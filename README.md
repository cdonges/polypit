# Polypit

A 3-D falling-block game for the browser, in the spirit of *Blockout* (California Dreams, 1989), which was itself inspired by the Soma Cube. Built from the original DOS user's manual. No dependencies, no build step.

## Run

High scores are stored in a SQLite database by a small Python server (standard library only, Python 3.8+):

```sh
python3 server.py                 # then visit http://localhost:8000
```

Environment variables: `PORT` (default `8000`) and `POLYPIT_DB` (default `./polypit.db`).

With Docker (mount a volume so scores survive container restarts):

```sh
docker build -t polypit .
docker run --rm -p 8000:8000 -v polypit-data:/data polypit
```

Or with Compose (see [compose.yml](compose.yml)):

```sh
docker compose up --build
```

The submitter's IP address is stored with each score in the `ip` column (never returned by the API). If you run behind a reverse proxy, set `TRUST_PROXY=1` so the address from `X-Forwarded-For` is recorded instead of the proxy's; only do this when the proxy is the sole way in, otherwise clients can spoof it. Note that IP addresses are personal data in some jurisdictions.

Example nginx location for the proxy (the sample [compose.yml](compose.yml) sets `TRUST_PROXY=1` and binds the container to `127.0.0.1` only):

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Score checking: the server issues a token when a game starts and, on submission, ignores scores that are implausible for the number of cubes played and the time elapsed (max 1500 points per cube, 15 cubes per second). Tokens are single-use and kept in memory, so a score from a game that started before a server restart is rejected. The limits live at the top of `server.py`.

Opening `index.html` directly from disk also works; with no server available, scores fall back to the browser's localStorage.

## Controls

| Key | Action |
| --- | --- |
| Numpad 4 / 6 / 8 / 2 | Move left / right / up / down |
| Numpad 7 / 9 / 1 / 3 | Move diagonally |
| Arrow keys, mouse | Also move the block (mouse click drops it) |
| Q / W / E | Flip / turn / spin counter-clockwise (x / y / z axis) |
| A / S / D | Flip / turn / spin clockwise (x / y / z axis) |
| Space | Drop the block (a brief moment remains to adjust) |
| P | Pause / resume |
| O | Sound on / off |
| G | Landing guide on / off (extra, not in the original) |
| Esc | Abort game / leave menu |

## Gameplay

Blocks fall into a pit; rotate and move them to fill complete layers, which then disappear. The game ends when the stack reaches the top.

- **Block sets:** Flat (8 blocks), Basic (the 7 Soma pieces), Extended (all 41 blocks of 1-5 cubes).
- **Pit:** width and length 3-7, depth 6-18.
- **Setups:** Flat Fun, 3-D Mania, Out of Control, or a custom one. "Write Setup" saves it in the browser.
- **Modes:** Start Game (levels 0-9), Practice Mode (blocks only fall when you press Space), Demo (the computer plays).
- **Hall of Fame:** a separate top ten per block set and pit size, stored server-side in SQLite (localStorage when no server is reachable).

## Layout

- `index.html` - page and styles
- `core.js` - game logic: shapes, rotation, collision, scoring, demo AI (no DOM, testable in Node)
- `ui.js` - rendering, menus, input, sound
- `Dockerfile`, `compose.yml`, `.github/workflows/docker.yml` - container image, Compose example, and CI that builds it (publishes to GHCR from `main`/tags)
- `server.py` - static file server and `/api/games` (POST, starts a game) and `/api/scores` (GET `?key=`, POST `{key, name, score, cubes, gameId}`) backed by SQLite

## Notes

The manual doesn't specify exact scoring, fall speeds or the pit sizes of the predefined setups, so those are approximations. Graphics and sound are original to this clone; copy protection and the multi-platform graphics modes are omitted.

*Blockout* is a trademark of its respective owners. Polypit is an unofficial, independent fan project and is not affiliated with them.
