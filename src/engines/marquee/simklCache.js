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

let ready = false;
function init() {
  if (ready) return;
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

// Activities-gated ratings sync (spec §4.2; §12 L2): read activities, compare
// movies.rated_at against the stored value INCLUDING null (null === null is
// unchanged; null stored as SQL NULL). No stored row = never synced → pull
// once. A missing rated_at KEY (≠ null) degrades to a 24 h pull cap (§4.2(5)).
// The whole-account ratings GET is one call; this profile's rows are replaced
// in one transaction; an imdb-only entry is resolved to a tmdb id via
// resolveTmdb, capped at 50 lookups per sync. Never throws (MI-3).
async function syncRatings(profile, {
  fetchActivities = simkl.getActivities,
  fetchRatings = simkl.getRatings,
  resolveTmdb,
  now = Date.now(),
  log = console,
  force = false,
  resolveCap = 50,
} = {}) {
  init();
  const profileId = profile.id;
  const resolver = resolveTmdb || ((imdbId) => tmdb.findByImdbId(settings.keyFor(profile, 'tmdb_api_key'), 'movie', imdbId));
  try {
    const activities = await fetchActivities(profile);
    const movies = activities && typeof activities === 'object' ? activities.movies : null;
    const hasKey = movies && typeof movies === 'object' && Object.prototype.hasOwnProperty.call(movies, 'rated_at');
    const ratedAt = hasKey ? (movies.rated_at == null ? null : String(movies.rated_at)) : null;

    const prev = db.get().prepare('SELECT ratings_activity, synced_at, degraded_synced_at FROM marquee_sync WHERE profile_id = ?').get(profileId);
    if (!force) {
      if (hasKey) {
        // §12 L2: the gate compares the stored and current value INCLUDING null.
        if (prev && (prev.ratings_activity == null ? ratedAt === null : prev.ratings_activity === ratedAt)) {
          return { ok: true, skipped: 'unchanged' };
        }
      } else if (prev && prev.degraded_synced_at != null && now - prev.degraded_synced_at < 24 * 3600e3) {
        // §4.2(5): the rated_at key itself is absent — no reliable gate, so pull
        // at most once per 24 h (degraded_synced_at tracks the last DEGRADED pull,
        // independent of the hasKey syncs above).
        log.warn('[marquee] ratings gate degraded (activities.movies.rated_at key absent) — pulling at most once per 24 h');
        return { ok: true, skipped: 'gate-degraded' };
      }
    }

    // One GET for the whole account (spec §4.2(3): ~hundreds of entries).
    const ratings = await fetchRatings(profile, 'movies');

    // Replace this profile's rows in one transaction (zero rated entries is
    // valid → the table is empty for this profile).
    let unresolved = 0;
    let synced = 0;
    let resolveCount = 0;
    const conn = db.get();
    conn.exec('BEGIN');
    try {
      conn.prepare('DELETE FROM marquee_ratings WHERE profile_id = ?').run(profileId);
      const ins = conn.prepare('INSERT INTO marquee_ratings (profile_id, tmdb_id, imdb_id, simkl_id, rating, rated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of ratings) {
        let tmdbId = r.tmdb_id;
        if (!tmdbId && r.imdb_id && resolveCount < resolveCap) {
          resolveCount += 1;
          try { tmdbId = await resolver(r.imdb_id); } catch { /* counted unresolved below */ }
        }
        if (!tmdbId) { unresolved += 1; continue; } // no tmdb id — the table's primary key
        ins.run(profileId, tmdbId, r.imdb_id || null, r.simkl_id != null ? r.simkl_id : null, r.rating, r.rated_at || null);
        synced += 1;
      }
      conn.exec('COMMIT');
    } catch (err) {
      try { conn.exec('ROLLBACK'); } catch { /* commit already ran */ }
      throw err;
    }
    // Upsert the sync cursor with the current value (possibly null — §12 L2).
    // In degraded mode (key absent) record the degraded-pull timestamp; in
    // hasKey mode clear it so a future degraded stretch starts fresh.
    db.get().prepare(`
      INSERT INTO marquee_sync (profile_id, ratings_activity, synced_at, degraded_synced_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET ratings_activity = excluded.ratings_activity, synced_at = excluded.synced_at, degraded_synced_at = excluded.degraded_synced_at
    `).run(profileId, hasKey ? ratedAt : null, now, hasKey ? null : now);
    return { ok: true, synced, unresolved };
  } catch (err) {
    log.warn(`[marquee] ratings sync failed: ${err.message} — keeping existing rows`);
    return { ok: false, error: err.message };
  }
}

// Map<tmdb_id, rating> for one profile (spec §4.2).
function getRatingsMap(profileId) {
  init();
  const out = new Map();
  for (const r of db.get().prepare('SELECT tmdb_id, rating FROM marquee_ratings WHERE profile_id = ?').all(profileId)) {
    out.set(r.tmdb_id, r.rating);
  }
  return out;
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
