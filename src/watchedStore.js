// Local watched store (v6, feature F3). A per-profile SQLite table of everything
// the user has watched, sourced from Simkl. It is:
//   - the de-dupe set (exclude watched from recommendations),
//   - the taste seed (feeds TMDB /recommendations, recency-weighted),
//   - upsert-not-duplicate, refreshed on an activities-gated sync.
//
// Genres and age classification are NOT in Simkl's payload, so those columns
// are enriched at ingest in a later slice; they start null and are preserved
// across re-syncs (the upsert never overwrites them with null).
const db = require('./db');
const simkl = require('./services/simkl');
const settings = require('./settings');
const tmdb = require('./services/tmdb');
const animeMap = require('./services/animeMap');
const mal = require('./services/mal');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS watched (
      profile_id   TEXT    NOT NULL,
      simkl_id     INTEGER NOT NULL,
      type         TEXT    NOT NULL,   -- 'movie' | 'series'
      imdb_id      TEXT,
      tmdb_id      TEXT,
      title        TEXT,
      year         INTEGER,
      primary_genre       TEXT,        -- enriched later (nullable)
      age_classification  TEXT,        -- enriched later (nullable)
      watched_at   TEXT,               -- ISO 8601
      updated_at   INTEGER,
      PRIMARY KEY (profile_id, simkl_id)
    );
    CREATE INDEX IF NOT EXISTS ix_watched_profile ON watched (profile_id);
    CREATE INDEX IF NOT EXISTS ix_watched_imdb    ON watched (profile_id, imdb_id);
    CREATE INDEX IF NOT EXISTS ix_watched_tmdb    ON watched (profile_id, tmdb_id);

    -- Per-profile sync cursor: last-seen Simkl activities timestamp.
    CREATE TABLE IF NOT EXISTS sync_state (
      profile_id  TEXT PRIMARY KEY,
      simkl_activities_all TEXT,
      last_synced_at INTEGER
    );
  `);
  ready = true;
}

// Upsert one parsed watched item (see simkl.parseWatchedItem). The ON CONFLICT
// updates only Simkl-sourced fields — primary_genre / age_classification set by
// enrichment are deliberately preserved.
function upsertMany(profileId, items) {
  init();
  if (!items.length) return 0;
  const conn = db.get();
  const stmt = conn.prepare(`
    INSERT INTO watched (profile_id, simkl_id, type, imdb_id, tmdb_id, title, year, watched_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, simkl_id) DO UPDATE SET
      type       = excluded.type,
      imdb_id    = excluded.imdb_id,
      tmdb_id    = excluded.tmdb_id,
      title      = excluded.title,
      year       = excluded.year,
      watched_at = excluded.watched_at,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();
  const tx = conn.prepare('BEGIN'); const commit = conn.prepare('COMMIT'); const rollback = conn.prepare('ROLLBACK');
  tx.run();
  try {
    let n = 0;
    for (const it of items) {
      if (!it.simkl_id) continue; // primary key — Simkl always provides it
      stmt.run(profileId, it.simkl_id, it.type, it.imdb_id, it.tmdb_id, it.title, it.year, it.watched_at, now);
      n++;
    }
    commit.run();
    return n;
  } catch (err) { rollback.run(); throw err; }
}

function getWatched(profileId, { type } = {}) {
  init();
  const conn = db.get();
  const rows = type
    ? conn.prepare('SELECT * FROM watched WHERE profile_id = ? AND type = ? ORDER BY watched_at DESC').all(profileId, type)
    : conn.prepare('SELECT * FROM watched WHERE profile_id = ? ORDER BY watched_at DESC').all(profileId);
  return rows;
}

function countWatched(profileId) {
  init();
  const row = db.get().prepare('SELECT COUNT(*) AS n FROM watched WHERE profile_id = ?').get(profileId);
  return row.n;
}

// Id sets for excluding watched titles from recommendations.
function watchedIdSets(profileId) {
  init();
  const rows = db.get().prepare('SELECT imdb_id, tmdb_id FROM watched WHERE profile_id = ?').all(profileId);
  const imdb = new Set(); const tmdb = new Set();
  for (const r of rows) { if (r.imdb_id) imdb.add(r.imdb_id); if (r.tmdb_id) tmdb.add(r.tmdb_id); }
  return { imdb, tmdb };
}

