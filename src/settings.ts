import joplin from 'api';
import { SettingItemType } from 'api/types';
import { listNotebookPaths } from './joplin/notebooks';

export const SETTINGS_SECTION = 'joplinGrokSection';

export enum SettingKey {
	Provider = 'joplinGrok.provider',
	/** api_key = console prepaid credits; super_grok = SuperGrok / SuperGrok Heavy OAuth */
	XaiAuthMode = 'joplinGrok.xaiAuthMode',
	XaiApiKey = 'joplinGrok.xaiApiKey',
	/** Toggle ON then Apply to reveal the stored xAI API key */
	ShowXaiApiKey = 'joplinGrok.showXaiApiKey',
	XaiModel = 'joplinGrok.xaiModel',
	/** Toggle ON then Apply to start SuperGrok device-code sign-in */
	OpenSuperGrokLogin = 'joplinGrok.openSuperGrokLogin',
	OAuthAccessToken = 'joplinGrok.oauthAccessToken',
	OAuthRefreshToken = 'joplinGrok.oauthRefreshToken',
	OAuthExpiresAt = 'joplinGrok.oauthExpiresAt',
	OAuthEmail = 'joplinGrok.oauthEmail',
	OAuthTierLabel = 'joplinGrok.oauthTierLabel',
	OpenRouterApiKey = 'joplinGrok.openRouterApiKey',
	OpenRouterModel = 'joplinGrok.openRouterModel',
	OpenAiBaseUrl = 'joplinGrok.openAiBaseUrl',
	OpenAiApiKey = 'joplinGrok.openAiApiKey',
	OpenAiModel = 'joplinGrok.openAiModel',
	DefaultNotebookId = 'joplinGrok.defaultNotebookId',
	AllowCreateNotebooks = 'joplinGrok.allowCreateNotebooks',
	ConfirmBeforeWrite = 'joplinGrok.confirmBeforeWrite',
	ShowFab = 'joplinGrok.showFab',
	SystemPromptOverride = 'joplinGrok.systemPromptOverride',
	PlacementConfidence = 'joplinGrok.placementConfidence',
	MaxToolSteps = 'joplinGrok.maxToolSteps',
	// Access control
	/** @deprecated hidden — legacy picker */
	ExcludeNotebookPicker = 'joplinGrok.excludeNotebookPicker',
	/** @deprecated hidden — legacy picker */
	RestoreNotebookPicker = 'joplinGrok.restoreNotebookPicker',
	BlockedNotebookIds = 'joplinGrok.blockedNotebookIds',
	/** Human-readable paths of excluded notebooks (synced automatically). */
	ExcludedNotebookPathsDisplay = 'joplinGrok.excludedNotebookPathsDisplay',
	/** Toggle ON then Apply/OK to open the exclude manager dialog. */
	OpenExcludeList = 'joplinGrok.openExcludeList',
	/** @deprecated hidden — use exclude dialog × to restore */
	OpenRestoreList = 'joplinGrok.openRestoreList',
	BlockedPathPatterns = 'joplinGrok.blockedPathPatterns',
	AllowlistMode = 'joplinGrok.allowlistMode',
	AllowedNotebookIds = 'joplinGrok.allowedNotebookIds',
}

export type ProviderId = 'xai' | 'openrouter' | 'openai_compatible';
export type XaiAuthModeId = 'api_key' | 'super_grok';

export interface PluginSettings {
	provider: ProviderId;
	xaiAuthMode: XaiAuthModeId;
	xaiApiKey: string;
	xaiModel: string;
	openRouterApiKey: string;
	openRouterModel: string;
	openAiBaseUrl: string;
	openAiApiKey: string;
	openAiModel: string;
	defaultNotebookId: string;
	allowCreateNotebooks: boolean;
	confirmBeforeWrite: boolean;
	showFab: boolean;
	systemPromptOverride: string;
	placementConfidence: number;
	maxToolSteps: number;
	blockedNotebookIds: string;
	blockedPathPatterns: string;
	allowlistMode: boolean;
	allowedNotebookIds: string;
}

