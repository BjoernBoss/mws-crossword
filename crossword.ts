/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2025-2026 Bjoern Boss Henrichsen */
import * as libInterface from "core/interface.js";
import * as libClient from "core/client.js";
import * as libLog from "core/log.js";
import * as libLocation from "core/location.js";
import * as libBuilder from "core/builder.js";
import * as libCache from "core/cache.js";
import * as libFs from "fs/promises";

const NameRegex = '^[a-zA-Z0-9]([-_.]?[a-zA-Z0-9])*$';
const NameMaxLength = 255;
const GridDimensions = { min: 1, max: 64 };
const MaxFileSize = 100_000;
const PingTimeout = 60_000;
const WriteBackDelayMs = 60_000;

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

function ParseAndValidateCells(grid: any, size: number, shallowGrid: boolean, refCells: GridCell[] | null): [GridCell[], boolean] {
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
		let author: string = cell.author.slice(0, NameMaxLength);
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
	catch (e) {
		throw new Error('Malformed JSON encountered');
	}

	/* validate the overall structure */
	if (typeof obj != 'object')
		throw new Error('Malformed object');
	if (typeof obj.width != 'number' || typeof obj.height != 'number'
		|| !isFinite(obj.width) || obj.width < GridDimensions.min || obj.width > GridDimensions.max
		|| !isFinite(obj.height) || obj.height < GridDimensions.min || obj.height > GridDimensions.max)
		throw new Error('Malformed Dimensions');

	/* validate and parse the list of cells and return the game structure */
	const [cells, _] = ParseAndValidateCells(obj.grid, obj.width * obj.height, shallowGrid, null);
	return { width: obj.width, height: obj.height, grid: cells };
}

class ActiveGame {
	private ws: Map<libClient.ClientSocket, string>;
	private data: GameBoard | null;
	private filePath: string;
	private writebackFailed: boolean;
	private loading: Promise<GameLoadState>;
	private queue: { backlog?: () => void, timer: NodeJS.Timeout | null, active: boolean };

	constructor(filePath: string) {
		this.ws = new Map<libClient.ClientSocket, string>();
		this.data = null;
		this.filePath = filePath;
		this.writebackFailed = false;
		this.loading = this.loadGameState();
		this.queue = { timer: null, active: false };
	}

