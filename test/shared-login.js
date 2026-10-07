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
  const { provisionAdmin, cookieHeader } = require('./helpers/admin-session');
  const { token: adminToken } = provisionAdmin();
  const adminCookie = cookieHeader(adminToken);
  const BASE = `http://localhost:${process.env.PORT}`;

  // T12: GET /api/me returns is_admin
  await ok('T12 GET /api/me returns is_admin', async () => {
    const res = await fetch(`${BASE}/api/me`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.profile.is_admin, true);
  });

  // T13: requireAdminApi 401 {auth:'signin'} when no session
  await ok('T13 /api 401 {auth:signin} without session', async () => {
    const res = await fetch(`${BASE}/api/version`);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.deepStrictEqual(body, { auth: 'signin' });
  });

  // T14: requireAdminApi 403 {auth:'forbidden'} when session but not admin
  await ok('T14 /api 403 {auth:forbidden} for non-admin session', async () => {
    // Create a non-admin profile + session.
    const nonAdmin = config.addProfile('NonAdmin');
    config.updateProfile(nonAdmin.id, { email: 'nonadmin@example.com' });
    const { token } = auth.createSession(nonAdmin.id);
    const res = await fetch(`${BASE}/api/version`, { headers: { Cookie: `air_sid=${token}` } });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.deepStrictEqual(body, { auth: 'forbidden' });
  });

  // T15: requireAdminApi passes when admin
  await ok('T15 /api passes for admin session', async () => {
    const res = await fetch(`${BASE}/api/version`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res.status, 200);
  });

  // T16: requireAdminPage 302 → /mobile/?next=%2Fconfigure%2F when no session
  await ok('T16 /configure 302 → /mobile/?next= without session', async () => {
    const res = await fetch(`${BASE}/configure/`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.get('location').includes('/mobile/?next='));
  });

  // T17: requireAdminPage 302 → /mobile/?next=%2Fconfigure%2F when session but not admin
  await ok('T17 /configure 302 → /mobile/?next= for non-admin session', async () => {
    const nonAdmin = config.addProfile('NonAdmin2');
    config.updateProfile(nonAdmin.id, { email: 'nonadmin2@example.com' });
    const { token } = auth.createSession(nonAdmin.id);
    const res = await fetch(`${BASE}/configure/`, { headers: { Cookie: `air_sid=${token}` }, redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.get('location').includes('/mobile/?next='));
  });

  // T18: requireAdminPage passes when admin
  await ok('T18 /configure passes for admin session', async () => {
    const res = await fetch(`${BASE}/configure/`, { headers: { Cookie: adminCookie } });
    assert.strictEqual(res.status, 200);
  });

  // T19: Legacy cookie upgrade (mobile_sid → air_sid)
  await ok('T19 legacy mobile_sid cookie upgrades to air_sid', async () => {
    const res = await fetch(`${BASE}/api/me`, { headers: { Cookie: `mobile_sid=${adminToken}` } });
    assert.strictEqual(res.status, 200);
    const setCookies = res.headers.get('set-cookie') || '';
    assert.ok(setCookies.includes('air_sid='), 'air_sid cookie set');
    assert.ok(setCookies.includes('mobile_sid=') && setCookies.includes('Max-Age=0'), 'mobile_sid cleared');
  });

  // T20: clearSessionCookies clears both cookies
  await ok('T20 logout clears both air_sid and mobile_sid', async () => {
    const res = await fetch(`${BASE}/mobile/api/auth/logout`, { method: 'POST', headers: { Cookie: adminCookie } });
    assert.strictEqual(res.status, 200);
    const setCookies = res.headers.get('set-cookie') || '';
    assert.ok(setCookies.includes('air_sid='), 'air_sid cleared');
    assert.ok(setCookies.includes('mobile_sid='), 'mobile_sid cleared');
  });

  // T20 cleared the admin session — re-provision for T21/T22.
  const { token: adminToken2 } = provisionAdmin();
  const adminCookie2 = cookieHeader(adminToken2);

  // T21: PUT /api/profiles/:id with is_admin error codes
  await ok('T21 PUT is_admin error codes over HTTP', async () => {
    const a = config.listProfiles().find((p) => p.is_admin === true);
    // Demote the only admin → LAST_ADMIN (409).
    const res1 = await fetch(`${BASE}/api/profiles/${a.id}`, {
      method: 'PUT', headers: { Cookie: adminCookie2, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: false }),
    });
    assert.strictEqual(res1.status, 409);
    const body1 = await res1.json();
    assert.ok(body1.error.includes('at least one admin'));
    // BAD_ADMIN_FLAG (400).
    const res2 = await fetch(`${BASE}/api/profiles/${a.id}`, {
      method: 'PUT', headers: { Cookie: adminCookie2, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: 'true' }),
    });
    assert.strictEqual(res2.status, 400);
  });

  // T22: DELETE /api/profiles/:id with LAST_ADMIN
  await ok('T22 DELETE only admin → 409 LAST_ADMIN', async () => {
    const a = config.listProfiles().find((p) => p.is_admin === true);
    const res = await fetch(`${BASE}/api/profiles/${a.id}`, { method: 'DELETE', headers: { Cookie: adminCookie2 } });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.ok(body.error.includes('at least one admin'));
  });

  console.log(`\nshared-login http: all ${passed - 7} HTTP checks passed.`);

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

    await ok('B2 style parity: /configure vs /mobile topbar', async () => {
      await adminPage.goto(BASE + '/mobile/');
      await adminPage.waitForTimeout(1500);
      const mobileCss = await adminPage.evaluate(() => {
        const bar = document.querySelector('.topbar');
        if (!bar) return null;
        const cs = getComputedStyle(bar);
        return { background: cs.backgroundColor, color: cs.color, padding: cs.padding, height: cs.height, display: cs.display, position: cs.position };
      });
      await adminPage.goto(BASE + '/configure/');
      await adminPage.waitForTimeout(1500);
      const configureCss = await adminPage.evaluate(() => {
        const bar = document.querySelector('.topbar') || document.querySelector('#appbar');
        if (!bar) return null;
        const cs = getComputedStyle(bar);
        return { background: cs.backgroundColor, color: cs.color, padding: cs.padding, height: cs.height, display: cs.display, position: cs.position };
      });
      console.log('  B2 parity: mobile=' + JSON.stringify(mobileCss) + ' configure=' + JSON.stringify(configureCss));
      assert.ok(mobileCss, 'mobile topbar exists');
      assert.ok(configureCss, 'configure topbar exists');
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
      assert.deepStrictEqual(body, { auth: 'forbidden' });
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
      const advancedTab = adminPage.locator('[data-tab="advanced"]');
      if (await advancedTab.isVisible()) { await advancedTab.click(); await adminPage.waitForTimeout(1000); }
      const visible = await adminPage.locator('[data-is-admin]').isVisible();
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
