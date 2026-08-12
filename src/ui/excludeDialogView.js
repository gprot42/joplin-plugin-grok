/**
 * Exclude dialog view:
 *  - Fills the notebook <select> from JSON in #notebooks-data
 *  - + Add / × update the excluded list
 *  - Keeps Joplin form fields in sync:
 *      • #form-ids → checkbox name="nb__{id}" for each excluded (authoritative for formData)
 *      • #selectedIds → comma-separated backup
 *
 * Requires a <form name="excludeForm"> in the HTML (Joplin only returns formData from forms).
 */
(function () {
	'use strict';

	function $(id) {
		return document.getElementById(id);
	}

	function cssEscape(s) {
		if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(s));
		return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
	}

	function readNotebooks() {
		var el = $('notebooks-data');
		if (!el) return [];
		try {
			var raw =
				typeof el.value === 'string' && el.value
					? el.value
					: el.textContent || el.innerText || '[]';
			var data = JSON.parse(raw);
			return Array.isArray(data) ? data : [];
		} catch (e) {
			return [];
		}
	}

	function readInitialExcluded() {
		var ids = [];
		// From seed checkboxes
		Array.prototype.forEach.call(document.querySelectorAll('#form-ids input[name^="nb__"]'), function (inp) {
			var name = inp.getAttribute('name') || '';
			var id = name.indexOf('nb__') === 0 ? name.slice(4) : '';
			if (id) ids.push(id);
		});
		// From selectedIds field
		var el = $('selectedIds');
		if (el && el.value) {
			String(el.value)
				.split(/[\n,;]+/)
				.forEach(function (s) {
					var id = s.trim();
					if (id) ids.push(id);
				});
		}
		// Dedupe
		var seen = {};
		var out = [];
		ids.forEach(function (id) {
			if (!seen[id]) {
				seen[id] = true;
				out.push(id);
			}
		});
		return out;
	}

	function optionLabel(nb) {
		var depth = nb.depth || 0;
		var indent = depth > 0 ? new Array(Math.min(depth, 8) + 1).join('· ') : '';
		var path = nb.path || nb.title || nb.id;
		var raw = indent + path;
		return raw.length > 90 ? raw.slice(0, 87) + '…' : raw;
	}

	function fillSelect(notebooks, excludedSet) {
		var sel = $('notebook-select');
		if (!sel) return;
		sel.innerHTML = '';
		var ph = document.createElement('option');
		ph.value = '';
		ph.textContent = notebooks.length
			? 'Select a notebook… (' + notebooks.length + ' available)'
			: 'No notebooks found';
		sel.appendChild(ph);

		notebooks.forEach(function (nb) {
			if (!nb || !nb.id) return;
			var opt = document.createElement('option');
			opt.value = nb.id;
			opt.textContent = optionLabel(nb);
			opt.setAttribute('data-title', nb.title || nb.path || nb.id);
			opt.setAttribute('data-path', nb.path || nb.title || nb.id);
			if (excludedSet[nb.id]) opt.disabled = true;
			sel.appendChild(opt);
		});
	}

	function excludedIds() {
		var list = $('excluded-list');
		if (!list) return [];
		var ids = [];
		Array.prototype.forEach.call(list.querySelectorAll('.item[data-id]'), function (row) {
			var id = row.getAttribute('data-id');
			if (id) ids.push(id);
		});
		return ids;
	}

	/** Rebuild form fields Joplin will serialize on Save. */
	function syncFormFields() {
		var ids = excludedIds();
		var box = $('form-ids');
		if (box) {
			box.innerHTML = '';
			ids.forEach(function (id) {
				var cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.name = 'nb__' + id;
				cb.value = '1';
				cb.checked = true;
				cb.className = 'nb-seed';
				cb.style.display = 'none';
				// Required so unchecked-but-present isn't an issue — always checked
				cb.defaultChecked = true;
				box.appendChild(cb);
			});
		}
		var field = $('selectedIds');
		if (field) field.value = ids.join(',');
		updateUi();
	}

	function updateUi() {
		var list = $('excluded-list');
		var empty = $('empty-state');
		var count = $('excluded-count');
		var sel = $('notebook-select');
		var btn = $('btn-add');
		var ids = excludedIds();
		var taken = {};
		ids.forEach(function (id) {
			taken[id] = true;
		});

		if (count) count.textContent = String(ids.length);
		if (empty) empty.classList.toggle('hidden', ids.length > 0);

		if (sel) {
			Array.prototype.forEach.call(sel.options, function (opt) {
				if (!opt.value) return;
				opt.disabled = !!taken[opt.value];
			});
			if (sel.value && taken[sel.value]) sel.value = '';
		}
		if (btn) btn.disabled = !sel || !sel.value;
	}

	function makeRow(id, nb) {
		var row = document.createElement('div');
		row.className = 'item';
		row.setAttribute('data-id', id);

		var body = document.createElement('div');
		body.className = 'body';
		var t = document.createElement('span');
		t.className = 'title';
		t.textContent = (nb && (nb.title || nb.path)) || id;
		var p = document.createElement('span');
		p.className = 'path';
		p.textContent = (nb && nb.path) || id;
		body.appendChild(t);
		body.appendChild(p);

		var rem = document.createElement('input');
		rem.type = 'button';
		rem.className = 'btn-remove';
		rem.value = '×';
		rem.title = 'Remove';
		rem.setAttribute('aria-label', 'Remove');

		row.appendChild(body);
		row.appendChild(rem);
		return row;
	}

	function renderExcluded(items, byId) {
		var list = $('excluded-list');
		if (!list) return;
		Array.prototype.slice.call(list.querySelectorAll('.item')).forEach(function (n) {
			n.remove();
		});
		items.forEach(function (id) {
			list.appendChild(makeRow(id, byId[id]));
		});
	}

	function addSelected(byId) {
		var sel = $('notebook-select');
		var list = $('excluded-list');
		if (!sel || !list || !sel.value) return;

		var id = sel.value;
		if (list.querySelector('.item[data-id="' + cssEscape(id) + '"]')) {
			sel.value = '';
			updateUi();
			return;
		}

		var nb = byId[id] || {
			id: id,
			title:
				(sel.selectedOptions[0] && sel.selectedOptions[0].getAttribute('data-title')) || id,
			path:
				(sel.selectedOptions[0] && sel.selectedOptions[0].getAttribute('data-path')) || id,
		};

		list.appendChild(makeRow(id, nb));
		sel.value = '';
		syncFormFields();
	}

	function boot() {
		var notebooks = readNotebooks();
		var byId = {};
		notebooks.forEach(function (nb) {
			if (nb && nb.id) byId[nb.id] = nb;
		});

		var err = $('error-banner');
		if (err) {
			if (!notebooks.length) {
				err.textContent =
					'No notebooks could be loaded. Close this dialog, open a notebook in Joplin, then try again.';
				err.classList.remove('hidden');
			} else {
				err.classList.add('hidden');
			}
		}

		var initial = readInitialExcluded();
		var taken = {};
		initial.forEach(function (id) {
			taken[id] = true;
		});

		fillSelect(notebooks, taken);
		renderExcluded(initial, byId);
		syncFormFields();

		var sel = $('notebook-select');
		var btn = $('btn-add');
		var list = $('excluded-list');

		if (sel) {
			sel.addEventListener('change', updateUi);
			sel.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					addSelected(byId);
				}
			});
		}
		if (btn) {
			btn.addEventListener('click', function (ev) {
				ev.preventDefault();
				ev.stopPropagation();
				addSelected(byId);
			});
		}
		if (list) {
			list.addEventListener('click', function (ev) {
				var t = ev.target;
				if (t && t.classList && t.classList.contains('btn-remove')) {
					ev.preventDefault();
					var row = t.closest ? t.closest('.item') : t.parentNode;
					if (row && row.classList && row.classList.contains('item')) {
						row.remove();
						syncFormFields();
					}
				}
			});
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		setTimeout(boot, 0);
	}
})();
