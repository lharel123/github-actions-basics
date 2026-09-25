const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer, parseNets, ipAllowed, sanitizeMeta } = require('./server');

describe('ipAllowed', () => {
  const nets = parseNets('100.64.0.0/10,fd7a:115c:a1e0::/48,127.0.0.0/8,::1/128');

  test('allows Tailscale and loopback addresses', () => {
    expect(ipAllowed('100.101.102.103', nets)).toBe(true);
    expect(ipAllowed('::ffff:100.64.0.1', nets)).toBe(true);
    expect(ipAllowed('fd7a:115c:a1e0:ab12::1', nets)).toBe(true);
    expect(ipAllowed('127.0.0.1', nets)).toBe(true);
    expect(ipAllowed('::1', nets)).toBe(true);
  });

  test('blocks LAN and public addresses', () => {
    expect(ipAllowed('192.168.1.20', nets)).toBe(false);
    expect(ipAllowed('100.128.0.1', nets)).toBe(false);
    expect(ipAllowed('8.8.8.8', nets)).toBe(false);
    expect(ipAllowed('2001:db8::1', nets)).toBe(false);
    expect(ipAllowed(undefined, nets)).toBe(false);
  });

  test('rejects invalid config', () => {
    expect(() => parseNets('not-an-ip/8')).toThrow();
  });
});

test('sanitizeMeta keeps only known, bounded fields', () => {
  const m = sanitizeMeta(JSON.stringify({ mode: 'pro', title: 'x'.repeat(200), evil: 1 }));
  expect(m.mode).toBe('pro');
  expect(m.title).toHaveLength(80);
  expect(m.evil).toBeUndefined();
  expect(sanitizeMeta('{nope')).toBeNull();
});

describe('HTTP server', () => {
  let server;
  let port;
  let dir;

  beforeAll((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touchline-'));
    server = createServer({ allowedNets: '127.0.0.0/8,::1/128', savesDir: dir });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });
  afterAll((done) => {
    server.close(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      done();
    });
  });

  function request(method, p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  test('serves the game with security headers', async () => {
    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('Touchline');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  test('blocks path traversal', async () => {
    const res = await request('GET', '/..%2fserver.js');
    expect([403, 404]).toContain(res.status);
  });

  test('stores, lists, loads and deletes saves', async () => {
    const data = Buffer.from([0x1f, 0x8b, 1, 2, 3, 4]);
    const meta = encodeURIComponent(JSON.stringify({ mode: 'manager', title: 'מכבי חיפה', subtitle: 'שבוע 3' }));
    const put = await request('PUT', '/api/saves/mgr-abc', data, { 'X-Save-Meta': meta });
    expect(put.status).toBe(200);
    const list = JSON.parse((await request('GET', '/api/saves')).body);
    expect(list.saves[0]).toMatchObject({ slot: 'mgr-abc', title: 'מכבי חיפה', mode: 'manager' });
    const get = await request('GET', '/api/saves/mgr-abc');
    expect(Buffer.compare(get.body, data)).toBe(0);
    expect((await request('DELETE', '/api/saves/mgr-abc')).status).toBe(200);
    expect((await request('GET', '/api/saves/mgr-abc')).status).toBe(404);
  });

  test('rejects bad slot names', async () => {
    expect((await request('PUT', '/api/saves/..%2f..%2fetc', Buffer.from('x'))).status).toBe(400);
    expect((await request('GET', '/api/saves/UPPER')).status).toBe(400);
  });
});
