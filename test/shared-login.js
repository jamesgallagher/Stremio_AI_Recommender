// AUTH-1 shared sign-in + admin users — the card's test suite (§8.3).
//
// Same doctrine as mobile/test/mobile.smoke.js: NO real network (the mail
// transport is injected), deterministic time (nowMs injected), a temp DATA_DIR,
// and secrets sealed with a throwaway key. Run with:
//   node --experimental-sqlite test/shared-login.js
//
// Build order (§10): this file grows across steps. T1–T6 (config.js) land in
// step 1; T7 (auth.js sessions) in step 2; T12–T22 (HTTP surface) in step 4;
// T8 (ui.js viewForState) in step 6. Each step's tests are green when that step
// lands, and the suite is in `npm test` from step 1 so every step stays green.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-shared-login-' + Date.now();
process.env.PORT = '7314'; // distinct from smoke (7311), mobile (7312), integration (7313)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
process.env.MOBILE_INSECURE_COOKIE = '1'; // no HTTPS in tests
// Mail intentionally NOT configured — sendOtpEmail would log; tests inject fakes.
delete process.env.BREVO_API_KEY;
delete process.env.BREVO_SMTP_KEY;
delete process.env.BREVO_SMTP_LOGIN;
delete process.env.MOBILE_MAIL_FROM;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../src/config');
const store = require('../src/store');
const auth = require('../mobile/server/auth');

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

// ---- store helpers (unit tests manipulate profiles.json directly) ----
const PROFILES_FILE = path.join(process.env.DATA_DIR, 'profiles.json');
function profilesBytes() {
  try { return fs.readFileSync(PROFILES_FILE, 'utf8'); } catch { return null; }
}
function resetStore() { store.saveProfiles({ profiles: [] }); }
// Write a raw profile (created_at / email / is_admin controlled) without going
// through the config write boundary — simulates legacy data.
function writeRawProfiles(list) { store.saveProfiles({ profiles: list }); }
function makeLegacy(name, email, createdAt) {
  return {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomBytes(16).toString('hex'),
    email: email || '',
    is_admin: false,
    created_at: createdAt,
    keys: {}, // minimum so applyMigrations (p.keys.*) doesn't throw; migrations fill the rest
    filters: {},
  };
}

