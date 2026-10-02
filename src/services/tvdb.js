// TVDB v4 (AGE-1): country-specific certifications for the TV-14 decision chain.
//
// TMDB's per-country ratings (AU/US/GB/IE/NZ/CA) are the primary source in the
// chain; TVDB is the fallback for whatever TMDB didn't answer. This client
// resolves a batch of IMDb ids to their TVDB country certifications.
//
// The API key is read ONLY here (A6): Server Config (settings.keys.tvdb_api_key)
// first, then process.env.TVDB_API_KEY. No real key is ever in code, tests,
// fixtures, docs or .env.example (the repo is public).
//
// TVDB v4 auth is a login token, not the raw key: POST /v4/login with the key
// returns a short-lived token that every data call sends as `Authorization:
// Bearer <token>`. The token is cached in memory for 25 days; a 401 from a data
// GET triggers exactly one re-login + retry. (Live-verified 2 Oct.)
const governor = require('./governor');
const settings = require('../settings');
const API = 'https://api4.thetvdb.com/v4';
const TOKEN_TTL_MS = 25 * 24 * 3600e3; // 25 days
const REQUEST_TIMEOUT_MS = 8000;       // 8 s per request

// The fetch seam. Defaults to the global fetch; a fetch-level test (T2) replaces
// it via `setTvdbFetch` so it is isolated from the other AGE-1 async tests (which
// run in parallel and stub the global fetch for other services).
let tvdbFetch = global.fetch;
function setTvdbFetch(fn) { tvdbFetch = fn; }

// The effective TVDB key: Server Config first, then the process env (A6: the
// env fallback is read ONLY in this module).
function tvdbKey() {
  const s = settings.getSettings();
  return (s?.keys?.tvdb_api_key || process.env.TVDB_API_KEY || '').trim();
}

// In-memory token cache (module-level, shared across calls). A failed or
// expired login leaves it empty; `clearToken` resets it (used by tests).
let token = null;
let tokenAt = 0;
function clearToken() { token = null; tokenAt = 0; }

// One governed POST (JSON body). Returns the fetch Response (the caller checks
// .ok / .status — a 401 is handled by the caller, not thrown here).
async function post(endpoint, body) {
  const url = new URL(`${API}/${endpoint}`);
  return governor.schedule('tvdb', () => tvdbFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
}

// One governed GET. `tokenValue` is the bearer token (NOT the key); `endpoint`
// is relative to /v4. Returns the fetch Response.
async function get(tokenValue, endpoint, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return governor.schedule('tvdb', () => tvdbFetch(url, {
    headers: { Authorization: `Bearer ${tokenValue}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
}

// POST /v4/login with the key → { data: { token } }. Caches the token; returns
// null on a failed login (bad key, network error) so the caller degrades to
// "no answer" rather than throwing.
async function login(key) {
  try {
    const res = await post('login', { apikey: key });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const t = data?.data?.token;
    if (!t) return null;
    token = t;
    tokenAt = Date.now();
    return t;
  } catch {
    return null;
  }
}

// Return a valid token: the cached one if still within the 25-day TTL, else a
// fresh login. Never throws — a failed login returns null.
async function ensureToken(key) {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  return login(key);
}

// TVDB reports country codes as three-letter lowercase (usa/aus/gbr/irl/nzl/
// can/fra/…); the decision chain reads the six-letter set. Map the six the
// chain reads; anything else is dropped.
const TVDB_COUNTRY = { aus: 'aus', usa: 'usa', gbr: 'gbr', irl: 'irl', nzl: 'nzl', can: 'can' };

// Resolve a batch of IMDb ids to their TVDB country certifications. Returns
// Map<imdb, { aus, usa, gbr, irl, nzl, can }> (lowercase three-letter chain
// codes). A title with no TVDB match or no ratings gets an empty object.
// `type` ('movie' | 'series') is accepted for seam consistency; the match's own
// type selects the entity endpoint. A per-title failure yields an empty object
// (no answer from this step — the chain continues), never a throw.
async function mediaCerts(imdbIds, type, log = console) {
  const key = tvdbKey();
  if (!key) { log?.warn?.('[tvdb] no TVDB API key — no ratings'); return new Map(); }
  const out = new Map();
  let tok = await ensureToken(key);
  if (!tok) {
    log?.warn?.('[tvdb] TVDB login failed — no ratings for this batch');
    for (const imdb of imdbIds) out.set(imdb, {});
    return out;
  }
  for (const imdb of imdbIds) {
    try {
      // Resolve the IMDb id to a TVDB id. A 401 on a data GET means the token
      // expired — re-login once and retry.
      let search = await get(tok, `search/remoteid/${imdb}`);
      if (search.status === 401) {
        tok = await login(key);
        if (!tok) { out.set(imdb, {}); continue; }
        search = await get(tok, `search/remoteid/${imdb}`);
      }
      if (!search.ok) throw new Error(`TVDB search/remoteid/${imdb} failed (${search.status})`);
      const matches = (await search.json()).data || [];
      const series = matches.find((m) => m.series);
      const movie = matches.find((m) => m.movie);
      if (!series && !movie) { out.set(imdb, {}); continue; }
      const entity = series ? `series/${series.series.id}` : `movies/${movie.movie.id}`;
      let ext = await get(tok, `${entity}/extended`, { short: 'true' });
      if (ext.status === 401) {
        tok = await login(key);
        if (!tok) { out.set(imdb, {}); continue; }
        ext = await get(tok, `${entity}/extended`, { short: 'true' });
      }
      if (!ext.ok) throw new Error(`TVDB ${entity}/extended failed (${ext.status})`);
      const ratings = (await ext.json()).data?.contentRatings || [];
      const cert = {};
      for (const r of ratings) {
        const code = TVDB_COUNTRY[String(r.country || '').toLowerCase()];
        if (code) cert[code] = r.name;
      }
      out.set(imdb, cert);
    } catch (err) {
      log?.warn?.(`[tvdb] ${imdb} failed: ${err.message}`);
      out.set(imdb, {});
    }
  }
  return out;
}

module.exports = { mediaCerts, tvdbKey, get, post, login, ensureToken, setTvdbFetch, clearToken };
