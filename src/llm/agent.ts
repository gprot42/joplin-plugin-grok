import { buildAccessContext, isNotebookAccessible } from '../joplin/access';
import { getNote } from '../joplin/notes';
import { notebookPathForId } from '../joplin/notebooks';
import { loadSettings } from '../settings';
import {
	buildSystemPrompt,
	isSummaryRequest,
	wrapSummaryUserRequest,
} from '../prompts/system';
import { createProvider } from './factory';
import { executeTool, TOOL_SPECS } from './tools';
import { ChatMessage, LLMProvider } from './types';
import {
	formatUsageFooter,
	getUsageSnapshot,
	recordChatUsage,
	UsageRecord,
} from './usage';
import { modelForProvider } from '../settings';

export interface AgentTurnResult {
	assistantMessage: string;
	toolTrace: { name: string; args: string; result: unknown }[];
	error?: string;
	/** Subtle one-line usage footer (tokens + est. USD); omit if tracking off / no data */
	usageFooter?: string;
}

/** Compress note body so the model cannot easily paste raw dumps. */
export function compressNoteBodyForSummary(body: string, maxChars = 900): string {
	let t = (body || '')
		// Strip raw URLs / images that models love to re-list
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
		.replace(/\[[^\]]*\]\(https?:\/\/[^)]+\)/g, '[link]')
		.replace(/https?:\/\/\S+/g, '[url]')
		// Flatten wide markdown tables to plain lines (keep first few cells)
		.replace(/^\|(.+)\|$/gm, (_m, row: string) => {
			const cells = String(row)
				.split('|')
				.map((c) => c.trim())
				.filter((c) => c && !/^[-:]+$/.test(c));
			return cells.slice(0, 4).join(' · ');
		})
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (t.length > maxChars) {
		t = t.slice(0, maxChars) + '\n…[truncated for synthesis]';
	}
	return t;
}

/** Shrink huge tool payloads before re-feeding the model (UI still gets full result). */
function toolResultForModel(name: string, result: unknown, summaryMode: boolean): string {
	if (!result || typeof result !== 'object') {
		return JSON.stringify(result ?? null);
	}
	const r = result as Record<string, unknown>;

	// Full note body can push the model to dump content — cap what it re-sees
	if (name === 'get_note' || name === 'get_current_note') {
		const body = typeof r.body === 'string' ? r.body : '';
		const max = summaryMode ? 900 : 3500;
		const clipped = compressNoteBodyForSummary(body, max);
		return JSON.stringify({
			id: r.id,
			title: r.title,
			parent_id: r.parent_id,
			notebook_path: r.notebook_path,
			is_todo: r.is_todo,
			body_excerpt: clipped,
			_instruction: summaryMode
				? 'Compressed excerpt only. Synthesize themes in your FINAL answer — never paste this text wholesale.'
				: 'Use this note as source material. Do not paste the full body into your final answer.',
		});
	}

	if (name === 'list_notes' || name === 'search_notes') {
		const notes = Array.isArray(r.notes) ? (r.notes as unknown[]) : [];
		// In summary mode, keep titles only — no temptation to inventory-dump
		const slimNotes = summaryMode
			? notes.slice(0, 40).map((n) => {
					const note = n as Record<string, unknown>;
					return {
						id: note.id,
						title: note.title,
						notebook_path: note.notebook_path,
					};
				})
			: notes;
		return JSON.stringify({
			count: r.count ?? notes.length,
			notebook_path: r.notebook_path,
			truncated: r.truncated,
			notes: slimNotes,
			_instruction: summaryMode
				? 'Inventory only. Read bodies with get_note, then write a human SYNTHESIS — not a title dump or table of contents.'
				: 'This is an inventory only. Read notes with get_note, then write a human summary — not a dump of titles/links.',
		});
	}

	const raw = JSON.stringify(result);
	const cap = summaryMode ? 6000 : 12000;
	if (raw.length > cap) {
		return raw.slice(0, cap) + '…[truncated for model context]';
	}
	return raw;
}

interface SummarySource {
	id?: string;
	title: string;
	path?: string;
	excerpt: string;
}

function noteFromToolResult(result: unknown): Record<string, unknown> | null {
	if (!result || typeof result !== 'object') return null;
	const r = result as Record<string, unknown>;
	if (r.error) return null;
	// get_note returns flat; get_current_note may nest
	if (r.note && typeof r.note === 'object') return r.note as Record<string, unknown>;
	if (r.title || r.body || r.id) return r;
	return null;
}

/**
 * Build compressed source pack from tool trace; fetch missing note bodies
 * when the agent only listed notes (common dump failure mode).
 */
