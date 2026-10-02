const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


const PORT = process.env.PORT !== undefined && !Number.isNaN(Number(process.env.PORT))
  ? Number(process.env.PORT)
  : 3002;
const DATA = process.env.CEM_DATA_DIR
  ? path.resolve(process.env.CEM_DATA_DIR)
  : path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const AUTH_FILE = path.join(DATA, 'auth.json');
// Session signing key. Set SESSION_SECRET so logins survive a restart; without
// it a fresh random key is generated per boot and every session is invalidated.
const TOKEN_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set - all sessions will reset on restart.');
}
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24h

const DB = {
  herd: [],
  farmers: [],
  transactions: [],
  events: [],
  projections: {
    years: [
      { year: 1, netProfit: 1220000, farmers: 5 },
      { year: 2, netProfit: 6720000, farmers: 15 },
      { year: 3, netProfit: 18880000, farmers: 30 },
      { year: 4, netProfit: 27800000, farmers: 50 },
      { year: 5, netProfit: 45200000, farmers: 80 },
      { year: 6, netProfit: 79000000, farmers: 100 },
      { year: 7, netProfit: 113000000, farmers: 120 },
      { year: 8, netProfit: 147000000, farmers: 140 },
      { year: 9, netProfit: 180000000, farmers: 160 },
      { year: 10, netProfit: 214000000, farmers: 180 }
    ]
  }
};

function load() {
  // A fresh clone has no data/ directory yet; create it before writing seeds.
  fs.mkdirSync(DATA, { recursive: true });
  for (const key of Object.keys(DB)) {
    const fp = path.join(DATA, key + '.json');
    try { DB[key] = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch { fs.writeFileSync(fp, JSON.stringify(DB[key], null, 2)); }
  }
}
function save(key) {
  fs.writeFileSync(path.join(DATA, key + '.json'), JSON.stringify(DB[key], null, 2));
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + key;
}

function verifyPassword(pw, stored) {
  const [salt, key] = stored.split(':');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return key === hash;
}

function createToken() {
  const payload = JSON.stringify({ t: Date.now() + SESSION_DURATION });
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + hmac;
}

function verifyToken(token) {
  try {
    const [encoded, hmac] = token.split('.');
    const payload = Buffer.from(encoded, 'base64').toString();
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (hmac !== expected) return false;
    const { t } = JSON.parse(payload);
    return Date.now() < t;
  } catch { return false; }
}

function authMiddleware(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  return verifyToken(token);
}

// --- Auth init ---
// No password is ever auto-provisioned. On first boot auth.json is absent, so
// the app stays in setup mode and the operator sets a password through
// POST /api/setup. Previously this block wrote a hardcoded default hash, which
// made setup unreachable and left a publicly known password on every install.
let auth = {};
try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
catch { auth = {}; }
if (!auth.passwordHash) {
  console.log('[auth] No password set. Open the app and complete first-time setup,');
  console.log('[auth] or POST /api/setup {"password":"..."} with 8+ characters.');
}

function saveAuth() {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

load();

let nextId = { herd: 1, farmers: 1, transactions: 1, events: 1 };
for (const key of ['herd', 'farmers', 'transactions', 'events']) {
  const arr = DB[key];
  if (arr.length > 0) nextId[key] = Math.max(...arr.map(x => x.id)) + 1;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function serveFile(res, filepath) {
  const ext = path.extname(filepath);
  fs.readFile(filepath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function getStats() {
  const herd = DB.herd;
  const total = herd.length;
  const alive = herd.filter(g => g.status === 'alive').length;
  const dead = herd.filter(g => g.status === 'dead').length;
  const sold = herd.filter(g => g.status === 'sold').length;
  const does = herd.filter(g => g.type === 'doe' && g.status === 'alive').length;
  const bucks = herd.filter(g => g.type === 'buck' && g.status === 'alive').length;
  const kids = herd.filter(g => g.type === 'kid' && g.status === 'alive').length;
  const births = herd.filter(g => g.status === 'alive' && g.source === 'born').length + dead + sold;
  const deaths = dead;
  const mortality = births > 0 ? Math.round((deaths / Math.max(births, 1)) * 100) : 0;
  return { total, alive, dead, sold, does, bucks, kids, births, deaths, mortality };
}

// --- AI Assistant ---
function buildFarmContext() {
  const stats = getStats();
  const txs = DB.transactions;
  const totalRev = txs.filter(t => t.type === 'revenue').reduce((s, t) => s + t.amount, 0);
  const totalExp = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const activeFarmers = DB.farmers.filter(f => f.status === 'active').length;
  const recentEvents = DB.events.slice().reverse().slice(0, 10).map(e => `${e.date?.slice(0,10) || ''} [${e.type}] ${e.detail}`).join('\n');
  return `
You are the CEASAR ENTERPRISE farm management AI assistant. You answer questions about the farm data below. Be concise, practical, and use numbers from the data. Answer in plain text without markdown.

CURRENT FARM DATA:
- Total goats: ${stats.total} (Alive: ${stats.alive}, Dead: ${stats.dead}, Sold: ${stats.sold})
- Breeding does: ${stats.does}, Bucks: ${stats.bucks}, Kids: ${stats.kids}
- Births (total): ${stats.births}, Deaths: ${stats.deaths}, Mortality rate: ${stats.mortality}%
- Farmers: ${DB.farmers.length} total (${activeFarmers} active)
- Total revenue: ${totalRev.toLocaleString()} UGX
- Total expenses: ${totalExp.toLocaleString()} UGX
- Net profit: ${(totalRev - totalExp).toLocaleString()} UGX
- Transactions recorded: ${txs.length}

RECENT ACTIVITY (last 10 events):
${recentEvents}

10-YEAR PROJECTIONS:
${DB.projections.years.map(y => `  Year ${y.year}: Net ${y.netProfit.toLocaleString()} UGX, ${y.farmers} farmers`).join('\n')}
`.trim();
}

async function askOllama(question, context) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'qwen2.5-coder:7b',
      messages: [
        { role: 'system', content: context },
        { role: 'user', content: question }
      ],
      stream: false
    });
    // Local LLM (Ollama or any OpenAI-compatible server). Runs fully offline;
    // the assistant panel degrades to "AI unavailable" when it is not running.
    const [aiHost, aiPort] = (process.env.AI_ENDPOINT || 'http://localhost:11434')
      .replace(/^https?:\/\//, '').split(':');
    const opts = {
      hostname: aiHost || 'localhost',
      port: Number(aiPort) || 11434,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content || 'No response'); }
        catch { resolve('Error parsing AI response'); }
      });
    });
    req.on('error', () => reject('Ollama not reachable. Make sure Ollama is running on localhost:11434.'));
    req.write(body);
    req.end();
  });
}

