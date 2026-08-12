/**
 * SuperGrok / SuperGrok Heavy OAuth (OIDC device flow + Grok CLI auth file).
 * Ported from android-tiny-ggrok (XaiOAuthClient / SuperGrokAuthRepository).
 *
 * SuperGrok Heavy is JWT tier=5. Tokens come from:
 *   - ~/.grok/auth.json (after `grok login`), or
 *   - plugin-stored OAuth session after device-code sign-in / refresh
 *
 * Note: console.x.ai API prepaid credits are a separate product from SuperGrok.
 * OAuth bearer may use the consumer SuperGrok path (different team/billing).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const XAI_OIDC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
export const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const XAI_OAUTH_SCOPE =
	'openid profile email offline_access api:access grok-cli:access';
export const XAI_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const JWT_TIER_LABELS: Record<number, string> = {
	0: 'Free',
	1: 'Free / entry',
	2: 'SuperGrok Lite',
	3: 'SuperGrok',
	4: 'X Premium+',
	5: 'SuperGrok Heavy',
};

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAtEpochMs: number;
	email?: string;
	tier?: number;
	tierLabel?: string;
	teamId?: string;
	source: 'grok-cli' | 'plugin' | 'refresh';
}

export interface DeviceCodeResponse {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

type PollResult =
	| { status: 'success'; tokens: OAuthTokens }
	| { status: 'pending'; reason: string }
	| { status: 'denied' | 'expired' | 'error'; message: string };

function grokAuthPath(): string {
	return path.join(os.homedir(), '.grok', 'auth.json');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
	try {
		const parts = jwt.split('.');
		if (parts.length < 2) return null;
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const pad = '='.repeat((4 - (b64.length % 4)) % 4);
		const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function describeToken(accessToken: string): {
	email?: string;
	tier?: number;
	tierLabel?: string;
	teamId?: string;
	expEpochMs?: number;
} {
	const payload = decodeJwtPayload(accessToken);
	if (!payload) return {};
	const tier = typeof payload.tier === 'number' ? payload.tier : undefined;
	const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
	return {
		email: typeof payload.email === 'string' ? payload.email : undefined,
		tier,
		tierLabel: tier !== undefined ? JWT_TIER_LABELS[tier] || `Tier ${tier}` : undefined,
		teamId: typeof payload.team_id === 'string' ? payload.team_id : undefined,
		expEpochMs: exp,
	};
}

/** Load SuperGrok OIDC session written by `grok login` / Grok CLI. */
export function loadGrokCliAuth(): OAuthTokens | null {
	const authPath = grokAuthPath();
	if (!fs.existsSync(authPath)) return null;
	try {
		const raw = fs.readFileSync(authPath, 'utf8');
		const data = JSON.parse(raw) as Record<string, any>;
		const preferredKey = `https://auth.x.ai::${XAI_OIDC_CLIENT_ID}`;
		const entry =
			data[preferredKey] ||
			Object.values(data).find(
				(v: any) =>
					v &&
					typeof v === 'object' &&
					(v.auth_mode === 'oidc' || v.oidc_issuer === 'https://auth.x.ai')
			);
		if (!entry || typeof entry !== 'object') return null;
		const access = String(entry.key || entry.access_token || '').trim();
		if (!access) return null;
		const refresh = String(entry.refresh_token || '').trim() || undefined;
		const meta = describeToken(access);
		let expiresAt = meta.expEpochMs || 0;
		if (entry.expires_at) {
			const t = Date.parse(String(entry.expires_at));
			if (Number.isFinite(t)) expiresAt = t;
		}
		return {
			accessToken: access,
			refreshToken: refresh,
			expiresAtEpochMs: expiresAt,
			email: entry.email || meta.email,
			tier: meta.tier,
			tierLabel: meta.tierLabel,
			teamId: entry.team_id || meta.teamId,
			source: 'grok-cli',
		};
	} catch {
		return null;
	}
}

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: XAI_OIDC_CLIENT_ID,
	});
	const res = await fetch(XAI_TOKEN_URL, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`SuperGrok token refresh failed HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	const json = JSON.parse(text) as Record<string, unknown>;
	const access = String(json.access_token || '').trim();
	if (!access) throw new Error('SuperGrok token refresh missing access_token');
	const refresh = String(json.refresh_token || '').trim() || refreshToken;
	const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
	const meta = describeToken(access);
	return {
		accessToken: access,
		refreshToken: refresh,
		expiresAtEpochMs: Date.now() + expiresIn * 1000,
		email: meta.email,
		tier: meta.tier,
		tierLabel: meta.tierLabel,
		teamId: meta.teamId,
		source: 'refresh',
	};
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
	const body = new URLSearchParams({
		client_id: XAI_OIDC_CLIENT_ID,
		scope: XAI_OAUTH_SCOPE,
	});
	const res = await fetch(XAI_DEVICE_CODE_URL, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Device code request failed HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	const json = JSON.parse(text) as Record<string, unknown>;
	return {
		deviceCode: String(json.device_code || ''),
		userCode: String(json.user_code || ''),
		verificationUri: String(json.verification_uri || 'https://accounts.x.ai/oauth2/device'),
		verificationUriComplete: json.verification_uri_complete
			? String(json.verification_uri_complete)
			: undefined,
		expiresInSeconds: Number(json.expires_in) || 1800,
		intervalSeconds: Math.max(1, Number(json.interval) || 5),
	};
}

export async function pollDeviceToken(deviceCode: string): Promise<PollResult> {
	const body = new URLSearchParams({
		grant_type: XAI_DEVICE_GRANT,
		device_code: deviceCode,
		client_id: XAI_OIDC_CLIENT_ID,
	});
	const res = await fetch(XAI_TOKEN_URL, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	});
	const text = await res.text();
	if (res.ok) {
		const json = JSON.parse(text) as Record<string, unknown>;
		const access = String(json.access_token || '').trim();
		if (!access) return { status: 'error', message: 'Missing access_token' };
		const refresh = String(json.refresh_token || '').trim() || undefined;
		const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
		const meta = describeToken(access);
		return {
			status: 'success',
			tokens: {
				accessToken: access,
				refreshToken: refresh,
				expiresAtEpochMs: Date.now() + expiresIn * 1000,
				email: meta.email,
				tier: meta.tier,
				tierLabel: meta.tierLabel,
				teamId: meta.teamId,
				source: 'plugin',
			},
		};
	}
	let err = '';
	let desc = text.slice(0, 200);
	try {
		const json = JSON.parse(text) as Record<string, unknown>;
		err = String(json.error || '');
		desc = String(json.error_description || json.error || desc);
	} catch {
		/* ignore */
	}
	if (err === 'authorization_pending' || err === 'slow_down') {
		return { status: 'pending', reason: err };
	}
	if (err === 'access_denied') return { status: 'denied', message: desc };
	if (err === 'expired_token') return { status: 'expired', message: desc };
	return { status: 'error', message: `HTTP ${res.status}: ${desc}` };
}

export async function waitForDeviceAuthorization(
	deviceCode: string,
	intervalSeconds: number,
	maxWaitMs = 15 * 60_000
): Promise<OAuthTokens> {
	const deadline = Date.now() + maxWaitMs;
	let intervalMs = Math.max(1, intervalSeconds) * 1000;
	while (Date.now() < deadline) {
		const result = await pollDeviceToken(deviceCode);
		if (result.status === 'success') return result.tokens;
		if (result.status === 'pending') {
			if (result.reason === 'slow_down') {
				intervalMs = Math.min(intervalMs + 2000, 15_000);
			}
			await new Promise((r) => setTimeout(r, intervalMs));
			continue;
		}
		throw new Error(result.message || result.status);
	}
	throw new Error('Timed out waiting for SuperGrok approval.');
}
