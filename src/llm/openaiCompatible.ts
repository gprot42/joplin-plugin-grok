import { ChatRequest, ChatResponse, LLMProvider } from './types';

export interface OpenAICompatibleConfig {
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	/** Label for errors */
	label?: string;
	/** Extra HTTP headers (e.g. OpenRouter HTTP-Referer / X-Title) */
	extraHeaders?: Record<string, string>;
}

export class OpenAICompatibleProvider implements LLMProvider {
	id: string;
	private config: OpenAICompatibleConfig;

	constructor(id: string, config: OpenAICompatibleConfig) {
		this.id = id;
		this.config = config;
	}

	async chat(request: ChatRequest): Promise<ChatResponse> {
		const base = this.config.baseUrl.replace(/\/+$/, '');
		const url = `${base}/chat/completions`;
		const model = request.model || this.config.defaultModel;

		const body: Record<string, unknown> = {
			model,
			messages: request.messages,
			temperature: request.temperature ?? 0.3,
		};
		if (request.tools && request.tools.length) {
			body.tools = request.tools;
			body.tool_choice = request.tool_choice || 'auto';
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(this.config.extraHeaders || {}),
		};
		if (this.config.apiKey) {
			headers.Authorization = `Bearer ${this.config.apiKey}`;
		}

		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});

		const text = await res.text();
		let data: any;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(
				`${this.config.label || this.id} returned non-JSON (${res.status}): ${text.slice(0, 300)}`
			);
		}

		if (!res.ok) {
			const msg = data?.error?.message || data?.error || text.slice(0, 400);
			throw new Error(`${this.config.label || this.id} API error ${res.status}: ${msg}`);
		}

		const choice = data.choices && data.choices[0];
		if (!choice) {
			throw new Error(`${this.config.label || this.id}: empty response`);
		}

		const message = choice.message || {};
		const u = data?.usage;
		const usage =
			u && typeof u === 'object'
				? {
						prompt_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
						completion_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
						total_tokens:
							Number(u.total_tokens ?? 0) ||
							(Number(u.prompt_tokens ?? 0) || 0) + (Number(u.completion_tokens ?? 0) || 0),
					}
				: null;
		return {
			message: {
				role: message.role || 'assistant',
				content: message.content ?? null,
				tool_calls: message.tool_calls,
			},
			finish_reason: choice.finish_reason,
			raw: data,
			usage,
		};
	}
}