/** Active chat model id for the configured provider. */
export function modelForProvider(settings: PluginSettings): string {
	if (settings.provider === 'xai') return settings.xaiModel;
	if (settings.provider === 'openrouter') return settings.openRouterModel;
	return settings.openAiModel;
}

/** @deprecated legacy sentinel — kept for sticky reset of old installs */
export const PICKER_NONE = '__none__';
/** @deprecated */
export const OPEN_MULTI_SELECT = '__open_multi_select__';

/** @deprecated */
export function isPickerIdle(value: string): boolean {
	const v = String(value || '').trim();
	return !v || v === PICKER_NONE;
}

/**
 * Register plugin settings. Builds a live dropdown of every notebook/subnotebook
 * so exclusions can be chosen from Configuration without leaving the settings screen.
 */
export async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection(SETTINGS_SECTION, {
		label: 'Joplin Grok AI',
		iconName: 'fas fa-robot',
		description:
			'Connect Grok (xAI) or any OpenAI-compatible LLM to your notes. Use “Exclude notebook / subnotebook” to pick from a full list.',
	});

	const blockedRaw = String(
		(await joplin.settings.value(SettingKey.BlockedNotebookIds).catch(() => '')) || ''
	);
	const blockedIds = new Set(parseBlockedIdList(blockedRaw));

	await joplin.settings.registerSettings({
		[SettingKey.Provider]: {
			value: 'xai',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'LLM provider',
			description:
				'Default is xAI Grok. OpenRouter needs an API key from openrouter.ai. OpenAI-compatible is for Ollama, LM Studio, OpenAI, etc.',
			isEnum: true,
			options: {
				xai: 'xAI Grok (default)',
				openrouter: 'OpenRouter',
				openai_compatible: 'OpenAI-compatible',
			},
		},
		[SettingKey.XaiAuthMode]: {
			value: 'super_grok',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'xAI auth mode',
			description:
				'SuperGrok Heavy uses your consumer SuperGrok subscription (from `grok login` / ~/.grok/auth.json or Sign in). API key uses console.x.ai prepaid credits (separate product — SuperGrok does not refill API credits).',
			isEnum: true,
			options: {
				super_grok: 'SuperGrok / SuperGrok Heavy (OAuth)',
				api_key: 'API key (console.x.ai credits)',
			},
		},
		[SettingKey.OpenSuperGrokLogin]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Sign in with SuperGrok (device code)…',
			description:
				'Check, then Apply/OK to start SuperGrok OAuth. Prefer `grok login` in a terminal if you already use Grok CLI — this plugin auto-loads ~/.grok/auth.json (Heavy = tier 5).',
		},
		[SettingKey.OAuthTierLabel]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'SuperGrok session',
			description: 'Detected plan/email after SuperGrok sign-in (read-only display; updated automatically).',
		},
		[SettingKey.XaiApiKey]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			secure: true,
			label: 'xAI API key (optional if in ~/.grok or .env)',
			description:
				'Preferred: put XAI_API_KEY in ~/.grok/.env or a one-line key in ~/.grok/api_key (outside the repo). Project .env is also supported and gitignored. This field is a fallback (Joplin secure storage). console.x.ai prepaid credits only — not SuperGrok chat quota.',
		},
		[SettingKey.ShowXaiApiKey]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Show',
			description:
				'Reveal the resolved key (env / ~/.grok / .env / this setting) with Show on the same line. Check, then Apply/OK. Also: Tools → Joplin Grok: Show xAI API key.',
		},
		[SettingKey.XaiModel]: {
			value: 'grok-4.5',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'xAI model',
			description: 'Default is Grok 4.5. Choose Grok 4.6 when you want the newer model.',
			isEnum: true,
			options: {
				'grok-4.5': 'Grok 4.5 (default)',
				'grok-4.6': 'Grok 4.6',
			},
		},
		[SettingKey.OAuthAccessToken]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: false,
			secure: true,
			label: 'OAuth access token',
		},
		[SettingKey.OAuthRefreshToken]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: false,
			secure: true,
			label: 'OAuth refresh token',
		},
		[SettingKey.OAuthExpiresAt]: {
			value: '0',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: false,
			label: 'OAuth expires at',
		},
		[SettingKey.OAuthEmail]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: false,
			label: 'OAuth email',
		},
		[SettingKey.OpenRouterApiKey]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			secure: true,
			label: 'OpenRouter API key (optional if in ~/.grok or .env)',
			description:
				'Preferred: OPENROUTER_API_KEY in ~/.grok/.env or project .env (gitignored). Fallback: this secure field. https://openrouter.ai/keys',
		},
		[SettingKey.OpenRouterModel]: {
			value: 'x-ai/grok-4.5',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'OpenRouter model',
			description:
				'OpenRouter model id (provider/model). Examples: x-ai/grok-4.5, openai/gpt-4o-mini, anthropic/claude-sonnet-4. See https://openrouter.ai/models',
		},
		[SettingKey.OpenAiBaseUrl]: {
			value: 'http://localhost:11434/v1',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'OpenAI-compatible base URL',
			description: 'Example: http://localhost:11434/v1 (Ollama) or https://api.openai.com/v1',
		},
		[SettingKey.OpenAiApiKey]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			secure: true,
			label: 'OpenAI-compatible API key',
			description:
				'Optional for many local servers (Ollama). Also reads OPENAI_API_KEY from ~/.grok/.env or project .env (gitignored).',
		},
		[SettingKey.OpenAiModel]: {
			value: 'llama3.2',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'OpenAI-compatible model',
		},

		// --- AI access control (one clear entry) ---
		[SettingKey.OpenExcludeList]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Manage excluded notebooks…',
			description:
				blockedIds.size
					? `Check, then Apply/OK. ${blockedIds.size} currently excluded. Pick notebooks, press + to add, × to remove, Save. Also: Tools → Joplin Grok: Manage excluded notebooks…`
					: 'Check, then Apply/OK. Pick a notebook, press + to exclude it, repeat, × to remove, then Save. Also: Tools → Joplin Grok: Manage excluded notebooks…',
		},
		// Hidden legacy toggles (keep keys so old configs don't break)
		[SettingKey.OpenRestoreList]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: false,
			label: 'Restore excluded notebooks (legacy)',
		},
		[SettingKey.ExcludeNotebookPicker]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: false,
			label: 'Exclude notebook picker (legacy)',
		},
		[SettingKey.RestoreNotebookPicker]: {
			value: PICKER_NONE,
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: false,
			label: 'Restore notebook picker (legacy)',
		},
		[SettingKey.ExcludedNotebookPathsDisplay]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Excluded notebooks (read-only)',
			description:
				'Paths of notebooks blocked from AI (one per line). Edit via “Manage excluded notebooks…” above.',
		},
		[SettingKey.BlockedNotebookIds]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			advanced: true,
			label: 'Excluded notebook IDs (advanced)',
			description:
				'Internal IDs (one per line). Prefer “Manage excluded notebooks…”. Subnotebooks of an excluded parent are blocked automatically.',
		},
		[SettingKey.BlockedPathPatterns]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Blocked path patterns',
			description:
				'Comma/newline substrings matched against notebook path or title (case-insensitive), e.g. "Private", "Finance / Taxes". Matching notebooks and their children are blocked.',
		},
		[SettingKey.AllowlistMode]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Allowlist mode (only listed notebooks)',
			description:
				'When on, the AI may only use notebooks listed in “Allowed notebook IDs” (and their subnotebooks). Everything else is hidden. Fail-closed if the list is empty.',
		},
		[SettingKey.AllowedNotebookIds]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Allowed notebook IDs (allowlist mode)',
			description: 'Used only when allowlist mode is on. Include root notebooks you want the AI to use.',
		},
		[SettingKey.DefaultNotebookId]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Default notebook ID (optional)',
			description: 'Fallback notebook when placement is ambiguous. Leave empty to use the selected notebook.',
		},
		[SettingKey.AllowCreateNotebooks]: {
			value: true,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Allow creating notebooks',
		},
		[SettingKey.ConfirmBeforeWrite]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Confirm before creating or updating notes',
		},
		[SettingKey.ShowFab]: {
			value: true,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Show floating Grok button',
			description:
				'Black Grok button bottom-right over the note editor/viewer. Hidden while the chat panel is open. You can always open chat from the robot toolbar icon or Tools → Joplin Grok.',
		},
		[SettingKey.PlacementConfidence]: {
			value: 0.55,
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			advanced: true,
			label: 'Placement confidence threshold (0–1)',
		},
		[SettingKey.MaxToolSteps]: {
			value: 8,
			type: SettingItemType.Int,
			section: SETTINGS_SECTION,
			public: true,
			advanced: true,
			label: 'Max agent tool steps per message',
			minimum: 1,
			maximum: 20,
		},
		[SettingKey.SystemPromptOverride]: {
			value: '',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			advanced: true,
			label: 'System prompt override',
			description: 'Leave empty to use the built-in prompt.',
		},
	});
}

