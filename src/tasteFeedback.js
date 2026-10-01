// Trainer T1 — the engine-AGNOSTIC taste-feedback store. Lives OUTSIDE
// src/engines/ so any engine can read it (typed by `type`); Marquee is the only
// engine wired in v1 (TD-2). It replaces the Marquee-owned marquee_ratings /
// marquee_sync tables (those are left in place but unused — no destructive
// migration). simklCache.syncRatings / getRatingsMap delegate here, so Marquee
// callers and tests keep working (mandate M9: the move is pure).
//
// Mandates honoured here:
//   M1 — a rating row is written by the caller only AFTER Simkl succeeds; this
//        store never calls Simkl itself.
//   M2 — ignore is local only: setIgnored never touches Simkl or the `watched`
//        rows; an ignored film stays in watchedIdSets.
//   M3 — there is no "super-like"/"loved" flag anywhere: Loved is computed as
//        rating === 10 in the DTO (trainer.js), never stored.
//   M8 — syncRatings resolves everything BEFORE a fully-synchronous transaction.
const db = require('./db');
const simkl = require('./services/simkl');
const tmdb = require('./services/tmdb');
const settings = require('./settings');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS taste_ratings (
      profile_id TEXT NOT NULL, type TEXT NOT NULL, tmdb_id TEXT NOT NULL,
      imdb_id TEXT, simkl_id INTEGER, rating INTEGER NOT NULL, rated_at TEXT,
      PRIMARY KEY (profile_id, type, tmdb_id));
    CREATE TABLE IF NOT EXISTS taste_ratings_sync (
      profile_id TEXT NOT NULL, type TEXT NOT NULL, activity TEXT, synced_at INTEGER,
      degraded_synced_at INTEGER, PRIMARY KEY (profile_id, type));
    CREATE TABLE IF NOT EXISTS taste_ignore (
      profile_id TEXT NOT NULL, type TEXT NOT NULL, simkl_id INTEGER,
      tmdb_id TEXT, imdb_id TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, type, tmdb_id));
    CREATE TABLE IF NOT EXISTS taste_changes (
      profile_id TEXT PRIMARY KEY, changed_at INTEGER, changes_since_build INTEGER);
  `);
  ready = true;
}

// Trainer T1: moved from simklCache (statement for statement; see §5.2). The
// storage is scoped by `type`; the `activity` column replaces `ratings_activity`.
// `type === 'series'` throws (the ONLY throw — v1 is movies only); otherwise it
// never throws, exactly as the Marquee sync did (MI-3).
async function syncRatings(profile, {
  type = 'movie',
  fetchActivities = simkl.getActivities,
  fetchRatings = simkl.getRatings,
  resolveTmdb,
  now = Date.now(),
  log = console,
  force = false,
  resolveCap = 50,
} = {}) {
  if (type === 'series') throw new Error('not-supported');
  init();
  const profileId = profile.id;
  const resolver = resolveTmdb || ((imdbId) => tmdb.findByImdbId(settings.keyFor(profile, 'tmdb_api_key'), 'movie', imdbId));
  try {
    const activities = await fetchActivities(profile);
    const movies = activities && typeof activities === 'object' ? activities.movies : null;
    const hasKey = movies && typeof movies === 'object' && Object.prototype.hasOwnProperty.call(movies, 'rated_at');
    const ratedAt = hasKey ? (movies.rated_at == null ? null : String(movies.rated_at)) : null;

    const prev = db.get().prepare('SELECT activity, synced_at, degraded_synced_at FROM taste_ratings_sync WHERE profile_id = ? AND type = ?').get(profileId, type);
    if (!force) {
      if (hasKey) {
        // §12 L2: the gate compares the stored and current value INCLUDING null.
        if (prev && (prev.activity == null ? ratedAt === null : prev.activity === ratedAt)) {
          return { ok: true, skipped: 'unchanged' };
        }
      } else if (prev && prev.degraded_synced_at != null && now - prev.degraded_synced_at < 24 * 3600e3) {
        // §4.2(5): the rated_at key itself is absent — no reliable gate, so pull
        // at most once per 24 h (degraded_synced_at tracks the last DEGRADED pull,
        // independent of the hasKey syncs above).
        log.warn('[trainer] ratings gate degraded (activities.movies.rated_at key absent) — pulling at most once per 24 h');
        return { ok: true, skipped: 'gate-degraded' };
      }
    }

    // One GET for the whole account (spec §4.2(3): ~hundreds of entries).
    const ratings = await fetchRatings(profile, 'movies');

    // Resolve all imdb-only entries to a tmdb id BEFORE the transaction. The
    // shared db.get() connection must never have a transaction open across an
    // await: while a resolver lookup is pending, another writer's BEGIN would
    // throw "cannot start a transaction within a transaction", and unrelated
    // writes (e.g. recordImpressions on a catalog serve) would silently join
    // this transaction and be discarded on a ROLLBACK. So the lookups happen
    // first; the transaction below is fully synchronous (BEGIN → DELETE →
    // inserts → COMMIT), as in upsertCandidates and trendingCache.replaceWindow.
    let unresolved = 0;
    let resolveCount = 0;
    const rows = [];
    for (const r of ratings) {
      let tmdbId = r.tmdb_id;
      if (!tmdbId && r.imdb_id && resolveCount < resolveCap) {
        resolveCount += 1;
        try { tmdbId = await resolver(r.imdb_id); } catch { /* counted unresolved below */ }
      }
      if (!tmdbId) { unresolved += 1; continue; } // no tmdb id — the table's primary key
      rows.push({ tmdbId: String(tmdbId), imdb: r.imdb_id || null, simkl: r.simkl_id != null ? r.simkl_id : null, rating: r.rating, ratedAt: r.rated_at || null });
    }

    // Replace this profile's rows in one fully-synchronous transaction (zero
    // rated entries is valid → the table is empty for this profile).
    const conn = db.get();
    conn.exec('BEGIN');
    try {
      conn.prepare('DELETE FROM taste_ratings WHERE profile_id = ? AND type = ?').run(profileId, type);
      const ins = conn.prepare('INSERT INTO taste_ratings (profile_id, type, tmdb_id, imdb_id, simkl_id, rating, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) {
        ins.run(profileId, type, row.tmdbId, row.imdb, row.simkl, row.rating, row.ratedAt);
      }
      conn.exec('COMMIT');
    } catch (err) {
      try { conn.exec('ROLLBACK'); } catch { /* commit already ran */ }
      throw err;
    }
    const synced = rows.length;
    // Upsert the sync cursor with the current value (possibly null — §12 L2).
    // In degraded mode (key absent) record the degraded-pull timestamp; in
    // hasKey mode clear it so a future degraded stretch starts fresh.
    db.get().prepare(`
      INSERT INTO taste_ratings_sync (profile_id, type, activity, synced_at, degraded_synced_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, type) DO UPDATE SET activity = excluded.activity, synced_at = excluded.synced_at, degraded_synced_at = excluded.degraded_synced_at
    `).run(profileId, type, hasKey ? ratedAt : null, now, hasKey ? null : now);
    return { ok: true, synced, unresolved };
  } catch (err) {
    log.warn(`[trainer] ratings sync failed: ${err.message} — keeping existing rows`);
    return { ok: false, error: err.message };
  }
}

// Map<tmdb_id(string), rating(int)> for one profile + type.
function getRatingsMap(profileId, type = 'movie') {
  init();
  const out = new Map();
  for (const r of db.get().prepare('SELECT tmdb_id, rating FROM taste_ratings WHERE profile_id = ? AND type = ?').all(profileId, type)) {
    out.set(String(r.tmdb_id), r.rating);
  }
  return out;
}

// A single rating (int) or null.
function getRating(profileId, type, tmdbId) {
  init();
  const row = db.get().prepare('SELECT rating FROM taste_ratings WHERE profile_id = ? AND type = ? AND tmdb_id = ?').get(profileId, type, String(tmdbId));
  return row ? row.rating : null;
}

// Upsert one rating row (Simkl has already succeeded — M1).
function upsertRating(profileId, { type, tmdb_id, imdb_id = null, simkl_id = null, rating, rated_at = null } = {}) {
  init();
  db.get().prepare(`
    INSERT INTO taste_ratings (profile_id, type, tmdb_id, imdb_id, simkl_id, rating, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET imdb_id = excluded.imdb_id, simkl_id = excluded.simkl_id, rating = excluded.rating, rated_at = excluded.rated_at
  `).run(profileId, type, String(tmdb_id), imdb_id, simkl_id, rating, rated_at);
}

// Delete one rating row. → boolean (a row existed).
function deleteRating(profileId, type, tmdbId) {
  init();
  const r = db.get().prepare('DELETE FROM taste_ratings WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profileId, type, String(tmdbId));
  return Number(r.changes || 0) > 0;
}

// Set/clear the local ignore flag. → boolean (state CHANGED). Never touches
// Simkl or the `watched` rows (M2).
function setIgnored(profileId, { type, tmdb_id, imdb_id = null, simkl_id = null }, ignored, now = Date.now()) {
  init();
  const conn = db.get();
  const key = String(tmdb_id);
  const existed = !!conn.prepare('SELECT 1 FROM taste_ignore WHERE profile_id = ? AND type = ? AND tmdb_id = ?').get(profileId, type, key);
  if (ignored) {
    conn.prepare(`
      INSERT INTO taste_ignore (profile_id, type, simkl_id, tmdb_id, imdb_id, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET simkl_id = excluded.simkl_id, imdb_id = excluded.imdb_id, at = excluded.at
    `).run(profileId, type, simkl_id, key, imdb_id, now);
    return !existed; // changed only if it was NOT already ignored
  }
  const r = conn.prepare('DELETE FROM taste_ignore WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profileId, type, key);
  return Number(r.changes || 0) > 0; // changed only if a row existed
}

// Set<tmdb_id(string)> of ignored rows for a profile + type.
function ignoredSet(profileId, type) {
  init();
  const out = new Set();
  for (const r of db.get().prepare('SELECT tmdb_id FROM taste_ignore WHERE profile_id = ? AND type = ?').all(profileId, type)) {
    out.add(String(r.tmdb_id));
  }
  return out;
}

// Record a training change (drives the rebuild trigger, §8).
function recordChange(profileId, now = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO taste_changes (profile_id, changed_at, changes_since_build) VALUES (?, ?, 1)
    ON CONFLICT(profile_id) DO UPDATE SET changed_at = excluded.changed_at, changes_since_build = taste_changes.changes_since_build + 1
  `).run(profileId, now);
}

// { changed_at: int|null, changes_since_build: int } for the banner.
function getTraining(profileId) {
  init();
  const row = db.get().prepare('SELECT changed_at, changes_since_build FROM taste_changes WHERE profile_id = ?').get(profileId);
  return { changed_at: row ? row.changed_at : null, changes_since_build: row ? row.changes_since_build : 0 };
}

// T2 resets this after a successful build; exported now.
function resetChangesSinceBuild(profileId) {
  init();
  db.get().prepare('UPDATE taste_changes SET changes_since_build = 0 WHERE profile_id = ?').run(profileId);
}

// Remove all four tables' rows for a profile (the profile-delete hook).
function deleteForProfile(profileId) {
  init();
  db.get().prepare('DELETE FROM taste_ratings WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM taste_ratings_sync WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM taste_ignore WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM taste_changes WHERE profile_id = ?').run(profileId);
}

module.exports = {
  init,
  syncRatings,
  getRatingsMap,
  getRating,
  upsertRating,
  deleteRating,
  setIgnored,
  ignoredSet,
  recordChange,
  getTraining,
  resetChangesSinceBuild,
  deleteForProfile,
};
