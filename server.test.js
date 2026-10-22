// Tests use a LOCAL MOCK of Gemini. They do NOT call the real Gemini API.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { createApp } = require('../server');
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
let mock, mport, mode = 'ok', seen = [];
before(async () => {
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(b || '{}') });
      if (mode === 'hang') return;
      if (mode === 'err') { res.writeHead(500); return res.end('{}'); }
      if (mode === 'badjson') { res.writeHead(200); return res.end('not json'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'empty' ? { candidates: [] } : { candidates: [{ content: { parts: [{ text: 'MOCK REPLY' }] } }] }));
    });
  });
  mport = await listen(mock);
});
after(() => { mock.closeAllConnections(); mock.close(); });
async function start(o = {}, dir) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'cai-'));
  const app = createApp({ GEMINI_API_KEY: 'test-key-123', GEMINI_BASE_URL: `http://127.0.0.1:${mport}`, DATA_DIR: dir, DAILY_LIMIT: '50', RATE_LIMIT: '100', ...o });
  const port = await listen(app.server);
  return { base: `http://127.0.0.1:${port}`, dir, close: () => { app.server.closeAllConnections(); app.server.close(); } };
}
const post = (b, body, h = { 'content-type': 'application/json' }) => fetch(b + '/api/generate', { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ok = { tool: 'writer', messages: [{ role: 'user', text: 'hello' }], lang: 'en' };

test('health, status and static page', async () => {
  const s = await start();
  assert.equal((await fetch(s.base + '/healthz')).status, 200);
  const st = await (await fetch(s.base + '/api/status')).json();
  assert.equal(st.gemini, true); assert.equal(st.image, false); assert.equal(st.auth, false); assert.equal(st.payments, false);
  const page = await fetch(s.base + '/'); const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /CreatorAI Tools/);
  assert.ok(!html.includes('test-key-123')); assert.ok(!JSON.stringify(st).includes('test-key-123'));
  assert.ok(page.headers.get('content-security-policy'));
  s.close();
});
test('path traversal and unknown routes are blocked', async () => {
  const s = await start();
  assert.equal((await fetch(s.base + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(s.base + '/server.js')).status, 404);
  assert.equal((await fetch(s.base + '/api/nope')).status, 404);
  assert.equal((await fetch(s.base + '/api/generate')).status, 405);
  s.close();
});
test('missing key gives 503', async () => {
  const s = await start({ GEMINI_API_KEY: '' });
  assert.equal((await post(s.base, ok)).status, 503);
  assert.equal((await (await fetch(s.base + '/api/status')).json()).gemini, false);
  s.close();
});
test('input validation', async () => {
  const s = await start();
  const bad = [{ ...ok, tool: 'x' }, { ...ok, tool: '__proto__' }, { ...ok, messages: [] }, { ...ok, messages: [{ role: 'user', text: '  ' }] },
    { ...ok, messages: [{ role: 'user', text: 'a'.repeat(2001) }] }, { ...ok, messages: [{ role: 'admin', text: 'hi' }] },
    { ...ok, messages: [{ role: 'model', text: 'hi' }] }, { ...ok, messages: Array(21).fill({ role: 'user', text: 'a' }) }, { messages: 5 }];
  for (const b of bad) assert.equal((await post(s.base, b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal((await post(s.base, '{broken')).status, 400);
  assert.equal((await post(s.base, ok, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(s.base, 'x'.repeat(30000))).status, 413);
  s.close();
});
test('success path sends key only to Gemini, language and tool prompt applied', async () => {
  seen = []; mode = 'ok';
  const s = await start();
  const r = await post(s.base, { ...ok, tool: 'caption', lang: 'ar' });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.text, 'MOCK REPLY'); assert.equal(j.used, 1);
  assert.equal(seen[0].key, 'test-key-123');
  assert.match(seen[0].body.systemInstruction.parts[0].text, /captions.*Arabic/s);
  assert.ok(!JSON.stringify(j).includes('test-key-123'));
  s.close();
});
test('Gemini failures return safe errors and do not use up quota', async () => {
  const s = await start();
  for (const [m, code] of [['err', 502], ['empty', 502], ['badjson', 502]]) { mode = m; assert.equal((await post(s.base, ok)).status, code, m); }
  mode = 'ok';
  assert.equal((await (await fetch(s.base + '/api/status')).json()).used, 0);
  s.close();
});
test('timeout returns 504', async () => {
  mode = 'hang'; const s = await start({ TIMEOUT_MS: '300' });
  assert.equal((await post(s.base, ok)).status, 504); mode = 'ok'; s.close();
});
test('daily limit survives a server restart', async () => {
  mode = 'ok'; let s = await start({ DAILY_LIMIT: '2' }); const dir = s.dir;
  assert.equal((await post(s.base, ok)).status, 200); assert.equal((await post(s.base, ok)).status, 200);
  assert.equal((await post(s.base, ok)).status, 429); s.close();
  s = await start({ DAILY_LIMIT: '2' }, dir);
  assert.equal((await (await fetch(s.base + '/api/status')).json()).used, 2);
  assert.equal((await post(s.base, ok)).status, 429); s.close();
});
test('global daily cap and per-minute rate limit', async () => {
  mode = 'ok'; let s = await start({ GLOBAL_DAILY_LIMIT: '1' });
  assert.equal((await post(s.base, ok)).status, 200); assert.equal((await post(s.base, ok)).status, 429); s.close();
  s = await start({ RATE_LIMIT: '2' });
  assert.equal((await post(s.base, ok)).status, 200); assert.equal((await post(s.base, ok)).status, 200);
  assert.equal((await post(s.base, ok)).status, 429); s.close();
});
test('browser script has valid syntax and no secrets', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0];
  new vm.Script(js);
  assert.ok(!/AIza[\w-]{20,}|sk-[\w-]{20,}|test-key-123/.test(html));
});