/**
 * Refresh the “Manage excluded notebooks…” label with the current count.
 * Safe to call after exclude/restore operations.
 */
export async function refreshExcludePickerSettings(): Promise<void> {
	const blockedRaw = String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || '');
	const blockedIds = new Set(parseBlockedIdList(blockedRaw));

	await joplin.settings.registerSettings({
		[SettingKey.OpenExcludeList]: {
			value: false,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Manage excluded notebooks…',
			description:
				blockedIds.size
					? `Check, then Apply/OK. ${blockedIds.size} currently excluded. Pick notebooks, press + to add, × to remove, Save.`
					: 'Check, then Apply/OK. Pick a notebook, press + to exclude, × to remove, then Save.',
		},
		[SettingKey.ExcludedNotebookPathsDisplay]: {
			value: String((await joplin.settings.value(SettingKey.ExcludedNotebookPathsDisplay)) || ''),
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Excluded notebooks (read-only)',
			description:
				'Paths of notebooks blocked from AI (one per line). Edit via “Manage excluded notebooks…” above.',
		},
	});

	try {
		await joplin.settings.setValue(SettingKey.OpenExcludeList, false);
		await joplin.settings.setValue(SettingKey.ExcludeNotebookPicker, false);
		await joplin.settings.setValue(SettingKey.OpenRestoreList, false);
		await joplin.settings.setValue(SettingKey.RestoreNotebookPicker, PICKER_NONE);
	} catch {
		/* ignore */
	}
}

