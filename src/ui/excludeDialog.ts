/**
 * Simple exclude UI:
 *  1. Choose a notebook from the dropdown
 *  2. Press + to add it to the excluded list
 *  3. Press × on any row to remove it
 *  4. Save
 */
import joplin from 'api';
import { ViewHandle } from 'api/types';
import { listNotebookPaths } from '../joplin/notebooks';
import { SettingKey, loadSettings } from '../settings';
import { parseIdList } from '../joplin/access';

const DIALOG_ID = 'joplinGrokExcludeNotebooksDialog';

let dialogHandle: ViewHandle | null = null;

function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function parseSelectedIdsFromFormData(formData: any): string[] {
	if (!formData || typeof formData !== 'object') return [];
	const found: string[] = [];

	const consider = (key: string, value: unknown) => {
		if (key === 'selectedIds' || key === 'selected_ids') {
			for (const part of String(value || '').split(/[\n,;]+/)) {
				const id = part.trim();
				if (id) found.push(id);
			}
		}
	};

	const visit = (obj: any, depth = 0) => {
		if (!obj || typeof obj !== 'object' || depth > 4) return;
		for (const [key, value] of Object.entries(obj)) {
			consider(key, value);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				visit(value, depth + 1);
			}
		}
	};
	visit(formData);
	return [...new Set(found.filter(Boolean))];
}

function optionLabel(path: string, depth: number): string {
	const indent = depth > 0 ? `${'· '.repeat(Math.min(depth, 8))}` : '';
	const raw = `${indent}${path}`;
	return raw.length > 90 ? `${raw.slice(0, 87)}…` : raw;
}

function buildDialogHtml(
	notebooks: { id: string; path: string; depth: number; title: string }[],
	blockedIds: Set<string>
): string {
	const initialSelected = [...blockedIds].join('\n');
	const byId = new Map(notebooks.map((n) => [n.id, n]));

	const options = notebooks
		.map((nb) => {
			const label = escapeHtml(optionLabel(nb.path, nb.depth));
			const id = escapeHtml(nb.id);
			const title = escapeHtml(nb.title || nb.path);
			const path = escapeHtml(nb.path);
			const disabled = blockedIds.has(nb.id) ? ' disabled' : '';
			return `<option value="${id}" data-title="${title}" data-path="${path}"${disabled}>${label}</option>`;
		})
		.join('');

	const excludedItems: string[] = [];
	const blockedList = Array.from(blockedIds);
	for (const id of blockedList) {
		const nb = byId.get(id);
		const title = escapeHtml(nb?.title || nb?.path || `Missing (${id.slice(0, 8)}…)`);
		const path = escapeHtml(nb?.path || id);
		excludedItems.push(`
<div class="item" data-id="${escapeHtml(id)}">
	<div class="body">
		<span class="title">${title}</span>
		<span class="path">${path}</span>
	</div>
	<button type="button" class="btn-remove" title="Remove" aria-label="Remove">×</button>
</div>`);
	}

	const hasExcluded = excludedItems.length > 0;

	return `
<div id="wrap">
	<h1>Exclude notebooks</h1>
	<p class="lead">
		Choose a notebook, click <strong>+ Add</strong>, repeat as needed.
		Press <strong>×</strong> to remove one from the list. Then save.
	</p>

	<div class="add-row">
		<select id="notebook-select" aria-label="Notebook to exclude">
			<option value="">Select a notebook…</option>
			${options}
		</select>
		<button type="button" id="btn-add" disabled>
			<span class="plus">+</span> Add
		</button>
	</div>

	<div class="section-label">
		<span>Excluded</span>
		<span class="count"><span id="excluded-count">${excludedItems.length}</span> notebook(s)</span>
	</div>
	<div id="excluded-list">
		${excludedItems.join('')}
		<p class="empty${hasExcluded ? ' hidden' : ''}" id="empty-state">
			Nothing excluded yet.<br />Select a notebook above and click + Add.
		</p>
	</div>

	<p class="footer-hint">
		Excluded notebooks and their subnotebooks are hidden from AI search, read, and write.
	</p>

	<form name="excludeForm">
		<input type="hidden" name="selectedIds" id="selectedIds" value="${escapeHtml(initialSelected)}" />
	</form>
</div>
`;
}

async function ensureDialog(): Promise<ViewHandle> {
	if (dialogHandle) return dialogHandle;
	dialogHandle = await joplin.views.dialogs.create(DIALOG_ID);
	await joplin.views.dialogs.setFitToContent(dialogHandle, true);
	return dialogHandle;
}

/** Open the simple exclude manager. On Save, replaces the blocked ID list. */
export async function openExcludeNotebooksDialog(): Promise<void> {
	const notebooks = await listNotebookPaths();
	const settings = await loadSettings();
	const blockedIds = new Set(parseIdList(settings.blockedNotebookIds));

	const items = notebooks.map((n) => ({
		id: n.id,
		path: n.path,
		depth: n.depth,
		title: n.title,
	}));

	const dialog = await ensureDialog();
	await joplin.views.dialogs.setHtml(dialog, buildDialogHtml(items, blockedIds));
	await joplin.views.dialogs.addScript(dialog, './ui/excludeDialog.css');
	// View script must not be named excludeDialog.js — webpack resolves .js before .ts
	await joplin.views.dialogs.addScript(dialog, './ui/excludeDialogView.js');

	await joplin.views.dialogs.setButtons(dialog, [
		{ id: 'ok', title: 'Save' },
		{ id: 'cancel', title: 'Cancel' },
	]);

	const result = await joplin.views.dialogs.open(dialog);
	if (result.id !== 'ok') return;

	const selected = parseSelectedIdsFromFormData(result.formData);
	await joplin.settings.setValue(SettingKey.BlockedNotebookIds, selected.join('\n'));

	const byId = new Map(items.map((n) => [n.id, n.path]));
	const pathList = selected.map((id) => byId.get(id) || id).join('\n');
	await joplin.settings.setValue(SettingKey.ExcludedNotebookPathsDisplay, pathList);
}
