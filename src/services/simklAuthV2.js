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
//   4. The callback handler validates state, exchanges the code for tokens
//      (POST /oauth2/token), and stores them in the profile.
//
// PKCE (RFC 7636):
//   code_verifier: 43-128 random chars (unpadded base64url)
//   code_challenge: BASE64URL(SHA256(code_verifier)) — S256 method

const crypto = require('crypto');
const config = require('../config');

const SIMKL_AUTHORIZE = 'https://simkl.com/oauth2/authorize';
const SIMKL_TOKEN = 'https://api.simkl.com/oauth2/token';
const SIMKL_REVOKE = 'https://api.simkl.com/oauth2/revoke';
const SCOPE = 'all'; // Simkl V2 default scope

// In-memory flow state: profileId → { state, code_verifier, redirect_uri, expires_at }
// The state is a random opaque string; the code_verifier is never sent to the
// browser (M4). The redirect_uri must match what was registered on the Simkl
// app AND what we send to the token endpoint.
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
function startFlow(profile, redirectUri) {
  const clientId = profile.keys.simkl_v2_client_id;
  if (!clientId) throw new Error('V2 Client ID required');
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomBase64Url(16); // 22 chars
  const flow = {
    state,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    expires_at: Date.now() + 10 * 60 * 1000, // 10 min
  };
  flows.set(profile.id, flow);
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge });
  return { authorizeUrl, state };
}

// Handle the callback: validate state, exchange code for tokens.
// Returns { access_token, refresh_token, expires_in, username? } or throws.
async function handleCallback(profile, { code, state }) {
  const flow = flows.get(profile.id);
  if (!flow) throw new Error('No pending V2 flow for this profile');
  if (Date.now() > flow.expires_at) {
    flows.delete(profile.id);
    throw new Error('V2 flow expired — start again');
  }
  if (flow.state !== state) {
    flows.delete(profile.id);
    throw new Error('State mismatch (possible CSRF) — start again');
  }
  // Exchange the authorization code for tokens. The client_secret is sent
  // server-side only (M4). PKCE code_verifier is included (S256).
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirect_uri,
    client_id: profile.keys.simkl_v2_client_id,
    client_secret: profile.keys.simkl_v2_client_secret,
    code_verifier: flow.code_verifier,
  });
  const res = await fetch(SIMKL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Never echo the provider body to the browser (M4).
    throw new Error(`Simkl token exchange failed (${res.status})`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Simkl did not return an access token');
  flows.delete(profile.id); // flow consumed
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || null,
    username: data.username || null,
  };
}

// Refresh a V2 token using the refresh_token grant.
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
  if (!data.access_token) throw new Error('Simkl did not return a refreshed access token');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || auth.refresh_token, // non-rotating
    expires_in: data.expires_in || null,
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
function getFlow(profileId) {
  const flow = flows.get(profileId);
  if (!flow) return null;
  if (Date.now() > flow.expires_at) {
    flows.delete(profileId);
    return null;
  }
  // Never expose the code_verifier (M4).
  return { state: flow.state, expires_at: flow.expires_at };
}

module.exports = {
  startFlow,
  handleCallback,
  refreshToken,
  revokeToken,
  getFlow,
  generatePkce,
  buildAuthorizeUrl,
};
