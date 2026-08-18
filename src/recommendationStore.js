// Recommendation store + builder + serve engine (v6, features F5/F6).
//
// BUILD (background): for each watched title, pull TMDB's per-title
// /recommendations, aggregate into candidates scored by RECENCY-WEIGHTED
// AFFINITY (a recent watch steers harder than an old one — the "watched
// Pirates 1 today → Pirates 2 tops the list" behaviour), keep the strongest
// few per title, resolve tt ids + posters, age-gate, and upsert a FULL pool
// (rating + full genre list stored, NOT pre-filtered by user preference).
//
// SERVE (request path, cheap, no network): selectServe applies the user's
// preferences (rating floor, excluded genres, recency) + a cheap age-band
// re-check over the stored pool, then genre-balances the result — so changing
// a filter takes effect immediately with no rebuild.
//
// Tables: `recommended` (the candidate pool, with a decay lifecycle),
// `dont_recommend` (user rejections + decay-outs, excluded from build/serve),
// and `rec_state` (last build time, the rebuild trigger).
const db = require('./db');
const settings = require('./settings');
const tmdb = require('./services/tmdb');
const animeMap = require('./services/animeMap');
const watchedStore = require('./watchedStore');

const HALF_LIFE_DAYS = 90;  // recency weight = 0.5 ^ (days_since_watched / this)
const SEED_CAP = 60;        // use the N most-recent watched titles as seeds
const STORE_CAP = 300;      // keep the top-N candidates by affinity
const SERVE_LIMIT = 100;    // max titles in a served, genre-balanced catalog
const DAY_MS = 24 * 3600e3;

// Per-source-title selection: TMDB returns ~20 recs already in RELEVANCE order
// (strongest match first). Keeping all 20 makes the matching mushy, so we keep
// only the strongest few PER title — the top N in TMDB's own order, gated only
// by the vote-count NOISE floor (an internal confidence gate, not a user
// preference) and the porn flag.
//
// DELIBERATELY NOT gated by the rating floor / genres / recency here: those are
// USER PREFERENCES that change, so we store a fuller pool of strong candidates
// (with vote_average + genres + year) and apply those filters at SERVE time
// (F6). Changing the floor or un-excluding a genre then takes effect with no
// rebuild and no TMDB refetch. (Decided 2026-08 — see docs/v6-features F5.)
const PER_TITLE_CAP = 5;
const VOTE_FLOOR_MOVIE = 150;
const VOTE_FLOOR_TV = 50;   // TV vote counts run lower, same asymmetry as elsewhere
const voteFloorFor = (type) => (type === 'series' ? VOTE_FLOOR_TV : VOTE_FLOOR_MOVIE);

