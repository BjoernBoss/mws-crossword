/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libInterface from "core/interface.js";
import * as libClient from "core/client.js";
import * as libRequest from "core/request.js";
import * as libLog from "core/log.js";
import * as libLocation from "core/location.js";
import * as libBuilder from "core/builder.js";
import * as libCache from "core/cache.js";
import * as libFs from "fs/promises";

const logger = libLog.Logger('crossword');

const NAME_REGEX = /^[a-zA-Z0-9]([-_.]?[a-zA-Z0-9])*$/;
const NAME_MAX_LENGTH = 256;
const GRID_DIMENSIONS = { min: 1, max: 64 };
const MAX_FILE_SIZE = 100_000;
const WRITE_BACK_DELAY_MS = 60_000;

interface GridCell {
	solid: boolean;
	char: string;
	certain: boolean;
	author: string;
	time: number;
}
interface GameBoard {
	width: number;
	height: number;
	grid: GridCell[];
}
interface GameState extends GameBoard {
	failed: boolean;
	names: string[];
	online: string[];
}
enum GameLoadState {
	valid,
	doesNotExist,
	corrupted
}

function ParseAndValidateCells(grid: unknown, size: number, shallowGrid: boolean, refCells: GridCell[] | null): [GridCell[], boolean] {
	/* validate the root grid format */
	if (!Array.isArray(grid) || grid.length != size)
		throw new Error('Malformed Grid');
	let out: GridCell[] = [], dirty: boolean = false;

	/* validate the separate cells */
	for (let i = 0; i < grid.length; ++i) {
		const cell = grid[i];
		const ref: GridCell | null = (refCells == null ? null : refCells[i]);

		/* check if its a shallow (solid-only) cell */
		if (shallowGrid) {
			if (typeof cell != 'boolean')
				throw new Error('Malformed Grid');
			out.push({ solid: cell, char: '', certain: false, author: '', time: 0 });
			continue;
		}

		/* validate the data-types */
		if (typeof cell.char != 'string' || typeof cell.certain != 'boolean' || typeof cell.author != 'string' || typeof cell.time != 'number')
			throw new Error('Malformed Grid');
		if (ref == null && typeof cell.solid != 'boolean')
			throw new Error('Malformed Grid');

		/* check if the grid is not newer than the current grid */
		if (ref != null && cell.time <= ref.time) {
			out.push(ref);
			continue;
		}

		/* setup the sanitized data */
		let char: string = cell.char.slice(0, 1).toUpperCase();
		let author: string = cell.author.slice(0, NAME_MAX_LENGTH);
		let certain: boolean = cell.certain;
		if (ref == null ? cell.solid : ref.solid)
			char = '', author = '', certain = false;
		else if (char == '' || char < 'A' || char > 'Z')
			char = '', author = '', certain = false;
		else if (ref != null && char == ref.char)
			author = ref.author;

		/* check if the data actually have changed */
		if (ref != null && char == ref.char && certain == ref.certain && author == ref.author) {
			out.push(ref);
			continue;
		}

		/* push the new updated cell */
		out.push({ solid: (ref == null ? cell.solid : ref.solid), char: char, certain: certain, author: author, time: cell.time });
		dirty = true;
	}
	return [out, dirty];
}
function ParseAndValidateGameBoard(data: string, shallowGrid: boolean): GameBoard {
	/* parse the json content */
	let obj = null;
	try { obj = JSON.parse(data); }
	catch (_) {
		throw new Error('Malformed JSON encountered');
	}

	/* validate the overall structure */
	if (typeof obj != 'object' || obj == null)
		throw new Error('Malformed object');
	const width = obj.width, height = obj.height;
	if (typeof width != 'number' || typeof height != 'number'
		|| !isFinite(width) || width < GRID_DIMENSIONS.min || width > GRID_DIMENSIONS.max
		|| !isFinite(height) || height < GRID_DIMENSIONS.min || height > GRID_DIMENSIONS.max)
		throw new Error('Malformed Dimensions');

	/* validate and parse the list of cells and return the game structure */
	const [cells, _] = ParseAndValidateCells(obj.grid, width * height, shallowGrid, null);
	return { width, height, grid: cells };
}

class ActiveGame {
	private ws: Map<libClient.ClientSocket, string>;
	private data: GameBoard | null;
	private filePath: string;
	private loading: Promise<GameLoadState>;
	private write: { timer: NodeJS.Timeout | null, active: Promise<void> | null, dirty: boolean, failed: boolean, retention: boolean };
	private dropSelf: (self: ActiveGame) => void;

