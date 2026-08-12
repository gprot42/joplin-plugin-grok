/**
 * Chat panel webview script — loaded via joplin.views.panels.addScript.
 * Talks to the plugin host via webviewApi.postMessage.
 * Transcript is stored on the host so close/reopen keeps prior results.
 */
(function () {
	'use strict';

	var mode = 'chat';
	var busy = false;
	/** API history: user + assistant only */
	var chatHistory = [];
	/** Full UI transcript (includes tool/error rows) for restore */
	var uiTranscript = [];
	var restoreScheduled = false;

	function messagesEl() {
		return document.getElementById('messages');
	}
	function inputEl() {
		return document.getElementById('input');
	}
	function statusEl() {
		return document.getElementById('status');
	}
	function providerLabel() {
		return document.getElementById('provider-label');
	}

	function setStatus(text, kind) {
		var el = statusEl();
		if (!el) return;
		el.textContent = text;
		el.className = kind || '';
	}

	function clearEmptyHint() {
		var empty = messagesEl().querySelector('.empty-hint');
		if (empty) empty.remove();
	}

	function emptyHintHtml() {
		return (
			'<div class="empty-hint">' +
			'Ask about your notes, add content with smart placement, or summarize the current note.' +
			'<br /><br />' +
			'Notebook access is configured under <strong>Configuration → Joplin Grok AI</strong>.' +
			'<div class="privacy-note">' +
			'<strong>Privacy:</strong> When you chat, note titles and content the assistant reads ' +
			'(via tools or “Include current note”) are sent to your configured AI provider ' +
			'(xAI, OpenRouter, or your OpenAI-compatible endpoint). Do not use this on notes you ' +
			'are not willing to share with that provider. Exclude private notebooks under settings.' +
			'</div>' +
			'</div>'
		);
	}

	function sendToHost(message) {
		return webviewApi.postMessage(message);
	}

	function persistTranscript() {
		return sendToHost({
			type: 'saveTranscript',
			messages: uiTranscript,
			chatMode: mode,
		}).catch(function () {
			/* host may not be ready */
		});
	}

	function scrollMessagesToBottom() {
		var box = messagesEl();
		if (!box) return;
		// Double rAF so layout settles after long assistant replies
		requestAnimationFrame(function () {
			box.scrollTop = box.scrollHeight;
			requestAnimationFrame(function () {
				box.scrollTop = box.scrollHeight;
			});
		});
	}

	function appendMessage(role, content, extraClass, skipPersist) {
		clearEmptyHint();
		var div = document.createElement('div');
		div.className = ('msg ' + role + ' ' + (extraClass || '')).trim();
		var roleSpan = document.createElement('span');
		roleSpan.className = 'role';
		roleSpan.textContent = role;
		div.appendChild(roleSpan);
		div.appendChild(document.createTextNode(content));
		messagesEl().appendChild(div);
		scrollMessagesToBottom();

		uiTranscript.push({
			role: role,
			content: content,
			extraClass: extraClass || '',
		});
		if (!skipPersist) persistTranscript();
	}

	function rebuildChatHistoryFromUi() {
		chatHistory = [];
		uiTranscript.forEach(function (m) {
			if (m.role === 'user' || m.role === 'assistant') {
				if (m.extraClass === 'error') return;
				chatHistory.push({ role: m.role, content: m.content });
			}
		});
	}

	function restoreTranscript(messages, chatMode) {
		uiTranscript = [];
		chatHistory = [];
		var box = messagesEl();
		if (!box) return;

		if (!messages || !messages.length) {
			box.innerHTML = emptyHintHtml();
			if (chatMode) setMode(chatMode, true);
			return;
		}

		box.innerHTML = '';
		messages.forEach(function (m) {
			appendMessage(
				String(m.role || 'assistant'),
				String(m.content || ''),
				m.extraClass ? String(m.extraClass) : '',
				true
			);
		});
		rebuildChatHistoryFromUi();
		if (chatMode) setMode(chatMode, true);
		// One host write after bulk restore
		persistTranscript();
		scrollMessagesToBottom();
	}

	function loadTranscriptFromHost() {
		return sendToHost({ type: 'getTranscript' })
			.then(function (res) {
				if (res && Array.isArray(res.messages) && res.messages.length) {
					restoreTranscript(res.messages, res.chatMode || mode);
				} else if (res && res.chatMode) {
					setMode(res.chatMode, true);
				}
			})
			.catch(function () {
				/* ignore */
			});
	}

	function refreshProvider() {
		return sendToHost({ type: 'getStatus' })
			.then(function (info) {
				var bits = [
					'Provider: ' + (info.provider || '?'),
					info.model || '',
					info.authLabel || info.authMode || '',
				].filter(Boolean);
				providerLabel().textContent = bits.join(' · ');
			})
			.catch(function () {
				providerLabel().textContent = 'Provider: (error loading settings)';
			});
	}

	function setMode(next, skipPersist) {
		mode = next || 'chat';
		document.querySelectorAll('.chip').forEach(function (el) {
			el.classList.toggle('active', el.dataset.mode === mode);
		});
		var placeholders = {
			chat: 'Message the assistant…',
			add: 'Describe the note to create (title + content). AI will place it in the best allowed notebook…',
			summarize: 'Optional focus for the summary (or leave empty to summarize the current note)…',
		};
		if (inputEl()) {
			inputEl().placeholder = placeholders[mode] || placeholders.chat;
		}
		if (!skipPersist) persistTranscript();
	}

	/** Compact, human-readable tool line (avoid dumping huge JSON). */
	function formatToolTrace(t) {
		var name = t.name || 'tool';
		var result = t.result;
		var argsShort = '';
		try {
			var parsed = typeof t.args === 'string' ? JSON.parse(t.args || '{}') : t.args || {};
			var keys = Object.keys(parsed || {});
			if (keys.length) {
				argsShort =
					'(' +
					keys
						.slice(0, 3)
						.map(function (k) {
							var v = parsed[k];
							var s = typeof v === 'string' ? v : JSON.stringify(v);
							if (s && s.length > 40) s = s.slice(0, 40) + '…';
							return k + '=' + s;
						})
						.join(', ') +
					')';
			} else {
				argsShort = '()';
			}
		} catch (e) {
			argsShort = '()';
		}

		if (result && typeof result === 'object') {
			if (result.error) {
				return name + argsShort + ' → error: ' + String(result.error).slice(0, 160);
			}
			if (name === 'list_notebooks') {
				var matching = result.matching != null ? result.matching : result.count;
				var returned = result.returned != null ? result.returned : (result.notebooks || []).length;
				var nbs = result.notebooks || [];
				var sample = nbs
					.slice(0, 6)
					.map(function (n) {
						return n.path || n.title || n.id;
					})
					.join(' · ');
				var line =
					name +
					argsShort +
					' → ' +
					returned +
					' shown' +
					(matching != null ? ' of ' + matching + ' matching' : '') +
					(result.total_accessible != null ? ' (' + result.total_accessible + ' accessible)' : '');
				if (result.truncated) line += ' [truncated]';
				if (sample) line += '\n  ' + sample + (matching > 6 || returned > 6 ? ' · …' : '');
				return line;
			}
			if (name === 'search_notes' || name === 'list_notes') {
				var notes = result.notes || [];
				var sc = result.count != null ? result.count : notes.length;
				var titles = notes
					.slice(0, 6)
					.map(function (n) {
						return n.title || n.id;
					})
					.join(' · ');
				var pathBit = result.notebook_path ? ' @ ' + result.notebook_path : '';
				return (
					name +
					argsShort +
					' → ' +
					sc +
					' note(s)' +
					pathBit +
					(result.truncated ? ' [truncated]' : '') +
					(titles ? '\n  ' + titles + (sc > 6 ? ' · …' : '') : '')
				);
			}
			if (name === 'get_note' || name === 'get_current_note') {
				var note = result.note || result;
				var title = note && (note.title || note.id);
				var path = note && note.notebook_path;
				return (
					name +
					argsShort +
					' → ' +
					(title || 'ok') +
					(path ? ' @ ' + path : '') +
					(result.message ? ' (' + result.message + ')' : '')
				);
			}
			if (name === 'create_note' || name === 'update_note') {
				return (
					name +
					argsShort +
					' → ' +
					(result.title || result.id || 'ok') +
					(result.notebook_path ? ' @ ' + result.notebook_path : '')
				);
			}
			if (name === 'suggest_placement') {
				return (
					name +
					argsShort +
					' → ' +
					(result.path || result.notebook_id || result.notebook_path || JSON.stringify(result).slice(0, 120))
				);
			}
		}

		var preview;
		try {
			preview = JSON.stringify(result);
		} catch (e2) {
			preview = String(result);
		}
		if (preview.length > 160) preview = preview.slice(0, 160) + '…';
		return name + argsShort + ' → ' + preview;
	}

	function handleSend() {
		if (busy) return;
		var text = inputEl().value.trim();
		if (!text && mode !== 'summarize') return;

		var includeCurrent = document.getElementById('include-current').checked;
		busy = true;
		document.getElementById('btn-send').disabled = true;
		setStatus('Thinking…', 'thinking');

		var displayUser = text || '(summarize current note)';
		appendMessage('user', displayUser);
		inputEl().value = '';
		chatHistory.push({ role: 'user', content: displayUser });

		sendToHost({
			type: 'chat',
			mode: mode,
			text: text,
			includeCurrent: includeCurrent,
			history: chatHistory.slice(0, -1),
		})
			.then(function (result) {
				if (result.error) {
					appendMessage('error', result.error, 'error');
					setStatus(result.error, 'error');
				} else {
					// One compact tool line — avoid a wall of tool output looking like the answer
					if (result.toolTrace && result.toolTrace.length) {
						var names = result.toolTrace.map(function (t) {
							return t.name || 'tool';
						});
						var toolSummary =
							'Used ' +
							result.toolTrace.length +
							' tool step' +
							(result.toolTrace.length === 1 ? '' : 's') +
							': ' +
							names.join(' → ');
						// For long traces, add only first few detail lines (titles/paths, not bodies)
						var detailCap = names.length > 8 ? 4 : Math.min(names.length, 6);
						var details = result.toolTrace.slice(0, detailCap).map(function (t) {
							return formatToolTrace(t);
						});
						if (details.length) {
							toolSummary +=
								'\n' +
								details
									.map(function (d) {
										// Single-line only — drop multi-line samples for less noise
										return '· ' + String(d).split('\n')[0];
									})
									.join('\n');
							if (result.toolTrace.length > detailCap) {
								toolSummary +=
									'\n· … +' +
									(result.toolTrace.length - detailCap) +
									' more';
							}
						}
						appendMessage('tool', toolSummary);
					}
					var reply = result.assistantMessage || '(empty)';
					appendMessage('assistant', reply);
					chatHistory.push({ role: 'assistant', content: reply });
					// Subtle usage line (tokens / est. USD) — not a primary UI element
					if (result.usageFooter) {
						appendMessage('usage', String(result.usageFooter), 'usage');
					}
					setStatus('Done', 'ok');
				}
			})
			.catch(function (e) {
				var msg = (e && e.message) || String(e);
				appendMessage('error', msg, 'error');
				setStatus(msg, 'error');
			})
			.then(function () {
				busy = false;
				document.getElementById('btn-send').disabled = false;
				return refreshProvider();
			});
	}

	function setUiMode(_next) {
		// Panel is only mounted when chat is open
		refreshProvider();
		if (!uiTranscript.length && !restoreScheduled) {
			restoreScheduled = true;
			loadTranscriptFromHost().then(function () {
				restoreScheduled = false;
			});
		}
	}

	function wireUi() {
		document.getElementById('btn-send').addEventListener('click', handleSend);
		document.getElementById('btn-clear').addEventListener('click', function () {
			chatHistory = [];
			uiTranscript = [];
			messagesEl().innerHTML = emptyHintHtml();
			setStatus('');
			sendToHost({ type: 'clearTranscript' });
		});
		document.getElementById('btn-test').addEventListener('click', function () {
			setStatus('Testing connection…');
			sendToHost({ type: 'testConnection' })
				.then(function (r) {
					setStatus(r.message || (r.ok ? 'OK' : 'Failed'), r.ok ? 'ok' : 'error');
					if (r.message) appendMessage('assistant', r.message);
				})
				.catch(function (e) {
					setStatus((e && e.message) || String(e), 'error');
				});
		});

		var btnClose = document.getElementById('btn-close');
		if (btnClose) {
			btnClose.addEventListener('click', function () {
				sendToHost({
					type: 'closeAssistant',
					messages: uiTranscript,
					chatMode: mode,
				});
			});
		}

		document.querySelectorAll('.chip').forEach(function (el) {
			el.addEventListener('click', function () {
				setMode(el.dataset.mode);
			});
		});
		inputEl().addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter' && !ev.shiftKey) {
				ev.preventDefault();
				handleSend();
			}
		});

		if (typeof webviewApi !== 'undefined' && webviewApi.onMessage) {
			webviewApi.onMessage(function (msg) {
				var payload = msg && msg.message != null ? msg.message : msg;
				if (!payload) return;
				if (payload.type === 'setUiMode') {
					setUiMode(payload.mode);
					if (payload.mode === 'chat') {
						// Host may push transcript when expanding
						loadTranscriptFromHost();
					}
				}
				if (payload.type === 'restoreTranscript' && Array.isArray(payload.messages)) {
					restoreTranscript(payload.messages, payload.chatMode);
				}
			});
		}
	}

	function boot() {
		wireUi();
		refreshProvider();
		sendToHost({ type: 'panelReady' })
			.then(function (res) {
				if (res && Array.isArray(res.messages) && res.messages.length) {
					restoreTranscript(res.messages, res.chatMode || mode);
				} else if (res && res.chatMode) {
					setMode(res.chatMode, true);
				}
			})
			.catch(function () {
				/* host may not answer yet */
			});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
