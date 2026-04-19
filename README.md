# \[MWS\] Module to Create and Play Crosswords Together
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

A collaborative crossword module for [`MWS-Base`](https://github.com/BjoernBoss/mws-base.git). Players can create, edit, and solve crossword puzzles together in real time using WebSockets.

Game state is stored as JSON files in a configurable data directory and persists across server restarts. All active sessions are managed by the `Crossword` object; sharing it across multiple ports gives each port access to the same game state and player base.

## Setup
Clone into the modules directory of an existing MWS-Base installation:

    $ git clone https://github.com/BjoernBoss/mws-crossword.git modules/crossword

Register the module in `modules/setup.js`:

```JavaScript
export async function Run(server) {
    try {
        const crossword = await import("crossword/crossword.js");
        server.listenHttp(93, new crossword.Crossword('path/to/crossword/data'), (host) => host == 'localhost');
    }
    catch (e) {
        throw new Error(`Failed to load module: ${e.message}`);
    }
}
```

Then just build and run the server as usual.

## HTTP Endpoints
| Method | Path | Description |
|---|---|---|
| GET | `/` | Redirects to `/main.html` |
| GET | `/main.html` | Game lobby: list, create, and delete crosswords |
| GET | `/play.html` | Play/solve a crossword collaboratively |
| GET | `/editor.html` | Create a new crossword layout |
| GET | `/games` | JSON array of available game names |
| POST | `/game/{name}` | Create a new game (JSON body with `width`, `height`, `grid`) |
| DELETE | `/game/{name}` | Delete an existing game |
| GET | `/*.css`, `/*.js` | Static assets |
| GET | `/ws/{name}` | Endpoint for the WebSocket to join a game session |

## WebSocket Protocol
Upon each connection established to a known crossword game, the WebSocket clients can give themselves a name, and then push game updates. The game will notify all connected clients upon game changes. Should the game not exist, be corrupted, or be removed, the server will respond with short descriptive error identifiers, and then discard any further game state update requests.

## Game Rules
 - Grid dimensions: 1x1 to 64x64
 - Game names: alphanumeric with hyphens, dots, and underscores (max 256 characters)
 - Characters: uppercase A-Z only (lowercase input is uppercased; non-letter input is rejected)
 - Solid cells cannot be modified
 - Unnamed players cannot update the grid
 - Older timestamps are ignored (conflict resolution)
- Max upload size: 100 KB

## Persistence
Games are stored as JSON files (`{name}.json`) in the data directory. Writebacks are debounced by 60 seconds after the last change. When all clients disconnect, any pending changes are flushed immediately before the game is unloaded. A retention timer keeps the game in memory briefly to handle reconnections. Writebacks use a temporary file (`{name}.json.upload`) and atomic rename to prevent corruption.
