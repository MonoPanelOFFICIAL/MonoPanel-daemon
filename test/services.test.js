// Zero-dependency tests for the hosting-kind modules. Run:  npm run build && npm test
// They never touch PostgreSQL or Docker: the state module is replaced by an in-memory map and the process runtime is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-daemon-test-'));
process.env.DATA_DIR = tmp;
process.env.DAEMON_SECRET = 'x'.repeat(40);
process.env.DAEMON_PORT = '0';
process.env.RUNTIME = 'process';
process.env.ALLOW_UNSANDBOXED_ROOT = 'true';
process.env.NODE_SERVICES = 'bot,nodejs,website,lavalink';          // no vps on this test node
process.env.WEB_ACME_DIR = path.join(tmp, 'acme');
process.env.PORT_MIN = '20000'; process.env.PORT_MAX = '40000';
fs.mkdirSync(path.join(tmp, 'volumes'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'acme'), { recursive: true });

const dist = p => require(path.join(__dirname, '..', 'dist', p));
const store = dist('state.js');
const specs = new Map();
store.loadSpec = id => specs.get(id) || null;
store.listSpecs = () => [...specs.values()];
store.saveSpec = async s => { specs.set(s.id, JSON.parse(JSON.stringify(s))); };
store.deleteSpec = async id => { specs.delete(id); };
store.getInstall = () => null;
store.setInstall = () => undefined;
store.clearInstall = async () => undefined;
store.binItems = () => [];
store.binServerIds = () => [];
store.binDrop = async () => undefined;

const kinds = dist('kinds.js');
const lavalink = dist('lavalink.js');
const nodejs = dist('nodejs.js');
const web = dist('web.js');
const { config } = dist('config.js');

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const mkSpec = (over = {}) => ({ id: ID, kind: 'lavalink', image: 'x', startup: 'true', stopCommand: '^C', env: {}, ports: [{ host: 23333, container: 23333 }], limits: { ramMB: 512, cpuPercent: 100, diskMB: 1024, swapMB: 0, pids: 256 }, ...over });
const vol = id => { const d = path.join(config.volumesDir, id); fs.mkdirSync(d, { recursive: true }); return d; };

test('kinds: NODE_SERVICES is honoured and validated', () => {
  assert.deepEqual(kinds.enabledKinds(), ['bot', 'nodejs', 'website', 'lavalink']);
  assert.equal(kinds.kindEnabled('vps'), false);
  assert.throws(() => kinds.needKind('vps'), /does not host vps/);
  assert.deepEqual(kinds.parseServices('lavalink, bot,nope'), { ok: ['bot', 'lavalink'], bad: ['nope'] });
});

test('lavalink: settings are validated and the YAML uses env placeholders', () => {
  const d = lavalink.defaultSettings();
  const yml = lavalink.renderYaml(d);
  assert.match(yml, /port: \$\{SERVER_PORT:2333\}/);
  assert.match(yml, /password: "\$\{LAVALINK_PASSWORD:youshallnotpass\}"/);
  assert.match(yml, /youtube: false/);
  assert.ok(yml.startsWith('# Managed by MonoPanel'));

  const s = lavalink.sanitize({ sources: { youtube: true, bogus: true }, opusEncodingQuality: 99, resamplingQuality: 'ULTRA', plugins: [{ dependency: 'dev.lavalink.youtube:youtube-plugin:1.2.3', repository: 'https://maven.lavalink.dev/releases' }] });
  assert.equal(s.sources.youtube, true);
  assert.equal(s.sources.bogus, undefined);
  assert.equal(s.opusEncodingQuality, 10);
  assert.equal(s.resamplingQuality, 'LOW');
  const out = lavalink.renderYaml(s);
  assert.match(out, /- dependency: "dev\.lavalink\.youtube:youtube-plugin:1\.2\.3"/);
  assert.match(out, /repository: "https:\/\/maven\.lavalink\.dev\/releases"/);

  assert.throws(() => lavalink.sanitize({ plugins: [{ dependency: 'nope' }] }), /group:artifact:version/);
  assert.throws(() => lavalink.sanitize({ plugins: [{ dependency: 'a:b:1', repository: 'http://insecure' }] }), /https/);
  assert.throws(() => lavalink.sanitize({ plugins: [{ dependency: 'a:b:1"\ninjected: true' }] }), /group:artifact:version/);
  assert.throws(() => lavalink.sanitize({ extraYaml: 'lavalink:\n  server:\n    password: x' }), /cannot redefine/);
  assert.doesNotThrow(() => lavalink.sanitize({ extraYaml: 'plugins:\n  youtube:\n    enabled: true' }));
});