	constructor(filePath: string, dropSelf: (self: ActiveGame) => void) {
		this.ws = new Map<libClient.ClientSocket, string>();
		this.data = null;
		this.filePath = filePath;
		this.loading = this.loadGameState();
		this.write = { timer: null, active: null, dirty: false, failed: false, retention: false };
		this.dropSelf = dropSelf;
	}

	private async loadGameState(): Promise<GameLoadState> {
		let data: string = '';

		/* try to read the game state */
		try {
			logger.log(`Loading game [${this.filePath}]...`);
			data = await libFs.readFile(this.filePath, { encoding: 'utf-8' });
		}
		catch (err: any) {
			if (err.code === 'ENOENT') {
				logger.error(`Game [${this.filePath}] does not exist: ${err.message}`);
				return GameLoadState.doesNotExist;
			}
			logger.error(`Failed to read the game [${this.filePath}] state: ${err.message}`);
			return GameLoadState.corrupted;
		}

		/* parse and validate the game state */
		try {
			this.data = ParseAndValidateGameBoard(data, false);
			return GameLoadState.valid;
		}
		catch (err: any) {
			logger.error(`Corrupted game state found [${this.filePath}]: ${err.message}`);
			return GameLoadState.corrupted;
		}
	}
	private buildOutput(): GameState {
		if (this.data == null)
			return { failed: true, grid: [], width: 0, height: 0, names: [], online: [] };
		let out: GameState = {
			failed: this.write.failed,
			grid: this.data.grid,
			width: this.data.width,
			height: this.data.height,
			names: [],
			online: []
		};

		/* collect the online names */
		let online: Set<string> = new Set<string>();
		let names: Set<string> = new Set<string>();
		for (const child of this.ws) {
			const name = child[1];
			if (name == '') continue;

			/* add the name to the list of objects */
			if (!online.has(name)) {
				online.add(name);
				out.online.push(name);
			}
			if (!names.has(name)) {
				names.add(name);
				out.names.push(name);
			}
		}

		/* collect all already used names in the grid */
		for (let i = 0; i < this.data.grid.length; ++i) {
			if (names.has(this.data.grid[i].author) || this.data.grid[i].author == '') continue;
			names.add(this.data.grid[i].author);
			out.names.push(this.data.grid[i].author);
		}
		return out;
	}
	private notifyAll(): void {
		const json = JSON.stringify(this.buildOutput());

		/* send the data to all clients */
		for (const child of this.ws)
			child[0].send(json);
	}
	private unloadGame(): void {
		/* check the game should be unloaded */
		if (this.write.retention) {
			if (this.write.failed)
				logger.warning(`Game state is lost as write-back to [${this.filePath}] failed`);
			logger.log(`Unloading game [${this.filePath}]...`);
			return this.dropSelf(this);
		}
		this.write.retention = true;

		/* check if the last write-back failed, in which case the retention will be passed via
		*	another write-back, and otherwise it will be directly piped through this unload */
		if (this.write.failed)
			this.write.timer = setTimeout(() => this.performWriteBack(), WRITE_BACK_DELAY_MS);
		else
			this.write.timer = setTimeout(() => this.unloadGame(), WRITE_BACK_DELAY_MS);
	}
	private async performWriteBack(): Promise<void> {
		/* cache the current state to be serialized and mark the write-back as being processed */
		const currentState: string = JSON.stringify(this.data);
		this.write.active = new Promise(async (resolve) => {
			/* try to write the data back via a temporary file */
			if (await libLocation.AtomicWrite(this.filePath, currentState, 'crossword', logger))
				this.write.failed = false;
			else if (!this.write.failed) {
				this.write.failed = true;
				this.notifyAll();
			}

			/* mark the write-back as not active anymore */
			resolve();
			this.write.active = null;

			/* check if another write-back is queued and start it up again */
			if (this.write.dirty) {
				this.write.dirty = false;
				return this.queueWriteBack(true);
			}

			/* check if this was a write-back without any connected clients, in which case the game can
			*	be unloaded, and otherwise queue another write-back, if the current one has failed */
			if (this.ws.size == 0)
				return this.unloadGame();
			else if (this.write.failed)
				this.queueWriteBack(true);
		});
	}
	private queueWriteBack(dirty: boolean): void {
		/* check if the game can just be dropped */
		if (this.data == null) {
			if (this.ws.size == 0)
				this.dropSelf(this);
			return;
		}

		/* check if a writeback is currently being performed and queue another to be performed */
		if (this.write.active) {
			if (dirty)
				this.write.dirty = true;
			return;
		}

		/* kill the last writeback timer, as the function will either be executed now, or the timeout reset */
		dirty = (this.write.timer != null || dirty);
		if (this.write.timer != null) {
			clearTimeout(this.write.timer);
			this.write.timer = null;
		}

		/* queue the next write-out or perform it right now (if no clients are registered) */
		if (dirty) {
			if (this.ws.size > 0)
				this.write.timer = setTimeout(() => this.performWriteBack(), WRITE_BACK_DELAY_MS);
			else
				this.performWriteBack();
		}
		else if (this.ws.size == 0)
			this.unloadGame();
	}

