/**
 * Authentication, session and static-file behaviour.
 *
 * The app is a single-file HTTP server. We import it (the listen call is
 * guarded by require.main) bind port 0 and point CEM_DATA_DIR at a scratch
 * directory, so the real data/ is never touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cem-test-'));

process.env.CEM_DATA_DIR = SCRATCH;
process.env.SESSION_SECRET = 'test-secret-pinned-for-determinism';

const { server, hashPassword, verifyPassword, createToken, verifyToken } = require('../index.js');

const PASSWORD = 'correct-horse-battery';

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

const post = (route, body, token) =>
  fetch(base + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (route, token) =>
  fetch(base + route, {
    headers: { Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

// --- password hashing ---

test('hashPassword salts each hash and round-trips the password', () => {
  const a = hashPassword(PASSWORD);
  const b = hashPassword(PASSWORD);

  assert.match(a, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'expected salt:key hex');
  assert.notEqual(a, b, 'the same password must not produce the same hash twice');
  assert.equal(verifyPassword(PASSWORD, a), true);
  assert.equal(verifyPassword('wrong-password', a), false);
});

test('verifyPassword rejects a malformed stored hash instead of throwing', () => {
  assert.equal(verifyPassword(PASSWORD, 'garbage'), false);
  assert.equal(verifyPassword(PASSWORD, ''), false);
});

test('createToken/verifyToken round-trips and rejects a foreign secret', () => {
  const token = createToken();
  assert.equal(verifyToken(token), true);

  const [payload, hmac] = token.split('.');
  const forged = [
    payload,
    crypto.createHmac('sha256', 'not-the-real-secret').update(payload).digest('hex'),
  ].join('.');
  assert.equal(verifyToken(forged), false, 'a token signed with another secret must not verify');
  assert.equal(verifyToken('nonsense'), false);
  assert.equal(verifyToken(''), false);
});

test('an expired token is rejected', () => {
  const payload = Buffer.from(JSON.stringify({ t: Date.now() - 1000 })).toString('base64');
  const expired = `${payload}.${crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload)
    .digest('hex')}`;

  assert.equal(verifyToken(expired), false);
});

test('the hardcoded default password is gone from the source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.equal(src.includes('1010F'), false, 'the known default password must be gone');
});

test('a data directory that does not exist yet is created on boot', () => {
  // A fresh clone ships no data/, so load() must create it rather than throw.
  const missing = path.join(SCRATCH, 'nested', 'fresh-clone', 'data');
  assert.equal(fs.existsSync(missing), false, 'precondition: the dir is absent');

  const { spawnSync } = require('node:child_process');
  const out = spawnSync(process.execPath, ['-e', "require(process.argv[1]); console.log('booted');", path.join(ROOT, 'index.js')], {
    env: { ...process.env, CEM_DATA_DIR: missing },
    encoding: 'utf8',
  });

  assert.equal(out.status, 0, `boot failed:\n${out.stderr}`);
  assert.match(out.stdout, /booted/);
  assert.equal(fs.existsSync(path.join(missing, 'herd.json')), true, 'seed files should be written');
});

// --- the live HTTP flow, in order ---

test('a fresh install starts unconfigured', async () => {
  const status = await get('/api/auth-status');
  const body = await status.json();

  assert.equal(status.status, 200);
  assert.equal(body.hasAuth, false, 'a fresh install must not be pre-provisioned');

  // Nothing may have been written with a password.
  const authFile = path.join(SCRATCH, 'auth.json');
  if (fs.existsSync(authFile)) {
    assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).passwordHash, undefined);
  }

  // Login must refuse while unconfigured.
  const login = await post('/api/login', { password: '1010F' });
  assert.equal(login.status, 400);
  assert.match((await login.json()).error, /setup/i);
});

test('setup rejects a weak password', async () => {
  const weak = await post('/api/setup', { password: 'short' });
  assert.equal(weak.status, 400);
  assert.match((await weak.json()).error, /8\+/);

  const missing = await post('/api/setup', {});
  assert.equal(missing.status, 400);
});

test('setup accepts a real password and cannot be replayed', async () => {
  const setup = await post('/api/setup', { password: PASSWORD });
  assert.equal(setup.status, 200);

  const again = await post('/api/setup', { password: 'another-one' });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /already/i);

  // The hash is persisted, salted, and never the plaintext.
  const stored = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'auth.json'), 'utf8'));
  assert.match(stored.passwordHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(stored.passwordHash.includes(PASSWORD), false);

  const status = await (await get('/api/auth-status')).json();
  assert.equal(status.hasAuth, true);
});

test('login refuses a wrong password and issues a token for the right one', async () => {
  const wrong = await post('/api/login', { password: 'not-the-password' });
  assert.equal(wrong.status, 401);

  const ok = await post('/api/login', { password: PASSWORD });
  assert.equal(ok.status, 200);

  const { token } = await ok.json();
  assert.equal(typeof token, 'string');
  assert.ok(token.includes('.'), 'token should be payload.hmac');
});

test('protected routes reject anonymous, bogus and forged tokens', async () => {
  const anon = await get('/api/herd');
  assert.equal(anon.status, 401);

  const bogus = await get('/api/herd', 'nonsense.token');
  assert.equal(bogus.status, 401);

  const { token } = await (await post('/api/login', { password: PASSWORD })).json();
  const [payload] = token.split('.');
  const forged = [
    payload,
    crypto.createHmac('sha256', 'another-secret').update(payload).digest('hex'),
  ].join('.');
  assert.equal((await get('/api/herd', forged)).status, 401);
});

test('an authenticated request reaches the data layer', async () => {
  const { token } = await (await post('/api/login', { password: PASSWORD })).json();

  const herd = await get('/api/herd', token);
  assert.equal(herd.status, 200);
  assert.ok(Array.isArray(await herd.json()));
});

test('static files are served and traversal is refused', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);

  const missing = await get('/does-not-exist.html');
  assert.equal(missing.status, 404);

  // The path join is guarded by a startsWith check on PUBLIC.
  const escape = await fetch(`${base}/../index.js`, { headers: { Connection: 'close' } });
  assert.ok(escape.status === 403 || escape.status === 404,
    `expected traversal to be blocked, got ${escape.status}`);
});
