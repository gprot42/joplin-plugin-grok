import joplin from 'api';
import {
	AccessContext,
	assertNotebookAccessible,
	buildAccessContext,
	filterAccessibleNotebooks,
	filterNotesByAccess,
	isNotebookAccessible,
} from '../joplin/access';
import { createFolder, listNotebookPaths, notebookPathForId } from '../joplin/notebooks';
import {
	appendToNote,
	createNote,
	getNote,
	getSelectedNote,
	listNotesInNotebook,
	openNote,
	updateNote,
} from '../joplin/notes';
import { searchNotes } from '../joplin/search';
import { listTags, tagNoteWithMany } from '../joplin/tags';
import { loadSettings, PluginSettings, addBlockedNotebookId, removeBlockedNotebookId } from '../settings';
import { ToolSpec } from './types';
import { suggestPlacement } from './placement';

export const TOOL_SPECS: ToolSpec[] = [
	{
		type: 'function',
		function: {
			name: 'search_notes',
			description: 'Full-text search notes the AI is allowed to access. Returns titles, ids, notebook paths, snippets.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Joplin search query' },
					limit: { type: 'integer', description: 'Max results (default 15)' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_note',
			description: 'Read a note by id (full markdown body). Fails if the notebook is blocked.',
			parameters: {
				type: 'object',
				properties: {
					note_id: { type: 'string' },
				},
				required: ['note_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_notes',
			description:
				'List notes inside a notebook by notebook id (titles/ids/paths, no full bodies). ' +
				'Prefer this over search_notes when summarizing or inventorying a specific notebook. ' +
				'Set include_subnotebooks=true to include notes in child folders. Then call get_note for each note to read content.',
			parameters: {
				type: 'object',
				properties: {
					notebook_id: { type: 'string', description: 'Notebook (folder) id from list_notebooks' },
					include_subnotebooks: {
						type: 'boolean',
						description: 'Include notes from subnotebooks (default true for notebook summaries)',
					},
					limit: {
						type: 'integer',
						description: 'Max notes to return (default 50, max 200)',
					},
				},
				required: ['notebook_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_notebooks',
			description:
				'List notebooks the AI may use (id, title, path, depth). Blocked notebooks are omitted. ' +
				'Use query to filter by path/title. Results are capped — do not expect the full tree in one call.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Optional case-insensitive substring filter on notebook title or path',
					},
					top_level_only: {
						type: 'boolean',
						description: 'If true, only root notebooks (depth 0). Default false.',
					},
					limit: {
						type: 'integer',
						description: 'Max notebooks to return (default 40, max 100)',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_current_note',
			description: 'Get the currently selected note in Joplin, if accessible.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_note',
			description: 'Create a note in an allowed notebook. Prefer suggest_placement first when unsure where to put it.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					body: { type: 'string', description: 'Markdown body' },
					parent_id: { type: 'string', description: 'Notebook id' },
					tags: { type: 'array', items: { type: 'string' } },
					is_todo: { type: 'boolean' },
				},
				required: ['title', 'parent_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_note',
			description: 'Update title, body, and/or notebook of an existing accessible note.',
			parameters: {
				type: 'object',
				properties: {
					note_id: { type: 'string' },
					title: { type: 'string' },
					body: { type: 'string' },
					parent_id: { type: 'string' },
					append_body: {
						type: 'string',
						description: 'If set, append this markdown instead of replacing body',
					},
				},
				required: ['note_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_notebook',
			description: 'Create a notebook or subnotebook under an allowed parent (or root).',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					parent_id: { type: 'string', description: 'Parent notebook id; omit for top-level' },
				},
				required: ['title'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'tag_note',
			description: 'Attach one or more tags to a note (creates tags if needed).',
			parameters: {
				type: 'object',
				properties: {
					note_id: { type: 'string' },
					tags: { type: 'array', items: { type: 'string' } },
				},
				required: ['note_id', 'tags'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_tags',
			description: 'List existing tags.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function',
		function: {
			name: 'suggest_placement',
			description:
				'Suggest the best allowed notebook (or a new subnotebook) for draft content. Use before create_note when placement is unclear.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					body: { type: 'string' },
					hint: { type: 'string', description: 'Optional user hint' },
				},
				required: ['title'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'open_note',
			description: 'Open a note in the Joplin editor.',
			parameters: {
				type: 'object',
				properties: { note_id: { type: 'string' } },
				required: ['note_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'block_notebook',
			description:
				'Block a notebook (and all subnotebooks) from AI access going forward. Use when the user asks to hide a notebook from the AI.',
			parameters: {
				type: 'object',
				properties: {
					notebook_id: { type: 'string' },
				},
				required: ['notebook_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'unblock_notebook',
			description: 'Remove a notebook id from the AI block list.',
			parameters: {
				type: 'object',
				properties: {
					notebook_id: { type: 'string' },
				},
				required: ['notebook_id'],
			},
		},
	},
];

function parseArgs(raw: string): Record<string, unknown> {
	if (!raw || !raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`Invalid tool arguments JSON: ${raw.slice(0, 200)}`);
	}
}

async function maybeConfirm(settings: PluginSettings, message: string): Promise<boolean> {
	if (!settings.confirmBeforeWrite) return true;
	const result = await joplin.views.dialogs.showMessageBox(`${message}\n\nContinue?`);
	// 0 = OK, 1 = Cancel in Joplin
	return result === 0;
}

export async function executeTool(
	name: string,
	argsJson: string,
	options?: { access?: AccessContext; settings?: PluginSettings }
): Promise<unknown> {
	const args = parseArgs(argsJson);
	const settings = options?.settings || (await loadSettings());
	const access = options?.access || (await buildAccessContext());

	switch (name) {
		case 'search_notes': {
			const query = String(args.query || '');
			const limit = Number(args.limit || 15);
			const hits = await searchNotes(query, limit);
			const allowed = filterNotesByAccess(access, hits).map((h) => ({
				id: h.id,
				title: h.title,
				parent_id: h.parent_id,
				notebook_path: h.notebook_path,
				snippet: h.snippet,
			}));
			return { count: allowed.length, notes: allowed };
		}

		case 'get_note': {
			const noteId = String(args.note_id || '');
			const note = await getNote(noteId);
			if (!note) return { error: 'Note not found' };
			assertNotebookAccessible(access, note.parent_id, 'get_note');
			const path = await notebookPathForId(note.parent_id, access.notebooks);
			return {
				id: note.id,
				title: note.title,
				parent_id: note.parent_id,
				notebook_path: path,
				body: note.body,
				is_todo: note.is_todo,
			};
		}

		case 'list_notes': {
			const notebookId = String(args.notebook_id || '').trim();
			if (!notebookId) return { error: 'notebook_id is required' };
			assertNotebookAccessible(access, notebookId, 'list_notes');
			const includeSubs =
				args.include_subnotebooks === undefined ? true : Boolean(args.include_subnotebooks);
			const limit = Math.max(1, Math.min(200, Number(args.limit || 50)));
			const notes = await listNotesInNotebook(notebookId, {
				includeSubnotebooks: includeSubs,
				limit,
			});
			// Drop any notes that landed in blocked notebooks (defensive)
			const allowed = notes.filter((n) => isNotebookAccessible(access, n.parent_id));
			const notebookPath = await notebookPathForId(notebookId, access.notebooks);
			return {
				notebook_id: notebookId,
				notebook_path: notebookPath,
				include_subnotebooks: includeSubs,
				count: allowed.length,
				truncated: allowed.length >= limit,
				notes: allowed.map((n) => ({
					id: n.id,
					title: n.title,
					parent_id: n.parent_id,
					notebook_path: n.notebook_path,
					is_todo: n.is_todo,
					updated_time: n.user_updated_time || n.updated_time,
				})),
				hint:
					allowed.length === 0
						? 'No notes in this notebook (with current include_subnotebooks setting).'
						: allowed.length >= limit
							? `Returned ${limit} notes (cap). Raise limit or summarize in batches via get_note.`
							: 'Call get_note on each id to read full markdown bodies for a complete summary.',
			};
		}

		case 'list_notebooks': {
			const query = String(args.query || '').trim().toLowerCase();
			const topLevelOnly = Boolean(args.top_level_only);
			const limit = Math.max(1, Math.min(100, Number(args.limit || 40)));

			let nodes = filterAccessibleNotebooks(access);
			if (topLevelOnly) {
				nodes = nodes.filter((n) => n.depth === 0);
			}
			if (query) {
				nodes = nodes.filter(
					(n) =>
						n.title.toLowerCase().includes(query) ||
						n.path.toLowerCase().includes(query)
				);
			}

			const totalMatching = nodes.length;
			const page = nodes.slice(0, limit).map((n) => ({
				id: n.id,
				title: n.title,
				parent_id: n.parent_id,
				path: n.path,
				depth: n.depth,
			}));

			return {
				total_accessible: filterAccessibleNotebooks(access).length,
				matching: totalMatching,
				returned: page.length,
				truncated: totalMatching > limit,
				query: query || null,
				top_level_only: topLevelOnly,
				notebooks: page,
				hint: totalMatching > limit
					? `Showing first ${limit} of ${totalMatching}. Narrow with query or raise limit (max 100).`
					: undefined,
			};
		}

		case 'get_current_note': {
			const note = await getSelectedNote();
			if (!note) return { note: null, message: 'No note selected' };
			if (!isNotebookAccessible(access, note.parent_id)) {
				return {
					note: null,
					message: 'Current note is in a notebook blocked from AI access',
					parent_id: note.parent_id,
				};
			}
			const path = await notebookPathForId(note.parent_id, access.notebooks);
			return {
				id: note.id,
				title: note.title,
				parent_id: note.parent_id,
				notebook_path: path,
				body: note.body,
			};
		}

		case 'create_note': {
			const title = String(args.title || 'Untitled');
			const body = String(args.body || '');
			const parentId = String(args.parent_id || '');
			assertNotebookAccessible(access, parentId, 'create_note');
			const ok = await maybeConfirm(settings, `Create note "${title}" in notebook ${parentId}?`);
			if (!ok) return { cancelled: true };
			const note = await createNote({
				title,
				body,
				parent_id: parentId,
				is_todo: Boolean(args.is_todo),
			});
			const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
			if (tags.length) await tagNoteWithMany(note.id, tags);
			const path = await notebookPathForId(note.parent_id, await listNotebookPaths());
			return { id: note.id, title: note.title, parent_id: note.parent_id, notebook_path: path, tags };
		}

		case 'update_note': {
			const noteId = String(args.note_id || '');
			const existing = await getNote(noteId);
			if (!existing) return { error: 'Note not found' };
			assertNotebookAccessible(access, existing.parent_id, 'update_note');
			if (args.parent_id) {
				assertNotebookAccessible(access, String(args.parent_id), 'update_note move');
			}
			const ok = await maybeConfirm(settings, `Update note "${existing.title}" (${noteId})?`);
			if (!ok) return { cancelled: true };

			if (args.append_body) {
				const note = await appendToNote(noteId, String(args.append_body));
				return { id: note.id, title: note.title, updated: true, appended: true };
			}
			const patch: Record<string, unknown> = {};
			if (args.title !== undefined) patch.title = String(args.title);
			if (args.body !== undefined) patch.body = String(args.body);
			if (args.parent_id !== undefined) patch.parent_id = String(args.parent_id);
			const note = await updateNote(noteId, patch as any);
			return { id: note.id, title: note.title, parent_id: note.parent_id, updated: true };
		}

		case 'create_notebook': {
			if (!settings.allowCreateNotebooks) {
				return { error: 'Creating notebooks is disabled in settings' };
			}
			const title = String(args.title || '');
			const parentId = args.parent_id ? String(args.parent_id) : undefined;
			if (parentId) assertNotebookAccessible(access, parentId, 'create_notebook');
			// Creating at root is only allowed if not in allowlist mode, or if we treat root as allowed when creating under nothing — fail closed in allowlist
			if (!parentId && access.allowed !== null) {
				return { error: 'In allowlist mode, new top-level notebooks are not allowed. Provide a parent_id under an allowed notebook.' };
			}
			const ok = await maybeConfirm(
				settings,
				`Create notebook "${title}"${parentId ? ` under ${parentId}` : ' at root'}?`
			);
			if (!ok) return { cancelled: true };
			const folder = await createFolder(title, parentId);
			return { id: folder.id, title: folder.title, parent_id: folder.parent_id };
		}

		case 'tag_note': {
			const noteId = String(args.note_id || '');
			const note = await getNote(noteId);
			if (!note) return { error: 'Note not found' };
			assertNotebookAccessible(access, note.parent_id, 'tag_note');
			const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
			const applied = await tagNoteWithMany(noteId, tags);
			return { note_id: noteId, tags: applied.map((t) => t.title) };
		}

		case 'list_tags': {
			const tags = await listTags();
			return { tags: tags.map((t) => ({ id: t.id, title: t.title })) };
		}

		case 'suggest_placement': {
			return suggestPlacement({
				title: String(args.title || ''),
				body: String(args.body || ''),
				hint: args.hint ? String(args.hint) : undefined,
				access,
				settings,
			});
		}

		case 'open_note': {
			const noteId = String(args.note_id || '');
			const note = await getNote(noteId);
			if (!note) return { error: 'Note not found' };
			assertNotebookAccessible(access, note.parent_id, 'open_note');
			await openNote(noteId);
			return { opened: noteId };
		}

		case 'block_notebook': {
			const notebookId = String(args.notebook_id || '');
			await addBlockedNotebookId(notebookId);
			return {
				blocked: notebookId,
				message: 'Notebook (and its subnotebooks) will be hidden from the AI on subsequent tools.',
			};
		}

		case 'unblock_notebook': {
			const notebookId = String(args.notebook_id || '');
			await removeBlockedNotebookId(notebookId);
			return { unblocked: notebookId };
		}

		default:
			return { error: `Unknown tool: ${name}` };
	}
}
