const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---- tiny .env loader (no dependencies) ----
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#]*?)\s*(#.*)?$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
} } catch {}

const PLANS = require('./lib/plans'), ai = require('./lib/ai'), payments = require('./lib/payments');
const PORT = process.env.PORT || 3000, PROD = process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tool TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, tool TEXT NOT NULL, input TEXT, output TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gen_user ON generations(user_id, created_at);`);

const now = () => Date.now();
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [s, h] = stored.split(':'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const err = (status, message, extra) => Object.assign(new Error(message), { status, extra });

function usageInfo(u) {
  const p = PLANS[u.plan] || PLANS.free;
  const d = new Date(), since = p.period === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) : 0;
  const used = db.prepare('SELECT COUNT(*) c FROM usage WHERE user_id=? AND created_at>=?').get(u.id, since).c;
  return { used, limit: p.limit, remaining: Math.max(0, p.limit - used), period: p.period };
}
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, plan: u.plan, planName: (PLANS[u.plan] || PLANS.free).name, isAdmin: !!u.is_admin, usage: usageInfo(u) });

// ---- sessions ----
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]));
function currentUser(req) {
  const t = cookieOf(req).sid; if (!t) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(t, now()) || null;
}
function startSession(res, userId) {
  const t = crypto.randomBytes(32).toString('hex'), days = 30;
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, userId, now() + days * 864e5);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${PROD ? '; Secure' : ''}`);
}
const need = req => { const u = currentUser(req); if (!u) throw err(401, 'Please log in'); return u; };
const needAdmin = req => { const u = need(req); if (!u.is_admin) throw err(403, 'Admins only'); return u; };

// ---- simple in-memory rate limit for auth ----
const hits = new Map();
function limitAuth(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress, t = now();
  const arr = (hits.get(ip) || []).filter(x => t - x < 15 * 60e3); arr.push(t); hits.set(ip, arr);
  if (arr.length > 20) throw err(429, 'Too many attempts. Try again in a few minutes.');
}

// ---- API routes ----
const routes = {
  'POST /api/signup': async (req, body) => {
    limitAuth(req);
    const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || ''), name = String(body.name || '').trim().slice(0, 60);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw err(400, 'Enter a valid email');
    if (pw.length < 8) throw err(400, 'Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw err(409, 'Email already registered');
    const admin = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;
    const r = db.prepare('INSERT INTO users(email,name,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)').run(email, name, hashPw(pw), admin, now());
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid)), _login: Number(r.lastInsertRowid) };
  },
  'POST /api/login': async (req, body) => {
    limitAuth(req);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email || '').trim().toLowerCase());
    if (!u || !checkPw(String(body.password || ''), u.password_hash)) throw err(401, 'Wrong email or password');
    return { user: publicUser(u), _login: u.id };
  },
  'POST /api/logout': async (req, b, res) => {
    const t = cookieOf(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); return { ok: true };
  },
  'GET /api/me': async req => { const u = currentUser(req); return { user: u ? publicUser(u) : null }; },
  'GET /api/config': async () => ({
    tools: Object.entries(ai.TOOLS).map(([id, t]) => ({ id, name: t.name, icon: t.icon, desc: t.desc, label: t.label, ph: t.ph })),
    tones: ai.TONES, platforms: ai.PLATFORMS,
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })), paymentsReady: payments.configured(),
  }),
  'POST /api/generate': async (req, body) => {
    const u = need(req), tool = String(body.tool || ''), input = String(body.input || '').trim();
    if (!ai.TOOLS[tool]) throw err(400, 'Unknown tool');
    if (input.length < 3) throw err(400, 'Please enter some text first');
    if (input.length > 2000) throw err(400, 'Input too long (max 2000 characters)');
    if (usageInfo(u).remaining <= 0) throw err(402, 'You have used all your generations.', { upgrade: true });
    const tone = ai.TONES.includes(body.tone) ? body.tone : ai.TONES[0], platform = ai.PLATFORMS.includes(body.platform) ? body.platform : ai.PLATFORMS[0];
    const output = await ai.generate(tool, input, tone, platform);
    if (!output) throw err(502, 'The AI returned an empty answer. Please try again.');
    db.prepare('INSERT INTO usage(user_id,tool,created_at) VALUES(?,?,?)').run(u.id, tool, now()); // only charged on success
    return { output, usage: usageInfo(u) };
  },
  'GET /api/saved': async req => ({ items: db.prepare('SELECT id,tool,input,output,created_at FROM generations WHERE user_id=? ORDER BY id DESC LIMIT 100').all(need(req).id) }),
  'POST /api/saved': async (req, body) => {
    const u = need(req), tool = String(body.tool || ''), output = String(body.output || '').slice(0, 20000);
    if (!ai.TOOLS[tool] || !output) throw err(400, 'Nothing to save');
    const r = db.prepare('INSERT INTO generations(user_id,tool,input,output,created_at) VALUES(?,?,?,?,?)').run(u.id, tool, String(body.input || '').slice(0, 2000), output, now());
    return { id: Number(r.lastInsertRowid) };
  },
  'DELETE /api/saved': async (req, body, res, id) => { db.prepare('DELETE FROM generations WHERE id=? AND user_id=?').run(Number(id), need(req).id); return { ok: true }; },
  'POST /api/checkout': async (req, body) => { const u = need(req); if (!PLANS[body.plan] || body.plan === 'free') throw err(400, 'Invalid plan'); return payments.createCheckout(u, body.plan); },
  // ---- admin foundation ----
  'GET /api/admin/users': async req => {
    needAdmin(req);
    return { users: db.prepare('SELECT id,email,name,plan,is_admin,created_at,(SELECT COUNT(*) FROM usage WHERE user_id=users.id) used FROM users ORDER BY id DESC LIMIT 200').all() };
  },
  'POST /api/admin/plan': async (req, body) => {
    needAdmin(req); if (!PLANS[body.plan]) throw err(400, 'Invalid plan');
    db.prepare('UPDATE users SET plan=? WHERE id=?').run(body.plan, Number(body.id)); return { ok: true };
  },
};

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 50000) { no(err(413, 'Request too large')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(err(400, 'Bad JSON')); } }); });
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p.startsWith('/api/')) {
    try {
      let key = `${req.method} ${p}`, arg;
      const m = p.match(/^\/api\/saved\/(\d+)$/); if (m && req.method === 'DELETE') { key = 'DELETE /api/saved'; arg = m[1]; }
      const h = routes[key]; if (!h) throw err(404, 'Not found');
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('json') && req.method !== 'DELETE') throw err(415, 'JSON only');
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await h(req, body, res, arg);
      if (out && out._login) { startSession(res, out._login); delete out._login; }
      return send(res, 200, out);
    } catch (e) {
      if (!e.status) console.error(e);
      return send(res, e.status || 500, { error: e.status ? e.message : 'Server error', ...(e.extra || {}) });
    }
  }
  const rel = p === '/' ? 'index.html' : p.slice(1), file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, SEC); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', ...SEC }); res.end(data);
  });
});
if (require.main === module) server.listen(PORT, () => console.log(`CreatorAI Studio running on port ${PORT}${process.env.AI_API_KEY ? '' : '  (AI_API_KEY missing: AI tools REQUIRE CONFIGURATION)'}`));
module.exports = { server, db };
