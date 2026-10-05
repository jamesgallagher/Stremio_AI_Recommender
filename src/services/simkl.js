// Simkl API client (v6) — the Trakt replacement for watch-tracking.
//
// One Simkl app PER PROFILE (client id + secret), each connecting its own Simkl
// account via the PIN device flow — the same shape as the old Trakt client, so
// the portal wiring maps across almost 1:1.
//
// Simkl API rules (docs/v6-plan.md §6b), enforced here:
//   - EVERY request carries client_id + app-name + app-version query params and
//     a descriptive User-Agent header.
//   - Reads are 10/s, writes 1/s (the rate governor, a later slice, will pace
//     the sync traffic; auth calls here are one-offs).
const governor = require('./governor');
const API = 'https://api.simkl.com';
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';
const APP_NAME = 'AI-Recommender';
const APP_VERSION = require('../../package.json').version;

// Append the always-required query params to a path.
function withParams(clientId, path, extra = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('app-name', APP_NAME);
  url.searchParams.set('app-version', APP_VERSION);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url;
}

function headers(accessToken) {
  const h = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

// ---- PIN device flow ----
// Start: returns { user_code, verification_url, expires_in, interval }. The user
// enters user_code at verification_url (simkl.com/pin); we then poll.
async function startPinFlow(clientId) {
  const res = await fetch(withParams(clientId, '/oauth/pin'), { headers: headers() });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Simkl PIN request failed (${res.status})${body ? `: ${body}` : ''} — check the Client ID`);
  }
  const dc = await res.json();
  if (!dc.user_code) throw new Error('Simkl did not return a user code — check the Client ID');
  return dc;
}

// Poll: Simkl returns { result: 'OK', access_token } once approved, otherwise
// { result: 'KO' } while pending. Mirrors the Trakt poll shape our portal
// expects ({ pending } | { token } | { error }).
async function pollPin(clientId, userCode) {
  const res = await fetch(withParams(clientId, `/oauth/pin/${encodeURIComponent(userCode)}`), { headers: headers() });
  if (res.status === 404) return { error: 'PIN expired — start again' };
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    return { error: `Simkl PIN poll failed (${res.status})${body ? `: ${body}` : ''}` };
  }
  const data = await res.json();
  if (data.result === 'OK' && data.access_token) {
    // Simkl access tokens are long-lived (no refresh cycle like Trakt).
    return { token: { access_token: data.access_token, connected_at: Date.now() } };
  }
  return { pending: true };
}

// ---- connection check (LIVE status) ----
// The portal calls this on the Simkl tab open to show REAL status, never a
// stored flag — the v5 bug was showing "connected" for tokens the provider had
// long since invalidated. A cheap authed call: 200 = valid, 401/403 = dead.
async function checkConnection(clientId, accessToken) {
  if (!accessToken) return { valid: false, reason: 'not connected' };
  try {
    const res = await fetch(withParams(clientId, '/sync/activities'), { headers: headers(accessToken) });
    if (res.ok) {
      const info = await accountName(clientId, accessToken).catch(() => null);
      return { valid: true, username: info?.name || null };
    }
    if (res.status === 401 || res.status === 403) return { valid: false, reason: 'token rejected — reconnect' };
    return { valid: false, reason: `Simkl returned ${res.status}` };
  } catch (err) {
    return { valid: false, reason: `Simkl unreachable: ${err.message}` };
  }
}

// Best-effort account info for the status line. Non-fatal if it fails.
// Returns { name, id } where id is the stable Simkl account ID (user_id)
// if the provider returns one; name is the display name/username.
async function accountName(clientId, accessToken) {
  const res = await fetch(withParams(clientId, '/users/settings'), { headers: headers(accessToken) });
  if (!res.ok) return null;
  const data = await res.json();
  const name = data?.user?.name || data?.user?.username || null;
  const id = data?.user?.id || data?.user?.user_id || null;
  return { name, id };
}

// Bounded fetch (mandate M6): the manual check must not hang the portal. A
// timeout is a distinct, visible "unreachable" result, not a silent failure.
// The provider's one-request check stays out of the recurring background poll.
const CHECK_TIMEOUT_MS = 10000;
async function boundedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Simkl unreachable (timeout)');
    throw new Error(`Simkl unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Shared auth resolution (SIMKL-AUTH-1 Step 3) ----
// resolveAuth returns { clientId, token } for the profile's active token.
// V1: simkl_client_id + simkl_auth.access_token.
// V2: simkl_v2_client_id + simkl_auth.access_token.
// The active token is always the one stored in simkl_auth, regardless of the
// preferred version (simkl_auth_version). Selecting V2 for the NEXT connection
// does NOT change the active token's version (M3).
// Rejects a stored grant/client-ID mismatch before any request (Blocker 6):
// if the active token's bound client_id differs from the current credential,
// the token is unusable (it was minted by a different app registration).
function resolveAuth(profile) {
  const auth = profile.simkl_auth;
  if (!auth?.access_token) return null;
  const version = auth.version || 1; // absent version = V1
  const clientId = version === 2 ? profile.keys.simkl_v2_client_id : profile.keys.simkl_client_id;
  if (!clientId) return null;
  // Reject a stored grant/client-ID mismatch: the token is bound to the
  // client_id that minted it. A changed credential means the token is
  // unusable (credential_mismatch), never a user API call with a mismatched pair.
  if (auth.client_id && auth.client_id !== clientId) return null;
  return { clientId, token: auth.access_token, version };
}

// simklFetch: the shared adapter for all Simkl API calls. Resolves the active
// token via resolveAuth, applies the rate governor, and handles auth errors.
// All Simkl call sites use this instead of directly referencing
// profile.keys.simkl_client_id / profile.simkl_auth.
//
// Refresh policy:
//   - Only an ACTIVE V2 grant is refreshed (version === 2 on the token).
//   - Proactive: if the token is expired or about to expire (within 60 s),
//     refresh before sending the request.
//   - Reactive: on 401, refresh and replay once — but only if the refresh
//     actually persisted a new token for the same grant (a disconnect or
//     account switch during the refresh makes the refresh obsolete).
//   - A 403 is NOT a refresh trigger (it may be insufficient scope, which a
//     refresh cannot fix).
//   - A V1 grant is never refreshed (V1 tokens are long-lived; a 401 means
//     the token is dead → reconnect).
const EXPIRY_MARGIN_MS = 60 * 1000; // refresh 60 s before expiry

async function simklFetch(profile, path, { method = 'GET', extra = {}, body = null, lane = 'simkl_get' } = {}) {
  let auth = resolveAuth(profile);
  if (!auth) throw new Error('Simkl is not connected for this profile');
  let { clientId, token, version } = auth;
  // Proactive expiry check: if the token is expired or about to expire,
  // refresh before sending the request (V2 only). After a successful refresh,
  // re-resolve the persisted active grant so the first API call uses the NEW
  // token (Simkl invalidates the old access token on refresh).
  if (version === 2) {
    const fresh = require('../config').getProfile(profile.id);
    const expiresAt = fresh?.simkl_auth?.expires_at;
    if (expiresAt && Date.now() >= expiresAt - EXPIRY_MARGIN_MS) {
      const refreshed = await refreshV2(profile).catch(() => null);
      if (refreshed) {
        // Re-read the grant to confirm the refresh persisted.
        const after = require('../config').getProfile(profile.id);
        if (after?.simkl_auth?.access_token === refreshed.access_token && after.simkl_auth.version === 2) {
          // Re-resolve: use the NEW token and client ID for the API call.
          auth = resolveAuth(after);
          if (!auth) throw new Error('Simkl token expired and refresh did not persist — reconnect the account');
          clientId = auth.clientId;
          token = auth.token;
        } else {
          // The refresh did not persist (grant changed/disconnected).
          throw new Error('Simkl token expired and refresh did not persist — reconnect the account');
        }
      } else {
        throw new Error('Simkl token expired — reconnect the account');
      }
    }
  }
  // The governed send re-reads the active grant immediately before the fetch:
  // a grant-keyed refresh alone does not protect the LATER governor callback.
  // If a Disconnect or account replacement occurs while this call was queued,
  // the send is aborted (the captured token no longer belongs to the active
  // grant) rather than fired with a stale token.
  const res = await governor.schedule(lane, async () => {
    const after = require('../config').getProfile(profile.id);
    const current = resolveAuth(after);
    if (!current || current.token !== token || current.version !== version) {
      throw new Error('Simkl grant changed while queued — abort');
    }
    return fetch(withParams(current.clientId, path, extra), {
      method,
      headers: headers(current.token),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  });
  if (res.status === 401) {
    // Only refresh an active V2 grant on 401. A V1 grant is never refreshed.
    if (version === 2) {
      const refreshed = await refreshV2(profile).catch(() => null);
      if (refreshed) {
        // Verify the refresh persisted for the same grant. A disconnect or
        // account switch during the refresh makes the refresh obsolete —
        // do NOT replay with a token that no longer belongs to the active grant.
        const after = require('../config').getProfile(profile.id);
        if (after?.simkl_auth?.access_token === refreshed.access_token && after.simkl_auth.version === 2) {
          const res2 = await governor.schedule(lane, async () => {
            const after2 = require('../config').getProfile(profile.id);
            const current = resolveAuth(after2);
            if (!current || current.token !== refreshed.access_token || current.version !== 2) {
              throw new Error('Simkl grant changed while queued — abort');
            }
            return fetch(withParams(current.clientId, path, extra), {
              method,
              headers: headers(current.token),
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
          });
          if (res2.ok) return res2;
        }
      }
    }
    throw new Error('Simkl token rejected — reconnect the account');
  }
  if (res.status === 403) {
    // 403 is NOT a refresh trigger: it may be insufficient scope (a refresh
    // cannot fix that) or a permission error. Report it directly.
    throw new Error('Simkl access denied (403) — check the token scope or reconnect');
  }
  if (!res.ok) throw new Error(`Simkl ${method} ${path} failed (${res.status})`);
  return res;
}

// V2 token refresh (single-flight, non-rotating refresh token, one replay).
// Re-read the latest grant before refreshing, key the single-flight to that
// specific grant (not just the profile), update only if the grant still
// matches after the refresh (a disconnect or new V2 authorization during the
// refresh must not be reversed), and persist the new absolute expiry.
//
// Returns { access_token, refresh_token, expires_at } on success, or null if
// the refresh is obsolete (grant disconnected/changed during the refresh).
// An obsolete refresh returns no usable token to its caller.
const refreshInFlight = new Map(); // grantKey → Promise
async function refreshV2(profile) {
  // Re-read the latest grant from the store (the `profile` argument may be
  // a stale snapshot from before the refresh started).
  const config = require('../config');
  const fresh = config.getProfile(profile.id);
  if (!fresh?.simkl_auth?.access_token || fresh.simkl_auth.version !== 2) return null;
  if (!fresh.simkl_auth.refresh_token) return null;
  // Key the single-flight to the specific grant (access_token + refresh_token):
  // a concurrent refresh for the SAME grant joins the in-flight one; a
  // different grant (new authorization) starts a fresh refresh.
  const grantKey = `${profile.id}:${fresh.simkl_auth.access_token}:${fresh.simkl_auth.refresh_token}`;
  const existing = refreshInFlight.get(grantKey);
  if (existing) return existing;
  const simklAuthV2 = require('./simklAuthV2');
  const promise = simklAuthV2.refreshToken(fresh).then((tokens) => {
    // Re-read the grant after the refresh: a disconnect or new V2
    // authorization during the refresh must not be reversed.
    const after = config.getProfile(profile.id);
    if (!after?.simkl_auth?.access_token || after.simkl_auth.version !== 2) return null;
    // Update only if the grant still matches (same access_token as before the
    // refresh — a new authorization would have a different token).
    if (after.simkl_auth.access_token !== fresh.simkl_auth.access_token) return null;
    config.updateProfile(profile.id, {
      simkl_auth: {
        ...after.simkl_auth,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || after.simkl_auth.refresh_token,
        expires_at: tokens.expires_at,
      },
    });
    return tokens;
  }).finally(() => {
    refreshInFlight.delete(grantKey);
  });
  refreshInFlight.set(grantKey, promise);
  return promise;
}

// ---- Manual Check connection (mandate M6) ----
// The manual "Check connection" button calls this (POST /simkl/check). It does
// NOT create a connection flow, authorize a user, or show a PIN, and it does
// NOT edit profile settings. It returns a structured state + a short safe
// message (never a generic {connected:false}). Only `connected` is a success
// badge; a stored token alone is "token stored", never "connected".
//
// The state enum (mandate M6): connected, v1_ready_unconnected, not_authorized,
// wrong_auth_version, client_id_rejected, credential_mismatch, rate_limited,
// provider_unavailable, missing_configuration.
//
// Simkl's documented stable `error` identifiers (conventions/errors) are parsed
// by identifier + HTTP status — never by pattern-matching provider prose, and
// the provider body is never echoed to the browser (M4).
async function manualCheck(profile) {
  const version = profile.simkl_auth_version || 2;
  const auth = profile.simkl_auth;
  const hasToken = !!(auth && auth.access_token);

  if (hasToken) {
    // Active token + matching active client ID → verify /sync/activities.
    const clientId = auth.version === 2 ? profile.keys.simkl_v2_client_id : profile.keys.simkl_client_id;
    let token = auth.access_token;
    if (!clientId) {
      return { state: 'credential_mismatch', message: 'Simkl credential missing — reconnect the account' };
    }
    // The active token must be bound to the client ID that minted it (M3). A
    // changed/replaced credential while connected is a mismatch, never a
    // user API call with a mismatched pair.
    if (auth.client_id && auth.client_id !== clientId) {
      return { state: 'credential_mismatch', message: 'Simkl credential changed since this token was issued — reconnect' };
    }
    try {
      const res = await boundedFetch(withParams(clientId, '/sync/activities'), { headers: headers(token) });
      if (res.ok) {
        const info = await accountName(clientId, token).catch(() => null);
        return { state: 'connected', message: 'Connected and verified', username: info?.name || auth.username || null, account_id: info?.id || null };
      }
      // V2: a 401 may be an expired token — attempt one refresh before
      // declaring the grant rejected (Blocker 6).
      if (res.status === 401 && auth.version === 2) {
        const refreshed = await refreshV2(profile).catch(() => null);
        if (refreshed) {
          const res2 = await boundedFetch(withParams(clientId, '/sync/activities'), { headers: headers(refreshed.access_token) });
          if (res2.ok) {
            const info = await accountName(clientId, refreshed.access_token).catch(() => null);
            return { state: 'connected', message: 'Connected and verified (token refreshed)', username: info?.name || auth.username || null, account_id: info?.id || null };
          }
        }
      }
      if (res.status === 401 || res.status === 403) {
        return { state: 'credential_mismatch', message: 'Token rejected by Simkl — reconnect the account' };
      }
      if (res.status === 429) {
        return { state: 'rate_limited', message: 'Simkl rate limit — try again shortly' };
      }
      return { state: 'provider_unavailable', message: `Simkl returned ${res.status}` };
    } catch (err) {
      return { state: 'provider_unavailable', message: err.message };
    }
  }

  // No token. Branch on the preferred version (what Connect would start).
  if (version === 1) {
    const clientId = profile.keys.simkl_client_id;
    if (!clientId) {
      return { state: 'missing_configuration', message: 'Client ID required' };
    }
    // One GET /oauth/pin compatibility probe; discard the returned PIN. This
    // tells us whether the V1 app can start the PIN flow (no grant exists yet).
    try {
      const res = await boundedFetch(withParams(clientId, '/oauth/pin'), { headers: headers() });
      if (res.ok) {
        return { state: 'v1_ready_unconnected', message: 'V1 app accepted; Simkl account not connected. Click Connect.' };
      }
      const body = await res.json().catch(() => ({}));
      // 400 unauthorized_client: Simkl's documented V2-ID-on-V1-endpoint error.
      if (res.status === 400 && body.error === 'unauthorized_client') {
        return { state: 'wrong_auth_version', message: 'This is a V2 app; select AUTH V2 and connect with the new flow.' };
      }
      // 412 client_id_failed: an incorrect/suspended ID or an active throttling
      // block. It does NOT prove the ID is V2 — do not assert that (M6).
      if (res.status === 412 && body.error === 'client_id_failed') {
        return { state: 'client_id_rejected', message: 'V1 Client ID rejected (HTTP 412). Check the ID/app registration or a Simkl block.' };
      }
      return { state: 'provider_unavailable', message: `Simkl returned ${res.status}` };
    } catch (err) {
      return { state: 'provider_unavailable', message: err.message };
    }
  }

  // V2 selected, no token. Simkl has no app-only grant — the secret cannot be
  // validated without a user grant (M6). Name the missing field, or report that
  // OAuth consent is needed (never a "successful secret test").
  const v2Id = profile.keys.simkl_v2_client_id;
  const v2Secret = profile.keys.simkl_v2_client_secret;
  if (!v2Id || !v2Secret) {
    const missing = !v2Id ? 'V2 Client ID' : 'V2 Client Secret';
    return { state: 'missing_configuration', message: `${missing} required` };
  }
  return { state: 'not_authorized', message: 'Credentials saved; account not yet verified. Click Connect to complete V2 OAuth.' };
}

// ---- watched-history read (v6) ----
// Verified live against the real API (account "James", 2026-08-18): activities
// returns per-type change timestamps; all-items/{type}/completed returns items
// carrying imdb+tmdb ids and last_watched_at inline (genres/cert are NOT
// included — enriched at ingest, see the watched store).

async function authedGet(profile, path, extra = {}) {
  const res = await simklFetch(profile, path, { method: 'GET', extra });
  return res.json();
}

// The cheap "what changed" call. Returns { all, movies, tv_shows, anime, ... }
// ISO timestamps. Compare against the saved value before pulling all-items —
// mandatory per Simkl's rules (docs/v6-plan §6b).
async function getActivities(profile) {
  return authedGet(profile, '/sync/activities');
}

// ---- Marquee ME-03 (spec §4.1): ratings + "users also liked" ----
// Both are authed GETs on the same governed simkl_get lane (MI-4 etiquette:
// every Simkl call via the governor, sequential, no retry loops).

// GET /sync/ratings/{kind} — §12 L1: returns EVERY movie on the account, not
// only rated ones; unrated entries carry user_rating null.
async function getRatings(profile, kind = 'movies') {
  const body = await authedGet(profile, `/sync/ratings/${kind}`);
  return parseRatings(body, kind);
}

// PURE (spec §4.1): parse a /sync/ratings/{kind} body into
// [{ tmdb_id, imdb_id, simkl_id, rating, rated_at }]. §12 L1: ids sit at
// entry.movie.ids (kind 'movies') or entry.show.ids (kind 'shows') (tmdb a
// string), else entry.ids; keep only entries whose user_rating is an integer
// 1–10; tolerate a bare array; drop entries with no id; never throws (MI-3) —
// malformed entries just come back as fewer items.
function parseRatings(body, kind = 'movies') {
  let entries;
  if (Array.isArray(body)) entries = body;
  else if (body && typeof body === 'object') entries = body[kind] || [];
  else entries = [];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const rating = e.user_rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) continue; // unrated / out of range
    const media = kind === 'shows' ? e.show : e.movie;
    const ids = (media && media.ids) || e.ids || {};
    const tmdb = ids.tmdb != null ? String(ids.tmdb) : null;
    const imdb = ids.imdb != null ? String(ids.imdb) : null;
    const simkl = ids.simkl != null ? Number(ids.simkl) : null;
    if (tmdb == null && imdb == null && simkl == null) continue; // no id — unusable
    out.push({ tmdb_id: tmdb, imdb_id: imdb, simkl_id: simkl, rating, rated_at: e.user_rated_at || null });
  }
  return out;
}

// ---- Trainer T1: Simkl rating WRITEs (the /sync/ratings POST pair) ----
// Simkl is the authority for ratings (mandate M1): a rating is written here
// first, and the local taste_ratings row is written only after this succeeds.
// Both writes ride the governed simkl_post lane (mandate M7 — hard 1 POST/s
// write cap; exceeding it risks account suspension). No retries, no loops.

// PURE: build a /sync/ratings body from items. `items` is
// [{ type, simkl_id?, imdb_id?, tmdb_id?, rating? }]. Output is
// { movies: [...], shows: [...] } — both keys always present. `type 'series'`
// → shows, everything else → movies. ids: simkl a Number (finite only), imdb a
// String (truthy only), tmdb a String (non-null/non-empty only); an item with
// no ids is dropped. `rating` is included only when `withRating` is true AND it
// is an integer 1–10. Exported for tests.
function buildRatingsBody(items, { withRating = true } = {}) {
  const movies = [];
  const shows = [];
  for (const it of Array.isArray(items) ? items : [items]) {
    if (!it) continue;
    const ids = {};
    if (it.simkl_id != null && Number.isFinite(Number(it.simkl_id))) ids.simkl = Number(it.simkl_id);
    if (it.imdb_id) ids.imdb = String(it.imdb_id);
    if (it.tmdb_id != null && it.tmdb_id !== '') ids.tmdb = String(it.tmdb_id);
    if (!ids.simkl && !ids.imdb && !ids.tmdb) continue; // no ids — dropped
    const entry = { ids };
    if (withRating && Number.isInteger(it.rating) && it.rating >= 1 && it.rating <= 10) entry.rating = it.rating;
    (it.type === 'series' ? shows : movies).push(entry);
  }
  return { movies, shows };
}

// POST /sync/ratings — set ratings. Rate-governed at the hard 1-POST/s Simkl
// write cap (the simkl_post lane), exactly like addToHistory. Throws on a
// rejected token or a non-ok response; the caller maps that to a 502.
async function setRatings(profile, items) {
  const body = buildRatingsBody(items);
  if (!body.movies.length && !body.shows.length) throw new Error('nothing to rate');
  const res = await simklFetch(profile, '/sync/ratings', { method: 'POST', body, lane: 'simkl_post' });
  return res.json().catch(() => ({}));
}

// POST /sync/ratings/remove — clear ratings (withRating:false → no rating field).
// Same lane and error contract as setRatings.
async function removeRatings(profile, items) {
  const body = buildRatingsBody(items, { withRating: false });
  if (!body.movies.length && !body.shows.length) throw new Error('nothing to rate');
  const res = await simklFetch(profile, '/sync/ratings/remove', { method: 'POST', body, lane: 'simkl_post' });
  return res.json().catch(() => ({}));
}

// POST /sync/history/remove — remove items from watch history (Trainer T3.1
// "Mark unwatched"). Same lane and error contract as removeRatings (the
// governed simkl_post lane). withRating:false → ids only, no rating field.
async function removeFromHistory(profile, items) {
  const body = buildRatingsBody(items, { withRating: false });
  if (!body.movies.length && !body.shows.length) throw new Error('nothing to remove');
  const res = await simklFetch(profile, '/sync/history/remove', { method: 'POST', body, lane: 'simkl_post' });
  return res.json().catch(() => ({}));
}

// GET /movies/{simklId} — §12 L4: users_recommendations ("users also liked")
// is present BY DEFAULT (no extra query params), so none are sent.
async function getMovieSummary(profile, simklId) {
  const body = await authedGet(profile, `/movies/${simklId}`);
  return parseMovieSummary(body);
}

// PURE (spec §4.1): parse a /movies/{id} body → { users_recommendations:
// [{ simkl_id, tmdb_id, imdb_id, title, year }] }. §12 L4: ids at item.ids,
// tmdb a string; missing users_recommendations → [].
function parseMovieSummary(body) {
  const items = body && typeof body === 'object' && Array.isArray(body.users_recommendations) ? body.users_recommendations : [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const ids = it.ids || {};
    const tmdb = ids.tmdb != null ? String(ids.tmdb) : null;
    const imdb = ids.imdb != null ? String(ids.imdb) : null;
    const simkl = ids.simkl != null ? Number(ids.simkl) : null;
    if (tmdb == null && imdb == null && simkl == null) continue; // no id — unusable
    out.push({ simkl_id: simkl, tmdb_id: tmdb, imdb_id: imdb, title: it.title || null, year: it.year != null ? Number(it.year) : null });
  }
  return { users_recommendations: out };
}

// Full/delta watched read for one type ('movies' | 'shows' | 'anime'), status
// 'completed'. Pass dateFrom (ISO) for Phase-2 delta syncs; omit for the
// Phase-1 initial pull. Always sequential per type (Simkl asks not to hammer).
// `episodes: true` adds `extended=full&episode_watched_at=yes` (shows/anime only).
async function getAllItems(profile, type, { status = 'completed', dateFrom, episodes = false } = {}) {
  const extra = {};
  if (dateFrom) extra.date_from = dateFrom;
  if (episodes) { extra.extended = 'full'; extra.episode_watched_at = 'yes'; }
  const body = await authedGet(profile, `/sync/all-items/${type}/${status}`, extra);
  if (Array.isArray(body)) return body;
  // Combined all-items responses key by section; single-type still returns an
  // array here, but guard for the { movies:[], shows:[], anime:[] } shape.
  return body?.[type] || body?.[type === 'shows' ? 'tv' : type] || [];
}

// Normalise a Simkl all-items entry to our watched-store shape. Genres and age
// classification are filled by the ingest enrichment, not here.
function parseWatchedItem(item, type) {
  const media = item.movie || item.show || item.anime || (type === 'movies' ? item.movie : item.show);
  if (!media?.ids) return null;
  const kind = (item.movie || type === 'movies') ? 'movie' : 'series';
  return {
    type: kind,
    title: media.title || null,
    year: media.year || null,
    tmdb_id: media.ids.tmdb ? String(media.ids.tmdb) : null,
    imdb_id: media.ids.imdb || null,
    simkl_id: media.ids.simkl || null,
    watched_at: item.last_watched_at || item.watched_at || null,
  };
}

function parseWatchedItems(items, type) {
  return (Array.isArray(items) ? items : []).map((it) => parseWatchedItem(it, type)).filter(Boolean);
}

// ---- series progress (TV-1) ----
// One all-items entry from the 'shows' or 'anime' section → a progress row,
// or null (no ids / no simkl id). Pure: no network, no DB.
//
// Bulk rule: a stamp is BULK if the gap to its previous OR next sorted stamp
// is < BULK_GAP_MS (5 min). Identical stamps are bulk. A gap of exactly
// BULK_GAP_MS is real. Speed (eps_per_week) uses real stamps only (V4).
const BULK_GAP_MS = 300000; // 5 minutes

function parseSeriesProgress(item, section) {
  const media = item.show || item.anime;
  if (!media?.ids) return null;
  const simklId = media.ids.simkl;
  if (simklId == null) return null;

  const kind = section === 'anime' ? 'anime' : 'show';
  const stamps = [];
  for (const season of (item.seasons || [])) {
    for (const ep of (season.episodes || [])) {
      if (ep.watched_at) stamps.push(Date.parse(ep.watched_at));
    }
  }
  stamps.sort((a, b) => a - b);

  // Classify each stamp as bulk or real.
  const realStamps = [];
  for (let i = 0; i < stamps.length; i++) {
    let isBulk = false;
    if (i > 0 && stamps[i] - stamps[i - 1] < BULK_GAP_MS) isBulk = true;
    if (i < stamps.length - 1 && stamps[i + 1] - stamps[i] < BULK_GAP_MS) isBulk = true;
    if (!isBulk) realStamps.push(stamps[i]);
  }

  const lastWatchedAt = item.last_watched_at ? Date.parse(item.last_watched_at) : null;
  const firstRealAt = realStamps.length ? realStamps[0] : null;
  const lastRealAt = realStamps.length ? realStamps[realStamps.length - 1] : null;

  // Speed: real stamps only, ≥ 4 required. eps_per_week = real_stamps / max(1,
  // span in weeks) — the span is measured in 7-day units (7 * 86400e3 ms), so a
  // show watched over 2 weeks at 4 real eps is 2 eps/week.
  let epsPerWeek = null;
  if (realStamps.length >= 4) {
    const spanWeeks = (lastRealAt - firstRealAt) / (7 * 86400e3);
    epsPerWeek = realStamps.length / Math.max(1, spanWeeks);
  }

  return {
    simkl_id: simklId,
    kind,
    imdb_id: media.ids.imdb || null,
    tmdb_id: media.ids.tmdb ? String(media.ids.tmdb) : null,
    title: media.title || null,
    year: media.year || null,
    status: item.status || null,
    watched_eps: item.watched_episodes_count || 0,
    total_eps: item.total_episodes_count > 0 ? item.total_episodes_count : null,
    not_aired_eps: item.not_aired_episodes_count ?? null,
    last_watched_at: lastWatchedAt,
    first_watched_at: stamps.length ? stamps[0] : null,
    first_real_at: firstRealAt,
    last_real_at: lastRealAt,
    stamps: stamps.length,
    real_stamps: realStamps.length,
    eps_per_week: epsPerWeek,
  };
}

// Map an all-items section (shows | anime) into progress rows, dropping entries
// parseSeriesProgress can't use (no ids / no simkl id). Pure.
function parseSeriesProgressItems(items, section) {
  return (Array.isArray(items) ? items : [])
    .map((it) => parseSeriesProgress(it, section))
    .filter(Boolean);
}

// ---- recent watched history (debug view) ----
// LIVE from Simkl — the authority — bypassing the local watched store and the
// Nuvio/Stremio scrobble view entirely. Returns items newest-first, capped at
// `limit`. Movies come from the 'movies' section; series merge Simkl's two
// separate sections ('shows' + 'anime'). We pull both 'completed' and (for
// series) 'watching', since Simkl files an in-progress show under 'watching' —
// that's still "recently watched" for a debug list. De-dupes across sections/
// statuses by simkl_id, keeping the most recent watch time.
function watchedMs(iso) { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? 0 : t; }

async function getRecentWatched(profile, kind, { limit = 50 } = {}) {
  const sections = kind === 'movie' ? ['movies'] : ['shows', 'anime'];
  const statuses = kind === 'movie' ? ['completed'] : ['completed', 'watching'];
  const byId = new Map();
  for (const section of sections) { // sequential per Simkl's rules
    for (const status of statuses) {
      const items = await getAllItems(profile, section, { status });
      for (const it of parseWatchedItems(items, section)) {
        const key = it.simkl_id != null ? `s:${it.simkl_id}` : `k:${it.type}:${it.tmdb_id || it.imdb_id || it.title}`;
        const prev = byId.get(key);
        if (!prev || watchedMs(it.watched_at) > watchedMs(prev.watched_at)) byId.set(key, it);
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => watchedMs(b.watched_at) - watchedMs(a.watched_at))
    .slice(0, limit);
}

// ---- watched-history write (v6, auto-scrobble destination) ----
// POST missing watched items to Simkl's history. The body shape matches what
// scrobble.computeDelta already builds:
//   { movies: [{ ids:{imdb}, watched_at? }],
//     shows:  [{ ids:{imdb}, seasons:[{ number, episodes:[{ number, watched_at? }] }] }] }
// Simkl de-dupes re-marks, so an over-broad push is harmless.
async function addToHistory(profile, body) {
  const res = await simklFetch(profile, '/sync/history', { method: 'POST', body, lane: 'simkl_post' });
  return res.json().catch(() => ({}));
}

// Plan-to-watch list for one media KIND ('movie' | 'series'), normalised to the
// watched-store item shape ({ tmdb_id, imdb_id, title, year, ... }). This is the
// v6 backing for the "Watch Later" catalog (replaces the Trakt watchlist).
// Series pulls BOTH the 'shows' and 'anime' Simkl sections, since Simkl files
// anime separately.
async function getPlanToWatch(profile, kind) {
  const sections = kind === 'movie' ? ['movies'] : ['shows', 'anime'];
  const out = [];
  for (const section of sections) {
    const items = await getAllItems(profile, section, { status: 'plantowatch' });
    out.push(...parseWatchedItems(items, section));
  }
  return out;
}

// ---- plan-to-watch WRITE (v6, Mobile Companion "add to watchlist") ----
// PURE: build the /sync/add-to-list body from watchlist item(s). Each becomes
// { to, ids:{ imdb?, tmdb? } }, filed under movies or shows by media kind; an
// item with no usable id is skipped. Exported for tests. `to` defaults to
// 'plantowatch' (the Watch Later list this app writes to).
function buildAddToListBody(items, to = 'plantowatch') {
  const movies = [];
  const shows = [];
  for (const it of Array.isArray(items) ? items : [items]) {
    if (!it) continue;
    const ids = {};
    if (it.imdb_id) ids.imdb = String(it.imdb_id);
    if (it.tmdb_id != null && it.tmdb_id !== '') ids.tmdb = String(it.tmdb_id);
    if (!ids.imdb && !ids.tmdb) continue; // need at least one id for Simkl to match
    (it.type === 'series' ? shows : movies).push({ to, ids });
  }
  return { movies, shows };
}

// Add title(s) to the profile's Simkl plan-to-watch list. Rate-governed at the
// hard 1-POST/s Simkl write cap, exactly like addToHistory. Simkl de-dupes
// re-adds, so a double-tap is harmless. Requires the profile's Simkl connection.
async function addToPlanToWatch(profile, items) {
  const body = buildAddToListBody(items, 'plantowatch');
  if (!body.movies.length && !body.shows.length) return { skipped: true, added: {} };
  const res = await simklFetch(profile, '/sync/add-to-list', { method: 'POST', body, lane: 'simkl_post' });
  return res.json().catch(() => ({}));
}

// ---- plan-to-watch REMOVE (v7 MW-04, Mobile Companion / portal "remove from
// Watch Later") ----
// The inverse of addToPlanToWatch. Plain list management — NOT a "not
// interested" suppression: it writes nothing to dont_recommend, so a removed
// title can still appear in AI recs and other catalogs (that's the point).
//
// ENDPOINT — verified against the Simkl API spec (github.com/SIMKL/API,
// apiary.apib § "Remove Items from History and from Lists"): POST
// /sync/history/remove removes the item from history AND from the user's lists —
// "If [no] seasons [are] skipped too then the show will be removed completely."
// Passing a whole movie/show with NO seasons therefore removes it from
// plan-to-watch. Body shape matches /sync/history: { movies:[{ids}], shows:[{ids}] }.
// BUILD-TIME GATE (MW-05 I3): still confirm live against a real plan-to-watch
// item (removing a title that is ONLY on plan-to-watch, never in history) before
// relying on it in production — the offline suite stubs the write.
//
// PURE: build the /sync/history/remove body for watchlist item(s). A movie →
// movies:[{ids}]; a series → shows:[{ids}] with NO seasons (remove the whole
// show). An item with no usable id is skipped. Exported for tests.
function buildRemoveFromListBody(items) {
  const movies = [];
  const shows = [];
  for (const it of Array.isArray(items) ? items : [items]) {
    if (!it) continue;
    const ids = {};
    if (it.imdb_id) ids.imdb = String(it.imdb_id);
    if (it.tmdb_id != null && it.tmdb_id !== '') ids.tmdb = String(it.tmdb_id);
    if (!ids.imdb && !ids.tmdb) continue; // need at least one id for Simkl to match
    (it.type === 'series' ? shows : movies).push({ ids });
  }
  return { movies, shows };
}

// Remove title(s) from the profile's Simkl plan-to-watch list. Rate-governed at
// the hard 1-POST/s write cap (same simkl_post lane as the add/history writes).
// De-dupe-safe: removing something already gone is a harmless no-op. Requires the
// profile's Simkl connection; a rejected token maps to the reconnect message.
async function removeFromPlanToWatch(profile, items) {
  const body = buildRemoveFromListBody(items);
  if (!body.movies.length && !body.shows.length) return { skipped: true };
  const res = await simklFetch(profile, '/sync/history/remove', { method: 'POST', body, lane: 'simkl_post' });
  return res.json().catch(() => ({}));
}

module.exports = {
  startPinFlow,
  pollPin,
  checkConnection,
  manualCheck,
  accountName,
  resolveAuth,
  simklFetch,
  refreshV2,
  authedGet,
  getActivities,
  getRatings,
  parseRatings,
  buildRatingsBody,
  setRatings,
  removeRatings,
  removeFromHistory,
  getMovieSummary,
  parseMovieSummary,
  getAllItems,
  getRecentWatched,
  getPlanToWatch,
  addToHistory,
  buildAddToListBody,
  addToPlanToWatch,
  buildRemoveFromListBody,
  removeFromPlanToWatch,
  parseWatchedItem,
  parseWatchedItems,
  parseSeriesProgress,
  parseSeriesProgressItems,
  BULK_GAP_MS,
  withParams,
  USER_AGENT,
  APP_NAME,
};