	private async loadGameState(): Promise<GameLoadState> {
		let data: string = '';

		/* try to read the game state */
		try {
			data = await libFs.readFile(this.filePath, { encoding: 'utf-8' });
		}
		catch (e: any) {
			if (e.code === 'ENOENT') {
				libLog.Error(`Game [${this.filePath}] does not exist: ${e.message}`);
				return GameLoadState.doesNotExist;
			}
			libLog.Error(`Failed to read the game [${this.filePath}] state: ${e.message}`);
			return GameLoadState.corrupted;
		}

		/* parse and validate the game state */
		try {
			this.data = ParseAndValidateGameBoard(data, false);
			return GameLoadState.valid;
		}
		catch (e: any) {
			libLog.Error(`Corrupted game state found [${this.filePath}]: ${e.message}`);
			return GameLoadState.corrupted;
		}
	}
	private buildOutput(): GameState {
		if (this.data == null)
			return { failed: true, grid: [], width: 0, height: 0, names: [], online: [] };
		let out: GameState = {
			failed: this.writebackFailed,
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
	private notifySingleId(ws: libClient.ClientSocket): void {
		const json = JSON.stringify(this.buildOutput());
		ws.send(json);
	}
	private queueWriteBack(dropAsActiveGame: () => void): void {
		/* check if the game can just be dropped */
		if (this.data == null) {
			if (this.ws.size == 0)
				dropAsActiveGame();
			return;
		}

		/* check if an entry is already being written back */
		if (this.queue.active) {
			this.queue.backlog = dropAsActiveGame;
			return;
		}

		/* kill the last queue as the new entry will now be queued */
		if (this.queue.timer != null)
			clearTimeout(this.queue.timer);

		/* queue the next write-back execution */
		this.queue.timer = setTimeout(async () => {
			/* mark the queue as now being processed and cache the state being stored */
			this.queue.timer = null;
			this.queue.active = true;
			const currentState: string = JSON.stringify(this.data);

			/* prepare the writeback to the temporary upload file */
			const tempPath = `${this.filePath}.upload`;
			let written = false;
			try {
				/* try to write the data back to a temporary file */
				libLog.Log(`Uploading crossword via temporary file [${tempPath}] for [${this.filePath}]`);
				await libFs.writeFile(tempPath, currentState, { encoding: 'utf-8' });
				written = true;

				/* replace the existing file */
				await libFs.rename(tempPath, this.filePath);
				this.writebackFailed = false;
			}
			catch (e: any) {
				if (written)
					libLog.Error(`Failed to replace original file [${this.filePath}]: ${e.message}`);
				else
					libLog.Error(`Failed to write to temporary file [${tempPath}]: ${e.message}`);

				/* try to remove the temporary file */
				try {
					await libFs.unlink(tempPath);
				}
				catch (e: any) {
					libLog.Error(`Failed to remove temporary file [${tempPath}]: ${e.message}`);
				}

				/* notify about the failed write-back */
				if (!this.writebackFailed) {
					this.writebackFailed = true;
					this.notifyAll();
				}

				/* check if the changes will be discarded, or if another write approach should be made */
				if (this.ws.size == 0)
					libLog.Warning(`Discarding write-back as state is lost`);
				else if (this.queue.backlog == undefined)
					this.queue.backlog = dropAsActiveGame;
			}

			/* check if the current game can be dropped or if the next write-back needs to be started */
			this.queue.active = false;
			if (this.queue.backlog != undefined)
				this.queueWriteBack(this.queue.backlog);
			else if (this.ws.size == 0)
				dropAsActiveGame();
			this.queue.backlog = undefined;
		}, WriteBackDelayMs);
	}

	public waitOnGame(): Promise<GameLoadState> {
		return this.loading;
	}
	public updateGrid(client: libClient.ClientSocket, grid: any): void {
		/* ensure that a grid exists */
		if (this.data == null) {
			client.log(`Discarding grid update for corrupted load [${this.filePath}]`);
			this.notifySingle(client);
			return;
		}

		/* ensure that the player has a name */
		if (this.ws.get(client)!.length == 0) {
			client.log(`Discarding grid update of unnamed player [${this.filePath}]`);
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
			client.log(`Discarding empty grid update of [${this.filePath}]`);
			this.notifySingle(client);
			return;
		}

		/* update the grid and notify the listeners about the change */
		this.data.grid = merged;
		this.notifyAll();
		this.queueWriteBack(() => { });
	}
	public updateName(ws: libClient.ClientSocket, name: string): void {
		name = name.slice(0, NameMaxLength);
		if (this.ws.get(ws) == name) return;

		/* update the name and notify the other sockets */
		this.ws.set(ws, name);
		this.notifyAll();
	}
	public drop(ws: libClient.ClientSocket, dropAsActiveGame: () => void): void {
		/* remove the web-socket from the open connections */
		let name = this.ws.get(ws)!;
		this.ws.delete(ws);

		/* check if this was the last listener and the object can be unloaded */
		if (this.ws.size == 0)
			this.queueWriteBack(dropAsActiveGame);

		/* check if other listeners should be notified */
		else if (name.length > 0)
			this.notifyAll();
	}
	public register(ws: libClient.ClientSocket): void {
		this.ws.set(ws, '');
	}
	public notifySingle(ws: libClient.ClientSocket): void {
		this.notifySingleId(ws);
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
		if (!name.match(NameRegex) || name.length > NameMaxLength) {
			client.respondNotFound();
			return;
		}
		client.log(`Handling Game: [${name}] as [${method}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game is being removed */
		if (method == 'DELETE') {
			try {
				await libFs.unlink(filePath);
				libLog.Log(`Game file: [${filePath}] deleted successfully`);
				client.respondOk('delete');
			} catch (e: any) {
				/*  check why the removal failed and log it accordingly */
				libLog.Error(`Error while removing file [${filePath}]: ${e.message}`);
				if (e.code === 'ENOENT')
					client.respondNotFound();
				else
					client.respondFileSystemError();
			}
			return;
		}

		/* validate the content type */
		if (client.ensureMediaType(['application/json']) == null)
			return;

		/* collect all of the data */
		try {
			const text: string = await client.receiveAllText(client.getMediaTypeCharset('utf-8'), MaxFileSize);

			/* parse and validate the data */
			let parsed: GameBoard | null = null;
			try {
				parsed = ParseAndValidateGameBoard(text, true);
			} catch (e: any) {
				client.error(`Error while parsing the game: ${e.message}`);
				client.respondBadRequest(e.message);
				return;
			}

			/* serialize the data to the file and write it out */
			try {
				await libFs.writeFile(filePath, JSON.stringify(parsed), { encoding: 'utf-8', flag: 'wx' });
				client.respondOk('upload');
			}
			catch (e: any) {
				/* check why the creating failed and log it accordingly */
				libLog.Error(`Error while writing the game out: ${e.message}`);
				if (e.code === 'EEXIST')
					client.respondConflict('already exists');
				else
					client.respondFileSystemError();
				return;
			}
		}
		catch (err: any) {
			/* no need to notify the client, as the receive function will already have done so) */
			client.error(`Error occurred while posting to [${filePath}]: ${err.message}`);
		}
	}
	private async queryGames(client: libClient.HttpRequest): Promise<void> {
		let content: string[] = [];
		try {
			content = await libFs.readdir(this.fileGames('.'));
		}
		catch (e: any) {
			libLog.Error(`Error while reading directory content: ${e.message}`);
		}
		let out = [];

		/* collect them all out */
		libLog.Log(`Querying list of all registered games: [${content}]`);
		for (const name of content) {
			if (!name.endsWith('.json'))
				continue;
			let actual = name.slice(0, name.length - 5);
			if (!actual.match(NameRegex) || actual.length > NameMaxLength)
				continue;
			out.push(name.slice(0, name.length - 5));
		}

		/* return them to the request */
		client.respondText(JSON.stringify(out), 'json');
	}
	private async acceptWebSocket(client: libClient.ClientSocket, name: string): Promise<void> {
		client.log(`Handling WebSocket to: [${name}]`);
		const filePath = this.fileGames(`${name}.json`);

		/* check if the game-state for the given name has already been set-up */
		if (!(name in this.gameStates))
			this.gameStates[name] = new ActiveGame(filePath);
		const game = this.gameStates[name];

		/* register the client to the game (to prevent it from being removed) */
		game.register(client);
		client.log(`Registered websocket to [${name}]`);

		/* wait for the game data to load and check if the file was found */
		const loadState: GameLoadState = await game.waitOnGame();
		if (loadState != GameLoadState.valid) {
			/* drop the client again from the game */
			game.drop(client, () => {
				if (this.gameStates[name] === game)
					delete this.gameStates[name];
			});

			/* notify the client about the game state */
			client.send(JSON.stringify(loadState == GameLoadState.doesNotExist ? 'unknown-game' : 'corrupted-game'));
			client.close();
			return;
		}

		/* define the alive callback */
		let isAlive = true, aliveInterval: NodeJS.Timeout | null = null;
		const queueAliveCheck = function (alive: boolean): void {
			/* update the alive-flag and kill the old timer */
			isAlive = alive;
			if (aliveInterval != null)
				clearTimeout(aliveInterval);

			/* queue the check callback */
			aliveInterval = setTimeout(function () {
				if (!isAlive) {
					client.close();
					aliveInterval = null;
				}
				else {
					queueAliveCheck(false);
					client.ping();
				}
			}, PingTimeout);
		};

		/* initiate the alive-check */
		queueAliveCheck(true);

		/* register the web-socket callbacks */
		client.onpong = () => queueAliveCheck(true);
		client.onclose = async () => {
			/* clear the alive ping timeout */
			if (aliveInterval != null)
				clearTimeout(aliveInterval);

			/* try to drop the game and check if it should be removed from the active games */
			game.drop(client, () => {
				if (this.gameStates[name] === game)
					delete this.gameStates[name];
			});
			client.log(`Socket disconnected`);
		};
		client.ondata = (data) => {
			queueAliveCheck(true);

			/* parse the data */
			try {
				const parsed: any = JSON.parse(data.toString('utf-8'));
				client.log(`Received for socket: ${parsed.cmd}`);

				/* handle the command */
				if (parsed.cmd == 'name' && typeof parsed.name == 'string')
					game.updateName(client, parsed.name);
				else if (parsed.cmd == 'update')
					game.updateGrid(client, parsed.data);
			} catch (e: any) {
				client.error(`Failed to parse web-socket response: ${e.message}`);
				client.close();
			}
		};

		/* send the initial state to the socket */
		game.notifySingle(client);
	}
	private async fetchBody(client: libClient.HttpRequest, path: string): Promise<string | null> {
		const fullPath = this.fileStatic(path);

		/* look for the file */
		const cached: libCache.Cached | null = libCache.Get(fullPath);
		if (cached == null) {
			client.error(`Failed to find content [${fullPath}]`);
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
		const b = libBuilder;

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/main.html');
		if (body == null)
			return;
		const page = new libBuilder.HtmlPage('en', '', b.Embed(body));
		client.respondHtml(page, libClient.StatusCode.Ok);

		/* add the required page headers and load the content from cache */
		page.head += b.Meta('viewport', 'width=device-width, initial-scale=1');
		page.head += b.Title('Crosswords!');
		page.head += b.LoadStyle(client.makePath('/style.css'));
		page.head += b.LoadScript(client.makePath('/notifier.js'));
	}
	private async buildPlayPage(client: libClient.HttpRequest): Promise<void> {
		const b = libBuilder;

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/play.html');
		if (body == null)
			return;
		const page = new libBuilder.HtmlPage('en', '', b.Embed(body));
		client.respondHtml(page, libClient.StatusCode.Ok);

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		page.head += b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
		page.head += b.Title('Play Crossword!');
		page.head += b.LoadStyle(client.makePath('/style.css'));
		page.head += b.LoadScript(client.makePath('/notifier.js'));
		page.head += b.LoadScript(client.makePath('/sync-socket.js'));
		page.head += b.LoadScript(client.makePath('/grid.js'));
	}
	private async buildEditorPage(client: libClient.HttpRequest): Promise<void> {
		const b = libBuilder;

		/* read the body */
		const body: string | null = await this.fetchBody(client, '/editor.html');
		if (body == null)
			return;
		const page = new libBuilder.HtmlPage('en', '', b.Embed(body));
		client.respondHtml(page, libClient.StatusCode.Ok);

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		page.head += b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
		page.head += b.Title('Crossword Editor');
		page.head += b.LoadStyle(client.makePath('/style.css'));
		page.head += b.LoadScript(client.makePath('/grid.js'));
	}

	public async request(client: libClient.HttpRequest): Promise<void> {
		client.log(`Game handler for [${client.path}]`);

		/* check if a game is being manipulated */
		if (client.path.startsWith('/game/'))
			return this.modifyGame(client);

		/* all other endpoints only support 'getting' */
		if (client.ensureMethod(['GET']) == null)
			return;

		/* check if its a redirection and forward it accordingly */
		if (client.path == '/' || client.path == '/main')
			return client.respondTemporaryRedirect(client.makePath('/main.html'));
		if (client.path == '/editor')
			return client.respondTemporaryRedirect(client.makePath('/editor.html'));
		if (client.path == '/play')
			return client.respondTemporaryRedirect(client.makePath('/play.html'));

		/* check if the games are queried */
		if (client.path == '/games')
			return this.queryGames(client);

		/* check if its one of the html endpoints and build them (discard any other requests) */
		if (client.path == '/main.html')
			return this.buildMainPage(client);
		if (client.path == '/play.html')
			return this.buildPlayPage(client);
		if (client.path == '/editor.html')
			return this.buildEditorPage(client);
		if (client.path.toLowerCase().endsWith('.html'))
			return;

		/* respond to the request by trying to server the file */
		client.tryRespondFile(this.fileStatic(client.path));
	}
	public async upgrade(client: libClient.HttpUpgrade): Promise<void> {
		client.log(`Game handler for [${client.path}]`);

		/* check if a web-socket is connecting */
		if (!client.path.startsWith('/ws/'))
			return;

		/* extract the name and validate it (return with not-found as the entire endpoint is owned) */
		let name = client.path.slice(4);
		if (name.match(NameRegex) && name.length <= NameMaxLength) {
			if (client.tryAcceptWebSocket((ws) => this.acceptWebSocket(ws, name)))
				return;
		}
		client.log(`Invalid request for web-socket point for game [${name}]`);
		client.respondNotFound();
	}
}
