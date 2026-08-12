import { dataGet } from './client';
import { NoteSearchHit, Paginated } from './types';
import { listNotebookPaths, notebookPathForId } from './notebooks';

function snippetFromBody(body: string | undefined, max = 220): string {
	if (!body) return '';
	const cleaned = body.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= max) return cleaned;
	return cleaned.slice(0, max - 1) + '…';
}

export async function searchNotes(query: string, limit = 20): Promise<NoteSearchHit[]> {
	if (!query || !query.trim()) return [];

	const result = await dataGet<Paginated<NoteSearchHit>>(['search'], {
		query: query.trim(),
		type: 'note',
		fields: 'id,title,parent_id,body',
		limit: Math.min(limit, 100),
	});

	const items = result.items || [];
	const paths = await listNotebookPaths();

	return Promise.all(
		items.map(async (item) => ({
			id: item.id,
			title: item.title,
			parent_id: item.parent_id,
			body: item.body,
			notebook_path: await notebookPathForId(item.parent_id, paths),
			snippet: snippetFromBody(item.body),
		}))
	);
}

export async function searchFolders(query: string): Promise<{ id: string; title: string }[]> {
	const result = await dataGet<Paginated<{ id: string; title: string }>>(['search'], {
		query: query.trim(),
		type: 'folder',
		fields: 'id,title',
		limit: 50,
	});
	return result.items || [];
}