test('lavalink: write, read back, raw mode and reset', () => {
  vol(ID);
  const spec = mkSpec();
  const v1 = lavalink.writeSettings(spec, { bufferDurationMs: 800, plugins: [] });
  assert.equal(v1.managed, true);
  assert.equal(v1.settings.bufferDurationMs, 800);
  assert.match(v1.raw, /bufferDurationMs: 800/);

  const v2 = lavalink.writeRaw(spec, 'server:\n  port: 2333\nlavalink:\n  server:\n    password: "mine"\n');
  assert.equal(v2.managed, false);
  assert.match(v2.raw, /password: "mine"/);
  assert.throws(() => lavalink.writeRaw(spec, '   '), /empty/);

  const v3 = lavalink.resetConfig(spec);
  assert.equal(v3.managed, true);
  assert.equal(v3.settings.bufferDurationMs, 400);
});

test('lavalink: probe reads /v4/info + /v4/stats with the server password', async () => {
  const seen = [];
  const fake = async (url, opts) => {
    seen.push([url, opts.headers.Authorization]);
    if (opts.headers.Authorization !== 'sekret') return { ok: false, status: 401, json: async () => ({}) };
    const body = url.endsWith('/v4/info') ? { version: { semver: '4.0.8' }, sourceManagers: ['soundcloud'], plugins: [{ name: 'youtube-plugin', version: '1.2.3' }] }
      : { players: 3, playingPlayers: 2, uptime: 5000, memory: { used: 104857600, allocated: 209715200 }, cpu: { cores: 2, systemLoad: 0.1, lavalinkLoad: 0.05 } };
    return { ok: true, status: 200, json: async () => body };
  };
  const ok = await lavalink.probe(mkSpec({ env: { LAVALINK_PASSWORD: 'sekret' } }), fake);
  assert.equal(ok.online, true);
  assert.equal(ok.version, '4.0.8');
  assert.equal(ok.stats.players, 3);
  assert.equal(ok.stats.memUsedMB, 100);
  assert.equal(seen[0][0].startsWith('http://127.0.0.1:23333/'), true);
  const bad = await lavalink.probe(mkSpec({ env: { LAVALINK_PASSWORD: 'wrong' } }), fake);
  assert.equal(bad.online, false);
  assert.match(bad.error, /password/);
  const down = await lavalink.probe(mkSpec(), async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); });
  assert.equal(down.online, false);
  assert.match(down.error, /not answering/);
});

test('nodejs: project info, credential stripping and fixed task scripts', () => {
  const id = 'bbbbbbbb-1111-2222-3333-444444444444';
  const d = vol(id);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'shop', version: '1.0.0', main: 'server.js', scripts: { build: 'vite build', start: 'node server.js' }, dependencies: { express: '^4' }, devDependencies: { vite: '^5' }, engines: { node: '>=20' } }));
  fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
  fs.mkdirSync(path.join(d, '.git'));
  fs.writeFileSync(path.join(d, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://me:ghp_SECRET@github.com/me/shop.git\n');
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const p = nodejs.project(id);
  assert.equal(p.hasPackageJson, true);
  assert.equal(p.name, 'shop');
  assert.equal(p.packageManager, 'pnpm');
  assert.equal(p.framework, 'Vite');
  assert.equal(p.dependencies, 1);
  assert.equal(p.git.present, true);
  assert.equal(p.git.remote, 'https://github.com/me/shop.git');
  assert.equal(JSON.stringify(p).includes('ghp_SECRET'), false);
  assert.equal(p.git.branch, 'main');

  assert.match(nodejs.scriptFor('build', 'pnpm'), /pnpm install[\s\S]*pnpm run build/);
  assert.match(nodejs.scriptFor('install', 'npm'), /npm ci/);
  assert.match(nodejs.scriptFor('update', 'npm'), /git pull --ff-only/);
  assert.match(nodejs.scriptFor('clean', 'npm'), /rm -rf node_modules/);
  assert.deepEqual(nodejs.TASKS, ['install', 'build', 'update', 'clean']);
  assert.rejects(() => nodejs.runTask(mkSpec({ id, kind: 'nodejs' }), 'rm -rf /'), /Unknown task/);
});

