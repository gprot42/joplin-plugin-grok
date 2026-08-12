/**
 * Simple exclude UI: pick notebook → + Add → list with × remove.
 * Keeps #selectedIds in sync for Save.
 */
(function () {
	'use strict';

	function selectEl() {
		return document.getElementById('notebook-select');
	}
	function listEl() {
		return document.getElementById('excluded-list');
	}
	function hiddenEl() {
		return document.getElementById('selectedIds');
	}
	function emptyEl() {
		return document.getElementById('empty-state');
	}
	function countEl() {
		return document.getElementById('excluded-count');
	}
	function addBtn() {
		return document.getElementById('btn-add');
	}

	function optionById(id) {
		var sel = selectEl();
		if (!sel) return null;
		for (var i = 0; i < sel.options.length; i++) {
			if (sel.options[i].value === id) return sel.options[i];
		}
		return null;
	}

	function syncHidden() {
		var list = listEl();
		var hidden = hiddenEl();
		if (!list || !hidden) return;
		var ids = [];
		Array.prototype.forEach.call(list.querySelectorAll('.item[data-id]'), function (row) {
			var id = row.getAttribute('data-id');
			if (id) ids.push(id);
		});
		hidden.value = ids.join('\n');
		updateUi();
	}

	function updateUi() {
		var list = listEl();
		var empty = emptyEl();
		var count = countEl();
		var sel = selectEl();
		var btn = addBtn();
		if (!list) return;

		var n = list.querySelectorAll('.item[data-id]').length;
		if (count) count.textContent = String(n);
		if (empty) empty.classList.toggle('hidden', n > 0);

		// Disable options already excluded
		if (sel) {
			Array.prototype.forEach.call(sel.options, function (opt) {
				if (!opt.value) return;
				var taken = !!list.querySelector('.item[data-id="' + cssEscape(opt.value) + '"]');
				opt.disabled = taken;
			});
			// If current selection is disabled, jump to placeholder
			if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) {
				sel.value = '';
			}
		}
		if (btn) {
			btn.disabled = !sel || !sel.value;
		}
	}

	function cssEscape(s) {
		if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
		return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
	}

	function addSelected() {
		var sel = selectEl();
		var list = listEl();
		if (!sel || !list || !sel.value) return;

		var id = sel.value;
		if (list.querySelector('.item[data-id="' + cssEscape(id) + '"]')) {
			sel.value = '';
			updateUi();
			return;
		}

		var opt = optionById(id);
		var title = opt ? opt.getAttribute('data-title') || opt.textContent : id;
		var path = opt ? opt.getAttribute('data-path') || title : id;

		var row = document.createElement('div');
		row.className = 'item';
		row.setAttribute('data-id', id);

		var body = document.createElement('div');
		body.className = 'body';
		var t = document.createElement('span');
		t.className = 'title';
		t.textContent = title;
		var p = document.createElement('span');
		p.className = 'path';
		p.textContent = path;
		body.appendChild(t);
		body.appendChild(p);

		var rem = document.createElement('button');
		rem.type = 'button';
		rem.className = 'btn-remove';
		rem.title = 'Remove';
		rem.setAttribute('aria-label', 'Remove');
		rem.textContent = '×';

		row.appendChild(body);
		row.appendChild(rem);
		list.appendChild(row);

		// Reset select to pick another
		sel.value = '';
		syncHidden();
	}

	function removeItem(row) {
		if (!row) return;
		row.remove();
		syncHidden();
	}

	function boot() {
		var sel = selectEl();
		var btn = addBtn();
		var list = listEl();

		if (sel) {
			sel.addEventListener('change', updateUi);
			sel.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					addSelected();
				}
			});
		}
		if (btn) {
			btn.addEventListener('click', function (ev) {
				ev.preventDefault();
				addSelected();
			});
		}
		if (list) {
			list.addEventListener('click', function (ev) {
				var t = ev.target;
				if (t && t.classList && t.classList.contains('btn-remove')) {
					ev.preventDefault();
					removeItem(t.closest('.item'));
				}
			});
		}

		syncHidden();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