/** Clear sticky action toggles left over after Apply. */
export async function resetStickyPickers(): Promise<void> {
	try {
		await joplin.settings.setValue(SettingKey.OpenExcludeList, false);
		await joplin.settings.setValue(SettingKey.ExcludeNotebookPicker, false);
		await joplin.settings.setValue(SettingKey.OpenRestoreList, false);
		await joplin.settings.setValue(SettingKey.RestoreNotebookPicker, PICKER_NONE);
	} catch {
		/* ignore */
	}
}

export async function loadSettings(): Promise<PluginSettings> {
	const confRaw = await joplin.settings.value(SettingKey.PlacementConfidence);
	const conf = typeof confRaw === 'number' ? confRaw : parseFloat(String(confRaw || '0.55'));

	const authModeRaw = String((await joplin.settings.value(SettingKey.XaiAuthMode)) || 'super_grok');
	const xaiAuthMode: XaiAuthModeId =
		authModeRaw === 'api_key' ? 'api_key' : 'super_grok';

	const providerRaw = String((await joplin.settings.value(SettingKey.Provider)) || 'xai');
	const provider: ProviderId =
		providerRaw === 'openrouter'
			? 'openrouter'
			: providerRaw === 'openai_compatible'
				? 'openai_compatible'
				: 'xai';

	return {
		provider,
		xaiAuthMode,
		xaiApiKey: String((await joplin.settings.value(SettingKey.XaiApiKey)) || ''),
		xaiModel: String((await joplin.settings.value(SettingKey.XaiModel)) || 'grok-4.5'),
		openRouterApiKey: String((await joplin.settings.value(SettingKey.OpenRouterApiKey)) || ''),
		openRouterModel: String(
			(await joplin.settings.value(SettingKey.OpenRouterModel)) || 'x-ai/grok-4.5'
		),
		openAiBaseUrl: String((await joplin.settings.value(SettingKey.OpenAiBaseUrl)) || 'http://localhost:11434/v1'),
		openAiApiKey: String((await joplin.settings.value(SettingKey.OpenAiApiKey)) || ''),
		openAiModel: String((await joplin.settings.value(SettingKey.OpenAiModel)) || 'llama3.2'),
		defaultNotebookId: String((await joplin.settings.value(SettingKey.DefaultNotebookId)) || ''),
		allowCreateNotebooks: Boolean(await joplin.settings.value(SettingKey.AllowCreateNotebooks)),
		confirmBeforeWrite: Boolean(await joplin.settings.value(SettingKey.ConfirmBeforeWrite)),
		showFab: Boolean(await joplin.settings.value(SettingKey.ShowFab)),
		systemPromptOverride: String((await joplin.settings.value(SettingKey.SystemPromptOverride)) || ''),
		placementConfidence: Number.isFinite(conf) ? conf : 0.55,
		maxToolSteps: Number((await joplin.settings.value(SettingKey.MaxToolSteps)) || 8),
		blockedNotebookIds: String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || ''),
		blockedPathPatterns: String((await joplin.settings.value(SettingKey.BlockedPathPatterns)) || ''),
		allowlistMode: Boolean(await joplin.settings.value(SettingKey.AllowlistMode)),
		allowedNotebookIds: String((await joplin.settings.value(SettingKey.AllowedNotebookIds)) || ''),
	};
}

