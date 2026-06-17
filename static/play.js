/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
let _state = {
	game: '',
	name: '',
	sock: null,
	dirty: false,
	ackStamp: 0,
	grid: null,
	players: {},
	usedsHues: [],
	view: null,
	focus: null,
	configured: false,
	failedNotified: false,
	params: {}
};

window.onload = function () {
	_state.params.edit = __LOAD_PARAMS__?.edit ?? false;
	_state.params.sockets = __LOAD_PARAMS__?.sockets ?? '/bad_path';
	_state.params.cookie = {
		name: __LOAD_PARAMS__?.cookie?.name ?? '',
		lifetime: __LOAD_PARAMS__?.cookie?.lifetime ?? 0
	};

	/* ensure phones handle the visibility of the keyboard properly */
	if (window.visualViewport) {
		let lastHeight = window.visualViewport.height;
		window.visualViewport.addEventListener("resize", function () {

			/* check if the keyboard was hidden and take the focus */
			if (lastHeight * (4 / 3) < window.visualViewport.height && _state.focus != null)
				_state.focus.lose();
			lastHeight = window.visualViewport.height;

			/* resize all components accordingly */
			document.body.style.height = `${window.visualViewport.height}px`;
			const height = `${document.getElementById('main-body').clientHeight}px`;
			document.querySelectorAll('.overlay').forEach(e => e.style.height = height);
		});
	}

	/* initialize the last name from the cookies */
	if (_state.params.cookie.name != '') {
		let lastName = document.cookie.split('; ').find((v) => v.startsWith(`${_state.params.cookie.name}=`))?.split('=')[1];
		if (lastName != null)
			document.getElementById('name').value = lastName;
	}

	/* initialize the caption */
	let game = new URLSearchParams(document.location.search).get('game');
	if (game != null) {
		_state.game = game;
		document.getElementById('caption').innerText = `Crossword: ${_state.game}`;
	}
	else
		document.getElementById('caption').innerText = 'Unknown Crossword!';

	/* setup the socket and register all corresponding callbacks */
	_state.sock = new SyncSocket(`${_state.params.sockets}/${_state.game}`);
	_state.sock.onfailed = (msg) => PushNotification(msg, true, () => _state.sock.retry());
	_state.sock.onreceived = (data) => _state.handleData(data);
	_state.sock.onconnected = () => _state.handleConnected();

	/* setup the viewport */
	const content = document.getElementById('content');
	_state.view = new GridView(document.getElementById('container'), content);

	/* setup the focus-host */
	_state.focus = new GridFocus(_state.view, function () {
		RenderGrid(_state.grid, _state.getAuthorHue);
		_state.pushDirty(true);
	}, function (horizontal) {
		document.getElementById(horizontal ? 'horizontal' : 'vertical').classList.add('toggled');
		document.getElementById(horizontal ? 'vertical' : 'horizontal').classList.remove('toggled');
	}, function (certain) {
		if (certain)
			document.getElementById('guess').classList.remove('toggled');
		else
			document.getElementById('guess').classList.add('toggled');
	});
	_state.focus.setDirtyStamp(_state.ackStamp);

	/* add the toggle callbacks for horizontal/vertical and guess */
	document.getElementById('horizontal').onmousedown = function (e) {
		e.preventDefault();
		_state.focus.config(true, null, null);
	};
	document.getElementById('vertical').onmousedown = function (e) {
		e.preventDefault();
		_state.focus.config(false, null, null);
	};
	document.getElementById('guess').onmousedown = function (e) {
		e.preventDefault();
		_state.focus.config(null, !_state.focus.isCertain(), null);
	};

	/* initialize the ui-state based on the focus-object */
	document.getElementById(_state.focus.isHorizontal() ? 'horizontal' : 'vertical').classList.add('toggled');
	if (!_state.focus.isCertain())
		document.getElementById('guess').classList.add('toggled');

	/* check if the player is not allowed to edit the game */
	if (!_state.params.edit)
		_state.enter(true);

	/* focus the name element and register the enter-to-enter listener */
	else {
		const name = document.getElementById('name');
		name.onkeydown = function (e) {
			if (e.key == 'Enter')
				_state.enter(false);
		};
		name.focus();
	}
}

_state.enter = function (passive) {
	if (_state.configured)
		return;

	/* validate the name */
	if (!passive) {
		const name = document.getElementById('name').value.trim();
		document.getElementById('name').value = name;
		if (name.length == 0) {
			document.getElementById('error').innerText = 'Name cannot be empty';
			document.getElementById('error').classList.add('show');
			return;
		}

		/* update the name and write it to the cookie */
		_state.name = name;
		if (_state.params.cookie.name != '' && _state.params.cookie.lifetime > 0)
			document.cookie = `${_state.params.cookie.name}=${_state.name}; expires=${new Date(Date.now() + _state.params.cookie.lifetime).toUTCString()};`;

		/* notify the socket about the available name */
		if (_state.sock.connected())
			_state.sock.send((send) => send({ cmd: 'name', name: _state.name }));

		/* update the focus to use the proper name */
		_state.focus.config(null, null, _state.name);
	}
	_state.configured = true;
	document.getElementById('fetch-name').classList.remove('show');

	/* check if the guess button can be added */
	if (!passive)
		document.getElementById('guess').classList.remove('hidden');

	/* register convenience handler (first after setting the name to prevent the input from being consumed) */
	document.body.onkeydown = function (e) {
		if (e.key != ' ' && e.key != 'Tab' && e.key != 'Shift')
			return;
		e.stopPropagation();
		e.preventDefault();
		if (e.key == 'Shift')
			_state.focus.config(null, false, null);
		else
			_state.focus.config(!_state.focus.isHorizontal(), null, null);
	};
	document.body.onkeyup = function (e) {
		if (e.key == 'Shift') {
			e.stopPropagation();
			e.preventDefault();
			_state.focus.config(null, true, null);
		}
	};
}

