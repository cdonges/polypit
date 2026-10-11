// Polypit - pure game logic (no DOM). Coordinates: x = right, y = down-screen, z = depth into the pit (0 = top rim).
(function (root) {
  'use strict';

  // ---------- Rotation primitives ----------
  const ROT = {
    x: (c, d) => (d > 0 ? [c[0], -c[2], c[1]] : [c[0], c[2], -c[1]]),
    y: (c, d) => (d > 0 ? [c[2], c[1], -c[0]] : [-c[2], c[1], c[0]]),
    z: (c, d) => (d > 0 ? [-c[1], c[0], c[2]] : [c[1], -c[0], c[2]]),
  };

  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  function normalize(cells) {
    let mx = Infinity, my = Infinity, mz = Infinity;
    for (const c of cells) {
      if (c[0] < mx) mx = c[0];
      if (c[1] < my) my = c[1];
      if (c[2] < mz) mz = c[2];
    }
    return cells.map((c) => [c[0] - mx, c[1] - my, c[2] - mz]).sort(cmp);
  }

  const keyOf = (cells) => cells.map((c) => c.join(',')).join(';');

  function bounds(cells) {
    let w = 0, l = 0, h = 0;
    for (const c of cells) {
      if (c[0] + 1 > w) w = c[0] + 1;
      if (c[1] + 1 > l) l = c[1] + 1;
      if (c[2] + 1 > h) h = c[2] + 1;
    }
    return [w, l, h];
  }

  // All distinct (normalized) orientations reachable by rotation.
  function orientations(cells) {
    const start = normalize(cells);
    const seen = new Map([[keyOf(start), start]]);
    const stack = [start];
    while (stack.length) {
      const c = stack.pop();
      for (const ax of ['x', 'y', 'z']) {
        const n = normalize(c.map((p) => ROT[ax](p, 1)));
        const k = keyOf(n);
        if (!seen.has(k)) { seen.set(k, n); stack.push(n); }
      }
    }
    return [...seen.values()];
  }

  // ---------- Shape catalogue: all polycubes of 1..5 cubes (41 blocks) ----------
  function generateShapes() {
    const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let level = [normalize([[0, 0, 0]])];
    const out = [];
    const add = (cells) => {
      const orients = orientations(cells).map((c) => ({ cells: c, dims: bounds(c) }));
      out.push({ n: cells.length, cells, orients });
    };
    add(level[0]);
    for (let n = 2; n <= 5; n++) {
      const found = new Map();
      for (const p of level) {
        const have = new Set(p.map((c) => c.join(',')));
        for (const c of p) {
          for (const d of DIRS) {
            const nc = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
            if (have.has(nc.join(','))) continue;
            const cand = normalize([...p, nc]);
            const canon = orientations(cand).map(keyOf).sort()[0];
            if (!found.has(canon)) found.set(canon, cand);
          }
        }
      }
      level = [...found.values()];
      level.forEach(add);
    }
    return out;
  }

  const ALL_SHAPES = generateShapes();
  const dimsSorted = (s) => s.orients[0].dims.slice().sort((a, b) => a - b);

  const SETS = {
    // monocube, domino, I3, L3, O, L, T, S  (the 8 flat blocks of the manual)
    flat: ALL_SHAPES.filter((s) => {
      const d = dimsSorted(s);
      return s.n <= 4 && d[0] === 1 && !(s.n === 4 && d[2] === 4);
    }),
    // 7 Soma pieces
    basic: ALL_SHAPES.filter((s) => {
      const d = dimsSorted(s);
      if (s.n === 3) return d[2] === 2;
      if (s.n === 4) return d[2] !== 4 && !(d[0] === 1 && d[1] === 2 && d[2] === 2);
      return false;
    }),
    extended: ALL_SHAPES,
  };

  function poolFor(set, W, L, D) {
    const fits = (s) => s.orients.some((o) => o.dims[0] <= W && o.dims[1] <= L && o.dims[2] <= D);
    return (SETS[set] || SETS.flat).filter(fits);
  }

  // ---------- Game ----------
  const SPEEDS = {
    fast: { tau: 35, rot: 90 },
    medium: { tau: 70, rot: 170 },
    slow: { tau: 130, rot: 300 },
  };
  const SET_FACTOR = { flat: 1, basic: 1.5, extended: 2 };

  class Game {
    constructor(opt) {
      this.W = opt.W; this.L = opt.L; this.D = opt.D;
      this.set = opt.set;
      this.mode = opt.mode || 'game';           // game | practice | demo
      this.speed = SPEEDS[opt.speed] || SPEEDS.medium;
      this.rng = opt.rng || Math.random;
      this.onEvent = opt.onEvent || (() => {});
      this.startLevel = opt.level || 0;
      this.level = this.startLevel;
      this.score = 0;
      this.cubes = 0;
      this.pieces = 0;
      this.grid = new Uint8Array(this.W * this.L * this.D);
      this.pool = poolFor(this.set, this.W, this.L, this.D);
      this.fx = { x: 0, y: 0, z: 0, rot: null };
      this.pieceId = 0;
      this.phase = 'falling';                  // falling | clearing | over
      this.piece = null;
      this.pitFactor = 1 + ((49 - this.W * this.L) / 49) * 1.5;
      this.spawn();
    }

    idx(x, y, z) { return (z * this.L + y) * this.W + x; }

    valid(cells, px, py, pz) {
      for (const c of cells) {
        const x = c[0] + px, y = c[1] + py, z = c[2] + pz;
        if (x < 0 || y < 0 || z < 0 || x >= this.W || y >= this.L || z >= this.D) return false;
        if (this.grid[this.idx(x, y, z)]) return false;
      }
      return true;
    }

    gravityInterval() { return Math.max(150, 1800 * Math.pow(0.8, this.level)); }

    spawn() {
      const shape = this.pool[Math.floor(this.rng() * this.pool.length)];
      const fitting = shape.orients.filter((o) => o.dims[0] <= this.W && o.dims[1] <= this.L && o.dims[2] <= this.D);
      const o = fitting[Math.floor(this.rng() * fitting.length)];
      const x = Math.floor((this.W - o.dims[0]) / 2);
      const y = Math.floor((this.L - o.dims[1]) / 2);
      this.piece = { cells: o.cells, dims: o.dims, x, y, z: 0 };
      this.pieceId++;
      this.dropping = false;
      this.acc = 0;
      this.lockT = 0;
      this.dropDist = 0;
      this.dropStartZ = 0;
      this.fx.x = this.fx.y = this.fx.z = 0;
      this.fx.rot = null;
      if (!this.valid(o.cells, x, y, 0)) {
        if (this.mode === 'practice') {
          this.grid.fill(0);
        } else {
          this.phase = 'over';
          this.onEvent('over');
        }
      }
    }

    _place(nx, ny, nz) {
      const p = this.piece;
      this.fx.x += p.x - nx; this.fx.y += p.y - ny; this.fx.z += p.z - nz;
      p.x = nx; p.y = ny; p.z = nz;
    }

    move(dx, dy) {
      if (this.phase !== 'falling') return false;
      const p = this.piece;
      if (this.valid(p.cells, p.x + dx, p.y + dy, p.z)) {
        this._place(p.x + dx, p.y + dy, p.z);
        this.onEvent('move');
        return true;
      }
      return false;
    }

    moveTo(x, y) {
      if (this.phase !== 'falling') return;
      const p = this.piece;
      x = Math.max(0, Math.min(this.W - p.dims[0], x));
      y = Math.max(0, Math.min(this.L - p.dims[1], y));
      if (x === p.x && y === p.y) return;
      if (this.valid(p.cells, x, y, p.z)) this._place(x, y, p.z);
    }

    rotate(axis, dir) {
      if (this.phase !== 'falling') return false;
      const p = this.piece;
      const cells = normalize(p.cells.map((c) => ROT[axis](c, dir)));
      const dims = bounds(cells);
      // keep the centre of the block where it was
      const cx = p.x + p.dims[0] / 2, cy = p.y + p.dims[1] / 2, cz = p.z + p.dims[2] / 2;
      let nx = Math.round(cx - dims[0] / 2), ny = Math.round(cy - dims[1] / 2), nz = Math.round(cz - dims[2] / 2);
      nx = Math.max(0, Math.min(this.W - dims[0], nx));
      ny = Math.max(0, Math.min(this.L - dims[1], ny));
      nz = Math.max(0, nz);
      if (dims[0] > this.W || dims[1] > this.L || nz + dims[2] > this.D) return false;
      const tries = [[0, 0, 0], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0]];
      for (const t of tries) {
        const tx = nx + t[0], ty = ny + t[1], tz = nz + t[2];
        if (tz < 0 || tx < 0 || ty < 0 || tx + dims[0] > this.W || ty + dims[1] > this.L || tz + dims[2] > this.D) continue;
        if (this.valid(cells, tx, ty, tz)) {
          this._place(tx, ty, tz);
          p.cells = cells; p.dims = dims;
          this.fx.rot = { axis, dir, age: 0, dur: this.speed.rot };
          this.onEvent('rotate');
          return true;
        }
      }
      return false;
    }

    hardDrop() {
      if (this.phase !== 'falling' || this.dropping) return;
      this.dropping = true;
      this.dropStartZ = this.piece.z;
      this.lockT = 0;
      this.acc = 0;
    }

    landingZ() {
      const p = this.piece;
      let z = p.z;
      while (this.valid(p.cells, p.x, p.y, z + 1)) z++;
      return z;
    }

    update(dt) {
      // visual easing
      const k = 1 - Math.exp(-dt / this.speed.tau);
      this.fx.x -= this.fx.x * k; this.fx.y -= this.fx.y * k; this.fx.z -= this.fx.z * k;
      if (this.fx.rot) { this.fx.rot.age += dt; if (this.fx.rot.age >= this.fx.rot.dur) this.fx.rot = null; }

      if (this.phase === 'clearing') {
        this.clearT -= dt;
        if (this.clearT <= 0) this._finishClear();
        return;
      }
      if (this.phase !== 'falling') return;
      if (this.mode === 'practice' && !this.dropping) return;

      const p = this.piece;
      if (this.dropping) {
        this.acc += dt;
        while (this.acc >= 28 && this.phase === 'falling') {
          this.acc -= 28;
          if (this.valid(p.cells, p.x, p.y, p.z + 1)) {
            this._place(p.x, p.y, p.z + 1);
            this.dropDist++;
            this.lockT = 0;
          } else {
            this.lockT += 28;
            if (this.lockT >= 280) { this._lock(); break; }
          }
        }
      } else {
        this.acc += dt;
        const iv = this.mode === 'demo' ? 2200 : this.gravityInterval();
        if (this.acc >= iv) {
          this.acc = 0;
          if (this.valid(p.cells, p.x, p.y, p.z + 1)) this._place(p.x, p.y, p.z + 1);
          else this._lock();
        }
      }
    }

    _lock() {
      const p = this.piece;
      const n = p.cells.length;
      for (const c of p.cells) this.grid[this.idx(c[0] + p.x, c[1] + p.y, c[2] + p.z)] = 1;
      this.cubes += n;
      this.pieces++;
      this.onEvent('land');

      if (this.mode !== 'practice') {
        const vol = p.dims[0] * p.dims[1] * p.dims[2];
        const complexity = n + vol * 0.5;
        const dropDist = this.dropping ? p.z - this.dropStartZ : 0;
        const pts = (complexity * 10 + dropDist * 2) * (1 + this.level * 0.5) * (SET_FACTOR[this.set] || 1) * this.pitFactor;
        this.score += Math.round(pts);
        const per = this.W * this.L * 2;
        const lvl = Math.min(10, this.startLevel + Math.floor(this.cubes / per));
        if (lvl !== this.level) { this.level = lvl; this.onEvent('level'); }
      }

      const full = [];
      const per = this.W * this.L;
      for (let z = 0; z < this.D; z++) {
        let c = 0;
        for (let i = 0; i < per; i++) c += this.grid[z * per + i];
        if (c === per) full.push(z);
      }
      if (full.length) {
        this.phase = 'clearing';
        this.clearLayers = full;
        this.clearT = 380;
        this.onEvent('clear', full.length);
      } else {
        this.spawn();
      }
    }

    _finishClear() {
      const per = this.W * this.L;
      const full = new Set(this.clearLayers);
      const ng = new Uint8Array(this.grid.length);
      let wz = this.D - 1;
      for (let z = this.D - 1; z >= 0; z--) {
        if (full.has(z)) continue;
        ng.set(this.grid.subarray(z * per, (z + 1) * per), wz * per);
        wz--;
      }
      this.grid = ng;
      if (this.mode !== 'practice') {
        const k = full.size;
        this.score += Math.round(this.W * this.L * 10 * k * k * (1 + this.level * 0.5) * this.pitFactor);
        if (!ng.some((v) => v)) {
          this.score += Math.round(2000 * (1 + this.level) * this.pitFactor);
          this.onEvent('perfect');
        }
      }
      this.clearLayers = null;
      this.phase = 'falling';
      this.spawn();
    }

    layerCount(z) {
      const per = this.W * this.L;
      let c = 0;
      for (let i = 0; i < per; i++) c += this.grid[z * per + i];
      return c;
    }

    abort() { if (this.phase !== 'over') { this.phase = 'over'; this.onEvent('over'); } }
  }

  // ---------- Demo AI ----------
  function evaluate(game, cells, x, y) {
    if (!game.valid(cells, x, y, 0)) return null;
    let z = 0;
    while (game.valid(cells, x, y, z + 1)) z++;
    const { W, L, D } = game;
    const per = W * L;
    const g = game.grid.slice();
    for (const c of cells) g[((c[2] + z) * L + c[1] + y) * W + c[0] + x] = 1;
    // clear full layers
    let clears = 0;
    const ng = new Uint8Array(g.length);
    let wz = D - 1;
    for (let zz = D - 1; zz >= 0; zz--) {
      let c = 0;
      for (let i = 0; i < per; i++) c += g[zz * per + i];
      if (c === per) { clears++; continue; }
      ng.set(g.subarray(zz * per, (zz + 1) * per), wz * per);
      wz--;
    }
    const h = new Array(per).fill(0);
    let holes = 0, agg = 0, maxH = 0;
    for (let i = 0; i < per; i++) {
      let top = -1;
      for (let zz = 0; zz < D; zz++) if (ng[zz * per + i]) { top = zz; break; }
      if (top >= 0) {
        h[i] = D - top;
        for (let zz = top + 1; zz < D; zz++) if (!ng[zz * per + i]) holes++;
      }
      agg += h[i];
      if (h[i] > maxH) maxH = h[i];
    }
    let bump = 0;
    for (let yy = 0; yy < L; yy++) {
      for (let xx = 0; xx < W; xx++) {
        if (xx + 1 < W) bump += Math.abs(h[yy * W + xx] - h[yy * W + xx + 1]);
        if (yy + 1 < L) bump += Math.abs(h[yy * W + xx] - h[(yy + 1) * W + xx]);
      }
    }
    return { z, value: clears * 3 - 0.5 * agg - 4 * holes - 0.2 * bump - 0.6 * maxH };
  }

  // Choose a target orientation + position for the falling piece.
  function plan(game) {
    const p = game.piece;
    const start = normalize(p.cells);
    const seen = new Map([[keyOf(start), { cells: start, ops: [] }]]);
    const queue = [start];
    while (queue.length) {
      const c = queue.shift();
      const ops = seen.get(keyOf(c)).ops;
      for (const ax of ['x', 'y', 'z']) {
        const n = normalize(c.map((q) => ROT[ax](q, 1)));
        const k = keyOf(n);
        if (!seen.has(k)) { seen.set(k, { cells: n, ops: [...ops, [ax, 1]] }); queue.push(n); }
      }
    }
    let best = null;
    for (const s of seen.values()) {
      const d = bounds(s.cells);
      if (d[0] > game.W || d[1] > game.L || d[2] > game.D) continue;
      for (let y = 0; y <= game.L - d[1]; y++) {
        for (let x = 0; x <= game.W - d[0]; x++) {
          const r = evaluate(game, s.cells, x, y);
          if (r && (!best || r.value > best.value)) best = { value: r.value, ops: s.ops.slice(), tx: x, ty: y, key: keyOf(s.cells) };
        }
      }
    }
    return best;
  }

  const Core = { ROT, normalize, keyOf, bounds, orientations, ALL_SHAPES, SETS, poolFor, Game, plan, SPEEDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
