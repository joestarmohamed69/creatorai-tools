// Quick end-to-end check: node test.js  (uses a temp DB, no real AI call)
process.env.DB_PATH = require('os').tmpdir() + '/cai-test-' + Date.now() + '.db'; process.env.AI_API_KEY = '';
const { server } = require('./server');
const assert = require('assert');
server.listen(0, async () => {
  const base = 'http://localhost:' + server.address().port; let cookie = '';
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { s: r.status, d: await r.json().catch(() => ({})) }; };
  let r = await call('POST', '/api/generate', { tool: 'ideas', input: 'abc' }); assert.equal(r.s, 401, 'unauth blocked');
  r = await call('POST', '/api/signup', { email: 'a@b.co', password: 'short' }); assert.equal(r.s, 400, 'short pw rejected');
  r = await call('POST', '/api/signup', { email: 'a@b.co', password: 'password123', name: 'A' }); assert.equal(r.s, 200); assert.equal(r.d.user.usage.remaining, 10);
  r = await call('POST', '/api/login', { email: 'a@b.co', password: 'wrong' }); assert.equal(r.s, 401);
  r = await call('POST', '/api/generate', { tool: 'ideas', input: 'fitness' }); assert.equal(r.s, 503, 'missing key reported');
  require('./server').db.prepare('INSERT INTO usage(user_id,tool,created_at) SELECT 1,\'ideas\',? FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<10) SELECT x FROM c)').run(Date.now());
  r = await call('POST', '/api/generate', { tool: 'ideas', input: 'fitness' }); assert.equal(r.s, 402); assert.equal(r.d.upgrade, true, 'limit enforced');
  r = await call('POST', '/api/saved', { tool: 'ideas', input: 'x', output: 'result' }); assert.equal(r.s, 200);
  r = await call('GET', '/api/saved'); assert.equal(r.d.items.length, 1);
  r = await call('DELETE', '/api/saved/' + r.d.items[0].id); assert.equal(r.s, 200);
  r = await call('POST', '/api/checkout', { plan: 'pro' }); assert.equal(r.s, 501, 'payments honest');
  r = await call('GET', '/api/admin/users'); assert.equal(r.s, 403, 'admin protected');
  const h = await fetch(base + '/'); assert.equal(h.status, 200);
  const t = await fetch(base + '/..%2fserver.js'); assert.notEqual(t.status, 200 + 0 * 1, 'no traversal');
  await call('POST', '/api/logout', {}); r = await call('GET', '/api/me'); assert.equal(r.d.user, null);
  console.log('ALL TESTS PASSED'); process.exit(0);
});