/** Keep the human-readable paths setting in sync with blocked IDs. */
export async function syncExcludedPathsDisplay(): Promise<void> {
	const raw = String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || '');
	const ids = new Set(parseBlockedIdList(raw));
	if (!ids.size) {
		await joplin.settings.setValue(SettingKey.ExcludedNotebookPathsDisplay, '');
		return;
	}
	const notebooks = await listNotebookPaths();
	const paths = notebooks.filter((n) => ids.has(n.id)).map((n) => n.path);
	await joplin.settings.setValue(SettingKey.ExcludedNotebookPathsDisplay, paths.join('\n'));
}

function parseBlockedIdList(raw: string): string[] {
	return String(raw || '')
		.split(/[\n,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Append a notebook ID to the blocked list (no duplicates). */
export async function addBlockedNotebookId(notebookId: string): Promise<void> {
	await addBlockedNotebookIds([notebookId]);
}

/** Append several notebook IDs to the blocked list (no duplicates). */
export async function addBlockedNotebookIds(notebookIds: string[]): Promise<number> {
	const raw = String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || '');
	const ids = parseBlockedIdList(raw);
	const set = new Set(ids);
	let added = 0;
	for (const id of notebookIds) {
		const clean = String(id || '').trim();
		if (!clean || set.has(clean)) continue;
		set.add(clean);
		ids.push(clean);
		added += 1;
	}
	if (added) {
		await joplin.settings.setValue(SettingKey.BlockedNotebookIds, ids.join('\n'));
	}
	return added;
}

/** Remove a notebook ID from the blocked list. */
export async function removeBlockedNotebookId(notebookId: string): Promise<void> {
	await removeBlockedNotebookIds([notebookId]);
}

/** Remove several notebook IDs from the blocked list. */
export async function removeBlockedNotebookIds(notebookIds: string[]): Promise<number> {
	const remove = new Set(
		notebookIds.map((id) => String(id || '').trim()).filter(Boolean)
	);
	if (!remove.size) return 0;
	const raw = String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || '');
	const before = parseBlockedIdList(raw);
	const ids = before.filter((id) => !remove.has(id));
	const removed = before.length - ids.length;
	if (removed) {
		await joplin.settings.setValue(SettingKey.BlockedNotebookIds, ids.join('\n'));
	}
	return removed;
}