async function collectSummarySources(
	toolTrace: AgentTurnResult['toolTrace'],
	maxNotes = 18
): Promise<{ sources: SummarySource[]; notebookHint: string }> {
	const sources: SummarySource[] = [];
	const seen = new Set<string>();
	let notebookHint = '';
	const pendingIds: { id: string; title?: string; path?: string }[] = [];

	for (const t of toolTrace) {
		const r = t.result as Record<string, unknown> | null;
		if (!r || typeof r !== 'object') continue;

		if (t.name === 'list_notebooks' && Array.isArray(r.notebooks) && !notebookHint) {
			const nbs = r.notebooks as { title?: string; path?: string }[];
			if (nbs[0]) notebookHint = nbs[0].path || nbs[0].title || '';
		}

		if ((t.name === 'list_notes' || t.name === 'search_notes') && Array.isArray(r.notes)) {
			if (typeof r.notebook_path === 'string' && r.notebook_path) {
				notebookHint = r.notebook_path;
			}
			for (const n of r.notes as { id?: string; title?: string; notebook_path?: string }[]) {
				if (!n?.id || seen.has(n.id)) continue;
				pendingIds.push({
					id: n.id,
					title: n.title,
					path: n.notebook_path,
				});
			}
		}

		if (t.name === 'get_note' || t.name === 'get_current_note') {
			const note = noteFromToolResult(r);
			if (!note) continue;
			const id = note.id != null ? String(note.id) : '';
			if (id && seen.has(id)) continue;
			if (id) seen.add(id);
			const body = typeof note.body === 'string' ? note.body : '';
			sources.push({
				id: id || undefined,
				title: String(note.title || 'Untitled'),
				path: note.notebook_path != null ? String(note.notebook_path) : undefined,
				excerpt: compressNoteBodyForSummary(body, 900),
			});
		}
	}

	// Fetch bodies the agent listed but never opened (or opened without body in trace shape)
	const access = await buildAccessContext();
	for (const p of pendingIds) {
		if (sources.length >= maxNotes) break;
		if (seen.has(p.id)) continue;
		const note = await getNote(p.id);
		if (!note) continue;
		if (!isNotebookAccessible(access, note.parent_id)) continue;
		seen.add(p.id);
		const path =
			p.path || (await notebookPathForId(note.parent_id, access.notebooks));
		sources.push({
			id: note.id,
			title: note.title || p.title || 'Untitled',
			path,
			excerpt: compressNoteBodyForSummary(note.body || '', 900),
		});
	}

	return { sources: sources.slice(0, maxNotes), notebookHint };
}

