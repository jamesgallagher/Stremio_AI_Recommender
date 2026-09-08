// Recommendation store + builder + serve engine (v6, features F5/F6).
//
// BUILD (background): for each watched title, pull TMDB's per-title
// /recommendations, aggregate into candidates scored by RECENCY-WEIGHTED
// AFFINITY (a recent watch steers harder than an old one — the "watched
// Pirates 1 today → Pirates 2 tops the list" behaviour), keep the strongest
// few per title (only those clearing the vote-count floor — the one build-time
// user preference: a sub-floor title must never be stored), resolve tt ids +
// posters + IMDb ratings, age-gate, and upsert a FULL pool (rating + full genre
// list stored, NOT pre-filtered by the serve-time preferences).
//
// SERVE (request path, cheap, no network): selectServe applies the user's
// serve-time preferences (rating floor, excluded genres, movies-only recency,
// list size) + a cheap age-band re-check over the stored pool, then
// genre-balances the result — so changing one takes effect with no rebuild.
//
// Tables: `recommended` (the candidate pool, with a decay lifecycle),
// `dont_recommend` (user rejections + decay-outs, excluded from build/serve),
// and `rec_state` (last build time, the rebuild trigger).
const db = require('./db');
const settings = require('./settings');
const tmdb = require('./services/tmdb');
const animeMap = require('./services/animeMap');
const watchedStore = require('./watchedStore');
// The candidate-generation half of the build now lives in the Genesis Engine
// (SC-01). recommendationStore keeps the pool table, serve path, decay, age gate
// and the IMDb-rating heal — all engine-agnostic — and re-exports Genesis's pure
// candidate logic (computeAffinity / selectStrong) + parameters (HALF_LIFE_DAYS /
// PER_TITLE_CAP) so existing imports and tests resolve them from their old home.
const genesis = require('./engines/genesis');

const SERVE_LIMIT = 100;    // max titles in a served, genre-balanced catalog
const DAY_MS = 24 * 3600e3;

// IMDb-rating re-enrichment (v6.38). The stored imdb_rating is a point-in-time
// MDBList snapshot from the build that stored the title; the candidate build only
// re-enriches this build's `servable`, so an ORPHAN row (no longer a live TMDB
// candidate) would keep its NULL/stale rating forever and leak past the serve
// rating floor via the TMDB vote_average fallback. refreshStaleRatings re-resolves
// due rows each build: NULL ratings chased daily (a freshly released title is
// unrated on MDBList at first, then isn't), known ratings refreshed monthly.
// Capped per build so a large pool can't hammer MDBList in one pass.
const RATING_NULL_RECHECK_MS = 1 * DAY_MS;
const RATING_STALE_RECHECK_MS = 30 * DAY_MS;
const RATING_RECHECK_CAP = 150;

// ---- Recommendation decay (v6, params confirmed 2026-08-19) ----
// A recommendation the user is repeatedly SHOWN but never engages with is an
// implicit rejection — it decays out. Decay tracks a VISIBLE STREAK (consecutive
// days shown), not wall-clock age: a title out-competed by newer picks falls off
// and gets a clean slate if it climbs back, so only the genuinely-ignored-while-
// persistently-shown titles die. Impressions are counted once per day per title.
// Manual "Don't recommend" (🚫) is the permanent force-out for anyone impatient.
const DECAY_WINDOW_MS = 60 * DAY_MS;   // sustained visibility before a title may decay
const FALLOFF_GAP_MS = 14 * DAY_MS;    // no impression this long → streak resets
const DECAY_COOLDOWN_MS = 90 * DAY_MS; // a decayed title may return to the pool after this
const DECAY_MIN_DAYS = 8;              // must be shown on ≥ this many distinct days to decay

