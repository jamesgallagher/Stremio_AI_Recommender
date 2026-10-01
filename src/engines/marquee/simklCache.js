// Marquee ME-03 (spec §4.2) — engine-owned caches for the Simkl movie RATINGS
// and the per-seed "users also liked" recommendations (users_recommendations).
//
// MI-3 graceful degradation: every fetch path degrades (skip, keep stale rows,
// return {ok:false}) — a Simkl outage never fails a Marquee build. MI-4 Simkl
// etiquette: every call rides the governed simkl_get lane (the fetchers are
// simkl.authedGet-based), fetches are sequential and capped, no retry loops.
// §12 L3: an account with no movie ratings is the NORMAL case — a zero-rated
// sync is a valid, empty state, not an error.
const db = require('../../db');
const simkl = require('../../services/simkl');
const tmdb = require('../../services/tmdb');
const settings = require('../../settings');
const tasteFeedback = require('../../tasteFeedback');

let ready = false;
function init() {
  if (ready) return;
  // marquee_ratings / marquee_sync are unused since Trainer T1 — kept, no destructive migration.
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS marquee_ratings (
      profile_id TEXT NOT NULL, tmdb_id TEXT NOT NULL, imdb_id TEXT, simkl_id INTEGER,
      rating INTEGER NOT NULL, rated_at TEXT, PRIMARY KEY (profile_id, tmdb_id));
    CREATE TABLE IF NOT EXISTS marquee_sync (
      profile_id TEXT PRIMARY KEY, ratings_activity TEXT, synced_at INTEGER, degraded_synced_at INTEGER);
    CREATE TABLE IF NOT EXISTS marquee_simkl_recs (
      simkl_id INTEGER PRIMARY KEY, recs TEXT, fetched_at INTEGER);
  `);
  ready = true;
}

// Activities-gated ratings sync (spec §4.2; §12 L2). Trainer T1: the whole
// implementation lives in the engine-agnostic tasteFeedback store (type-scoped);
// Marquee delegates for movies only (M9 — a pure move, identical behaviour).
async function syncRatings(profile, opts = {}) {
  return tasteFeedback.syncRatings(profile, { ...opts, type: 'movie' });
}

// Map<tmdb_id, rating> for one profile (spec §4.2). Trainer T1: delegated to
// the engine-agnostic tasteFeedback store (movies only — M9, a pure move).
function getRatingsMap(profileId) {
  return tasteFeedback.getRatingsMap(profileId, 'movie');
}

// "Users also liked" recommendations for seed simkl ids (spec §4.2): fresh
// cached ids are served from the table; uncached/stale ids are fetched
// SEQUENTIALLY (one at a time — the governor paces), stopping after
// maxUncached fetches even if more are pending; a per-id fetch error logs +
// skips (not cached, retries next build) and continues. Stale cached data is
// returned for ids beyond the cap (stale better than nothing) but is still
// due for refetch. TTL: MARQUEE_SIMKL_RECS_TTL_MS env override, default 30 days.
async function ensureRecs(profile, simklIds, {
  maxUncached = 40,
  ttlMs,
  fetchSummary = simkl.getMovieSummary,
  now = Date.now(),
  log = console,
} = {}) {
  init();
  const ttl = ttlMs != null ? ttlMs : (Number(process.env.MARQUEE_SIMKL_RECS_TTL_MS) || 30 * 24 * 3600e3);
  const ids = [...new Set((simklIds || []).filter((id) => id != null))];
  const out = new Map();
  const toFetch = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.get().prepare(`SELECT simkl_id, recs, fetched_at FROM marquee_simkl_recs WHERE simkl_id IN (${placeholders})`).all(...ids);
    const cached = new Map();
    for (const r of rows) {
      let recs;
      try { recs = JSON.parse(r.recs); } catch { recs = []; }
      cached.set(r.simkl_id, { recs: Array.isArray(recs) ? recs : [], fetchedAt: r.fetched_at || 0 });
    }
    for (const id of ids) {
      const c = cached.get(id);
      if (c) {
        out.set(id, c.recs); // fresh or stale — stale is still served (better than nothing)
        if (now - c.fetchedAt > ttl) toFetch.push(id); // stale → due for refetch
      } else {
        toFetch.push(id);
      }
    }
  }
  let fetched = 0;
  for (const id of toFetch) {
    if (fetched >= maxUncached) break; // spec §4.2: stop after maxUncached even if more pending
    fetched += 1; // an attempt counts against the cap whether it succeeds or not
    try {
      const summary = await fetchSummary(profile, id);
      const recs = summary && Array.isArray(summary.users_recommendations) ? summary.users_recommendations : [];
      db.get().prepare(`
        INSERT INTO marquee_simkl_recs (simkl_id, recs, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(simkl_id) DO UPDATE SET recs = excluded.recs, fetched_at = excluded.fetched_at
      `).run(id, JSON.stringify(recs), now);
      out.set(id, recs);
    } catch (err) {
      log.warn(`[marquee] simkl recs for ${id} failed: ${err.message} — skipping (retries next build)`);
    }
  }
  return out;
}

module.exports = { init, syncRatings, getRatingsMap, ensureRecs };
