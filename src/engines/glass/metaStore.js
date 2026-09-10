// Glass deep-metadata store (GE-03) — a Glass-OWNED cache of TMDB deep metadata
// (director / franchise / lead cast / keywords / decade + the imdb_id, poster,
// genres and vote fields) keyed by (type, tmdb_id).
//
// Why a Glass-owned table, not the shared watched store: the shared contract
// (watched/pool schemas) stays untouched (design §5.5). Both the WATCHED-history
// backfill (GE-04) and CANDIDATE enrichment (GE-05/06) fill this ONE cache — the
// metadata for a title is identical whether it was watched or is a candidate, so
// enriching a title once serves both roles. It is treated as PERMANENTLY cached:
// deep credits/keywords/collection are static, so steady state is one TMDB append
// call per newly-seen title, then free forever.
const db = require('../../db');
const tmdb = require('../../services/tmdb');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS glass_metadata (
      type       TEXT NOT NULL,           -- 'movie' | 'series'
      tmdb_id    TEXT NOT NULL,
      imdb_id    TEXT,
      meta       TEXT,                    -- JSON: tmdb.normalizeDeepMeta output
      fetched_at INTEGER,
      PRIMARY KEY (type, tmdb_id)
    );
    CREATE INDEX IF NOT EXISTS ix_glass_meta_imdb ON glass_metadata (imdb_id);
  `);
  ready = true;
}

// The cached normalized deep-meta for one title, or null if not enriched yet.
function get(type, tmdbId) {
  init();
  const row = db.get().prepare('SELECT meta FROM glass_metadata WHERE type = ? AND tmdb_id = ?').get(type, String(tmdbId));
  if (!row || !row.meta) return null;
  try { return JSON.parse(row.meta); } catch { return null; }
}

// A Map<tmdb_id, meta> for many ids of one type (one query). Absent ids are
// simply missing from the map.
function getMany(type, tmdbIds) {
  init();
  const out = new Map();
  const ids = [...new Set((tmdbIds || []).map(String))];
  if (!ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.get().prepare(`SELECT tmdb_id, meta FROM glass_metadata WHERE type = ? AND tmdb_id IN (${placeholders})`).all(type, ...ids);
  for (const r of rows) { try { out.set(r.tmdb_id, JSON.parse(r.meta)); } catch { /* skip bad row */ } }
  return out;
}

function put(type, tmdbId, meta, at = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO glass_metadata (type, tmdb_id, imdb_id, meta, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type, tmdb_id) DO UPDATE SET imdb_id = excluded.imdb_id, meta = excluded.meta, fetched_at = excluded.fetched_at
  `).run(type, String(tmdbId), meta?.imdb_id || null, JSON.stringify(meta), at);
}

function has(type, tmdbId) {
  init();
  return !!db.get().prepare('SELECT 1 FROM glass_metadata WHERE type = ? AND tmdb_id = ?').get(type, String(tmdbId));
}

// Get-or-fetch: return the cached deep-meta, else make the one TMDB append call,
// cache it permanently, and return it. `fetcher` is injectable for tests
// (defaults to the live tmdb.deepMeta). A fetch that returns null (TMDB failure /
// no such title) is NOT cached — it retries on a later build. Returns the meta
// or null.
async function enrich(apiKey, type, tmdbId, log = console, { fetcher = tmdb.deepMeta } = {}) {
  init();
  const cached = get(type, tmdbId);
  if (cached) return cached;
  const meta = await fetcher(apiKey, type, tmdbId, log);
  if (meta) put(type, tmdbId, meta);
  return meta;
}

function count() {
  init();
  return db.get().prepare('SELECT COUNT(*) AS n FROM glass_metadata').get().n;
}

// Test/maintenance helper.
function _clear() {
  init();
  db.get().prepare('DELETE FROM glass_metadata').run();
}

module.exports = { init, get, getMany, put, has, enrich, count, _clear };
