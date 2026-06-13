/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libFs from "fs/promises";

const GAME_NAME_REGEX = /^[a-zA-Z0-9]([-_. ]?[a-zA-Z0-9])*$/;
const GAME_NAME_MAX_LENGTH = 64;
const PLAYER_NAME_MAX_LENGTH = 256;
const GRID_DIMENSIONS = { min: 1, max: 64 };
const MAX_FILE_SIZE = 100_000;
const WRITE_BACK_DELAY_MS = 60_000;
const NAME_COOKIE_NAME = 'crossword-last-name';

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
	dropped,
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
		let author: string = cell.author.trim().slice(0, PLAYER_NAME_MAX_LENGTH);
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
		|| !isFinite(width) || width < GRID_DIMENSIONS.min || width > GRID_DIMENSIONS.max || Math.floor(width) != width
		|| !isFinite(height) || height < GRID_DIMENSIONS.min || height > GRID_DIMENSIONS.max || Math.floor(height) != height)
		throw new Error('Malformed Dimensions');

	/* validate and parse the list of cells and return the game structure */
	const [cells, _] = ParseAndValidateCells(obj.grid, width * height, shallowGrid, null);
	return { width, height, grid: cells };
}

class ActiveGame {
	private logger: mws.Logger;
	private cache: mws.CacheHost;
	private ws: Map<mws.ClientSocket, string>;
	private data: GameBoard | null;
	private filePath: string;
	private loading: Promise<GameLoadState>;
	private write: { timer: NodeJS.Timeout | null, active: Promise<void> | null, dirty: boolean, failed: boolean, retention: boolean };
	private dropSelf: (self: ActiveGame) => void;
	private dropped: Promise<void> | null;

	constructor(logger: mws.Logger, cache: mws.CacheHost, filePath: string, dropSelf: (self: ActiveGame) => void) {
		this.logger = logger;
		this.cache = cache;
		this.ws = new Map<mws.ClientSocket, string>();
		this.data = null;
		this.filePath = filePath;
		this.loading = this.loadGameState();
		this.write = { timer: null, active: null, dirty: false, failed: false, retention: false };
		this.dropSelf = dropSelf;
		this.dropped = null;
	}

