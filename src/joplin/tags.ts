import { dataGet, dataPost, fetchAllPages } from './client';
import { JoplinTag } from './types';

export async function listTags(): Promise<JoplinTag[]> {
	return fetchAllPages<JoplinTag>(['tags'], { fields: 'id,title' });
}

export async function getNoteTags(noteId: string): Promise<JoplinTag[]> {
	try {
		const result = await dataGet<{ items: JoplinTag[] }>(['notes', noteId, 'tags'], {
			fields: 'id,title',
		});
		return result.items || [];
	} catch {
		return [];
	}
}

export async function findTagByTitle(title: string): Promise<JoplinTag | null> {
	const tags = await listTags();
	const lower = title.toLowerCase();
	return tags.find((t) => t.title.toLowerCase() === lower) || null;
}

export async function createTag(title: string): Promise<JoplinTag> {
	return dataPost<JoplinTag>(['tags'], null, { title });
}

export async function ensureTag(title: string): Promise<JoplinTag> {
	const existing = await findTagByTitle(title);
	if (existing) return existing;
	return createTag(title);
}

export async function tagNote(noteId: string, tagTitle: string): Promise<JoplinTag> {
	const tag = await ensureTag(tagTitle);
	await dataPost(['tags', tag.id, 'notes'], null, { id: noteId });
	return tag;
}

export async function tagNoteWithMany(noteId: string, tagTitles: string[]): Promise<JoplinTag[]> {
	const out: JoplinTag[] = [];
	for (const title of tagTitles) {
		if (!title || !title.trim()) continue;
		out.push(await tagNote(noteId, title.trim()));
	}
	return out;
}