// The vote-count floor is a build-time STORAGE gate (decided 2026-08-27): a
// sub-floor title must never be stored, not merely hidden at serve. Genesis
// applies it at candidate selection (selectStrong, now in engines/genesis.js);
// purgeBelowVoteFloor below clears any already-stored row that has since fallen
// under the floor, for EVERY engine. The rating floor / genres / recency are
// DIFFERENT — cheap serve-time preferences over the stored pool (no rebuild).

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
      vote_average REAL,                  -- TMDB rating; serve-time rating-floor fallback
      imdb_rating  REAL,                  -- IMDb rating (MDBList) = the number on the poster badge; the rating floor prefers this
      imdb_rating_at INTEGER,             -- when imdb_rating was last resolved from MDBList (null = never); drives the stale/null re-enrichment pass
      vote_count   INTEGER,               -- TMDB vote count; the build-time vote-count floor gates + purges on this
      age_classification  TEXT,           -- filled by the age-gate slice
      affinity    REAL,                   -- recency-weighted score (primary rank)
      rec_count   INTEGER,                -- raw # of watched titles that recommended it
      because_title TEXT,                 -- strongest-contributing watched title (debug "why")
      popularity  REAL,
      poster      TEXT,
      first_shown_at INTEGER,             -- first-ever impression (informational)
      times_shown INTEGER DEFAULT 0,      -- all-time distinct days shown (informational)
      streak_started_at INTEGER,          -- start of the current continuous impression run
      times_shown_in_streak INTEGER DEFAULT 0, -- distinct days shown in the current streak
      last_shown_at INTEGER,              -- last impression (fall-off detection + day de-dupe)
      engaged_at  INTEGER,                -- real interest signal → decay off (reserved)
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
  for (const [col, decl] of [['genres', 'TEXT'], ['vote_average', 'REAL'], ['imdb_rating', 'REAL'], ['imdb_rating_at', 'INTEGER'], ['vote_count', 'INTEGER'], ['because_title', 'TEXT'],
    ['streak_started_at', 'INTEGER'], ['times_shown_in_streak', 'INTEGER DEFAULT 0'], ['last_shown_at', 'INTEGER']]) {
    try { db.get().exec(`ALTER TABLE recommended ADD COLUMN ${col} ${decl}`); } catch { /* already present */ }
  }
  ready = true;
}

const key = (type, tmdbId) => `${type}:${tmdbId}`;

// Titles to suppress from build + serve. Explicit user rejections are permanent;
// DECAYED entries expire after the cooldown so a decayed title gets another
// chance if it's still relevant on a later build.
function dontRecommendKeys(profileId, nowMs = Date.now()) {
  init();
  const rows = db.get().prepare('SELECT type, tmdb_id, reason, at FROM dont_recommend WHERE profile_id = ?').all(profileId);
  const out = new Set();
  for (const r of rows) {
    if (r.reason === 'decayed' && r.at && (nowMs - r.at) > DECAY_COOLDOWN_MS) continue; // cooldown expired → allow back
    out.add(key(r.type, r.tmdb_id));
  }
  return out;
}

