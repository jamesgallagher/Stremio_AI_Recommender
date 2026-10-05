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

// Compute a non-disclosed digest of the starting grant + target credentials.
// This is a fingerprint of the specific grant/credential binding at the
// start of the attempt. It is NOT the raw token or secret.
//
// The grant snapshot includes: bound client ID, version, access token,
// refresh token, and account identity.
// The credential snapshot includes: the target version's client ID and
// secret (even when the active grant is another version, e.g. V1→V2
// migration). Hashing structured data server-side; the digest is never
// exposed to the browser.
function grantDigest(profile) {
  const auth = profile.simkl_auth || {};
  const keys = profile.keys || {};
  const targetVersion = profile.simkl_auth_version || 2;
  // Grant snapshot: the active grant's binding.
  const grantVersion = auth.version || 1;
  const grantClientId = grantVersion === 2 ? (keys.simkl_v2_client_id || '') : (keys.simkl_client_id || '');
  const grantToken = auth.access_token || '';
  const grantRefresh = auth.refresh_token || '';
  const grantAccount = auth.account_id || '';
  // Credential snapshot: the target version's client ID and secret.
  const credClientId = targetVersion === 2 ? (keys.simkl_v2_client_id || '') : (keys.simkl_client_id || '');
  const credSecret = targetVersion === 2 ? (keys.simkl_v2_client_secret || '') : (keys.simkl_client_secret || '');
  const raw = `${profile.id}|${grantVersion}|${grantClientId}|${grantToken}|${grantRefresh}|${grantAccount}|${targetVersion}|${credClientId}|${credSecret}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// Start a new connection attempt. Supersedes any previous attempt for the
// profile. Returns the flow_id.
// expiryOverride: optional absolute timestamp (ms) for V1 provider expiry.
function startAttempt(profile, expiryOverride) {
  const flowId = crypto.randomUUID();
  const version = profile.simkl_auth_version || 2;
  const expiry = expiryOverride || Date.now() + (version === 2 ? V2_POLL_WINDOW_MS : V1_POLL_WINDOW_MS);
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

// Prune expired attempts: terminal records past their polling window, and
// abandoned pending/verifying attempts (expired without reaching a terminal
// state). An expired completed ID must not keep reporting completion.
// Keep storage bounded, including repeated Connect requests.
function pruneExpired() {
  const now = Date.now();
  for (const [id, rec] of attempts) {
    if (now > rec.expiry) {
      // Expire abandoned pending/verifying attempts.
      if (rec.state === 'pending' || rec.state === 'verifying') {
        rec.state = 'failed';
        rec.result = null;
        rec.message = 'Connection attempt expired';
      }
      // Remove expired terminal records.
      attempts.delete(id);
    }
  }
}

// Bounded identity verification (§3).
// Race the entire fetch-and-parse operation against a 10,000-ms deadline.
// On deadline, abort and return the timeout failure regardless of whether
// fetch/parsing settles. Uses the helper's own signal for its request; does
// NOT send it through boundedFetch (which replaces the supplied signal and
// does not bound parsing).
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
    // The entire fetch + JSON parse operation.
    const operation = (async () => {
      const res = await fetch(simkl.withParams(clientId, '/users/settings'), {
        headers: simkl.headers(accessToken),
        signal: controller.signal,
      });
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
    })();
    // Prevent unhandled rejection if the operation rejects after the timeout
    // wins the race (e.g. late abort rejection).
    operation.catch(() => {});
    // The deadline promise: resolves with a timeout failure at 10,000 ms.
    const deadline = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, reason: 'timeout', id: null, name: null }), IDENTITY_TIMEOUT_MS);
    });
    return await Promise.race([operation, deadline]);
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
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
