import joplin from 'api';
import { dataGet, dataPost, dataPut, fetchAllPages } from './client';
import { JoplinNote } from './types';
import { listNotebookPaths, notebookPathForId } from './notebooks';

const NOTE_FIELDS = 'id,title,body,parent_id,is_todo,todo_completed,todo_due,source_url,created_time,updated_time,user_updated_time';
const NOTE_LIST_FIELDS = 'id,title,parent_id,is_todo,updated_time,user_updated_time';

export async function getNote(id: string, fields = NOTE_FIELDS): Promise<JoplinNote | null> {
	try {
		return await dataGet<JoplinNote>(['notes', id], { fields });
	} catch {
		return null;
	}
}

/**
 * List notes in a notebook (folder). Optionally include notes from all
 * descendant subnotebooks. Bodies are omitted — use get_note for content.
 */
export async function listNotesInNotebook(
	notebookId: string,
	options?: { includeSubnotebooks?: boolean; limit?: number }
): Promise<(JoplinNote & { notebook_path: string })[]> {
	const includeSubs = Boolean(options?.includeSubnotebooks);
	const limit = Math.max(1, Math.min(200, options?.limit ?? 50));
	const paths = await listNotebookPaths();

	const folderIds = new Set<string>([notebookId]);
	if (includeSubs) {
		const root = paths.find((n) => n.id === notebookId);
		if (root) {
			for (const n of paths) {
				if (n.path === root.path || n.path.startsWith(root.path + ' / ')) {
					folderIds.add(n.id);
				}
			}
		}
	}

	const collected: JoplinNote[] = [];
	for (const fid of folderIds) {
		if (collected.length >= limit) break;
		// Joplin: GET /folders/:id/notes
		const notes = await fetchAllPages<JoplinNote>(['folders', fid, 'notes'], {
			fields: NOTE_LIST_FIELDS,
			order_by: 'user_updated_time',
			order_dir: 'DESC',
		});
		for (const n of notes) {
			if (collected.length >= limit) break;
			collected.push(n);
		}
	}

	const withPaths = await Promise.all(
		collected.slice(0, limit).map(async (n) => ({
			...n,
			notebook_path: await notebookPathForId(n.parent_id, paths),
		}))
	);
	return withPaths;
}

export async function getSelectedNote(): Promise<JoplinNote | null> {
	const note = await joplin.workspace.selectedNote();
	if (!note || !note.id) return null;
	return getNote(note.id);
}

export async function createNote(input: {
	title: string;
	body?: string;
	parent_id?: string;
	is_todo?: boolean;
	source_url?: string;
}): Promise<JoplinNote> {
	const body: Record<string, unknown> = {
		title: input.title,
		body: input.body || '',
	};
	if (input.parent_id) body.parent_id = input.parent_id;
	if (input.is_todo) body.is_todo = 1;
	if (input.source_url) body.source_url = input.source_url;

	return dataPost<JoplinNote>(['notes'], null, body);
}

export async function updateNote(
	id: string,
	patch: Partial<Pick<JoplinNote, 'title' | 'body' | 'parent_id' | 'is_todo' | 'todo_completed' | 'todo_due'>>
): Promise<JoplinNote> {
	const body: Record<string, unknown> = { ...patch };
	return dataPut<JoplinNote>(['notes', id], null, body);
}

export async function appendToNote(id: string, markdown: string): Promise<JoplinNote> {
	const note = await getNote(id);
	if (!note) throw new Error(`Note not found: ${id}`);
	const body = (note.body || '').trimEnd() + '\n\n' + markdown;
	return updateNote(id, { body });
}

export async function openNote(id: string): Promise<void> {
	await joplin.commands.execute('openNote', id);
}

export async function noteWithPath(note: JoplinNote): Promise<JoplinNote & { notebook_path: string }> {
	const notebook_path = await notebookPathForId(note.parent_id);
	return { ...note, notebook_path };
}
