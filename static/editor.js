/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
const GAME_NAME_REGEX = /^[a-zA-Z0-9]([-_. ]?[a-zA-Z0-9])*$/;
const GAME_NAME_MAX_LENGTH = 64;

let _state = { dirty: false, uploading: false, params: {} };

window.onbeforeunload = function () { if (!_state.dirty) return null; return "Your work will be lost."; };

window.onload = function () {
	_state.params.lobby = __LOAD_PARAMS__?.lobby ?? '/bad_path';
	_state.params.game = __LOAD_PARAMS__?.game ?? '/bad_path';

	/* ensure phones handle the visibility of the keyboard properly */
	if (window.visualViewport) {
		window.visualViewport.addEventListener("resize", function () {
			document.body.style.height = `${window.visualViewport.height}px`;
			const height = `${document.getElementById('main-body').clientHeight}px`;
			document.querySelectorAll('.overlay').forEach(e => e.style.height = height);
		});
	}
}

_state.setup = function () {
	/* validate the dimension */
	const width = parseInt(document.getElementById('width').value);
	const height = parseInt(document.getElementById('height').value);
	if (!isFinite(width) || !isFinite(height) || width < 1 || width > 64 || height < 1 || height > 64) {
		alert("Invalid dimensions specified");
		return;
	}

	/* lock the input page */
	document.getElementById('dimensions').classList.remove('show');

	/* setup the editor caption */
	document.getElementById('caption').innerText = `Creating a Crossword of Size: [${width} \u00d7 ${height}]`;

	/* create the grid object and show it */
	const content = document.getElementById('content');
	_state.grid = GenerateGrid(width, height, content, null, () => 0);

	/* setup the viewport */
	_state.view = new GridView(document.getElementById('container'), content);
	_state.view.update(_state.grid);

	/* register the event listeners for updating the grid (by left-click/single touch) */
	_state.updating = null;
	content.addEventListener('mousedown', function (e) {
		if (e.button == 0 && _state.startToggle(e.clientX, e.clientY)) {
			e.preventDefault();
			e.stopPropagation();
		}
	});
	content.addEventListener('mousemove', function (e) {
		if ((e.buttons & 0x01) != 0x01)
			_state.stopToggle();
		else
			_state.moveToggle(e.clientX, e.clientY);
	});
	content.addEventListener('mouseup', function (e) {
		if (e.button != 0) return;
		_state.stopToggle();
		e.preventDefault();
		e.stopPropagation();
	});
	content.addEventListener('touchstart', function (e) {
		if (e.touches.length != 1) _state.stopToggle();
		else if (_state.startToggle(e.touches[0].clientX, e.touches[0].clientY)) {
			e.preventDefault();
			e.stopPropagation();
		}
	});
	content.addEventListener('touchmove', function (e) {
		if (e.touches.length != 1)
			_state.stopToggle();
		else
			_state.moveToggle(e.touches[0].clientX, e.touches[0].clientY);
	});
	content.addEventListener('touchend', function (e) {
		_state.stopToggle();
		e.preventDefault();
		e.stopPropagation();
	});

	/* register handle to cancel dialogs */
	window.addEventListener('keydown', function (e) {
		if (e.key === 'Escape')
			_state.cancel();
	});
}
_state.finish = function () {
	document.getElementById("finalize").classList.add('show');
	document.getElementById('error').classList.remove('show');
}
_state.upload = function () {
	let name = document.getElementById('name').value;

	/* check if an upload is active */
	if (_state.uploading) {
		document.getElementById('error').innerText = 'Uploading...';
		document.getElementById('error').classList.add('show');
		return;
	}

	/* validate the name */
	if (!name.match(GAME_NAME_REGEX) || name.length > GAME_NAME_MAX_LENGTH) {
		document.getElementById('error').innerText = `Name must start/end with alphanumerical characters and may\nonly contain [._- ] (between 1...${GAME_NAME_MAX_LENGTH})`;
		document.getElementById('error').classList.add('show');
		return;
	}

	/* serialize the grid */
	let out = SolidSerializeAll(_state.grid);
	document.getElementById('error').classList.remove('show');

	/* post the result out */
	_state.uploading = true;
	fetch(`${_state.params.game}/${name}`, { method: 'POST', body: JSON.stringify(out), headers: { "Content-Type": 'application/json' } })
		.then(function (resp) {
			/* redirect to the main page */
			if (!resp.ok)
				throw new Error(resp.statusText);

			document.getElementById("finalize").classList.remove('show');
			_state.dirty = false;
			_state.uploading = false;

			document.location = `${_state.params.lobby}?uploaded=${name}`;
		}).catch(function (e) {
			/* post the error */
			document.getElementById('error').classList.add('show');
			document.getElementById('error').innerText = `Error while uploading the edited crossword: ${e.message}`;
			_state.uploading = false;
		});
}
_state.cancel = function () {
	document.getElementById('name').value = '';
	document.getElementById("finalize").classList.remove('show');
}

_state.startToggle = function (clientX, clientY) {
	/* check if a valid cell has been hit */
	let [x, y] = _state.view.index(clientX, clientY);
	if (x == null || y == null) return false;

	/* setup the operation */
	_state.updating = !_state.grid.mesh[x][y].solid;
	_state.dirty = true;
	_state.toggleSolid(x, y);
	return true;
}
_state.moveToggle = function (clientX, clientY) {
	if (_state.updating == null) return;
	let [x, y] = _state.view.index(clientX, clientY);
	_state.toggleSolid(x, y);
}
_state.stopToggle = function () {
	_state.updating = null;
}
_state.toggleSolid = function (x, y) {
	/* check if the operation is over */
	if (_state.updating == null) return;
	if (x == null || y == null) {
		_state.updating = null;
		return;
	}

	/* check if the value should be updated */
	if (_state.grid.mesh[x][y].solid != _state.updating) {
		_state.grid.mesh[x][y].solid = _state.updating;
		RenderGrid(_state.grid, () => 0);
	}
}