	private async loadGameState(): Promise<GameLoadState> {
		let data: string = '';

		/* try to read the game state */
		try {
			this.logger.log(`Loading game [${this.filePath}]...`);
			const raw = await this.cache.read(this.filePath, { checkFreshness: true });
			if (raw == null) {
				this.logger.error(`Game [${this.filePath}] does not exist`);
				return GameLoadState.doesNotExist;
			}
			data = raw.toString('utf-8');
		}
		catch (err: any) {
			this.logger.error(`Failed to read the game [${this.filePath}] state: ${err.message}`);
			return GameLoadState.corrupted;
		}

		/* parse and validate the game state */
		try {
			this.data = ParseAndValidateGameBoard(data, false);
			return GameLoadState.valid;
		}
		catch (err: any) {
			this.logger.error(`Corrupted game state found [${this.filePath}]: ${err.message}`);
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
		/* check the game should be unloaded (immediately, if its being dropped) */
		if (this.dropped != null || this.write.retention) {
			if (this.write.failed)
				this.logger.warning(`Game state is lost as write-back to [${this.filePath}] failed`);
			this.logger.log(`Unloading game [${this.filePath}]...`);
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
	private performWriteBack(): void {
		/* cache the current state to be serialized and mark the write-back as being processed */
		const currentState: string = JSON.stringify(this.data);
		this.write.active = (async () => {
			/* try to write the data back via a temporary file */
			try {
				await this.cache.write(this.filePath, currentState, { what: 'crossword' });
				this.write.failed = false;
			}
			catch (err: any) {
				this.logger.error(`Failed to write crossword [${this.filePath}]: ${err.message}`);
				if (!this.write.failed) {
					this.write.failed = true;
					this.notifyAll();
				}
			}

			/* mark the write-back as not active anymore */
			this.write.active = null;

			/* check if another write-back is queued and start it up again or check if the
			*	game can be unloaded or has failed, and should be written back again */
			if (this.write.dirty) {
				this.write.dirty = false;
				this.queueWriteBack(true);
			}
			else if (this.ws.size == 0)
				this.unloadGame();
			else if (this.write.failed)
				this.queueWriteBack(true);
		})();
	}
	private queueWriteBack(dirty: boolean): void {
		/* check if the game can just be dropped */
		if (this.data == null) {
			if (this.ws.size == 0)
				this.dropSelf(this);
			return;
		}

		/* check if a writeback is currently being performed and queue another to be performed */
		if (this.write.active != null) {
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
	public updateGrid(client: mws.ClientSocket, grid: any): void {
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
	public updateName(ws: mws.ClientSocket, name: string): void {
		name = name.trim().slice(0, PLAYER_NAME_MAX_LENGTH);
		if (this.ws.get(ws) == name) return;

		/* update the name and notify the other sockets */
		this.ws.set(ws, name);
		this.notifyAll();
	}
	public drop(ws: mws.ClientSocket): void {
		/* remove the web-socket from the open connections */
		const name = this.ws.get(ws) ?? '';
		this.ws.delete(ws);
		if (this.dropped != null)
			return;

		/* check if this was the last listener and the object can be unloaded */
		if (this.ws.size == 0)
			this.queueWriteBack(false);

		/* check if other listeners should be notified */
		else if (name != '')
			this.notifyAll();
	}
	public register(ws: mws.ClientSocket): void {
		if (this.dropped != null)
			return;
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
	public notifySingle(ws: mws.ClientSocket): void {
		ws.send(JSON.stringify(this.buildOutput()));
	}
	public async disconnectAll(reason: string): Promise<void> {
		const content: string = JSON.stringify(reason);

		/* disconnect all of the clients and wait for the disconnects to complete */
		const promises: Promise<void>[] = [];
		for (const child of this.ws) {
			child[0].send(content);
			promises.push(child[0].close());
		}
		this.ws.clear();
		await Promise.all(promises);
	}
	public async dropGame(reason: string, removed: boolean): Promise<void> {
		/* ensure the game is properly loaded and drop it */
		if (await this.loading == GameLoadState.dropped)
			return this.dropped!;
		let resolver = () => { };
		this.dropped = new Promise((res) => resolver = res);
		this.loading = Promise.resolve(GameLoadState.dropped);

		/* disconnect all of the clients and wait for the disconnects to complete */
		await this.disconnectAll(reason);

		/* check if the game is being removed, in which case any last queued
		*	timers can be killed and otherwise trigger the final write-back */
		if (removed) {
			if (this.write.timer != null)
				clearTimeout(this.write.timer);
			this.write.timer = null;
		}
		else
			this.queueWriteBack(false);

		/* wait for any final writebacks to be completed and remove the game from the active games */
		while (this.write.active != null)
			await this.write.active;
		this.dropSelf(this);

		resolver();
		return this.dropped;
	}
}
interface BurntAccess {
	create: boolean;
	delete: boolean;
	edit: boolean;
	query: boolean;
}

export interface Access {
	/* connection is allowed to create crosswords (default: false) */
	create?: boolean;

	/* connection is allowed to delete crosswords (default: false) */
	delete?: boolean;

	/* connection is allowed to edit crosswords (default: false) */
	edit?: boolean;

	/* connection is allowed to query the crosswords (default: false) */
	query?: boolean;
}
export const Endpoints = {
	static: '/static',
	list: '/',
	play: '/play',
	editor: '/editor',
	sockets: '/ws',
	games: '/games',
	game: '/game'
}

export class Crossword extends mws.ModuleHandler {
	private fileStatic: (path: string) => string;
	private filePages: (path: string) => string;
	private fileGames: (path: string) => string;
	private gameStates: Record<string, ActiveGame>;
	private defaultAccess: BurntAccess;

	constructor(dataPath: string, access?: Access) {
		super('crossword');

		this.fileStatic = mws.createPathSelf(import.meta.url, '../static');
		this.filePages = mws.createPathSelf(import.meta.url, '../pages');
		this.fileGames = mws.createPathLocation(dataPath);
		this.gameStates = {};
		this.defaultAccess = {
			create: access?.create ?? false,
			delete: access?.delete ?? false,
			edit: access?.edit ?? false,
			query: access?.query ?? false
		};
	}

	private async modifyGame(client: mws.ClientRequest, params: BurntAccess, name: string): Promise<void> {
		/* validate the method */
		const method = client.requireMethod(['POST', 'DELETE']);
		if (method == null)
			return;

		/* check if the client is allowed to create/delete */
		if (!(method == 'POST' ? params.create : params.delete))
			return client.respondForbidden(`Not allowed to ${method == 'POST' ? 'create' : 'delete'} crosswords`);

		/* extract the name (respond with 400/404 on error, as this is a totally owned endpoint) */
		if (!name.match(GAME_NAME_REGEX) || name.length > GAME_NAME_MAX_LENGTH) {
			if (method == 'DELETE')
				client.respondNotFound();
			else
				client.respondBadRequest('Malformed name');
			return;
		}
		client.trace(`Handling Game: [${name}] with [${method}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game is being removed */
		if (method == 'DELETE') {
			/* disconnect any active players */
			if (name in this.gameStates)
				await this.gameStates[name].dropGame('dropped-game', true);

			/* remove the game file itself */
			try {
				if (!await this.cache.remove(filePath)) {
					this.error(`Game file [${filePath}] does not exist`);
					client.respondNotFound();
				}

				this.log(`Game file [${filePath}] deleted successfully`);
				client.respondOk({ message: `Game [${name}] deleted successfully` });
			}

			/* check if the removal failed and log it accordingly */
			catch (err: any) {
				client.respondInternalError(`Error while removing file [${filePath}]: ${err.message}`);
			}
			return;
		}

		/* validate the content type */
		if (client.requireMediaType(mws.Media.Json) == null)
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
			if (!await this.cache.write(filePath, JSON.stringify(parsed), { what: 'crossword', create: true })) {
				this.error(`Game file [${filePath}] already exists`);
				client.respondConflict('Already exists');
			}
			client.respondCreated(client.makePath(`/play?name=${encodeURIComponent(name)}`));
		}

		/* check why the creating failed and log it accordingly */
		catch (err: any) {
			client.respondInternalError(`Error while writing the game [${filePath}]: ${err.message}`);
		}
	}
	private async queryGames(client: mws.ClientRequest, params: BurntAccess): Promise<void> {
		/* check if the client is allowed to query */
		if (!params.query)
			return client.respondForbidden('Not allowed to query crosswords');

		/* read the current list of game files */
		let content: string[] = [];
		try {
			content = await libFs.readdir(this.fileGames('.'));
		}
		catch (err: any) {
			client.respondInternalError(`Error while reading directory content: ${err.message}`);
			return;
		}
		let out = [];

		/* collect them all out */
		this.trace(`Querying list of all registered games: [${content}]`);
		for (const name of content) {
			if (!name.endsWith('.json'))
				continue;
			const actual = name.slice(0, name.length - 5);
			if (!actual.match(GAME_NAME_REGEX) || actual.length > GAME_NAME_MAX_LENGTH)
				continue;
			out.push(actual);
		}

		/* return them to the request */
		client.respond(JSON.stringify(out), { media: mws.Media.Json });
	}
	private async acceptWebSocket(client: mws.ClientSocket, name: string, params: BurntAccess): Promise<void> {
		client.trace(`Handling WebSocket to: [${name}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game-state for the given name has already been set-up */
		if (!(name in this.gameStates)) {
			this.gameStates[name] = new ActiveGame(this, this.cache, filePath, (game) => {
				if (this.gameStates[name] === game)
					delete this.gameStates[name];
			});
		}
		const game = this.gameStates[name];

		/* register the client to the game to prevent it from being removed
		*	(shift the game-name onto the log, but never unshift it again) */
		game.register(client);
		client.tagLog(name);
		client.log('Registered websocket to game');

		/* register the callbacks (only forward update commands after the game was successfully loaded) */
		let gameLoaded = false;
		client.on('close', () => {
			game.drop(client);
			client.log(`Socket disconnected`);
		});
		client.on('data', (data) => {
			try {
				const parsed: any = JSON.parse(data.toString('utf-8'));

				/* dispatch the client request accordingly */
				if (!params.edit)
					client.error(`Received not allowed command [${parsed.cmd}]`);
				else if (parsed.cmd == 'name' && typeof parsed.name == 'string') {
					client.trace(`Received for socket: ${parsed.cmd} (${parsed.name})`);
					game.updateName(client, parsed.name);
				}
				else if (parsed.cmd != 'update')
					client.warning(`Received unknown command [${parsed.cmd}]`);
				else if (gameLoaded) {
					client.trace(`Received grid update`);
					game.updateGrid(client, parsed.data);
				}
				else
					client.warning('Discarding update of not yet loaded game');
			} catch (err: any) {
				client.error(`Failed to parse web-socket response: ${err.message}`);
				client.close();
			}
		});

		/* wait for the game data to load and check if the file was found */
		const loadState: GameLoadState = await game.waitOnGame();
		if (loadState != GameLoadState.valid) {
			/* drop the client again from the game and notify it about the state */
			game.drop(client);
			if (loadState == GameLoadState.doesNotExist)
				client.send(JSON.stringify('unknown-game'));
			else if (loadState == GameLoadState.dropped)
				client.send(JSON.stringify('dropped-game'));
			else
				client.send(JSON.stringify('corrupted-game'));
			client.close();
			return;
		}

		/* send the initial state to the socket */
		gameLoaded = true;
		game.notifySingle(client);
	}
	private async fetchBody(client: mws.ClientRequest, path: string): Promise<string | null> {
		const fullPath = this.filePages(path);

		/* look for the file (will never be an immutable path; consider it stable) */
		try {
			const data: Buffer | null = await this.cache.read(fullPath);
			if (data == null) {
				client.respondInternalError(`Failed to find content [${fullPath}]`);
				return null;
			}
			return data.toString('utf-8');
		}
		catch (err: any) {
			client.respondInternalError(`Failed to read content [${fullPath}]: ${err.message}`);
			return null;
		}
	}
	private staticPath(client: mws.ClientRequest, path: string): string {
		return client.makePath(this.cache.immutable(this.name, mws.joinSanitized(Endpoints.static, path)));
	}
	private async buildMainPage(client: mws.ClientRequest, params: BurntAccess): Promise<void> {
		/* check if the client is allowed to query */
		if (!params.query)
			return client.respondForbidden('Not allowed to query crosswords');

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/main.html');
		if (body == null)
			return;

		const loadConfig: string = JSON.stringify({
			manifest: {
				create: params.create,
				delete: params.delete,
				games: client.makePath(Endpoints.games),
				editor: client.makePath(Endpoints.editor),
				play: client.makePath(Endpoints.play),
				game: client.makePath(Endpoints.game)
			}
		});

		/* add the required page headers and load the content from cache */
		const b = mws.build;
		const page = new b.HtmlPage({
			language: 'en',
			head: [
				b.Meta('viewport', 'width=device-width, initial-scale=1'),
				b.Title('Crosswords!'),
				b.LoadStyle(this.staticPath(client, '/style.css')),
				b.LoadScript(this.staticPath(client, '/notifier.js')),
				b.AddScript(`__LOAD_CONFIG__=${loadConfig}`)
			],
			body: b.Embed(body, true)
		});
		await client.respondHtml(page, { status: mws.Status.Ok });
	}
	private async buildPlayPage(client: mws.ClientRequest, params: BurntAccess): Promise<void> {
		const toPath = (base: string, path: string) => client.makePath(this.cache.immutable(this.name, mws.joinSanitized(base, path)));

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/play.html');
		if (body == null)
			return;

		const loadConfig: string = JSON.stringify({
			manifest: {
				edit: params.edit,
				cookie: NAME_COOKIE_NAME,
				sockets: client.makePath(Endpoints.sockets)
			}
		});

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		const b = mws.build;
		const page = new b.HtmlPage({
			language: 'en',
			head: [
				b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'),
				b.Title('Play Crossword!'),
				b.LoadStyle(toPath(Endpoints.static, '/style.css')),
				b.LoadScript(toPath(Endpoints.static, '/notifier.js')),
				b.LoadScript(toPath(Endpoints.static, '/sync-socket.js')),
				b.LoadScript(toPath(Endpoints.static, '/grid.js')),
				b.AddScript(`__LOAD_CONFIG__=${loadConfig}`)
			],
			body: b.Embed(body, true)
		});
		await client.respondHtml(page, { status: mws.Status.Ok });
	}
	private async buildEditorPage(client: mws.ClientRequest, params: BurntAccess): Promise<void> {
		const toPath = (base: string, path: string) => client.makePath(this.cache.immutable(this.name, mws.joinSanitized(base, path)));

		/* check if the client is allowed to edit */
		if (!params.create)
			return client.respondForbidden('Not allowed to create crosswords');

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/editor.html');
		if (body == null)
			return;

		const loadConfig: string = JSON.stringify({
			manifest: {
				list: client.makePath(Endpoints.list),
				game: client.makePath(Endpoints.game)
			}
		});

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		const b = mws.build;
		const page = new b.HtmlPage({
			language: 'en',
			head: [
				b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'),
				b.Title('Crossword Editor'),
				b.LoadStyle(toPath(Endpoints.static, '/style.css')),
				b.LoadScript(toPath(Endpoints.static, '/grid.js')),
				b.AddScript(`__LOAD_CONFIG__=${loadConfig}`)
			],
			body: b.Embed(body, true)
		});
		await client.respondHtml(page, { status: mws.Status.Ok });
	}

	protected override async handleRequest(client: mws.ClientRequest, params?: mws.Params): Promise<void> {
		const access: BurntAccess = {
			query: (params?.query === true ? true : this.defaultAccess.query),
			edit: (params?.edit === true ? true : this.defaultAccess.edit),
			delete: (params?.delete === true ? true : this.defaultAccess.delete),
			create: (params?.create === true ? true : this.defaultAccess.create),
		};
		client.trace(`Request handler for [${client.path}] (Q: ${access.query} | E: ${access.edit} | D: ${access.delete} | C: ${access.create})`);

		/* check if a game is being manipulated */
		if (client.isInsideOf(Endpoints.game)) {
			const name = decodeURIComponent(mws.childPath(Endpoints.game, client.path).substring(1));
			return this.modifyGame(client, access, name);
		}

		/* check if a websocket is created */
		if (client.isInsideOf(Endpoints.sockets)) {
			const name = decodeURIComponent(mws.childPath(Endpoints.sockets, client.path).substring(1));
			if (!name.match(GAME_NAME_REGEX) || name.length > GAME_NAME_MAX_LENGTH)
				return client.respondNotFound();

			/* try to accept the web socket and handle it (await acceptance to ensure the
			*	stop method is not entered before the full accept has been performed) */
			const ws = await client.acceptWebSocket();
			if (ws != null)
				await this.acceptWebSocket(ws, name, access);
			return;
		}

		/* all other endpoints only support 'getting' */
		if (client.requireMethod('GET') == null)
			return;

		/* check if the games are queried */
		if (client.path == Endpoints.games)
			return this.queryGames(client, access);

		/* check if its one of the primary endpoints and build them dynamically */
		if (client.path == Endpoints.list)
			return this.buildMainPage(client, access);
		if (client.path == Endpoints.play)
			return this.buildPlayPage(client, access);
		if (client.path == Endpoints.editor)
			return this.buildEditorPage(client, access);

		/* check if its just static content to be served */
		if (client.isInsideOf(Endpoints.static))
			await client.tryRespondFile(this.fileStatic(mws.childPath(Endpoints.static, client.path)));
	}
	protected override async handleStop(): Promise<void> {
		const list: Promise<void>[] = [];

		/* drop all games (no new games can be started as no connections will enter the module anymore) */
		for (const game of Object.values(this.gameStates))
			list.push(game.dropGame('shutdown', false));
		await Promise.all(list);
	}
}