function addDontRecommend(profileId, type, tmdbId, reason = 'user', at = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO dont_recommend (profile_id, type, tmdb_id, reason, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET reason = excluded.reason, at = excluded.at
  `).run(profileId, type, String(tmdbId), reason, at);
  // If it was in the pool, drop it now.
  db.get().prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profileId, type, String(tmdbId));
}

// Undo a USER rejection (Mobile Companion "Undo" after a swipe-remove). Scoped to
// reason='user' so it can NEVER resurrect a decayed-out title mid-cooldown — the
// decay lifecycle stays intact. Returns the number of flags cleared (0 or 1).
// Clears the flag only; the pool row (deleted on suppress) returns on the next
// build. The Companion re-inserts the row optimistically for instant UX.
function removeDontRecommend(profileId, type, tmdbId) {
  init();
  const r = db.get().prepare("DELETE FROM dont_recommend WHERE profile_id = ? AND type = ? AND tmdb_id = ? AND reason = 'user'").run(profileId, type, String(tmdbId));
  return Number(r.changes || 0);
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
// `ratingCheckedAt` stamps imdb_rating_at for the rows written here — pass the
// build time when this build resolved IMDb ratings (MDBList key present), or null
// when it couldn't (no key), so refreshStaleRatings picks them up later. On
// conflict both imdb_rating and imdb_rating_at COALESCE to the stored value when
// this build's value is null, so a transient MDBList miss never wipes a known
// rating (which would let the title leak past the floor until the next refresh).
function upsertCandidates(profileId, candidates, { ratingCheckedAt = null } = {}) {
  init();
  const conn = db.get();
  const stmt = conn.prepare(`
    INSERT INTO recommended (profile_id, type, tmdb_id, imdb_id, title, year, primary_genre, genres, vote_average, imdb_rating, imdb_rating_at, vote_count, affinity, rec_count, because_title, popularity, poster, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET
      affinity = excluded.affinity, rec_count = excluded.rec_count, popularity = excluded.popularity,
      primary_genre = excluded.primary_genre, genres = excluded.genres, vote_average = excluded.vote_average,
      imdb_rating = COALESCE(excluded.imdb_rating, recommended.imdb_rating),
      imdb_rating_at = COALESCE(excluded.imdb_rating_at, recommended.imdb_rating_at), vote_count = excluded.vote_count,
      because_title = excluded.because_title, title = excluded.title, year = excluded.year, poster = excluded.poster
  `);
  conn.prepare('BEGIN').run();
  try {
    const now = Date.now();
    for (const c of candidates) {
      stmt.run(profileId, c.type, c.tmdb_id, c.imdb_id || null, c.title, c.year, c.primary_genre || null, c.genres || null, c.vote_average ?? null, c.imdb_rating ?? null, ratingCheckedAt, c.vote_count ?? null, c.affinity, c.rec_count, c.because_title || null, c.popularity, c.poster || null, now);
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

// Enforce the vote-count floor as a STORAGE gate (decided 2026-08-27): drop any
// pool row whose TMDB vote count is confirmed below the profile's floor (movies
// vs series ⅕, via tmdb.voteFloor). selectStrong keeps new sub-floor titles from
// being added; this clears ones already stored — e.g. under the old fixed noise
// gate, or after the floor is raised. A dropped title is NOT a user rejection: it
// returns naturally on a later build once its vote count climbs past the floor.
// Rows with an unknown (NULL) vote count are left for a rebuild to re-evaluate.
function purgeBelowVoteFloor(profileId, filters = {}) {
  init();
  const r = db.get().prepare(`
    DELETE FROM recommended
    WHERE profile_id = ? AND vote_count IS NOT NULL
      AND ((type = 'movie'  AND vote_count < ?)
        OR (type = 'series' AND vote_count < ?))
  `).run(profileId, tmdb.voteFloor(filters, 'movie'), tmdb.voteFloor(filters, 'series'));
  return Number(r.changes || 0);
}

// Re-resolve IMDb ratings for stored pool rows that are DUE (see the RATING_*
// constants): NULL ratings (unrated when first built) chased frequently, known
// ratings refreshed occasionally. This is the ONLY thing that heals an orphan
// row — a title that has dropped out of the live TMDB candidate set is never
// re-enriched by the candidate build, so without this its NULL/stale rating
// would let it slip past the serve-time floor via the TMDB fallback forever.
// Network-bound (MDBList), so it runs in the background build, NEVER on the serve
// path. Rows we check but that are still unrated get their timestamp stamped so
// we don't re-hit them until due again. A failed batch leaves the timestamp
// untouched so those rows retry next build. `fetchRatings(type, ids) ->
// Promise<Map<imdbId, number|null>>` is injectable for tests (defaults to
// MDBList). Returns { checked, updated }.
async function refreshStaleRatings(profileId, mdblistKey, log = console, { now = Date.now(), fetchRatings, cap = RATING_RECHECK_CAP } = {}) {
  init();
  if (!mdblistKey) return { checked: 0, updated: 0 };
  const nullCut = now - RATING_NULL_RECHECK_MS;
  const staleCut = now - RATING_STALE_RECHECK_MS;
  const due = db.get().prepare(`
    SELECT type, imdb_id FROM recommended
    WHERE profile_id = ? AND imdb_id IS NOT NULL
      AND (imdb_rating_at IS NULL
        OR (imdb_rating IS NULL     AND imdb_rating_at < ?)
        OR (imdb_rating IS NOT NULL AND imdb_rating_at < ?))
    ORDER BY imdb_rating_at IS NOT NULL, imdb_rating_at ASC
    LIMIT ?
  `).all(profileId, nullCut, staleCut, cap);
  if (!due.length) return { checked: 0, updated: 0 };

  const getRatings = fetchRatings
    || ((type, ids) => require('./services/mdblist').imdbRatings(mdblistKey, type, ids, log));
  const conn = db.get();
  const setRating = conn.prepare('UPDATE recommended SET imdb_rating = ?, imdb_rating_at = ? WHERE profile_id = ? AND type = ? AND imdb_id = ?');
  const stampOnly = conn.prepare('UPDATE recommended SET imdb_rating_at = ? WHERE profile_id = ? AND type = ? AND imdb_id = ?');
  let updated = 0;
  for (const t of ['movie', 'series']) {
    const ids = due.filter((r) => r.type === t).map((r) => r.imdb_id);
    if (!ids.length) continue;
    let ratings;
    try {
      ratings = await getRatings(t, ids);
    } catch (err) {
      log.warn(`[rec] rating refresh (${t}) failed: ${err.message} — retrying next build`);
      continue; // leave imdb_rating_at untouched so these rows stay due
    }
    conn.prepare('BEGIN').run();
    try {
      for (const id of ids) {
        const v = ratings.get(id);
        if (v != null) { setRating.run(v, now, profileId, t, id); updated++; }
        else stampOnly.run(now, profileId, t, id); // checked, still unrated
      }
      conn.prepare('COMMIT').run();
    } catch (err) { conn.prepare('ROLLBACK').run(); throw err; }
  }
  return { checked: due.length, updated };
}

// Age-gate the pool (docs/v6-features F5). Reuses the shipped v5.2 stack:
//   1. NSFW blacklist + anime age band (ALL profiles) via rebuild.applyAnimeGate
//      — porn is dropped for everyone; anime over the band for age-limited ones.
//      The MAL band it resolves is stored as age_classification.
//   2. LLM ACB pass (age-limited profiles only) — remove-only, per type.
// Failures are deleted from the pool (re-evaluated on the next build, not a
// permanent user rejection). TMDB `adult` porn was already dropped at build.
async function ageGatePool(profile, log = console, onProgress = () => {}) {
  init();
  const rebuild = require('./rebuild');   // lazy — heavy module, avoids load-order surprises
  const groq = require('./services/groq');
  const rows = getRecommended(profile.id, { limit: 100000 });
  if (!rows.length) return { dropped: 0, vetoed: 0, remain: 0 };
  const limit = profile.filters?.age_limit || 0;
  onProgress(0, 'Age-gating the pool…');

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
    onProgress(50, 'Age-checking with the LLM…');
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

// Clear ONE type's pool slice — SC-03. Used when a profile's engine_<type> changes
// (a new selection, or an age-limit raise that revokes an unrestricted engine): the
// candidate PRODUCER changed, so stale rows from the previous engine must not linger
// (overview §5.4). Deliberately leaves dont_recommend ALONE — a user's rejections /
// decays are engine-independent and persist across an engine swap. Also resets the
// profile's build state so needsBuild → true and the next ensureBuilt rebuilds the
// pool. (We mark build-needed here rather than teaching needsBuild to treat an empty
// slice as build-needed: an empty slice is ambiguous — a single-type watcher legitimately
// has an empty other slice — and would re-trigger every tick. buildRecommendations
// rebuilds both types anyway, so the cost is identical.) Returns rows removed.
function clearType(profileId, type) {
  init();
  const r = db.get().prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ?').run(profileId, String(type));
  db.get().prepare('DELETE FROM rec_state WHERE profile_id = ?').run(profileId); // mark build-needed
  return Number(r.changes || 0);
}

// Build the recommendation pool for a profile — now a thin TWO-TYPE GENESIS
// WRAPPER (SC-01). Genesis produces candidates per type; the shared pipeline
// (engines/pipeline.js) resolves/enriches/upserts/purges each type's slice. The
// caller runs ageGatePool() after this to make the pool age-safe. Callers/tests
// are unchanged — the return still carries { skipped?, seeds, stored, … } and
// per-type dispatch-by-config arrives in SC-03.
//
// NOTE: the STORE_CAP (300) is now applied PER TYPE (in Genesis), not across the
// combined candidate set as the pre-abstraction monolith did. This is the
// architecturally correct seam for SC-03 (independent per-type engines) and
// matches the existing per-type SEED_CAP. Served catalogs are IDENTICAL — serve
// only ever reads the strongest list_size titles per type, and the per-type pool
// is a superset of the old combined pool that adds only weaker, never-served
// rows. The one observable difference is a larger stored `total` for very active
// profiles (deeper storage per type).
async function buildRecommendations(profile, log = console, onProgress = () => {}) {
  init();
  const s = settings.getSettings();
  const tmdbKey = s?.keys?.tmdb_api_key;
  if (!tmdbKey) return { skipped: true, reason: 'no TMDB key in Server Config' };

  const engines = require('./engines');
  const pipeline = require('./engines/pipeline');
  const filters = profile.filters || {};
  const ctx = {
    tmdbKey,
    mdblistKey: settings.keyFor(profile, 'mdblist_api_key'),
    settings: s,
    filters,
    log,
  };
  const spans = { movie: [0, 50], series: [50, 100] };
  const band = (lo, hi) => (pct, label) => onProgress(lo + (pct / 100) * (hi - lo), label);

  // SC-03: dispatch each type to the engine the profile selected for it (Genesis
  // is the guaranteed safe floor — resolveFor never returns an unknown engine, one
  // that doesn't support the type, or an age-inappropriate one, so this can never
  // disable or unsafely fill a type). A type whose resolved engine's requirements
  // are unmet is SKIPPED with a logged reason and its existing pool rows are LEFT
  // SERVING — a skip must NEVER wipe a slice (only an engine CHANGE does, via
  // config.updateProfile → clearType). The engine id per type is threaded into the
  // result + logs so the Advanced tab / API can show who produced each catalog.
  const results = {};
  const engineIds = {};
  const missing = [];
  const skipResult = (engine) => ({ skipped: true, engine: engine.id, seeds: 0, raw: 0, strong: 0, kept: 0, stored: 0, purged: 0 });
  for (const type of ['movie', 'series']) {
    const engine = engines.resolveFor(profile, type);
    engineIds[type] = engine.id;
    const req = engine.requirements(profile);
    if (!req.ok) {
      const miss = req.missing || [];
      missing.push(...miss);
      log.warn(`[rec] ${profile.name}/${type}: ${engine.name} unavailable — missing ${miss.join(', ') || 'requirements'} (keeping existing ${type} rows)`);
      results[type] = { ...skipResult(engine), missing: miss };
      continue;
    }
    log.log(`[rec] ${profile.name}/${type}: building with ${engine.name}`);
    const r = await pipeline.runEngineBuild(profile, type, engine, ctx, band(...spans[type]));
    r.engine = engine.id;
    results[type] = r;
  }
  const m = results.movie;
  const sr = results.series;

  // Nothing to build — either no type's engine was ready (all requirement-skipped)
  // or the engines ran but found no seeds. DON'T stamp built_at, so needsBuild
  // keeps retrying until the inputs (a connection, watch history) appear. A
  // requirements miss reports what's missing; the ready-but-empty case keeps its
  // long-standing reason so existing status text is unchanged.
  const ranAny = !m.skipped || !sr.skipped;
  if (!ranAny || (m.seeds + sr.seeds) === 0) {
    const reason = !ranAny
      ? `engine not ready — missing ${[...new Set(missing)].join(', ') || 'requirements'}`
      : 'no watched titles to seed from';
    return { skipped: true, reason, engines: engineIds, movie: m, series: sr };
  }

  // Whole-pool IMDb-rating heal — runs ONCE after BOTH types (like the age gate),
  // so an orphan/stale row of either type is re-enriched and can't leak past the
  // serve rating floor via the TMDB fallback. Best-effort. With no key the floor
  // degrades to TMDB's rating; warn the operator (mirrors the portal warning).
  let refreshed = { checked: 0, updated: 0 };
  if (ctx.mdblistKey) {
    try { refreshed = await refreshStaleRatings(profile.id, ctx.mdblistKey, log); }
    catch (err) { log.warn(`[rec] ${profile.name}: rating refresh failed — ${err.message}`); }
  } else if ((filters.min_rating || 0) > 0) {
    log.warn(`[rec] ${profile.name}: rating floor ≥ ${filters.min_rating} is set but no MDBList key — the floor falls back to TMDB's rating, not the IMDb number on the poster (lower-rated titles can slip through)`);
  }

  setBuiltAt(profile.id);

  const seeds = m.seeds + sr.seeds;
  const stored = m.stored + sr.stored;
  const purged = m.purged + sr.purged;
  log.log(`[rec] ${profile.name}: ${seeds} seed(s) → ${m.strong + sr.strong} unique → ${stored} servable (movies ${m.stored} via ${engineIds.movie}, series ${sr.stored} via ${engineIds.series})${purged ? `, ${purged} purged below vote floor` : ''}${refreshed.updated ? `, ${refreshed.updated} rating(s) refreshed` : ''} (total ${countRecommended(profile.id)})`);
  return {
    seeds,
    raw: m.raw + sr.raw,
    strong: m.strong + sr.strong,
    kept: m.kept + sr.kept,
    stored,
    purged,
    ratingsRefreshed: refreshed.updated,
    total: countRecommended(profile.id),
    engines: engineIds, // which engine produced each type (SC-03)
    movie: m,           // per-type detail (engine id, stored, or {skipped,missing})
    series: sr,
  };
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

// PURE: does a stored row satisfy the profile's age BAND? For an age-limited
// profile a title whose classification maps to a minimum age above the
// judgement age (age_limit + 1) is rejected; everything passes for an
// unlimited (adult) profile, and an unrated title (min age null) is never "too
// old". This is the cheap cert/MAL re-check selectServe already ran inline —
// extracted so the Companion's "entire recommendations list" view can reuse it,
// keeping that view vetted-only for a kids profile even though it isn't
// genre-balanced or size-limited. NOT a substitute for the build-time LLM gate
// (the pool is already LLM-vetted); this is the same lowered-limit safety net.
function passesAgeBand(row, filters = {}) {
  const limit = filters.age_limit || 0;
  if (limit <= 0) return true;
  const m = certMinAge(row.age_classification);
  return m === null || m <= limit + 1;
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

  const passed = (rows || []).filter((r) => {
    if (!r.imdb_id) return false;                                             // not servable
    // Rating floor: judged against the IMDb rating shown on the poster (via
    // MDBList) when we have it, falling back to TMDB's rating only for titles
    // with no IMDb rating. Neither known -> kept ("no rating" isn't "bad").
    const shownRating = r.imdb_rating > 0 ? r.imdb_rating : (r.vote_average || 0);
    if (minRating > 0 && shownRating > 0 && shownRating < minRating) return false;
    const genres = (r.genres || '').split(',').filter(Boolean);
    if (genres.some((g) => excluded.has(g))) return false;                    // excluded genre (full list, incl. Anime)
    // Recency window — MOVIES ONLY. Series run for years from an old first-air
    // date, so a recency cut-off would wrongly drop still-running shows.
    if (maxAge > 0 && r.type === 'movie' && r.year && r.year < nowYear - maxAge) return false;
    if (!passesAgeBand(r, filters)) return false;                            // lowered-limit safety net (adult profile: always true)
    return true;
  });
  return balanceByGenre(passed, limit);
}

// The user's configured "List size (per catalog)" filter — the number of titles
// the AI catalogs actually serve. Clamped to the same [5,50] band the portal
// enforces so a hand-edited profiles.json can't ask for an absurd catalog, and
// falls back to the shipped default (20) only when unset. Applied at SERVE time
// like the other user preferences (rating floor, genres, recency), so changing
// it takes effect immediately with no rebuild.
const LIST_SIZE_DEFAULT = 20;
const LIST_SIZE_MIN = 5;
const LIST_SIZE_MAX = 50;
function listSizeFor(profile) {
  const n = parseInt(profile?.filters?.list_size, 10);
  if (!Number.isFinite(n)) return LIST_SIZE_DEFAULT;
  return Math.min(LIST_SIZE_MAX, Math.max(LIST_SIZE_MIN, n));
}

// Build Stremio catalog metas for a profile's AI recommendations of one type.
// Cache-only + cheap (local writes only, no external calls) — safe for the addon
// request path. Records one impression per served title (fuels decay). The served
// count is the profile's list_size filter (an explicit `limit` still overrides).
function serveRecommendations(profile, type, { limit } = {}) {
  init();
  const rows = getRecommended(profile.id, { type, limit: 100000 });
  const picked = selectServe(rows, profile.filters || {}, { limit: limit ?? listSizeFor(profile) });
  recordImpressions(profile.id, picked);
  return picked.map((r) => ({
    id: r.imdb_id,
    type,
    name: r.title,
    poster: r.poster || null,
    releaseInfo: r.year ? String(r.year) : null,
    genres: (r.genres || '').split(',').filter(Boolean),
  }));
}

// ---- decay lifecycle (v6) ----
const dayOf = (ms) => Math.floor((ms || 0) / DAY_MS);

// PURE: given a pool row's current streak state + now, compute the updated
// impression columns. Counts at most once per calendar day; a gap longer than
// the fall-off resets the streak (a fresh chance for an out-competed title).
function impressionStep(row, nowMs = Date.now()) {
  const last = row.last_shown_at || 0;
  const fellOff = !last || (nowMs - last) > FALLOFF_GAP_MS;
  const newDay = dayOf(last) !== dayOf(nowMs);
  return {
    streak_started_at: fellOff ? nowMs : (row.streak_started_at || nowMs),
    times_shown_in_streak: fellOff ? 1 : (row.times_shown_in_streak || 0) + (newDay ? 1 : 0),
    last_shown_at: nowMs,
    times_shown: (row.times_shown || 0) + (newDay ? 1 : 0),
    first_shown_at: row.first_shown_at || nowMs,
  };
}

// PURE: does this row qualify to decay out? Persistently shown (streak past the
// window, on ≥ the day floor) AND never engaged. Watched titles never reach here
// — they're excluded from the pool at build. `windowMs` is the sustained-
// visibility window: DECAY_WINDOW_MS by default, or the profile's configured
// title_decay_days (see decayWindowMsFor). Exported for testing.
function shouldDecay(row, nowMs = Date.now(), windowMs = DECAY_WINDOW_MS) {
  if (row.engaged_at) return false;
  if (!row.streak_started_at) return false;
  if ((nowMs - row.streak_started_at) <= windowMs) return false;
  return (row.times_shown_in_streak || 0) >= DECAY_MIN_DAYS;
}

// The sustained-visibility window (ms) for a profile, or null when decay is OFF.
// Title decay is opt-in (v6.37): filters.title_decay_enabled gates it, and
// filters.title_decay_days sets the window (config clamps it to 14–365). Callers
// use null to skip decay entirely for that profile.
function decayWindowMsFor(profile) {
  const f = (profile && profile.filters) || {};
  if (!f.title_decay_enabled) return null;
  const days = Number(f.title_decay_days) || (DECAY_WINDOW_MS / DAY_MS);
  return days * DAY_MS;
}

// Record one impression per served title (batched, day-de-duped so pagination /
// prefetch don't inflate the count).
function recordImpressions(profileId, rows, nowMs = Date.now()) {
  if (!rows || !rows.length) return;
  init();
  const conn = db.get();
  const stmt = conn.prepare(`UPDATE recommended SET
      streak_started_at = ?, times_shown_in_streak = ?, last_shown_at = ?, times_shown = ?, first_shown_at = ?
    WHERE profile_id = ? AND type = ? AND tmdb_id = ?`);
  conn.prepare('BEGIN').run();
  try {
    for (const r of rows) {
      const u = impressionStep(r, nowMs);
      stmt.run(u.streak_started_at, u.times_shown_in_streak, u.last_shown_at, u.times_shown, u.first_shown_at, profileId, r.type, String(r.tmdb_id));
    }
    conn.prepare('COMMIT').run();
  } catch (err) { conn.prepare('ROLLBACK').run(); throw err; }
}

// Move every decay-qualifying title to dont_recommend(reason='decayed'). Runs on
// the hourly tick — but only for profiles that opted in; the caller gates on
// decayWindowMsFor and passes that window here. Returns { decayed }.
function applyDecay(profileId, { nowMs = Date.now(), log = console, windowMs = DECAY_WINDOW_MS } = {}) {
  init();
  const rows = db.get().prepare(
    'SELECT type, tmdb_id, streak_started_at, times_shown_in_streak, engaged_at FROM recommended WHERE profile_id = ?',
  ).all(profileId);
  let decayed = 0;
  for (const r of rows) {
    if (shouldDecay(r, nowMs, windowMs)) { addDontRecommend(profileId, r.type, r.tmdb_id, 'decayed', nowMs); decayed++; }
  }
  if (decayed) log.log(`[decay] ${profileId}: ${decayed} title(s) decayed out (shown ${DECAY_MIN_DAYS}+ days over ${Math.round(windowMs / DAY_MS)}d, never engaged)`);
  return { decayed };
}

// Soft engagement: opening a title's detail page (/meta) resets its streak clock
// (light interest — not a permanent 'engaged'), so an actively-opened title won't
// decay. No-op when the title isn't in this profile's pool.
function noteMetaOpen(profileId, type, imdbId, nowMs = Date.now()) {
  init();
  db.get().prepare('UPDATE recommended SET streak_started_at = ?, times_shown_in_streak = 0 WHERE profile_id = ? AND type = ? AND imdb_id = ?')
    .run(nowMs, profileId, type, imdbId);
}

// The pool only needs rebuilding when there are new SEEDS (watched history moved
// since the last build) or it's empty — user-filter changes now apply at serve
// time, so they never trigger a rebuild.
function needsBuild(profileId) {
  if (countRecommended(profileId) === 0) return true;
  return watchedStore.newestWatchedMs(profileId) > getBuiltAt(profileId);
}

// Build the pool NOW (buildRecommendations + ageGatePool) with progress. This is
// the unit of work the job queue runs; callers should route it through
// jobs.enqueue so builds serialise + report a percentage. Exported so the portal
// and the tick share one implementation.
async function buildPool(profile, log = console, onProgress = () => {}) {
  init();
  const r = await buildRecommendations(profile, log, (pct, label) => onProgress(pct * 0.85, label)); // 0–85%
  if (!r.skipped) await ageGatePool(profile, log, (pct, label) => onProgress(85 + pct * 0.15, label)); // 85–100%
  return r;
}

// Background trigger from the tick: enqueue a pool build only when it's needed.
async function ensureBuilt(profile, log = console) {
  init();
  if (!needsBuild(profile.id)) return { skipped: 'fresh' };
  const jobs = require('./jobs');
  return jobs.enqueue(profile.id, 'recs', (progress) => buildPool(profile, log, progress));
}

module.exports = {
  init,
  // Re-exported from the Genesis Engine (their new home) so existing imports and
  // the smoke tests keep resolving them from recommendationStore.
  computeAffinity: genesis.computeAffinity,
  selectStrong: genesis.selectStrong,
  buildRecommendations,
  ageGatePool,
  buildPool,
  ensureBuilt,
  needsBuild,
  resetRecommendations,
  clearType,
  upsertCandidates,
  setAgeClassification,
  purgeBelowVoteFloor,
  refreshStaleRatings,
  getRecommended,
  countRecommended,
  dontRecommendKeys,
  addDontRecommend,
  removeDontRecommend,
  deleteForProfile,
  selectServe,
  balanceByGenre,
  certMinAge,
  passesAgeBand,
  listSizeFor,
  serveRecommendations,
  setBuiltAt,
  getBuiltAt,
  impressionStep,
  shouldDecay,
  decayWindowMsFor,
  recordImpressions,
  applyDecay,
  noteMetaOpen,
  HALF_LIFE_DAYS: genesis.HALF_LIFE_DAYS,
  PER_TITLE_CAP: genesis.PER_TITLE_CAP,
  SERVE_LIMIT,
  DECAY_WINDOW_MS,
  FALLOFF_GAP_MS,
  DECAY_COOLDOWN_MS,
  DECAY_MIN_DAYS,
};
