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
        INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, imdb_id) DO UPDATE SET
          tmdb_id = COALESCE(excluded.tmdb_id, marquee_engagement.tmdb_id),
          percent = MAX(excluded.percent, COALESCE(marquee_engagement.percent, 0)),
          updated_at = MAX(COALESCE(excluded.updated_at, 0), COALESCE(marquee_engagement.updated_at, 0)),
          seen_at = excluded.seen_at
      `);
      for (const r of ready2) up.run(profile.id, r.imdbId, r.tmdbId, r.percent, r.updatedAtMs, now);
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

// The films this profile ABANDONED: furthest progress below
// cfg.engagement.abandon_below (%), untouched for at least grace_days (a film
// paused last night is not a verdict), with a resolved tmdb id, and NOT in the
// watched store (a completed watch always wins). Map<tmdb_id, { percent, ts }>.
function abandonedFor(profileId, cfg, { now = Date.now() } = {}) {
  init();
  const eng = cfg.engagement || {};
  if (eng.enabled === false) return new Map();
  const below = eng.abandon_below ?? 50;
  const graceMs = (eng.grace_days ?? 7) * DAY_MS;
  const watched = watchedStore.watchedIdSets(profileId);
  const out = new Map();
  const rows = db.get().prepare('SELECT imdb_id, tmdb_id, percent, updated_at FROM marquee_engagement WHERE profile_id = ? AND tmdb_id IS NOT NULL AND percent < ?').all(profileId, below);
  for (const r of rows) {
    if (watched.tmdb.has(r.tmdb_id) || watched.imdb.has(r.imdb_id)) continue; // finished later → not abandoned
    if (r.updated_at && now - r.updated_at < graceMs) continue;                 // still possibly in progress
    out.set(String(r.tmdb_id), { percent: r.percent, ts: r.updated_at || null });
  }
  return out;
}

// Test/maintenance helper.
function _clear() {
  init();
  db.get().exec('DELETE FROM marquee_engagement; DELETE FROM marquee_engagement_sync');
}

module.exports = { init, syncEngagement, abandonedFor, _clear };
