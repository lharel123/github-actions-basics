const http = require('http');
const { createServer, sanitizeName, validateScore, insertScore, parseNets, ipAllowed } = require('./server');

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

describe('scores', () => {
  test('sanitizeName strips unsafe characters and keeps Hebrew', () => {
    expect(sanitizeName('<b>ליאור</b>')).toBe('bליאורb');
    expect(sanitizeName('   ')).toBeNull();
    expect(sanitizeName(42)).toBeNull();
    expect(sanitizeName('x'.repeat(40))).toHaveLength(16);
  });

  const good = { name: 'Neo', score: 1200, wave: 3, level: 5, kills: 80, time: 95 };

  test('validateScore accepts a normal run', () => {
    expect(validateScore(good).entry).toMatchObject({ name: 'Neo', score: 1200 });
  });

  test('validateScore rejects bad or implausible values', () => {
    expect(validateScore({ ...good, score: -1 }).error).toBeDefined();
    expect(validateScore({ ...good, score: 1.5 }).error).toBeDefined();
    expect(validateScore({ ...good, kills: 0, score: 999999 }).error).toBe('implausible score');
    expect(validateScore(null).error).toBeDefined();
  });

  test('insertScore keeps list sorted and capped', () => {
    const list = [];
    for (let i = 0; i < 5; i++) insertScore(list, { score: i * 10, time: 1 }, 3);
    expect(list.map((s) => s.score)).toEqual([40, 30, 20]);
    expect(insertScore(list, { score: 1, time: 1 }, 3)).toBeNull();
  });
});

describe('HTTP server', () => {
  let server;
  let port;
  const saved = [];

  beforeAll((done) => {
    server = createServer({ allowedNets: '127.0.0.0/8,::1/128', scores: [], persist: (s) => saved.push(s.length) });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  test('serves the game page with security headers', async () => {
    const res = await request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Legion Arena');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  test('blocks path traversal', async () => {
    const res = await request('GET', '/..%2fserver.js');
    expect([403, 404]).toContain(res.status);
  });

  test('stores and returns scores', async () => {
    const post = await request('POST', '/api/scores', { name: 'Tester', score: 500, wave: 2, level: 3, kills: 40, time: 60 });
    expect(post.status).toBe(201);
    expect(JSON.parse(post.body).rank).toBe(1);
    expect(saved.length).toBe(1);
    const get = await request('GET', '/api/scores');
    expect(JSON.parse(get.body).scores[0].name).toBe('Tester');
  });

  test('rejects malformed submissions', async () => {
    expect((await request('POST', '/api/scores', '{nope')).status).toBe(400);
    expect((await request('POST', '/api/scores', { name: '', score: 1 })).status).toBe(400);
  });
});
