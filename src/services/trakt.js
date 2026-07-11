// Trakt: OAuth device flow per profile + /sync endpoints.
// One Trakt API app per profile (client ID/secret stored on the profile).
const config = require('../config');

const API = 'https://api.trakt.tv';

// Node's built-in fetch sends NO User-Agent by default; Trakt (behind
// Cloudflare) rejects UA-less requests with 403. Always send a real one,
// and send the trakt-api-key/version headers on every call including OAuth,
// per Trakt's API docs.
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';

function baseHeaders(clientId) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  };
}

function headers(profile, withAuth = true) {
  const h = baseHeaders(profile.keys.trakt_client_id);
  if (withAuth && profile.trakt_auth?.access_token) {
    h.Authorization = `Bearer ${profile.trakt_auth.access_token}`;
  }
  return h;
}

// ---- Device flow ----
async function startDeviceFlow(profile) {
  console.log(`[trakt] ${profile.name}: requesting device code (client_id ${profile.keys.trakt_client_id.slice(0, 8)}…)`);
  const res = await fetch(`${API}/oauth/device/code`, {
    method: 'POST',
    headers: baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({ client_id: profile.keys.trakt_client_id }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[trakt] ${profile.name}: device code failed ${res.status}${body ? ` — response: ${body}` : ''}`);
    const hint = res.status === 403
      ? ' (403 = Trakt does not recognize this Client ID — re-copy it from your Trakt app page)'
      : ' — check the Client ID';
    throw new Error(`Trakt device code failed (${res.status})${body ? `: ${body}` : ''}${hint}`);
  }
  const dc = await res.json();
  console.log(`[trakt] ${profile.name}: device code issued, user code ${dc.user_code}, expires in ${dc.expires_in}s`);
  return dc; // { device_code, user_code, verification_url, expires_in, interval }
}

async function pollDeviceToken(profile, deviceCode) {
  const res = await fetch(`${API}/oauth/device/token`, {
    method: 'POST',
    headers: baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({
      code: deviceCode,
      client_id: profile.keys.trakt_client_id,
      client_secret: profile.keys.trakt_client_secret,
    }),
  });
  if (res.status === 400) return { pending: true }; // user hasn't approved yet
  if (res.status === 409) return { pending: true }; // already polled too fast
  if (res.status === 404) return { error: 'Invalid device code (expired?)' };
  if (res.status === 410) return { error: 'Code expired — start again' };
  if (res.status === 418) return { error: 'User denied the authorization' };
  if (res.status === 403) return { error: 'Trakt rejected the Client Secret (403) — re-copy it from your Trakt app page' };
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`[trakt] ${profile.name}: token poll failed ${res.status}${body ? ` — ${body}` : ''}`);
    return { error: `Trakt token poll failed (${res.status})${body ? `: ${body}` : ''}` };
  }
  const tok = await res.json();
  console.log(`[trakt] ${profile.name}: authorization complete, token expires ${new Date(Date.now() + (tok.expires_in || 7776000) * 1000).toISOString()}`);
  return {
    token: {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 7776000) * 1000,
    },
  };
}

// ---- Token refresh ----
// Trakt rotates refresh tokens: each one is single-use. Two concurrent
// requests both deciding to refresh would race, and the loser's attempt
// (with the now-consumed old token) can invalidate the profile's auth.
// Serialize per profile: concurrent callers share one in-flight refresh.
const refreshing = new Map(); // profile.id -> Promise<trakt_auth>

async function refreshToken(profile) {
  let inflight = refreshing.get(profile.id);
  if (!inflight) {
    inflight = doRefreshToken(profile).finally(() => refreshing.delete(profile.id));
    refreshing.set(profile.id, inflight);
  }
  const trakt_auth = await inflight;
  profile.trakt_auth = trakt_auth; // update this caller's profile object too
  return trakt_auth;
}

async function doRefreshToken(profile) {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({
      refresh_token: profile.trakt_auth.refresh_token,
      client_id: profile.keys.trakt_client_id,
      client_secret: profile.keys.trakt_client_secret,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`[trakt] ${profile.name}: token refresh failed ${res.status}${body ? ` — ${body}` : ''}`);
    throw new Error(`Trakt token refresh failed (${res.status}) — profile may need re-authorization`);
  }
  console.log(`[trakt] ${profile.name}: token refreshed`);
  const tok = await res.json();
  const trakt_auth = {
    ...profile.trakt_auth, // keep username and any other recorded fields
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 7776000) * 1000,
  };
  config.updateProfile(profile.id, { trakt_auth });
  return trakt_auth;
}

// Authorized GET returning the raw Response (headers intact — pagination reads
// the X-Pagination-* headers). Proactive refresh within 24h of expiry, plus one
// reactive refresh + retry on a server-side 401.
async function authedFetch(profile, urlPath, options = {}) {
  if (!profile.trakt_auth?.access_token) {
    throw new Error('Trakt not authorized for this profile');
  }
  // Proactive refresh if within 24h of expiry
  if (profile.trakt_auth.expires_at && profile.trakt_auth.expires_at - Date.now() < 24 * 3600e3) {
    await refreshToken(profile);
  }
  // headers(profile) is recomputed per attempt so the retry picks up the
  // refreshed token.
  const send = () => fetch(`${API}${urlPath}`, { ...options, headers: headers(profile) });
  let res = await send();
  if (res.status === 401) {
    // Token invalidated server-side — try one refresh, then re-request
    await refreshToken(profile);
    res = await send();
  }
  return res;
}

async function authedGet(profile, urlPath) {
  const res = await authedFetch(profile, urlPath);
  if (!res.ok) throw new Error(`Trakt GET ${urlPath} failed (${res.status})`);
  return res.json();
}

// Fetch EVERY page of a paginated Trakt endpoint and concatenate the items.
// Trakt made /sync/watched/* pagination-mandatory on 2026-07-03: with no
// params the response is now capped at the first 100 items, so an account with
// more than 100 watched titles was silently truncated — watched titles beyond
// the first page leaked back into recommendations. Walk pages until the last
// one. limit=250 is Trakt's max for these endpoints. The stop condition is the
// X-Pagination-Page-Count header, NOT a short page: Trakt warns a page may hold
// fewer than the requested limit depending on `extended`, so a short page is
// not a reliable end-of-list signal.
const PAGE_LIMIT = 250;

async function authedGetAll(profile, urlPath) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const all = [];
  let page = 1;
  let pageCount = 1;
  do {
    const res = await authedFetch(profile, `${urlPath}${sep}page=${page}&limit=${PAGE_LIMIT}`);
    if (!res.ok) throw new Error(`Trakt GET ${urlPath} failed (${res.status})`);
    const items = await res.json();
    if (Array.isArray(items)) all.push(...items);
    pageCount = parseInt(res.headers.get('x-pagination-page-count') || '1', 10) || 1;
    page += 1;
  } while (page <= pageCount);
  return all;
}

// Which Trakt account does this profile's token actually belong to?
// Surfaced in the portal so a profile authorized against the wrong family
// member's account is immediately visible.
async function getAccountUsername(profile) {
  const data = await authedGet(profile, '/users/settings');
  return data?.user?.username || null;
}

// ---- Change detection ----
// One cheap call that says when anything was last watched — lets callers
// skip downloading the full watched lists (which grow with history) when
// nothing has changed. Show watched-state derives from episode plays, so
// `episodes.watched_at` is the signal for series.
async function getLastActivities(profile) {
  const data = await authedGet(profile, '/sync/last_activities');
  return {
    movies: data?.movies?.watched_at || null,
    episodes: data?.episodes?.watched_at || null,
  };
}

// ---- Exclusion + taste: full watched state (canonical IDs + recency) ----
// A show with ANY watched history is excluded, even if only partially watched.
// `recent` (the N most recently watched titles) doubles as the taste seed.
// It is derived from the watched list rather than /sync/history because a
// fixed-size play window collapses to 2-3 unique shows for a binge watcher —
// which used to misclassify heavy accounts as cold-start.
const HISTORY_SEED_COUNT = 10;

function parseWatchedItems(items, type) {
  const imdbIds = new Set();
  const tmdbIds = new Set();
  const withDates = [];
  for (const item of items) {
    const media = type === 'series' ? item.show : item.movie;
    if (!media?.ids) continue;
    if (media.ids.imdb) imdbIds.add(media.ids.imdb);
    if (media.ids.tmdb) tmdbIds.add(media.ids.tmdb);
    withDates.push({ title: media.title, year: media.year, watched_at: item.last_watched_at || '' });
  }
  const recent = withDates
    .sort((a, b) => (a.watched_at < b.watched_at ? 1 : -1)) // ISO-8601 sorts lexically
    .slice(0, HISTORY_SEED_COUNT)
    .map(({ title, year }) => ({ title, year }));
  return { imdbIds, tmdbIds, recent };
}

// ---- Auto-scrobble support: read current history, push a delta ----
// The scrobble sync needs Trakt's existing state to avoid re-adding plays.
// Movies: the set of watched IMDb ids. Episodes: keys "imdb:season:episode"
// (needs extended=progress — the season/episode matrix is no longer returned
// by default since Trakt's 2026-07 change).
async function getWatchedMovieImdbIds(profile) {
  const items = await authedGetAll(profile, '/sync/watched/movies');
  const ids = new Set();
  for (const w of items) if (w.movie?.ids?.imdb) ids.add(w.movie.ids.imdb);
  return ids;
}

async function getWatchedEpisodeKeys(profile) {
  const items = await authedGetAll(profile, '/sync/watched/shows?extended=progress');
  const keys = new Set();
  for (const w of items) {
    const imdb = w.show?.ids?.imdb;
    if (!imdb) continue;
    for (const s of w.seasons || []) {
      for (const e of s.episodes || []) keys.add(`${imdb}:${s.number}:${e.number}`);
    }
  }
  return keys;
}

// Add plays to history. body = { movies: [...], shows: [...] } in Trakt's
// /sync/history shape. Returns the parsed response (added/not_found counts).
async function addToHistory(profile, body) {
  const res = await authedFetch(profile, '/sync/history', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Trakt add-to-history failed (${res.status})${text ? `: ${text}` : ''}`);
  }
  return res.json();
}

async function getWatchedSets(profile, type) {
  // noseasons: without it, every show arrives with its full season/episode
  // play matrix — megabytes for a large account, none of it used here.
  // Paginated: /sync/watched/* returns only the first 100 items unpaged since
  // Trakt's 2026-07-03 change, so walk every page to get the complete list —
  // the exclusion sets must cover the ENTIRE watch history, not just page one.
  const endpoint = type === 'series' ? 'shows?extended=noseasons' : 'movies';
  const items = await authedGetAll(profile, `/sync/watched/${endpoint}`);
  return parseWatchedItems(items, type);
}

module.exports = {
  startDeviceFlow,
  pollDeviceToken,
  refreshToken,
  getWatchedSets,
  parseWatchedItems,
  getLastActivities,
  getAccountUsername,
  getWatchedMovieImdbIds,
  getWatchedEpisodeKeys,
  addToHistory,
  baseHeaders,
  USER_AGENT,
};
