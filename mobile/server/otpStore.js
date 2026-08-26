// SQLite storage for the Mobile Companion's one-time codes and sessions.
//
// Two tables in the shared store.db (the same node:sqlite connection the watched
// + recommended stores use), created idempotently on first use — the pattern
// recommendationStore.init() follows.
//
// Both the OTP code and the session token are stored HASHED (sha256): a leaked
// DB backup cannot be used to sign in. The raw values live only in transit — the
// code in the email, the token in the cookie. This mirrors how the rest of the
// app treats secrets (sealed at rest; admin password compared, never stored raw).
const crypto = require('crypto');
const db = require('../../src/db');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS mobile_otp (
      id          TEXT PRIMARY KEY,     -- random uuid
      email       TEXT NOT NULL,        -- normalised (trim + lowercase)
      profile_id  TEXT NOT NULL,        -- resolved at issue time (strict 1:1)
      code_hash   TEXT NOT NULL,        -- sha256(code) — never the plaintext code
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,     -- created_at + 1 hour
      used_at     INTEGER,              -- set on verify / invalidation → single-use
      attempts    INTEGER DEFAULT 0     -- wrong-code guesses; locks after a cap
    );
    CREATE INDEX IF NOT EXISTS ix_otp_email ON mobile_otp (email);

    CREATE TABLE IF NOT EXISTS mobile_session (
      token_hash   TEXT PRIMARY KEY,    -- sha256(token) — raw token only in the cookie
      profile_id   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      last_seen_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_sess_profile ON mobile_session (profile_id);
  `);
  ready = true;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- OTP codes ----
function insertOtp({ email, profileId, code, createdAt, expiresAt }) {
  init();
  const id = crypto.randomUUID();
  db.get().prepare(`INSERT INTO mobile_otp
    (id, email, profile_id, code_hash, created_at, expires_at, used_at, attempts)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`)
    .run(id, email, profileId, sha256(code), createdAt, expiresAt);
  return id;
}

// Newest still-unused code for an email. Expiry is checked by the caller so it
// can inject `now` in tests; here we only exclude already-used rows.
function newestUnusedOtp(email) {
  init();
  return db.get().prepare(`SELECT * FROM mobile_otp
    WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(email) || null;
}

function markOtpUsed(id, at) {
  init();
  db.get().prepare('UPDATE mobile_otp SET used_at = ? WHERE id = ?').run(at, id);
}

function incOtpAttempts(id) {
  init();
  db.get().prepare('UPDATE mobile_otp SET attempts = attempts + 1 WHERE id = ?').run(id);
}

// Invalidate every outstanding (unused) code for an email — called before a new
// code is issued, so at most one live code exists per email at any time.
function purgeUnusedOtps(email, at) {
  init();
  db.get().prepare('UPDATE mobile_otp SET used_at = ? WHERE email = ? AND used_at IS NULL').run(at, email);
}

// ---- sessions ----
function insertSession({ token, profileId, createdAt, expiresAt }) {
  init();
  db.get().prepare(`INSERT INTO mobile_session
    (token_hash, profile_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)`).run(sha256(token), profileId, createdAt, expiresAt, createdAt);
}

function sessionByToken(token) {
  init();
  if (!token) return null;
  return db.get().prepare('SELECT * FROM mobile_session WHERE token_hash = ?').get(sha256(token)) || null;
}

function touchSession(token, at) {
  init();
  db.get().prepare('UPDATE mobile_session SET last_seen_at = ? WHERE token_hash = ?').run(at, sha256(token));
}

function deleteSession(token) {
  init();
  db.get().prepare('DELETE FROM mobile_session WHERE token_hash = ?').run(sha256(token));
}

function deleteSessionsForProfile(profileId) {
  init();
  db.get().prepare('DELETE FROM mobile_session WHERE profile_id = ?').run(profileId);
}

// Housekeeping: drop expired codes + sessions (called on the hourly tick).
function pruneExpired(nowMs = Date.now()) {
  init();
  const otp = db.get().prepare('DELETE FROM mobile_otp WHERE expires_at < ?').run(nowMs);
  const sess = db.get().prepare('DELETE FROM mobile_session WHERE expires_at < ?').run(nowMs);
  return { otp: Number(otp.changes || 0), sessions: Number(sess.changes || 0) };
}

module.exports = {
  init, sha256,
  insertOtp, newestUnusedOtp, markOtpUsed, incOtpAttempts, purgeUnusedOtps,
  insertSession, sessionByToken, touchSession, deleteSession, deleteSessionsForProfile,
  pruneExpired,
};
