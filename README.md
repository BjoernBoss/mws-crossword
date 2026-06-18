# \[MWS\] Module to Create and Play Crosswords Together
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

A collaborative crossword module for [`@bjoernboss/mws`](https://github.com/BjoernBoss/mws).

Players can create, edit, and solve crossword puzzles together in real time using WebSockets.

Game state is stored as JSON files in a configurable data directory and persists across server restarts. All active sessions are managed by the `Crossword` module.

## Installation

	$ npm install @bjoernboss/mws-crossword

Requires Node.js 22 or later.

## Setup

The `Crossword` module takes a data directory path and an optional `Params` object controlling what operations clients may perform. Mount it under a path using `dispatch`:

```typescript
import { Server, dispatch, addLogger, createConsoleLogger } from "@bjoernboss/mws";
import { Crossword } from "@bjoernboss/mws-crossword";

addLogger(createConsoleLogger());

const server = new Server();
const crossword = new Crossword('./data/crossword', {
    query: true,
    create: true,
    delete: true,
    edit: true
});

server.listen(dispatch({ '/crossword': crossword }), { port: 8080 });
```

The module serves its own pages, static assets, and WebSocket endpoints from its mount point. Navigate to `http://localhost:8080/crossword/` to open the lobby.

Important: The module caches the loaded games in memory. The same data directory should therefore not be used by multiple `Crossword` modules simultaneously.

## Parameters

The `Params` object controls module behavior and access. All fields are optional:

| Field | Default | Description |
|---|---|---|
| `query` | `false` | List existing games and view the lobby page |
| `create` | `false` | Create new crossword puzzles via the editor |
| `delete` | `false` | Delete existing crossword puzzles |
| `edit` | `false` | Modify game cells and set player names via WebSocket |
| `lifetime` | `86400000` (24h) | Cookie lifetime in milliseconds |

At minimum `query` and `edit` should be enabled for a functional game. Parameters can also be set per-request through `params` when dispatching to the module. Request parameter override the corresponding default, allowing parent modules to implement authentication or per-route access policies.

## Endpoints

The `Endpoints` export provides the path constants used by the module. All paths are relative to the module's mount point.

| Path | Method | Description |
|---|---|---|
| `/` | GET | Game lobby: list, create, and delete crosswords |
| `/play` | GET | Play/solve a crossword collaboratively (query param: `game`) |
| `/editor` | GET | Create a new crossword layout |
| `/games` | GET | JSON array of available game names |
| `/game/{name}` | POST | Create a new game (JSON body with `width`, `height`, `grid`) |
| `/game/{name}` | DELETE | Delete an existing game |
| `/static/*` | GET | Static assets (CSS, JS) served with immutable cache headers |
| `/ws/{name}` | WebSocket | Join a game session |

## WebSocket Protocol

Clients connect to `/ws/{name}` to join a game session. The server sends the full game state on connection and delta updates after every change. Clients send JSON commands to interact with the game.

### Client Commands

| Command | Fields | Description |
|---|---|---|
| `name` | `{ cmd: 'name', name: string }` | Set the player name (required before grid updates are accepted) |
| `update` | `{ cmd: 'update', data: GridCell[], id: number }` | Push a delta grid update; each cell includes an `index` field identifying its position in the linearized grid (`x + y * width`); `id` is a monotonically increasing ack-stamp |

### Server Messages

The server sends one of three message types: a `GameState` object, an `Ack` object, or a string error identifier.

- **`GameState`** object: `{ failed, delta, width, height, grid, online }` where `failed` indicates a write-back error, `delta` indicates whether `grid` contains a delta (only changed cells with `index` fields) or the full grid, and `online` lists currently connected player names.
- **`Ack`** object: `{ ack: number }` confirming the server received a client `update` message with the given `id`.
- **`"unknown-game"`**: the requested game does not exist.
- **`"corrupted-game"`**: the game file could not be parsed.
- **`"dropped-game"`**: the game was deleted while connected.
- **`"shutdown"`**: the server is shutting down.

After an error identifier is sent, the server closes the WebSocket.

### Delta Encoding

To minimize bandwidth, grid updates use delta encoding. Instead of transmitting the full grid on every change, only the modified cells are sent — both from client to server and from server to clients. Each cell in a delta carries an `index` field indicating its position in the linearized grid array (`x + y * width`).

The server sends the full grid state (`delta: false`) on initial connection and uses delta messages (`delta: true`) for subsequent broadcasts. Non-grid changes (player joins, name changes, disconnects) are broadcast as empty deltas that only update the `online` list.

### Conflict Resolution

Each cell carries a timestamp. When a client pushes an update, only cells with a strictly newer timestamp than the server's current state are applied. Cells with equal or older timestamps are silently discarded. This ensures that concurrent edits from multiple players converge without explicit locking.

## Game Rules

- Grid dimensions: 1x1 to 64x64
- Game names: alphanumeric with hyphens, dots, spaces, and underscores (max 64 characters)
- Characters: uppercase A-Z only (lowercase input is uppercased; non-letter input is rejected)
- Solid cells cannot be modified
- Unnamed players cannot update the grid
- Crossword numbering is assigned automatically based on standard crossword conventions (a cell gets a number if it starts a horizontal or vertical word)
- Max upload size: 100 KB

## Persistence

Games are stored as JSON files (`{name}.json`) in the data directory. Writebacks are debounced by 60 seconds after the last change. When all clients disconnect, any pending changes are flushed immediately before the game is unloaded from memory. A retention timer keeps the game loaded briefly after the last disconnect to handle quick reconnections.

If a writeback fails, the game state notifies all connected clients via the `failed` flag. The server retries the writeback on the next debounce cycle. If all clients disconnect while the writeback is still failing, the in-memory state is lost and a warning is logged.

## Cookies

The `Cookies` export provides the cookie name constants used by the module. The play page stores the last used player name in a cookie (`crossword-last-name`, configurable lifetime, default 24 hours) so it can be pre-filled on the next visit.
