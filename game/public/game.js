'use strict';

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const WORLD = 3200;
  const CELL = 80;
  const MAX_ENEMIES = 380;
  const MAX_PARTICLES = 1400;
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // ---------- canvas ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- storage ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('legion.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('legion.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    },
  };
  const settings = {
    autoAim: store.get('autoAim', isTouch),
    autoFire: store.get('autoFire', isTouch),
    muted: store.get('muted', false),
  };

  // ---------- audio (synthesized, no assets) ----------
  const Sound = {
    ac: null,
    last: {},
    defs: {
      shoot: [620, 220, 0.06, 'square', 0.025, 0.045],
      hit: [240, 90, 0.07, 'sawtooth', 0.03, 0.03],
      kill: [320, 60, 0.14, 'triangle', 0.07, 0.03],
      pickup: [700, 1300, 0.07, 'sine', 0.04, 0.03],
      power: [300, 1500, 0.3, 'triangle', 0.1, 0],
      level: [400, 1400, 0.45, 'triangle', 0.12, 0],
      hurt: [160, 50, 0.25, 'sawtooth', 0.12, 0.1],
      boom: [110, 25, 0.6, 'sawtooth', 0.18, 0.1],
      dash: [260, 900, 0.12, 'sine', 0.07, 0],
      eshoot: [900, 400, 0.08, 'square', 0.015, 0.08],
    },
    init() {
      if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
      try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ac = null; }
    },
    play(type) {
      if (settings.muted || !this.ac) return;
      const d = this.defs[type];
      const now = this.ac.currentTime;
      if (this.last[type] && now - this.last[type] < d[5]) return;
      this.last[type] = now;
      const o = this.ac.createOscillator();
      const g = this.ac.createGain();
      o.type = d[3];
      o.frequency.setValueAtTime(d[0], now);
      o.frequency.exponentialRampToValueAtTime(d[1], now + d[2]);
      g.gain.setValueAtTime(d[4], now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d[2]);
      o.connect(g).connect(this.ac.destination);
      o.start(now);
      o.stop(now + d[2] + 0.02);
    },
  };

  // ---------- content ----------
  const UPGRADES = [
    { id: 'dmg', ico: '💥', name: 'כוח אש', desc: '+25% נזק לכל הנשקים', max: 10, apply: (p) => { p.damage *= 1.25; } },
    { id: 'rate', ico: '⚡', name: 'קצב ירי', desc: '+18% קצב ירי', max: 10, apply: (p) => { p.fireRate *= 1.18; } },
    { id: 'multi', ico: '🔱', name: 'ירי מרובה', desc: '+1 קליע בכל ירייה', max: 6, apply: (p) => { p.multishot += 1; } },
    { id: 'pierce', ico: '🗡️', name: 'חודר שריון', desc: 'קליעים עוברים דרך אויב נוסף', max: 5, apply: (p) => { p.pierce += 1; } },
    { id: 'speed', ico: '👟', name: 'מגפי ריצה', desc: '+10% מהירות תנועה', max: 6, apply: (p) => { p.speed *= 1.1; } },
    { id: 'hp', ico: '❤️', name: 'שריון גוף', desc: '+25 חיים מקסימליים וריפוי', max: 8, apply: (p) => { p.maxHp += 25; p.hp = Math.min(p.maxHp, p.hp + 25); } },
    { id: 'regen', ico: '💚', name: 'התחדשות', desc: '+1 חיים לשנייה', max: 6, apply: (p) => { p.regen += 1; } },
    { id: 'magnet', ico: '🧲', name: 'מגנט', desc: '+40% טווח איסוף', max: 5, apply: (p) => { p.magnet *= 1.4; } },
    { id: 'crit', ico: '🎯', name: 'פגיעה קריטית', desc: '+8% סיכוי לנזק כפול וחצי', max: 6, apply: (p) => { p.crit += 0.08; } },
    { id: 'orbit', ico: '🌀', name: 'להבים מסתובבים', desc: '+1 להב שחותך אויבים וחוסם קליעים', max: 6, apply: (p) => { p.orbitals += 1; } },
    { id: 'explode', ico: '🔥', name: 'קליעים נפיצים', desc: 'פיצוץ באזור הפגיעה (+רדיוס ונזק)', max: 4, apply: (p) => { p.explosive += 1; } },
    { id: 'drone', ico: '🛸', name: 'רחפן תקיפה', desc: 'רחפן שיורה לבד באויב הקרוב', max: 4, apply: (p) => { p.drones += 1; } },
    { id: 'dash', ico: '💨', name: 'זינוק משופר', desc: '-20% זמן טעינה לזינוק', max: 4, apply: (p) => { p.dashCd *= 0.8; } },
    { id: 'vamp', ico: '🩸', name: 'ערפד', desc: '+2% מהנזק חוזר כחיים', max: 5, apply: (p) => { p.lifesteal += 0.02; } },
    { id: 'armor', ico: '🛡️', name: 'מגן', desc: '-8% נזק נכנס', max: 5, apply: (p) => { p.armor += 0.08; } },
    { id: 'bspeed', ico: '🔭', name: 'קנה ארוך', desc: '+20% מהירות וטווח קליע', max: 4, apply: (p) => { p.bulletSpeed *= 1.2; } },
  ];
  const UPG = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

  const ETYPES = {
    grunt: { r: 14, hp: 22, speed: 105, dmg: 10, xp: 1, color: '#ff4d6d', score: 10, sides: 0 },
    runner: { r: 10, hp: 12, speed: 195, dmg: 8, xp: 1, color: '#ffb703', score: 12, sides: 3 },
    shooter: { r: 15, hp: 35, speed: 85, dmg: 10, xp: 3, color: '#00f5d4', score: 30, sides: 4 },
    tank: { r: 26, hp: 150, speed: 55, dmg: 25, xp: 5, color: '#9b5de5', score: 40, sides: 6 },
    splitter: { r: 20, hp: 60, speed: 80, dmg: 15, xp: 3, color: '#f15bb5', score: 30, sides: 5 },
    boss: { r: 58, hp: 2200, speed: 75, dmg: 35, xp: 40, color: '#ff006e', score: 1000, sides: 8 },
  };

  // ---------- input ----------
  const keys = new Set();
  const mouse = { x: W / 2, y: H / 2, down: false };
  const stick = { id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  let dashRequested = false;
  let touchMode = false; // last input came from a touchscreen

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    keys.add(e.code); // e.code is layout independent (works with a Hebrew keyboard)
    if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
    else if (e.code === 'KeyM') toggleSetting('muted');
    else if (e.code === 'KeyQ') toggleSetting('autoAim');
    else if (e.code === 'KeyF') toggleSetting('autoFire');
    else if ((e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) dashRequested = true;
    else if (G && G.state === 'levelup' && /^(Digit|Numpad)[1-3]$/.test(e.code)) pickUpgrade(Number(e.code.slice(-1)) - 1);
    else if (e.code === 'Enter' && (!G || G.state === 'menu')) startGame();
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => {
    keys.clear();
    mouse.down = false;
    if (G && G.state === 'playing') togglePause();
  });
  canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; touchMode = false; });
  canvas.addEventListener('mousedown', (e) => {
    Sound.init();
    if (e.button === 0) mouse.down = true;
    if (e.button === 2) dashRequested = true;
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.down = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('touchstart', (e) => {
    Sound.init();
    touchMode = true;
    for (const t of e.changedTouches) {
      if (t.clientX < W * 0.5 && stick.id === null) {
        stick.id = t.identifier;
        stick.ox = t.clientX;
        stick.oy = t.clientY;
        stick.dx = stick.dy = 0;
      } else {
        dashRequested = true;
      }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stick.id) continue;
      let dx = t.clientX - stick.ox, dy = t.clientY - stick.oy;
      const len = Math.hypot(dx, dy);
      const R = 60;
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      stick.dx = dx / R;
      stick.dy = dy / R;
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) if (t.identifier === stick.id) { stick.id = null; stick.dx = stick.dy = 0; }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  // ---------- game state ----------
  let G = null;
  let enemyId = 0;

  function newPlayer() {
    return {
      x: WORLD / 2, y: WORLD / 2, r: 16, angle: 0, vx: 0, vy: 0,
      hp: 100, maxHp: 100, speed: 250, damage: 12, fireRate: 4, bulletSpeed: 750,
      multishot: 1, pierce: 0, crit: 0.05, regen: 0, magnet: 140, orbitals: 0, explosive: 0,
      drones: 0, dashCd: 2.2, lifesteal: 0, armor: 0,
      fireTimer: 0, dashTimer: 0, dashing: 0, invuln: 0, rapid: 0, droneTimer: 0,
      level: 1, xp: 0, xpNext: 5, upgrades: {},
    };
  }

  function newGame() {
    return {
      state: 'playing', player: newPlayer(),
      enemies: [], bullets: [], ebullets: [], pickups: [], particles: [], texts: [], trails: [],
      wave: 1, waveTime: 0, waveLen: 30, spawnTimer: 1, bossAlive: false,
      score: 0, kills: 0, time: 0, combo: 0, comboTimer: 0, bestCombo: 0,
      shake: 0, flash: 0, cam: { x: WORLD / 2, y: WORLD / 2 }, orbitAngle: 0,
      pendingLevels: 0, choices: [], submitted: false,
    };
  }

  // ---------- spatial grid ----------
  const grid = new Map();
  function buildGrid() {
    grid.clear();
    for (const e of G.enemies) {
      if (e.dead) continue;
      const k = ((e.x / CELL) | 0) * 1000 + ((e.y / CELL) | 0);
      let a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(e);
    }
  }
  function query(x, y, r) {
    const out = [];
    const pad = r + 60;
    const x0 = Math.max(0, ((x - pad) / CELL) | 0), x1 = ((x + pad) / CELL) | 0;
    const y0 = Math.max(0, ((y - pad) / CELL) | 0), y1 = ((y + pad) / CELL) | 0;
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        const a = grid.get(i * 1000 + j);
        if (a) for (const e of a) if (!e.dead) out.push(e);
      }
    }
    return out;
  }
  function nearestEnemy(x, y, maxDist) {
    let best = null, bd = maxDist * maxDist;
    for (const e of G.enemies) {
      if (e.dead) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // ---------- effects ----------
  function burst(x, y, color, n, speed, size = 3) {
    for (let i = 0; i < n && G.particles.length < MAX_PARTICLES; i++) {
      const a = rand(0, TAU), s = rand(speed * 0.2, speed);
      G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.8), max: 0.8, color, size: rand(1, size) });
    }
  }
  function addText(x, y, text, color, big) {
    if (G.texts.length > 140) G.texts.shift();
    G.texts.push({ x: x + rand(-8, 8), y, text, color, life: 0.8, big });
  }
  let announceTimer = null;
  function announce(msg, ms = 1800) {
    const el = $('announce');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------- spawning ----------
  function spawnEnemy(type, x, y) {
    const t = ETYPES[type];
    const scale = 1 + 0.18 * (G.wave - 1);
    let hp = t.hp * scale;
    if (type === 'boss') hp *= 1 + 0.6 * (Math.floor(G.wave / 5) - 1);
    const e = {
      id: ++enemyId, type, x: clamp(x, t.r, WORLD - t.r), y: clamp(y, t.r, WORLD - t.r), r: t.r,
      hp, maxHp: hp, speed: t.speed * (1 + Math.min(0.5, G.wave * 0.02)),
      dmg: t.dmg * (1 + 0.06 * (G.wave - 1)), xp: t.xp, color: t.color, score: t.score, sides: t.sides,
      hit: 0, orbHit: 0, shootTimer: rand(1, 2.5), t: rand(0, 10), charge: 0, dead: false, rot: rand(0, TAU),
    };
    G.enemies.push(e);
    return e;
  }
  function pickType() {
    const w = G.wave;
    const pool = [['grunt', 10], ['runner', w >= 2 ? 6 : 0], ['shooter', w >= 3 ? 4 : 0], ['tank', w >= 4 ? 3 : 0], ['splitter', w >= 6 ? 3 : 0]];
    let total = 0;
    for (const [, wt] of pool) total += wt;
    let r = Math.random() * total;
    for (const [type, wt] of pool) { r -= wt; if (r <= 0) return type; }
    return 'grunt';
  }
  function spawnAroundPlayer(type) {
    const p = G.player;
    const a = rand(0, TAU);
    const d = Math.max(W, H) / 2 + rand(60, 160);
    return spawnEnemy(type, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d);
  }

  function updateWave(dt) {
    if (!G.bossAlive) G.waveTime += dt;
    if (G.waveTime >= G.waveLen) {
      G.wave++;
      G.waveTime = 0;
      G.score += G.wave * 100;
      if (G.wave % 5 === 0) {
        spawnAroundPlayer('boss');
        G.bossAlive = true;
        announce(`גל ${G.wave} — בוס!`, 2500);
        Sound.play('boom');
      } else {
        announce(`גל ${G.wave}`);
      }
    }
    G.spawnTimer -= dt;
    if (G.spawnTimer <= 0) {
      const interval = Math.max(0.14, 0.8 * Math.pow(0.9, G.wave - 1));
      G.spawnTimer = G.bossAlive ? interval * 2 : interval;
      const batch = 2 + Math.floor(G.wave / 3);
      for (let i = 0; i < batch && G.enemies.length < MAX_ENEMIES; i++) spawnAroundPlayer(pickType());
    }
  }

  // ---------- combat ----------
  function comboMult() {
    return Math.min(4, 1 + Math.floor(G.combo / 10) * 0.5);
  }

  function damagePlayer(amount) {
    const p = G.player;
    if (p.invuln > 0 || G.state !== 'playing') return;
    const dmg = amount * (1 - Math.min(0.6, p.armor));
    p.hp -= dmg;
    p.invuln = 0.6;
    G.shake = Math.max(G.shake, 12);
    G.flash = 0.35;
    G.combo = 0;
    Sound.play('hurt');
    burst(p.x, p.y, '#ff4d6d', 16, 260);
    if (p.hp <= 0) { p.hp = 0; gameOver(); }
  }

  function damageEnemy(e, dmg, kx, ky, crit) {
    if (e.dead) return;
    e.hp -= dmg;
    e.hit = 0.08;
    if (kx !== undefined) {
      const kb = e.type === 'boss' ? 0.1 : e.type === 'tank' ? 0.3 : 1;
      e.x += kx * 7 * kb;
      e.y += ky * 7 * kb;
    }
    addText(e.x, e.y - e.r, String(Math.round(dmg)), crit ? '#ffd166' : '#ffffff', crit);
    const p = G.player;
    if (p.lifesteal > 0) p.hp = Math.min(p.maxHp, p.hp + dmg * p.lifesteal);
    Sound.play('hit');
    if (e.hp <= 0) killEnemy(e);
  }

  function explode(x, y, radius, dmg) {
    for (const e of query(x, y, radius)) {
      if ((e.x - x) ** 2 + (e.y - y) ** 2 < (radius + e.r) ** 2) damageEnemy(e, dmg);
    }
    burst(x, y, '#ff9f1c', 18, radius * 4, 4);
    G.particles.push({ ring: true, x, y, r: 4, maxR: radius, life: 0.25, max: 0.25, color: '#ffbf69' });
  }

  function killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    G.kills++;
    G.combo++;
    G.comboTimer = 2;
    G.bestCombo = Math.max(G.bestCombo, G.combo);
    G.score += Math.round(e.score * comboMult());
    const big = e.type === 'boss';
    burst(e.x, e.y, e.color, big ? 80 : e.r > 20 ? 24 : 12, big ? 500 : 240, big ? 6 : 3);
    Sound.play(big ? 'boom' : 'kill');

    // XP gems: split big values into several gems
    let xp = e.xp;
    while (xp > 0) {
      const v = xp >= 5 ? 5 : 1;
      xp -= v;
      G.pickups.push({ kind: 'xp', value: v, x: e.x + rand(-e.r, e.r), y: e.y + rand(-e.r, e.r), r: v === 5 ? 7 : 5, t: rand(0, 6) });
    }
    const roll = Math.random();
    const drop = (kind) => G.pickups.push({ kind, x: e.x, y: e.y, r: 11, t: 0 });
    if (big) { drop('heart'); drop('magnet'); }
    else if (roll < 0.018) drop('heart');
    else if (roll < 0.026) drop('bomb');
    else if (roll < 0.035) drop('magnet');
    else if (roll < 0.045) drop('rapid');

    if (e.type === 'splitter') {
      for (let i = 0; i < 3; i++) {
        const c = spawnEnemy('runner', e.x + rand(-15, 15), e.y + rand(-15, 15));
        c.hp = c.maxHp = c.maxHp * 0.6;
      }
    }
    if (big) {
      G.shake = 30;
      G.bossAlive = G.enemies.some((o) => o.type === 'boss' && !o.dead);
      if (!G.bossAlive) announce('הבוס הושמד!');
    }
    if (G.pickups.length > 700) G.pickups.splice(0, G.pickups.length - 700);
  }

  function fire(p) {
    const n = p.multishot;
    const spread = n > 1 ? Math.min(0.14, 0.9 / n) : 0;
    for (let i = 0; i < n; i++) {
      const a = p.angle + (i - (n - 1) / 2) * spread + rand(-0.02, 0.02);
      G.bullets.push({
        x: p.x + Math.cos(a) * p.r, y: p.y + Math.sin(a) * p.r,
        vx: Math.cos(a) * p.bulletSpeed, vy: Math.sin(a) * p.bulletSpeed,
        r: 4, life: 0.75 * (p.bulletSpeed / 750), dmg: p.damage, pierce: p.pierce, hits: new Set(), color: '#9bf6ff',
      });
    }
    G.shake = Math.max(G.shake, 1.5);
    Sound.play('shoot');
  }

  function hitRoll(base) {
    const crit = Math.random() < G.player.crit;
    return { dmg: base * (crit ? 2.5 : 1) * rand(0.9, 1.1), crit };
  }

  // ---------- update ----------
  function updatePlayer(dt) {
    const p = G.player;
    let mx = 0, my = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) my -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) my += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
    if (stick.id !== null) { mx = stick.dx; my = stick.dy; }
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }

    p.dashTimer = Math.max(0, p.dashTimer - dt);
    if (dashRequested && p.dashTimer <= 0) {
      let dx = mx, dy = my;
      if (Math.hypot(dx, dy) < 0.1) { dx = Math.cos(p.angle); dy = Math.sin(p.angle); }
      const l = Math.hypot(dx, dy);
      p.vx = (dx / l) * p.speed * 3.4;
      p.vy = (dy / l) * p.speed * 3.4;
      p.dashing = 0.17;
      p.invuln = Math.max(p.invuln, 0.3);
      p.dashTimer = p.dashCd;
      Sound.play('dash');
    }
    dashRequested = false;

    if (p.dashing > 0) {
      p.dashing -= dt;
      G.trails.push({ x: p.x, y: p.y, life: 0.25 });
    } else {
      p.vx = mx * p.speed;
      p.vy = my * p.speed;
    }
    p.x = clamp(p.x + p.vx * dt, p.r, WORLD - p.r);
    p.y = clamp(p.y + p.vy * dt, p.r, WORLD - p.r);

    // aim
    let target = null;
    if (settings.autoAim || touchMode) target = nearestEnemy(p.x, p.y, 650);
    if (target) p.angle = Math.atan2(target.y - p.y, target.x - p.x);
    else if (!touchMode) p.angle = Math.atan2(mouse.y + G.cam.y - H / 2 - p.y, mouse.x + G.cam.x - W / 2 - p.x);

    // shoot
    p.rapid = Math.max(0, p.rapid - dt);
    p.fireTimer -= dt;
    const wantsFire = mouse.down || settings.autoFire || (touchMode && target);
    if (wantsFire && p.fireTimer <= 0) {
      fire(p);
      p.fireTimer = 1 / (p.fireRate * (p.rapid > 0 ? 2 : 1));
    }

    p.invuln = Math.max(0, p.invuln - dt);
    if (p.regen > 0) p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
  }

  function updateEnemies(dt) {
    const p = G.player;
    for (let i = 0; i < G.enemies.length; i++) {
      const e = G.enemies[i];
      if (e.dead) continue;
      e.t += dt;
      e.hit = Math.max(0, e.hit - dt);
      e.orbHit = Math.max(0, e.orbHit - dt);
      e.rot += dt * (e.type === 'runner' ? 6 : 1.2);
      const dx = p.x - e.x, dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      let speed = e.speed;
      let vx = ux, vy = uy;

      if (e.type === 'shooter') {
        // keep distance and strafe
        const want = 300;
        const radial = d > want + 40 ? 1 : d < want - 40 ? -1 : 0;
        vx = ux * radial - uy * 0.6;
        vy = uy * radial + ux * 0.6;
        e.shootTimer -= dt;
        if (e.shootTimer <= 0 && d < 700) {
          e.shootTimer = rand(1.6, 2.6);
          G.ebullets.push({ x: e.x, y: e.y, vx: ux * 330, vy: uy * 330, r: 6, dmg: e.dmg, life: 4, color: '#00f5d4' });
          Sound.play('eshoot');
        }
      } else if (e.type === 'boss') {
        e.shootTimer -= dt;
        if (e.shootTimer <= 0) {
          e.shootTimer = 2.6;
          const n = 18 + Math.floor(G.wave / 5) * 2;
          const off = rand(0, TAU);
          for (let k = 0; k < n; k++) {
            const a = off + (k / n) * TAU;
            G.ebullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 240, vy: Math.sin(a) * 240, r: 8, dmg: e.dmg * 0.5, life: 5, color: '#ff006e' });
          }
          Sound.play('eshoot');
        }
        e.charge -= dt;
        if (e.charge < -5) { e.charge = 0.7; announce('!!!', 600); }
        if (e.charge > 0) speed *= 4.2;
        if (G.wave >= 10 && Math.random() < dt * 0.8 && G.enemies.length < MAX_ENEMIES) {
          spawnEnemy('runner', e.x + rand(-40, 40), e.y + rand(-40, 40));
        }
      }

      e.x += vx * speed * dt;
      e.y += vy * speed * dt;

      // separation from neighbours
      const near = query(e.x, e.y, e.r);
      for (const o of near) {
        if (o === e) continue;
        const sx = e.x - o.x, sy = e.y - o.y;
        const min = e.r + o.r;
        const sd = sx * sx + sy * sy;
        if (sd > 0 && sd < min * min) {
          const dd = Math.sqrt(sd);
          const push = ((min - dd) / dd) * 0.5;
          const wE = e.type === 'boss' ? 0.05 : 1;
          e.x += sx * push * wE;
          e.y += sy * push * wE;
        }
      }
      e.x = clamp(e.x, e.r, WORLD - e.r);
      e.y = clamp(e.y, e.r, WORLD - e.r);

      if ((p.x - e.x) ** 2 + (p.y - e.y) ** 2 < (p.r + e.r) ** 2) damagePlayer(e.dmg);
    }
  }

  function updateBullets(dt) {
    const p = G.player;
    for (let i = G.bullets.length - 1; i >= 0; i--) {
      const b = G.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      let remove = b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD;
      if (!remove) {
        for (const e of query(b.x, b.y, b.r)) {
          if (b.hits.has(e.id)) continue;
          if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 > (e.r + b.r) ** 2) continue;
          b.hits.add(e.id);
          const { dmg, crit } = hitRoll(b.dmg);
          const sp = Math.hypot(b.vx, b.vy) || 1;
          damageEnemy(e, dmg, b.vx / sp, b.vy / sp, crit);
          burst(b.x, b.y, b.color, 3, 150, 2);
          if (p.explosive > 0) explode(b.x, b.y, 30 + p.explosive * 18, b.dmg * (0.3 + 0.1 * p.explosive));
          b.pierce--;
          if (b.pierce < 0) { remove = true; break; }
        }
      }
      if (remove) G.bullets.splice(i, 1);
    }

    for (let i = G.ebullets.length - 1; i >= 0; i--) {
      const b = G.ebullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      let remove = b.life <= 0;
      if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 < (p.r + b.r) ** 2) {
        damagePlayer(b.dmg);
        remove = true;
      }
      if (remove) G.ebullets.splice(i, 1);
    }
  }

  function orbitalPositions() {
    const p = G.player, out = [];
    for (let i = 0; i < p.orbitals; i++) {
      const a = G.orbitAngle + (i / p.orbitals) * TAU;
      out.push({ x: p.x + Math.cos(a) * 78, y: p.y + Math.sin(a) * 78, a });
    }
    return out;
  }
  function dronePositions() {
    const p = G.player, out = [];
    for (let i = 0; i < p.drones; i++) {
      const a = -G.orbitAngle * 0.5 + (i / p.drones) * TAU;
      out.push({ x: p.x + Math.cos(a) * 42, y: p.y + Math.sin(a) * 42 });
    }
    return out;
  }

  function updateWeapons(dt) {
    const p = G.player;
    G.orbitAngle += dt * 3.2;
    if (p.orbitals > 0) {
      for (const o of orbitalPositions()) {
        for (const e of query(o.x, o.y, 12)) {
          if (e.orbHit > 0) continue;
          if ((e.x - o.x) ** 2 + (e.y - o.y) ** 2 < (e.r + 12) ** 2) {
            e.orbHit = 0.3;
            const { dmg, crit } = hitRoll(p.damage * 0.8);
            damageEnemy(e, dmg, Math.cos(o.a + Math.PI / 2), Math.sin(o.a + Math.PI / 2), crit);
          }
        }
        for (let i = G.ebullets.length - 1; i >= 0; i--) {
          const b = G.ebullets[i];
          if ((b.x - o.x) ** 2 + (b.y - o.y) ** 2 < (b.r + 12) ** 2) {
            burst(b.x, b.y, b.color, 5, 120, 2);
            G.ebullets.splice(i, 1);
          }
        }
      }
    }
    if (p.drones > 0) {
      p.droneTimer -= dt;
      if (p.droneTimer <= 0) {
        p.droneTimer = 0.55;
        for (const d of dronePositions()) {
          const t = nearestEnemy(d.x, d.y, 600);
          if (!t) continue;
          const a = Math.atan2(t.y - d.y, t.x - d.x);
          G.bullets.push({
            x: d.x, y: d.y, vx: Math.cos(a) * 820, vy: Math.sin(a) * 820, r: 3, life: 0.8,
            dmg: p.damage * 0.7, pierce: 0, hits: new Set(), color: '#caffbf',
          });
        }
      }
    }
  }

  function addXp(v) {
    const p = G.player;
    p.xp += v;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = Math.floor(p.xpNext * 1.17 + 3);
      G.pendingLevels++;
    }
  }

  function updatePickups(dt) {
    const p = G.player;
    for (let i = G.pickups.length - 1; i >= 0; i--) {
      const k = G.pickups[i];
      k.t += dt;
      const dx = p.x - k.x, dy = p.y - k.y;
      const d = Math.hypot(dx, dy) || 1;
      if (k.pull || (k.kind === 'xp' && d < p.magnet) || (k.kind !== 'xp' && d < 60)) {
        k.pull = true;
        const s = Math.max(450, p.speed * 1.8);
        k.x += (dx / d) * s * dt;
        k.y += (dy / d) * s * dt;
      }
      if (d < p.r + k.r) {
        collect(k);
        G.pickups.splice(i, 1);
      }
    }
  }

  function collect(k) {
    const p = G.player;
    switch (k.kind) {
      case 'xp':
        addXp(k.value);
        Sound.play('pickup');
        break;
      case 'heart':
        p.hp = Math.min(p.maxHp, p.hp + 30);
        addText(p.x, p.y - 30, '+30', '#06d6a0', true);
        Sound.play('power');
        break;
      case 'magnet':
        for (const o of G.pickups) if (o.kind === 'xp') o.pull = true;
        announce('מגנט!', 900);
        Sound.play('power');
        break;
      case 'rapid':
        p.rapid = 8;
        announce('ירי מהיר!', 900);
        Sound.play('power');
        break;
      case 'bomb': {
        const dmg = 250 + G.wave * 40;
        for (const e of G.enemies.slice()) {
          if (!e.dead && Math.abs(e.x - p.x) < W / 2 + 50 && Math.abs(e.y - p.y) < H / 2 + 50) damageEnemy(e, e.type === 'boss' ? dmg * 0.3 : dmg);
        }
        G.ebullets.length = 0;
        G.shake = 28;
        G.particles.push({ ring: true, x: p.x, y: p.y, r: 10, maxR: Math.max(W, H), life: 0.5, max: 0.5, color: '#ffffff' });
        Sound.play('boom');
        break;
      }
    }
  }

  function updateFx(dt) {
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const q = G.particles[i];
      q.life -= dt;
      if (q.life <= 0) { G.particles.splice(i, 1); continue; }
      if (q.ring) { q.r += ((q.maxR - q.r) * dt) / q.life; continue; }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= 0.92;
      q.vy *= 0.92;
    }
    for (let i = G.texts.length - 1; i >= 0; i--) {
      const t = G.texts[i];
      t.life -= dt;
      t.y -= 40 * dt;
      if (t.life <= 0) G.texts.splice(i, 1);
    }
    for (let i = G.trails.length - 1; i >= 0; i--) {
      G.trails[i].life -= dt;
      if (G.trails[i].life <= 0) G.trails.splice(i, 1);
    }
    G.shake = Math.max(0, G.shake - dt * 40);
    G.flash = Math.max(0, G.flash - dt);
    if (G.comboTimer > 0) {
      G.comboTimer -= dt;
      if (G.comboTimer <= 0) G.combo = 0;
    }
  }

  function update(dt) {
    G.time += dt;
    buildGrid();
    updatePlayer(dt);
    updateWave(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateWeapons(dt);
    updatePickups(dt);
    updateFx(dt);
    G.enemies = G.enemies.filter((e) => !e.dead);
    const p = G.player;
    G.cam.x += (p.x - G.cam.x) * Math.min(1, dt * 8);
    G.cam.y += (p.y - G.cam.y) * Math.min(1, dt * 8);
    if (G.state === 'playing' && G.pendingLevels > 0) openLevelUp();
  }

  // ---------- render ----------
  function poly(x, y, r, sides, rot) {
    ctx.beginPath();
    if (!sides) { ctx.arc(x, y, r, 0, TAU); return; }
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TAU;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawBackground(cx, cy) {
    ctx.fillStyle = '#070a13';
    ctx.fillRect(0, 0, W, H);
    const left = cx - W / 2, top = cy - H / 2;
    const step = 80;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(80, 110, 200, 0.12)';
    ctx.beginPath();
    for (let x = Math.floor(left / step) * step; x < left + W; x += step) {
      ctx.moveTo(x - left, 0);
      ctx.lineTo(x - left, H);
    }
    for (let y = Math.floor(top / step) * step; y < top + H; y += step) {
      ctx.moveTo(0, y - top);
      ctx.lineTo(W, y - top);
    }
    ctx.stroke();
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!G) {
      const t = performance.now() / 1000;
      drawBackground(WORLD / 2 + Math.cos(t * 0.2) * 400, WORLD / 2 + t * 40);
      return;
    }
    const p = G.player;
    const sx = G.shake ? rand(-G.shake, G.shake) : 0;
    const sy = G.shake ? rand(-G.shake, G.shake) : 0;
    const cx = G.cam.x + sx, cy = G.cam.y + sy;
    drawBackground(cx, cy);

    ctx.save();
    ctx.translate(W / 2 - cx, H / 2 - cy);
    const vis = (x, y, r) => Math.abs(x - cx) < W / 2 + r && Math.abs(y - cy) < H / 2 + r;

    // world border
    ctx.strokeStyle = 'rgba(247, 37, 133, 0.6)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, WORLD, WORLD);

    // pickups
    for (const k of G.pickups) {
      if (!vis(k.x, k.y, 20)) continue;
      const bob = Math.sin(k.t * 5) * 2;
      if (k.kind === 'xp') {
        ctx.fillStyle = k.value >= 5 ? '#4cc9f0' : '#06d6a0';
        poly(k.x, k.y + bob, k.r, 4, k.t * 2);
        ctx.fill();
      } else {
        const col = { heart: '#ef476f', bomb: '#ff9f1c', magnet: '#4361ee', rapid: '#ffd166' }[k.kind];
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(k.x, k.y + bob, k.r + 6, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(k.x, k.y + bob, k.r, 0, TAU); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText({ heart: '+', bomb: 'B', magnet: 'M', rapid: 'R' }[k.kind], k.x, k.y + bob + 1);
      }
    }

    // dash trail
    for (const t of G.trails) {
      ctx.globalAlpha = t.life * 2;
      ctx.fillStyle = '#4cc9f0';
      ctx.beginPath(); ctx.arc(t.x, t.y, p.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // enemies
    for (const e of G.enemies) {
      if (!vis(e.x, e.y, e.r + 10)) continue;
      const white = e.hit > 0;
      ctx.fillStyle = white ? '#ffffff' : e.color;
      ctx.strokeStyle = white ? '#ffffff' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      if (e.type === 'boss') {
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const a = e.rot + (i / 16) * TAU;
          const rr = i % 2 ? e.r * 0.75 : e.r * 1.1;
          const px = e.x + Math.cos(a) * rr, py = e.y + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else {
        poly(e.x, e.y, e.r, e.sides, e.rot);
      }
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      // eye pointing at the player
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      ctx.fillStyle = '#0b0f1a';
      ctx.beginPath(); ctx.arc(e.x + Math.cos(a) * e.r * 0.4, e.y + Math.sin(a) * e.r * 0.4, Math.max(2.5, e.r * 0.22), 0, TAU); ctx.fill();
      if (e.hp < e.maxHp && e.type !== 'boss') {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(e.x - e.r, e.y - e.r - 9, e.r * 2, 4);
        ctx.fillStyle = '#ef476f';
        ctx.fillRect(e.x - e.r, e.y - e.r - 9, e.r * 2 * Math.max(0, e.hp / e.maxHp), 4);
      }
    }

    // bullets (additive glow)
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of G.bullets) {
      if (!vis(b.x, b.y, 20)) continue;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.r * 2;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const b of G.ebullets) {
      if (!vis(b.x, b.y, 20)) continue;
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.45, 0, TAU); ctx.fill();
    }
    for (const q of G.particles) {
      const alpha = Math.max(0, q.life / q.max);
      ctx.globalAlpha = alpha;
      if (q.ring) {
        ctx.strokeStyle = q.color;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, TAU); ctx.stroke();
      } else {
        ctx.fillStyle = q.color;
        ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // orbitals & drones
    for (const o of orbitalPositions()) {
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(G.orbitAngle * 4);
      ctx.fillStyle = '#b8c0ff';
      poly(0, 0, 12, 3, 0);
      ctx.fill();
      ctx.restore();
    }
    for (const d of dronePositions()) {
      ctx.fillStyle = '#caffbf';
      poly(d.x, d.y, 7, 4, G.orbitAngle);
      ctx.fill();
    }

    // player
    const blink = p.invuln > 0 && p.dashing <= 0 && Math.floor(G.time * 20) % 2 === 0;
    if (!blink) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = '#e0e6ff';
      ctx.fillRect(p.r * 0.3, -4 - (p.multishot > 2 ? 2 : 0), p.r * 1.2, 8 + (p.multishot > 2 ? 4 : 0));
      ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU);
      ctx.fillStyle = p.rapid > 0 ? '#ffd166' : '#4cc9f0';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
    if (p.magnet > 140) {
      ctx.strokeStyle = 'rgba(6, 214, 160, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.magnet, 0, TAU); ctx.stroke();
    }

    // floating texts
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of G.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = t.big ? 'bold 18px system-ui' : '12px system-ui';
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    drawScreenUi();
  }

  function drawScreenUi() {
    const p = G.player;
    // damage vignette
    if (G.flash > 0 || p.hp / p.maxHp < 0.25) {
      const a = Math.max(G.flash, p.hp / p.maxHp < 0.25 ? 0.18 + Math.sin(G.time * 6) * 0.08 : 0);
      const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      grad.addColorStop(0, 'rgba(255,0,60,0)');
      grad.addColorStop(1, `rgba(255,0,60,${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // boss bar
    const boss = G.enemies.find((e) => e.type === 'boss');
    if (boss) {
      const bw = Math.min(600, W - 40), bx = (W - bw) / 2, by = H - 44;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx, by, bw, 14);
      ctx.fillStyle = '#ff006e';
      ctx.fillRect(bx, by, bw * Math.max(0, boss.hp / boss.maxHp), 14);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bw, 14);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('BOSS', W / 2, by - 8);
    }

    // minimap
    const mm = Math.min(150, W * 0.28), mx = 12, my = H - mm - 12, s = mm / WORLD;
    ctx.fillStyle = 'rgba(10, 14, 28, 0.75)';
    ctx.fillRect(mx, my, mm, mm);
    ctx.strokeStyle = 'rgba(120,150,255,0.35)';
    ctx.strokeRect(mx, my, mm, mm);
    for (const e of G.enemies) {
      ctx.fillStyle = e.type === 'boss' ? '#ff006e' : 'rgba(255, 77, 109, 0.8)';
      const r = e.type === 'boss' ? 4 : 1.5;
      ctx.fillRect(mx + e.x * s - r / 2, my + e.y * s - r / 2, r, r);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.strokeRect(mx + (G.cam.x - W / 2) * s, my + (G.cam.y - H / 2) * s, W * s, H * s);
    ctx.fillStyle = '#4cc9f0';
    ctx.fillRect(mx + p.x * s - 2.5, my + p.y * s - 2.5, 5, 5);

    // joystick
    if (stick.id !== null) {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(stick.ox, stick.oy, 60, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(76, 201, 240, 0.5)';
      ctx.beginPath(); ctx.arc(stick.ox + stick.dx * 60, stick.oy + stick.dy * 60, 22, 0, TAU); ctx.fill();
    }
  }

  // ---------- HUD (DOM) ----------
  const hudCache = {};
  function setText(id, v) {
    if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; }
  }
  function setWidth(id, frac) {
    const v = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    if (hudCache[id] !== v) { hudCache[id] = v; $(id).style.width = v; }
  }
  function fmtTime(s) {
    s = Math.floor(s);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function updateHud() {
    const p = G.player;
    setWidth('hpFill', p.hp / p.maxHp);
    setText('hpText', `${Math.ceil(p.hp)} / ${p.maxHp}`);
    setWidth('xpFill', p.xp / p.xpNext);
    setText('lvText', `רמה ${p.level}`);
    setWidth('dashFill', 1 - p.dashTimer / p.dashCd);
    setText('score', G.score.toLocaleString());
    setText('wave', String(G.wave));
    setText('time', fmtTime(G.time));
    setText('kills', String(G.kills));
    setText('combo', G.combo >= 5 ? `קומבו ${G.combo} · \u2066x${comboMult()}\u2069` : '');
  }
  function renderToggles() {
    const on = (b) => (b ? 'פעיל' : 'כבוי');
    $('toggles').textContent = isTouch ? '' : `כיוון אוטומטי [Q]: ${on(settings.autoAim)} · ירי אוטומטי [F]: ${on(settings.autoFire)} · צליל [M]: ${on(!settings.muted)}`;
    $('aimBtn').textContent = `כיוון אוטומטי: ${on(settings.autoAim)}`;
    $('fireBtn').textContent = `ירי אוטומטי: ${on(settings.autoFire)}`;
    $('muteBtn').textContent = `צליל: ${on(!settings.muted)}`;
  }
  function toggleSetting(k) {
    settings[k] = !settings[k];
    store.set(k, settings[k]);
    renderToggles();
  }

  // ---------- screens ----------
  const screens = ['menu', 'pause', 'levelup', 'gameover'];
  function show(id) {
    for (const s of screens) $(s).classList.toggle('hidden', s !== id);
    $('hud').classList.toggle('hidden', !G || G.state === 'menu');
  }

  function startGame() {
    Sound.init();
    G = newGame();
    enemyId = 0;
    show(null);
    announce('גל 1');
  }

  function togglePause() {
    if (!G) return;
    if (G.state === 'playing') {
      G.state = 'paused';
      mouse.down = false;
      const chips = $('pauseUpgrades');
      chips.replaceChildren();
      for (const [id, lvl] of Object.entries(G.player.upgrades)) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = `${UPG[id].ico} ${UPG[id].name} ${lvl}`;
        chips.appendChild(c);
      }
      if (!chips.children.length) chips.textContent = 'אין עדיין שדרוגים';
      show('pause');
    } else if (G.state === 'paused') {
      G.state = 'playing';
      show(null);
    }
  }

  function openLevelUp() {
    const p = G.player;
    const avail = UPGRADES.filter((u) => (p.upgrades[u.id] || 0) < u.max);
    if (!avail.length) {
      G.pendingLevels = 0;
      p.hp = p.maxHp;
      return;
    }
    for (let i = avail.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [avail[i], avail[j]] = [avail[j], avail[i]];
    }
    G.choices = avail.slice(0, 3);
    G.state = 'levelup';
    mouse.down = false;
    Sound.play('level');
    $('luLevel').textContent = `(רמה ${p.level - G.pendingLevels + 1})`;
    const cards = $('cards');
    cards.replaceChildren();
    G.choices.forEach((u, i) => {
      const cur = p.upgrades[u.id] || 0;
      const el = document.createElement('div');
      el.className = 'card';
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);
      const ico = document.createElement('div');
      ico.className = 'ico';
      ico.textContent = u.ico;
      const h = document.createElement('h4');
      h.textContent = u.name;
      const d = document.createElement('p');
      d.textContent = u.desc;
      const lv = document.createElement('div');
      lv.className = 'lvl';
      lv.textContent = cur ? `רמה ${cur} ← ${cur + 1} (מקס׳ ${u.max})` : `חדש! (מקס׳ ${u.max})`;
      el.append(key, ico, h, d, lv);
      el.addEventListener('click', () => pickUpgrade(i));
      cards.appendChild(el);
    });
    show('levelup');
  }

  function pickUpgrade(i) {
    if (!G || G.state !== 'levelup' || !G.choices[i]) return;
    const u = G.choices[i];
    const p = G.player;
    u.apply(p);
    p.upgrades[u.id] = (p.upgrades[u.id] || 0) + 1;
    G.pendingLevels--;
    G.state = 'playing';
    show(null);
    if (G.pendingLevels > 0) openLevelUp();
  }

  function gameOver() {
    G.state = 'over';
    mouse.down = false;
    Sound.play('boom');
    burst(G.player.x, G.player.y, '#4cc9f0', 80, 500, 5);
    const best = store.get('best', 0);
    if (G.score > best) store.set('best', G.score);
    const stats = [
      ['ניקוד', G.score.toLocaleString()], ['גל', G.wave], ['רמה', G.player.level],
      ['הריגות', G.kills], ['זמן', fmtTime(G.time)], ['קומבו שיא', G.bestCombo],
    ];
    const box = $('finalStats');
    box.replaceChildren();
    for (const [label, val] of stats) {
      const d = document.createElement('div');
      const s = document.createElement('small');
      s.textContent = label;
      const b = document.createElement('b');
      b.textContent = String(val);
      d.append(s, b);
      box.appendChild(d);
    }
    $('submitMsg').textContent = G.score > best ? 'שיא אישי חדש!' : `השיא האישי שלך: ${best.toLocaleString()}`;
    $('scoreForm').classList.remove('hidden');
    $('nameInput').value = store.get('name', '');
    setTimeout(() => {
      show('gameover');
      loadBoard($('overBoard'));
      if (!isTouch) $('nameInput').focus();
    }, 900);
  }

  // ---------- leaderboard ----------
  function renderBoard(el, scores, highlight) {
    el.replaceChildren();
    if (!scores.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'עדיין אין שיאים — היה הראשון!';
      el.appendChild(li);
      return;
    }
    scores.slice(0, 10).forEach((s, i) => {
      const li = document.createElement('li');
      if (highlight === i + 1) li.className = 'me';
      const b = document.createElement('b');
      b.textContent = s.score.toLocaleString();
      li.append(`${s.name} — `, b, ` · גל ${s.wave}`);
      el.appendChild(li);
    });
  }
  async function loadBoard(el) {
    try {
      const res = await fetch('/api/scores?limit=10', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      renderBoard(el, (await res.json()).scores);
    } catch (e) {
      el.replaceChildren();
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'טבלת השיאים לא זמינה';
      el.appendChild(li);
    }
  }
  $('scoreForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!G || G.submitted) return;
    const name = $('nameInput').value.trim();
    if (!name) return;
    store.set('name', name);
    G.submitted = true;
    $('submitMsg').textContent = 'שומר...';
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, score: G.score, wave: G.wave, level: G.player.level, kills: G.kills, time: Math.floor(G.time),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      $('submitMsg').textContent = data.rank ? `נשמר! מקום ${data.rank} בטבלה` : 'נשמר!';
      $('scoreForm').classList.add('hidden');
      renderBoard($('overBoard'), data.scores, data.rank);
    } catch (e) {
      G.submitted = false;
      $('submitMsg').textContent = `השמירה נכשלה (${e.message})`;
    }
  });

  // ---------- wiring ----------
  const controls = isTouch
    ? [['אגודל שמאל', 'תנועה'], ['הקשה בצד ימין', 'זינוק'], ['', 'כיוון וירי אוטומטיים']]
    : [['WASD / חצים', 'תנועה'], ['עכבר', 'כיוון וירי'], ['רווח / Shift / קליק ימני', 'זינוק'],
      ['Q', 'כיוון אוטומטי'], ['F', 'ירי אוטומטי'], ['P / Esc', 'הפסקה'], ['M', 'השתקה']];
  for (const [k, v] of controls) {
    const li = document.createElement('li');
    if (k) {
      const kb = document.createElement('kbd');
      kb.textContent = k;
      li.append(kb, ' ');
    }
    li.append(v);
    $('controlsList').appendChild(li);
  }
  const best = store.get('best', 0);
  $('bestLocal').textContent = best ? `השיא האישי שלך: ${best.toLocaleString()}` : '';

  $('startBtn').addEventListener('click', startGame);
  $('againBtn').addEventListener('click', startGame);
  $('resumeBtn').addEventListener('click', togglePause);
  $('pauseBtn').addEventListener('click', togglePause);
  const toMenu = () => {
    G = null;
    show('menu');
    loadBoard($('menuBoard'));
    const b = store.get('best', 0);
    $('bestLocal').textContent = b ? `השיא האישי שלך: ${b.toLocaleString()}` : '';
  };
  $('quitBtn').addEventListener('click', toMenu);
  $('menuBtn').addEventListener('click', toMenu);
  $('aimBtn').addEventListener('click', () => toggleSetting('autoAim'));
  $('fireBtn').addEventListener('click', () => toggleSetting('autoFire'));
  $('muteBtn').addEventListener('click', () => toggleSetting('muted'));
  renderToggles();
  loadBoard($('menuBoard'));

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (G && G.state === 'playing') update(dt);
    else if (G && G.state === 'over') updateFx(dt);
    render();
    if (G) updateHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Open the page with #debug to inspect the game state from the console: __legion()
  if (location.hash === '#debug') window.__legion = () => G;
})();
