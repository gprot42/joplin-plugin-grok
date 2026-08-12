/**
 * CodeMirror content script — single floating Grok button (bottom-right).
 * Only used when the chat panel is closed (no docked empty rail).
 */
import { ContentScriptContext } from 'api/types';

const FAB_ID = 'joplin-grok-fab';

const FAB_STYLE = [
	'position:fixed',
	'right:20px',
	'bottom:20px',
	'z-index:2147483646',
	'width:56px',
	'height:56px',
	'border-radius:50%',
	'border:1px solid rgba(255,255,255,0.1)',
	'background:#0a0a0a',
	'color:#fff',
	'box-shadow:0 10px 28px rgba(0,0,0,0.28),0 2px 8px rgba(0,0,0,0.16)',
	'cursor:pointer',
	'padding:0',
	'margin:0',
	'display:flex',
	'align-items:center',
	'justify-content:center',
	'line-height:1',
	'pointer-events:auto',
].join(';');

const STAR_SVG =
	'<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
	'<path fill="currentColor" d="M12 1.6l1.85 6.05L20 9.5l-6.15 1.85L12 17.4l-1.85-6.05L4 9.5l6.15-1.85L12 1.6z"/>' +
	'<path fill="currentColor" d="M18.2 14.2l.95 3.1 3.1.95-3.1.95-.95 3.1-.95-3.1-3.1-.95 3.1-.95.95-3.1z"/>' +
	'</svg>';

function ensureFab(doc: Document, visible: boolean): void {
	const existing = doc.getElementById(FAB_ID);
	if (!visible) {
		if (existing) existing.remove();
		return;
	}
	if (existing) {
		(existing as HTMLElement).style.cssText = FAB_STYLE;
		return;
	}
	if (!doc.body) return;
	const btn = doc.createElement('button');
	btn.id = FAB_ID;
	btn.type = 'button';
	btn.title = 'Open Grok';
	btn.setAttribute('aria-label', 'Open Grok');
	btn.style.cssText = FAB_STYLE;
	btn.innerHTML = STAR_SVG;
	// Click handler is attached once at creation via the outer plugin() closure.
	doc.body.appendChild(btn);
}

module.exports = {
	default: function (context: ContentScriptContext) {
		return {
			plugin: function (cm: any) {
				const doc =
					(typeof document !== 'undefined' ? document : null) ||
					cm?.editor?.dom?.ownerDocument ||
					cm?.getWrapperElement?.()?.ownerDocument ||
					null;
				if (!doc) return;

				let cachedShow: boolean | null = null;
				let lastFetch = 0;
				let opening = false;

				const setVisible = (visible: boolean) => {
					cachedShow = visible;
					ensureFab(doc, visible);
					const btn = doc.getElementById(FAB_ID) as HTMLButtonElement | null;
					if (btn && !btn.dataset.grokBound) {
						btn.dataset.grokBound = '1';
						btn.addEventListener(
							'click',
							(e) => {
								e.preventDefault();
								e.stopPropagation();
								if (opening) return;
								opening = true;
								// Hide immediately so one click feels definitive
								setVisible(false);
								void context
									.postMessage({ type: 'openAssistant' })
									.then(() => {
										cachedShow = false;
										lastFetch = Date.now();
									})
									.catch(() => {
										// Re-show if open failed
										setVisible(true);
									})
									.finally(() => {
										opening = false;
									});
							},
							true
						);
					}
				};

				const tick = async () => {
					try {
						const now = Date.now();
						// While a click is in flight, don't resurrect the FAB from a stale poll
						if (opening) return;
						if (cachedShow === null || now - lastFetch > 1500) {
							const res: any = await context.postMessage({ type: 'getFabVisible' });
							cachedShow = res?.showFab !== false;
							lastFetch = now;
						}
						setVisible(cachedShow !== false);
					} catch {
						/* ignore */
					}
				};

				void tick();
				[200, 600, 1500, 3000].forEach((ms) => setTimeout(() => void tick(), ms));

				const root = doc.documentElement || doc.body;
				if (root) {
					const obs = new MutationObserver(() => {
						if (opening) return;
						if (!doc.getElementById(FAB_ID) && cachedShow !== false) void tick();
					});
					obs.observe(root, { childList: true, subtree: true });
				}
			},
			assets: function () {
				return [];
			},
		};
	},
};
