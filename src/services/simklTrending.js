// Simkl trending cache (Glass GE-02) — the breadth + velocity source for the
// Glass engine's candidate strategies C–G and its trending-momentum feature.
//
// SOURCE (GD-1, resolved 2026-09-10): Simkl's PUBLIC trending CDN — a static
// JSON file on data.simkl.in, NOT the authed api.simkl.com. Consequences that
// shape this module:
//   • No user OAuth, no profile Simkl connection, no per-profile token. It is
//     fetched ONCE, SERVER-WIDE, and cached — it never touches a profile's
//     rate-limited 10-GET/s Simkl budget (its own governor lane, `simkl_cdn`).
//   • The COMBINED `week_500.json` carries {movies, tv, anime} in one response —
//     one round-trip per refresh. `week` (last 7 days) is REGENERATED DAILY by
//     Simkl, so the cache TTL is ~24h (a weekly cache would serve up to 6-day-
//     stale data for no saving). The `today`/hourly file is unnecessary: every
//     item already exposes `watched` (24h viewers = velocity) + `drop_rate`
//     (momentum direction), so momentum comes straight from the file — GD-3 (a
//     popularity time-series) is not needed.
//   • Every item carries ids.{tmdb,imdb,simkl,…} (anime also mal/anidb/anilist),
//     so candidates resolve cleanly into the TMDB-keyed pool and anime keeps the
//     ids the shared anime age-band needs.
//
// THREE-WAY cache in Simkl's native split (movies / tv / anime), persisted in a
// small DB table so a restart serves the last good copy instead of refetching,
// and so a CDN outage degrades to stale-but-usable data (graceful degradation is
// a first-class rule). Candidate generation (GE-05) maps the 3 lists onto the
// engine's two types: movie ← movies; series ← tv ∪ anime.
//
// This module is a self-contained DATA LAYER: fetch + parse + cache. It does no
// scoring and knows nothing about a profile. Verified-live wiring (the exact CDN
// path + item shape) is confirmed against the real endpoint in a live-verify
// gate, mirroring the Simkl I2/I3 pattern; the parse here is deliberately
// TOLERANT so a shape surprise degrades to "fewer fields" rather than a crash.
const db = require('../db');
const governor = require('./governor');

const DAY_MS = 24 * 3600e3;
// Combined week file: {movies, tv, anime} in one response. `_500` gives enough
// depth for client-side genre filtering (there is no genre query param).
const CDN_BASE = process.env.SIMKL_CDN_BASE || 'https://data.simkl.in/discover/trending';
const COMBINED_WEEK_URL = `${CDN_BASE}/week_500.json`;
const REFRESH_TTL_MS = 24 * 3600e3;         // week file regenerates daily
const APP_NAME = 'AI-Recommender';
const APP_VERSION = require('../../package.json').version;

