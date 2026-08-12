/**
 * CodeMirror content script — floating Grok button (bottom-right).
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

function ensureFab(doc: Document, visible: boolean, onActivate: () => void): void {
	const existing = doc.getElementById(FAB_ID) as HTMLButtonElement | null;
	if (!visible) {
		if (existing) existing.remove();
		return;
	}
	if (existing) {
		existing.style.cssText = FAB_STYLE;
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

	// Use pointerdown — CodeMirror often eats the first "click" for focus
	const fire = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
		onActivate();
	};
	btn.addEventListener('pointerdown', fire, true);
	btn.addEventListener('click', fire, true);
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

				let wantShow = true;
				let opening = false;
				let lastOpenAt = 0;

				const onActivate = () => {
					const now = Date.now();
					// Ignore double-fire from pointerdown+click or dual listeners
					if (opening || now - lastOpenAt < 600) return;
					opening = true;
					lastOpenAt = now;
					// Hide only after host accepts open — keep button if open fails
					void context
						.postMessage({ type: 'openAssistant' })
						.then((res: any) => {
							if (res && res.ok !== false) {
								wantShow = false;
								ensureFab(doc, false, onActivate);
							}
						})
						.catch(() => {
							wantShow = true;
							ensureFab(doc, true, onActivate);
						})
						.finally(() => {
							opening = false;
							setTimeout(() => void tick(true), 500);
							setTimeout(() => void tick(true), 1500);
						});
				};

				const tick = async (_force = false) => {
					if (opening) return;
					try {
						const res: any = await context.postMessage({ type: 'getFabVisible' });
						if (res && typeof res.showFab === 'boolean') {
							wantShow = res.showFab;
						}
					} catch {
						/* keep */
					}
					ensureFab(doc, wantShow, onActivate);
				};

				void tick(true);
				[400, 1000, 2500].forEach((ms) => setTimeout(() => void tick(true), ms));
				setInterval(() => void tick(true), 2500);

				const root = doc.documentElement || doc.body;
				if (root) {
					const obs = new MutationObserver(() => {
						if (opening) return;
						if (!doc.getElementById(FAB_ID) && wantShow) void tick(true);
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
