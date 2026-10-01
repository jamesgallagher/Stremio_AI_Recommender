// Marquee m2 — the ENGAGEMENT signal: how far into a film a profile got.
//
// This family doesn't rate films (spec §12 L3: no Simkl ratings). Instead:
//   • a film watched to the end (Simkl "completed") is the sign it was good —
//     that is already the taste model's positive base;
//   • a film STARTED but abandoned before halfway is the sign it wasn't —
//     that is what this module adds (James, 2026-09-30).
// Scope: Marquee only (James's decision) — Genesis/Glass never read this table.
//
// Source: the profile's watch provider progress (Nuvio's sync_pull_watch_progress
// via scrobble.pullProviderProgress). Simkl has none for this family (§12:
// activities.movies.playback / dropped are null).
//
// Observations are KEPT even after the provider prunes its "continue watching"
// row, so an abandoned film stays remembered; a later completed watch (the film
// appearing in the watched store) always overrides it.
const db = require('../../db');
const tmdb = require('../../services/tmdb');
const settings = require('../../settings');
const watchedStore = require('../../watchedStore');

const DAY_MS = 24 * 3600e3;

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS marquee_engagement (
      profile_id  TEXT NOT NULL,
      imdb_id     TEXT NOT NULL,
      tmdb_id     TEXT,                -- resolved lazily (TMDB find), capped per sync
      percent     REAL,                -- furthest-known progress, 0–100
      updated_at  INTEGER,             -- provider's last-touched time (ms)
      seen_at     INTEGER,             -- when this app last observed the row
      PRIMARY KEY (profile_id, imdb_id)
    );
    CREATE TABLE IF NOT EXISTS marquee_engagement_sync (
      profile_id TEXT PRIMARY KEY,
      synced_at  INTEGER
    );
  `);
  // Trainer T2 (§4.2): additive migration — old DBs predate the duration_ms
  // column (the credits guard reads it). ADD COLUMN guarded by PRAGMA table_info
  // (N11: no DROP, no data copy).
  if (!db.get().prepare('PRAGMA table_info(marquee_engagement)').all().some((c) => c.name === 'duration_ms')) {
    db.get().exec('ALTER TABLE marquee_engagement ADD COLUMN duration_ms INTEGER');
  }
  ready = true;
}

// Pull the provider's progress rows and upsert the MOVIE ones. Throttled to one
// pull per cfg.engagement.sync_hours per profile (the provider login is not
// free). Never throws — a provider outage just leaves the stored observations.
// `pull(profile)` → normalized rows or null (no provider progress source).
async function syncEngagement(profile, cfg, { pull, resolveTmdb, now = Date.now(), log = console, force = false } = {}) {
  init();
  const eng = cfg.engagement || {};
  const conn = db.get();
  try {
    const prev = conn.prepare('SELECT synced_at FROM marquee_engagement_sync WHERE profile_id = ?').get(profile.id);
    if (!force && prev?.synced_at && now - prev.synced_at < (eng.sync_hours ?? 6) * 3600e3) return { skipped: 'fresh' };
    const puller = pull || ((p) => require('../../services/scrobble').pullProviderProgress(p.scrobble));
    const rows = await puller(profile);
    if (rows == null) return { skipped: 'no progress source' };
    const movies = rows.filter((r) => r && r.type === 'movie' && r.imdbId && r.percent != null);

    // Resolve tmdb ids BEFORE the transaction (never hold a transaction open
    // across an await on the shared connection — P2 review F1).
    const known = new Map(conn.prepare('SELECT imdb_id, tmdb_id FROM marquee_engagement WHERE profile_id = ? AND tmdb_id IS NOT NULL').all(profile.id).map((r) => [r.imdb_id, r.tmdb_id]));
    const resolver = resolveTmdb || ((imdbId) => tmdb.findByImdbId(settings.keyFor(profile, 'tmdb_api_key'), 'movie', imdbId));
    let resolves = 0;
    const ready2 = [];
    for (const r of movies) {
      let tmdbId = known.get(r.imdbId) || null;
      if (!tmdbId && resolves < (eng.resolve_cap ?? 30)) {
        resolves += 1;
        try { const id = await resolver(r.imdbId); tmdbId = id != null ? String(id) : null; } catch { tmdbId = null; }
      }
      ready2.push({ ...r, tmdbId });
    }

    conn.exec('BEGIN');
    try {
      const up = conn.prepare(`
        INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, imdb_id) DO UPDATE SET
          tmdb_id = COALESCE(excluded.tmdb_id, marquee_engagement.tmdb_id),
          percent = MAX(excluded.percent, COALESCE(marquee_engagement.percent, 0)),
          updated_at = MAX(COALESCE(excluded.updated_at, 0), COALESCE(marquee_engagement.updated_at, 0)),
          seen_at = excluded.seen_at,
          duration_ms = COALESCE(excluded.duration_ms, marquee_engagement.duration_ms)
      `);
      for (const r of ready2) up.run(profile.id, r.imdbId, r.tmdbId, r.percent, r.updatedAtMs, now, (Number.isFinite(r.durationMs) && r.durationMs > 0) ? r.durationMs : null);
      conn.prepare(`
        INSERT INTO marquee_engagement_sync (profile_id, synced_at) VALUES (?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET synced_at = excluded.synced_at
      `).run(profile.id, now);
      conn.exec('COMMIT');
    } catch (err) {
      try { conn.exec('ROLLBACK'); } catch { /* already closed */ }
      throw err;
    }
    log.log(`[marquee] ${profile.name}: engagement sync — ${movies.length} movie progress row(s), ${resolves} tmdb lookup(s)`);
    return { ok: true, movies: movies.length };
  } catch (err) {
    log.warn(`[marquee] engagement sync failed: ${err.message} — keeping stored observations`);
    return { ok: false, error: err.message };
  }
}

// PURE (Trainer T2, N6/N7): is one marquee_engagement row an ABANDONED film?
// True iff ALL of these hold: engagement enabled; a resolved tmdb id; furthest
// progress below abandon_below AND below finish_pct; when a duration is known,
// more than credits_min minutes remain (credits/rewatch = never abandoned);
// untouched for at least grace_days (a film paused last night is not a
// verdict); and NOT in the watched store under either id (a completed watch —
// or a rewatch — always wins). `watchedIds` is watchedStore.watchedIdSets
// (it already includes the pending shim — never re-query pending_watched).
function isAbandoned(row, eng, { now, watchedIds }) {
  if (eng.enabled === false) return false;
  if (row.tmdb_id == null) return false;
  if (row.percent == null) return false;
  const p = Number(row.percent);
  if (!(p < (eng.abandon_below ?? 50))) return false;
  if (!(p < (eng.finish_pct ?? 90))) return false;
  const dur = Number(row.duration_ms);
  if (dur > 0 && !((dur * (1 - p / 100)) / 60000 > (eng.credits_min ?? 20))) return false; // credits → never abandoned
  if (row.updated_at && now - row.updated_at < (eng.grace_days ?? 7) * DAY_MS) return false;
  if (watchedIds.tmdb.has(String(row.tmdb_id))) return false;
  if (watchedIds.imdb.has(row.imdb_id)) return false;
  return true;
}

// The profile's ABANDONED rows (Trainer T2, N7): the full marquee_engagement
// rows that isAbandoned flags, including duration_ms. The Trainer's "Unfinished"
// list and Marquee's abandoned set BOTH come from here, so they can never
// disagree (one rule, two consumers).
function abandonedRows(profileId, cfg, { now = Date.now() } = {}) {
  init();
  const eng = cfg.engagement || {};
  const watchedIds = watchedStore.watchedIdSets(profileId);
  const rows = db.get().prepare('SELECT imdb_id, tmdb_id, percent, updated_at, duration_ms FROM marquee_engagement WHERE profile_id = ?').all(profileId);
  return rows.filter((row) => isAbandoned(row, eng, { now, watchedIds }));
}

// The films this profile ABANDONED, keyed by tmdb id: Map<tmdb_id, { percent, ts }>.
// Built from abandonedRows (Trainer T2) — same rule, same rows, same shape as m2.
function abandonedFor(profileId, cfg, { now = Date.now() } = {}) {
  const out = new Map();
  for (const r of abandonedRows(profileId, cfg, { now })) {
    out.set(String(r.tmdb_id), { percent: r.percent, ts: r.updated_at || null });
  }
  return out;
}

// Test/maintenance helper.
function _clear() {
  init();
  db.get().exec('DELETE FROM marquee_engagement; DELETE FROM marquee_engagement_sync');
}

module.exports = { init, syncEngagement, isAbandoned, abandonedRows, abandonedFor, _clear };
