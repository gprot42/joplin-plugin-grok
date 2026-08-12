import joplin from 'api';
import { ContentScriptType, MenuItemLocation, ToolbarButtonLocation, ViewHandle } from 'api/types';
import {
	addBlockedNotebookId,
	loadSettings,
	modelForProvider,
	refreshExcludePickerSettings,
	registerSettings,
	resetStickyPickers,
	SettingKey,
	syncExcludedPathsDisplay,
} from './settings';
import { openExcludeNotebooksDialog } from './ui/excludeDialog';
import { openShowXaiApiKeyDialog } from './ui/showApiKeyDialog';
import { runSuperGrokDeviceLogin, syncSuperGrokSessionLabel } from './auth/superGrokLogin';
import { loadGrokCliAuth, describeToken } from './auth/xaiOAuth';
import { persistPluginOAuth } from './auth/resolveXaiAuth';
import {
	buildAccessContext,
	isNotebookAccessible,
} from './joplin/access';
import { getSelectedNote } from './joplin/notes';
import { notebookPathForId } from './joplin/notebooks';
import { runAgentTurn, runSimpleChat } from './llm/agent';
import { summarizeNote } from './llm/summarize';
import { createProvider } from './llm/factory';
import { ChatMessage } from './llm/types';
import { CHAT_PANEL_HTML } from './ui/panelHtml';

const PANEL_ID = 'joplinGrokChatPanel';
const FAB_CONTENT_SCRIPT_ID = 'joplinGrokFab';
const VIEWER_FAB_CONTENT_SCRIPT_ID = 'joplinGrokViewerFab';
const CMD_TOGGLE = 'joplinGrok.toggleAssistant';
const CMD_BLOCK_CURRENT = 'joplinGrok.blockCurrentNotebook';
const CMD_COPY_NOTEBOOK_ID = 'joplinGrok.copyNotebookId';
const CMD_OPEN_EXCLUDE = 'joplinGrok.openExcludeNotebooks';
const CMD_OPEN_RESTORE = 'joplinGrok.openRestoreNotebooks';
const CMD_SHOW_XAI_KEY = 'joplinGrok.showXaiApiKey';
const CMD_SHOW_USAGE = 'joplinGrok.showUsage';

let panel: ViewHandle | null = null;
/** Serializes first create so concurrent FAB clicks don't race two create() calls. */
let panelCreatePromise: Promise<ViewHandle> | null = null;
/** User intent / soft cache: true after open, false after close. */
let panelExpanded = false;
/** When true, background warm-up must not hide the panel. */
let userWantsPanelOpen = false;
/** Serializes open/close so the first click always completes before a second runs. */
let panelVisibilityChain: Promise<void> = Promise.resolve();

/** Survives close/reopen of the Grok panel within this Joplin session. */
export interface SessionUiMessage {
	role: string;
	content: string;
	extraClass?: string;
}
let sessionTranscript: SessionUiMessage[] = [];
/** chat | add | summarize */
let sessionChatMode = 'chat';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hidePanelRaw(p: ViewHandle): Promise<void> {
	try {
		await joplin.views.panels.hide(p);
	} catch {
		await joplin.views.panels.show(p, false);
	}
}

async function ensurePanel(): Promise<ViewHandle> {
	if (panel) return panel;
	if (panelCreatePromise) return panelCreatePromise;

	panelCreatePromise = (async () => {
		const p = await joplin.views.panels.create(PANEL_ID);
		// Create often shows the panel immediately — hide ASAP unless user already opened
		if (!userWantsPanelOpen) {
			await hidePanelRaw(p);
		}
		await joplin.views.panels.setHtml(p, CHAT_PANEL_HTML);
		await joplin.views.panels.addScript(p, './ui/chatPanel.css');
		await joplin.views.panels.addScript(p, './ui/chatPanel.js');
		await joplin.views.panels.onMessage(p, handlePanelMessage);
		if (!userWantsPanelOpen) {
			await hidePanelRaw(p);
		}
		panel = p;
		return p;
	})();

	try {
		return await panelCreatePromise;
	} catch (e) {
		panelCreatePromise = null;
		throw e;
	}
}

function pushPanelMessages(): void {
	if (!panel || !panelExpanded) return;
	try {
		joplin.views.panels.postMessage(panel, { type: 'setUiMode', mode: 'chat' });
		if (sessionTranscript.length) {
			joplin.views.panels.postMessage(panel, {
				type: 'restoreTranscript',
				messages: sessionTranscript,
				chatMode: sessionChatMode,
			});
		}
	} catch {
		// panelReady will re-sync when the webview finishes loading
	}
}

