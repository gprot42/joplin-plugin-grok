/**
 * Show/Hide toggle for the API key field (same row as the input).
 */
(function () {
	'use strict';

	function wire() {
		var input = document.getElementById('apiKey');
		var btn = document.getElementById('btnShow');
		if (!input || !btn) return;

		btn.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			if (input.disabled) return;
			var showing = input.type === 'text';
			input.type = showing ? 'password' : 'text';
			btn.textContent = showing ? 'Show' : 'Hide';
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wire);
	} else {
		wire();
	}
})();
