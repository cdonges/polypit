#!/usr/bin/env python3
"""Serves the Polypit game and stores high scores in SQLite. Standard library only.

Env: PORT (default 8000), POLYPIT_DB (default ./polypit.db),
     TRUST_PROXY (set to 1 to record the client IP from X-Forwarded-For)
"""
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("POLYPIT_DB", os.path.join(ROOT, "polypit.db"))
PORT = int(os.environ.get("PORT", "8000"))
TRUST_PROXY = os.environ.get("TRUST_PROXY", "") == "1"
KEEP = 10

# Plausibility limits. The demo AI (far better than a human at surviving) peaks around
# 820 points per cube played, so 1500 leaves a wide margin.
MAX_SCORE_PER_CUBE = 1500
MAX_SCORE = 50_000_000
MAX_CUBES_PER_SECOND = 15   # ~3 five-cube blocks a second is beyond human play
CUBE_SLACK = 20
GAME_TTL = 6 * 3600

# Games started via POST /api/games: token -> start time. Single use, in memory.
_games = {}
_games_lock = threading.Lock()


def start_game():
    now = time.time()
    token = secrets.token_hex(16)
    with _games_lock:
        for t in [t for t, st in _games.items() if now - st > GAME_TTL]:
            del _games[t]
        if len(_games) > 10000:
            _games.clear()
        _games[token] = now
    return token


def plausible(game_id, cubes, score):
    """Consume the game token and check the claimed result is achievable."""
    with _games_lock:
        started = _games.pop(game_id, None)
    if started is None:
        return False
    elapsed = time.time() - started
    if elapsed > GAME_TTL or cubes <= 0:
        return False
    if cubes > elapsed * MAX_CUBES_PER_SECOND + CUBE_SLACK:
        return False
    return score <= min(MAX_SCORE, cubes * MAX_SCORE_PER_CUBE)

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/core.js": ("core.js", "text/javascript; charset=utf-8"),
    "/ui.js": ("ui.js", "text/javascript; charset=utf-8"),
}
KEY_RE = re.compile(r"^polypit\.hof\.(flat|basic|extended)\.\d{1,2}x\d{1,2}x\d{1,2}$")


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.execute(
            """CREATE TABLE IF NOT EXISTS scores (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 setup TEXT NOT NULL,
                 name TEXT NOT NULL,
                 score INTEGER NOT NULL,
                 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"""
        )
        # Databases created before the ip column existed are upgraded in place.
        cols = [r["name"] for r in con.execute("PRAGMA table_info(scores)")]
        if "ip" not in cols:
            con.execute("ALTER TABLE scores ADD COLUMN ip TEXT")
        con.execute("CREATE INDEX IF NOT EXISTS scores_setup ON scores (setup, score DESC)")


def top(con, key):
    rows = con.execute(
        "SELECT name, score FROM scores WHERE setup = ? ORDER BY score DESC, id ASC LIMIT ?",
        (key, KEEP),
    ).fetchall()
    return [{"name": r["name"], "score": r["score"]} for r in rows]


class Handler(BaseHTTPRequestHandler):
    server_version = "Polypit"

    def _client_ip(self):
        """Peer address; behind a trusted reverse proxy, the address it appended to X-Forwarded-For."""
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[-1].strip()[:64]
        return self.client_address[0]

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/scores":
            key = parse_qs(url.query).get("key", [""])[0]
            if not KEY_RE.match(key):
                return self._send(400, {"error": "bad key"})
            with db() as con:
                return self._send(200, top(con, key))
        if url.path in STATIC:
            fname, ctype = STATIC[url.path]
            with open(os.path.join(ROOT, fname), "rb") as f:
                return self._send(200, f.read(), ctype)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/games":
            return self._send(200, {"id": start_game()})
        if path != "/api/scores":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 4096:
                raise ValueError
            body = json.loads(self.rfile.read(n))
            key, name, score = body["key"], str(body["name"]).strip()[:12], int(body["score"])
            cubes, game_id = int(body["cubes"]), str(body["gameId"])
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad request"})
        if not KEY_RE.match(key) or not 0 < score <= 10**9:
            return self._send(400, {"error": "bad request"})
        if not plausible(game_id, cubes, score):
            return self._send(422, {"error": "score rejected"})
        with db() as con:
            con.execute(
                "INSERT INTO scores (setup, name, score, ip) VALUES (?, ?, ?, ?)",
                (key, name or "Anonymous", score, self._client_ip()),
            )
            con.execute(
                """DELETE FROM scores WHERE setup = ? AND id NOT IN
                   (SELECT id FROM scores WHERE setup = ? ORDER BY score DESC, id ASC LIMIT ?)""",
                (key, key, KEEP),
            )
            result = top(con, key)
        # respond only after the transaction has been committed
        self._send(200, result)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    init_db()
    print(f"Polypit on http://localhost:{PORT}  (scores: {DB_PATH})")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