const LIST_TYPES = ['movies', 'tv', 'anime'];

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS simkl_trending (
      list_type  TEXT PRIMARY KEY,   -- 'movies' | 'tv' | 'anime'
      items      TEXT,               -- JSON array of normalized trending items
      count      INTEGER,
      fetched_at INTEGER
    );
  `);
  ready = true;
}

// A number, or null. Simkl ratings/counts arrive as numbers or numeric strings.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A percentage field, as a number. Verified live 2026-09-10: Simkl sends
// `drop_rate` as a STRING like "0.5%" (always positive; range ~0.1–20; low =
// sticky/rising, high = falling). parseFloat strips the trailing % → 0.5.
function pct(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Pull one rating source ({rating, votes}) out of an item's `ratings` block,
// tolerant of the two shapes seen in the wild: nested (`ratings.imdb.rating`)
// or flat (`ratings.imdb`). Returns { rating, votes } with nulls for absent.
function pickRating(ratings, source) {
  if (!ratings || typeof ratings !== 'object') return { rating: null, votes: null };
  const r = ratings[source];
  if (r == null) return { rating: null, votes: null };
  if (typeof r === 'object') return { rating: num(r.rating), votes: num(r.votes ?? r.votes_count ?? r.count) };
  return { rating: num(r), votes: null };
}

// The four-digit release year from a release_date/year field, or null. Verified
// live 2026-09-10: Simkl `release_date` is "MM/DD/YYYY" (e.g. "09/03/2026"), NOT
// ISO — so find the 19xx/20xx run rather than slicing the first four chars.
function yearOf(item) {
  const y0 = num(item.year);
  if (y0 && y0 > 1800) return y0;
  const d = item.release_date || item.first_aired || item.date || null;
  const m = d ? String(d).match(/(19|20)\d{2}/) : null;
  return m ? parseInt(m[0], 10) : null;
}

// PURE: normalize ONE raw CDN item into the field set Glass scores on, all with
// ZERO extra network calls (the whole point of the CDN source). `listType` is
// the Simkl section it came from ('movies'|'tv'|'anime') — kept so the caller
// can map anime→series and preserve the anime age band. An item with no usable
// tmdb id is unresolvable into the TMDB-keyed pool → returned as null (dropped).
// Exported for tests.
function parseTrendingItem(raw, listType) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = raw.ids || raw.id || {};
  const tmdb = ids.tmdb ?? raw.tmdb ?? null;
  if (tmdb == null || tmdb === '') return null;             // no tmdb id → unresolvable
  const imdb = ids.imdb ?? raw.imdb ?? null;
  const simkl = ids.simkl ?? ids.simkl_id ?? raw.simkl_id ?? null;
  // Genres arrive with duplicates in the wild (["Action","Action",…]) — dedupe.
  const genres = Array.isArray(raw.genres) ? [...new Set(raw.genres.filter(Boolean).map(String))] : [];
  return {
    list_type: listType,
    tmdb_id: String(tmdb),
    imdb_id: imdb ? String(imdb) : null,
    simkl_id: simkl != null ? Number(simkl) : null,
    // Anime cross-ids the shared anime band / animeMap can key on.
    mal: ids.mal != null ? Number(ids.mal) : null,
    anidb: ids.anidb != null ? Number(ids.anidb) : null,
    anilist: ids.anilist != null ? Number(ids.anilist) : null,
    title: raw.title || raw.name || null,
    year: yearOf(raw),
    genres,
    release_date: raw.release_date || raw.first_aired || null,
    runtime: num(raw.runtime),
    country: raw.country || null,
    original_language: raw.original_language || raw.lang || null,
    // Velocity + momentum, straight from the file (no time-series needed).
    watched: num(raw.watched ?? raw.watched_24h ?? raw.plays),   // recent viewers (velocity)
    drop_rate: pct(raw.drop_rate),                               // % decline (momentum; low = sticky)
    rank: num(raw.rank),
    // Quality, in-file (also resolves the P4 quality-source cleanly downstream).
    ratings: {
      imdb: pickRating(raw.ratings, 'imdb'),
      simkl: pickRating(raw.ratings, 'simkl'),
      mal: pickRating(raw.ratings, 'mal'),
    },
  };
}

// PURE: normalize a raw list (array) for one section. Drops unparseable/tmdb-less
// items. Exported for tests.
function parseTrendingList(rawList, listType) {
  return (Array.isArray(rawList) ? rawList : [])
    .map((r) => parseTrendingItem(r, listType))
    .filter(Boolean);
}

// PURE: split the combined `week_500` response ({movies, tv, anime}) into the
// three normalized lists. Tolerant of a section being absent. Exported for tests.
function parseCombined(json) {
  const src = json && typeof json === 'object' ? json : {};
  return {
    movies: parseTrendingList(src.movies, 'movies'),
    tv: parseTrendingList(src.tv || src.shows, 'tv'),
    anime: parseTrendingList(src.anime, 'anime'),
  };
}

// The default network fetch of the combined week file. Governed on the dedicated
// `simkl_cdn` lane (never the authed api.simkl.com lanes). App params match the
// simkl.js convention; no client_id/token — this is a public static file.
async function fetchCombined() {
  const url = new URL(COMBINED_WEEK_URL);
  url.searchParams.set('app-name', APP_NAME);
  url.searchParams.set('app-version', APP_VERSION);
  const res = await governor.schedule('simkl_cdn', () => fetch(url, {
    headers: { 'User-Agent': require('./simkl').USER_AGENT, Accept: 'application/json' },
  }));
  if (!res.ok) throw new Error(`Simkl trending CDN failed (${res.status})`);
  return res.json();
}

function upsertList(listType, items, at = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO simkl_trending (list_type, items, count, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(list_type) DO UPDATE SET items = excluded.items, count = excluded.count, fetched_at = excluded.fetched_at
  `).run(listType, JSON.stringify(items), items.length, at);
}

