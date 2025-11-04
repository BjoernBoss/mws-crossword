# \[MWS\] Module to Create and Play Crosswords Together
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

This repository is designed to be used with the [`MWS-Base`](https://github.com/BjoernBoss/mws-base.git).

It provides an interactive way to create crosswords, which are stored in a given `data-path` (as given to the constructor of the application), to preserve them across reboots. Further, it allows to work on the crosswords in tandem, by making use of `WebSockets`.

All active sessions are managed by the created `Crossword` object. Sharing this object across multiple listened ports will therefore ensure each port shares a common player base.

## Using the Module
To use this module, setup the `mws-base`. Then simply clone this repository into the modules directory:

	$ git clone https://github.com/BjoernBoss/mws-crossword.git modules/crossword

Afterwards, transpile the entire server application, and construct this module in the `setup.js Run` method as:

```JavaScript
const m = await import("./crossword/crossword.js");
server.listenHttp(93, new m.Crossword('path/to/crossword/data'), null);
```