// The strongest ≤N recommendations for one source title (relevance order).
function selectStrong(recs) {
  return (recs || [])
    .filter((r) => !r.adult && (r.vote_count || 0) >= voteFloorFor(r.type))
    .slice(0, PER_TITLE_CAP); // TMDB relevance order preserved
}

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
      primary_genre       TEXT,           -- genres[0], for genre-balanced serve
      genres      TEXT,                   -- full CSV genre list, for serve-time exclusion
      vote_average REAL,                  -- for the serve-time rating floor
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

    CREATE TABLE IF NOT EXISTS rec_state (
      profile_id TEXT PRIMARY KEY,
      built_at   INTEGER                  -- last successful pool build (rebuild trigger)
    );
  `);
  // Migrate older beta DBs that predate the serve-time-filter columns. ADD COLUMN
  // throws "duplicate column" once present, so each is best-effort.
  for (const [col, decl] of [['genres', 'TEXT'], ['vote_average', 'REAL']]) {
    try { db.get().exec(`ALTER TABLE recommended ADD COLUMN ${col} ${decl}`); } catch { /* already present */ }
  }
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
  db.get().prepare('DELETE FROM rec_state WHERE profile_id = ?').run(profileId);
}

// Upsert candidates, preserving the lifecycle columns (created_at, first_shown_at,
// times_shown, engaged_at, age_classification) on conflict so decay/serve state
// survives a rebuild.
function upsertCandidates(profileId, candidates) {
  init();
  const conn = db.get();
  const stmt = conn.prepare(`
    INSERT INTO recommended (profile_id, type, tmdb_id, imdb_id, title, year, primary_genre, genres, vote_average, affinity, rec_count, popularity, poster, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET
      affinity = excluded.affinity, rec_count = excluded.rec_count, popularity = excluded.popularity,
      primary_genre = excluded.primary_genre, genres = excluded.genres, vote_average = excluded.vote_average,
      title = excluded.title, year = excluded.year, poster = excluded.poster
  `);
  conn.prepare('BEGIN').run();
  try {
    const now = Date.now();
    for (const c of candidates) {
      stmt.run(profileId, c.type, c.tmdb_id, c.imdb_id || null, c.title, c.year, c.primary_genre || null, c.genres || null, c.vote_average ?? null, c.affinity, c.rec_count, c.popularity, c.poster || null, now);
    }
    conn.prepare('COMMIT').run();
  } catch (err) { conn.prepare('ROLLBACK').run(); throw err; }
}

function setAgeClassification(profileId, type, tmdbId, age) {
  db.get().prepare('UPDATE recommended SET age_classification = ? WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(age, profileId, type, String(tmdbId));
}

function hardDrop(profileId, type, tmdbId) {
  db.get().prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profileId, type, String(tmdbId));
}

// Age-gate the pool (docs/v6-features F5). Reuses the shipped v5.2 stack:
//   1. NSFW blacklist + anime age band (ALL profiles) via rebuild.applyAnimeGate
//      — porn is dropped for everyone; anime over the band for age-limited ones.
//      The MAL band it resolves is stored as age_classification.
//   2. LLM ACB pass (age-limited profiles only) — remove-only, per type.
// Failures are deleted from the pool (re-evaluated on the next build, not a
// permanent user rejection). TMDB `adult` porn was already dropped at build.
async function ageGatePool(profile, log = console) {
  init();
  const rebuild = require('./rebuild');   // lazy — heavy module, avoids load-order surprises
  const groq = require('./services/groq');
  const rows = getRecommended(profile.id, { limit: 100000 });
  if (!rows.length) return { dropped: 0, vetoed: 0, remain: 0 };
  const limit = profile.filters?.age_limit || 0;

  // 1. NSFW + anime band. Shape candidates as the metas applyAnimeGate expects.
  const metas = rows.map((r) => ({ id: r.imdb_id || r.tmdb_id, _tmdb_id: r.tmdb_id, name: r.title, _rtype: r.type }));
  const kept = await rebuild.applyAnimeGate(metas, profile, log);
  const keptKeys = new Set(kept.map((m) => key(m._rtype, m._tmdb_id)));
  for (const m of kept) if (m._certification) setAgeClassification(profile.id, m._rtype, m._tmdb_id, m._certification);
  let dropped = 0;
  for (const r of rows) if (!keptKeys.has(key(r.type, r.tmdb_id))) { hardDrop(profile.id, r.type, r.tmdb_id); dropped++; }

  // 2. LLM ACB pass — kids only, remove-only, per type.
  let vetoed = 0;
  if (limit > 0) {
    for (const type of ['movie', 'series']) {
      const survivors = getRecommended(profile.id, { type, limit: 100000 });
      if (!survivors.length) continue;
      const veto = await groq.ageGate(type, rebuild.judgementAge(profile.filters),
        survivors.map((r) => ({ id: r.tmdb_id, title: r.title, year: r.year, genres: r.primary_genre ? [r.primary_genre] : [], certification: r.age_classification })), log);
      for (const r of survivors) if (veto.has(r.tmdb_id)) { hardDrop(profile.id, r.type, r.tmdb_id); vetoed++; }
    }
  }
  log.log(`[rec] ${profile.name}: age gate — ${dropped} NSFW/band dropped, ${vetoed} LLM-vetoed, ${countRecommended(profile.id)} remain`);
  return { dropped, vetoed, remain: countRecommended(profile.id) };
}

// Reset: wipe the pool AND the user's don't-recommend flags for a profile.
function resetRecommendations(profileId) {
  init();
  db.get().prepare('DELETE FROM recommended WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM dont_recommend WHERE profile_id = ?').run(profileId);
  db.get().prepare('DELETE FROM rec_state WHERE profile_id = ?').run(profileId);
  return { cleared: true };
}

// Build the recommendation pool for a profile. Fetches TMDB recs per watched
// seed, scores by affinity, applies deterministic filters, upserts the top N.
// The caller runs ageGatePool() after this to make the pool age-safe.
async function buildRecommendations(profile, log = console) {
  init();
  const s = settings.getSettings();
  const tmdbKey = s?.keys?.tmdb_api_key;
  if (!tmdbKey) return { skipped: true, reason: 'no TMDB key in Server Config' };

  const filters = profile.filters || {};
  const seedsAll = watchedStore.getWatched(profile.id).filter((w) => w.tmdb_id); // most-recent first
  const seeds = seedsAll.slice(0, SEED_CAP);
  if (!seeds.length) return { skipped: true, reason: 'no watched titles to seed from' };

  // Fetch recommendations per seed, then keep only the STRONGEST few per title
  // (vote-count noise gate, TMDB relevance order). This is the matching quality
  // lever — ~5/title instead of ~20. User-preference filters (rating floor,
  // excluded genres, recency) are NOT applied here — they run at serve time over
  // this stored pool, so changing one takes effect with no rebuild.
  const recsBySeed = new Map();
  let rawFetched = 0;
  for (let i = 0; i < seeds.length; i += 5) {
    const chunk = seeds.slice(i, i + 5);
    await Promise.all(chunk.map(async (w) => {
      try {
        const recs = await tmdb.getRecommendations(tmdbKey, w.type, w.tmdb_id);
        rawFetched += recs.length;
        recsBySeed.set(key(w.type, w.tmdb_id), selectStrong(recs));
      } catch (err) { log.warn(`[rec] recs for ${w.title} failed: ${err.message}`); }
    }));
  }

  const candidates = computeAffinity(seeds, recsBySeed);
  const watchedIds = watchedStore.watchedIdSets(profile.id);
  const dont = dontRecommendKeys(profile.id);
  const genreMap = await tmdb.getGenreMap(tmdbKey);

  const kept = [];
  for (const c of candidates.values()) {
    if (watchedIds.tmdb.has(c.tmdb_id)) continue;             // already watched
    if (dont.has(key(c.type, c.tmdb_id))) continue;           // user-rejected / decayed
    // Resolve genre names once and store the FULL list — serve-time exclusion
    // needs every genre, not just the primary, or a title whose secondary genre
    // is excluded would slip through.
    const names = (c.genre_ids || []).map((g) => genreMap[g]).filter(Boolean);
    c.primary_genre = names[0] || null;
    c.genres = names.join(',');
    kept.push(c);
  }
  kept.sort((a, b) => b.affinity - a.affinity || b.popularity - a.popularity);
  const top = kept.slice(0, STORE_CAP);

  // Dress the survivors for Stremio: resolve the tt id (catalogs need it) and a
  // full poster URL, and tag the Anime pseudo-genre so serve-time exclusion is a
  // pure string check. No tt id -> not servable -> dropped. This is the only
  // heavy step (one light TMDB call each); it runs in the background build.
  await animeMap.ensureLoaded(log);
  const servable = [];
  for (let i = 0; i < top.length; i += 8) {
    const chunk = top.slice(i, i + 8);
    await Promise.all(chunk.map(async (c) => {
      const imdb = await tmdb.imdbFor(tmdbKey, c.type, c.tmdb_id);
      if (!imdb) return;                       // Stremio needs a tt id
      c.imdb_id = imdb;
      c.poster = tmdb.posterUrl(c.poster);     // bare path -> full URL
      if (animeMap.isAnime(imdb, c.tmdb_id) && !c.genres.split(',').includes('Anime')) {
        c.genres = c.genres ? `Anime,${c.genres}` : 'Anime';
      }
      servable.push(c);
    }));
  }
  upsertCandidates(profile.id, servable);
  setBuiltAt(profile.id);

  log.log(`[rec] ${profile.name}: ${seeds.length} seed(s), ${rawFetched} raw recs → top-${PER_TITLE_CAP}/title → ${candidates.size} unique → ${kept.length} after de-dupe → ${servable.length} servable → stored (total ${countRecommended(profile.id)})`);
  return { seeds: seeds.length, raw: rawFetched, strong: candidates.size, kept: kept.length, stored: servable.length, total: countRecommended(profile.id) };
}

// ---- build state ----
function setBuiltAt(profileId, at = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO rec_state (profile_id, built_at) VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET built_at = excluded.built_at
  `).run(profileId, at);
}

