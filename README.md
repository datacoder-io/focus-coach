# Focus Coach (working title)

A live, focus-friendly coach for Dota 2. It tells you **one thing at a time** — what to buy, when to back off, which skill to level, when the next rune spawns, which neutral item to craft, and which items counter this match's enemies — in a small click-through overlay on top of the game, with voice in Persian or English.

[فارسی](README.fa.md)

> Not affiliated with or endorsed by Valve. Dota 2 is a registered trademark of Valve Corporation.

## Features

- **One big instruction** — the single most important thing right now (low HP, buy now, rune in 15 s, skill up…), color-coded.
- **In-game overlay** — always on top and click-through, so your clicks still reach the game. `Ctrl+Alt+M` to move or resize it.
- **Voice alerts** — natural Persian voices (Microsoft Edge) or English.
- **Item build** — popular build per hero (OpenDota), the next item with the gold you still need, and the item name copied to the clipboard for the shop search (`Ctrl+V`).
- **Skill order** — the next ability or talent to take, based on recent pro matches.
- **Neutral items** — ranked artifacts and enchantments for your hero, for the craft window.
- **Timers** — runes, wisdom shrines, Tormentor, Roshan (configurable for the current patch).
- **AI counters (optional)** — identifies the enemy heroes from the top bar and suggests counter items, via your own [OpenRouter](https://openrouter.ai) key (~$0.005 per match).

## How it works

- Game data comes from Valve's official **Game State Integration**: Dota 2 posts your own hero's state to a local server. No memory reading, and the app never sends keys or clicks to the game.
- With AI enabled, only a picture of the **top bar** (the 10 hero portraits) is sent for hero recognition.
- Hero, item and ability data: [OpenDota](https://www.opendota.com) and [dotaconstants](https://github.com/odota/dotaconstants).

## Requirements

- Windows 10/11, [Node.js](https://nodejs.org) 20+, Microsoft Edge (overlay window and Persian voices)
- Dota 2 in **Borderless Window** display mode (exclusive fullscreen hides every other window)

## Quick start

```bat
git clone <this repo>
cd <repo>
START.bat
```

`START.bat` installs the Game State Integration config into your Dota folder, launches Dota 2 with `-gamestateintegration`, starts the local server and opens the overlay. `DEMO.bat` shows a simulated match without the game.

The full dashboard and settings are at `http://localhost:3005`; on a phone on the same Wi-Fi, use the PC's IP instead.

## AI counters (optional)

Copy `secrets.example.json` to `secrets.json` and put your OpenRouter key in it, or paste the key into the dashboard. Defaults: `anthropic/claude-sonnet-5.5` for reading hero portraits (once per match) and `anthropic/claude-haiku-5.5` for the analysis; both can be changed in `secrets.json`. Set a spending limit on your OpenRouter account.

`secrets.json` is git-ignored — never commit it.

## Configuration

`config.json`: server port, rune/objective timers (patch 7.41) and item unlock times.

## Project layout

| Path | What it is |
|---|---|
| `server.js` | Local server: receives Game State Integration data, serves the dashboard, streams updates (SSE) |
| `public/` | Dashboard and overlay UI (`app.js` holds the coaching logic) |
| `ai.js`, `capture.ps1` | Optional AI: top-bar capture, hero recognition, counter-item analysis |
| `overlay.ps1` | Opens the always-on-top, click-through overlay and its `Ctrl+Alt+M` move mode |
| `setup.ps1` | Finds Dota 2 and installs the Game State Integration config |
| `demo.js` | Simulated match for `DEMO.bat` |

## License

[MIT](LICENSE)
