// Recommendation store + builder (v6, feature F5). Weekly-ish: for each watched
// title, pull TMDB's per-title /recommendations, aggregate into candidates
// scored by RECENCY-WEIGHTED AFFINITY (a recent watch steers harder than an old
// one — the "watched Pirates 1 today → Pirates 2 tops the list" behaviour),
// apply the deterministic filters, and upsert into the `recommended` table.
//
// Two tables, mirroring the design: `recommended` (the candidate pool, with a
// lifecycle for decay later) and `dont_recommend` (user rejections + decay-outs;
// excluded from every build/serve). The age gate + genre-balanced serve are the
// next slices — this builds and filters the pool; nothing serves it yet.
const db = require('./db');
const settings = require('./settings');
const tmdb = require('./services/tmdb');
const animeMap = require('./services/animeMap');
const watchedStore = require('./watchedStore');

const HALF_LIFE_DAYS = 90;  // recency weight = 0.5 ^ (days_since_watched / this)
const SEED_CAP = 60;        // use the N most-recent watched titles as seeds
const STORE_CAP = 300;      // keep the top-N candidates by affinity
const DAY_MS = 24 * 3600e3;

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS recommended (
      profile_id  TEXT NOT NULL,
      type        TEXT NOT NULL,          -- 'movie' | 'series'
      tmdb_id     TEXT NOT NULL,
      imdb_id     TEXT,
      title       TEXT,
      year        INTEGER,
      primary_genre       TEXT,
      age_classification  TEXT,           -- filled by the age-gate slice
      affinity    REAL,                   -- recency-weighted score (primary rank)
      rec_count   INTEGER,                -- raw # of watched titles that recommended it
      popularity  REAL,
      poster      TEXT,
      first_shown_at INTEGER,             -- decay lifecycle (later slice)
      times_shown INTEGER DEFAULT 0,
      engaged_at  INTEGER,
      created_at  INTEGER,
      PRIMARY KEY (profile_id, type, tmdb_id)
    );
    CREATE INDEX IF NOT EXISTS ix_rec_profile ON recommended (profile_id, affinity DESC);

    CREATE TABLE IF NOT EXISTS dont_recommend (
      profile_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      tmdb_id    TEXT NOT NULL,
      reason     TEXT,                    -- 'user' | 'decayed'
      at         INTEGER,
      PRIMARY KEY (profile_id, type, tmdb_id)
    );
  `);
  ready = true;
}

const key = (type, tmdbId) => `${type}:${tmdbId}`;

// PURE: aggregate recommendations into scored candidates. Exported for testing.
//   seeds:          [{ tmdb_id, type, watched_at }]
//   recsBySeed:     Map<`type:tmdb_id`, recs[]>  (recs from tmdb.getRecommendations)
// Returns Map<`type:tmdb_id`, candidate> with affinity + rec_count.
function computeAffinity(seeds, recsBySeed, { halfLifeDays = HALF_LIFE_DAYS, nowMs = Date.now() } = {}) {
  const out = new Map();
  for (const seed of seeds) {
    const ts = seed.watched_at ? Date.parse(seed.watched_at) : NaN;
    const days = Number.isNaN(ts) ? 0 : Math.max(0, (nowMs - ts) / DAY_MS);
    const weight = 0.5 ** (days / halfLifeDays);
    const recs = recsBySeed.get(key(seed.type, seed.tmdb_id)) || [];
    for (const r of recs) {
      const k = key(r.type, r.tmdb_id);
      let c = out.get(k);
      if (!c) { c = { ...r, affinity: 0, rec_count: 0 }; out.set(k, c); }
      c.affinity += weight;
      c.rec_count += 1;
    }
  }
  return out;
}

function dontRecommendKeys(profileId) {
  init();
  const rows = db.get().prepare('SELECT type, tmdb_id FROM dont_recommend WHERE profile_id = ?').all(profileId);
  return new Set(rows.map((r) => key(r.type, r.tmdb_id)));
}

function addDontRecommend(profileId, type, tmdbId, reason = 'user') {
  init();
  db.get().prepare(`
    INSERT INTO dont_recommend (profile_id, type, tmdb_id, reason, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET reason = excluded.reason, at = excluded.at
  `).run(profileId, type, String(tmdbId), reason, Date.now());
  // If it was in the pool, drop it now.
  db.get().prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profileId, type, String(tmdbId));
}

function getRecommended(profileId, { type, limit = 100 } = {}) {
  init();
  return type
    ? db.get().prepare('SELECT * FROM recommended WHERE profile_id = ? AND type = ? ORDER BY affinity DESC LIMIT ?').all(profileId, type, limit)
    : db.get().prepare('SELECT * FROM recommended WHERE profile_id = ? ORDER BY affinity DESC LIMIT ?').all(profileId, limit);
}

function countRecommended(profileId) {
  init();
  return db.get().prepare('SELECT COUNT(*) AS n FROM recommended WHERE profile_id = ?').get(profileId).n;
}

function deleteForProfile(profileId) {
  init();
  db.get().prepare('DELETE FROM recommended WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM dont_recommend WHERE profile_id = ?').run(profileId);
}

// Upsert candidates, preserving the lifecycle columns (created_at, first_shown_at,
// times_shown, engaged_at, age_classification) on conflict so decay/serve state
// survives a rebuild.
function upsertCandidates(profileId, candidates) {
  init();
  const conn = db.get();
  const stmt = conn.prepare(`
    INSERT INTO recommended (profile_id, type, tmdb_id, imdb_id, title, year, primary_genre, affinity, rec_count, popularity, poster, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET
      affinity = excluded.affinity, rec_count = excluded.rec_count, popularity = excluded.popularity,
      primary_genre = excluded.primary_genre, title = excluded.title, year = excluded.year, poster = excluded.poster
  `);
  conn.prepare('BEGIN').run();
  try {
    const now = Date.now();
    for (const c of candidates) {
      stmt.run(profileId, c.type, c.tmdb_id, c.imdb_id || null, c.title, c.year, c.primary_genre || null, c.affinity, c.rec_count, c.popularity, c.poster || null, now);
    }
    conn.prepare('COMMIT').run();
  } catch (err) { conn.prepare('ROLLBACK').run(); throw err; }
}

// Build the recommendation pool for a profile. Fetches TMDB recs per watched
// seed, scores by affinity, applies deterministic filters, upserts the top N.
// Age gating is a later slice; this produces the candidate pool only.
async function buildRecommendations(profile, log = console) {
  init();
  const s = settings.getSettings();
  const tmdbKey = s?.keys?.tmdb_api_key;
  if (!tmdbKey) return { skipped: true, reason: 'no TMDB key in Server Config' };

  const filters = profile.filters || {};
  const seedsAll = watchedStore.getWatched(profile.id).filter((w) => w.tmdb_id); // most-recent first
  const seeds = seedsAll.slice(0, SEED_CAP);
  if (!seeds.length) return { skipped: true, reason: 'no watched titles to seed from' };

  // Fetch recommendations per seed (sequential-ish, small chunks to be gentle).
  const recsBySeed = new Map();
  for (let i = 0; i < seeds.length; i += 5) {
    const chunk = seeds.slice(i, i + 5);
    await Promise.all(chunk.map(async (w) => {
      try { recsBySeed.set(key(w.type, w.tmdb_id), await tmdb.getRecommendations(tmdbKey, w.type, w.tmdb_id)); }
      catch (err) { log.warn(`[rec] recs for ${w.title} failed: ${err.message}`); }
    }));
  }

  const candidates = computeAffinity(seeds, recsBySeed);
  const watchedIds = watchedStore.watchedIdSets(profile.id);
  const dont = dontRecommendKeys(profile.id);
  const genreMap = await tmdb.getGenreMap(tmdbKey);
  await animeMap.ensureLoaded(log);
  const excluded = new Set((filters.excluded_genres || []));
  const minRating = filters.min_rating || 0;

  const kept = [];
  for (const c of candidates.values()) {
    if (watchedIds.tmdb.has(c.tmdb_id)) continue;             // already watched
    if (dont.has(key(c.type, c.tmdb_id))) continue;           // user-rejected / decayed
    if (minRating > 0 && c.vote_average > 0 && c.vote_average < minRating) continue; // rating floor (unrated kept)
    const names = (c.genre_ids || []).map((g) => genreMap[g]).filter(Boolean);
    if (names.some((n) => excluded.has(n))) continue;         // excluded genre
    if (excluded.has('Anime') && animeMap.isAnime(null, c.tmdb_id)) continue; // pseudo-genre
    c.primary_genre = names[0] || null;
    kept.push(c);
  }
  kept.sort((a, b) => b.affinity - a.affinity || b.popularity - a.popularity);
  const top = kept.slice(0, STORE_CAP);
  upsertCandidates(profile.id, top);

  log.log(`[rec] ${profile.name}: built from ${seeds.length} seed(s) → ${candidates.size} raw → ${kept.length} after filters → stored ${top.length} (total ${countRecommended(profile.id)})`);
  return { seeds: seeds.length, raw: candidates.size, kept: kept.length, stored: top.length, total: countRecommended(profile.id) };
}

module.exports = {
  init,
  computeAffinity,
  buildRecommendations,
  upsertCandidates,
  getRecommended,
  countRecommended,
  dontRecommendKeys,
  addDontRecommend,
  deleteForProfile,
  HALF_LIFE_DAYS,
};