(async () => {
  console.log('shared-login unit:');

  // ---- T1: createInitialAdmin on an empty store ----
  await ok('T1 createInitialAdmin: empty store -> admin, trims/lower-cases email; second call SETUP_DONE; bad inputs write nothing', () => {
    resetStore();
    const p = config.createInitialAdmin({ name: '  First Admin ', email: '  First@Example.COM ' });
    assert.strictEqual(p.is_admin, true, 'is_admin true');
    assert.strictEqual(p.email, 'first@example.com', 'email trimmed + lower-cased');
    assert.strictEqual(p.name, 'First Admin', 'name trimmed');
    // Second call -> SETUP_DONE, profile count still 1.
    assert.throws(() => config.createInitialAdmin({ name: 'Second', email: 'second@example.com' }),
      (e) => e.code === 'SETUP_DONE');
    assert.strictEqual(config.listProfiles().length, 1, 'still one profile');
    // Bad name -> BAD_NAME, nothing written.
    assert.throws(() => config.createInitialAdmin({ name: '', email: 'x@y.com' }),
      (e) => e.code === 'BAD_NAME');
    // Bad email -> BAD_EMAIL, nothing written.
    assert.throws(() => config.createInitialAdmin({ name: 'X', email: 'not-an-email' }),
      (e) => e.code === 'BAD_EMAIL');
    assert.strictEqual(config.listProfiles().length, 1, 'bad inputs wrote nothing');
  });

  // ---- T2: promoteFirstAdminIfMissing ----
  await ok('T2 promoteFirstAdminIfMissing: promotes the oldest profile WITH an email; idempotent; no-email and no-profiles cases', () => {
    resetStore();
    const day = 24 * 3600e3;
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    // Oldest (no email), middle (email), newest (email).
    const oldest = makeLegacy('Oldest', '', t0);
    const middle = makeLegacy('Middle', 'middle@example.com', t0 + day);
    const newest = makeLegacy('Newest', 'newest@example.com', t0 + 2 * day);
    writeRawProfiles([oldest, middle, newest]);
    const r = config.promoteFirstAdminIfMissing();
    assert.strictEqual(r.reason, 'promoted');
    assert.strictEqual(r.promoted, 'Middle', 'the middle (oldest with email) is promoted');
    const byId = Object.fromEntries(config.listProfiles().map((p) => [p.id, p]));
    assert.strictEqual(byId[middle.id].is_admin, true);
    assert.strictEqual(byId[oldest.id].is_admin, false);
    assert.strictEqual(byId[newest.id].is_admin, false);
    // Second run -> has-admin, profiles.json bytes unchanged.
    const bytes = profilesBytes();
    const r2 = config.promoteFirstAdminIfMissing();
    assert.strictEqual(r2.reason, 'has-admin');
    assert.strictEqual(profilesBytes(), bytes, 'bytes unchanged on has-admin');
    // No-email case: profiles exist but none has an email.
    resetStore();
    writeRawProfiles([makeLegacy('NoEmail1', '', t0), makeLegacy('NoEmail2', '', t0 + day)]);
    const r3 = config.promoteFirstAdminIfMissing();
    assert.strictEqual(r3.reason, 'no-email');
    assert.strictEqual(r3.promoted, null);
    // Empty store -> no-profiles.
    resetStore();
    const r4 = config.promoteFirstAdminIfMissing();
    assert.strictEqual(r4.reason, 'no-profiles');
  });

  // ---- T3: LAST_ADMIN (demotion) ----
  await ok('T3 LAST_ADMIN: demoting the only admin throws (file unchanged); with 2 admins one demotes, then the remaining one throws', () => {
    resetStore();
    const a = config.createInitialAdmin({ name: 'AdminA', email: 'a@example.com' });
    const b = config.addProfile('AdminB');
    config.updateProfile(b.id, { email: 'b@example.com', is_admin: true });
    // Demote the only admin (A) while B is also admin -> allowed (2 admins).
    // But first: with only A as admin, demoting A throws.
    config.updateProfile(b.id, { is_admin: false }); // now only A is admin
    const bytes = profilesBytes();
    assert.throws(() => config.updateProfile(a.id, { is_admin: false }),
      (e) => e.code === 'LAST_ADMIN');
    assert.strictEqual(profilesBytes(), bytes, 'file unchanged after refused demotion');
    // With 2 admins, demoting one succeeds (self-demotion allowed).
    config.updateProfile(b.id, { is_admin: true }); // A + B both admin
    config.updateProfile(a.id, { is_admin: false }); // demote A -> OK (B remains)
    assert.strictEqual(config.getProfile(a.id).is_admin, false);
    // Now only B is admin; demoting B throws.
    assert.throws(() => config.updateProfile(b.id, { is_admin: false }),
      (e) => e.code === 'LAST_ADMIN');
  });

  // ---- T4: removeProfile of the only admin ----
  await ok('T4 removeProfile: the only admin cannot be deleted (file unchanged); with 2 admins it succeeds', () => {
    resetStore();
    const a = config.createInitialAdmin({ name: 'AdminA', email: 'a@example.com' });
    // Only admin: remove throws LAST_ADMIN, file unchanged.
    const bytes = profilesBytes();
    assert.throws(() => config.removeProfile(a.id), (e) => e.code === 'LAST_ADMIN');
    assert.strictEqual(profilesBytes(), bytes, 'file unchanged after refused delete');
    // With 2 admins, removing one succeeds.
    const b = config.addProfile('AdminB');
    config.updateProfile(b.id, { email: 'b@example.com', is_admin: true });
    config.removeProfile(a.id); // OK — B remains
    assert.strictEqual(config.getProfile(a.id), null);
    assert.strictEqual(config.getProfile(b.id).is_admin, true);
  });

  // ---- T5: ADMIN_NEEDS_EMAIL ----
  await ok('T5 ADMIN_NEEDS_EMAIL: setting is_admin on an emailless profile throws; clearing an admin\'s email throws; file unchanged', () => {
    resetStore();
    const a = config.createInitialAdmin({ name: 'AdminA', email: 'a@example.com' });
    const emailless = config.addProfile('NoEmail');
    // Setting is_admin:true on an emailless profile throws.
    let bytes = profilesBytes();
    assert.throws(() => config.updateProfile(emailless.id, { is_admin: true }),
      (e) => e.code === 'ADMIN_NEEDS_EMAIL');
    assert.strictEqual(profilesBytes(), bytes, 'file unchanged');
    // Clearing an admin's email throws.
    bytes = profilesBytes();
    assert.throws(() => config.updateProfile(a.id, { email: '' }),
      (e) => e.code === 'ADMIN_NEEDS_EMAIL');
    assert.strictEqual(profilesBytes(), bytes, 'file unchanged');
  });

  // ---- T6: BAD_ADMIN_FLAG ----
  await ok('T6 BAD_ADMIN_FLAG: non-boolean is_admin (string/number/null) throws', () => {
    resetStore();
    const a = config.createInitialAdmin({ name: 'AdminA', email: 'a@example.com' });
    for (const bad of ['true', 1, null]) {
      assert.throws(() => config.updateProfile(a.id, { is_admin: bad }),
        (e) => e.code === 'BAD_ADMIN_FLAG');
    }
  });

  // ---- T7: 30-day absolute session ----
  await ok('T7 30-day absolute session: createSession, resolve at t0+10d, touch doesn\'t change expiry, t0+30d-1ms works, t0+30d+1ms null', () => {
    resetStore();
    const a = config.createInitialAdmin({ name: 'AdminA', email: 'a@example.com' });
    const day = 24 * 3600e3;
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    const { token } = auth.createSession(a.id, { nowMs: t0 });
    // Resolve at t0+10d works
    const d1 = auth.resolveSessionDetail(token, { nowMs: t0 + 10 * day });
    assert.ok(d1, 'resolve at t0+10d works');
    assert.strictEqual(d1.profile.id, a.id);
    assert.strictEqual(d1.expiresAt, t0 + 30 * day, 'expiresAt is absolute 30d');
    // Touch (via resolve) doesn't change expiresAt
    const d2 = auth.resolveSessionDetail(token, { nowMs: t0 + 20 * day });
    assert.ok(d2, 'resolve at t0+20d works');
    assert.strictEqual(d2.expiresAt, t0 + 30 * day, 'expiresAt unchanged after touch');
    // Resolve at t0+30d-1ms works
    const d3 = auth.resolveSessionDetail(token, { nowMs: t0 + 30 * day - 1 });
    assert.ok(d3, 'resolve at t0+30d-1ms works');
    // Resolve at t0+30d+1ms → null
    const d4 = auth.resolveSessionDetail(token, { nowMs: t0 + 30 * day + 1 });
    assert.strictEqual(d4, null, 'resolve at t0+30d+1ms is null');
  });

  // ---- T8: ui.js viewForState with setupNeeded ----
  await ok('T8 viewForState: setupNeeded → setup; authed → route; login', () => {
    const ui = require('../mobile/public/ui');
    // setupNeeded → always 'setup'.
    assert.strictEqual(ui.viewForState({ setupNeeded: true, authed: false, route: 'recs' }), 'setup');
    assert.strictEqual(ui.viewForState({ setupNeeded: true, authed: true, route: 'recs' }), 'setup');
    // Not authed → 'login'.
    assert.strictEqual(ui.viewForState({ authed: false, route: 'recs' }), 'login');
    // Authed → the route.
    assert.strictEqual(ui.viewForState({ authed: true, route: 'search' }), 'search');
    // Authed + 'login' route → default.
    assert.strictEqual(ui.viewForState({ authed: true, route: 'login' }), 'recs');
    // Authed + 'setup' route → default (setup is only shown via setupNeeded).
    assert.strictEqual(ui.viewForState({ authed: true, route: 'setup' }), 'recs');
  });

  console.log(`\nshared-login unit: all ${passed} checks passed.`);

  // ---- HTTP surface (T12-T22) ----
  console.log('shared-login http:');
  require('../src/server');
  const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
  const BASE = `http://localhost:${process.env.PORT}`;

  // Reset the store so the setup-wizard tests (T12–T14) run against an empty store.
  resetStore();

  // Capturing mailer for the setup-wizard OTP (T13).
  function capturingSender() {
    const fn = async (args) => { fn.calls.push(args); return { sent: true, fake: true }; };
    fn.calls = [];
    fn.last = () => fn.calls[fn.calls.length - 1];
    return fn;
  }

  // ---- T12: setup over HTTP (store is empty) ----
  await ok('T12 setup: needed:true; bad email → 400; empty name → 400', async () => {
    const res1 = await fetch(`${BASE}/mobile/api/setup`);
    assert.strictEqual(res1.status, 200);
    assert.deepStrictEqual(await res1.json(), { needed: true });
    // Bad email → 400
    const res2 = await fetch(`${BASE}/mobile/api/setup/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', email: 'not-an-email' }),
    });
    assert.strictEqual(res2.status, 400);
    assert.ok((await res2.json()).error.includes('valid email'));
    // Empty name → 400
    const res3 = await fetch(`${BASE}/mobile/api/setup/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'test@example.com' }),
    });
    assert.strictEqual(res3.status, 400);
    assert.ok((await res3.json()).error.includes('name'));
  });

  // ---- T13: setup verify (in-process OTP + HTTP verify) ----
  await ok('T13 setup verify: wrong code → 401; right code → 200 + Set-Cookie; admin; needed:false', async () => {
    const mailer = capturingSender();
    const r = await auth.requestSetupOtp({ name: 'Setup Admin', email: 'setup@example.com' }, { sendMail: mailer });
    assert.ok(r.ok, 'requestSetupOtp ok');
    const code = mailer.last().code;
    // Wrong code → 401
    const res1 = await fetch(`${BASE}/mobile/api/setup/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'setup@example.com', code: '000000' }),
    });
    assert.strictEqual(res1.status, 401);
    // Right code → 200 + Set-Cookie
    const res2 = await fetch(`${BASE}/mobile/api/setup/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'setup@example.com', code }),
    });
    assert.strictEqual(res2.status, 200);
    const setCookie = res2.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('air_sid='), 'air_sid set');
    assert.ok(setCookie.includes('Path=/'), 'Path=/');
    assert.ok(setCookie.includes('HttpOnly'), 'HttpOnly');
    assert.ok(setCookie.includes('SameSite=Lax'), 'SameSite=Lax');
    const maxAgeMatch = setCookie.match(/Max-Age=(\d+)/);
    assert.ok(maxAgeMatch, 'Max-Age present');
    const maxAge = parseInt(maxAgeMatch[1], 10);
    assert.ok(maxAge > 2591995 && maxAge <= 2592000, 'Max-Age ≈ 2592000 (30 days)');
    // Created profile is admin
    const profiles = config.listProfiles();
    assert.strictEqual(profiles.length, 1);
    assert.strictEqual(profiles[0].is_admin, true);
    assert.strictEqual(profiles[0].name, 'Setup Admin');
    // needed:false
    const res3 = await fetch(`${BASE}/mobile/api/setup`);
    assert.deepStrictEqual(await res3.json(), { needed: false });
  });

  // ---- T14: setup request again → 409 ----
  await ok('T14 setup request again → 409', async () => {
    const res = await fetch(`${BASE}/mobile/api/setup/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', email: 'second@example.com' }),
    });
    assert.strictEqual(res.status, 409);
    assert.ok((await res.json()).error.includes('Setup is already complete'));
  });

  // Provision an admin session for the remaining tests.
  const { token: adminToken } = provisionAdmin();
  const adminCookie = cookieHeader(adminToken);

  // ---- T15: GET /configure/ (302 no cookie, 302 non-admin, 200 admin) ----
  await ok('T15 /configure: 302 no cookie; 302 non-admin; 200 admin (appbar + Cache-Control)', async () => {
    // No cookie → 302
    const res1 = await fetch(`${BASE}/configure/`, { redirect: 'manual' });
    assert.strictEqual(res1.status, 302);
    assert.ok(res1.headers.get('location').includes('/mobile/?next='));
    // Non-admin → 302
    const nonAdmin = config.addProfile('NonAdmin');
    config.updateProfile(nonAdmin.id, { email: 'nonadmin@example.com' });
    const { token: nonAdminToken } = auth.createSession(nonAdmin.id);
    const res2 = await fetch(`${BASE}/configure/`, { headers: { Cookie: `air_sid=${nonAdminToken}` }, redirect: 'manual' });
    assert.strictEqual(res2.status, 302);
    assert.ok(res2.headers.get('location').includes('/mobile/?next='));
    // Admin → 200 + appbar + Cache-Control
    const res3 = await fetch(`${BASE}/configure/`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res3.status, 200);
    assert.strictEqual(res3.headers.get('cache-control'), 'no-store');
    const html = await res3.text();
    assert.ok(html.includes('id="appbar"'), 'appbar present');
  });

  // ---- T16: GET /api/version (401, 403, 200, Basic → 401) ----
  await ok('T16 /api/version: 401 no cookie; 403 non-admin; 200 admin; Basic → 401', async () => {
    // No cookie → 401
    const res1 = await fetch(`${BASE}/api/version`);
    assert.strictEqual(res1.status, 401);
    assert.deepStrictEqual(await res1.json(), { error: 'Not signed in', auth: 'signin' });
    // Non-admin → 403
    const nonAdmin = config.listProfiles().find(p => !p.is_admin);
    const { token: nonAdminToken } = auth.createSession(nonAdmin.id);
    const res2 = await fetch(`${BASE}/api/version`, { headers: { Cookie: `air_sid=${nonAdminToken}` } });
    assert.strictEqual(res2.status, 403);
    assert.deepStrictEqual(await res2.json(), { error: 'Admins only', auth: 'forbidden' });
    // Admin → 200
    const res3 = await fetch(`${BASE}/api/version`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res3.status, 200);
    // Basic Auth header → 401 (Basic Auth is gone)
    process.env.ADMIN_USER = 'admin';
    process.env.ADMIN_PASSWORD = 'secret';
    const basic = Buffer.from('admin:secret').toString('base64');
    const res4 = await fetch(`${BASE}/api/version`, { headers: { Authorization: `Basic ${basic}` } });
    assert.strictEqual(res4.status, 401);
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASSWORD;
  });

  // ---- T17: Non-admin can't elevate ----
  await ok('T17 non-admin cannot elevate', async () => {
    const nonAdmin = config.listProfiles().find(p => !p.is_admin);
    const { token: nonAdminToken } = auth.createSession(nonAdmin.id);
    // PUT /api/profiles/<own> {is_admin:true} → 403, file unchanged
    const bytes = profilesBytes();
    const res1 = await fetch(`${BASE}/api/profiles/${nonAdmin.id}`, {
      method: 'PUT', headers: { Cookie: `air_sid=${nonAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: true }),
    });
    assert.strictEqual(res1.status, 403);
    assert.strictEqual(profilesBytes(), bytes, 'file unchanged');
    // POST /mobile/api/settings {is_admin:true, min_rating:6} → 200 but still not admin
    const res2 = await fetch(`${BASE}/mobile/api/settings`, {
      method: 'POST', headers: { Cookie: `air_sid=${nonAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: true, min_rating: 6 }),
    });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(config.getProfile(nonAdmin.id).is_admin, false, 'still not admin');
    // POST /mobile/api/settings {is_admin:true} alone → 400
    const res3 = await fetch(`${BASE}/mobile/api/settings`, {
      method: 'POST', headers: { Cookie: `air_sid=${nonAdminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: true }),
    });
    assert.strictEqual(res3.status, 400);
  });

  // ---- T18: Admin flows over HTTP ----
  await ok('T18 admin flows: demote self 409; promote B 200; demote self 200; same cookie → 403; DELETE → 409', async () => {
    const admin = config.listProfiles().find(p => p.is_admin === true);
    // Demote self while only admin → 409
    const res1 = await fetch(`${BASE}/api/profiles/${admin.id}`, {
      method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: false }),
    });
    assert.strictEqual(res1.status, 409);
    assert.ok((await res1.json()).error.includes('at least one admin'));
    // Promote B → 200
    const b = config.listProfiles().find(p => p.id !== admin.id);
    config.updateProfile(b.id, { email: 'b@example.com' });
    const res2 = await fetch(`${BASE}/api/profiles/${b.id}`, {
      method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: true }),
    });
    assert.strictEqual(res2.status, 200);
    // Demote self → 200
    const res3 = await fetch(`${BASE}/api/profiles/${admin.id}`, {
      method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: false }),
    });
    assert.strictEqual(res3.status, 200);
    // Same cookie on /api/version → 403 (fresh read)
    const res4 = await fetch(`${BASE}/api/version`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res4.status, 403);
    // DELETE of only remaining admin (B, using B's cookie) → 409
    const { token: bToken } = auth.createSession(b.id);
    const res5 = await fetch(`${BASE}/api/profiles/${b.id}`, { method: 'DELETE', headers: { Cookie: `air_sid=${bToken}` } });
    assert.strictEqual(res5.status, 409);
  });

  // ---- T19: Legacy cookie upgrade (mobile_sid → air_sid) ----
  await ok('T19 legacy mobile_sid → air_sid (GET /mobile/api/me, Max-Age window)', async () => {
    const otpStore = require('../mobile/server/otpStore');
    const admin = config.listProfiles().find(p => p.is_admin === true);
    // Create a session with expiresAt = now + 3d
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 3 * 86400e3;
    otpStore.insertSession({ token, profileId: admin.id, createdAt: Date.now(), expiresAt });
    // GET /mobile/api/me with mobile_sid → 200
    const res1 = await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: `mobile_sid=${token}` } });
    assert.strictEqual(res1.status, 200);
    const setCookie = res1.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('air_sid='), 'air_sid set');
    assert.ok(setCookie.includes('Path=/'), 'Path=/');
    const maxAgeMatch = setCookie.match(/Max-Age=(\d+)/);
    assert.ok(maxAgeMatch, 'Max-Age present');
    const maxAge = parseInt(maxAgeMatch[1], 10);
    assert.ok(maxAge <= 259200 && maxAge > 259100, `Max-Age ${maxAge} in (259100, 259200]`);
    // mobile_sid cleared
    assert.ok(setCookie.includes('mobile_sid=') && setCookie.includes('Max-Age=0'), 'mobile_sid cleared');
    // air_sid then works on /mobile/api/me
    const res2 = await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: `air_sid=${token}` } });
    assert.strictEqual(res2.status, 200);
  });

  // ---- T20: Logout ----
  await ok('T20 logout: clears both cookies; token revoked', async () => {
    const res = await fetch(`${BASE}/mobile/api/auth/logout`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.strictEqual(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('air_sid='), 'air_sid cleared');
    assert.ok(setCookie.includes('mobile_sid='), 'mobile_sid cleared');
    // Token revoked: same cookie → 401
    const res2 = await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res2.status, 401);
  });

  // ---- T21: /mobile/api/me is_admin; /api/me ----
  await ok('T21 /mobile/api/me is_admin; /api/me → {profile:{id,name,is_admin:true}}', async () => {
    // Re-provision after T20 revoked the session
    const { token: newToken } = provisionAdmin();
    const newCookie = cookieHeader(newToken);
    // /mobile/api/me includes is_admin
    const res1 = await fetch(`${BASE}/mobile/api/me`, { headers: { Cookie: newCookie } });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual((await res1.json()).profile.is_admin, true);
    // /api/me → {profile:{id,name,is_admin:true}}
    const res2 = await fetch(`${BASE}/api/me`, { headers: { Cookie: newCookie } });
    assert.strictEqual(res2.status, 200);
    const body = await res2.json();
    assert.strictEqual(body.profile.is_admin, true);
    assert.ok(body.profile.id);
    assert.ok(body.profile.name);
  });

  // ---- T22: scripts/set-admin.js via execFileSync ----
  await ok('T22 set-admin.js: --email promotes; unknown email → exit 1; --profile + --email', () => {
    const { execFileSync } = require('child_process');
    const script = path.join(__dirname, '..', 'scripts', 'set-admin.js');
    // Find a non-admin profile with an email
    const nonAdmin = config.listProfiles().find(p => !p.is_admin && p.email);
    // --email → exit 0, prints "Admin set:"
    const out = execFileSync('node', ['--experimental-sqlite', script, '--email', nonAdmin.email], { encoding: 'utf8' });
    assert.ok(out.includes('Admin set:'), 'prints Admin set:');
    assert.strictEqual(config.getProfile(nonAdmin.id).is_admin, true, 'now admin');
    // Unknown email → exit 1
    assert.throws(() => {
      execFileSync('node', ['--experimental-sqlite', script, '--email', 'unknown@nowhere.xyz'], { encoding: 'utf8' });
    }, (e) => e.status === 1);
    // --profile "Name" --email new@x.y → sets both
    const p = config.addProfile('SetAdminTarget');
    const out2 = execFileSync('node', ['--experimental-sqlite', script, '--profile', 'SetAdminTarget', '--email', 'new@x.y'], { encoding: 'utf8' });
    assert.ok(out2.includes('Admin set:'), 'prints Admin set:');
    const updated = config.getProfile(p.id);
    assert.strictEqual(updated.is_admin, true, 'admin');
    assert.strictEqual(updated.email, 'new@x.y', 'email set');
  });

  console.log(`\nshared-login http: all ${passed - 8} HTTP checks passed.`);

  // ---- T23: nextAfterSignIn pure helper (card §6.4) ----
  await ok('T23 nextAfterSignIn: /configure/ admin → redirect; non-admin → deny; other values → null', () => {
    const ui = require('../mobile/public/ui');
    // Admin with next=/configure/ → redirect.
    assert.strictEqual(ui.nextAfterSignIn('/configure/', { is_admin: true }), '/configure/');
    // Non-admin with next=/configure/ → deny.
    assert.strictEqual(ui.nextAfterSignIn('/configure/', { is_admin: false }), 'deny');
    // Non-admin with no is_admin field → deny.
    assert.strictEqual(ui.nextAfterSignIn('/configure/', {}), 'deny');
    // External URL → null.
    assert.strictEqual(ui.nextAfterSignIn('https://evil.example/phish', { is_admin: true }), null);
    // Protocol-relative → null.
    assert.strictEqual(ui.nextAfterSignIn('//evil.example', { is_admin: true }), null);
    // /configure without trailing slash → null.
    assert.strictEqual(ui.nextAfterSignIn('/configure', { is_admin: true }), null);
    // /configure/x → null.
    assert.strictEqual(ui.nextAfterSignIn('/configure/x', { is_admin: true }), null);
    // javascript: → null.
    assert.strictEqual(ui.nextAfterSignIn('javascript:alert(1)', { is_admin: true }), null);
    // null profile → null (not authed).
    assert.strictEqual(ui.nextAfterSignIn('/configure/', null), 'deny');
  });

  console.log(`\nshared-login unit+http: all ${passed} checks passed.`);

