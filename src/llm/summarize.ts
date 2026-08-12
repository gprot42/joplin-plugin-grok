import { buildAccessContext, isNotebookAccessible } from '../joplin/access';
import { getNote, getSelectedNote, createNote } from '../joplin/notes';
import { notebookPathForId } from '../joplin/notebooks';
import { loadSettings } from '../settings';
import { createProvider } from './factory';

export async function summarizeNote(options: {
	noteId?: string;
	text?: string;
	writeAsNewNote?: boolean;
}): Promise<{ summary: string; sourceTitle?: string; newNoteId?: string }> {
	const settings = await loadSettings();
	const access = await buildAccessContext();
	const provider = await createProvider(settings);

	let title = 'Selection';
	let body = options.text || '';

	if (options.noteId || !body) {
		const note = options.noteId ? await getNote(options.noteId) : await getSelectedNote();
		if (!note) throw new Error('No note to summarize');
		if (!isNotebookAccessible(access, note.parent_id)) {
			throw new Error('This note is in a notebook blocked from AI access');
		}
		title = note.title;
		body = note.body || '';
	}

	const res = await provider.chat({
		messages: [
			{
				role: 'system',
				content:
					'Summarize the following Joplin note in clear Markdown. Use short sections and bullet points when helpful. Do not invent facts not present in the note.',
			},
			{
				role: 'user',
				content: `# ${title}\n\n${body.slice(0, 12000)}`,
			},
		],
		temperature: 0.2,
	});

	const summary = res.message.content || '';
	let newNoteId: string | undefined;

	if (options.writeAsNewNote) {
		const note = options.noteId ? await getNote(options.noteId) : await getSelectedNote();
		const parentId =
			note && isNotebookAccessible(access, note.parent_id)
				? note.parent_id
				: settings.defaultNotebookId;
		if (!parentId || !isNotebookAccessible(access, parentId)) {
			throw new Error('No accessible notebook to write the summary');
		}
		const created = await createNote({
			title: `Summary: ${title}`,
			body: summary,
			parent_id: parentId,
		});
		newNoteId = created.id;
	}

	return { summary, sourceTitle: title, newNoteId };
}

export async function summarizeCurrentNote(writeAsNewNote = false) {
	return summarizeNote({ writeAsNewNote });
}