// Fetch + parse + store the combined week file (all three lists). `fetcher` is
// injectable for tests (defaults to the live CDN fetch). GRACEFUL DEGRADATION:
// on any failure the existing cached rows are LEFT UNTOUCHED (stale-but-usable)
// and the error is returned, never thrown — a CDN outage must never fail a Glass
// build, only narrow its candidate breadth. Returns { ok, counts, error? }.
async function refresh({ fetcher = fetchCombined, now = Date.now(), log = console } = {}) {
  init();
  let json;
  try {
    json = await fetcher();
  } catch (err) {
    log.warn(`[glass] trending refresh failed: ${err.message} — keeping last cached lists`);
    return { ok: false, error: err.message, counts: currentCounts() };
  }
  const lists = parseCombined(json);
  const counts = {};
  for (const lt of LIST_TYPES) { upsertList(lt, lists[lt], now); counts[lt] = lists[lt].length; }
  log.log(`[glass] trending refreshed — movies ${counts.movies}, tv ${counts.tv}, anime ${counts.anime}`);
  return { ok: true, counts };
}

function currentCounts() {
  init();
  const out = {};
  for (const lt of LIST_TYPES) {
    out[lt] = db.get().prepare('SELECT count FROM simkl_trending WHERE list_type = ?').get(lt)?.count || 0;
  }
  return out;
}

// The cached, normalized items for one Simkl section. Returns [] when never
// fetched. `maxAgeMs` (default: no limit) lets a caller reject stale data
// explicitly; Glass generation tolerates stale (breadth is a bonus, not a gate).
function getList(listType, { maxAgeMs = Infinity, now = Date.now() } = {}) {
  init();
  const row = db.get().prepare('SELECT items, fetched_at FROM simkl_trending WHERE list_type = ?').get(listType);
  if (!row || !row.items) return [];
  if (Number.isFinite(maxAgeMs) && row.fetched_at && (now - row.fetched_at) > maxAgeMs) return [];
  try { return JSON.parse(row.items); } catch { return []; }
}

// When was any list last fetched? 0 = never. Drives ensureFresh's TTL check.
function newestFetchedAt() {
  init();
  const row = db.get().prepare('SELECT MAX(fetched_at) AS m FROM simkl_trending').get();
  return row?.m || 0;
}

// Refresh only when the cache is older than the TTL (or empty). The Glass build
// calls this once per run; a same-day second build reuses the cached lists. A
// failed refresh degrades to stale (refresh() never throws). Returns the refresh
// result, or { ok:true, skipped:'fresh' } when nothing was due.
async function ensureFresh({ ttlMs = REFRESH_TTL_MS, now = Date.now(), fetcher, log = console } = {}) {
  init();
  const age = now - newestFetchedAt();
  if (newestFetchedAt() && age < ttlMs) return { ok: true, skipped: 'fresh', counts: currentCounts() };
  return refresh({ fetcher, now, log });
}

module.exports = {
  init,
  parseTrendingItem,
  parseTrendingList,
  parseCombined,
  refresh,
  ensureFresh,
  getList,
  upsertList,
  newestFetchedAt,
  currentCounts,
  COMBINED_WEEK_URL,
  REFRESH_TTL_MS,
  LIST_TYPES,
};
