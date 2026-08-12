/**
 * Load API keys from outside the repo (never commit secrets).
 *
 * Sources (first non-empty wins), per key:
 *  1. process.env
 *  2. ~/.grok/.env  and  ~/.grok/api_key (xAI only)
 *  3. project .env next to package.json / cwd (local dev only; gitignored)
 *  4. Joplin secure settings (caller passes as last resort)
 *
 * SuperGrok OAuth remains in ~/.grok/auth.json (see xaiOAuth.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SecretKind = 'xai' | 'openrouter' | 'openai';

export interface ResolvedSecret {
	value: string;
	/** Where the key was found (for status labels; never log the value). */
	source: string;
}

const ENV_NAMES: Record<SecretKind, string[]> = {
	xai: ['XAI_API_KEY', 'GROK_API_KEY'],
	openrouter: ['OPENROUTER_API_KEY'],
	openai: ['OPENAI_API_KEY'],
};

function grokDir(): string {
	return path.join(os.homedir(), '.grok');
}

/** Minimal KEY=value parser (no export keyword required). */
function parseDotEnv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const cleaned = trimmed.startsWith('export ')
			? trimmed.slice('export '.length).trim()
			: trimmed;
		const eq = cleaned.indexOf('=');
		if (eq <= 0) continue;
		const key = cleaned.slice(0, eq).trim();
		let val = cleaned.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (key) out[key] = val;
	}
	return out;
}

function readFileIfExists(filePath: string): string | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return null;
	}
}

function readDotEnvFile(filePath: string): Record<string, string> {
	const raw = readFileIfExists(filePath);
	if (!raw) return {};
	return parseDotEnv(raw);
}

/** Candidate .env paths for local plugin development (all gitignored). */
function projectEnvPaths(): string[] {
	const paths: string[] = [];
	try {
		// Joplin often runs with cwd = app path; also try common plugin roots.
		paths.push(path.join(process.cwd(), '.env'));
		// When the plugin is loaded from a development folder:
		// .../joplin-plugin-grok/dist/index.js → repo root .env
		const here = typeof __dirname !== 'undefined' ? __dirname : '';
		if (here) {
			paths.push(path.resolve(here, '..', '.env'));
			paths.push(path.resolve(here, '..', '..', '.env'));
		}
	} catch {
		/* ignore */
	}
	return [...new Set(paths)];
}

function fromEnvNames(names: string[], env: NodeJS.ProcessEnv): string {
	for (const name of names) {
		const v = String(env[name] || '').trim();
		if (v) return v;
	}
	return '';
}

function fromDotEnvMap(map: Record<string, string>, names: string[]): string {
	for (const name of names) {
		const v = String(map[name] || '').trim();
		if (v) return v;
	}
	return '';
}

/**
 * Resolve an API key. Never returns tokens from SuperGrok OAuth (auth.json).
 * `settingsValue` is the Joplin secure setting (optional last resort).
 */
export function resolveApiKey(
	kind: SecretKind,
	settingsValue?: string
): ResolvedSecret | null {
	const names = ENV_NAMES[kind];

	// 1) process.env
	const fromProc = fromEnvNames(names, process.env);
	if (fromProc) {
		return { value: fromProc, source: `env:${names.find((n) => process.env[n])}` };
	}

	// 2) ~/.grok/.env
	const grokEnv = readDotEnvFile(path.join(grokDir(), '.env'));
	const fromGrokEnv = fromDotEnvMap(grokEnv, names);
	if (fromGrokEnv) {
		return { value: fromGrokEnv, source: '~/.grok/.env' };
	}

	// 2b) ~/.grok/api_key — plain file for xAI only (one key, no KEY= prefix)
	if (kind === 'xai') {
		const plain = readFileIfExists(path.join(grokDir(), 'api_key'));
		if (plain) {
			const line = plain
				.split(/\r?\n/)
				.map((l) => l.trim())
				.find((l) => l && !l.startsWith('#'));
			if (line) {
				// Allow "XAI_API_KEY=..." or raw key
				const m = line.match(/^(?:XAI_API_KEY|GROK_API_KEY)\s*=\s*(.+)$/i);
				const key = (m ? m[1].trim().replace(/^["']|["']$/g, '') : line).trim();
				if (key) return { value: key, source: '~/.grok/api_key' };
			}
		}
	}

	// 3) project .env (gitignored)
	for (const envPath of projectEnvPaths()) {
		const map = readDotEnvFile(envPath);
		const v = fromDotEnvMap(map, names);
		if (v) {
			return { value: v, source: envPath };
		}
	}

	// 4) Joplin settings (local keychain / secure storage — not in git)
	const fromSettings = String(settingsValue || '').trim();
	if (fromSettings) {
		return { value: fromSettings, source: 'joplin-settings' };
	}

	return null;
}

export function resolveXaiApiKey(settingsValue?: string): ResolvedSecret | null {
	return resolveApiKey('xai', settingsValue);
}

export function resolveOpenRouterApiKey(settingsValue?: string): ResolvedSecret | null {
	return resolveApiKey('openrouter', settingsValue);
}

export function resolveOpenAiApiKey(settingsValue?: string): ResolvedSecret | null {
	return resolveApiKey('openai', settingsValue);
}

/** Short status line for the chat panel / settings (never includes the secret). */
export function describeSecretSources(): string {
	const bits: string[] = [];
	const xai = resolveXaiApiKey();
	if (xai) bits.push(`xAI key via ${xai.source}`);
	const or = resolveOpenRouterApiKey();
	if (or) bits.push(`OpenRouter key via ${or.source}`);
	const authPath = path.join(grokDir(), 'auth.json');
	if (fs.existsSync(authPath)) bits.push('SuperGrok session ~/.grok/auth.json');
	return bits.join(' · ') || 'No external keys found';
}