// ------------------------------------------------------------------------------------------------ website proxy
function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let buf = ''; s.on('data', c => { buf += c; if (buf.includes('\r\n\r\n') && /Content-Length: (\d+)/i.test(buf) === false) { /* wait */ } });
    s.on('end', () => resolve(buf)); s.on('error', reject); setTimeout(() => { s.destroy(); resolve(buf); }, 700);
  });
}
const get = (port, host, p = '/', headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host, ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', reject); r.end();
});

test('web: domains are validated', () => {
  assert.deepEqual(web.validateDomains(['Shop.Example.com', 'shop.example.com']), ['shop.example.com']);
  assert.throws(() => web.validateDomains(['localhost']), /Invalid domain/);
  assert.throws(() => web.validateDomains(['a.b.com/../x']), /Invalid domain/);
  assert.throws(() => web.validateDomains(Array.from({ length: 13 }, (_, i) => `d${i}.example.com`)), /Invalid domains/);
  assert.equal(web.hostOf('Shop.Example.com:8080'), 'shop.example.com');
  assert.equal(web.hostOf('127.0.0.1'), '');
  assert.equal(web.hostOf('[::1]:80'), '');
});

test('web: routes by Host, shows offline/unknown pages, never trusts forwarded headers, proxies websockets', async () => {
  // customer app
  const app = http.createServer((req, res) => { res.setHeader('x-app', '1'); res.end(JSON.stringify({ url: req.url, host: req.headers.host, xff: req.headers['x-forwarded-for'], proto: req.headers['x-forwarded-proto'], fwdHost: req.headers['x-forwarded-host'] })); });
  app.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello-from-app'); socket.end(); });
  const appPort = await listen(app);
  const site = mkSpec({ id: 'cccccccc-1111-2222-3333-444444444444', kind: 'website', ports: [{ host: appPort, container: appPort }], domains: ['shop.example.com'] });
  const off = mkSpec({ id: 'dddddddd-1111-2222-3333-444444444444', kind: 'website', ports: [{ host: 1, container: 1 }], domains: ['off.example.com'] });
  const running = new Set([site.id]);
  const h = web.makeHandlers({ lookup: d => [site, off].find(s => s.domains.includes(d)) || null, isRunning: async s => running.has(s.id), hasCert: () => false });
  const front = http.createServer((q, r) => { void h.request(q, r, 'http'); });
  front.on('upgrade', h.upgrade);
  const port = await listen(front);

  const ok = await get(port, 'shop.example.com', '/a?b=1', { 'X-Forwarded-For': '6.6.6.6', 'X-Forwarded-Proto': 'https' });
  assert.equal(ok.status, 200);
  const seen = JSON.parse(ok.body);
  assert.equal(seen.url, '/a?b=1');
  assert.equal(seen.host, 'shop.example.com');
  assert.equal(seen.xff, '127.0.0.1');            // the visitor's forged header was replaced
  assert.equal(seen.proto, 'http');
  assert.equal(ok.headers['x-app'], '1');

  assert.equal((await get(port, 'nobody.example.com')).status, 404);
  assert.equal((await get(port, 'off.example.com')).status, 503);
  assert.equal((await get(port, '127.0.0.1')).status, 404);

  // certbot webroot challenge
  fs.writeFileSync(path.join(config.web.acmeDir, 'tok_1234567890'), 'abc.def');
  const ch = await get(port, 'anything.example.com', '/.well-known/acme-challenge/tok_1234567890');
  assert.equal(ch.status, 200); assert.equal(ch.body, 'abc.def');
  assert.equal((await get(port, 'anything.example.com', '/.well-known/acme-challenge/..%2f..%2fpasswd')).status, 404);

  // websocket upgrade is passed straight through
  const ws = await raw(port, 'GET /socket HTTP/1.1\r\nHost: shop.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n');
  assert.match(ws, /101 Switching Protocols/);
  assert.match(ws, /hello-from-app/);
  const wsBad = await raw(port, 'GET /socket HTTP/1.1\r\nHost: nobody.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  assert.match(wsBad, /502/);

  // an app that is "running" but not answering
  app.close(); app.closeAllConnections?.();
  assert.equal((await get(port, 'shop.example.com')).status, 502);
  front.close();
});

// ------------------------------------------------------------------------------------------------ the real HTTP API
test('API: signed requests create kind servers and reach the kind routes', async () => {
  const { sign } = dist('auth.js');
  const { registerRoutes } = dist('app.js');
  const { startHttp } = dist('http.js');
  registerRoutes();
  config.port = 0;
  const server = startHttp();
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;

  const call = (method, p, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(16).toString('hex');
    const sig = sign(config.secret, ts, nonce, method, p, payload);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'X-Mono-Ts': ts, 'X-Mono-Nonce': nonce, 'X-Mono-Sig': sig, ...(payload.length ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.end(payload.length ? payload : undefined);
  });

  const lid = 'eeeeeeee-1111-2222-3333-444444444444';
  const base = { image: 'ghcr.io/x/y:1', startup: 'echo hi', stopCommand: '^C', env: { LAVALINK_PASSWORD: 'pw' }, ports: [{ host: 23456, container: 23456 }], limits: { ramMB: 512, cpuPercent: 100, diskMB: 1024, swapMB: 0, pids: 256 } };

  let r = await call('GET', '/v1/ping');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.services, ['bot', 'nodejs', 'website', 'lavalink']);
  assert.equal(r.json.version, '4.1.0');

  // a node that is not set up for vps refuses it, and unknown kinds are rejected
  r = await call('PUT', `/v1/servers/${lid}`, { ...base, kind: 'vps' });
  assert.equal(r.status, 400);
  r = await call('PUT', `/v1/servers/${lid}`, { ...base, kind: 'lavalink' });
  assert.equal(r.status, 200);
  assert.equal(r.json.spec.kind, 'lavalink');

  // the kind cannot change afterwards, and a later push without a kind keeps it
  r = await call('PUT', `/v1/servers/${lid}`, { ...base, kind: 'website' });
  assert.equal(r.status, 409);
  r = await call('PUT', `/v1/servers/${lid}`, { ...base });
  assert.equal(r.status, 200); assert.equal(r.json.spec.kind, 'lavalink');

  // domains only on website servers
  r = await call('PUT', `/v1/servers/${lid}`, { ...base, domains: ['a.example.com'] });
  assert.equal(r.status, 400);

  r = await call('GET', `/v1/servers/${lid}/lavalink/config`);
  assert.equal(r.status, 200); assert.equal(r.json.managed, true);
  r = await call('PUT', `/v1/servers/${lid}/lavalink/config`, { settings: { logLevel: 'DEBUG' } });
  assert.equal(r.status, 200); assert.match(r.json.raw, /root: DEBUG/);
  r = await call('GET', `/v1/servers/${lid}/lavalink/status`);
  assert.equal(r.status, 200); assert.equal(r.json.online, false);
  r = await call('GET', `/v1/servers/${lid}/nodejs/project`);
  assert.equal(r.status, 409);                                      // wrong kind for that route

  const wid = 'ffffffff-1111-2222-3333-444444444444';
  r = await call('PUT', `/v1/servers/${wid}`, { ...base, kind: 'website', domains: ['Site.Example.com'] });
  assert.equal(r.status, 200); assert.deepEqual(r.json.spec.domains, ['site.example.com']);
  r = await call('GET', `/v1/servers/${wid}/web`);
  assert.equal(r.status, 200); assert.deepEqual(r.json.domains, ['site.example.com']);
  r = await call('GET', `/v1/servers/${wid}/lavalink/config`);
  assert.equal(r.status, 409);
  r = await call('GET', '/v1/services');
  assert.deepEqual(r.json.servers, { lavalink: 1, website: 1 });

  // an unsigned request learns nothing
  const naked = await new Promise(res => http.get({ host: '127.0.0.1', port, path: '/v1/services' }, x => res(x.statusCode)));
  assert.equal(naked, 401);
  server.close(); server.closeAllConnections?.();
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50).unref(); });
