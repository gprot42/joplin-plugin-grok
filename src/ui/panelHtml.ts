/** Chat panel HTML — only shown when the assistant is open (no empty docked rail). */
export const CHAT_PANEL_HTML = `
<div id="shell" class="mode-chat">
	<div id="app">
		<header>
			<div>
				<h1>Grok</h1>
				<div class="meta" id="provider-label">Provider: —</div>
			</div>
			<div class="header-actions">
				<button type="button" id="btn-close" title="Close assistant">Close</button>
			</div>
		</header>

		<div class="toolbar">
			<span class="chip active" data-mode="chat">Chat</span>
			<span class="chip" data-mode="add">Add note</span>
			<span class="chip" data-mode="summarize">Summarize</span>
			<button type="button" id="btn-clear">Clear</button>
			<button type="button" id="btn-test">Test connection</button>
		</div>

		<div id="messages">
			<div class="empty-hint">
				Ask about your notes, add content with smart placement, or summarize the current note.
				<br /><br />
				Notebook access is configured under <strong>Configuration → Joplin Grok AI</strong>.
				<div class="privacy-note">
					<strong>Privacy:</strong> When you chat, note titles and content the assistant reads
					(via tools or “Include current note”) are sent to your configured AI provider
					(xAI, OpenRouter, or your OpenAI-compatible endpoint). Do not use this on notes you
					are not willing to share with that provider. Exclude private notebooks under settings.
				</div>
			</div>
		</div>

		<div id="composer">
			<textarea id="input" placeholder="Message the assistant… (Enter to send, Shift+Enter for newline)"></textarea>
			<div class="composer-row">
				<label>
					<input type="checkbox" id="include-current" />
					Include current note context
				</label>
				<button type="button" class="primary" id="btn-send">Send</button>
			</div>
			<div class="privacy-footer" title="Note content may be sent to your AI provider">
				Privacy: note content may leave your device to the AI provider
			</div>
			<div id="status"></div>
		</div>
	</div>
</div>
`;
