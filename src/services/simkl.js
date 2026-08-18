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
      const username = await accountName(clientId, accessToken).catch(() => null);
      return { valid: true, username };
    }
    if (res.status === 401 || res.status === 403) return { valid: false, reason: 'token rejected — reconnect' };
    return { valid: false, reason: `Simkl returned ${res.status}` };
  } catch (err) {
    return { valid: false, reason: `Simkl unreachable: ${err.message}` };
  }
}

// Best-effort account name for the status line. Non-fatal if it fails.
async function accountName(clientId, accessToken) {
  const res = await fetch(withParams(clientId, '/users/settings'), { headers: headers(accessToken) });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.user?.name || data?.user?.username || null;
}

// ---- watched-history read (v6) ----
// Verified live against the real API (account "James", 2026-08-18): activities
// returns per-type change timestamps; all-items/{type}/completed returns items
// carrying imdb+tmdb ids and last_watched_at inline (genres/cert are NOT
// included — enriched at ingest, see the watched store).

async function authedGet(profile, path, extra = {}) {
  const clientId = profile.keys.simkl_client_id;
  const token = profile.simkl_auth?.access_token;
  if (!clientId || !token) throw new Error('Simkl is not connected for this profile');
  const res = await fetch(withParams(clientId, path, extra), { headers: headers(token) });
  if (res.status === 401 || res.status === 403) throw new Error('Simkl token rejected — reconnect the account');
  if (!res.ok) throw new Error(`Simkl GET ${path} failed (${res.status})`);
  return res.json();
}

// The cheap "what changed" call. Returns { all, movies, tv_shows, anime, ... }
// ISO timestamps. Compare against the saved value before pulling all-items —
// mandatory per Simkl's rules (docs/v6-plan §6b).
async function getActivities(profile) {
  return authedGet(profile, '/sync/activities');
}

// Full/delta watched read for one type ('movies' | 'shows' | 'anime'), status
// 'completed'. Pass dateFrom (ISO) for Phase-2 delta syncs; omit for the
// Phase-1 initial pull. Always sequential per type (Simkl asks not to hammer).
async function getAllItems(profile, type, { status = 'completed', dateFrom } = {}) {
  const extra = dateFrom ? { date_from: dateFrom } : {};
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

// ---- watched-history write (v6, auto-scrobble destination) ----
// POST missing watched items to Simkl's history. The body shape matches what
// scrobble.computeDelta already builds:
//   { movies: [{ ids:{imdb}, watched_at? }],
//     shows:  [{ ids:{imdb}, seasons:[{ number, episodes:[{ number, watched_at? }] }] }] }
// Simkl de-dupes re-marks, so an over-broad push is harmless.
async function addToHistory(profile, body) {
  const clientId = profile.keys.simkl_client_id;
  const token = profile.simkl_auth?.access_token;
  if (!clientId || !token) throw new Error('Simkl is not connected for this profile');
  const res = await fetch(withParams(clientId, '/sync/history'), {
    method: 'POST', headers: headers(token), body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Simkl token rejected — reconnect the account');
  if (!res.ok) throw new Error(`Simkl POST /sync/history failed (${res.status})`);
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

module.exports = {
  startPinFlow,
  pollPin,
  checkConnection,
  accountName,
  authedGet,
  getActivities,
  getAllItems,
  getPlanToWatch,
  addToHistory,
  parseWatchedItem,
  parseWatchedItems,
  withParams,
  USER_AGENT,
  APP_NAME,
};