	public waitOnGame(): Promise<GameLoadState> {
		return this.loading;
	}
	public updateGrid(client: libClient.ClientSocket, grid: any): void {
		/* ensure that a grid exists */
		if (this.data == null) {
			client.warning(`Discarding grid update for corrupted load [${this.filePath}]`);
			this.notifySingle(client);
			return;
		}

		/* ensure that the player has a name */
		if (this.ws.get(client)!.length == 0) {
			client.warning(`Discarding grid update of unnamed player [${this.filePath}]`);
			this.notifySingle(client);
			return;
		}

		let merged: GridCell[] | null = null, dirty: boolean = false;
		try {
			[merged, dirty] = ParseAndValidateCells(grid, this.data.grid.length, false, this.data.grid);
		}
		catch (_) {
			client.error(`Discarding invalid grid update [${this.filePath}]`);
			this.notifySingle(client);
			return;
		}

		/* check if the data are not dirty */
		if (!dirty) {
			client.trace(`Discarding empty grid update of [${this.filePath}]`);
			this.notifySingle(client);
			return;
		}

		/* update the grid and notify the listeners about the change */
		this.data.grid = merged;
		this.notifyAll();
		this.queueWriteBack(true);
	}
	public updateName(ws: libClient.ClientSocket, name: string): void {
		name = name.slice(0, NAME_MAX_LENGTH);
		if (this.ws.get(ws) == name) return;

		/* update the name and notify the other sockets */
		this.ws.set(ws, name);
		this.notifyAll();
	}
	public drop(ws: libClient.ClientSocket): void {
		/* remove the web-socket from the open connections */
		let name = this.ws.get(ws)!;
		this.ws.delete(ws);

		/* check if this was the last listener and the object can be unloaded */
		if (this.ws.size == 0)
			this.queueWriteBack(false);

		/* check if other listeners should be notified */
		else if (name.length > 0)
			this.notifyAll();
	}
	public register(ws: libClient.ClientSocket): void {
		this.ws.set(ws, '');

		/* reset the retention, as at least one connect has been established again */
		if (this.write.retention && this.write.timer != null) {
			this.write.retention = false;
			if (!this.write.failed) {
				clearTimeout(this.write.timer);
				this.write.timer = null;
			}
		}
	}
	public notifySingle(ws: libClient.ClientSocket): void {
		ws.send(JSON.stringify(this.buildOutput()));
	}
	public async dropGame(): Promise<void> {
		/* remove all the data to prevent future write-backs and kill any timers */
		this.data = null;
		if (this.write.timer != null)
			clearTimeout(this.write.timer);
		this.write.timer = null;

		/* disconnect all of the clients */
		const content: string = JSON.stringify('dropped-game');
		for (const child of this.ws) {
			child[0].send(content);
			child[0].close();
		}
		this.ws.clear();

		/* check if a writeback is currently performed and otherwise unregister the game */
		if (this.write.active != null)
			await this.write.active;
		this.dropSelf(this);
	}
}

export class Crossword implements libInterface.ModuleInterface {
	private fileStatic: (path: string) => string;
	private fileGames: (path: string) => string;
	private gameStates: Record<string, ActiveGame>;

	public name: string = 'crossword';
	constructor(dataPath: string) {
		this.fileStatic = libLocation.MakeSelfPath(import.meta.url, '/static');
		this.fileGames = libLocation.MakeLocation(dataPath);
		this.gameStates = {};
	}

