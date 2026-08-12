import { AccessContext, filterAccessibleNotebooks, isNotebookAccessible } from '../joplin/access';
import { searchNotes } from '../joplin/search';
import { PluginSettings } from '../settings';
import { createProvider } from './factory';
import { ChatMessage } from './types';

export interface PlacementInput {
	title: string;
	body?: string;
	hint?: string;
	access: AccessContext;
	settings: PluginSettings;
}

export interface PlacementResult {
	action: 'use_existing' | 'create_notebook';
	notebook_id?: string;
	notebook_path?: string;
	new_notebook?: { title: string; parent_id?: string };
	tags: string[];
	confidence: number;
	rationale: string;
}

function extractJson(text: string): any {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = fenced ? fenced[1] : text;
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end < 0) throw new Error('No JSON object in placement response');
	return JSON.parse(raw.slice(start, end + 1));
}

export async function suggestPlacement(input: PlacementInput): Promise<PlacementResult> {
	const notebooks = filterAccessibleNotebooks(input.access);
	if (!notebooks.length) {
		return {
			action: 'use_existing',
			confidence: 0,
			tags: [],
			rationale: 'No notebooks are accessible to the AI. Adjust access settings.',
		};
	}

	const searchQuery = [input.title, input.hint, (input.body || '').slice(0, 200)].filter(Boolean).join(' ');
	let related: { title: string; notebook_path?: string }[] = [];
	try {
		const hits = await searchNotes(searchQuery, 10);
		related = hits
			.filter((h) => isNotebookAccessible(input.access, h.parent_id))
			.map((h) => ({ title: h.title, notebook_path: h.notebook_path }));
	} catch {
		related = [];
	}

	const notebookLines = notebooks
		.map((n) => `- ${n.id} | depth=${n.depth} | ${n.path}`)
		.join('\n');
	const relatedLines = related.length
		? related.map((r) => `- "${r.title}" in ${r.notebook_path}`).join('\n')
		: '(none)';

	const userContent = `Choose the best notebook for this new note among ALLOWED notebooks only.

Title: ${input.title}
Hint: ${input.hint || '(none)'}
Body (truncated):
${(input.body || '').slice(0, 1500)}

ALLOWED notebooks:
${notebookLines}

Related existing notes:
${relatedLines}

Prefer the deepest (most specific) matching subnotebook.
Only suggest create_notebook if nothing fits and creating is appropriate.
Respond with JSON only:
{
  "action": "use_existing" | "create_notebook",
  "notebook_id": "id when use_existing",
  "new_notebook": { "title": "...", "parent_id": "optional parent id" },
  "tags": ["..."],
  "confidence": 0.0-1.0,
  "rationale": "short reason"
}`;

	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				'You place notes into Joplin notebooks. Only use notebook IDs from the provided allowed list. Reply with JSON only.',
		},
		{ role: 'user', content: userContent },
	];

	try {
		const provider = await createProvider(input.settings);
		const res = await provider.chat({ messages, temperature: 0.1 });
		const content = res.message.content || '';
		const parsed = extractJson(content);

		const action = parsed.action === 'create_notebook' ? 'create_notebook' : 'use_existing';
		let notebook_id = parsed.notebook_id ? String(parsed.notebook_id) : undefined;
		let notebook_path: string | undefined;

		if (action === 'use_existing') {
			if (!notebook_id || !isNotebookAccessible(input.access, notebook_id)) {
				// Fallback: default notebook or first allowed
				notebook_id =
					(input.settings.defaultNotebookId &&
					isNotebookAccessible(input.access, input.settings.defaultNotebookId)
						? input.settings.defaultNotebookId
						: notebooks[0].id);
			}
			const node = notebooks.find((n) => n.id === notebook_id);
			notebook_path = node?.path;
		} else if (parsed.new_notebook?.parent_id) {
			const pid = String(parsed.new_notebook.parent_id);
			if (!isNotebookAccessible(input.access, pid)) {
				return {
					action: 'use_existing',
					notebook_id: notebooks[0].id,
					notebook_path: notebooks[0].path,
					tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
					confidence: 0.3,
					rationale: 'Suggested parent was not accessible; fell back to first allowed notebook.',
				};
			}
		}

		return {
			action,
			notebook_id,
			notebook_path,
			new_notebook: parsed.new_notebook
				? {
						title: String(parsed.new_notebook.title || 'New notebook'),
						parent_id: parsed.new_notebook.parent_id
							? String(parsed.new_notebook.parent_id)
							: undefined,
				  }
				: undefined,
			tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
			confidence: Number(parsed.confidence) || 0.5,
			rationale: String(parsed.rationale || ''),
		};
	} catch (e: any) {
		const fallback =
			input.settings.defaultNotebookId &&
			isNotebookAccessible(input.access, input.settings.defaultNotebookId)
				? notebooks.find((n) => n.id === input.settings.defaultNotebookId) || notebooks[0]
				: notebooks[0];
		return {
			action: 'use_existing',
			notebook_id: fallback.id,
			notebook_path: fallback.path,
			tags: [],
			confidence: 0.2,
			rationale: `Placement model failed (${e.message || e}); using fallback notebook.`,
		};
	}
}