const publicRoutes = ['POST /api/login', 'POST /api/setup', 'GET /api/auth-status'];

const routes = {
  'POST /api/setup': async (req, res) => {
    if (auth.passwordHash) { res.writeHead(400); res.end(JSON.stringify({ error: 'Already set up' })); return; }
    const { password } = await parseBody(req);
    if (!password || password.length < 8) { res.writeHead(400); res.end(JSON.stringify({ error: 'Password must be 8+ chars' })); return; }
    auth.passwordHash = hashPassword(password);
    saveAuth();
    res.end(JSON.stringify({ token: createToken() }));
  },
  'POST /api/login': async (req, res) => {
    if (!auth.passwordHash) { res.writeHead(400); res.end(JSON.stringify({ error: 'No password set. First-time setup required.' })); return; }
    const { password } = await parseBody(req);
    if (!verifyPassword(password, auth.passwordHash)) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid password' })); return; }
    res.end(JSON.stringify({ token: createToken() }));
  },
  'GET /api/auth-status': (req, res) => {
    const hasAuth = !!auth.passwordHash;
    res.end(JSON.stringify({ hasAuth, authed: hasAuth ? authMiddleware(req, res) : false }));
  },
  'GET /api/herd': (req, res) => {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const type = qs.get('type'), status = qs.get('status');
    let list = DB.herd;
    if (type) list = list.filter(g => g.type === type);
    if (status) list = list.filter(g => g.status === status);
    res.end(JSON.stringify(list));
  },
  'GET /api/herd/stats': (req, res) => res.end(JSON.stringify(getStats())),
  'POST /api/herd': async (req, res) => {
    const g = await parseBody(req);
    g.id = nextId.herd++;
    g.createdAt = new Date().toISOString();
    DB.herd.push(g);
    save('herd');
    DB.events.push({ id: nextId.events++, type: 'herd', action: 'added', detail: `${g.name || g.tag} (${g.type})`, date: g.createdAt });
    save('events');
    res.writeHead(201); res.end(JSON.stringify(g));
  },
  'PUT /api/herd': async (req, res) => {
    const g = await parseBody(req);
    const idx = DB.herd.findIndex(x => x.id === g.id);
    if (idx === -1) { res.writeHead(404); res.end('{}'); return; }
    const old = DB.herd[idx];
    DB.herd[idx] = { ...old, ...g, id: old.id, createdAt: old.createdAt };
    save('herd');
    if (old.status !== g.status && g.status === 'dead') {
      DB.events.push({ id: nextId.events++, type: 'herd', action: 'death', detail: `${g.name || g.tag} died`, date: new Date().toISOString() });
      save('events');
    }
    res.end(JSON.stringify(DB.herd[idx]));
  },
  'DELETE /api/herd': async (req, res) => {
    const { id } = await parseBody(req);
    DB.herd = DB.herd.filter(x => x.id !== id);
    save('herd');
    res.end(JSON.stringify({ ok: true }));
  },

  'GET /api/farmers': (req, res) => res.end(JSON.stringify(DB.farmers)),
  'POST /api/farmers': async (req, res) => {
    const f = await parseBody(req);
    f.id = nextId.farmers++;
    f.createdAt = new Date().toISOString();
    f.status = f.status || 'active';
    DB.farmers.push(f);
    save('farmers');
    DB.events.push({ id: nextId.events++, type: 'coop', action: 'joined', detail: `${f.name} joined cooperative`, date: f.createdAt });
    save('events');
    res.writeHead(201); res.end(JSON.stringify(f));
  },
  'PUT /api/farmers': async (req, res) => {
    const f = await parseBody(req);
    const idx = DB.farmers.findIndex(x => x.id === f.id);
    if (idx === -1) { res.writeHead(404); res.end('{}'); return; }
    DB.farmers[idx] = { ...DB.farmers[idx], ...f, id: DB.farmers[idx].id, createdAt: DB.farmers[idx].createdAt };
    save('farmers');
    res.end(JSON.stringify(DB.farmers[idx]));
  },
  'DELETE /api/farmers': async (req, res) => {
    const { id } = await parseBody(req);
    DB.farmers = DB.farmers.filter(x => x.id !== id);
    save('farmers');
    res.end(JSON.stringify({ ok: true }));
  },

  'GET /api/finances': (req, res) => res.end(JSON.stringify(DB.transactions)),
  'GET /api/finances/summary': (req, res) => {
    const txs = DB.transactions;
    const totalRev = txs.filter(t => t.type === 'revenue').reduce((s, t) => s + t.amount, 0);
    const totalExp = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const byCategory = {};
    for (const t of txs) {
      byCategory[t.category] = (byCategory[t.category] || 0) + (t.type === 'revenue' ? t.amount : -t.amount);
    }
    res.end(JSON.stringify({ totalRevenue: totalRev, totalExpenses: totalExp, net: totalRev - totalExp, byCategory }));
  },
  'POST /api/finances': async (req, res) => {
    const t = await parseBody(req);
    t.id = nextId.transactions++;
    t.date = t.date || new Date().toISOString().slice(0, 10);
    DB.transactions.push(t);
    save('transactions');
    DB.events.push({ id: nextId.events++, type: 'finance', action: t.type, detail: `${t.category}: ${t.amount.toLocaleString()} UGX`, date: t.date });
    save('events');
    res.writeHead(201); res.end(JSON.stringify(t));
  },
  'PUT /api/finances': async (req, res) => {
    const t = await parseBody(req);
    const idx = DB.transactions.findIndex(x => x.id === t.id);
    if (idx === -1) { res.writeHead(404); res.end('{}'); return; }
    DB.transactions[idx] = { ...DB.transactions[idx], ...t, id: DB.transactions[idx].id, createdAt: DB.transactions[idx].createdAt };
    save('transactions');
    res.end(JSON.stringify(DB.transactions[idx]));
  },
  'DELETE /api/finances': async (req, res) => {
    const { id } = await parseBody(req);
    DB.transactions = DB.transactions.filter(x => x.id !== id);
    save('transactions');
    res.end(JSON.stringify({ ok: true }));
  },

  'GET /api/projections': (req, res) => res.end(JSON.stringify(DB.projections)),
  'PUT /api/finances/bulk': async (req, res) => {
    const { transactions } = await parseBody(req);
    DB.transactions = transactions || [];
    save('transactions');
    res.end(JSON.stringify({ ok: true }));
  },
  'PUT /api/projections': async (req, res) => {
    const p = await parseBody(req);
    DB.projections = { ...DB.projections, ...p };
    save('projections');
    res.end(JSON.stringify(DB.projections));
  },

  'GET /api/events': (req, res) => {
    const qs = new URL(req.url, 'http://localhost').searchParams;
    const limit = qs.get('limit');
    let list = DB.events.slice().reverse();
    if (limit) list = list.slice(0, parseInt(limit));
    res.end(JSON.stringify(list));
  },
  'POST /api/events': async (req, res) => {
    const e = await parseBody(req);
    e.id = nextId.events++;
    e.date = e.date || new Date().toISOString();
    DB.events.push(e);
    save('events');
    res.writeHead(201); res.end(JSON.stringify(e));
  },
  'POST /api/ai/query': async (req, res) => {
    const { question } = await parseBody(req);
    if (!question) { res.writeHead(400); res.end(JSON.stringify({ error: 'Question required' })); return; }
    try {
      const context = buildFarmContext();
      const answer = await askOllama(question, context);
      res.end(JSON.stringify({ answer }));
    } catch (e) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'AI unavailable', detail: e?.message || String(e) }));
    }
  }
};

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const routeKey = `${req.method} ${parsed.pathname}`;

  if (routes[routeKey]) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (publicRoutes.includes(routeKey)) {
      routes[routeKey](req, res);
    } else if (!authMiddleware(req, res)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    } else {
      routes[routeKey](req, res);
    }
    return;
  }

  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(PUBLIC, filePath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, filePath);
});

// Only listen when run directly, so tests can import the server and bind an
// ephemeral port themselves.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`CEASAR ENTERPRISE Manager running on http://localhost:${PORT}`);
  });
}

module.exports = { server, routes, hashPassword, verifyPassword, createToken, verifyToken };