/**
 * Open the chat panel. CRITICAL: never hide() during open.
 * Earlier “retry with hide→show” undid successful opens when visible() was wrong,
 * which felt like “need two clicks”.
 */
async function forceOpenPanel(): Promise<void> {
	userWantsPanelOpen = true;
	panelExpanded = true;
	const p = await ensurePanel();
	if (!userWantsPanelOpen) return;

	// Only show(true) — multiple times for Joplin flakiness. Never hide here.
	const delays = [0, 40, 100, 220, 450, 800];
	for (const ms of delays) {
		if (!userWantsPanelOpen) return;
		if (ms) await sleep(ms);
		if (!userWantsPanelOpen) return;
		await joplin.views.panels.show(p, true);
		pushPanelMessages();
	}
	panelExpanded = true;
}

async function forceClosePanel(): Promise<void> {
	userWantsPanelOpen = false;
	panelExpanded = false;
	if (!panel) return;
	await hidePanelRaw(panel);
	await sleep(30);
	if (!userWantsPanelOpen) {
		await hidePanelRaw(panel);
	}
	panelExpanded = false;
}

/**
 * Open/close the chat panel. Serialized so concurrent clicks cannot cancel each other.
 */
async function showPanel(show: boolean): Promise<void> {
	const run = async () => {
		if (show) await forceOpenPanel();
		else await forceClosePanel();
	};
	panelVisibilityChain = panelVisibilityChain.then(run, run);
	await panelVisibilityChain;
}

async function togglePanel(): Promise<void> {
	// Intent from our flag only (Joplin visible() is unreliable on some builds)
	await showPanel(!panelExpanded);
}

/**
 * Pre-create panel at startup (hidden). Do NOT show/hide race with user clicks.
 */
async function warmPanelInBackground(): Promise<void> {
	try {
		await ensurePanel();
		if (!userWantsPanelOpen && panel) {
			await hidePanelRaw(panel);
			panelExpanded = false;
		}
	} catch (e) {
		console.warn('Joplin Grok: panel pre-create failed', e);
	}
}

async function handlePanelMessage(message: any): Promise<any> {
	const type = message?.type as string;

	switch (type) {
		case 'panelReady': {
			return {
				mode: 'chat',
				messages: sessionTranscript,
				chatMode: sessionChatMode,
			};
		}

		case 'getFabVisible': {
			const settings = await loadSettings();
			const enabled = settings.showFab !== false;
			// Trust open intent flag — not Joplin visible() (can be wrong mid-open)
			return { showFab: enabled && !panelExpanded && !userWantsPanelOpen };
		}

		case 'openAssistant': {
			// Always force open (never toggle). Sets userWantsPanelOpen first so
			// warm-up / ensurePanel cannot hide the panel after this click.
			userWantsPanelOpen = true;
			panelExpanded = true;
			await showPanel(true);
			return {
				messages: sessionTranscript,
				chatMode: sessionChatMode,
				ok: true,
				expanded: true,
			};
		}

		case 'closeAssistant': {
			// Persist any transcript the webview sends with the close request
			if (Array.isArray(message?.messages)) {
				sessionTranscript = message.messages as SessionUiMessage[];
			}
			if (typeof message?.chatMode === 'string' && message.chatMode) {
				sessionChatMode = message.chatMode;
			}
			await showPanel(false);
			return null;
		}

		case 'getTranscript': {
			return {
				messages: sessionTranscript,
				chatMode: sessionChatMode,
			};
		}

		case 'saveTranscript': {
			if (Array.isArray(message?.messages)) {
				sessionTranscript = (message.messages as SessionUiMessage[]).map((m) => ({
					role: String(m.role || ''),
					content: String(m.content || ''),
					extraClass: m.extraClass ? String(m.extraClass) : undefined,
				}));
			}
			if (typeof message?.chatMode === 'string' && message.chatMode) {
				sessionChatMode = message.chatMode;
			}
			return { ok: true, count: sessionTranscript.length };
		}

		case 'clearTranscript': {
			sessionTranscript = [];
			sessionChatMode = 'chat';
			return { ok: true };
		}

		case 'getStatus': {
			const settings = await loadSettings();
			const model = modelForProvider(settings);
			const tier = String(
				(await joplin.settings.value(SettingKey.OAuthTierLabel)) || ''
			);
			let authLabel = '';
			if (settings.provider === 'xai') {
				authLabel = tier || settings.xaiAuthMode;
			} else if (settings.provider === 'openrouter') {
				authLabel = settings.openRouterApiKey ? 'API key' : 'API key missing';
			}
			return {
				provider: settings.provider,
				model,
				authMode: settings.provider === 'xai' ? settings.xaiAuthMode : settings.provider,
				authLabel,
			};
		}

		case 'testConnection': {
			try {
				const reply = await runSimpleChat(
					'Reply with exactly: Joplin Grok connection OK'
				);
				return { ok: true, message: reply };
			} catch (e: any) {
				return { ok: false, message: e.message || String(e) };
			}
		}

		case 'chat': {
			const mode = (message.mode as string) || 'chat';
			const text = String(message.text || '');
			const includeCurrent = Boolean(message.includeCurrent);
			const prev = Array.isArray(message.history)
				? (message.history as { role: string; content: string }[])
				: [];

			const history: ChatMessage[] = prev.map((m) => ({
				role: m.role as ChatMessage['role'],
				content: m.content,
			}));

			try {
				if (mode === 'summarize') {
					const summary = await summarizeNote({
						text: text || undefined,
						writeAsNewNote: false,
					});
					return {
						assistantMessage: summary.summary,
						toolTrace: [],
						usageFooter: undefined,
					};
				}

				let userText = text;
				if (mode === 'add') {
					userText =
						`The user wants to ADD a new note. Use suggest_placement then create_note (and tags if useful).\n\n` +
						`Content:\n${text}`;
				}

				if (includeCurrent) {
					const note = await getSelectedNote();
					if (note) {
						const access = await buildAccessContext();
						if (isNotebookAccessible(access, note.parent_id)) {
							const path = await notebookPathForId(note.parent_id, access.notebooks);
							const excerpt = (note.body || '').slice(0, 2500);
							userText +=
								`\n\n---\nCurrent note context (id=${note.id}, notebook=${path}):\n` +
								`# ${note.title}\n${excerpt}`;
						} else {
							userText +=
								'\n\n---\n(Current note is in a blocked notebook; content not included.)';
						}
					}
				}

				return await runAgentTurn(history, userText);
			} catch (e: any) {
				return { error: e.message || String(e), assistantMessage: '', toolTrace: [] };
			}
		}

		default:
			return { error: `Unknown message type: ${type}` };
	}
}

