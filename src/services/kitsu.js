// AGE-3a: the Kitsu age-rating client. One request per MAL id through the
// governor's 'kitsu' lane. Kitsu's edge API maps a MAL anime to its age rating
// (G/PG/R/R18) and guide. Cache-only after the first fetch (30-day rating,
// 7-day no-rating). A 429 or ≥500 stops the batch (partial result, no throw).
const db = require('../db');
const governor = require('./governor');

const API = 'https://kitsu.io/api/edge/mappings';
const TIMEOUT_MS = 15000; // 15s timeout
const RATING_TTL_MS = 30 * 86400e3; // 30-day cache for a rating
const NO_RATING_TTL_MS = 7 * 86400e3; // 7-day cache for "no rating"
const LOOKUP_CAP = 40; // at most 40 network lookups per call

// Fetch seam: tests stub fetch through this.
let fetchImpl = global.fetch;
function _setFetch(fn) { fetchImpl = fn; }

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS kitsu_ratings (
      mal_id TEXT PRIMARY KEY,
      rating TEXT,
      guide  TEXT,
      at     INTEGER NOT NULL
    );
  `);
  ready = true;
}

// One request per MAL id → { rating, guide } | null (no mapping). A 429 or
// ≥500 throws with `status` set (the batch stops); any other failure throws
// without a status (a per-id skip).
async function fetchOne(malId) {
  const params = new URLSearchParams({
    'filter[externalSite]': 'myanimelist/anime',
    'filter[externalId]': String(malId),
    'include': 'item',
    'fields[anime]': 'ageRating,ageRatingGuide,canonicalTitle',
  });
  const url = `${API}?${params.toString()}`;
  const res = await governor.schedule('kitsu', () => fetchImpl(url, {
    headers: { Accept: 'application/vnd.api+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (res.status === 429 || res.status >= 500) {
    const err = new Error(`Kitsu mappings failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Kitsu mappings failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  // An empty `data` or missing `included` means "no mapping" (cached as no rating).
  if (!body.data || body.data.length === 0) return null;
  const attrs = body.included && body.included[0] && body.included[0].attributes;
  if (!attrs || !attrs.ageRating) return null;
  return { rating: attrs.ageRating, guide: attrs.ageRatingGuide || null };
}

// Ratings for many MAL ids. Returns Map<malId(string), { rating, guide }> —
// only ids with a rating are present. Cache-first (30-day rating, 7-day
// no-rating); only uncached ids are fetched, capped at 40 per call. A 429 or
// ≥500 stops the batch (partial result, no throw, the failure is not cached).
// A per-id network error skips that id (not cached).
async function ageRatings(malIds, log = console) {
  init();
  const out = new Map();
  const now = Date.now();
  const conn = db.get();
  const misses = [];
  for (const id of new Set(malIds)) {
    const key = String(id);
    const row = conn.prepare('SELECT rating, guide, at FROM kitsu_ratings WHERE mal_id = ?').get(key);
    const ttl = row && row.rating ? RATING_TTL_MS : NO_RATING_TTL_MS;
    if (row && now - row.at <= ttl) {
      if (row.rating) out.set(key, { rating: row.rating, guide: row.guide });
      continue; // cached (rating or no-rating)
    }
    misses.push(key);
  }
  if (!misses.length) return out;

  const queue = misses.slice(0, LOOKUP_CAP);
  if (misses.length > LOOKUP_CAP) {
    log.warn(`[kitsu] ${misses.length} uncached titles — looking up ${LOOKUP_CAP} this run, the rest next time`);
  }
  let stopped = false;
  for (const id of queue) {
    if (stopped) break;
    try {
      const r = await fetchOne(id);
      conn.prepare(
        'INSERT INTO kitsu_ratings (mal_id, rating, guide, at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(mal_id) DO UPDATE SET rating = excluded.rating, guide = excluded.guide, at = excluded.at'
      ).run(id, r ? r.rating : null, r ? r.guide : null, now);
      if (r) out.set(id, { rating: r.rating, guide: r.guide });
    } catch (err) {
      if (err.status === 429 || (err.status && err.status >= 500)) {
        log.warn(`[kitsu] ${err.status} — stopping the batch (partial result)`);
        stopped = true;
        break;
      }
      // Per-id network error → skip that id (not cached).
      log.warn(`[kitsu] ${id} failed (${err.message}) — skipping`);
    }
  }
  return out;
}

// Test seam: clear the cache table.
function _reset() {
  init();
  db.get().exec('DELETE FROM kitsu_ratings;');
}

module.exports = { ageRatings, _setFetch, _reset };
