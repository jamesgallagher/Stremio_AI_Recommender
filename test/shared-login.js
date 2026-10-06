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

  console.log(`\nshared-login unit: all ${passed} checks passed.`);
})().catch((err) => {
  console.error('\n✗ SHARED-LOGIN FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
