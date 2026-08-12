/**
 * Optional token / USD usage tracking (subtle — not a primary UI surface).
 *
 * USD estimates use published xAI API list rates. SuperGrok OAuth sessions may
 * bill under the consumer subscription instead; we still show token counts and
 * label USD as an estimate.
 */
import * as fs from 'fs';
import * as path from 'path';
import joplin from 'api';

export interface TokenUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface UsageRecord {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/** Estimated USD at list API rates (may not match SuperGrok subscription). */
	estimated_usd: number;
	model: string;
	provider: string;
	authMode: string;
	at: string;
}

export interface UsageTotals {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	estimated_usd: number;
	calls: number;
	updatedAt: string;
}

export interface UsageState {
	version: 1;
	/** Since last reset / plugin install */
	lifetime: UsageTotals;
	/** Current Joplin session (reset on restart) */
	session: UsageTotals;
	recent: UsageRecord[];
}

const STORE_FILE = 'usage.json';
const MAX_RECENT = 40;

/** Published short-context API rates USD per 1M tokens (approximate). */
const MODEL_RATES: Record<string, { input: number; output: number }> = {
	'grok-4.5': { input: 2.0, output: 6.0 },
	'grok-4.6': { input: 2.0, output: 6.0 },
	'grok-4': { input: 3.0, output: 15.0 },
	'grok-3': { input: 3.0, output: 15.0 },
	'grok-3-mini': { input: 0.3, output: 0.5 },
	'grok-2': { input: 2.0, output: 10.0 },
	'grok-2-1212': { input: 2.0, output: 10.0 },
	'grok-code-fast-1': { input: 0.2, output: 1.5 },
	// OpenRouter / generic fallbacks
	'x-ai/grok-4.5': { input: 2.0, output: 6.0 },
	'x-ai/grok-4': { input: 3.0, output: 15.0 },
};

const DEFAULT_RATE = { input: 2.0, output: 6.0 };

let sessionTotals: UsageTotals = emptyTotals();
let memoryState: UsageState | null = null;

function emptyTotals(): UsageTotals {
	return {
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		estimated_usd: 0,
		calls: 0,
		updatedAt: new Date().toISOString(),
	};
}

function rateForModel(model: string): { input: number; output: number } {
	const m = (model || '').toLowerCase().trim();
	if (MODEL_RATES[m]) return MODEL_RATES[m];
	// Fuzzy match
	for (const [key, rate] of Object.entries(MODEL_RATES)) {
		if (m.includes(key) || key.includes(m)) return rate;
	}
	if (m.includes('grok-4.5') || m.includes('grok-4-5')) return MODEL_RATES['grok-4.5'];
	if (m.includes('mini')) return MODEL_RATES['grok-3-mini'];
	if (m.includes('fast')) return MODEL_RATES['grok-code-fast-1'];
	return DEFAULT_RATE;
}

export function estimateUsd(
	promptTokens: number,
	completionTokens: number,
	model: string
): number {
	const r = rateForModel(model);
	return (promptTokens / 1_000_000) * r.input + (completionTokens / 1_000_000) * r.output;
}

