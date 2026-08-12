/**
 * Multi-select dialog of currently excluded notebooks — un-exclude one or many.
 */
import joplin from 'api';
import { ViewHandle } from 'api/types';
import { listNotebookPaths } from '../joplin/notebooks';
import { SettingKey, loadSettings } from '../settings';
import { parseIdList } from '../joplin/access';

const DIALOG_ID = 'joplinGrokRestoreNotebooksDialog';

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

function buildHtml(
	items: { id: string; path: string; title: string; depth: number }[]
): string {
	const rows = items
		.map((nb) => {
			const title = escapeHtml(nb.title || nb.path);
			const path = escapeHtml(nb.path);
			const id = escapeHtml(nb.id);
			const indent = Math.min(nb.depth, 12) * 14;
			return `
<label class="row" style="padding-left:${10 + indent}px" data-path="${path.toLowerCase()}" data-title="${title.toLowerCase()}">
	<input class="nb-cb" type="checkbox" data-id="${id}" value="1" />
	<span class="body">
		<span class="title">${title}</span>
		<span class="meta">${path}</span>
	</span>
</label>`;
		})
		.join('');

	return `
<div id="wrap">
	<h1>Restore notebooks for AI</h1>
	<p class="lead">
		These notebooks are currently <strong>excluded</strong> from AI.
		Check the ones you want to <strong>allow again</strong>, then click <strong>Restore selected</strong>.
	</p>
	<input id="filter" type="search" placeholder="Filter by name or path…" />
	<div class="actions">
		<button type="button" id="btn-all">Select all visible</button>
		<button type="button" id="btn-none">Clear all checks</button>
	</div>
	<div id="status">${items.length} excluded</div>
	<form name="restoreForm">
		<input type="hidden" name="selectedIds" id="selectedIds" value="" />
		<div id="list">${
			rows ||
			'<p style="padding:12px">No notebooks are excluded right now.</p>'
		}</div>
	</form>
</div>
`;
}

async function ensureDialog(): Promise<ViewHandle> {
	if (dialogHandle) return dialogHandle;
	dialogHandle = await joplin.views.dialogs.create(DIALOG_ID);
	await joplin.views.dialogs.setFitToContent(dialogHandle, false);
	return dialogHandle;
}

export async function openRestoreNotebooksDialog(): Promise<void> {
	const settings = await loadSettings();
	const blockedIds = parseIdList(settings.blockedNotebookIds);

	if (!blockedIds.length) {
		return;
	}

	const notebooks = await listNotebookPaths();
	const byId = new Map(notebooks.map((n) => [n.id, n]));

	const items = blockedIds.map((id) => {
		const n = byId.get(id);
		return {
			id,
			path: n?.path || `(missing notebook ${id.slice(0, 8)}…)`,
			title: n?.title || id.slice(0, 8),
			depth: n?.depth ?? 0,
		};
	});

	// Sort by path for readability
	items.sort((a, b) => a.path.localeCompare(b.path));

	const dialog = await ensureDialog();
	await joplin.views.dialogs.setHtml(dialog, buildHtml(items));
	await joplin.views.dialogs.addScript(dialog, './ui/excludeDialog.css');
	await joplin.views.dialogs.addScript(dialog, './ui/excludeDialog.js');
	await joplin.views.dialogs.setButtons(dialog, [
		{ id: 'ok', title: 'Restore selected' },
		{ id: 'cancel', title: 'Cancel' },
	]);

	const result = await joplin.views.dialogs.open(dialog);
	if (result.id !== 'ok') return;

	const selected = parseSelectedIdsFromFormData(result.formData);
	if (!selected.length) {
		return;
	}

	const selectedSet = new Set(selected);
	const remaining = blockedIds.filter((id) => !selectedSet.has(id));
	await joplin.settings.setValue(SettingKey.BlockedNotebookIds, remaining.join('\n'));

	const pathList = remaining
		.map((id) => {
			const n = byId.get(id);
			return n?.path || id;
		})
		.join('\n');
	await joplin.settings.setValue(SettingKey.ExcludedNotebookPathsDisplay, pathList);
}
