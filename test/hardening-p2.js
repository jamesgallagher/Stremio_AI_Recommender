// Hardening phase 2 — sign-in, first-run setup, transport (no network). Run via `npm test`.
//   OTP: 5 requests/hour, keyed code hash   Setup: one-time token   Transport: CORS scope, headers, log redaction
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-hard2-' + Date.now();
process.env.SECRET_KEY = 'test-secret-key-do-not-use-in-prod';
process.env.PORT = '7399';
process.env.EXTERNAL_URL = '';
process.env.BREVO_SMTP_LOGIN = ''; process.env.BREVO_SMTP_KEY = ''; // never send real mail
const assert = require('assert');

let n = 0;
async function ok(name, fn) { await fn(); n++; console.log(`  ✓ ${name}`); }

(async () => {
  console.log('hardening phase 2:');
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
  console.warn = (...a) => { logs.push(a.join(' ')); origWarn(...a); };

  require('../src/server');
  await new Promise((r) => setTimeout(r, 300));
  const BASE = 'http://localhost:7399';
  const auth = require('../mobile/server/auth');
  const otpStore = require('../mobile/server/otpStore');
  const config = require('../src/config');

  await ok('first run: the boot log prints a setup token, and the wizard REQUIRES it', async () => {
    assert.ok(logs.some((l) => l.includes('Setup token:') && l.includes(require('../mobile/server/auth').getSetupToken())), 'the token is printed in the log');
    assert.deepStrictEqual(await (await fetch(`${BASE}/mobile/api/setup`)).json(), { needed: true });
    const post = (body) => fetch(`${BASE}/mobile/api/setup/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // validation errors still come first (no token needed to be told your email is malformed)
    assert.strictEqual((await post({ name: 'Me', email: 'nope' })).status, 400);
    // no token / wrong token → 401, no code is generated
    assert.strictEqual((await post({ name: 'Me', email: 'me@example.com' })).status, 401);
    assert.strictEqual((await post({ name: 'Me', email: 'me@example.com', token: 'x'.repeat(24) })).status, 401);
    assert.strictEqual(auth.getSetupToken().length, 24);
    // the right token → accepted
    const good = await post({ name: 'Me', email: 'me@example.com', token: auth.getSetupToken() });
    assert.strictEqual(good.status, 200);
    auth._resetSetup();
  });

  await ok('setup token attempts are limited (10 wrong guesses lock the wizard)', async () => {
    const post = (token) => fetch(`${BASE}/mobile/api/setup/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Me', email: 'me@example.com', token }) });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post('wrong-' + i)).status;
    assert.strictEqual(last, 429);
    // even the right token is refused while locked
    assert.strictEqual((await post(auth.getSetupToken())).status, 429);
  });

  const p = config.addProfile('OtpUser'); config.updateProfile(p.id, { email: 'otp@example.com' });
  const send = async () => {};

  await ok('OTP: at most 5 code requests per email per HOUR; the 6th is refused, one is allowed again after the hour', async () => {
    auth._resetRateLimits();
    assert.strictEqual(auth.RATE_WINDOW_MS, 60 * 60e3);
    assert.strictEqual(auth.MAX_REQUESTS, 5);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const r = await auth.requestOtp('otp@example.com', { nowMs: t0 + i * 60e3, sendMail: send });
      assert.strictEqual(r.issued, true, `request ${i + 1} issued`);
    }
    const sixth = await auth.requestOtp('otp@example.com', { nowMs: t0 + 30 * 60e3, sendMail: send }); // 30 min later: same window
    assert.deepStrictEqual([sixth.issued, sixth.reason], [false, 'rate-limited']);
    const later = await auth.requestOtp('otp@example.com', { nowMs: t0 + 61 * 60e3, sendMail: send });
    assert.strictEqual(later.issued, true, 'allowed again once the hour has passed');
  });

  await ok('OTP: a code is valid 60 minutes and dies after 5 wrong tries', async () => {
    auth._resetRateLimits();
    assert.strictEqual(auth.OTP_TTL_MIN, 60);
    assert.strictEqual(auth.MAX_ATTEMPTS, 5);
    let now = Date.now();
    await auth.requestOtp('otp@example.com', { nowMs: now, sendMail: send });
    const reasons = [];
    for (let i = 0; i < 7; i++) reasons.push(auth.verifyOtp('otp@example.com', '000000', { nowMs: now }).reason);
    assert.deepStrictEqual(reasons.slice(0, 5), Array(5).fill('bad-code'));
    assert.strictEqual(reasons[5], 'locked');
  });

  await ok('OTP: the stored code hash is KEYED (HMAC) — not the plain SHA-256 of a 6-digit number', async () => {
    const h = otpStore.codeHash('123456');
    assert.notStrictEqual(h, otpStore.sha256('123456'));
    assert.strictEqual(h, otpStore.codeHash('123456'), 'deterministic');
    const saved = process.env.SECRET_KEY; process.env.SECRET_KEY = 'a-different-key';
    assert.notStrictEqual(otpStore.codeHash('123456'), h, 'depends on the server secret');
    process.env.SECRET_KEY = saved;
    // a correct code still verifies end to end
    auth._resetRateLimits();
    let sent; await auth.requestOtp('otp@example.com', { nowMs: Date.now(), sendMail: async (m) => { sent = m; } });
    const v = auth.verifyOtp('otp@example.com', sent.code);
    assert.strictEqual(v.ok, true);
  });

  await ok('CORS is scoped to /addon; portal API + companion send no Access-Control-Allow-Origin; hardening headers present', async () => {
    const acao = async (path) => (await fetch(`${BASE}${path}`, { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin');
    assert.strictEqual(await acao('/api/profiles'), null);
    assert.strictEqual(await acao('/mobile/api/config'), null);
    assert.strictEqual(await acao('/addon/zzz/manifest.json'), '*');
    const h = await fetch(`${BASE}/health`);
    assert.strictEqual(h.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(h.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(h.headers.get('referrer-policy'), 'no-referrer');
  });

  await ok('the install token is redacted from the request log', async () => {
    const token = 'abcd' + '0123456789abcdef0123456789ab'; // 32 hex-ish chars; only a[b-d] hex matter
    const hex = 'abcdef0123456789abcdef0123456789';
    await fetch(`${BASE}/addon/${hex}/manifest.json`); // unknown token → 404 → logged
    const line = logs.find((l) => l.includes('[http]') && l.includes('/addon/abcd'));
    assert.ok(line, 'the 404 was logged');
    assert.ok(!line.includes(hex), 'full token must not be logged');
    assert.ok(line.includes('/addon/abcd…'), 'only the first 4 characters remain');
    void token;
  });

  console.log = origLog; console.warn = origWarn;
  console.log(`All hardening phase 2 checks passed (${n}).`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
