/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
let _state = { removing: null, busy: false, params: {} };

window.onload = function () {
	_state.params.create = __LOAD_PARAMS__?.create ?? false;
	_state.params.delete = __LOAD_PARAMS__?.delete ?? false;
	_state.params.games = __LOAD_PARAMS__?.games ?? '/bad_path';
	_state.params.editor = __LOAD_PARAMS__?.editor ?? '/bad_path';
	_state.params.play = __LOAD_PARAMS__?.play ?? '/bad_path';
	_state.params.game = __LOAD_PARAMS__?.game ?? '/bad_path';

	/* check if creating of crosswords is allowed */
	if (_state.params.create) {
		let entry = document.createElement('a');
		entry.classList.add('button', 'menu-option');
		entry.href = _state.params.editor;
		document.getElementById('content').appendChild(entry);

		let text = document.createElement('div');
		text.classList.add('menu-text');
		text.innerText = 'Create a new Crossword!';
		entry.appendChild(text);
	}

	/* check if a notification is to be shown */
	let name = new URLSearchParams(document.location.search).get('uploaded');
	if (name != null)
		PushNotification(`Crossword [${name}] uploaded!`, false, null);

	/* patch the history to prevent the banner from being shown again */
	if (window.history.replaceState) {
		let url = `${document.location.protocol}//${window.location.host}${window.location.pathname}`;
		if (window.location.pathname.endsWith('/') && window.location.pathname != '/')
			url = url.slice(0, url.length - 1);
		window.history.replaceState({}, document.title, url);
	}

	/* register handle to cancel dialogs */
	window.addEventListener('keydown', function (e) {
		if (e.key === 'Escape')
			_state.cancelRemove();
	});

	/* start the query of all of the games */
	_state.loadList();
}

_state.loadList = function () {
	fetch(_state.params.games)
		.then(function (resp) {
			if (resp.status != 200)
				throw new Error(`Server responded with ${resp.status}`);
			if (resp.headers.has('content-type') && !resp.headers.get('content-type').startsWith('application/json'))
				throw new Error(`Server did not respond with json`);
			return resp.json();
		})
		.then(function (json) {
			json.sort();

			/* clear the old list */
			const content = document.getElementById('content');
			while (content.children.length > (_state.params.create ? 1 : 0))
				content.lastChild.remove();

			/* write the values out */
			for (const name of json) {
				/* add the next entry */
				let entry = document.createElement('a');
				entry.classList.add('button', 'menu-option');
				entry.href = `${_state.params.play}?game=${encodeURIComponent(name)}`;
				content.appendChild(entry);

				let text = document.createElement('div');
				text.classList.add('menu-text');
				entry.appendChild(text);

				/* add the inner html */
				text.innerText = name;

				/* check if the crosswords can be deleted */
				if (!_state.params.delete)
					continue;
				let hsep = document.createElement('div');
				hsep.classList.add('splitter');
				entry.appendChild(hsep);

				let button = document.createElement('div');
				button.classList.add('button');
				button.innerText = '\u2716';
				button.onclick = function (e) {
					e.stopPropagation();
					e.preventDefault();
					_state.removeEntry(name);
				};
				entry.appendChild(button);
			}
		})
		.catch(function (e) {
			PushNotification(`Failed to fetch the list of games: ${e.message}!`, true, () => _state.loadList());
		});
}

_state.removeEntry = function (name) {
	/* show the remove-screen */
	document.getElementById('remove').classList.add('show');
	document.getElementById('remove-busy').classList.remove('show');

	/* update the static content */
	document.getElementById('remove-caption').innerText = `Removing Crossword`;
	document.getElementById('remove-disclaimer').innerText = `Are you sure you want to remove: [${name}]\nThe game will be removed permanently.`;
	_state.removing = name;
}
_state.doRemove = function () {
	if (_state.removing == null) return;

	if (_state.busy) {
		document.getElementById('remove-busy').classList.add('show');
		return;
	}
	_state.busy = true;

	/* try to remove the entry */
	fetch(`${_state.params.game}/${_state.removing}`, { method: 'DELETE' })
		.then(function (resp) {
			if (!resp.ok)
				throw new Error(resp.statusText);

			PushNotification(`Crossword [${_state.removing}] removed!`, false, null);
			_state.cancelRemove();
			_state.busy = false;
			_state.loadList();
		}).catch(function (e) {
			PushNotification(`Failed to remove game [${_state.removing}]: ${e.message}`, true, () => _state.loadList());
			_state.cancelRemove();
			_state.busy = false;
		});
}
_state.cancelRemove = function () {
	document.getElementById('remove').classList.remove('show');
	_state.removing = null;
}