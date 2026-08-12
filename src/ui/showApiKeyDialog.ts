/**
 * Dialog to reveal/copy the resolved xAI API key.
 * Show sits on the same row as the key field (not possible in Joplin's settings grid).
 * Resolves from env / ~/.grok / project .env / Joplin settings (see secrets.ts).
 */
import joplin from 'api';
import { ViewHandle } from 'api/types';
import { resolveXaiApiKey } from '../auth/secrets';
import { SettingKey } from '../settings';

const DIALOG_ID = 'joplinGrokShowXaiApiKeyDialog';

let dialogHandle: ViewHandle | null = null;
let scriptsLoaded = false;

function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function buildHtml(key: string, source: string): string {
	const hasKey = Boolean(key);
	const value = escapeHtml(key);
	const emptyHint = hasKey
		? ''
		: `<p class="empty">No xAI API key found. Add one of:<br/>
			• <code>~/.grok/.env</code> with <code>XAI_API_KEY=…</code><br/>
			• <code>~/.grok/api_key</code> (one line)<br/>
			• project <code>.env</code> (gitignored)<br/>
			• Configuration → xAI API key field</p>`;

	const sourceLine = hasKey
		? `<p class="lead">Source: <strong>${escapeHtml(source)}</strong> (console.x.ai credits — not SuperGrok chat quota).</p>`
		: `<p class="lead">console.x.ai API credits (not SuperGrok chat quota).</p>`;

	// onclick is intentional: dialog scripts only bind reliably on first open
	const toggleJs =
		"(function(b){var i=document.getElementById('apiKey');if(!i||i.disabled)return;" +
		"var show=i.type==='password';i.type=show?'text':'password';b.textContent=show?'Hide':'Show';})(this);return false;";

	return `
<div id="wrap">
	<h1>xAI API key</h1>
	${sourceLine}
	${emptyHint}
	<div class="row">
		<input id="apiKey" type="password" readonly value="${value}" spellcheck="false" autocomplete="off" ${hasKey ? '' : 'disabled'} />
		<button type="button" id="btnShow" ${hasKey ? '' : 'disabled'} onclick="${toggleJs}">Show</button>
	</div>
	<p class="hint">Show / Hide sits on the same line as the key. Prefer storing keys outside the repo.</p>
</div>
`;
}

export async function openShowXaiApiKeyDialog(): Promise<void> {
	const settingsKey = String((await joplin.settings.value(SettingKey.XaiApiKey)) || '').trim();
	const resolved = resolveXaiApiKey(settingsKey);
	const key = resolved?.value || '';
	const source = resolved?.source || '';

	if (!dialogHandle) {
		dialogHandle = await joplin.views.dialogs.create(DIALOG_ID);
		await joplin.views.dialogs.setFitToContent(dialogHandle, true);
	}

	await joplin.views.dialogs.setHtml(dialogHandle, buildHtml(key, source));

	if (!scriptsLoaded) {
		await joplin.views.dialogs.addScript(dialogHandle, './ui/showApiKeyDialog.css');
		// View script must not be named showApiKeyDialog.js — webpack resolves .js before .ts
		await joplin.views.dialogs.addScript(dialogHandle, './ui/showApiKeyDialogView.js');
		scriptsLoaded = true;
	}

	const buttons = key
		? [
				{ id: 'copy', title: 'Copy to clipboard' },
				{ id: 'ok', title: 'Close' },
			]
		: [{ id: 'ok', title: 'Close' }];
	await joplin.views.dialogs.setButtons(dialogHandle, buttons);

	const result = await joplin.views.dialogs.open(dialogHandle);
	if (result.id === 'copy' && key) {
		try {
			await joplin.clipboard.writeText(key);
		} catch {
			/* clipboard may be unavailable */
		}
		await joplin.views.dialogs.showMessageBox(
			key.length <= 12
				? `Copied to clipboard:\n\n${key}`
				: `Copied to clipboard.\n\nPreview: ${key.slice(0, 6)}…${key.slice(-4)}\nSource: ${source}\nLength: ${key.length} characters`
		);
	}
}
