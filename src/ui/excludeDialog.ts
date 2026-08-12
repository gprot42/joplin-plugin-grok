/**
 * Exclude notebooks dialog:
 *  1. Choose a notebook from the dropdown
 *  2. Press + Add (repeat for more)
 *  3. Press × to remove
 *  4. Save
 *
 * Joplin only returns formData when the HTML includes a real <form>.
 * Each excluded notebook is a checked input name="nb__{id}" so Save always
 * receives every id (more reliable than a single multi-value field).
 *
 * Persistence: plugin dataDir JSON + Joplin settings (excludedStore).
 */
import joplin from 'api';
import { ViewHandle } from 'api/types';
import { listNotebookPaths } from '../joplin/notebooks';
import {
	loadExcludedIds,
	persistExcludedIds,
} from '../joplin/excludedStore';

const DIALOG_ID = 'joplinGrokExcludeNotebooksDialog';

let dialogHandle: ViewHandle | null = null;

function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Extract notebook ids from Joplin dialog formData.
 * Prefers nb__{id} checkbox/hidden fields; also reads selectedIds.
 */
export function parseSelectedIdsFromFormData(formData: any): string[] {
	if (!formData || typeof formData !== 'object') return [];
	const found: string[] = [];

	const pushId = (id: string) => {
		const clean = String(id || '').trim();
		if (clean) found.push(clean);
	};

	const pushParts = (value: unknown) => {
		if (value == null) return;
		if (Array.isArray(value)) {
			for (const v of value) pushParts(v);
			return;
		}
		// truthy checkbox values are "1" / "on" / true — not ids
		const s = String(value);
		if (s === '1' || s === 'on' || s === 'true') return;
		for (const part of s.split(/[\n,;|]+/)) {
			const id = part.trim();
			if (id && id.length >= 8) pushId(id);
		}
	};

	const consider = (key: string, value: unknown) => {
		const rawKey = String(key || '');
		const k = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, '');

		// Per-notebook fields: nb__{id} or nb_{id}
		if (k.startsWith('nb__') || k.startsWith('nb_')) {
			const id = rawKey.replace(/^nb__/i, '').replace(/^nb_/i, '');
			// Only count if the control is checked / present with a truthy value
			if (value === false || value === 0 || value === '' || value == null) return;
			if (id && id.length >= 8) pushId(id);
			return;
		}

		if (
			k === 'selectedids' ||
			k === 'selectedid' ||
			k.endsWith('selectedids') ||
			k === 'ids'
		) {
			pushParts(value);
		}
	};

	const visit = (obj: any, depth = 0) => {
		if (!obj || typeof obj !== 'object' || depth > 8) return;
		if (Array.isArray(obj)) {
			for (const item of obj) visit(item, depth + 1);
			return;
		}
		for (const [key, value] of Object.entries(obj)) {
			consider(key, value);
			if (value && typeof value === 'object') visit(value, depth + 1);
		}
	};
	visit(formData);
	return [...new Set(found.filter(Boolean))];
}

function formDataLooksPresent(formData: any): boolean {
	if (!formData || typeof formData !== 'object') return false;
	// Any keys at all mean Joplin returned a form
	const keys: string[] = [];
	const visit = (obj: any, depth = 0) => {
		if (!obj || typeof obj !== 'object' || depth > 4) return;
		if (Array.isArray(obj)) {
			for (const item of obj) visit(item, depth + 1);
			return;
		}
		for (const [k, v] of Object.entries(obj)) {
			keys.push(k);
			if (v && typeof v === 'object') visit(v, depth + 1);
		}
	};
	visit(formData);
	return keys.length > 0;
}