_state.nextColor = function () {
	let hue = 0;

	/* check if this is the first or second color */
	if (_state.usedsHues.length == 0)
		hue = Math.random() * 360;
	else if (_state.usedsHues.length == 1)
		hue = _state.usedsHues[0] + 180;

	/* find the largest distance between two hues and use its center as next color */
	else {
		let start = _state.usedsHues[0], end = _state.usedsHues[1];

		/* find the largest distance in the used hues */
		for (let i = 1; i < _state.usedsHues.length; ++i) {
			let tStart = _state.usedsHues[i], tEnd = (i + 1 >= _state.usedsHues.length ? _state.usedsHues[0] + 360 : _state.usedsHues[i + 1]);
			if (tEnd - tStart > end - start) {
				start = tStart;
				end = tEnd;
			}
		}
		hue = (start + end) / 2;
	}

	/* sanitize the color */
	hue = Math.floor(hue);
	if (hue >= 360)
		hue -= 360;

	/* add the hue to the list of used hues and return the actual hsl-color */
	_state.usedsHues.push(hue);
	_state.usedsHues.sort((a, b) => a - b);
	return hue;
}
_state.getAuthorHue = function (name) {
	if (name in _state.players)
		return _state.players[name].hue;
	return 0;
}
_state.updatePlayers = function () {
	const html = document.getElementById('players');

	/* update all of the players */
	let players = Object.keys(_state.players).sort();
	for (let i = 0; i < players.length; ++i) {
		const name = players[i];
		let div = null;

		/* fetch the next child div */
		if (i >= html.children.length) {
			div = document.createElement('div');
			div.classList.add('player');
			html.appendChild(div);
		}
		else
			div = html.children[i];

		/* update the name, color, and online status */
		if (_state.players[name].online)
			div.classList.add('online');
		else
			div.classList.remove('online');
		div.innerText = name;
		div.style.backgroundColor = `hsl(${_state.players[name].hue}, 75%, 75%)`;
	}

	/* remove the remaining children */
	while (html.children.length > players.length)
		html.lastChild.remove();
}
_state.updateGrid = function (data) {
	const content = document.getElementById('content');
	let loaded = false;

	_state.dirty = false;
	if (!data.delta) {
		/* check if the grid should be unloaded */
		if (_state.grid != null && (_state.grid.width != data.width || _state.grid.height != data.height)) {
			_state.grid = null;
			while (content.children.length > 0)
				content.lastChild.remove();
		}

		/* check if the initial grid is being shown */
		if (_state.grid == null) {
			_state.grid = LoadGrid(data, content, _state.focus, _state.getAuthorHue);
			loaded = true;
		}
	}

	/* ignore invalid measurements for deltas */
	else if (_state.grid == null || _state.grid.width != data.width || _state.grid.height != data.height)
		return;

	/* update the grid data (and check if it still consideres the game dirty) */
	if (!loaded && ApplyGridUpdate(_state.grid, data, _state.getAuthorHue, data.delta))
		_state.pushDirty(true);

	/* update the view and focus */
	_state.view.update(_state.grid);
	_state.focus.update(_state.grid);
}

_state.handleData = function (data) {
	/* check if invalid data have been received */
	if (data === 'unknown-game') {
		_state.sock.error(`Game [${_state.game}] not known by the server!`);
		return;
	}
	else if (data === 'corrupted-game') {
		_state.sock.error(`Game [${_state.game}] is corrupted on server!`);
		return;
	}
	else if (data === 'dropped-game') {
		_state.sock.error(`Game [${_state.game}] was removed from the server!`);
		return;
	}
	else if (data === 'shutdown') {
		_state.sock.error(`Game is being shut down!`);
		return;
	}

	/* check if its an ack and mark the given cells as processed */
	if (typeof data.ack == 'number') {
		ApplyGridAck(_state.grid, data.ack);
		return;
	}

	/* check if the server has failed (only notify once per failure) */
	if (!data.failed)
		_state.failedNotified = false;
	else if (!_state.failedNotified) {
		_state.failedNotified = true;
		PushNotification('Server encountered an issue saving the game!', true, null);
	}

	/* mark all players as offline until the online re-enables them */
	for (const key in _state.players)
		_state.players[key].online = false;

	/* update the player data */
	for (const name of data.online) {
		if (!(name in _state.players))
			_state.players[name] = { hue: _state.nextColor(), online: false };
		_state.players[name].online = true;
	}
	for (const cell of data.grid) {
		if (cell.author != '' && !(cell.author in _state.players))
			_state.players[cell.author] = { hue: _state.nextColor(), online: false };
	}
	_state.updatePlayers();

	/* update the grid */
	_state.updateGrid(data);
}
_state.handleConnected = function () {
	if (_state.name != '')
		_state.sock.send((send) => send({ cmd: 'name', name: _state.name }));
	_state.pushDirty(false);
}
_state.pushDirty = function (dirty) {
	if (dirty)
		_state.dirty = true;
	else if (!_state.dirty)
		return;

	/* check if the grid can be sent */
	if (_state.grid == null)
		return;

	/* build the delta-state to be sent and advance the ack stamp */
	const id = _state.ackStamp, data = DeltaSerializeGrid(_state.grid);
	_state.focus.setDirtyStamp(++_state.ackStamp);

	/* send the data to the server */
	_state.sock.send((send) => send({ cmd: 'update', data, id }));
}