async function blockCurrentNotebook(): Promise<void> {
	const note = await getSelectedNote();
	if (!note) return;
	await addBlockedNotebookId(note.parent_id);
	await syncExcludedPathsDisplay();
	await refreshExcludePickerSettings();
}

async function copyCurrentNotebookId(): Promise<void> {
	const note = await getSelectedNote();
	if (!note) return;
	await joplin.clipboard.writeText(note.parent_id);
}

/** Reveal the stored xAI API key (Show sits beside the key field in a dialog). */
async function showXaiApiKey(): Promise<void> {
	await openShowXaiApiKeyDialog();
}

/** Quiet usage report (tokens + estimated USD) — not a primary UI surface. */
async function showUsageReport(): Promise<void> {
	const settings = await loadSettings();
	const { getUsageSnapshot, formatUsageReport, resetLifetimeUsage } = await import(
		'./llm/usage'
	);
	const snap = await getUsageSnapshot();
	const authMode = settings.provider === 'xai' ? settings.xaiAuthMode : settings.provider;
	const report = formatUsageReport(snap, authMode, modelForProvider(settings));
	await joplin.views.dialogs.showMessageBox(report);
}

async function handleUsageSettingsAction(action: string): Promise<void> {
	if (action === 'show') {
		await showUsageReport();
	} else if (action === 'reset') {
		const { resetLifetimeUsage } = await import('./llm/usage');
		await resetLifetimeUsage();
		await joplin.views.dialogs.showMessageBox(
			'Usage totals reset for this device (session + lifetime).'
		);
	}
	try {
		await joplin.settings.setValue(SettingKey.ShowUsageReport, 'idle');
	} catch {
		/* ignore */
	}
}

