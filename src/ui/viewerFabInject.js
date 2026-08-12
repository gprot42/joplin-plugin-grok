/**
 * Floating Grok button in the Markdown viewer webview.
 */
(function () {
	'use strict';

	var CONTENT_SCRIPT_ID = 'joplinGrokViewerFab';
	var FAB_ID = 'joplin-grok-fab';
	var STYLE =
		'position:fixed;right:20px;bottom:20px;z-index:2147483646;width:56px;height:56px;' +
		'border-radius:50%;border:1px solid rgba(255,255,255,0.1);background:#0a0a0a;color:#fff;' +
		'box-shadow:0 10px 28px rgba(0,0,0,0.28),0 2px 8px rgba(0,0,0,0.16);cursor:pointer;' +
		'padding:0;margin:0;display:flex;align-items:center;justify-content:center;line-height:1;';
	var STAR =
		'<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
		'<path fill="currentColor" d="M12 1.6l1.85 6.05L20 9.5l-6.15 1.85L12 17.4l-1.85-6.05L4 9.5l6.15-1.85L12 1.6z"/>' +
		'<path fill="currentColor" d="M18.2 14.2l.95 3.1 3.1.95-3.1.95-.95 3.1-.95-3.1-3.1-.95 3.1-.95.95-3.1z"/>' +
		'</svg>';

	var show = true;
	var opening = false;

	function post(msg) {
		if (typeof webviewApi === 'undefined' || !webviewApi.postMessage) return Promise.resolve(null);
		return webviewApi.postMessage(CONTENT_SCRIPT_ID, msg);
	}

	function ensureFab(visible) {
		var existing = document.getElementById(FAB_ID);
		if (!visible) {
			if (existing) existing.remove();
			return;
		}
		if (existing) {
			existing.style.cssText = STYLE;
			return;
		}
		if (!document.body) return;
		var btn = document.createElement('button');
		btn.id = FAB_ID;
		btn.type = 'button';
		btn.title = 'Open Grok';
		btn.setAttribute('aria-label', 'Open Grok');
		btn.style.cssText = STYLE;
		btn.innerHTML = STAR;
		btn.addEventListener(
			'click',
			function (e) {
				e.preventDefault();
				e.stopPropagation();
				if (opening) return;
				opening = true;
				// One click: hide FAB immediately, open panel
				ensureFab(false);
				show = false;
				post({ type: 'openAssistant' })
					.then(function () {
						show = false;
					})
					.catch(function () {
						show = true;
						ensureFab(true);
					})
					.then(function () {
						opening = false;
					});
			},
			true
		);
		document.body.appendChild(btn);
	}

	function refresh() {
		if (opening) return;
		post({ type: 'getFabVisible' })
			.then(function (res) {
				if (res && typeof res.showFab === 'boolean') show = res.showFab;
				ensureFab(show);
			})
			.catch(function () {
				ensureFab(show);
			});
	}

	function boot() {
		refresh();
		setTimeout(refresh, 400);
		setTimeout(refresh, 1200);
		setTimeout(refresh, 2500);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
