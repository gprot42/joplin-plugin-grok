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
	const v = Math.round(n);
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	// Prefer full count with commas under 100k so cost context is readable
	if (v >= 100_000) return `${Math.round(v / 1000)}k`;
	return v.toLocaleString('en-US');
}

export function formatUsd(n: number): string {
	if (n <= 0) return '$0.00';
	if (n < 0.0001) return '<$0.0001';
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/**
 * Compact footer under chat replies: cost + total tokens only.
 */
export function formatUsageFooter(
	rec: UsageRecord | null,
	session: UsageTotals,
	_authMode: string
): string {
	if (!rec && session.calls === 0) return '';

	// Prefer this-reply numbers; fall back to session if no per-call record
	const usd = rec ? rec.estimated_usd : session.estimated_usd;
	const tokens = rec ? rec.total_tokens : session.total_tokens;
	return `${formatUsd(usd)} · ${formatTokens(tokens)} tokens`;
}

export function formatUsageReport(state: UsageState, authMode: string, model: string): string {
	const rate = rateForModel(model);
	const billingNote =
		authMode === 'super_grok'
			? 'Billing mode: SuperGrok OAuth\n' +
				'Token counts come from the API response.\n' +
				'USD is estimated from published API list rates and may not match SuperGrok subscription billing.'
			: 'Billing mode: API key (console credits)\n' +
				'USD is estimated from published xAI list rates (short-context tier).';

	const block = (label: string, t: UsageTotals) =>
		`${label}\n` +
		`  Estimated cost: ${formatUsd(t.estimated_usd)}\n` +
		`  Tokens: ${formatTokens(t.total_tokens)} total` +
		`  (${formatTokens(t.prompt_tokens)} input + ${formatTokens(t.completion_tokens)} output)\n` +
		`  API calls: ${t.calls}`;

	const rates =
		`Rate table used for “${model || 'default'}”:\n` +
		`  Input  ${formatUsd(rate.input)} per 1M tokens\n` +
		`  Output ${formatUsd(rate.output)} per 1M tokens`;

	return (
		`Grok usage (tracked on this device only)\n\n` +
		`${block('This Joplin session', state.session)}\n\n` +
		`${block('Lifetime (since last reset)', state.lifetime)}\n\n` +
		`${rates}\n\n` +
		billingNote
	);
}
