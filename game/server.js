'use strict';

// Legion Arena server: serves the game and a small leaderboard API.
// No external dependencies. Designed to listen only on the Tailscale interface.

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
// Tailscale IPv4 (CGNAT) + Tailscale IPv6 ULA + loopback (for `tailscale serve`).
const DEFAULT_NETS = '100.64.0.0/10,fd7a:115c:a1e0::/48,127.0.0.0/8,::1/128';
const MAX_SCORES = 100;
const MAX_BODY = 2048;
const RATE_LIMIT = 10; // score submissions per IP per minute

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// ---------- IP allow-list ----------

function ipv4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) + BigInt(p);
  }
  return n;
}

function ipv6ToBigInt(ip) {
  if (!ip.includes(':')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}

function parseNets(spec) {
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cidr) => {
      if (cidr === '*') return { any: true };
      const [addr, bitsStr] = cidr.split('/');
      const v6 = addr.includes(':');
      const total = v6 ? 128 : 32;
      const bits = bitsStr === undefined ? total : parseInt(bitsStr, 10);
      const base = v6 ? ipv6ToBigInt(addr) : ipv4ToBigInt(addr);
      if (base === null || !(bits >= 0 && bits <= total)) {
        throw new Error(`Invalid network in ALLOWED_NETS: ${cidr}`);
      }
      const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(total - bits);
      return { v6, mask, net: base & mask };
    });
}

function ipAllowed(ip, nets) {
  if (!ip) return false;
  let addr = ip.replace(/%.*$/, ''); // strip IPv6 zone id
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  const v6 = addr.includes(':');
  const n = v6 ? ipv6ToBigInt(addr) : ipv4ToBigInt(addr);
  return nets.some((net) => net.any || (n !== null && net.v6 === v6 && (n & net.mask) === net.net));
}

// ---------- scores ----------

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return clean.length ? clean : null;
}

function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function validateScore(body) {
  if (!body || typeof body !== 'object') return { error: 'bad body' };
  const name = sanitizeName(body.name);
  if (!name) return { error: 'invalid name' };
  const { score, wave, level, kills, time } = body;
  if (!isInt(score, 0, 100000000)) return { error: 'invalid score' };
  if (!isInt(wave, 1, 9999)) return { error: 'invalid wave' };
  if (!isInt(level, 1, 9999)) return { error: 'invalid level' };
  if (!isInt(kills, 0, 10000000)) return { error: 'invalid kills' };
  if (!isInt(time, 0, 86400)) return { error: 'invalid time' };
  // Loose plausibility check: max per-kill score is a boss (1000) at the top combo multiplier (x4).
  if (score > kills * 4000 + wave * wave * 100 + 1000) return { error: 'implausible score' };
  return { entry: { name, score, wave, level, kills, time, date: new Date().toISOString() } };
}

function insertScore(list, entry, max = MAX_SCORES) {
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.time - b.time);
  const rank = list.indexOf(entry) + 1;
  list.length = Math.min(list.length, max);
  return rank <= max ? rank : null;
}

function loadScores() {
  try {
    const data = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function saveScores(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SCORES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, SCORES_FILE);
}

// ---------- HTTP ----------

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return send(res, 400, 'Bad request', 'text/plain');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer(options = {}) {
  const nets = parseNets(options.allowedNets || process.env.ALLOWED_NETS || DEFAULT_NETS);
  const scores = options.scores || loadScores();
  const persist = options.persist || saveScores;
  const hits = new Map();

  function rateLimited(ip) {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now > h.reset) {
      hits.set(ip, { count: 1, reset: now + 60000 });
      return false;
    }
    h.count += 1;
    return h.count > RATE_LIMIT;
  }

  return http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!ipAllowed(ip, nets)) {
      req.socket.destroy(); // drop silently: this service is VPN-only
      return;
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/scores') {
      if (req.method === 'GET') {
        const limit = clampInt(url.searchParams.get('limit'), 1, MAX_SCORES, 20);
        return sendJson(res, 200, { scores: scores.slice(0, limit) });
      }
      if (req.method === 'POST') {
        if (rateLimited(ip)) return sendJson(res, 429, { error: 'too many requests' });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          return sendJson(res, 400, { error: 'bad json' });
        }
        const { entry, error } = validateScore(body);
        if (error) return sendJson(res, 400, { error });
        const rank = insertScore(scores, entry);
        try {
          persist(scores);
        } catch (e) {
          console.error('Failed to save scores:', e.message);
        }
        return sendJson(res, 201, { rank, scores: scores.slice(0, 20) });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res, url.pathname);
  });
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.max(min, Math.min(max, n));
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Legion Arena listening on http://${HOST}:${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, sanitizeName, validateScore, insertScore, parseNets, ipAllowed };