export function parseUsageFromApi(raw: unknown): TokenUsage | null {
	if (!raw || typeof raw !== 'object') return null;
	const u = (raw as any).usage;
	if (!u || typeof u !== 'object') return null;
	const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
	const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
	const total = Number(u.total_tokens ?? prompt + completion) || prompt + completion;
	if (prompt <= 0 && completion <= 0 && total <= 0) return null;
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function addToTotals(t: UsageTotals, rec: UsageRecord): UsageTotals {
	return {
		prompt_tokens: t.prompt_tokens + rec.prompt_tokens,
		completion_tokens: t.completion_tokens + rec.completion_tokens,
		total_tokens: t.total_tokens + rec.total_tokens,
		estimated_usd: t.estimated_usd + rec.estimated_usd,
		calls: t.calls + 1,
		updatedAt: rec.at,
	};
}

async function storePath(): Promise<string> {
	const dir = await joplin.plugins.dataDir();
	return path.join(dir, STORE_FILE);
}

async function loadState(): Promise<UsageState> {
	if (memoryState) {
		memoryState.session = sessionTotals;
		return memoryState;
	}
	try {
		const file = await storePath();
		if (fs.existsSync(file)) {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as UsageState;
			if (raw && raw.lifetime) {
				memoryState = {
					version: 1,
					lifetime: { ...emptyTotals(), ...raw.lifetime },
					session: sessionTotals,
					recent: Array.isArray(raw.recent) ? raw.recent.slice(0, MAX_RECENT) : [],
				};
				return memoryState;
			}
		}
	} catch (e) {
		console.warn('Joplin Grok: usage load failed', e);
	}
	memoryState = {
		version: 1,
		lifetime: emptyTotals(),
		session: sessionTotals,
		recent: [],
	};
	return memoryState;
}

async function saveState(state: UsageState): Promise<void> {
	memoryState = state;
	try {
		const file = await storePath();
		const dir = path.dirname(file);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		// Persist lifetime + recent only (session is process-local)
		const disk = {
			version: 1 as const,
			lifetime: state.lifetime,
			recent: state.recent,
		};
		fs.writeFileSync(file, JSON.stringify(disk, null, 2), 'utf8');
	} catch (e) {
		console.warn('Joplin Grok: usage save failed', e);
	}
}

export async function recordChatUsage(opts: {
	raw: unknown;
	model: string;
	provider: string;
	authMode: string;
}): Promise<UsageRecord | null> {
	const usage = parseUsageFromApi(opts.raw);
	if (!usage) return null;
	const at = new Date().toISOString();
	const estimated_usd = estimateUsd(usage.prompt_tokens, usage.completion_tokens, opts.model);
	const rec: UsageRecord = {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		estimated_usd,
		model: opts.model,
		provider: opts.provider,
		authMode: opts.authMode,
		at,
	};

	sessionTotals = addToTotals(sessionTotals, rec);
	const state = await loadState();
	state.session = sessionTotals;
	state.lifetime = addToTotals(state.lifetime, rec);
	state.recent = [rec, ...state.recent].slice(0, MAX_RECENT);
	await saveState(state);
	return rec;
}

export async function getUsageSnapshot(): Promise<UsageState> {
	const state = await loadState();
	state.session = sessionTotals;
	return state;
}

export async function resetLifetimeUsage(): Promise<void> {
	sessionTotals = emptyTotals();
	const state: UsageState = {
		version: 1,
		lifetime: emptyTotals(),
		session: sessionTotals,
		recent: [],
	};
	await saveState(state);
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

export function formatUsd(n: number): string {
	if (n < 0.0001 && n > 0) return '<$0.0001';
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/** One-line muted footer for chat (not prominent). */
export function formatUsageFooter(
	rec: UsageRecord | null,
	session: UsageTotals,
	authMode: string
): string {
	if (!rec && session.calls === 0) return '';
	const parts: string[] = [];
	if (rec) {
		parts.push(`this turn ${formatTokens(rec.total_tokens)} tok`);
		if (authMode === 'api_key') {
			parts.push(`~${formatUsd(rec.estimated_usd)}`);
		} else {
			parts.push(`~${formatUsd(rec.estimated_usd)} est.`);
		}
	}
	if (session.calls > 0) {
		parts.push(
			`session ${formatTokens(session.total_tokens)} tok · ${formatUsd(session.estimated_usd)}${
				authMode === 'super_grok' ? ' est.' : ''
			}`
		);
	}
	return parts.length ? `Usage · ${parts.join(' · ')}` : '';
}

export function formatUsageReport(state: UsageState, authMode: string, model: string): string {
	const rate = rateForModel(model);
	const subNote =
		authMode === 'super_grok'
			? '\n\nAuth: SuperGrok OAuth — token counts are from the API; USD is an estimate at published API list rates and may not match SuperGrok subscription billing.'
			: '\n\nAuth: API key — USD estimate uses published xAI list rates (short context).';

	const line = (label: string, t: UsageTotals) =>
		`${label}\n` +
		`  Calls: ${t.calls}\n` +
		`  Tokens: ${formatTokens(t.total_tokens)} total` +
		` (${formatTokens(t.prompt_tokens)} in / ${formatTokens(t.completion_tokens)} out)\n` +
		`  Est. USD: ${formatUsd(t.estimated_usd)}`;

	const rates =
		`List rates used for ${model || 'default'}: ` +
		`$${rate.input}/1M in · $${rate.output}/1M out`;

	return (
		`Grok usage (plugin-local)\n\n` +
		`${line('This session', state.session)}\n\n` +
		`${line('Lifetime (this device)', state.lifetime)}\n\n` +
		rates +
		subNote
	);
}
