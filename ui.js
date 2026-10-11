// Polypit - rendering, menus, input
(function () {
  'use strict';
  const { Game, plan } = Core;

  const stage = document.getElementById('stage');
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const ui = document.getElementById('ui');
  const VW = 800, VH = 600;

  // ---------- persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const PRESETS = {
    'Flat Fun':       { set: 'flat',     W: 5, L: 5, D: 12 },
    '3-D Mania':      { set: 'basic',    W: 3, L: 3, D: 10 },
    'Out of Control': { set: 'extended', W: 5, L: 5, D: 12 },
  };
  const DEFAULT_SETUP = { set: 'flat', W: 5, L: 5, D: 12, speed: 'medium', sound: true };
  let setup = Object.assign({}, DEFAULT_SETUP, store.get('polypit.setup', {}));
  let ghost = store.get('polypit.ghost', false);

  const SET_NAMES = { flat: 'Flat', basic: 'Basic', extended: 'Extended' };
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const pitText = (s) => `${s.W}x${s.L}x${s.D}`;
  const hofKey = (s) => `polypit.hof.${s.set}.${Math.min(s.W, s.L)}x${Math.max(s.W, s.L)}x${s.D}`;
  // High scores live in SQLite behind /api/scores; localStorage is the offline fallback.
  const hofCache = {};
  const loadHof = (s) => hofCache[hofKey(s)] || store.get(hofKey(s), []);
  function refreshHof(s) {
    const k = hofKey(s);
    return fetch('/api/scores?key=' + encodeURIComponent(k))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((l) => { hofCache[k] = l; })
      .catch(() => {});
  }
  // The server issues a token when a game starts and rejects scores it deems implausible.
  function startGameToken() {
    return fetch('/api/games', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => j.id)
      .catch(() => null);
  }
  function submitHof(s, name, score, cubes, gameId) {
    const k = hofKey(s);
    return fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: k, name, score, cubes, gameId }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((l) => { hofCache[k] = l; return l; });
  }

  // ---------- sound ----------
  let actx = null;
  function beep(freq, dur, type, vol, toFreq) {
    if (!setup.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, t + dur);
      g.gain.setValueAtTime(vol || 0.04, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* audio unavailable */ }
  }
  const SFX = {
    move: () => beep(180, 0.025, 'square', 0.02),
    rotate: () => beep(420, 0.05, 'triangle', 0.05, 520),
    land: () => beep(120, 0.14, 'sawtooth', 0.06, 60),
    clear: (n) => { for (let i = 0; i < 3 + n; i++) setTimeout(() => beep(400 + i * 120, 0.09, 'square', 0.05), i * 70); },
    level: () => { [500, 650, 800].forEach((f, i) => setTimeout(() => beep(f, 0.1, 'triangle', 0.06), i * 90)); },
    perfect: () => { for (let i = 0; i < 8; i++) setTimeout(() => beep(300 + i * 100, 0.12, 'square', 0.05), i * 80); },
    over: () => { [400, 330, 260, 190].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'sawtooth', 0.06), i * 220)); },
    menu: () => beep(300, 0.03, 'square', 0.03),
  };
  function onGameEvent(name, arg) { if (SFX[name]) SFX[name](arg); }

  // ---------- scaling ----------
  let R = 1;
  function resize() {
    const s = Math.min(window.innerWidth / VW, window.innerHeight / VH);
    stage.style.transform = `translate(${-VW * s / 2}px, ${-VH * s / 2}px) scale(${s})`;
    R = s * (window.devicePixelRatio || 1);
    canvas.width = Math.round(VW * R);
    canvas.height = Math.round(VH * R);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- drawing helpers ----------
  const D0 = 8; // camera distance in cell units
  const VIEW = { x: 92, y: 14, w: 520, h: 572 };

  function makeView(W, L, D) {
    const cell = Math.min(VIEW.w / W, VIEW.h / L) * 0.98;
    const cx = VIEW.x + VIEW.w / 2, cy = VIEW.y + VIEW.h / 2;
    const proj = (x, y, z) => {
      const s = D0 / (D0 + z);
      return [cx + (x - W / 2) * cell * s, cy + (y - L / 2) * cell * s];
    };
    return { cell, cx, cy, proj };
  }

  function layerHue(z) { return (z * 67 + 8) % 360; }
  function layerColor(z, D, light, a) {
    const h = layerHue(z);
    const l = (z % 2 ? 46 : 58) * (light || 1);
    return `hsla(${h.toFixed(0)},85%,${l.toFixed(0)}%,${a === undefined ? 1 : a})`;
  }

  function poly(pts, fill, stroke, lw) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }

  function line(a, b) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }

  function drawWalls(W, L, D, P) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#5d5d5d';
    ctx.beginPath();
    for (let k = 1; k < D; k++) {
      ctx.moveTo(...P(0, 0, k)); ctx.lineTo(...P(W, 0, k)); ctx.lineTo(...P(W, L, k)); ctx.lineTo(...P(0, L, k)); ctx.closePath();
    }
    for (let i = 0; i <= W; i++) { line(P(i, 0, 0), P(i, 0, D)); line(P(i, L, 0), P(i, L, D)); }
    for (let j = 0; j <= L; j++) { line(P(0, j, 0), P(0, j, D)); line(P(W, j, 0), P(W, j, D)); }
    ctx.stroke();
    // floor
    ctx.strokeStyle = '#9a9a9a';
    ctx.beginPath();
    for (let i = 0; i <= W; i++) line(P(i, 0, D), P(i, L, D));
    for (let j = 0; j <= L; j++) line(P(0, j, D), P(W, j, D));
    ctx.stroke();
    // rim
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    poly([P(0, 0, 0), P(W, 0, 0), P(W, L, 0), P(0, L, 0)], null, '#fff', 2);
  }

  const orderCache = {};
  function cellOrder(W, L) {
    const k = W + 'x' + L;
    if (!orderCache[k]) {
      const a = [];
      for (let y = 0; y < L; y++) for (let x = 0; x < W; x++) a.push([x, y, (x + 0.5 - W / 2) ** 2 + (y + 0.5 - L / 2) ** 2]);
      a.sort((p, q) => q[2] - p[2]);
      orderCache[k] = a;
    }
    return orderCache[k];
  }

  function drawCube(x, y, z, W, L, D, P, g, flash) {
    const camX = W / 2, camY = L / 2;
    const has = (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < L && g.grid[g.idx(xx, yy, z)];
    const edge = 'rgba(0,0,0,.7)';
    const side = (pts, shade) => poly(pts, flash ? '#fff' : layerColor(z, D, shade), edge, 1);
    if (camX < x && !has(x - 1, y)) side([P(x, y, z), P(x, y + 1, z), P(x, y + 1, z + 1), P(x, y, z + 1)], 0.62);
    if (camX > x + 1 && !has(x + 1, y)) side([P(x + 1, y, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x + 1, y, z + 1)], 0.62);
    if (camY < y && !has(x, y - 1)) side([P(x, y, z), P(x + 1, y, z), P(x + 1, y, z + 1), P(x, y, z + 1)], 0.78);
    if (camY > y + 1 && !has(x, y + 1)) side([P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], 0.78);
    poly([P(x, y, z), P(x + 1, y, z), P(x + 1, y + 1, z), P(x, y + 1, z)], flash ? '#fff' : layerColor(z, D, 1.15), edge, 1);
  }

  const FACES = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5],
  ];
  const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

  function rotPoint(p, axis, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    if (axis === 'x') return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
    if (axis === 'y') return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
  }

  function drawPiece(g, P) {
    const p = g.piece, { W, L, D } = g;
    const ox = p.x + g.fx.x, oy = p.y + g.fx.y, oz = p.z + g.fx.z;
    let rot = null;
    if (g.fx.rot) {
      const t = g.fx.rot.age / g.fx.rot.dur;
      const e = 1 - (1 - t) * (1 - t);
      rot = { axis: g.fx.rot.axis, ang: -g.fx.rot.dir * (Math.PI / 2) * (1 - e), c: [p.dims[0] / 2, p.dims[1] / 2, p.dims[2] / 2] };
    }
    const faces = [];
    const occ = new Set(p.cells.map((c) => c.join(',')));
    for (const c of p.cells) {
      const pts = CORNERS.map((k) => {
        let q = [c[0] + k[0], c[1] + k[1], c[2] + k[2]];
        if (rot) {
          const r = rotPoint([q[0] - rot.c[0], q[1] - rot.c[1], q[2] - rot.c[2]], rot.axis, rot.ang);
          q = [r[0] + rot.c[0], r[1] + rot.c[1], r[2] + rot.c[2]];
        }
        return [q[0] + ox, q[1] + oy, q[2] + oz];
      });
      const dirs = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
      FACES.forEach((f, fi) => {
        const d = dirs[fi];
        if (occ.has([c[0] + d[0], c[1] + d[1], c[2] + d[2]].join(','))) return;
        const poly3 = f.map((i) => pts[i]);
        const mx = poly3.reduce((a, q) => a + q[0], 0) / 4 - W / 2;
        const my = poly3.reduce((a, q) => a + q[1], 0) / 4 - L / 2;
        const mz = poly3.reduce((a, q) => a + q[2], 0) / 4 + D0;
        faces.push({ poly3, dist: mx * mx + my * my + mz * mz, z: c[2] + p.z });
      });
    }
    faces.sort((a, b) => b.dist - a.dist);
    for (const f of faces) poly(f.poly3.map((q) => P(q[0], q[1], q[2])), layerColor(f.z, D, 1.25, 0.55), '#fff', 1.5);
  }

  function drawGhost(g, P) {
    const p = g.piece;
    const lz = g.landingZ();
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth = 1;
    for (const c of p.cells) {
      const x = c[0] + p.x, y = c[1] + p.y, z = c[2] + lz;
      poly([P(x, y, z), P(x + 1, y, z), P(x + 1, y + 1, z), P(x, y + 1, z)], 'rgba(255,255,255,.12)', 'rgba(255,255,255,.5)', 1);
    }
  }

  function drawPit(g, ghostOn) {
    const { W, L, D } = g;
    const v = makeView(W, L, D);
    const P = v.proj;
    ctx.save();
    ctx.beginPath();
    ctx.rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h);
    ctx.clip();
    drawWalls(W, L, D, P);
    const order = cellOrder(W, L);
    const flash = g.phase === 'clearing' && Math.floor(g.clearT / 70) % 2 === 0;
    const clearing = g.clearLayers ? new Set(g.clearLayers) : null;
    for (let z = D - 1; z >= 0; z--) {
      for (const o of order) {
        if (g.grid[g.idx(o[0], o[1], z)]) drawCube(o[0], o[1], z, W, L, D, P, g, flash && clearing.has(z));
      }
    }
    if (g.phase === 'falling' && g.piece) {
      if (ghostOn) drawGhost(g, P);
      drawPiece(g, P);
    }
    ctx.restore();
    return v;
  }

  // HUD ---------------------------------------------------------
  function hudBox(x, y, w, h, label, value, big) {
    ctx.fillStyle = '#cfcfcf';
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x + w / 2, y - 4);
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${big || 20}px "Courier New", monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x + w / 2, y + h / 2 + 1);
  }

  function drawHud(g, highScore, tag) {
    // layer bar
    hudBox(18, 30, 56, 40, 'LEVEL', g ? g.level : 0, 24);
    const bx = 30, by = 90, bw = 32, bh = 490;
    ctx.fillStyle = '#000'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, bh);
    if (g) {
      const sh = bh / g.D, per = g.W * g.L;
      for (let z = 0; z < g.D; z++) {
        const y = by + z * sh;
        const n = g.layerCount(z);
        if (n) {
          ctx.fillStyle = layerColor(z, g.D, 1);
          ctx.fillRect(bx + 2, y + 1, (bw - 4) * Math.max(0.25, n / per), sh - 1);
        }
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx + 8, y); ctx.stroke();
      }
      if (g.phase === 'falling' && g.piece) {
        const p = g.piece;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(bx - 4, by + p.z * sh, bw + 8, p.dims[2] * sh);
      }
    }
    // right panel
    const rx = 636, rw = 150;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = '900 40px Impact, "Arial Black", sans-serif';
    ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#0a9a3f';
    ctx.strokeText('POLY', rx + rw / 2, 50); ctx.fillText('POLY', rx + rw / 2, 50);
    ctx.fillStyle = '#fff'; ctx.fillRect(rx + 38, 56, 74, 22);
    ctx.fillStyle = '#000'; ctx.font = '900 20px Impact, "Arial Black", sans-serif';
    ctx.fillText('PIT', rx + rw / 2, 74);
    hudBox(rx, 115, rw, 40, 'SCORE', g ? g.score : 0);
    hudBox(rx, 190, rw, 40, 'CUBES PLAYED', g ? g.cubes : 0);
    hudBox(rx, 285, rw, 40, 'HIGH SCORE', highScore);
    hudBox(rx, 360, rw, 36, 'PIT', pitText(setup).replace(/x/g, ' x '), 18);
    hudBox(rx, 430, rw, 36, 'BLOCK SET', SET_NAMES[setup.set].toUpperCase(), 18);
    if (tag) {
      ctx.fillStyle = '#ffd84a'; ctx.font = 'bold 14px "Courier New", monospace'; ctx.textAlign = 'center';
      ctx.fillText(tag, rx + rw / 2, 520);
    }
    ctx.fillStyle = '#666'; ctx.font = '11px "Courier New", monospace';
    ctx.fillText(`G: guide ${ghost ? 'on' : 'off'}`, rx + rw / 2, 560);
    ctx.fillText(`O: sound ${setup.sound ? 'on' : 'off'}`, rx + rw / 2, 576);
  }

  function banner(text, sub) {
    ctx.fillStyle = 'rgba(0,0,0,.85)';
    const w = 360, h = sub ? 90 : 60, x = VIEW.x + VIEW.w / 2 - w / 2, y = VIEW.y + VIEW.h / 2 - h / 2;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.fillText(text, x + w / 2, y + (sub ? 32 : h / 2));
    if (sub) { ctx.font = 'bold 15px "Courier New", monospace'; ctx.fillStyle = '#ffd84a'; ctx.fillText(sub, x + w / 2, y + 66); }
  }

  // ---------- screen manager ----------
  let screen = null;
  function setScreen(s) {
    if (screen && screen.leave) screen.leave();
    screen = s;
    ui.innerHTML = '';
    if (s.enter) s.enter();
  }

  // Generic keyboard/mouse menu.
  function menuScreen(def) {
    let sel = def.start || 0;
    const el = document.createElement('div');
    el.className = 'panel';
    const items = () => (typeof def.items === 'function' ? def.items() : def.items);
    function render() {
      el.innerHTML = '';
      if (def.title) { const h = document.createElement('h2'); h.textContent = def.title; el.appendChild(h); }
      items().forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'item' + (i === sel ? ' sel' : '');
        const l = document.createElement('span'); l.textContent = it.label;
        d.appendChild(l);
        if (it.value) { const v = document.createElement('span'); v.className = 'v'; v.textContent = it.value(); d.appendChild(v); }
        d.addEventListener('mouseenter', () => { if (sel !== i) { sel = i; render(); } });
        d.addEventListener('click', () => activate(i));
        el.appendChild(d);
      });
      if (def.hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = def.hint; el.appendChild(h); }
    }
    function activate(i) {
      sel = i;
      const it = items()[i];
      SFX.menu();
      if (it.act) it.act();
      if (screen === me) render();
    }
    const me = {
      enter() { ui.appendChild(el); render(); idleReset(); },
      key(e) {
        idleReset();
        const list = items();
        if (e.code === 'ArrowUp') { sel = (sel + list.length - 1) % list.length; render(); }
        else if (e.code === 'ArrowDown') { sel = (sel + 1) % list.length; render(); }
        else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
          const it = list[sel];
          const f = e.code === 'ArrowLeft' ? it.left : it.right;
          if (f) { f(); SFX.menu(); render(); }
        } else if (e.code === 'Enter' || e.code === 'NumpadEnter') activate(sel);
        else if (e.code === 'Escape') { if (def.onEsc) def.onEsc(); }
        else if (e.key.length === 1 && /[a-z]/i.test(e.key)) {
          const k = e.key.toLowerCase();
          const i = list.findIndex((it) => it.hotkey === k);
          if (i >= 0) activate(i);
        } else return false;
        return true;
      },
      draw() { drawBackdrop(); },
      update() { if (def.idleDemo && performance.now() - idleAt > 30000) startDemo(); },
    };
    return me;
  }

  let idleAt = performance.now();
  function idleReset() { idleAt = performance.now(); }

  function drawBackdrop() {
    const g = { W: setup.W, L: setup.L, D: setup.D, grid: new Uint8Array(setup.W * setup.L * setup.D), idx(x, y, z) { return (z * this.L + y) * this.W + x; }, phase: 'idle', level: 0, score: 0, cubes: 0, layerCount() { return 0; } };
    drawPit(g, false);
    drawHud(g, (loadHof(setup)[0] || { score: 0 }).score);
  }

  // ---------- screens ----------
  function titleScreen() {
    const el = document.createElement('div');
    el.innerHTML = '<div class="panel" style="text-align:center"><div class="logo"><div class="b">POLY</div><div class="o">PIT</div></div>' +
      '<div>3-D action and strategy</div><div class="blink">press any key</div>' +
      '<div class="hint">In the spirit of Blockout (California Dreams, 1989)</div></div>';
    return {
      enter() { ui.appendChild(el.firstChild); },
      key(e) { if (/^(Shift|Control|Alt|Meta)/.test(e.code)) return false; setScreen(mainMenu()); return true; },
      draw() { drawBackdrop(); },
    };
  }

  function mainMenu() {
    return menuScreen({
      title: 'POLYPIT',
      idleDemo: true,
      hint: `Setup: ${SET_NAMES[setup.set]} set, pit ${pitText(setup)}`,
      items: [
        { label: 'Start Game', hotkey: 's', act: () => setScreen(levelScreen()) },
        { label: 'Choose Setup', hotkey: 'c', act: () => setScreen(setupMenu('main')) },
        { label: 'Write Setup', hotkey: 'w', act: () => { store.set('polypit.setup', setup); } },
        { label: 'Practice Mode', hotkey: 'p', act: () => setScreen(playScreen('practice', 0)) },
        { label: 'Demo', hotkey: 'd', act: () => startDemo() },
        { label: 'Help', hotkey: 'h', act: () => setScreen(helpScreen()) },
        { label: 'Quit Game', hotkey: 'q', act: () => setScreen(titleScreen()) },
      ],
      onEsc: () => {},
    });
  }

  function startDemo() { setScreen(playScreen('demo', 0)); }

  function setupMenu(back) {
    const cycle = (arr, cur, d) => arr[(arr.indexOf(cur) + d + arr.length) % arr.length];
    const sets = ['flat', 'basic', 'extended'], speeds = ['fast', 'medium', 'slow'];
    const clampv = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const saved = Object.assign({}, setup);
    const presetName = () => Object.keys(PRESETS).find((k) => {
      const p = PRESETS[k]; return p.set === setup.set && p.W === setup.W && p.L === setup.L && p.D === setup.D;
    }) || 'Custom';
    const applyPreset = (n) => { Object.assign(setup, PRESETS[n]); };
    const presetNames = Object.keys(PRESETS);
    const stepPreset = (d) => {
      const cur = presetNames.indexOf(presetName());
      applyPreset(presetNames[(cur + d + presetNames.length) % presetNames.length]);
    };
    const m = menuScreen({
      title: 'CHOOSE SETUP',
      hint: 'Up/Down select · Left/Right change · Esc cancel',
      items: () => [
        { label: 'Predefined', hotkey: 'p', value: presetName, left: () => stepPreset(-1), right: () => stepPreset(1), act: () => stepPreset(1) },
        { label: 'Block Set', hotkey: 'b', value: () => SET_NAMES[setup.set], left: () => { setup.set = cycle(sets, setup.set, -1); }, right: () => { setup.set = cycle(sets, setup.set, 1); }, act: () => { setup.set = cycle(sets, setup.set, 1); } },
        { label: 'Rotation Speed', hotkey: 'r', value: () => cap(setup.speed), left: () => { setup.speed = cycle(speeds, setup.speed, -1); }, right: () => { setup.speed = cycle(speeds, setup.speed, 1); }, act: () => { setup.speed = cycle(speeds, setup.speed, 1); } },
        { label: 'Pit Width', hotkey: 'w', value: () => setup.W, left: () => { setup.W = clampv(setup.W - 1, 3, 7); }, right: () => { setup.W = clampv(setup.W + 1, 3, 7); }, act: () => { setup.W = setup.W >= 7 ? 3 : setup.W + 1; } },
        { label: 'Pit Length', hotkey: 'l', value: () => setup.L, left: () => { setup.L = clampv(setup.L - 1, 3, 7); }, right: () => { setup.L = clampv(setup.L + 1, 3, 7); }, act: () => { setup.L = setup.L >= 7 ? 3 : setup.L + 1; } },
        { label: 'Pit Depth', hotkey: 'd', value: () => setup.D, left: () => { setup.D = clampv(setup.D - 1, 6, 18); }, right: () => { setup.D = clampv(setup.D + 1, 6, 18); }, act: () => { setup.D = setup.D >= 18 ? 6 : setup.D + 1; } },
        { label: 'Sound', hotkey: 'o', value: () => (setup.sound ? 'On' : 'Off'), left: () => { setup.sound = !setup.sound; }, right: () => { setup.sound = !setup.sound; }, act: () => { setup.sound = !setup.sound; } },
        { label: 'Start Game', hotkey: 's', act: () => setScreen(levelScreen()) },
        { label: 'Write Setup', hotkey: 'u', act: () => store.set('polypit.setup', setup) },
        { label: 'Main Menu', hotkey: 'm', act: () => setScreen(mainMenu()) },
        { label: 'Cancel', hotkey: 'x', act: () => { Object.assign(setup, saved); setScreen(mainMenu()); } },
      ],
      onEsc: () => { Object.assign(setup, saved); setScreen(mainMenu()); },
    });
    return m;
  }

  function levelScreen() {
    let sel = 0;
    const el = document.createElement('div');
    el.className = 'panel';
    function render() {
      el.innerHTML = '<h2>STARTING LEVEL</h2><div class="levels"></div><div class="hint">0 (easiest) – 9 · Enter to start · Esc back</div>';
      const row = el.querySelector('.levels');
      for (let i = 0; i < 10; i++) {
        const d = document.createElement('div');
        d.className = 'item' + (i === sel ? ' sel' : '');
        d.textContent = i;
        d.addEventListener('click', () => setScreen(playScreen('game', i)));
        row.appendChild(d);
      }
    }
    return {
      enter() { ui.appendChild(el); render(); },
      key(e) {
        if (/^(Digit|Numpad)\d$/.test(e.code)) { setScreen(playScreen('game', +e.code.slice(-1))); return true; }
        if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') { sel = (sel + 9) % 10; render(); return true; }
        if (e.code === 'ArrowRight' || e.code === 'ArrowDown') { sel = (sel + 1) % 10; render(); return true; }
        if (e.code === 'Enter' || e.code === 'NumpadEnter') { setScreen(playScreen('game', sel)); return true; }
        if (e.code === 'Escape') { setScreen(mainMenu()); return true; }
        return false;
      },
      draw() { drawBackdrop(); },
    };
  }

  function helpScreen() {
    const el = document.createElement('div');
    el.className = 'panel';
    el.innerHTML = '<h2>HELP</h2><table class="keys">' +
      '<tr><td>Numpad 4 / 6 / 8 / 2</td><td>move left / right / up / down</td></tr>' +
      '<tr><td>Numpad 7 / 9 / 1 / 3</td><td>move diagonally</td></tr>' +
      '<tr><td>Arrow keys, mouse</td><td>also move the block (click drops it)</td></tr>' +
      '<tr><td>Q / W / E</td><td>flip X / turn Y / spin Z, counter-clockwise</td></tr>' +
      '<tr><td>A / S / D</td><td>flip X / turn Y / spin Z, clockwise</td></tr>' +
      '<tr><td>Space</td><td>drop the block (a brief moment to still adjust)</td></tr>' +
      '<tr><td>P</td><td>pause / resume</td></tr>' +
      '<tr><td>O</td><td>sound on / off</td></tr>' +
      '<tr><td>G</td><td>landing guide on / off (extra)</td></tr>' +
      '<tr><td>Esc</td><td>abort the game / leave menu</td></tr>' +
      '</table><div class="hint">Fill whole layers to clear them. Don’t let the stack reach the top.<br>Press any key to return.</div>';
    return {
      enter() { ui.appendChild(el); },
      key() { setScreen(mainMenu()); return true; },
      draw() { drawBackdrop(); },
    };
  }

  // ---------- hall of fame ----------
  function hofScreen(score, cubes, gameId) {
    const list = loadHof(setup);
    const qualifies = score > 0 && (list.length < 10 || score > list[list.length - 1].score);
    let name = '';
    let saved = !qualifies;
    let row = -1;
    if (qualifies) {
      row = list.findIndex((r) => score > r.score);
      if (row < 0) row = list.length;
    }
    const el = document.createElement('div');
    el.className = 'panel';
    let input = null;
    function render() {
      const rows = list.slice();
      if (qualifies && !saved) rows.splice(row, 0, { name: null, score });
      let html = `<h2>HALL OF FAME</h2><div class="hint" style="margin:-6px 0 8px">${SET_NAMES[setup.set]} set · pit ${pitText(setup)}</div><table class="hof">`;
      for (let i = 0; i < 10; i++) {
        const r = rows[i];
        const me = r && r.name === null;
        html += `<tr class="${me ? 'me' : ''}"><td>${i + 1}.</td><td>${r ? (me ? '<input class="name" maxlength="12">' : esc(r.name || '---')) : ''}</td><td class="r">${r ? r.score : ''}</td></tr>`;
      }
      html += '</table>';
      el.innerHTML = html;
      input = el.querySelector('input');
      if (input) { input.focus(); input.value = name; input.addEventListener('input', () => { name = input.value; }); }
      if (saved) {
        const m = menuScreen({
          items: [
            { label: 'Start Game', hotkey: 's', act: () => setScreen(levelScreen()) },
            { label: 'Choose Setup', hotkey: 'c', act: () => setScreen(setupMenu('hof')) },
            { label: 'Main Menu', hotkey: 'm', act: () => setScreen(mainMenu()) },
            { label: 'Quit Game', hotkey: 'q', act: () => setScreen(titleScreen()) },
          ],
          onEsc: () => setScreen(mainMenu()),
        });
        sub = m;
        const holder = document.createElement('div');
        el.appendChild(holder);
        const tmp = document.createElement('div');
        ui.appendChild(tmp);
        m.enter();
        // move the generated panel's items inside ours
        const p = ui.lastElementChild;
        if (p && p !== el) { p.style.border = 'none'; p.style.boxShadow = 'none'; p.style.padding = '0'; p.style.minWidth = '0'; holder.appendChild(p); }
        tmp.remove();
      } else {
        el.insertAdjacentHTML('beforeend', '<div class="hint">Type your name · Enter saves · Esc cancels</div>');
      }
    }
    let sub = null;
    function save() {
      list.splice(row, 0, { name: name.trim() || 'Anonymous', score });
      list.length = Math.min(list.length, 10);
      store.set(hofKey(setup), list);
      hofCache[hofKey(setup)] = list;
      saved = true;
      render();
      const entry = list[row];
      submitHof(setup, entry.name, score, cubes, gameId).then((l) => {
        list.splice(0, list.length, ...l);
        store.set(hofKey(setup), l);
        if (screen === me) render();
      }).catch((status) => {
        if (status !== 422) return; // offline: keep the local entry
        // The server ignored the score: restore the authoritative list.
        refreshHof(setup).then(() => {
          list.splice(0, list.length, ...loadHof(setup).filter((r) => r !== entry));
          store.set(hofKey(setup), list);
          if (screen === me) render();
        });
      });
    }
    const me = {
      enter() { ui.appendChild(el); render(); },
      key(e) {
        if (!saved) {
          if (e.code === 'Enter' || e.code === 'NumpadEnter') { save(); return true; }
          if (e.code === 'Escape') { saved = true; list.splice(0, list.length, ...loadHof(setup)); render(); return true; }
          return false; // let the input take typing
        }
        return sub ? sub.key(e) : false;
      },
      draw() { drawBackdrop(); },
    };
    return me;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- play ----------
  const MOVES = {
    Numpad1: [-1, 1], Numpad2: [0, 1], Numpad3: [1, 1], Numpad4: [-1, 0], Numpad6: [1, 0],
    Numpad7: [-1, -1], Numpad8: [0, -1], Numpad9: [1, -1],
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  };
  const ROTS = { KeyQ: ['x', 1], KeyW: ['y', 1], KeyE: ['z', 1], KeyA: ['x', -1], KeyS: ['y', -1], KeyD: ['z', -1] };

  function playScreen(mode, level) {
    let g = null, paused = false, view = null, demo = null, overTimer = 0, hof = 0, gameId = null;
    const newGame = () => new Game({
      W: setup.W, L: setup.L, D: setup.D, set: setup.set, speed: setup.speed,
      mode, level, onEvent: mode === 'demo' ? () => {} : onGameEvent,
    });
    const finish = () => {
      if (mode === 'practice' || mode === 'demo') { setScreen(mainMenu()); return; }
      refreshHof(setup).then(() => { if (screen === s) setScreen(hofScreen(g.score, g.cubes, gameId)); });
    };
    const s = {
      enter() {
        g = newGame();
        hof = (loadHof(setup)[0] || { score: 0 }).score;
        refreshHof(setup).then(() => { hof = (loadHof(setup)[0] || { score: 0 }).score; });
        demo = { plan: null, pid: -1, t: 0 };
        if (mode === 'game') startGameToken().then((id) => { gameId = id; });
      },
      key(e) {
        const c = e.code;
        if (mode === 'demo') {
          if (/^(Shift|Control|Alt|Meta)/.test(c)) return false;
          setScreen(mainMenu()); return true;
        }
        if (g.phase === 'over') {
          if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space' || c === 'Escape') { finish(); return true; }
          return false;
        }
        if (c === 'Escape') {
          if (mode === 'practice') { setScreen(mainMenu()); return true; }
          g.abort(); return true;
        }
        if (c === 'KeyP') { paused = !paused; return true; }
        if (c === 'KeyO') { setup.sound = !setup.sound; return true; }
        if (c === 'KeyG') { ghost = !ghost; store.set('polypit.ghost', ghost); return true; }
        if (paused) return false;
        if (MOVES[c]) {
          const m = MOVES[c];
          if (!g.move(m[0], m[1]) && m[0] && m[1]) { if (!g.move(m[0], 0)) g.move(0, m[1]); }
          return true;
        }
        if (ROTS[c]) { g.rotate(ROTS[c][0], ROTS[c][1]); return true; }
        if (c === 'Space') { g.hardDrop(); return true; }
        return false;
      },
      mouse(type, mx, my) {
        if (mode === 'demo') { if (type === 'down') setScreen(mainMenu()); return; }
        if (!g || paused || g.phase !== 'falling' || !view) return;
        if (type === 'down') { g.hardDrop(); return; }
        const p = g.piece;
        const sc = D0 / (D0 + p.z);
        const gx = (mx - view.cx) / (view.cell * sc) + g.W / 2;
        const gy = (my - view.cy) / (view.cell * sc) + g.L / 2;
        g.moveTo(Math.round(gx - p.dims[0] / 2), Math.round(gy - p.dims[1] / 2));
      },
      update(dt) {
        if (paused) return;
        if (mode === 'demo') this.runDemo(dt);
        g.update(dt);
        if (g.phase === 'over' && mode === 'demo') {
          overTimer += dt;
          if (overTimer > 1800) { overTimer = 0; g = newGame(); demo.plan = null; }
        }
      },
      runDemo(dt) {
        demo.t -= dt;
        if (demo.t > 0 || g.phase !== 'falling' || g.dropping) return;
        demo.t = 110;
        if (demo.pid !== g.pieceId) { demo.pid = g.pieceId; demo.plan = plan(g); demo.fixed = false; }
        const pl = demo.plan;
        if (!pl) { g.hardDrop(); return; }
        if (pl.ops.length) { const op = pl.ops.shift(); g.rotate(op[0], op[1]); return; }
        if (!demo.fixed && Core.keyOf(Core.normalize(g.piece.cells)) !== pl.key) {
          demo.fixed = true; demo.plan = plan(g); return;
        }
        const p = g.piece;
        const dx = Math.sign(pl.tx - p.x), dy = Math.sign(pl.ty - p.y);
        if (dx || dy) { if (!g.move(dx, dy) && !g.move(dx, 0) && !g.move(0, dy)) g.hardDrop(); return; }
        g.hardDrop();
      },
      draw() {
        view = drawPit(g, ghost && mode !== 'demo');
        drawHud(g, Math.max(hof, g.score), mode === 'practice' ? 'PRACTICE' : mode === 'demo' ? 'DEMO – press any key' : '');
        if (paused) banner('PAUSED', 'press P to resume');
        else if (g.phase === 'over' && mode !== 'demo') banner('GAME OVER', 'press Enter');
      },
    };
    return s;
  }

  // ---------- input / main loop ----------
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!screen || !screen.key) return;
    const typing = e.target && e.target.tagName === 'INPUT';
    const handled = screen.key(e);
    if (handled || (!typing && /^(Arrow|Numpad|Space|Page|Home|End)/.test(e.code))) e.preventDefault();
  });

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * VW, (e.clientY - r.top) / r.height * VH];
  }
  canvas.addEventListener('mousemove', (e) => { if (screen && screen.mouse) { const p = canvasPoint(e); screen.mouse('move', p[0], p[1]); } });
  canvas.addEventListener('mousedown', (e) => { if (screen && screen.mouse) { const p = canvasPoint(e); screen.mouse('down', p[0], p[1]); e.preventDefault(); } });
  ui.addEventListener('mousedown', (e) => { if (screen && screen.mouse && e.target === ui) { const p = canvasPoint(e); screen.mouse('down', p[0], p[1]); } });
  ui.addEventListener('mousemove', (e) => { if (screen && screen.mouse && e.target === ui) { const p = canvasPoint(e); screen.mouse('move', p[0], p[1]); } });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(60, now - last);
    last = now;
    if (screen && screen.update) screen.update(dt);
    renderFrame();
    requestAnimationFrame(frame);
  }
  function renderFrame() {
    ctx.setTransform(R, 0, 0, R, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, VW, VH);
    if (screen && screen.draw) screen.draw();
  }

  setScreen(titleScreen());
  requestAnimationFrame(frame);

  // Hook for automated tests.
  window.__polypit = { get screen() { return screen; }, setScreen, playScreen, mainMenu, renderFrame };
})();