	private async modifyGame(client: libClient.HttpRequest): Promise<void> {
		/* validate the method */
		const method = client.ensureMethod(['POST', 'DELETE']);
		if (method == null)
			return;

		/* extract the name (respond with 404 on error, as this is a totally owned endpoint) */
		let name = client.path.slice(6);
		if (!name.match(NAME_REGEX) || name.length > NAME_MAX_LENGTH) {
			client.respondNotFound();
			return;
		}
		client.trace(`Handling Game: [${name}] with [${method}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game is being removed */
		if (method == 'DELETE') {
			/* disconnect any active players */
			if (name in this.gameStates)
				await this.gameStates[name].dropGame();

			/* remove the game file itself */
			try {
				await libFs.unlink(filePath);
				logger.log(`Game file [${filePath}] deleted successfully`);
				client.respondOk('delete');
			}

			/* check if the removal failed and log it accordingly */
			catch (err: any) {
				logger.error(`Error while removing file [${filePath}]: ${err.message}`);
				if (err.code === 'ENOENT')
					client.respondNotFound();
				else
					client.respondFileSystemError();
			}
			return;
		}

		/* validate the content type */
		if (client.ensureMediaType([libRequest.Media.Json]) == null)
			return;

		/* collect all of the data (failure will automatically be responded to by the receive function) */
		let text: string = '';
		try {
			text = await client.receiveAllText(client.getMediaTypeCharset('utf-8'), MAX_FILE_SIZE);
		}
		catch (err: any) {
			client.error(`Error occurred while posting to [${filePath}]: ${err.message}`);
			return;
		}

		/* parse and validate the data */
		let parsed: GameBoard | null = null;
		try {
			parsed = ParseAndValidateGameBoard(text, true);
		} catch (err: any) {
			client.error(`Error while parsing the game: ${err.message}`);
			client.respondBadRequest(err.message);
			return;
		}

		/* serialize the data to the file and write it out */
		try {
			await libFs.writeFile(filePath, JSON.stringify(parsed), { encoding: 'utf-8', flag: 'wx' });
			client.respondOk('upload');
		}

		/* check why the creating failed and log it accordingly */
		catch (err: any) {
			logger.error(`Error while writing the game [${filePath}] out: ${err.message}`);
			if (err.code === 'EEXIST')
				client.respondConflict('already exists');
			else
				client.respondFileSystemError();
		}
	}
	private async queryGames(client: libClient.HttpRequest): Promise<void> {
		let content: string[] = [];
		try {
			content = await libFs.readdir(this.fileGames('.'));
		}
		catch (err: any) {
			logger.error(`Error while reading directory content: ${err.message}`);
			client.respondFileSystemError();
			return;
		}
		let out = [];

		/* collect them all out */
		logger.trace(`Querying list of all registered games: [${content}]`);
		for (const name of content) {
			if (!name.endsWith('.json'))
				continue;
			const actual = name.slice(0, name.length - 5);
			if (!actual.match(NAME_REGEX) || actual.length > NAME_MAX_LENGTH)
				continue;
			out.push(actual);
		}

		/* return them to the request */
		client.respond(JSON.stringify(out), { media: libRequest.Media.Json });
	}
	private async acceptWebSocket(client: libClient.ClientSocket, name: string): Promise<void> {
		client.trace(`Handling WebSocket to: [${name}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game-state for the given name has already been set-up */
		if (!(name in this.gameStates)) {
			this.gameStates[name] = new ActiveGame(filePath, (game) => {
				if (this.gameStates[name] === game)
					delete this.gameStates[name];
			});
		}
		const game = this.gameStates[name];

		/* register the client to the game to prevent it from being removed
		*	(shift the game-name onto the log, but never unshift it again) */
		game.register(client);
		client.shiftLog(name);
		client.log('Registered websocket to game');

		/* wait for the game data to load and check if the file was found */
		const loadState: GameLoadState = await game.waitOnGame();
		if (loadState != GameLoadState.valid) {
			/* drop the client again from the game and notify it about the state */
			game.drop(client);
			client.send(JSON.stringify(loadState == GameLoadState.doesNotExist ? 'unknown-game' : 'corrupted-game'));
			client.close();
			return;
		}

		/* register the web-socket callbacks */
		client.onclose = async () => {
			game.drop(client);
			client.log(`Socket disconnected`);
		};
		client.ondata = (data) => {
			try {
				const parsed: any = JSON.parse(data.toString('utf-8'));
				client.trace(`Received for socket: ${parsed.cmd}`);

				/* dispatch the client request accordingly */
				if (parsed.cmd == 'name' && typeof parsed.name == 'string')
					game.updateName(client, parsed.name);
				else if (parsed.cmd == 'update')
					game.updateGrid(client, parsed.data);
			} catch (err: any) {
				client.error(`Failed to parse web-socket response: ${err.message}`);
				client.close();
			}
		};

		/* send the initial state to the socket */
		game.notifySingle(client);
	}
	private async fetchBody(client: libClient.HttpRequest, path: string): Promise<string | null> {
		const fullPath = this.fileStatic(path);

		/* look for the file (will never be an immutable path; consider it stable) */
		const cached: libCache.Cached | null = libCache.GetCached(fullPath, true);
		if (cached == null) {
			client.error(`Failed to find content [${fullPath}]`);
			client.respondFileSystemError();
			return null;
		}

		/* read the file */
		try {
			return (await cached.readAsync()).toString('utf-8');
		}
		catch (err: any) {
			client.error(`Failed to read content [${fullPath}]: ${err.message}`);
			client.respondFileSystemError();
			return null;
		}
	}
	private async buildMainPage(client: libClient.HttpRequest): Promise<void> {
		const toPath = (path: string) => libCache.Immutable(client.makePath(path));
		const b = libBuilder;

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/main.html');
		if (body == null)
			return;

		/* add the required page headers and load the content from cache */
		const page = new libBuilder.HtmlPage('en', [
			b.Meta('viewport', 'width=device-width, initial-scale=1'),
			b.Title('Crosswords!'),
			b.LoadStyle(toPath('/style.css')),
			b.LoadScript(toPath('/notifier.js'))
		], [
			b.AddScript(`GAMES_RESOURCE="${client.makePath('/games')}"`),
			b.Embed(body, true)
		]);
		client.respondHtml(page, { status: libRequest.Status.Ok });
	}
	private async buildPlayPage(client: libClient.HttpRequest): Promise<void> {
		const toPath = (path: string) => libCache.Immutable(client.makePath(path));
		const b = libBuilder;

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/play.html');
		if (body == null)
			return;

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		const page = new libBuilder.HtmlPage('en', [
			b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'),
			b.Title('Play Crossword!'),
			b.LoadStyle(toPath('/style.css')),
			b.LoadScript(toPath('/notifier.js')),
			b.LoadScript(toPath('/sync-socket.js')),
			b.LoadScript(toPath('/grid.js'))
		], b.Embed(body, true));
		client.respondHtml(page, { status: libRequest.Status.Ok });
	}
	private async buildEditorPage(client: libClient.HttpRequest): Promise<void> {
		const toPath = (path: string) => libCache.Immutable(client.makePath(path));
		const b = libBuilder;

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/editor.html');
		if (body == null)
			return;

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		const page = new libBuilder.HtmlPage('en', [
			b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'),
			b.Title('Crossword Editor'),
			b.LoadStyle(toPath('/style.css')),
			b.LoadScript(toPath('/grid.js'))
		], b.Embed(body, true));
		client.respondHtml(page, { status: libRequest.Status.Ok });
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		client.trace(`Game handler for [${client.path}]`);

		/* check if a game is being manipulated */
		if (client.path.startsWith('/game/'))
			return this.modifyGame(client);

		/* all other endpoints only support 'getting' */
		if (client.ensureMethod(['GET']) == null)
			return;

		/* check if its a redirection and forward it accordingly */
		if (client.path == '/main' || client.path == '/main.html')
			return client.respondTemporaryRedirect(client.makePath('/'));
		if (client.path == '/editor')
			return client.respondTemporaryRedirect(client.makePath('/editor.html'));
		if (client.path == '/play')
			return client.respondTemporaryRedirect(client.makePath('/play.html'));

		/* check if the games are queried */
		if (client.path == '/games')
			return this.queryGames(client);

		/* check if its one of the html endpoints and build them (discard any other requests) */
		if (client.path == '/')
			return this.buildMainPage(client);
		if (client.path == '/play.html')
			return this.buildPlayPage(client);
		if (client.path == '/editor.html')
			return this.buildEditorPage(client);
		if (client.path.toLowerCase().endsWith('.html'))
			return;

		/* respond to the request by trying to serve the file (all files are considered stable) */
		await client.tryRespondFile(this.fileStatic(client.path), true);
	}
	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		client.trace(`Game handler for [${client.path}]`);

		/* check if a web-socket is connecting */
		if (!client.path.startsWith('/ws/'))
			return;

		/* extract the name and validate it (return with not-found as the entire endpoint is owned) */
		let name = client.path.slice(4);
		if (name.match(NAME_REGEX) && name.length <= NAME_MAX_LENGTH) {
			if (client.tryAcceptWebSocket((ws) => this.acceptWebSocket(ws, name)))
				return;
			client.respondBadRequest('Endpoint is designed for web-sockets');
		}
		else
			client.respondNotFound();
		client.log(`Invalid request for web-socket point for game [${name}]`);
	}
}
