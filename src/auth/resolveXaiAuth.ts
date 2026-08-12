/**
 * Resolve the bearer token for xAI API calls:
 * SuperGrok OAuth (Heavy) vs console API key.
 *
 * API keys are loaded from env / ~/.grok / project .env / Joplin settings
 * (see secrets.ts) — never from the git repo.
 */
import joplin from 'api';
import { SettingKey } from '../settings';
import { resolveXaiApiKey } from './secrets';
import {
	describeToken,
	loadGrokCliAuth,
	OAuthTokens,
	refreshAccessToken,
} from './xaiOAuth';

export type XaiAuthMode = 'api_key' | 'super_grok';

export interface ResolvedXaiAuth {
	bearerToken: string;
	mode: XaiAuthMode;
	label: string;
	tierLabel?: string;
	email?: string;
	teamId?: string;
}

const SKEW_MS = 120_000; // refresh 2 minutes early

async function readPluginOAuth(): Promise<OAuthTokens | null> {
	const access = String(
		(await joplin.settings.value(SettingKey.OAuthAccessToken).catch(() => '')) || ''
	).trim();
	if (!access) return null;
	const refresh = String(
		(await joplin.settings.value(SettingKey.OAuthRefreshToken).catch(() => '')) || ''
	).trim();
	const expiresAt = Number(
		(await joplin.settings.value(SettingKey.OAuthExpiresAt).catch(() => 0)) || 0
	);
	const meta = describeToken(access);
	return {
		accessToken: access,
		refreshToken: refresh || undefined,
		expiresAtEpochMs: expiresAt || meta.expEpochMs || 0,
		email: meta.email,
		tier: meta.tier,
		tierLabel: meta.tierLabel,
		teamId: meta.teamId,
		source: 'plugin',
	};
}

export async function persistPluginOAuth(tokens: OAuthTokens): Promise<void> {
	await joplin.settings.setValue(SettingKey.OAuthAccessToken, tokens.accessToken);
	if (tokens.refreshToken) {
		await joplin.settings.setValue(SettingKey.OAuthRefreshToken, tokens.refreshToken);
	}
	await joplin.settings.setValue(
		SettingKey.OAuthExpiresAt,
		String(tokens.expiresAtEpochMs || 0)
	);
	if (tokens.email) {
		await joplin.settings.setValue(SettingKey.OAuthEmail, tokens.email);
	}
	if (tokens.tierLabel) {
		await joplin.settings.setValue(SettingKey.OAuthTierLabel, tokens.tierLabel);
	}
}

async function ensureFresh(tokens: OAuthTokens): Promise<OAuthTokens> {
	const now = Date.now();
	if (tokens.accessToken && tokens.expiresAtEpochMs > now + SKEW_MS) {
		return tokens;
	}
	if (!tokens.refreshToken) {
		if (tokens.accessToken && tokens.expiresAtEpochMs > now) return tokens;
		throw new Error(
			'SuperGrok session expired. Run `grok login` in a terminal, or Configuration → Sign in with SuperGrok.'
		);
	}
	const refreshed = await refreshAccessToken(tokens.refreshToken);
	await persistPluginOAuth(refreshed);
	return refreshed;
}

/**
 * Resolve bearer for xAI requests based on auth mode.
 * SuperGrok mode prefers ~/.grok/auth.json then plugin-stored OAuth tokens.
 * API key mode prefers env / ~/.grok / .env, then Joplin settings.
 */
export async function resolveXaiAuth(mode: XaiAuthMode, apiKey: string): Promise<ResolvedXaiAuth> {
	if (mode === 'api_key') {
		const resolved = resolveXaiApiKey(apiKey);
		if (!resolved) {
			throw new Error(
				'xAI API key is not set. Put it in ~/.grok/.env (XAI_API_KEY=…), ~/.grok/api_key, project .env (gitignored), or Configuration → Joplin Grok AI. Or switch Auth mode to SuperGrok Heavy (`grok login`).'
			);
		}
		return {
			bearerToken: resolved.value,
			mode: 'api_key',
			label: `API key (${resolved.source})`,
		};
	}

	// SuperGrok OAuth path (Heavy subscription when JWT tier=5)
	const candidates: OAuthTokens[] = [];
	const cli = loadGrokCliAuth();
	if (cli) candidates.push(cli);
	const plugin = await readPluginOAuth();
	if (plugin) candidates.push(plugin);

	if (!candidates.length) {
		throw new Error(
			'No SuperGrok session found. Run `grok login` in a terminal (uses SuperGrok / SuperGrok Heavy), or Configuration → Sign in with SuperGrok. Note: SuperGrok is separate from console.x.ai API prepaid credits.'
		);
	}

	// Prefer the token that is still valid / has refresh
	let lastError: Error | null = null;
	for (const cand of candidates) {
		try {
			const fresh = await ensureFresh(cand);
			const meta = describeToken(fresh.accessToken);
			return {
				bearerToken: fresh.accessToken,
				mode: 'super_grok',
				label: meta.tierLabel || fresh.tierLabel || 'SuperGrok',
				tierLabel: meta.tierLabel || fresh.tierLabel,
				email: fresh.email || meta.email,
				teamId: fresh.teamId || meta.teamId,
			};
		} catch (e: any) {
			lastError = e instanceof Error ? e : new Error(String(e));
		}
	}
	throw lastError || new Error('Could not resolve SuperGrok credentials.');
}
