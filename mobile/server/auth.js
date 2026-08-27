// Mobile Companion authentication: passwordless OTP + server-side sessions.
//
// ISOLATION GUARANTEE — the reason this module exists in this shape:
// verifyOtp binds a session to exactly ONE profile_id, and resolveSession is the
// ONLY way the router learns which profile a request belongs to. No handler ever
// trusts a client-supplied profile id, so one user can never see another's data.
//
// Strict 1:1 email <-> profile (decided): an email matching 0 or 2+ profiles
// issues nothing (2+ is a config error, logged). The HTTP layer answers the same
// generic 200 in every case, so it can't be probed for which emails are registered.
//
// Everything time-dependent takes an injected `nowMs`, and the mail send is
// injectable — so the tests run offline and deterministically (test/smoke.js doctrine).
const crypto = require('crypto');
const config = require('../../src/config');
const otpStore = require('./otpStore');
const mail = require('./mail');

const OTP_TTL_MIN = 60;                        // spec: valid 1 hour, single use
const OTP_TTL_MS = OTP_TTL_MIN * 60e3;
const MAX_ATTEMPTS = 5;                         // wrong-code guesses before a code dies
const MAX_REQUESTS = 5;                         // OTP requests per email per window
const RATE_WINDOW_MS = 15 * 60e3;
const SESSION_DAYS = Math.max(1, parseInt(process.env.MOBILE_SESSION_DAYS || '30', 10) || 30);
const SESSION_MS = SESSION_DAYS * 24 * 3600e3;

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// ---- rate limiter (in-memory sliding window, keyed by email) ----
const rate = new Map(); // email -> { count, resetAt }
function rateLimited(email, nowMs) {
  const e = rate.get(email);
  if (!e || nowMs > e.resetAt) { rate.set(email, { count: 1, resetAt: nowMs + RATE_WINDOW_MS }); return false; }
  if (e.count >= MAX_REQUESTS) return true;
  e.count += 1;
  return false;
}
function _resetRateLimits() { rate.clear(); } // test hook

// Find the single profile whose email matches (case/space-insensitive). Returns
// { profile } on a unique hit, else { profile:null, reason:'none'|'ambiguous' }.
function resolveProfileByEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return { profile: null, reason: 'none' };
  const matches = config.listProfiles().filter((p) => normalizeEmail(p.email) === norm);
  if (matches.length === 1) return { profile: matches[0] };
  return { profile: null, reason: matches.length === 0 ? 'none' : 'ambiguous' };
}

// Issue an OTP. Always resolves { ok:true } for the router (generic). The extra
// fields (issued/reason) are for logging + tests, never sent to the client.
async function requestOtp(email, { nowMs = Date.now(), sendMail = mail.sendOtpEmail, appUrl = '' } = {}) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: true, issued: false, reason: 'invalid' };
  if (rateLimited(norm, nowMs)) return { ok: true, issued: false, reason: 'rate-limited' };

  const { profile, reason } = resolveProfileByEmail(norm);
  if (!profile) {
    if (reason === 'ambiguous') {
      console.warn(`[mobile] email ${norm} maps to multiple profiles — refusing OTP (config error, expected strict 1:1)`);
    }
    return { ok: true, issued: false, reason };
  }

  // Debug: a matched request. Server-side log only — the HTTP response stays
  // generic (no account enumeration), so this never leaks to the client.
  console.log(`[mobile] OTP request made for ${profile.name} using email address ${String(email || '').trim()}`);

  otpStore.purgeUnusedOtps(norm, nowMs);        // one live code per email
  const code = generateCode();
  otpStore.insertOtp({ email: norm, profileId: profile.id, code, createdAt: nowMs, expiresAt: nowMs + OTP_TTL_MS });
  // Fire-and-forget the send: the code is already stored, so the HTTP response
  // never waits on SMTP latency (~2s measured against Brevo). This keeps login
  // snappy AND makes the response time roughly constant whether or not the email
  // matched a profile — closing the timing side-channel that an awaited send
  // would open (match = slow, miss = instant). A failed send is logged; the user
  // can request a resend.
  Promise.resolve(sendMail({ to: profile.email, code, ttlMinutes: OTP_TTL_MIN, appUrl }))
    .catch((err) => console.warn(`[mobile] BREVO: OTP email to ${profile.email} FAILED — ${err.message}`));
  return { ok: true, issued: true, reason: 'sent' };
}

// Verify a code. On success returns { ok:true, token, profile:{id,name} } — the
// router turns `token` into the mobile_sid cookie. On failure { ok:false, reason }.
function verifyOtp(email, code, { nowMs = Date.now() } = {}) {
  const norm = normalizeEmail(email);
  const row = otpStore.newestUnusedOtp(norm);
  if (!row) return { ok: false, reason: 'no-code' };
  if (nowMs > row.expires_at) { otpStore.markOtpUsed(row.id, nowMs); return { ok: false, reason: 'expired' }; }
  if (row.attempts >= MAX_ATTEMPTS) { otpStore.markOtpUsed(row.id, nowMs); return { ok: false, reason: 'locked' }; }
  if (otpStore.sha256(String(code)) !== row.code_hash) {
    otpStore.incOtpAttempts(row.id);
    return { ok: false, reason: 'bad-code' };
  }
  otpStore.markOtpUsed(row.id, nowMs);          // single use
  const profile = config.getProfile(row.profile_id);
  if (!profile) return { ok: false, reason: 'no-profile' };
  const token = crypto.randomBytes(32).toString('hex');
  otpStore.insertSession({ token, profileId: profile.id, createdAt: nowMs, expiresAt: nowMs + SESSION_MS });
  return { ok: true, token, profile: { id: profile.id, name: profile.name } };
}

// Resolve a raw session token to its bound profile, or null. Expired/orphaned
// sessions are rejected and cleaned. Touches last_seen_at on a live hit.
function resolveSession(token, { nowMs = Date.now() } = {}) {
  const row = otpStore.sessionByToken(token);
  if (!row) return null;
  if (nowMs > row.expires_at) { otpStore.deleteSession(token); return null; }
  const profile = config.getProfile(row.profile_id);
  if (!profile) { otpStore.deleteSession(token); return null; }
  otpStore.touchSession(token, nowMs);
  return profile;
}

function logout(token) { if (token) otpStore.deleteSession(token); }

module.exports = {
  requestOtp, verifyOtp, resolveSession, logout,
  resolveProfileByEmail, normalizeEmail, generateCode,
  OTP_TTL_MIN, MAX_ATTEMPTS, MAX_REQUESTS, RATE_WINDOW_MS, SESSION_DAYS,
  _resetRateLimits,
};
