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

    -- MW-00 pending-watched shim. When a user marks a title watched from the
    -- phone we write it to Simkl (authoritative), but the local watched row is
    -- keyed by simkl_id which we don't have at tap-time. This tiny per-profile
    -- table holds the just-marked title's imdb/tmdb so watchedIdSets can UNION it
    -- into the served id sets immediately — every serve path that already prunes
    -- watched then drops the title NOW, before the next activities-gated sync
    -- pulls the real row back. id is imdb_id (preferred) or tmdb_id, the dedupe
    -- key — a re-tap upserts, never duplicates. Cleared only by SUPERSESSION (a
    -- real watched row with the same id lands) or profile reset, NEVER on a timer
    -- (MW-05 I4): a timed expiry would flash the title back between expiry and the
    -- next sync.
    CREATE TABLE IF NOT EXISTS pending_watched (
      profile_id TEXT NOT NULL,
      type       TEXT NOT NULL,   -- 'movie' | 'series'
      id         TEXT NOT NULL,   -- imdb_id preferred, else tmdb_id (dedupe key)
      imdb_id    TEXT,
      tmdb_id    TEXT,
      at         INTEGER,
      PRIMARY KEY (profile_id, type, id)
    );

    -- Trainer T3.1 (R5): a per-profile unwatch block. When the user marks a
    -- film unwatched (removed from Simkl history by mistake), the Nuvio/Stremio
    -- scrobble must not re-add it. Keyed by imdb (the scrobble's movie key); a
    -- provider watch NEWER than the block time is a genuine rewatch and clears it.
    CREATE TABLE IF NOT EXISTS unwatched_block (
      profile_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      imdb_id    TEXT NOT NULL,
      tmdb_id    TEXT,
      at         INTEGER NOT NULL,
      PRIMARY KEY (profile_id, type, imdb_id)
    );

    -- Scrobble episode ledger: the episodes this app has already pushed to the
    -- profile's Simkl history. Movies are de-duped against the watched store, but
    -- per-episode state isn't tracked there, so without this every hourly
    -- scrobble re-sent the provider's ENTIRE episode history (thousands of
    -- episodes per profile, de-duped by Simkl but needless writes). A full
    -- re-push ignores the ledger.
    CREATE TABLE IF NOT EXISTS scrobble_pushed_episodes (
      profile_id TEXT    NOT NULL,
      imdb_id    TEXT    NOT NULL,
      season     INTEGER NOT NULL,
      episode    INTEGER NOT NULL,
      pushed_at  INTEGER,
      PRIMARY KEY (profile_id, imdb_id, season, episode)
    );

    -- Scrobble Part A: a film Simkl can't match (its imdb id comes back in
    -- not_found). A recorded film is skipped by later runs until 7 days after its
    -- last attempt, then tried once again. A film that later matches (it isn't in
    -- not_found, or shows up in the local watched store) has its record deleted.
    CREATE TABLE IF NOT EXISTS scrobble_unmatched (
      profile_id TEXT NOT NULL,
      imdb_id    TEXT NOT NULL,
      tmdb_id    TEXT,
      first_seen INTEGER NOT NULL,
      last_tried INTEGER NOT NULL,
      attempts   INTEGER NOT NULL,
      PRIMARY KEY (profile_id, imdb_id)
    );

    -- Scrobble movie ledger: the movies this app has already pushed to the
    -- profile's Simkl history (Simkl accepted them). Movies de-duped against the
    -- watched store only catch films whose Simkl id matches the provider's; a
    -- film whose Simkl id differs (e.g. Pokémon 4Ever: Nuvio tt0287635 vs
    -- Simkl's tt0313487, same TMDB 12600) would otherwise be re-sent every
    -- hour. A full re-push ignores the ledger; markUnwatched clears the entry.
    CREATE TABLE IF NOT EXISTS scrobble_pushed_movies (
      profile_id TEXT NOT NULL,
      imdb_id    TEXT NOT NULL,
      pushed_at  INTEGER NOT NULL,
      PRIMARY KEY (profile_id, imdb_id)
    );

    -- Marquee TV TV-1: per-show progress, parsed from Simkl all-items episode
    -- stamps (simkl.parseSeriesProgress). The engagement ladder's input. Bulk
    -- vs real stamp counts and eps_per_week are stored so the ladder is pure
    -- (no re-parsing). kind keeps 'show' vs 'anime' distinct (both Simkl
    -- sections collapse to type 'series' in the watched store).
    CREATE TABLE IF NOT EXISTS series_progress (
      profile_id    TEXT    NOT NULL,
      simkl_id      INTEGER NOT NULL,
      kind          TEXT    NOT NULL,   -- 'show' | 'anime'
      imdb_id       TEXT,
      tmdb_id       TEXT,
      title         TEXT,
      year          INTEGER,
      status        TEXT,
      watched_eps   INTEGER NOT NULL DEFAULT 0,
      total_eps     INTEGER,            -- null when Simkl reports 0
      not_aired_eps INTEGER,
      last_watched_at  INTEGER,         -- ms; the item's last_watched_at
      first_watched_at INTEGER,         -- ms; earliest episode stamp (bulk or real)
      first_real_at    INTEGER,         -- ms; earliest REAL (non-bulk) stamp
      last_real_at     INTEGER,         -- ms; latest REAL (non-bulk) stamp
      stamps        INTEGER,            -- total episode stamps
      real_stamps   INTEGER,            -- non-bulk stamps
      eps_per_week  REAL,               -- real-stamp speed, null when <4 real
      updated_at    INTEGER NOT NULL,   -- ms; set on every upsert
      PRIMARY KEY (profile_id, simkl_id)
    );
    CREATE INDEX IF NOT EXISTS ix_series_progress_profile ON series_progress (profile_id);

    -- One-time backfill marker: set the first time a profile's series_progress
    -- is filled from a full (no date_from) shows+anime pull. Steady-state syncs
    -- then only delta-pull (V2: no new Simkl requests beyond the backfill).
    CREATE TABLE IF NOT EXISTS series_progress_sync (
      profile_id    TEXT PRIMARY KEY,
      backfilled_at INTEGER
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
    // A real watched row (with its simkl_id) now exists for these titles, so any
    // MW-00 pending-watched shim they had is superseded — retire it (I4).
    if (n) clearSupersededPending(profileId);
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

// Id sets for excluding watched titles from recommendations. UNIONS the MW-00
// pending-watched shim (a just-marked title with no simkl_id yet) so every
// serve path that prunes watched drops the title immediately — no change needed
// at those call sites, they just see a bigger set.
function watchedIdSets(profileId) {
  init();
  const rows = db.get().prepare('SELECT imdb_id, tmdb_id FROM watched WHERE profile_id = ?').all(profileId);
  const imdb = new Set(); const tmdb = new Set();
  for (const r of rows) { if (r.imdb_id) imdb.add(r.imdb_id); if (r.tmdb_id) tmdb.add(r.tmdb_id); }
  const pend = db.get().prepare('SELECT imdb_id, tmdb_id FROM pending_watched WHERE profile_id = ?').all(profileId);
  for (const r of pend) { if (r.imdb_id) imdb.add(r.imdb_id); if (r.tmdb_id) tmdb.add(r.tmdb_id); }
  return { imdb, tmdb };
}

// MW-00: record a just-marked-watched title as pending (see the table comment).
// `id` is imdb (preferred) or tmdb; an item with neither is a no-op (nothing to
// pin). A re-tap upserts on the dedupe key rather than duplicating.
function addPendingWatched(profileId, { type, imdbId = null, tmdbId = null } = {}) {
  init();
  const imdb = imdbId || null;
  const tmdb = (tmdbId != null && tmdbId !== '') ? String(tmdbId) : null;
  const id = imdb || tmdb;
  if (!id) return false;
  db.get().prepare(`
    INSERT INTO pending_watched (profile_id, type, id, imdb_id, tmdb_id, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, id) DO UPDATE SET imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id, at = excluded.at
  `).run(profileId, type, id, imdb, tmdb, Date.now());
  return true;
}

// MW-00 I4: drop pending rows now backed by a REAL watched row (matched on imdb
// OR tmdb). Called after a sync upsert so the shim retires exactly when the
// authoritative row lands — supersede-only, never a timer. Returns rows cleared.
function clearSupersededPending(profileId) {
  init();
  const r = db.get().prepare(`
    DELETE FROM pending_watched WHERE profile_id = ?
      AND ((imdb_id IS NOT NULL AND imdb_id IN (SELECT imdb_id FROM watched WHERE profile_id = ? AND imdb_id IS NOT NULL))
        OR (tmdb_id IS NOT NULL AND tmdb_id IN (SELECT tmdb_id FROM watched WHERE profile_id = ? AND tmdb_id IS NOT NULL)))
  `).run(profileId, profileId, profileId);
  return Number(r.changes || 0);
}

// Most-recent watch time (ms) for a profile, or 0 if nothing watched. Drives
// the pool's rebuild trigger: new watched history = new seeds = rebuild.
function newestWatchedMs(profileId) {
  init();
  const row = db.get().prepare('SELECT MAX(watched_at) AS m FROM watched WHERE profile_id = ?').get(profileId);
  const ms = row?.m ? Date.parse(row.m) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

// Trainer T3.1 (R3/R4): remove a film's watched + pending rows by tmdb OR imdb
// id (a film marked watched by mistake). One synchronous transaction; a null
// id's clause is skipped. Returns the number of `watched` rows deleted.
function removeWatched(profileId, type, { tmdbId = null, imdbId = null } = {}) {
  init();
  const tmdb = tmdbId != null ? String(tmdbId) : null;
  const imdb = imdbId != null && imdbId !== '' ? String(imdbId) : null;
  if (!tmdb && !imdb) return 0;
  const tmdbClause = tmdb ? 'tmdb_id = ?' : null;
  const imdbClause = imdb ? 'imdb_id = ?' : null;
  const watchedWhere = tmdbClause && imdbClause ? `${tmdbClause} OR ${imdbClause}` : (tmdbClause || imdbClause);
  const watchedParams = [profileId, type, ...(tmdb ? [tmdb] : []), ...(imdb ? [imdb] : [])];
  // pending_watched rows carry imdb_id / tmdb_id columns (the `id` dedupe key
  // is one or the other); match the same way — by either column.
  const pendingWhere = tmdbClause && imdbClause
    ? '((imdb_id IS NOT NULL AND imdb_id = ?) OR (tmdb_id IS NOT NULL AND tmdb_id = ?))'
    : (imdb ? 'imdb_id = ?' : 'tmdb_id = ?');
  const pendingParams = [profileId, type, ...(imdb ? [imdb] : []), ...(tmdb ? [tmdb] : [])];
  const conn = db.get();
  conn.exec('BEGIN');
  try {
    const r = conn.prepare(`DELETE FROM watched WHERE profile_id = ? AND type = ? AND (${watchedWhere})`).run(...watchedParams);
    conn.prepare(`DELETE FROM pending_watched WHERE profile_id = ? AND type = ? AND ${pendingWhere}`).run(...pendingParams);
    conn.exec('COMMIT');
    return Number(r.changes || 0);
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

// Trainer T3.1 (R5): record that the user unwatched a film — the scrobble must
// not re-add it. Keyed by imdb (the scrobble's movie key); a film without an
// imdb id is a no-op (nothing to key on). Upsert on (profile_id, type, imdb_id).
function addUnwatchedBlock(profileId, type, { imdbId = null, tmdbId = null } = {}, at = Date.now()) {
  init();
  const imdb = imdbId != null && imdbId !== '' ? String(imdbId) : null;
  if (!imdb) return false; // no imdb id — the scrobble keys on imdb, nothing to block
  const tmdb = tmdbId != null ? String(tmdbId) : null;
  db.get().prepare(`
    INSERT INTO unwatched_block (profile_id, type, imdb_id, tmdb_id, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, imdb_id) DO UPDATE SET tmdb_id = excluded.tmdb_id, at = excluded.at
  `).run(profileId, type, imdb, tmdb, at);
  return true;
}

// Map<imdb_id, at> of unwatch blocks for a profile + type.
function unwatchedBlocks(profileId, type) {
  init();
  const out = new Map();
  for (const r of db.get().prepare('SELECT imdb_id, at FROM unwatched_block WHERE profile_id = ? AND type = ?').all(profileId, type)) {
    out.set(r.imdb_id, r.at);
  }
  return out;
}

// Drop one unwatch block (a genuine rewatch newer than the block clears it).
function clearUnwatchedBlock(profileId, type, imdbId) {
  init();
  db.get().prepare('DELETE FROM unwatched_block WHERE profile_id = ? AND type = ? AND imdb_id = ?').run(profileId, type, imdbId);
}

// Scrobble ledger: Set of `${imdb}:${season}:${episode}` keys already pushed to
// this profile's Simkl history (the same key shape computeDelta checks).
function pushedEpisodeKeys(profileId) {
  init();
  const out = new Set();
  for (const r of db.get().prepare('SELECT imdb_id, season, episode FROM scrobble_pushed_episodes WHERE profile_id = ?').all(profileId)) {
    out.add(`${r.imdb_id}:${r.season}:${r.episode}`);
  }
  return out;
}

// Record the episodes of a /sync/history body that Simkl just accepted. One
// synchronous transaction (no await inside). Returns the number recorded.
function recordPushedEpisodes(profileId, body, at = Date.now()) {
  init();
  const conn = db.get();
  const ins = conn.prepare(`
    INSERT INTO scrobble_pushed_episodes (profile_id, imdb_id, season, episode, pushed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, imdb_id, season, episode) DO UPDATE SET pushed_at = excluded.pushed_at
  `);
  let n = 0;
  conn.exec('BEGIN');
  try {
    for (const show of (body && body.shows) || []) {
      const imdb = show && show.ids && show.ids.imdb;
      if (!imdb) continue;
      for (const s of show.seasons || []) {
        for (const ep of s.episodes || []) {
          ins.run(profileId, String(imdb), Number(s.number), Number(ep.number), at);
          n++;
        }
      }
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return n;
}

// Scrobble movie ledger: Set<imdb_id> of movies this app has already pushed to
// the profile's Simkl history (Simkl accepted them). A normal scrobble skips
// them; a full re-push ignores the ledger.
function pushedMovieIds(profileId) {
  init();
  const out = new Set();
  for (const r of db.get().prepare('SELECT imdb_id FROM scrobble_pushed_movies WHERE profile_id = ?').all(profileId)) {
    out.add(r.imdb_id);
  }
  return out;
}

// Record the movies Simkl just accepted (upsert on (profile_id, imdb_id)). One
// synchronous transaction (no await inside). Returns the number recorded.
function recordPushedMovies(profileId, imdbIds, at = Date.now()) {
  init();
  const ids = (imdbIds || []).filter((id) => id != null && id !== '').map(String);
  if (!ids.length) return 0;
  const conn = db.get();
  const ins = conn.prepare(`
    INSERT INTO scrobble_pushed_movies (profile_id, imdb_id, pushed_at) VALUES (?, ?, ?)
    ON CONFLICT(profile_id, imdb_id) DO UPDATE SET pushed_at = excluded.pushed_at
  `);
  conn.exec('BEGIN');
  try {
    for (const id of ids) ins.run(profileId, id, at);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return ids.length;
}

// Drop one movie's ledger entry (the user marked it unwatched — a later
// rewatch must be pushed to Simkl again).
function clearPushedMovie(profileId, imdbId) {
  init();
  db.get().prepare('DELETE FROM scrobble_pushed_movies WHERE profile_id = ? AND imdb_id = ?').run(profileId, imdbId);
}

// Scrobble Part A: record a film Simkl could not match (its imdb id came back
// in not_found). Upsert on (profile_id, imdb_id): on insert first_seen =
// last_tried = at and attempts = 1; on conflict last_tried = at, attempts + 1,
// and tmdb_id = COALESCE(new, old) (a later run's better id is kept).
function recordUnmatched(profileId, { imdbId, tmdbId = null } = {}, at = Date.now()) {
  init();
  const imdb = imdbId != null && imdbId !== '' ? String(imdbId) : null;
  if (!imdb) return false;
  const tmdb = tmdbId != null && tmdbId !== '' ? String(tmdbId) : null;
  db.get().prepare(`
    INSERT INTO scrobble_unmatched (profile_id, imdb_id, tmdb_id, first_seen, last_tried, attempts)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(profile_id, imdb_id) DO UPDATE SET
      last_tried = excluded.last_tried,
      attempts = scrobble_unmatched.attempts + 1,
      tmdb_id = COALESCE(excluded.tmdb_id, scrobble_unmatched.tmdb_id)
  `).run(profileId, imdb, tmdb, at, at);
  return true;
}

// Set<imdb_id> of recorded films still inside their backoff window (to SKIP):
// now - last_tried < days*DAY_MS. A film past the window is tried again.
function unmatchedBackoff(profileId, now, days = 7) {
  init();
  const DAY_MS = 86400e3;
  const out = new Set();
  for (const r of db.get().prepare('SELECT imdb_id, last_tried FROM scrobble_unmatched WHERE profile_id = ?').all(profileId)) {
    if (now - r.last_tried < days * DAY_MS) out.add(r.imdb_id);
  }
  return out;
}

// Delete the recorded rows for the given imdb id(s). Returns the count.
function clearUnmatched(profileId, imdbIds) {
  init();
  const ids = Array.isArray(imdbIds) ? imdbIds : [imdbIds];
  if (!ids.length) return 0;
  const conn = db.get();
  const stmt = conn.prepare('DELETE FROM scrobble_unmatched WHERE profile_id = ? AND imdb_id = ?');
  let n = 0;
  conn.exec('BEGIN');
  try {
    for (const id of ids) {
      const r = stmt.run(profileId, id);
      n += Number(r.changes || 0);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return n;
}

// Recorded rows for a profile, ordered by last_tried DESC (newest attempts first).
function listUnmatched(profileId) {
  init();
  return db.get().prepare('SELECT * FROM scrobble_unmatched WHERE profile_id = ? ORDER BY last_tried DESC').all(profileId);
}

// Marquee TV TV-1: upsert per-show progress rows (from simkl.parseSeriesProgress).
// One synchronous transaction; replaces ALL columns per (profile_id, simkl_id),
// so a re-sync refreshes the row (watched_eps, stamps, eps_per_week) rather than
// preserving stale values. Returns the number upserted.
function upsertSeriesProgress(profileId, rows) {
  init();
  if (!rows.length) return 0;
  const conn = db.get();
  const stmt = conn.prepare(`
    INSERT INTO series_progress (
      profile_id, simkl_id, kind, imdb_id, tmdb_id, title, year, status,
      watched_eps, total_eps, not_aired_eps,
      last_watched_at, first_watched_at, first_real_at, last_real_at,
      stamps, real_stamps, eps_per_week, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, simkl_id) DO UPDATE SET
      kind          = excluded.kind,
      imdb_id       = excluded.imdb_id,
      tmdb_id       = excluded.tmdb_id,
      title         = excluded.title,
      year          = excluded.year,
      status        = excluded.status,
      watched_eps   = excluded.watched_eps,
      total_eps     = excluded.total_eps,
      not_aired_eps = excluded.not_aired_eps,
      last_watched_at  = excluded.last_watched_at,
      first_watched_at = excluded.first_watched_at,
      first_real_at    = excluded.first_real_at,
      last_real_at     = excluded.last_real_at,
      stamps        = excluded.stamps,
      real_stamps   = excluded.real_stamps,
      eps_per_week  = excluded.eps_per_week,
      updated_at    = excluded.updated_at
  `);
  const tx = conn.prepare('BEGIN'); const commit = conn.prepare('COMMIT'); const rollback = conn.prepare('ROLLBACK');
  tx.run();
  try {
    let n = 0;
    for (const r of rows) {
      if (r.simkl_id == null) continue; // primary key — Simkl always provides it
      stmt.run(
        profileId, r.simkl_id, r.kind, r.imdb_id, r.tmdb_id, r.title, r.year, r.status,
        r.watched_eps, r.total_eps, r.not_aired_eps,
        r.last_watched_at, r.first_watched_at, r.first_real_at, r.last_real_at,
        r.stamps, r.real_stamps, r.eps_per_week, Date.now(),
      );
      n++;
    }
    commit.run();
    return n;
  } catch (err) { rollback.run(); throw err; }
}

// Per-show progress rows for a profile, optionally filtered by kind
// ('show' | 'anime'). The engagement ladder's input (see seriesEngagement).
function getSeriesProgress(profileId, { kind } = {}) {
  init();
  const conn = db.get();
  const rows = kind
    ? conn.prepare('SELECT * FROM series_progress WHERE profile_id = ? AND kind = ?').all(profileId, kind)
    : conn.prepare('SELECT * FROM series_progress WHERE profile_id = ?').all(profileId);
  return rows;
}

// One-time backfill marker (see the series_progress_sync table comment).
function getSeriesProgressSync(profileId) {
  init();
  return db.get().prepare('SELECT * FROM series_progress_sync WHERE profile_id = ?').get(profileId) || null;
}

function setSeriesProgressSync(profileId) {
  init();
  db.get().prepare(`
    INSERT INTO series_progress_sync (profile_id, backfilled_at) VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET backfilled_at = excluded.backfilled_at
  `).run(profileId, Date.now());
}

function deleteForProfile(profileId) {
  init();
  db.get().prepare('DELETE FROM scrobble_pushed_episodes WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM scrobble_pushed_movies WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM watched WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM sync_state WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM pending_watched WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM unwatched_block WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM scrobble_unmatched WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM series_progress WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM series_progress_sync WHERE profile_id = ?').run(profileId);
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

  // Marquee TV TV-1 one-time backfill (V2: the ONLY new Simkl traffic). Before
  // the activities gate, if this profile has no series_progress_sync marker,
  // pull shows+anime (completed+watching) WITHOUT date_from with episodes — a
  // full pull, so every show's episode stamps land. Upsert both the watched
  // rows and the series_progress rows, then set the marker. In this run the
  // shows/anime delta pulls are skipped (already fully pulled above).
  let backfilled = false;
  if (!getSeriesProgressSync(profile.id)) {
    for (const section of ['shows', 'anime']) { // sequential per Simkl's rules
      for (const status of ['completed', 'watching']) {
        const items = await simkl.getAllItems(profile, section, { status, episodes: true });
        upsertMany(profile.id, simkl.parseWatchedItems(items, section));
        upsertSeriesProgress(profile.id, simkl.parseSeriesProgressItems(items, section));
      }
    }
    setSeriesProgressSync(profile.id);
    backfilled = true;
    // TV-2 C2: log inside the backfill block so it appears even when the
    // activities gate below returns early (the gate is checked after this block).
    const showN = getSeriesProgress(profile.id, { kind: 'show' }).length;
    const animeN = getSeriesProgress(profile.id, { kind: 'anime' }).length;
    log.log(`[simkl] ${profile.name}: series progress backfilled — ${showN} show(s), ${animeN} anime`);
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
  // Movies are only ever 'completed'. For shows/anime we ALSO pull 'watching':
  // an in-progress show is the user's strongest, most CURRENT taste signal, and
  // Simkl files a partly-watched show under 'watching', not 'completed'. Pulling
  // completed-only left a heavy series watcher's library almost invisible to the
  // engine (only fully-finished shows seeded), and let a show they're actively
  // watching be recommended back (it was absent from the watched de-dupe set).
  const STATUSES = { movies: ['completed'], shows: ['completed', 'watching'], anime: ['completed', 'watching'] };
  for (const type of ['movies', 'shows', 'anime']) { // sequential per Simkl's rules
    // TV-1: shows/anime were fully pulled by the one-time backfill this run.
    if (backfilled && (type === 'shows' || type === 'anime')) { breakdown[type] = 0; continue; }
    let n = 0;
    for (const status of STATUSES[type]) {
      const episodes = (type === 'shows' || type === 'anime'); // shows/anime carry episode stamps
      const items = await simkl.getAllItems(profile, type, { status, dateFrom, episodes });
      const parsed = simkl.parseWatchedItems(items, type);
      upserted += upsertMany(profile.id, parsed);
      n += parsed.length;
      if (episodes) upsertSeriesProgress(profile.id, simkl.parseSeriesProgressItems(items, type));
    }
    breakdown[type] = n;
  }
  setSyncState(profile.id, all);
  log.log(`[simkl] ${profile.name}: watched sync ${dateFrom ? 'delta' : 'initial'} — movies ${breakdown.movies}, shows ${breakdown.shows}, anime ${breakdown.anime}${backfilled ? ' (series backfill)' : ''} (total in store: ${countWatched(profile.id)})`);
  return { skipped: false, upserted, breakdown, total: countWatched(profile.id) };
}

module.exports = {
  init,
  upsertMany,
  getWatched,
  countWatched,
  watchedIdSets,
  addPendingWatched,
  clearSupersededPending,
  removeWatched,
  addUnwatchedBlock,
  unwatchedBlocks,
  clearUnwatchedBlock,
  pushedEpisodeKeys,
  recordPushedEpisodes,
  pushedMovieIds,
  recordPushedMovies,
  clearPushedMovie,
  recordUnmatched,
  unmatchedBackoff,
  clearUnmatched,
  listUnmatched,
  newestWatchedMs,
  upsertSeriesProgress,
  getSeriesProgress,
  getSeriesProgressSync,
  setSeriesProgressSync,
  deleteForProfile,
  getSyncState,
  setSyncState,
  syncFromSimkl,
  getUnenriched,
  updateEnrichment,
  enrichPending,
};
