/**
 * SuperGrok device-code sign-in for Joplin settings.
 */
import joplin from 'api';
import { persistPluginOAuth } from './resolveXaiAuth';
import { requestDeviceCode, waitForDeviceAuthorization } from './xaiOAuth';
import { SettingKey } from '../settings';

/**
 * Starts OIDC device login, shows the user code, waits for approval, stores tokens.
 */
export async function runSuperGrokDeviceLogin(): Promise<void> {
	const device = await requestDeviceCode();
	const url =
		device.verificationUriComplete ||
		`${device.verificationUri}?user_code=${encodeURIComponent(device.userCode)}`;

	await joplin.views.dialogs.showMessageBox(
		`Sign in with SuperGrok / SuperGrok Heavy\n\n` +
			`1. Open: ${url}\n` +
			`2. Confirm code: ${device.userCode}\n\n` +
			`Click OK, then approve in the browser. Joplin will wait up to 15 minutes.`
	);

	try {
		const tokens = await waitForDeviceAuthorization(
			device.deviceCode,
			device.intervalSeconds
		);
		await persistPluginOAuth(tokens);
		const label = [
			tokens.tierLabel || 'SuperGrok',
			tokens.email,
			tokens.teamId ? `team ${tokens.teamId.slice(0, 8)}…` : '',
		]
			.filter(Boolean)
			.join(' · ');
		await joplin.settings.setValue(SettingKey.OAuthTierLabel, label);
		await joplin.settings.setValue(SettingKey.XaiAuthMode, 'super_grok');
	} catch (e: any) {
		await joplin.views.dialogs.showMessageBox(
			`SuperGrok sign-in failed: ${e?.message || String(e)}`
		);
	}
}

/** Best-effort status string for settings display from CLI auth or stored session. */
export async function syncSuperGrokSessionLabel(): Promise<void> {
	try {
		const { loadGrokCliAuth, describeToken } = await import('./xaiOAuth');
		const { resolveXaiAuth } = await import('./resolveXaiAuth');
		const mode = String(
			(await joplin.settings.value(SettingKey.XaiAuthMode)) || 'super_grok'
		);
		if (mode !== 'super_grok') {
			await joplin.settings.setValue(
				SettingKey.OAuthTierLabel,
				'Using API key mode (console.x.ai credits)'
			);
			return;
		}
		// Prefer resolve (refreshes if needed)
		try {
			const auth = await resolveXaiAuth('super_grok', '');
			const bits = [auth.tierLabel || auth.label, auth.email].filter(Boolean);
			await joplin.settings.setValue(SettingKey.OAuthTierLabel, bits.join(' · '));
			return;
		} catch {
			/* fall through */
		}
		const cli = loadGrokCliAuth();
		if (cli) {
			const meta = describeToken(cli.accessToken);
			const bits = [
				meta.tierLabel || cli.tierLabel || 'SuperGrok',
				cli.email || meta.email,
				'(from ~/.grok/auth.json — may need refresh)',
			].filter(Boolean);
			await joplin.settings.setValue(SettingKey.OAuthTierLabel, bits.join(' · '));
			return;
		}
		await joplin.settings.setValue(
			SettingKey.OAuthTierLabel,
			'Not signed in — run `grok login` or enable “Sign in with SuperGrok”'
		);
	} catch {
		/* ignore */
	}
}
