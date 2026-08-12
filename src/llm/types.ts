export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
	role: Role;
	content: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ToolSpec {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ChatRequest {
	messages: ChatMessage[];
	tools?: ToolSpec[];
	model?: string;
	temperature?: number;
	tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatResponse {
	message: ChatMessage;
	finish_reason?: string;
	raw?: unknown;
}

export interface LLMProvider {
	id: string;
	chat(request: ChatRequest): Promise<ChatResponse>;
}
