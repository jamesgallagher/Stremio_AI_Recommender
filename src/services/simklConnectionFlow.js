// Shared connection-attempt state (SIMKL-AUTH-1 final fixes §1).
//
// Each Connect (V1 PIN or V2 OAuth) creates a flow_id that identifies the
// specific attempt. The browser polls /simkl/status?flow_id=<id> and stops
// only when THAT attempt reaches a terminal state (completed/failed) — never
// from the top-level connected/token_stored value, which can belong to the
// old connection.
//
// Attempts are stored in a Map keyed by flow_id. Each entry carries:
//   - profileId, version (target), expiry (ms),
//   - a snapshot/digest of the starting active grant and client credentials,
//   - state: pending | verifying | completed | failed,
//   - result: null | 'connected' | 'token_stored' (only when completed),
//   - message: safe user-facing text.
//
// Terminal results are retained for the polling window (V2: 10 min, V1:
// provider expiry) then pruned. Passive status must not call Simkl.

const crypto = require('crypto');

const V2_POLL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (flow TTL)
const V1_POLL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes (PIN expiry)

const attempts = new Map(); // flow_id → attempt record

// Compute a non-disclosed digest of the starting grant + credentials.
// This is a fingerprint of the specific grant/credential binding at the
// start of the attempt. It is NOT the raw token or secret.
function grantDigest(profile) {
  const auth = profile.simkl_auth || {};
  const keys = profile.keys || {};
  const version = auth.version || 1;
  const clientId = version === 2 ? (keys.simkl_v2_client_id || '') : (keys.simkl_client_id || '');
  const token = auth.access_token || '';
  const account = auth.account_id || '';
  const raw = `${profile.id}:${version}:${clientId}:${token}:${account}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// Start a new connection attempt. Supersedes any previous attempt for the
// profile. Returns the flow_id.
function startAttempt(profile) {
  const flowId = crypto.randomUUID();
  const version = profile.simkl_auth_version || 2;
  const expiry = Date.now() + (version === 2 ? V2_POLL_WINDOW_MS : V1_POLL_WINDOW_MS);
  const digest = grantDigest(profile);
  // Supersede any previous pending/verifying attempt for this profile.
  for (const [id, rec] of attempts) {
    if (rec.profileId === profile.id && (rec.state === 'pending' || rec.state === 'verifying')) {
      rec.state = 'failed';
      rec.result = null;
      rec.message = 'Superseded by a new connection attempt';
    }
  }
  attempts.set(flowId, {
    flowId,
    profileId: profile.id,
    version,
    expiry,
    digest,
    state: 'pending',
    result: null,
    message: 'Waiting for authorization',
  });
  return flowId;
}

// Get the attempt record for a given flow_id. Returns null if unknown.
function getAttempt(flowId) {
  return attempts.get(flowId) || null;
}

// Find the active (pending or verifying) attempt for a profile.
// At most one active attempt exists per profile (startAttempt supersedes).
function getActiveAttemptForProfile(profileId) {
  for (const [id, rec] of attempts) {
    if (rec.profileId === profileId && (rec.state === 'pending' || rec.state === 'verifying')) {
      return rec;
    }
  }
  return null;
}

// Get the attempt record for a profile + flow_id (must match the profile).
// Unknown or other-profile IDs return a generic failed attempt.
function getAttemptForProfile(profileId, flowId) {
  const rec = attempts.get(flowId);
  if (!rec || rec.profileId !== profileId) {
    return { flowId, state: 'failed', result: null, message: 'Unknown or expired connection attempt' };
  }
  if (Date.now() > rec.expiry && rec.state !== 'completed') {
    rec.state = 'failed';
    rec.result = null;
    rec.message = 'Connection attempt expired';
  }
  return rec;
}

// Mark the attempt as verifying (new token received, verification underway).
function markVerifying(flowId) {
  const rec = attempts.get(flowId);
  if (rec && rec.state === 'pending') {
    rec.state = 'verifying';
    rec.message = 'Verifying connection';
  }
}

// Complete the attempt with a terminal state.
// result: 'connected' | 'token_stored' (only when completed).
function completeAttempt(flowId, state, result, message) {
  const rec = attempts.get(flowId);
  if (rec) {
    rec.state = state;
    rec.result = result || null;
    rec.message = message;
  }
}

// Invalidate all pending/verifying attempts for a profile (Disconnect).
function invalidateAttempts(profileId) {
  for (const [id, rec] of attempts) {
    if (rec.profileId === profileId && (rec.state === 'pending' || rec.state === 'verifying')) {
      rec.state = 'failed';
      rec.result = null;
      rec.message = 'Connection changed — start again';
    }
  }
}

// Invalidate a specific attempt (credential edit, grant replacement).
function invalidateAttempt(flowId) {
  const rec = attempts.get(flowId);
  if (rec && (rec.state === 'pending' || rec.state === 'verifying')) {
    rec.state = 'failed';
    rec.result = null;
    rec.message = 'Connection changed — start again';
  }
}

// Prune expired terminal attempts.
function pruneExpired() {
  const now = Date.now();
  for (const [id, rec] of attempts) {
    if (now > rec.expiry && (rec.state === 'completed' || rec.state === 'failed')) {
      attempts.delete(id);
    }
  }
}

// Bounded identity verification (§3).
// Limit the whole identity operation (fetch + JSON parse) to 10,000 ms.
// Abort at the deadline and settle the helper even if fetch does not settle.
//
// Valid identity requires a successful /users/settings response with a
// nonempty string or finite numeric ID from user.id or user.user_id.
// Normalize valid IDs to strings before comparison.
// A display name alone is insufficient.
const IDENTITY_TIMEOUT_MS = 10000;

async function verifyIdentity(clientId, accessToken) {
  const simkl = require('./simkl');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const res = await simkl.boundedFetch(
      simkl.withParams(clientId, '/users/settings'),
      { headers: simkl.headers(accessToken), signal: controller.signal }
    );
    if (!res.ok) return { ok: false, reason: 'failed_http', id: null, name: null };
    const data = await res.json();
    const rawId = data?.user?.id ?? data?.user?.user_id;
    const name = data?.user?.name || null;
    // Normalize: nonempty string or finite numeric → string.
    if (typeof rawId === 'string' && rawId.trim() !== '') {
      return { ok: true, id: rawId.trim(), name };
    }
    if (typeof rawId === 'number' && Number.isFinite(rawId)) {
      return { ok: true, id: String(rawId), name };
    }
    return { ok: false, reason: 'invalid_id', id: null, name: null };
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('timeout')) {
      return { ok: false, reason: 'timeout', id: null, name: null };
    }
    return { ok: false, reason: 'network_error', id: null, name: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  startAttempt,
  getAttempt,
  getAttemptForProfile,
  getActiveAttemptForProfile,
  markVerifying,
  completeAttempt,
  invalidateAttempts,
  invalidateAttempt,
  pruneExpired,
  verifyIdentity,
  grantDigest,
};