/** True when the model answer looks like a raw inventory/dump rather than a summary. */
export function looksLikeContentDump(text: string): boolean {
	const t = text || '';
	if (t.length < 400) return false;
	const urlCount = (t.match(/https?:\/\//g) || []).length;
	const tableRows = (t.match(/^\|.+\|$/gm) || []).length;
	const headingNotes = (t.match(/^#{1,3}\s+/gm) || []).length;
	const bulletLines = (t.match(/^\s*[-*]\s+/gm) || []).length;
	// Many URLs or table rows → dump
	if (urlCount >= 6) return true;
	if (tableRows >= 8) return true;
	// Long reply that is mostly a list of titles / short lines
	if (t.length > 1200 && bulletLines >= 20 && headingNotes <= 2) return true;
	// Repeated "Title:" / note-id style inventory
	if ((t.match(/\b[a-f0-9]{32}\b/gi) || []).length >= 5) return true;
	return false;
}

async function synthesizeSummary(
	provider: LLMProvider,
	userText: string,
	sources: SummarySource[],
	notebookHint: string,
	onUsage?: (raw: unknown) => Promise<void>
): Promise<string> {
	const pack = sources
		.map((s, i) => {
			const loc = s.path ? ` (${s.path})` : '';
			return `### Note ${i + 1}: ${s.title}${loc}\n${s.excerpt || '(empty)'}`;
		})
		.join('\n\n');

	const scope = notebookHint ? `Notebook focus: ${notebookHint}\n` : '';
	const res = await provider.chat({
		messages: [
			{
				role: 'system',
				content:
					`You write high-quality summaries of Joplin notebooks and notes.\n` +
					`Hard rules:\n` +
					`- Produce a SYNTHESIZED overview a human can skim in under a minute.\n` +
					`- Structure: (1) 2–4 sentence overall picture, (2) themed sections or bullets, ` +
					`(3) optional "Notable items" with at most 8 bullets, (4) brief list of note titles cited.\n` +
					`- Target 150–350 words.\n` +
					`- Do NOT paste raw note bodies, full URL lists, markdown tables, or tool JSON.\n` +
					`- Do NOT produce a table of contents or one bullet per note unless there are ≤5 notes.\n` +
					`- Group by theme. Merge overlapping tips. Prefer prose over inventories.\n` +
					`- Only use facts present in the source material. Do not invent.`,
			},
			{
				role: 'user',
				content:
					`User request:\n${userText}\n\n` +
					scope +
					`Compressed source material (${sources.length} note(s)):\n\n` +
					pack.slice(0, 28000) +
					`\n\nWrite the synthesized summary now. No preamble about tools.`,
			},
		],
		temperature: 0.2,
	});
	if (onUsage) await onUsage(res.raw);
	return (res.message.content || '').trim();
}

export async function runAgentTurn(
	history: ChatMessage[],
	userText: string
): Promise<AgentTurnResult> {
	const settings = await loadSettings();
	const access = await buildAccessContext();
	const provider = await createProvider(settings);

	const wantsSummary = isSummaryRequest(userText);
	const effectiveUser = wantsSummary ? wrapSummaryUserRequest(userText) : userText;

	const system: ChatMessage = {
		role: 'system',
		content: buildSystemPrompt(settings.systemPromptOverride, access),
	};

	const messages: ChatMessage[] = [
		system,
		...history.filter((m) => m.role !== 'system'),
		{ role: 'user', content: effectiveUser },
	];

	const toolTrace: AgentTurnResult['toolTrace'] = [];
	const maxSteps = Math.max(1, Math.min(20, settings.maxToolSteps || 8));
	const trackUsage = settings.trackUsage !== false;
	const model = modelForProvider(settings);
	const authMode = settings.provider === 'xai' ? settings.xaiAuthMode : settings.provider;
	let lastUsageRec: UsageRecord | null = null;

	const track = async (raw: unknown) => {
		if (!trackUsage) return;
		try {
			const rec = await recordChatUsage({
				raw,
				model,
				provider: settings.provider,
				authMode,
			});
			if (rec) lastUsageRec = rec;
		} catch {
			/* ignore usage errors */
		}
	};

	try {
		let finalAssistant = '';

		for (let step = 0; step < maxSteps; step++) {
			// Refresh access each step so block_notebook takes effect mid-turn
			const stepAccess = step === 0 ? access : await buildAccessContext();

			const response = await provider.chat({
				messages,
				tools: TOOL_SPECS,
				// Slightly lower temp for summaries so output stays structured
				temperature: wantsSummary ? 0.2 : 0.3,
			});
			await track(response.raw);

			const msg = response.message;
			messages.push({
				role: 'assistant',
				content: msg.content,
				tool_calls: msg.tool_calls,
			});

			const calls = msg.tool_calls;
			if (!calls || !calls.length) {
				finalAssistant = msg.content || '(No response)';
				break;
			}

			for (const call of calls) {
				const name = call.function?.name || '';
				const args = call.function?.arguments || '{}';
				let result: unknown;
				try {
					result = await executeTool(name, args, { access: stepAccess, settings });
				} catch (e: any) {
					result = { error: e.message || String(e) };
				}
				// Full result for UI tool trace; compact form for the model
				toolTrace.push({ name, args, result });
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: toolResultForModel(name, result, wantsSummary),
				});
			}
		}

		if (!finalAssistant && toolTrace.length) {
			finalAssistant =
				'I hit the tool-step limit before finishing. Partial tool results are in the trace — try a more specific request.';
		}
		if (!finalAssistant) {
			finalAssistant = '(No response)';
		}

		// Summary requests: always (when we have sources) replace with a forced synthesis
		// so the user never gets a raw note dump as the "answer".
		if (wantsSummary) {
			const { sources, notebookHint } = await collectSummarySources(toolTrace);
			if (sources.length > 0) {
				try {
					const synthesized = await synthesizeSummary(
						provider,
						userText,
						sources,
						notebookHint,
						track
					);
					if (synthesized) {
						finalAssistant = synthesized;
					}
				} catch (e: any) {
					// Keep agent text if synthesis fails; optionally re-prompt dump
					if (looksLikeContentDump(finalAssistant)) {
						finalAssistant =
							finalAssistant +
							'\n\n_(Automatic re-synthesis failed: ' +
							(e.message || String(e)) +
							')_';
					}
				}
			} else if (looksLikeContentDump(finalAssistant)) {
				// Agent dumped without usable tools — ask model to rewrite from its own draft
				try {
					const rewrite = await provider.chat({
						messages: [
							{
								role: 'system',
								content:
									'Rewrite the following into a concise synthesized summary (150–350 words). ' +
									'Remove raw dumps, URL lists, and tables. Group by theme.',
							},
							{
								role: 'user',
								content: `User asked: ${userText}\n\nDraft to rewrite:\n${finalAssistant.slice(0, 12000)}`,
							},
						],
						temperature: 0.2,
					});
					await track(rewrite.raw);
					if (rewrite.message.content?.trim()) {
						finalAssistant = rewrite.message.content.trim();
					}
				} catch {
					/* keep original */
				}
			}
		}

		let usageFooter = '';
		if (trackUsage) {
			try {
				const snap = await getUsageSnapshot();
				usageFooter = formatUsageFooter(lastUsageRec, snap.session, authMode);
			} catch {
				/* ignore */
			}
		}

		return {
			assistantMessage: finalAssistant,
			toolTrace,
			usageFooter: usageFooter || undefined,
		};
	} catch (e: any) {
		return {
			assistantMessage: '',
			toolTrace,
			error: e.message || String(e),
		};
	}
}

/** Simple chat without tools (fallback / connection test). */
export async function runSimpleChat(userText: string): Promise<string> {
	const settings = await loadSettings();
	const access = await buildAccessContext();
	const provider = await createProvider(settings);
	const res = await provider.chat({
		messages: [
			{ role: 'system', content: buildSystemPrompt(settings.systemPromptOverride, access) },
			{ role: 'user', content: userText },
		],
		temperature: 0.4,
	});
	return res.message.content || '';
}
