// Simkl V2 OAuth (authorization code + PKCE S256) — server-side only.
//
// The browser never sees the Client Secret, code_verifier, authorization code,
// or any token (mandate M4). The AIR backend receives the callback, holds the
// secret and tokens, and makes Simkl API calls.
//
// Flow:
//   1. POST /simkl/connect (V2 selected) → generates PKCE pair + state,
//      returns the authorize URL for the browser to open.
//   2. Browser redirects to Simkl's consent page.
//   3. Simkl redirects back to GET /simkl/oauth2/callback?code=...&state=...
//      (or ?error=access_denied&state=... on cancellation).
//   4. The callback handler validates state, exchanges the code for tokens
//      (POST /oauth2/token), validates the returned grant, and stores them
//      in the profile. A failed/cancelled/replayed callback preserves any
//      existing active grant.
//
// PKCE (RFC 7636):
//   code_verifier: 43-128 random chars (unpadded base64url)
//   code_challenge: BASE64URL(SHA256(code_verifier)) — S256 method
//
// Scope: media:read media:write (per Simkl's authorization-code reference).
// The returned granted scope must include both; a read-only grant is rejected.

const crypto = require('crypto');
const config = require('../config');

const SIMKL_AUTHORIZE = 'https://simkl.com/oauth2/authorize';
const SIMKL_TOKEN = 'https://api.simkl.com/oauth2/token';
const SIMKL_REVOKE = 'https://api.simkl.com/oauth2/revoke';
const SCOPE = 'media:read media:write';
const EXPECTED_ISS = 'https://simkl.com';
const FLOW_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_PENDING_FLOWS = 50; // cap to prevent unbounded memory growth

// In-memory flow state: profileId → flow record.
// The state is a random opaque string; the code_verifier is never sent to the
// browser (M4). The redirect_uri must match what was registered on the Simkl
// app AND what we send to the token endpoint. The initiating Client ID is
// recorded so a credential change during the flow is detected.
const flows = new Map();

// Generate a cryptographically random string of the given byte length,
// base64url-encoded (no padding).
function randomBase64Url(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// PKCE S256: code_verifier is 32 random bytes → 43 base64url chars;
// code_challenge = BASE64URL(SHA256(code_verifier)).
function generatePkce() {
  const codeVerifier = randomBase64Url(32); // 43 chars
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// Build the authorize URL the browser opens. The state is a random opaque
// string (CSRF protection); the code_challenge is S256.
function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  const u = new URL(SIMKL_AUTHORIZE);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// Start a V2 authorization flow for a profile. Returns the authorize URL and
// stores the flow state in memory. The code_verifier stays server-side (M4).
// The initiating Client ID is recorded so a credential change during the flow
// is detected at callback time.
function startFlow(profile, redirectUri) {
  const clientId = profile.keys.simkl_v2_client_id;
  if (!clientId) throw new Error('V2 Client ID required');
  // Enforce the pending-flow cap (prevent unbounded memory growth).
  if (flows.size >= MAX_PENDING_FLOWS) {
    // Expire the oldest flow to make room.
    let oldestId = null, oldestExp = Infinity;
    for (const [id, f] of flows) {
      if (f.expires_at < oldestExp) { oldestExp = f.expires_at; oldestId = id; }
    }
    if (oldestId) flows.delete(oldestId);
  }
  // Expire any existing flow for this profile (one flow per profile).
  if (flows.has(profile.id)) flows.delete(profile.id);
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomBase64Url(16); // 22 chars
  const flow = {
    state,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    expires_at: Date.now() + FLOW_TTL_MS,
    // Record the initiating credentials so a change during the flow is detected.
    client_id: clientId,
    client_secret: profile.keys.simkl_v2_client_secret,
    profile_id: profile.id,
  };
  flows.set(profile.id, flow);
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge });
  return { authorizeUrl, state };
}

// Consume a pending flow for a profile (used by the cancellation path in
// server.js). The flow is removed so a replayed callback with the same state
// fails safely.
function consumeFlow(profileId) {
  flows.delete(profileId);
}

// Validate the granted scope: must contain exactly the required scope members.
// A read-only grant (e.g. scope="media:read") is insufficient for this app.
function validateScope(grantedScope) {
  if (typeof grantedScope !== 'string' || !grantedScope) {
    const err = new Error('Simkl did not return a scope');
    err.state = 'malformed_token';
    throw err;
  }
  const tokens = grantedScope.split(/\s+/);
  if (!tokens.includes('media:read') || !tokens.includes('media:write')) {
    const err = new Error('Insufficient scope — Simkl granted a read-only or restricted token');
    err.state = 'insufficient_scope';
    throw err;
  }
  return grantedScope;
}

