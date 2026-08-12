import { resolveXaiAuth } from '../auth/resolveXaiAuth';
import {
	resolveOpenAiApiKey,
	resolveOpenRouterApiKey,
} from '../auth/secrets';
import { PluginSettings } from '../settings';
import { LLMProvider } from './types';
import { OpenAICompatibleProvider } from './openaiCompatible';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export async function createProvider(settings: PluginSettings): Promise<LLMProvider> {
	if (settings.provider === 'xai') {
		const auth = await resolveXaiAuth(settings.xaiAuthMode, settings.xaiApiKey);
		const label =
			auth.mode === 'super_grok'
				? `xAI ${auth.tierLabel || 'SuperGrok'}${auth.email ? ` (${auth.email})` : ''}`
				: `xAI (${auth.label})`;
		return new OpenAICompatibleProvider('xai', {
			baseUrl: 'https://api.x.ai/v1',
			apiKey: auth.bearerToken,
			defaultModel: settings.xaiModel,
			label,
		});
	}

	if (settings.provider === 'openrouter') {
		const resolved = resolveOpenRouterApiKey(settings.openRouterApiKey);
		if (!resolved) {
			throw new Error(
				'OpenRouter API key is not set. Put OPENROUTER_API_KEY in ~/.grok/.env or project .env (gitignored), or Configuration → Joplin Grok AI (https://openrouter.ai/keys).'
			);
		}
		const model = (settings.openRouterModel || '').trim() || 'x-ai/grok-4.5';
		return new OpenAICompatibleProvider('openrouter', {
			baseUrl: OPENROUTER_BASE_URL,
			apiKey: resolved.value,
			defaultModel: model,
			label: `OpenRouter (${resolved.source})`,
			// OpenRouter optional ranking headers
			extraHeaders: {
				'HTTP-Referer': 'https://github.com/gprot42/joplin-plugin-grok',
				'X-Title': 'Joplin Grok AI Assistant',
			},
		});
	}

	if (!settings.openAiBaseUrl) {
		throw new Error('OpenAI-compatible base URL is empty.');
	}

	const openAi = resolveOpenAiApiKey(settings.openAiApiKey);
	return new OpenAICompatibleProvider('openai_compatible', {
		baseUrl: settings.openAiBaseUrl,
		apiKey: openAi?.value || settings.openAiApiKey || '',
		defaultModel: settings.openAiModel,
		label: openAi ? `OpenAI-compatible (${openAi.source})` : 'OpenAI-compatible',
	});
}