joplin.plugins.register({
	onStart: async function () {
		await registerSettings();

		await joplin.commands.register({
			name: CMD_TOGGLE,
			label: 'Joplin Grok: Toggle AI assistant',
			iconName: 'fas fa-robot',
			execute: async () => {
				await togglePanel();
			},
		});

		await joplin.commands.register({
			name: CMD_BLOCK_CURRENT,
			label: 'Joplin Grok: Exclude current notebook from AI',
			execute: async () => {
				await blockCurrentNotebook();
			},
		});

		await joplin.commands.register({
			name: CMD_COPY_NOTEBOOK_ID,
			label: 'Joplin Grok: Copy current notebook ID',
			execute: async () => {
				await copyCurrentNotebookId();
			},
		});

		await joplin.commands.register({
			name: CMD_OPEN_EXCLUDE,
			label: 'Joplin Grok: Manage excluded notebooks…',
			iconName: 'fas fa-ban',
			execute: async () => {
				await openExcludeNotebooksDialog();
				await syncExcludedPathsDisplay();
				await refreshExcludePickerSettings();
			},
		});

		// Legacy command id — same simple dialog (add with +, remove with ×)
		await joplin.commands.register({
			name: CMD_OPEN_RESTORE,
			label: 'Joplin Grok: Manage excluded notebooks…',
			iconName: 'fas fa-ban',
			execute: async () => {
				await openExcludeNotebooksDialog();
				await syncExcludedPathsDisplay();
				await refreshExcludePickerSettings();
			},
		});

		await joplin.commands.register({
			name: CMD_SHOW_XAI_KEY,
			label: 'Joplin Grok: Show xAI API key',
			iconName: 'fas fa-key',
			execute: async () => {
				await showXaiApiKey();
			},
		});

		await joplin.commands.register({
			name: CMD_SHOW_USAGE,
			label: 'Joplin Grok: Show usage (tokens / USD)…',
			iconName: 'fas fa-chart-bar',
			execute: async () => {
				await showUsageReport();
			},
		});

		await joplin.views.toolbarButtons.create(
			'joplinGrokToolbarBtn',
			CMD_TOGGLE,
			ToolbarButtonLocation.NoteToolbar
		);
		// Always-visible button to manage exclusions (settings "Button" type is unreliable)
		await joplin.views.toolbarButtons.create(
			'joplinGrokExcludeToolbarBtn',
			CMD_OPEN_EXCLUDE,
			ToolbarButtonLocation.NoteToolbar
		);

		await joplin.views.menuItems.create(
			'joplinGrokMenuToggle',
			CMD_TOGGLE,
			MenuItemLocation.Tools
		);
		await joplin.views.menuItems.create(
			'joplinGrokMenuExcludeList',
			CMD_OPEN_EXCLUDE,
			MenuItemLocation.Tools
		);
		await joplin.views.menuItems.create(
			'joplinGrokMenuBlock',
			CMD_BLOCK_CURRENT,
			MenuItemLocation.Tools
		);
		await joplin.views.menuItems.create(
			'joplinGrokMenuCopyId',
			CMD_COPY_NOTEBOOK_ID,
			MenuItemLocation.Tools
		);
		await joplin.views.menuItems.create(
			'joplinGrokMenuShowKey',
			CMD_SHOW_XAI_KEY,
			MenuItemLocation.Tools
		);
		await joplin.views.menuItems.create(
			'joplinGrokMenuUsage',
			CMD_SHOW_USAGE,
			MenuItemLocation.Tools
		);

		// Pre-create + warm panel so the first FAB/toolbar click only needs show(true).
		void warmPanelInBackground();

		// Floating FAB is injected by editor/viewer content scripts below.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			FAB_CONTENT_SCRIPT_ID,
			'./ui/fabContentScript.js'
		);
		await joplin.contentScripts.onMessage(FAB_CONTENT_SCRIPT_ID, handlePanelMessage);

		await joplin.contentScripts.register(
			ContentScriptType.MarkdownItPlugin,
			VIEWER_FAB_CONTENT_SCRIPT_ID,
			'./ui/viewerFabContentScript.js'
		);
		await joplin.contentScripts.onMessage(VIEWER_FAB_CONTENT_SCRIPT_ID, handlePanelMessage);

		// Hydrate excluded notebooks from plugin dataDir + settings (survives restart)
		try {
			await resetStickyPickers();
			const { hydrateExcludedOnStartup } = await import('./joplin/excludedStore');
			const { listNotebookPaths } = await import('./joplin/notebooks');
			await hydrateExcludedOnStartup(async (ids) => {
				const nodes = await listNotebookPaths();
				const map = new Map(nodes.map((n) => [n.id, n.path]));
				// Ensure every id has a label even if missing from tree
				for (const id of ids) {
					if (!map.has(id)) map.set(id, id);
				}
				return map;
			});
			await refreshExcludePickerSettings();
		} catch (e) {
			console.warn('Joplin Grok: could not hydrate excluded notebooks', e);
			try {
				await syncExcludedPathsDisplay();
				await refreshExcludePickerSettings();
			} catch {
				/* ignore */
			}
		}
		// Notebooks may not be ready at plugin start — re-sync shortly after
		for (const ms of [1500, 4000]) {
			setTimeout(() => {
				void (async () => {
					try {
						await syncExcludedPathsDisplay();
						await refreshExcludePickerSettings();
					} catch {
						/* ignore */
					}
				})();
			}, ms);
		}

		// Import SuperGrok Heavy session from `grok login` (~/.grok/auth.json) if present
		try {
			const cli = loadGrokCliAuth();
			if (cli) {
				await persistPluginOAuth(cli);
				const meta = describeToken(cli.accessToken);
				const label = [
					meta.tierLabel || cli.tierLabel || 'SuperGrok',
					cli.email || meta.email,
					'via ~/.grok/auth.json',
				]
					.filter(Boolean)
					.join(' · ');
				await joplin.settings.setValue(SettingKey.OAuthTierLabel, label);
				// Prefer SuperGrok auth when a CLI session exists
				const mode = String(
					(await joplin.settings.value(SettingKey.XaiAuthMode)) || 'super_grok'
				);
				if (mode !== 'api_key') {
					await joplin.settings.setValue(SettingKey.XaiAuthMode, 'super_grok');
				}
			}
			await syncSuperGrokSessionLabel();
		} catch (e) {
			console.warn('Joplin Grok: SuperGrok session import failed', e);
		}

		await joplin.settings.onChange(async (ev) => {
			// ShowFab is read by content-script FABs via getFabVisible (no panel action).

			if (ev.keys.includes(SettingKey.OpenSuperGrokLogin)) {
				const open = Boolean(await joplin.settings.value(SettingKey.OpenSuperGrokLogin));
				if (open) {
					try {
						await runSuperGrokDeviceLogin();
						await syncSuperGrokSessionLabel();
					} finally {
						await joplin.settings.setValue(SettingKey.OpenSuperGrokLogin, false);
					}
				}
			}

			if (ev.keys.includes(SettingKey.ShowXaiApiKey)) {
				const show = Boolean(await joplin.settings.value(SettingKey.ShowXaiApiKey));
				if (show) {
					try {
						await showXaiApiKey();
					} finally {
						await joplin.settings.setValue(SettingKey.ShowXaiApiKey, false);
					}
				}
			}

			if (ev.keys.includes(SettingKey.XaiAuthMode)) {
				await syncSuperGrokSessionLabel();
			}

			if (ev.keys.includes(SettingKey.ShowUsageReport)) {
				const action = String(
					(await joplin.settings.value(SettingKey.ShowUsageReport).catch(() => 'idle')) ||
						'idle'
				);
				if (action === 'show' || action === 'reset') {
					await handleUsageSettingsAction(action);
				}
			}

			// Settings action: enum "open" or legacy bools → exclude popup
			if (
				ev.keys.includes(SettingKey.OpenExcludeList) ||
				ev.keys.includes(SettingKey.ExcludeNotebookPicker) ||
				ev.keys.includes(SettingKey.OpenRestoreList)
			) {
				const action = String(
					(await joplin.settings.value(SettingKey.OpenExcludeList).catch(() => 'idle')) ||
						'idle'
				);
				const legacyOpen =
					Boolean(await joplin.settings.value(SettingKey.ExcludeNotebookPicker).catch(() => false)) ||
					Boolean(await joplin.settings.value(SettingKey.OpenRestoreList).catch(() => false));
				const shouldOpen = action === 'open' || legacyOpen;
				if (shouldOpen) {
					try {
						await openExcludeNotebooksDialog();
						await syncExcludedPathsDisplay();
						await refreshExcludePickerSettings();
					} catch (e) {
						console.warn('Joplin Grok: open exclude dialog failed', e);
					} finally {
						try {
							await joplin.settings.setValue(SettingKey.OpenExcludeList, 'idle');
							await joplin.settings.setValue(SettingKey.ExcludeNotebookPicker, false);
							await joplin.settings.setValue(SettingKey.OpenRestoreList, false);
						} catch {
							/* ignore */
						}
					}
				}
			}

			if (ev.keys.includes(SettingKey.BlockedNotebookIds)) {
				try {
					await syncExcludedPathsDisplay();
					await refreshExcludePickerSettings();
				} catch {
					/* ignore */
				}
			}
		});

		const settings = await loadSettings();
		console.info(
			'Joplin Grok AI started. Provider:',
			settings.provider,
			'| auth:',
			settings.xaiAuthMode,
			'| showFab:',
			settings.showFab
		);

		void createProvider;
		void SettingKey;
	},
});