// Handle the callback: validate state, exchange code for tokens, validate the
// returned grant. Consumes the flow BEFORE the token exchange (a replayed or
// failed callback cannot re-use the state). A failed/cancelled/replayed
// callback preserves any existing active grant (the caller does not overwrite
// simkl_auth on failure).
//
// Returns { access_token, refresh_token, expires_at, scope, username } or
// throws a structured error { message, state } where state is one of:
//   'expired', 'state_mismatch', 'exchange_failed',
//   'invalid_issuer', 'insufficient_scope', 'malformed_token',
//   'credential_changed'
async function handleCallback(profile, { code, state, iss }) {
  const flow = flows.get(profile.id);
  if (!flow) {
    const err = new Error('No pending V2 flow for this profile');
    err.state = 'expired';
    throw err;
  }
  // Consume the flow BEFORE the exchange: a replayed callback (same state,
  // second time) finds no pending flow and fails. This is the replay guard.
  flows.delete(profile.id);

  if (Date.now() > flow.expires_at) {
    const err = new Error('V2 flow expired — start again');
    err.state = 'expired';
    throw err;
  }
  if (flow.state !== state) {
    const err = new Error('State mismatch (possible CSRF) — start again');
    err.state = 'state_mismatch';
    throw err;
  }
  // Validate the callback issuer (Simkl supplies `iss` on the callback query).
  // A missing or non-Simkl issuer means the callback did not come from Simkl —
  // the documented exact issuer is required (a missing issuer is rejected too).
  if (iss !== EXPECTED_ISS) {
    const err = new Error('Unexpected callback issuer');
    err.state = 'invalid_issuer';
    throw err;
  }
  // Detect a credential change during the flow: the initiating Client ID
  // recorded at startFlow must match the profile's current V2 Client ID.
  // A changed credential means the flow was started with a different app
  // registration; the token would be bound to the old registration.
  if (flow.client_id !== profile.keys.simkl_v2_client_id) {
    const err = new Error('V2 Client ID changed during the flow — start again');
    err.state = 'credential_changed';
    throw err;
  }
  // Exchange the authorization code for tokens. The client_secret is sent
  // server-side only (M4). PKCE code_verifier is included (S256).
  // Use the INITIATING credentials (recorded at startFlow), not the profile's
  // current credentials (which may have changed).
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirect_uri,
    client_id: flow.client_id,
    client_secret: flow.client_secret,
    code_verifier: flow.code_verifier,
  });
  const res = await fetch(SIMKL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = new Error(`Simkl token exchange failed (${res.status})`);
    err.state = 'exchange_failed';
    throw err;
  }
  const data = await res.json();
  // Validate the returned grant. Require nonempty access_token AND
  // refresh_token, positive finite expires_in, and exact granted scope members.
  if (!data.access_token || typeof data.access_token !== 'string') {
    const err = new Error('Simkl did not return an access token');
    err.state = 'malformed_token';
    throw err;
  }
  if (!data.refresh_token || typeof data.refresh_token !== 'string') {
    const err = new Error('Simkl did not return a refresh token');
    err.state = 'malformed_token';
    throw err;
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    const err = new Error('Simkl did not return a valid expires_in');
    err.state = 'malformed_token';
    throw err;
  }
  // Validate the issuer (if present in the token response).
  if (data.iss && data.iss !== EXPECTED_ISS) {
    const err = new Error('Unexpected token issuer');
    err.state = 'invalid_issuer';
    throw err;
  }
  // Validate the granted scope.
  const grantedScope = validateScope(data.scope);
  // Compute absolute expiry (expires_in is relative seconds).
  const expiresAt = Date.now() + data.expires_in * 1000;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    scope: grantedScope,
    username: data.username || null,
  };
}

// Refresh a V2 token using the refresh_token grant.
// Returns { access_token, refresh_token, expires_at } where expires_at is
// an absolute timestamp (ms since epoch).
async function refreshToken(profile) {
  const auth = profile.simkl_auth;
  if (!auth?.refresh_token) throw new Error('No refresh token stored');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: profile.keys.simkl_v2_client_id,
    client_secret: profile.keys.simkl_v2_client_secret,
  });
  const res = await fetch(SIMKL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Simkl token refresh failed (${res.status})`);
  const data = await res.json();
  if (!data.access_token || typeof data.access_token !== 'string') {
    throw new Error('Simkl did not return a refreshed access token');
  }
  const expiresAt = (typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0)
    ? Date.now() + data.expires_in * 1000
    : null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || auth.refresh_token, // non-rotating
    expires_at: expiresAt,
  };
}

// Revoke a V2 token (POST /oauth2/revoke). Best-effort: a failure is logged
// but not fatal (the token may already be expired).
async function revokeToken(profile) {
  const auth = profile.simkl_auth;
  if (!auth?.access_token) return;
  const body = new URLSearchParams({
    token: auth.access_token,
    client_id: profile.keys.simkl_v2_client_id,
    client_secret: profile.keys.simkl_v2_client_secret,
  });
  try {
    await fetch(SIMKL_REVOKE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch { /* best-effort */ }
}

// Get the pending flow for a profile (for the portal's status endpoint).
// Never exposes the code_verifier or client_secret (M4).
function getFlow(profileId) {
  const flow = flows.get(profileId);
  if (!flow) return null;
  if (Date.now() > flow.expires_at) {
    flows.delete(profileId);
    return null;
  }
  return { state: flow.state, expires_at: flow.expires_at, client_id: flow.client_id };
}

module.exports = {
  startFlow,
  handleCallback,
  consumeFlow,
  refreshToken,
  revokeToken,
  getFlow,
  generatePkce,
  buildAuthorizeUrl,
};