function buildDialogHtml(
	notebooks: { id: string; path: string; depth: number; title: string }[],
	blockedIds: string[]
): string {
	const initialSelected = blockedIds.join(',');
	const notebooksJson = JSON.stringify(notebooks)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026');

	// Seed form with one named field per already-excluded id (Joplin formData)
	const seedFields = blockedIds
		.map((id) => {
			const safe = escapeHtml(id);
			return `<input type="checkbox" class="nb-seed" name="nb__${safe}" value="1" checked style="display:none" />`;
		})
		.join('');

	return `
<form name="excludeForm" id="excludeForm">
<div id="wrap">
	<h1>Exclude notebooks</h1>
	<p class="lead">
		<strong>1.</strong> Pick a notebook &nbsp;
		<strong>2.</strong> Click <strong>+ Add</strong> &nbsp;
		<strong>3.</strong> Repeat · <strong>×</strong> to remove · then <strong>Save</strong>
	</p>

	<div id="error-banner" class="error-banner hidden"></div>

	<div class="add-row">
		<select id="notebook-select" aria-label="Notebook to exclude">
			<option value="">Loading notebooks…</option>
		</select>
		<input type="button" id="btn-add" value="+ Add" disabled />
	</div>

	<div class="section-label">
		<span>Excluded</span>
		<span class="count"><span id="excluded-count">0</span> notebook(s)</span>
	</div>
	<div id="excluded-list">
		<p class="empty" id="empty-state">
			Nothing excluded yet.<br />Choose a notebook above, then click <strong>+ Add</strong>.
		</p>
	</div>

	<p class="footer-hint">
		${notebooks.length} notebook(s) loaded · ${blockedIds.length} currently excluded.
		Saved so they survive restart.
	</p>

	<!-- Joplin formData: per-id checkboxes (authoritative) + aggregate field (backup) -->
	<div id="form-ids">${seedFields}</div>
	<input type="text" name="selectedIds" id="selectedIds" value="${escapeHtml(initialSelected)}" readonly style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" tabindex="-1" aria-hidden="true" />
	<textarea id="notebooks-data" style="display:none" readonly aria-hidden="true">${notebooksJson}</textarea>
</div>
</form>
`;
}

async function ensureDialog(): Promise<ViewHandle> {
	if (dialogHandle) return dialogHandle;
	dialogHandle = await joplin.views.dialogs.create(DIALOG_ID);
	await joplin.views.dialogs.setFitToContent(dialogHandle, false);
	return dialogHandle;
}

/** Open the exclude manager. On Save, persists to disk + settings. */
export async function openExcludeNotebooksDialog(): Promise<void> {
	let notebooks: { id: string; path: string; depth: number; title: string }[] = [];
	try {
		const nodes = await listNotebookPaths();
		notebooks = nodes.map((n) => ({
			id: n.id,
			path: n.path,
			depth: n.depth,
			title: n.title,
		}));
	} catch (e) {
		console.warn('Joplin Grok: listNotebookPaths failed', e);
	}

	const blockedIds = await loadExcludedIds();
	const byId = new Map(notebooks.map((n) => [n.id, n.path]));

	const dialog = await ensureDialog();
	await joplin.views.dialogs.setHtml(dialog, buildDialogHtml(notebooks, blockedIds));
	await joplin.views.dialogs.addScript(dialog, './ui/excludeDialog.css');
	await joplin.views.dialogs.addScript(dialog, './ui/excludeDialogView.js');

	await joplin.views.dialogs.setButtons(dialog, [
		{ id: 'ok', title: 'Save' },
		{ id: 'cancel', title: 'Cancel' },
	]);

	const result = await joplin.views.dialogs.open(dialog);
	if (result.id !== 'ok') return;

	const formData = result.formData;
	const selected = parseSelectedIdsFromFormData(formData);
	const hasForm = formDataLooksPresent(formData);

	console.info('Joplin Grok: exclude dialog formData=', JSON.stringify(formData));
	console.info('Joplin Grok: parsed excluded ids=', selected);

	if (!hasForm) {
		// No form at all — keep previous, don't wipe
		if (blockedIds.length) {
			await persistExcludedIds(blockedIds, byId);
		}
		await joplin.views.dialogs.showMessageBox(
			'Could not read the excluded list from the dialog (no form data).\n\n' +
				'Your previous exclusions were kept.\n\n' +
				'Try: Tools → Joplin Grok: Manage excluded notebooks…'
		);
		return;
	}

	// Form present: empty selection is intentional (user cleared all)
	const saved = await persistExcludedIds(selected, byId);

	await joplin.views.dialogs.showMessageBox(
		saved.length
			? `Saved ${saved.length} excluded notebook(s).\n\n` +
					saved.map((id) => byId.get(id) || id).join('\n') +
					'\n\nThese persist after restart.'
			: 'Saved — no notebooks excluded. AI can access all allowed notebooks.'
	);
}