function getBuiltAt(profileId) {
  init();
  return db.get().prepare('SELECT built_at FROM rec_state WHERE profile_id = ?').get(profileId)?.built_at || 0;
}

// ---- serve-time selection (F6) ----
// Cheap classification -> minimum age, for the serve-time band re-check. Keyed
// by MAL band codes (the only classifications ageGatePool stamps) plus a few
// common certs. Unknown -> null -> KEPT: an unrated title is not "too old",
// same rule the build-time gate uses. This re-check is a safety net for a
// LOWERED age limit between builds; the authoritative gate is still at build.
const CERT_MIN_AGE = { G: 0, PG: 8, 'PG-13': 13, R: 17, 'R+': 17 };
function certMinAge(cert) {
  return cert && cert in CERT_MIN_AGE ? CERT_MIN_AGE[cert] : null;
}

// Round-robin across primary_genre buckets: take the strongest remaining title
// from each genre in turn, so one prolific genre can't dominate the row. Rows
// arrive affinity DESC, so each bucket is already strongest-first. NEVER
// force-fills — if the balanced set is smaller than `limit`, that's the honest
// size (quality over quantity), not padded with weak matches.
function balanceByGenre(rows, limit = SERVE_LIMIT) {
  const buckets = new Map();
  for (const r of rows) {
    const g = r.primary_genre || 'Other';
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(r);
  }
  // Rotate genres strongest-bucket-first for a stable, quality-led order.
  const order = [...buckets.entries()]
    .sort((a, b) => (b[1][0]?.affinity || 0) - (a[1][0]?.affinity || 0))
    .map(([g]) => g);
  const out = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const g of order) {
      const bucket = buckets.get(g);
      if (bucket && bucket.length) {
        out.push(bucket.shift());
        progressed = true;
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

// PURE serve-time selection over stored pool rows. Applies USER PREFERENCES
// (rating floor, excluded genres, recency) + a cheap age-band re-check, then
// balances across genres. Exported for testing. Nothing here touches the network.
function selectServe(rows, filters = {}, { nowYear = new Date().getFullYear(), limit = SERVE_LIMIT } = {}) {
  const minRating = filters.min_rating || 0;
  const excluded = new Set(filters.excluded_genres || []);
  const maxAge = filters.max_age_years || 0;
  const judge = (filters.age_limit || 0) + 1;
  const kids = (filters.age_limit || 0) > 0;

  const passed = (rows || []).filter((r) => {
    if (!r.imdb_id) return false;                                             // not servable
    if (minRating > 0 && r.vote_average > 0 && r.vote_average < minRating) return false; // rating floor (0 = unknown -> kept)
    const genres = (r.genres || '').split(',').filter(Boolean);
    if (genres.some((g) => excluded.has(g))) return false;                    // excluded genre (full list, incl. Anime)
    if (maxAge > 0 && r.year && r.year < nowYear - maxAge) return false;      // recency
    if (kids) { const m = certMinAge(r.age_classification); if (m !== null && m > judge) return false; } // lowered-limit safety net
    return true;
  });
  return balanceByGenre(passed, limit);
}

// Build Stremio catalog metas for a profile's AI recommendations of one type.
// Cache-only + cheap (no external calls) — safe for the addon request path.
function serveRecommendations(profile, type, { limit = SERVE_LIMIT } = {}) {
  init();
  const rows = getRecommended(profile.id, { type, limit: 100000 });
  return selectServe(rows, profile.filters || {}, { limit }).map((r) => ({
    id: r.imdb_id,
    type,
    name: r.title,
    poster: r.poster || null,
    releaseInfo: r.year ? String(r.year) : null,
    genres: (r.genres || '').split(',').filter(Boolean),
  }));
}

// Background rebuild trigger. The pool only needs rebuilding when there are new
// SEEDS (watched history moved since the last build) or it's empty — user-filter
// changes now apply at serve time, so they never trigger a rebuild. Serialized
// per profile with an in-memory lock.
const buildLocks = new Set();
function needsBuild(profileId) {
  if (countRecommended(profileId) === 0) return true;
  return watchedStore.newestWatchedMs(profileId) > getBuiltAt(profileId);
}
async function ensureBuilt(profile, log = console) {
  init();
  if (buildLocks.has(profile.id)) return { skipped: 'locked' };
  if (!needsBuild(profile.id)) return { skipped: 'fresh' };
  buildLocks.add(profile.id);
  try {
    const r = await buildRecommendations(profile, log);
    if (!r.skipped) await ageGatePool(profile, log);
    return r;
  } finally {
    buildLocks.delete(profile.id);
  }
}

module.exports = {
  init,
  computeAffinity,
  selectStrong,
  buildRecommendations,
  ageGatePool,
  ensureBuilt,
  needsBuild,
  resetRecommendations,
  upsertCandidates,
  getRecommended,
  countRecommended,
  dontRecommendKeys,
  addDontRecommend,
  deleteForProfile,
  selectServe,
  balanceByGenre,
  certMinAge,
  serveRecommendations,
  setBuiltAt,
  getBuiltAt,
  HALF_LIFE_DAYS,
  PER_TITLE_CAP,
  SERVE_LIMIT,
};