// ---- Browser checks (B1-B13) - only when --browser is passed ----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const SHOT_DIR = path.join(process.env.DATA_DIR, 'browser-shots');
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Re-provision admin session (T20 revoked it).
    const { token: adminToken2 } = provisionAdmin();

    const nonAdmin = config.addProfile('NonAdmin');
    config.updateProfile(nonAdmin.id, { email: 'nonadmin@test.local' });
    const { token: nonAdminToken } = auth.createSession(nonAdmin.id);

    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await adminCtx.addCookies([{ name: 'air_sid', value: adminToken2, url: BASE }]);
    const adminPage = await adminCtx.newPage();
    const adminErrors = [];
    adminPage.on('pageerror', e => adminErrors.push(e.message));

    const nonAdminCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await nonAdminCtx.addCookies([{ name: 'air_sid', value: nonAdminToken, url: BASE }]);
    const nonAdminPage = await nonAdminCtx.newPage();
    const nonAdminErrors = [];
    nonAdminPage.on('pageerror', e => nonAdminErrors.push(e.message));

    const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await phoneCtx.addCookies([{ name: 'air_sid', value: adminToken2, url: BASE }]);
    const phonePage = await phoneCtx.newPage();

    console.log('shared-login browser:');

    await ok('B1 /mobile/ shows login view', async () => {
      const freshCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const freshPage = await freshCtx.newPage();
      await freshPage.goto(BASE + '/mobile/');
      await freshPage.waitForTimeout(1000);
      const emailVisible = await freshPage.locator('#email').isVisible();
      const sendVisible = await freshPage.locator('#send-code').isVisible();
      assert.ok(emailVisible, 'email field visible');
      assert.ok(sendVisible, 'Send code button visible');
      await freshPage.screenshot({ path: path.join(SHOT_DIR, 'B1-mobile-login.png') });
    });

    await ok('B2 style parity: /configure vs /mobile topbar (dark mode)', async () => {
      const darkCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await darkCtx.addCookies([{ name: 'air_sid', value: adminToken2, url: BASE }]);
      const darkPage = await darkCtx.newPage();

      // Collect computed styles from /mobile/#/recs
      await darkPage.goto(BASE + '/mobile/#/recs');
      await darkPage.waitForTimeout(2000);
      const mobileStyles = await darkPage.evaluate(() => {
        function cs(sel) { const el = document.querySelector(sel); if (!el) return null; const c = getComputedStyle(el); return c; }
        const bar = cs('.topbar');
        const brand = cs('.topbar .brand');
        const profile = cs('.topbar .profile');
        const cog = cs('#open-settings');
        const logout = cs('#logout');
        return {
          topbar: { height: bar.height, backgroundColor: bar.backgroundColor, borderBottomColor: bar.borderBottomColor, borderBottomWidth: bar.borderBottomWidth, paddingLeft: bar.paddingLeft },
          brand: { fontWeight: brand.fontWeight, fontSize: brand.fontSize },
          profile: { fontSize: profile.fontSize, color: profile.color },
          cog: { fontSize: cog.fontSize, minHeight: cog.minHeight, minWidth: cog.minWidth, borderRadius: cog.borderRadius, fontWeight: cog.fontWeight },
          logout: { fontSize: logout.fontSize, minHeight: logout.minHeight, paddingLeft: logout.paddingLeft, borderRadius: logout.borderRadius, color: logout.color, fontWeight: logout.fontWeight },
        };
      });

      // Collect computed styles from /configure/
      await darkPage.goto(BASE + '/configure/');
      await darkPage.waitForTimeout(2000);
      const configureStyles = await darkPage.evaluate(() => {
        function cs(sel) { const el = document.querySelector(sel); if (!el) return null; const c = getComputedStyle(el); return c; }
        const bar = cs('.topbar');
        const brand = cs('.topbar .brand');
        const profile = cs('.topbar .profile');
        const cog = cs('#open-settings');
        const logout = cs('#logout');
        return {
          topbar: { height: bar.height, backgroundColor: bar.backgroundColor, borderBottomColor: bar.borderBottomColor, borderBottomWidth: bar.borderBottomWidth, paddingLeft: bar.paddingLeft },
          brand: { fontWeight: brand.fontWeight, fontSize: brand.fontSize },
          profile: { fontSize: profile.fontSize, color: profile.color },
          cog: { fontSize: cog.fontSize, minHeight: cog.minHeight, minWidth: cog.minWidth, borderRadius: cog.borderRadius, fontWeight: cog.fontWeight },
          logout: { fontSize: logout.fontSize, minHeight: logout.minHeight, paddingLeft: logout.paddingLeft, borderRadius: logout.borderRadius, color: logout.color, fontWeight: logout.fontWeight },
        };
      });

      // Assert every pair is equal
      const groups = ['topbar', 'brand', 'profile', 'cog', 'logout'];
      for (const g of groups) {
        for (const prop of Object.keys(mobileStyles[g])) {
          console.log(`  B2 parity ${g}.${prop}: mobile=${mobileStyles[g][prop]} configure=${configureStyles[g][prop]}`);
          assert.strictEqual(configureStyles[g][prop], mobileStyles[g][prop], `parity ${g}.${prop}`);
        }
      }
      await darkCtx.close();
    });

    await ok('B3 setup wizard: login view when profiles exist', async () => {
      const freshCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
      const freshPage = await freshCtx.newPage();
      await freshPage.goto(BASE + '/mobile/');
      await freshPage.waitForTimeout(1000);
      const loginVisible = await freshPage.locator('#view-login').isVisible();
      assert.ok(loginVisible, 'login view visible when profiles exist');
      await freshPage.screenshot({ path: path.join(SHOT_DIR, 'B3-mobile-375.png') });
    });

    await ok('B4 Configure button visible for admin', async () => {
      await adminPage.goto(BASE + '/mobile/');
      await adminPage.waitForTimeout(1500);
      const visible = await adminPage.locator('#open-configure').isVisible();
      assert.ok(visible, 'Configure button visible for admin');
    });

    await ok('B5 Configure button hidden for non-admin', async () => {
      await nonAdminPage.goto(BASE + '/mobile/');
      await nonAdminPage.waitForTimeout(1500);
      const visible = await nonAdminPage.locator('#open-configure').isVisible();
      assert.ok(!visible, 'Configure button hidden for non-admin');
    });

    await ok('B6 /configure/ loads for admin', async () => {
      await adminPage.goto(BASE + '/configure/');
      await adminPage.waitForTimeout(1500);
      assert.ok(adminPage.url().includes('/configure/'), 'stayed on /configure/');
      await adminPage.screenshot({ path: path.join(SHOT_DIR, 'B6-configure-admin.png') });
    });

    await ok('B7 /configure/ redirects non-admin to /mobile/', async () => {
      await nonAdminPage.goto(BASE + '/configure/');
      await nonAdminPage.waitForTimeout(2000);
      assert.ok(nonAdminPage.url().includes('/mobile/'), 'redirected to /mobile/');
    });

    await ok('B8 /api/* returns 403 for non-admin', async () => {
      const res = await fetch(BASE + '/api/version', { headers: { Cookie: 'air_sid=' + nonAdminToken } });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Admins only', auth: 'forbidden' });
    });

    await ok('B9 legacy mobile_sid upgrades to air_sid', async () => {
      const legacyCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const legacyPage = await legacyCtx.newPage();
      await legacyCtx.addCookies([{ name: 'mobile_sid', value: adminToken2, url: BASE + '/mobile/' }]);
      await legacyPage.goto(BASE + '/mobile/api/me');
      await legacyPage.waitForTimeout(1000);
      const cookies = await legacyCtx.cookies(BASE);
      const airCookie = cookies.find(c => c.name === 'air_sid');
      assert.ok(airCookie, 'air_sid cookie set after upgrade');
    });

    await ok('B10 Admin checkbox in /configure Advanced', async () => {
      await adminPage.goto(BASE + '/configure/');
      await adminPage.waitForTimeout(1500);
      const advancedTab = adminPage.locator('.tab-btn[data-tab="advanced"]');
      if (await advancedTab.isVisible()) { await advancedTab.click(); await adminPage.waitForTimeout(1000); }
      const visible = await adminPage.locator('[data-admin]').isVisible();
      assert.ok(visible, 'Admin checkbox visible');
    });

    await ok('B11 Logout button in /mobile topbar', async () => {
      await adminPage.goto(BASE + '/mobile/');
      await adminPage.waitForTimeout(1500);
      const visible = await adminPage.locator('#logout').isVisible();
      assert.ok(visible, 'Logout button visible');
      await phonePage.goto(BASE + '/mobile/');
      await phonePage.waitForTimeout(1500);
      await phonePage.screenshot({ path: path.join(SHOT_DIR, 'B11-mobile-375-admin.png') });
    });

    await ok('B12 non-admin /configure/ makes <=3 navs, ends on /mobile/', async () => {
      let navs = 0;
      nonAdminPage.on('framenavigated', f => { if (f === nonAdminPage.mainFrame()) navs++; });
      await nonAdminPage.goto(BASE + '/configure/');
      await nonAdminPage.waitForTimeout(4000);
      const url = nonAdminPage.url();
      console.log('  B12: ' + navs + ' navigations, final URL: ' + url);
      assert.ok(navs <= 3, 'only ' + navs + ' navigations');
      assert.ok(url.includes('/mobile/'), 'ended on /mobile/');
      assert.ok(!url.includes('next='), 'URL has no next param');
      await nonAdminPage.screenshot({ path: path.join(SHOT_DIR, 'B12-nonadmin-configure.png') });
    });

    await ok('B13 logout on /configure/ revokes session', async () => {
      await adminPage.goto(BASE + '/configure/');
      await adminPage.waitForTimeout(1500);
      const res = await fetch(BASE + '/mobile/api/auth/logout', { method: 'POST', headers: { Cookie: 'air_sid=' + adminToken2 } });
      assert.strictEqual(res.status, 200);
      const resolved = auth.resolveSession(adminToken2);
      assert.strictEqual(resolved, null, 'session revoked server-side');
      await adminPage.goto(BASE + '/mobile/');
      await adminPage.waitForTimeout(1500);
      const loginVisible = await adminPage.locator('#view-login').isVisible();
      assert.ok(loginVisible, 'login view visible after logout');
      await adminPage.screenshot({ path: path.join(SHOT_DIR, 'B13-logout-configure.png') });
    });

    assert.deepStrictEqual(adminErrors, [], 'no JS errors in admin context');
    assert.deepStrictEqual(nonAdminErrors, [], 'no JS errors in non-admin context');

    await browser.close();
    console.log('shared-login browser: all B1-B13 checks passed. Screenshots in ' + SHOT_DIR);
  }

  process.exit(0);
})().catch((err) => {
  console.error('\n✗ SHARED-LOGIN FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