// Most-recent watch time (ms) for a profile, or 0 if nothing watched. Drives
// the pool's rebuild trigger: new watched history = new seeds = rebuild.
function newestWatchedMs(profileId) {
  init();
  const row = db.get().prepare('SELECT MAX(watched_at) AS m FROM watched WHERE profile_id = ?').get(profileId);
  const ms = row?.m ? Date.parse(row.m) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function deleteForProfile(profileId) {
  init();
  db.get().prepare('DELETE FROM watched WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM sync_state WHERE profile_id = ?').run(profileId);
}

// ---- ingest enrichment: fill primary_genre + age_classification ----
// Simkl's payload carries neither, so we enrich after ingest. Anime titles get
// their age band from MAL (v5.2 pipeline); everything else from a TMDB genre +
// certification lookup. Fill-nulls only (never overwrites an existing value).
function getUnenriched(profileId, limit = 40) {
  init();
  return db.get().prepare(
    'SELECT * FROM watched WHERE profile_id = ? AND (primary_genre IS NULL OR age_classification IS NULL) ORDER BY watched_at DESC LIMIT ?',
  ).all(profileId, limit);
}

function updateEnrichment(profileId, simklId, { genre, age }) {
  init();
  db.get().prepare(
    'UPDATE watched SET primary_genre = COALESCE(?, primary_genre), age_classification = COALESCE(?, age_classification) WHERE profile_id = ? AND simkl_id = ?',
  ).run(genre || null, age || null, profileId, simklId);
}

// Enrich rows still missing genre/age. TMDB key is GLOBAL (Server Config).
// Capped per run so a large initial library enriches over several ticks rather
// than one long stall; MAL lookups are paced by mal.ratings.
async function enrichPending(profileId, log = console, { limit = 40 } = {}) {
  init();
  const s = settings.getSettings();
  const tmdbKey = s?.keys?.tmdb_api_key; // non-anime enrichment needs it; anime uses MAL
  const rows = getUnenriched(profileId, limit);
  if (!rows.length) return { enriched: 0, remaining: 0 };

  await animeMap.ensureLoaded(log);
  // Batch the anime MAL lookups: collect mal ids, one ratings() call.
  const anime = new Map(); // row.simkl_id -> mal id
  for (const r of rows) {
    const hit = animeMap.lookup(r.imdb_id, r.tmdb_id);
    if (hit?.mal) anime.set(r.simkl_id, hit.mal);
  }
  const malVerdicts = anime.size ? await mal.ratings([...anime.values()], log) : new Map();

  let enriched = 0;
  for (const r of rows) {
    let genre = null; let age = null;
    if (anime.has(r.simkl_id)) {
      const v = malVerdicts.get(anime.get(r.simkl_id));
      genre = 'Anime';
      age = v?.code || null; // e.g. PG-13 / R / Rx; null if MAL hasn't rated it
    } else if (r.tmdb_id && tmdbKey) {
      const gc = await tmdb.genreAndCert(tmdbKey, r.type, r.tmdb_id, log);
      genre = gc.genre; age = gc.certification;
    }
    if (genre || age) { updateEnrichment(profileId, r.simkl_id, { genre, age }); enriched++; }
  }
  const remaining = db.get().prepare(
    'SELECT COUNT(*) AS n FROM watched WHERE profile_id = ? AND (primary_genre IS NULL OR age_classification IS NULL)',
  ).get(profileId).n;
  log.log(`[watched] ${profileId}: enriched ${enriched} of ${rows.length} (${remaining} still pending)`);
  return { enriched, remaining };
}

function getSyncState(profileId) {
  init();
  return db.get().prepare('SELECT * FROM sync_state WHERE profile_id = ?').get(profileId) || null;
}

function setSyncState(profileId, activitiesAll) {
  init();
  db.get().prepare(`
    INSERT INTO sync_state (profile_id, simkl_activities_all, last_synced_at)
    VALUES (?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET simkl_activities_all = excluded.simkl_activities_all, last_synced_at = excluded.last_synced_at
  `).run(profileId, activitiesAll || null, Date.now());
}

// Activities-gated sync from Simkl (docs/v6-plan §6b compliance):
//   1. GET /sync/activities (cheap). If the overall timestamp is unchanged,
//      skip entirely — no all-items pull.
//   2. Phase 1 (first sync): pull each type WITHOUT date_from, sequentially.
//      Phase 2 (steady state): pull each type WITH date_from = saved timestamp,
//      transferring only the delta.
// Types: movies, shows, anime -> mapped to our 'movie'/'series' at parse time.
async function syncFromSimkl(profile, log = console, { force = false } = {}) {
  init();
  if (!profile.keys.simkl_client_id || !profile.simkl_auth?.access_token) {
    return { skipped: true, reason: 'Simkl not connected' };
  }
  const activities = await simkl.getActivities(profile);
  const all = activities?.all || null;
  const prev = getSyncState(profile.id);
  if (!force && prev && prev.simkl_activities_all && prev.simkl_activities_all === all) {
    return { skipped: true, reason: 'unchanged', count: countWatched(profile.id) };
  }

  const dateFrom = force ? undefined : (prev?.simkl_activities_all || undefined); // undefined => Phase 1 full pull
  let upserted = 0;
  const breakdown = {};
  for (const type of ['movies', 'shows', 'anime']) { // sequential per Simkl's rules
    const items = await simkl.getAllItems(profile, type, { dateFrom });
    const parsed = simkl.parseWatchedItems(items, type);
    upserted += upsertMany(profile.id, parsed);
    breakdown[type] = parsed.length;
  }
  setSyncState(profile.id, all);
  log.log(`[simkl] ${profile.name}: watched sync ${dateFrom ? 'delta' : 'initial'} — movies ${breakdown.movies}, shows ${breakdown.shows}, anime ${breakdown.anime} (total in store: ${countWatched(profile.id)})`);
  return { skipped: false, upserted, breakdown, total: countWatched(profile.id) };
}

module.exports = {
  init,
  upsertMany,
  getWatched,
  countWatched,
  watchedIdSets,
  newestWatchedMs,
  deleteForProfile,
  getSyncState,
  setSyncState,
  syncFromSimkl,
  getUnenriched,
  updateEnrichment,
  enrichPending,
};
