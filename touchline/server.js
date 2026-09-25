'use strict';

// Touchline server: serves the game and stores saved careers.
// No external dependencies. Designed to listen only on the Tailscale interface.

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVES_DIR = path.join(DATA_DIR, 'saves');
// Tailscale IPv4 (CGNAT) + Tailscale IPv6 ULA + loopback (for `tailscale serve`).
const DEFAULT_NETS = '100.64.0.0/10,fd7a:115c:a1e0::/48,127.0.0.0/8,::1/128';
const MAX_SAVE = 16 * 1024 * 1024;
const MAX_META = 2048;
const MAX_SLOTS = 50;
const SLOT_RE = /^[a-z0-9-]{1,40}$/;

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

// ---------- saves ----------
// Each slot is two files: <slot>.bin (the gzipped game state, opaque to the server)
// and <slot>.json (small metadata shown in the load menu).

function sanitizeMeta(raw) {
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!meta || typeof meta !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    mode: meta.mode === 'pro' ? 'pro' : 'manager',
    title: str(meta.title, 80),
    subtitle: str(meta.subtitle, 120),
    savedAt: new Date().toISOString(),
  };
}

function listSaves(dir = SAVES_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return { slot: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------- HTTP ----------

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
  const savesDir = options.savesDir || SAVES_DIR;

  async function handleSaves(req, res, slot) {
    if (!slot) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, { saves: listSaves(savesDir) });
    }
    if (!SLOT_RE.test(slot)) return sendJson(res, 400, { error: 'invalid slot' });
    const bin = path.join(savesDir, `${slot}.bin`);
    const meta = path.join(savesDir, `${slot}.json`);

    if (req.method === 'GET') {
      fs.readFile(bin, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'not found' });
        send(res, 200, data, 'application/octet-stream');
      });
      return undefined;
    }
    if (req.method === 'PUT') {
      const metaHeader = req.headers['x-save-meta'];
      const info = sanitizeMeta(metaHeader ? decodeURIComponent(String(metaHeader)).slice(0, MAX_META) : '{}');
      if (!info) return sendJson(res, 400, { error: 'bad meta' });
      let body;
      try {
        body = await readBody(req, MAX_SAVE);
      } catch (e) {
        return sendJson(res, 413, { error: 'save too large' });
      }
      if (!body.length) return sendJson(res, 400, { error: 'empty save' });
      fs.mkdirSync(savesDir, { recursive: true });
      const exists = fs.existsSync(meta);
      if (!exists && listSaves(savesDir).length >= MAX_SLOTS) return sendJson(res, 409, { error: 'too many saves' });
      writeAtomic(bin, body);
      writeAtomic(meta, JSON.stringify(info));
      return sendJson(res, 200, { slot, ...info });
    }
    if (req.method === 'DELETE') {
      fs.rmSync(bin, { force: true });
      fs.rmSync(meta, { force: true });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  return http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!ipAllowed(ip, nets)) {
      req.socket.destroy(); // drop silently: this service is VPN-only
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/api\/saves(?:\/([^/]+))?$/.exec(url.pathname);
    try {
      if (m) return await handleSaves(req, res, m[1]);
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      console.error(e);
      return sendJson(res, 500, { error: 'server error' });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Touchline listening on http://${HOST}:${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, parseNets, ipAllowed, sanitizeMeta, listSaves };
