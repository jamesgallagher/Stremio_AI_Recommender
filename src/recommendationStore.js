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
const certs = require('./certs');
const settings = require('./settings');
const tmdb = require('./services/tmdb');
const recency = require('./recency');
const animeMap = require('./services/animeMap');
const watchedStore = require('./watchedStore');
const lanes = require('./lanes');
// Trainer T2 (N8): the taste-feedback store's rebuild trigger (Marquee-only).
const tasteFeedback = require('./tasteFeedback');
// recommendationStore keeps the pool table, serve path, decay, age gate, and the
// IMDb-rating heal — all engine-agnostic. The candidate-generation half of the
// build lives in the engine (Marquee Cinema for movies, Marquee TV for series).
// Calibrated serving (spec §16): the pure helpers + the per-profile taste target store.
const serveCalibration = require('./serveCalibration');

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
// sub-floor title must never be stored, not merely hidden at serve. The
// profile's engine applies it at candidate selection (selectStrong);
// purgeBelowVoteFloor below clears any already-stored row that has since fallen
// under the floor, for EVERY engine. The rating floor / genres / recency are
// DIFFERENT — cheap serve-time preferences over the stored pool (no rebuild).

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS recommended (
      profile_id  TEXT NOT NULL,
      type        TEXT NOT NULL,          -- 'movie' | 'series' | 'anime' (src/lanes.js)
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
      score_components TEXT,              -- GE-01: JSON per-feature breakdown behind rankScore (engine-agnostic; null when an engine doesn't emit it)
      algorithm_version TEXT,             -- GE-01: the scoring version that produced score_components/affinity, so a stored row stays interpretable across weight changes
      engine_id   TEXT,                   -- GE-01: which engine produced this row (stamped by the shared pipeline)
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
    ['streak_started_at', 'INTEGER'], ['times_shown_in_streak', 'INTEGER DEFAULT 0'], ['last_shown_at', 'INTEGER'],
    // GE-01: score-components store (engine-agnostic). Best-effort on older DBs.
    ['score_components', 'TEXT'], ['algorithm_version', 'TEXT'], ['engine_id', 'TEXT'],
    // SH-01: real AU/US movie classification (strictest), engine- or pipeline-supplied.
    ['certification', 'TEXT']]) {
    try { db.get().exec(`ALTER TABLE recommended ADD COLUMN ${col} ${decl}`); } catch { /* already present */ }
  }
  // MW-03: persist the imdb id alongside the tmdb-keyed suppression row so a
  // curated (imdb-keyed) catalog meta can be matched at serve time WITHOUT a
  // per-title TMDB lookup. Best-effort ADD COLUMN (idempotent). Backfill is
  // unnecessary — a NULL imdb_id on an old row just means that title isn't
  // imdb-filterable from curated lists until it's re-suppressed (it stays
  // tmdb-suppressed from the AI pool, as before). The index backs
  // dontRecommendImdbSet's one read per curated serve.
  try { db.get().exec('ALTER TABLE dont_recommend ADD COLUMN imdb_id TEXT'); } catch { /* already present */ }
  db.get().exec('CREATE INDEX IF NOT EXISTS ix_dnr_profile ON dont_recommend (profile_id)');
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

// `imdbId` (MW-03, trailing/optional so existing positional callers are
// unaffected) is stored as the serve-time MATCH KEY for curated imdb-keyed
// catalogs — NOT an alternate identity: the row is still tmdb-keyed and requires
// a resolvable tmdb. On conflict imdb_id COALESCEs so a later re-suppression that
// happens to know the imdb can fill a previously-null one, but a null never wipes
// a known imdb.
function addDontRecommend(profileId, type, tmdbId, reason = 'user', at = Date.now(), imdbId = null) {
  init();
  db.get().prepare(`
    INSERT INTO dont_recommend (profile_id, type, tmdb_id, reason, at, imdb_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET reason = excluded.reason, at = excluded.at, imdb_id = COALESCE(excluded.imdb_id, dont_recommend.imdb_id)
  `).run(profileId, type, String(tmdbId), reason, at, imdbId || null);
  // If it was in the pool, drop it now.
  db.get().prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profileId, type, String(tmdbId));
}

// MW-03: the imdb-id siblings of dontRecommendKeys — a Set of `tt…` ids for
// filtering imdb-keyed curated catalog metas at serve time. Honours the same
// reason/decay rules (a 'decayed' row past its cooldown is allowed back), and
// skips rows with a null imdb_id (nothing to match on). One indexed read.
function dontRecommendImdbSet(profileId, nowMs = Date.now()) {
  init();
  const rows = db.get().prepare('SELECT imdb_id, reason, at FROM dont_recommend WHERE profile_id = ? AND imdb_id IS NOT NULL').all(profileId);
  const out = new Set();
  for (const r of rows) {
    if (r.reason === 'decayed' && r.at && (nowMs - r.at) > DECAY_COOLDOWN_MS) continue; // cooldown expired → allow back
    out.add(r.imdb_id);
  }
  return out;
}

// GE-10: raw dont_recommend rows (type/tmdb_id/reason/at) for one type, for the
// Glass feedback event list (a rejected title's dims steer taste AWAY). Unlike
// dontRecommendKeys (a serve/build exclusion Set that drops decayed rows past
// cooldown), this returns EVERY row — the taste model recency-decays each by `at`,
// so an old rejection fades on its own without a hard cooldown cliff.
function getDontRecommendRows(profileId, type) {
  init();
  return db.get().prepare('SELECT type, tmdb_id, reason, at FROM dont_recommend WHERE profile_id = ? AND type = ?').all(profileId, type);
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
    INSERT INTO recommended (profile_id, type, tmdb_id, imdb_id, title, year, primary_genre, genres, vote_average, imdb_rating, imdb_rating_at, vote_count, affinity, rec_count, because_title, score_components, algorithm_version, engine_id, popularity, poster, created_at, certification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET
      affinity = excluded.affinity, rec_count = excluded.rec_count, popularity = excluded.popularity,
      primary_genre = excluded.primary_genre, genres = excluded.genres, vote_average = excluded.vote_average,
      imdb_rating = COALESCE(excluded.imdb_rating, recommended.imdb_rating),
      imdb_rating_at = COALESCE(excluded.imdb_rating_at, recommended.imdb_rating_at), vote_count = excluded.vote_count,
      because_title = excluded.because_title, title = excluded.title, year = excluded.year, poster = excluded.poster,
      score_components = excluded.score_components, algorithm_version = excluded.algorithm_version, engine_id = excluded.engine_id,
      certification = COALESCE(excluded.certification, recommended.certification)
  `);
  conn.prepare('BEGIN').run();
  try {
    const now = Date.now();
    for (const c of candidates) {
      // GE-01: score_components accepts an object (stored as JSON) or a pre-stringified
      // string; null when the engine doesn't emit it.
      const comps = c.score_components == null ? null
        : (typeof c.score_components === 'string' ? c.score_components : JSON.stringify(c.score_components));
      stmt.run(profileId, c.type, c.tmdb_id, c.imdb_id || null, c.title, c.year, c.primary_genre || null, c.genres || null, c.vote_average ?? null, c.imdb_rating ?? null, ratingCheckedAt, c.vote_count ?? null, c.affinity, c.rec_count, c.because_title || null, comps, c.algorithm_version || null, c.engine_id || null, c.popularity, c.poster || null, now, c.certification || null);
    }
    conn.prepare('COMMIT').run();
  } catch (err) { conn.prepare('ROLLBACK').run(); throw err; }
}

function setAgeClassification(profileId, type, tmdbId, age) {
  db.get().prepare('UPDATE recommended SET age_classification = ? WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(age, profileId, type, String(tmdbId));
}

// AGE-1: store the TV-14 verdict's source+rating on the pool row's certification
// column (mandate A7: `<source>:<rating>`, e.g. `csm:14`, `au:M`, `tvdb-au:PG`).
function setCertification(profileId, type, tmdbId, certification) {
  db.get().prepare('UPDATE recommended SET certification = ? WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(certification, profileId, type, String(tmdbId));
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

// Drop one type's rows produced by an OLDER algorithm version of the SAME engine.
// The pool is cumulative (a build upserts what it produced and leaves the rest),
// so after a scoring change (e.g. marquee-m2 → m3) the old version's rows would
// otherwise linger forever with scores that predate the change — including ones
// a Trainer ignore/rating should now steer away from. Only rows that carry BOTH
// this engine's id AND a version are touched: other engines' rows, and legacy
// rows with no engine/version stamp, are left alone. Returns rows removed.
function pruneSupersededVersions(profileId, type, engineId, currentVersion) {
  init();
  if (!engineId || !currentVersion) return 0;
  const r = db.get().prepare(`
    DELETE FROM recommended
    WHERE profile_id = ? AND type = ? AND engine_id = ?
      AND algorithm_version IS NOT NULL AND algorithm_version != ?
  `).run(profileId, String(type), String(engineId), String(currentVersion));
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
  for (const t of lanes.LANES) {
    const ids = due.filter((r) => r.type === t).map((r) => r.imdb_id);
    if (!ids.length) continue;
    let ratings;
    try {
      ratings = await getRatings(lanes.lookupType(t), ids);
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

// TV-2 C1: the canonical order of the age chain's source labels for the
// per-source log line (deterministic sources first, then the hard floor, then
// the LLM). Only sources with a non-zero count are listed.
const AGE_SOURCE_ORDER = ['csm', 'au', 'us', 'tvdb-au', 'tvdb-us', 'simkl', 'mdblist', 'tmdb-gb', 'tmdb-ie', 'tmdb-nz', 'tmdb-ca', 'tvdb-gbr', 'tvdb-irl', 'tvdb-nzl', 'tvdb-can', 'hard-floor', 'llm'];

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

  // 2. Age gate — every positive age limit is a chain tier (AGE-2): the
  // multi-source decision chain is the ONLY age gate (mandate B3: no legacy
  // LLM age path remains). The chain's LLM step (step 5) is fail-closed.
  let vetoed = 0;
  const decidedBySource = new Map();
  const blockedBySource = new Map();
  if (limit > 0) {
    const ageVerify = require('./ageVerification');
    const tier = ageVerify.tierFor({ age_limit: limit });
    onProgress(50, 'Age-checking with the verification chain…');
    const sources = require('./ageVerification/sources').buildSources(profile, log);
    for (const type of lanes.LANES) {
      const survivors = getRecommended(profile.id, { type, limit: 100000 });
      if (!survivors.length) continue;
      const titles = survivors.map((r) => ({
        key: `${lanes.lookupType(type)}:${r.tmdb_id}`,
        imdb_id: r.imdb_id,
        adult: r.adult || false,
        title: r.title,
        year: r.year,
        genres: r.primary_genre ? [r.primary_genre] : [],
        certification: r.certification || r.age_classification,
      }));
      const result = await ageVerify.verify(titles, lanes.lookupType(type), tier, sources, log);
      for (const [k, v] of result) {
        const tmdbId = k.split(':')[1];
        if (v.verdict === 'block') { hardDrop(profile.id, type, tmdbId); vetoed++; }
        // A7: store the verdict's source+rating on the pool row's certification column.
        if (v.verdict === 'allow' || v.verdict === 'block') {
          setCertification(profile.id, type, tmdbId, `${v.source}:${v.rating || ''}`);
          // TV-2 C1: accumulate per-source counts. A cached verdict returns its
          // stored source from verify(), so cache hits count by their stored source.
          decidedBySource.set(v.source, (decidedBySource.get(v.source) || 0) + 1);
          if (v.verdict === 'block') blockedBySource.set(v.source, (blockedBySource.get(v.source) || 0) + 1);
        }
      }
    }
    // TV-2 C1: one per-source line (AGE-2 card §2.9). Only sources with n > 0
    // are listed; the tier label names the chain tier.
    const listBySource = (m) => AGE_SOURCE_ORDER.filter((s) => (m.get(s) || 0) > 0).map((s) => `${s} ${m.get(s)}`);
    log.log(`[rec] ${profile.name}: age gate (${tier.label}) — ${dropped} NSFW/band dropped · decided: ${listBySource(decidedBySource).join(', ')} · blocked ${vetoed} (${listBySource(blockedBySource).join(', ')}) · ${countRecommended(profile.id)} remain`);
  } else {
    log.log(`[rec] ${profile.name}: age gate — ${dropped} NSFW/band dropped, ${vetoed} LLM-vetoed, ${countRecommended(profile.id)} remain`);
  }
  return { dropped, vetoed, remain: countRecommended(profile.id) };
}

// ---- Staged build (feature/ai-catalog-cadence, Stage 2) ----
//
// The heavy watch-driven build used by the scheduled daily/weekly paths.
// Generates candidates in memory (both types), age-gates them in memory,
// checks the acceptance gate per type, and promotes them atomically. A
// failed/partial build never mutates the live pool (M6).
//
// Invariants:
//   • No unverified candidate is visible during the run — the staged
//     candidates live in memory until the atomic promotion commits.
//   • The old pool and schedule success markers remain intact on any
//     failure (generation, age gate, acceptance gate, promotion error).
//   • Successful promotion preserves impression/engagement columns for
//     surviving titles and all dont_recommend rows.
//   • A weekly (Sunday) promotion replaces obsolete same-engine rows; a
//     daily promotion is a cumulative upsert.

// Staged age gate: age-gate the staged candidates IN MEMORY (no pool
// mutation). Mirrors ageGatePool's two passes (NSFW + anime band via
// rebuild.applyAnimeGate; the LLM ACB pass via ageVerify.verify) but
// operates on the in-memory staged candidates instead of the live pool.
// Returns { movie: [...], series: [...], dropped, vetoed } — the filtered
// candidates with age_classification/certification set in memory.
async function stagedAgeGate(profile, stagedByType, log = console, onProgress = () => {}) {
  const rebuild = require('./rebuild');
  const limit = profile.filters?.age_limit || 0;
  onProgress(0, 'Age-gating the staged candidates…');

  const out = { movie: [], series: [], anime: [] };
  let dropped = 0;
  let vetoed = 0;

  for (const type of lanes.LANES) {
    const cands = stagedByType[type] || [];
    if (!cands.length) continue;

    // 1. NSFW + anime band (pure, in memory).
    const metas = cands.map((c) => ({ id: c.imdb_id || c.tmdb_id, _tmdb_id: c.tmdb_id, name: c.title, _rtype: type }));
    const kept = await rebuild.applyAnimeGate(metas, profile, log);
    const keptKeys = new Set(kept.map((m) => key(m._rtype, m._tmdb_id)));
    const keptCands = cands.filter((c) => keptKeys.has(key(type, c.tmdb_id)));
    for (const m of kept) {
      const c = cands.find((c) => c.tmdb_id === m._tmdb_id);
      if (c && m._certification) c.age_classification = m._certification;
    }
    dropped += cands.length - keptCands.length;

    // 2. LLM ACB pass (age-limited profiles only).
    if (limit > 0 && keptCands.length) {
      const ageVerify = require('./ageVerification');
      const tier = ageVerify.tierFor({ age_limit: limit });
      onProgress(50, 'Age-checking the staged candidates…');
      const sources = require('./ageVerification/sources').buildSources(profile, log);
      const titles = keptCands.map((c) => ({
        key: `${lanes.lookupType(type)}:${c.tmdb_id}`,
        imdb_id: c.imdb_id,
        adult: c.adult || false,
        title: c.title,
        year: c.year,
        genres: c.primary_genre ? [c.primary_genre] : [],
        certification: c.certification || c.age_classification,
      }));
      const result = await ageVerify.verify(titles, lanes.lookupType(type), tier, sources, log);
      const finalCands = [];
      for (const c of keptCands) {
        const v = result.get(`${lanes.lookupType(type)}:${c.tmdb_id}`);
        if (v && v.verdict === 'block') { vetoed++; continue; }
        if (v && (v.verdict === 'allow' || v.verdict === 'block')) {
          c.certification = `${v.source}:${v.rating || ''}`;
        }
        finalCands.push(c);
      }
      out[type] = finalCands;
    } else {
      out[type] = keptCands;
    }
  }

  const total = out.movie.length + out.series.length + out.anime.length;
  log.log(`[rec] ${profile.name}: staged age gate — ${dropped} NSFW/band dropped, ${vetoed} LLM-vetoed, ${total} remain`);
  return { movie: out.movie, series: out.series, anime: out.anime, dropped, vetoed };
}

// Acceptance gate: per type, the new eligible visible count must be >=
// min(listSizeFor, oldEligibleVisibleCount). "Eligible visible" = the count of
// rows that pass the serve-time filter (rating floor, excluded genres, age
// band) — the same filter the serve path applies. A failure means the new pool
// is too sparse; the caller aborts without promoting, so the old pool remains
// intact. Returns { ok, movie: {oldEligible, newEligible, minRequired, ok}, series: ... }.
function acceptanceGate(profile, stagedByType, filters) {
  const listSize = listSizeFor(profile);
  const result = { ok: true, movie: null, series: null, anime: null };
  // Current watched + suppression state at gate time (a title watched or
  // suppressed during generation must not count toward the eligible set).
  const watchedImdb = watchedStore.watchedIdSets(profile.id).imdb;
  const dnr = dontRecommendKeys(profile.id);
  const tmdb = require('./services/tmdb');
  for (const type of lanes.LANES) {
    const voteFloor = type === 'anime' ? 0 : tmdb.voteFloor(filters, type);
    // OLD eligible: the actual currently served catalog. selectedRecommendationRows
    // does NOT apply the vote-count floor to stored rows at serve time (the floor
    // is enforced by atomicPromotion deleting below-floor rows during promotion).
    // So the old side reflects what is actually served: watched + suppression +
    // normal serve filters (rating, genre, recency, age band).
    const oldRows = getRecommended(profile.id, { type, limit: 100000 });
    const oldEligible = oldRows.filter((r) => {
      if (r.imdb_id && watchedImdb.has(r.imdb_id)) return false;
      if (lanes.dnrTypes(type).some((t) => dnr.has(`${t}:${r.tmdb_id}`))) return false;
      return filterServable([r], filters).length === 1;
    }).length;
    // NEW eligible: distinct pool identities (tmdb_id) that would survive
    // promotion. atomicPromotion deletes below-vote-floor rows, so the vote
    // floor IS applied to the new set. Watched + suppression + serve filters
    // also apply (same as the old side).
    const newRows = stagedByType[type] || [];
    const newEligible = new Set(
      newRows.filter((c) => {
        if (c.vote_count != null && c.vote_count < voteFloor) return false;
        if (c.imdb_id && watchedImdb.has(c.imdb_id)) return false;
        if (lanes.dnrTypes(type).some((t) => dnr.has(`${t}:${c.tmdb_id}`))) return false;
        return filterServable([c], filters).length === 1;
      }).map((c) => String(c.tmdb_id))
    ).size;
    const minRequired = Math.min(listSize, oldEligible);
    const ok = newEligible >= minRequired;
    result[type] = { oldEligible, newEligible, minRequired, ok };
    if (!ok && type !== 'anime') result.ok = false;
  }
  return result;
}

// Atomic promotion: promote the staged candidates into the pool in ONE
// synchronous SQLite transaction. For a weekly (Sunday) build, obsolete
// same-engine rows (rows of this type with this engine_id NOT in the new staged
// set) are deleted BEFORE the upsert (the full replacement). For a daily build,
// the upsert is cumulative (no obsolete deletion). The upsert's ON CONFLICT
// clause preserves impression/engagement columns for surviving titles.
// dont_recommend is a separate table, untouched. A thrown error rolls back the
// entire transaction, so the old pool remains intact.
function atomicPromotion(profileId, stagedByType, { kind, filters, engineIds, ratingCheckedAt }) {
  const conn = db.get();
  conn.prepare('BEGIN').run();
  try {
    const now = Date.now();
    // Recheck current suppression at promotion time: a rejection that arrived
    // during generation (after the pipeline's ctx.dont snapshot) must not be
    // reinserted. The dont_recommend table is not modified by this transaction,
    // so reading it here is safe.
    const dnr = dontRecommendKeys(profileId);
    for (const type of lanes.LANES) {
      const cands = stagedByType[type] || [];
      if (cands.length) {
        stagedByType[type] = cands.filter((c) => !lanes.dnrTypes(type).some((t) => dnr.has(`${t}:${c.tmdb_id}`)));
      }
    }
    const stmt = conn.prepare(`
      INSERT INTO recommended (profile_id, type, tmdb_id, imdb_id, title, year, primary_genre, genres, vote_average, imdb_rating, imdb_rating_at, vote_count, affinity, rec_count, because_title, score_components, algorithm_version, engine_id, popularity, poster, created_at, certification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, type, tmdb_id) DO UPDATE SET
        affinity = excluded.affinity, rec_count = excluded.rec_count, popularity = excluded.popularity,
        primary_genre = excluded.primary_genre, genres = excluded.genres, vote_average = excluded.vote_average,
        imdb_rating = COALESCE(excluded.imdb_rating, recommended.imdb_rating),
        imdb_rating_at = COALESCE(excluded.imdb_rating_at, recommended.imdb_rating_at), vote_count = excluded.vote_count,
        because_title = excluded.because_title, title = excluded.title, year = excluded.year, poster = excluded.poster,
        score_components = excluded.score_components, algorithm_version = excluded.algorithm_version, engine_id = excluded.engine_id,
        certification = COALESCE(excluded.certification, recommended.certification)
    `);

    for (const type of lanes.LANES) {
      const cands = stagedByType[type] || [];
      const engineId = engineIds[type];
      if (!cands.length) continue;

      // Weekly (Sunday): full replacement — delete obsolete same-engine rows
      // (rows of this type with this engine_id NOT in the new staged set)
      // BEFORE the upsert. A daily build is cumulative (no obsolete deletion).
      if (kind === 'weekly' && engineId) {
        const newIds = new Set(cands.map((c) => String(c.tmdb_id)));
        const rows = conn.prepare('SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = ? AND engine_id = ?').all(profileId, type, engineId);
        const del = conn.prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND engine_id = ? AND tmdb_id = ?');
        for (const r of rows) {
          if (!newIds.has(String(r.tmdb_id))) del.run(profileId, type, engineId, r.tmdb_id);
        }
      }

      // Upsert the staged candidates (preserving impression/engagement for
      // surviving titles via the ON CONFLICT clause).
      for (const c of cands) {
        const comps = c.score_components == null ? null
          : (typeof c.score_components === 'string' ? c.score_components : JSON.stringify(c.score_components));
        stmt.run(profileId, c.type, c.tmdb_id, c.imdb_id || null, c.title, c.year, c.primary_genre || null, c.genres || null, c.vote_average ?? null, c.imdb_rating ?? null, ratingCheckedAt, c.vote_count ?? null, c.affinity, c.rec_count, c.because_title || null, comps, c.algorithm_version || null, c.engine_id || null, c.popularity, c.poster || null, now, c.certification || null);
      }

      // ENG-1: the slice now belongs to this engine — remove other engines' leftovers.
      conn.prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND (engine_id IS NULL OR engine_id != ?)').run(profileId, type, engineId);
      // Prune superseded versions (only when the build stored rows AND they agree on one version).
      const versions = new Set(cands.map((c) => c.algorithm_version).filter(Boolean));
      if (cands.length && versions.size === 1) {
        conn.prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ? AND engine_id = ? AND algorithm_version IS NOT NULL AND algorithm_version != ?').run(profileId, type, engineId, [...versions][0]);
      }
    }

    // Vote-count floor (per profile, both types).
    conn.prepare(`
      DELETE FROM recommended
      WHERE profile_id = ? AND vote_count IS NOT NULL
        AND ((type = 'movie'  AND vote_count < ?)
          OR (type = 'series' AND vote_count < ?))
    `).run(profileId, tmdb.voteFloor(filters, 'movie'), tmdb.voteFloor(filters, 'series'));

    conn.prepare('COMMIT').run();
  } catch (err) {
    conn.prepare('ROLLBACK').run();
    throw err;
  }
}

// Staged build: the heavy watch-driven build used by the scheduled daily/weekly
// paths. Generates candidates in memory (both types), age-gates them in
// memory, checks the acceptance gate per type, and promotes them atomically.
// A failed/partial build never mutates the live pool. `kind` is 'daily' |
// 'weekly'; `anchor` is the Sydney date of the window; `startHash` is the
// history snapshot at build start.
async function stagedBuildPool(profile, log = console, onProgress = () => {}, { kind, anchor, startHash } = {}) {
  init();
  const s = settings.getSettings();
  const tmdbKey = s?.keys?.tmdb_api_key;
  if (!tmdbKey) return { skipped: true, reason: 'no TMDB key in Server Config' };

  // Trainer T2 (N8): snapshot the taste-feedback change cursor at the build's
  // START — the stamp after a successful build is this value, so a Trainer
  // edit landing DURING the build stays newer than the stamp and triggers the
  // NEXT build.
  const trainingSnap = tasteFeedback.getTraining(profile.id);

  const engines = require('./engines');
  const pipeline = require('./engines/pipeline');
  const filters = profile.filters || {};
  const ctx = {
    tmdbKey,
    mdblistKey: settings.resolveMdblistKey(profile).key,
    settings: s,
    filters,
    log,
    stage: true, // feature/ai-catalog-cadence: the staged path defers serveCalibration.setTarget
  };

  // Staged generation (both types).
  const stagedByType = { movie: [], series: [], anime: [] };
  const engineIds = {};
  const missing = [];
  const animeEngine = engines.resolveFor(profile, 'anime');
  const spans = animeEngine
    ? { movie: [0, 45], series: [45, 72], anime: [72, 80] }
    : { movie: [0, 50], series: [50, 80] };
  const band = (lo, hi) => (pct, label) => onProgress(lo + (pct / 100) * (hi - lo), label);

  for (const type of ['movie', 'series']) {
    const engine = engines.resolveFor(profile, type);
    engineIds[type] = engine.id;
    const req = engine.requirements(profile);
    if (!req.ok) {
      const miss = req.missing || [];
      missing.push(...miss);
      log.warn(`[rec] ${profile.name}/${type}: ${engine.name} unavailable — missing ${miss.join(', ') || 'requirements'} (keeping existing ${type} rows)`);
      continue;
    }
    log.log(`[rec] ${profile.name}/${type}: staging with ${engine.name}`);
    const r = await pipeline.runEngineBuild(profile, type, engine, ctx, band(...spans[type]), { stage: true });
    stagedByType[type] = r.servable;
  }

  // AN-1a: the anime lane stages AFTER movie+series, only when its engine is on.
  if (animeEngine) {
    engineIds.anime = animeEngine.id;
    const req = animeEngine.requirements(profile);
    if (!req.ok) {
      const miss = req.missing || [];
      log.warn(`[rec] ${profile.name}/anime: ${animeEngine.name} unavailable — missing ${miss.join(', ') || 'requirements'} (keeping existing anime rows)`);
    } else {
      log.log(`[rec] ${profile.name}/anime: staging with ${animeEngine.name}`);
      const r = await pipeline.runEngineBuild(profile, 'anime', animeEngine, ctx, band(...spans.anime), { stage: true });
      stagedByType.anime = r.servable;
    }
  }

  // Age-gate the staged candidates in memory.
  const ageResult = await stagedAgeGate(profile, stagedByType, log, (pct, label) => onProgress(80 + pct * 0.1, label));
  stagedByType.movie = ageResult.movie;
  stagedByType.series = ageResult.series;
  stagedByType.anime = ageResult.anime;

  // Acceptance gate per type.
  const gate = acceptanceGate(profile, stagedByType, filters);
  if (!gate.ok) {
    const failed = [];
    if (gate.movie && !gate.movie.ok) failed.push(`movie (new ${gate.movie.newEligible} < min ${gate.movie.minRequired})`);
    if (gate.series && !gate.series.ok) failed.push(`series (new ${gate.series.newEligible} < min ${gate.series.minRequired})`);
    log.warn(`[rec] ${profile.name}: acceptance gate failed — ${failed.join('; ')} (old pool intact)`);
    return {
      skipped: true, reason: 'acceptance-gate',
      movie: { stored: gate.movie?.newEligible || 0 },
      series: { stored: gate.series?.newEligible || 0 },
      total: 0,
    };
  }
  // AN-1a: an anime acceptance failure only skips the anime promotion (old anime
  // rows stay serving); it never blocks movie/series.
  if (gate.anime && !gate.anime.ok) {
    log.warn(`[rec] ${profile.name}: anime acceptance gate failed (new ${gate.anime.newEligible} < min ${gate.anime.minRequired}) — keeping existing anime rows`);
    stagedByType.anime = [];
  }

  // Atomic promotion.
  atomicPromotion(profile.id, stagedByType, {
    kind,
    filters,
    engineIds,
    ratingCheckedAt: ctx.mdblistKey ? Date.now() : null,
  });

  // Promote the deferred serveCalibration targets (feature/ai-catalog-cadence,
  // Stage 2). The Marquee/Marquee TV engines stash the computed target in ctx
  // during generation (ctx.stage) so a failed/partial build never writes a
  // target for candidates that weren't promoted. Best-effort: a failure only
  // logs (C6).
  try {
    if (ctx.marqueeTarget) {
      serveCalibration.setTarget(profile.id, 'movie', 'marquee', ctx.marqueeTarget.target, ctx.marqueeTarget.filmCount, Date.now());
    }
    if (ctx.marqueeTvTarget) {
      serveCalibration.setTarget(profile.id, 'series', 'marquee-tv', ctx.marqueeTvTarget.target, ctx.marqueeTvTarget.filmCount, Date.now());
    }
  } catch (err) {
    log.warn(`[rec] ${profile.name}: serve target promotion failed: ${err.message}`);
  }

  // Stamp built_at + markTrainingBuilt (same as the urgent path).
  setBuiltAt(profile.id);
  tasteFeedback.markTrainingBuilt(profile.id, trainingSnap.changed_at);

  const animeStored = stagedByType.anime.length || 0;
  const stored = (stagedByType.movie.length || 0) + (stagedByType.series.length || 0) + animeStored;
  const animeLog = animeStored ? ` + anime ${animeStored} via marquee-anime` : '';
  log.log(`[rec] ${profile.name}: staged ${kind} build — ${stagedByType.movie.length} movie(s) + ${stagedByType.series.length} series${animeLog} (total ${countRecommended(profile.id)})`);
  const result = {
    movie: { stored: stagedByType.movie.length },
    series: { stored: stagedByType.series.length },
    stored,
    total: countRecommended(profile.id),
  };
  if (animeEngine) result.anime = { stored: animeStored };
  return result;
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

// Build the recommendation pool for a profile — now a thin TWO-TYPE
// WRAPPER (SC-01). The profile's engine produces candidates per type; the
// shared pipeline (engines/pipeline.js) resolves/enriches/upserts/purges each
// type's slice. The caller runs ageGatePool() after this to make the pool
// age-safe. Callers/tests are unchanged — the return still carries
// { skipped?, seeds, stored, … } and per-type dispatch-by-config arrives in SC-03.
//
// NOTE: the STORE_CAP (300) is now applied PER TYPE (in the engine), not across
// the combined candidate set as the pre-abstraction monolith did. This is the
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

  // Trainer T2 (N8): snapshot the taste-feedback change cursor at the build's
  // START — the stamp after a successful build is this value, so a Trainer
  // edit landing DURING the build stays newer than the stamp and triggers the
  // NEXT build.
  const trainingSnap = tasteFeedback.getTraining(profile.id);

  const engines = require('./engines');
  const pipeline = require('./engines/pipeline');
  const filters = profile.filters || {};
  const ctx = {
    tmdbKey,
    mdblistKey: settings.resolveMdblistKey(profile).key,
    settings: s,
    filters,
    log,
  };
  const animeEngine = engines.resolveFor(profile, 'anime');
  const spans = animeEngine
    ? { movie: [0, 45], series: [45, 90], anime: [90, 100] }
    : { movie: [0, 50], series: [50, 100] };
  const band = (lo, hi) => (pct, label) => onProgress(lo + (pct / 100) * (hi - lo), label);

  // SC-03: dispatch each type to the engine the profile selected for it (the
  // type's default is the guaranteed safe floor — resolveFor never returns an
  // unknown engine, one that doesn't support the type, or an age-inappropriate
  // one, so this can never disable or unsafely fill a type). A type whose
  // resolved engine's requirements are unmet is SKIPPED with a logged reason
  // and its existing pool rows are LEFT SERVING — a skip must NEVER wipe a
  // slice (only an engine CHANGE does, via config.updateProfile → clearType).
  // The engine id per type is threaded into the result + logs so the Advanced
  // tab / API can show who produced each catalog.
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

  // AN-1a: the anime lane builds AFTER movie+series, only when its engine is on.
  // It never decides whether the build as a whole counts (ranAny/builtSeeds stay
  // movie+series), and a requirement miss or an empty result leaves the existing
  // anime rows serving.
  if (animeEngine) {
    engineIds.anime = animeEngine.id;
    const req = animeEngine.requirements(profile);
    if (!req.ok) {
      const miss = req.missing || [];
      log.warn(`[rec] ${profile.name}/anime: ${animeEngine.name} unavailable — missing ${miss.join(', ') || 'requirements'} (keeping existing anime rows)`);
      results.anime = { ...skipResult(animeEngine), missing: miss };
    } else {
      log.log(`[rec] ${profile.name}/anime: building with ${animeEngine.name}`);
      const r = await pipeline.runEngineBuild(profile, 'anime', animeEngine, ctx, band(...spans.anime));
      r.engine = animeEngine.id;
      results.anime = r;
    }
  }

  const m = results.movie;
  const sr = results.series;

  // Nothing to build — either no type's engine was ready (all requirement-skipped)
  // or the engines ran but produced nothing. DON'T stamp built_at, so needsBuild
  // keeps retrying until the inputs (a connection, watch history) appear. A
  // requirements miss reports what's missing; the ready-but-empty case keeps its
  // long-standing reason so existing status text is unchanged.
  //
  // "Produced nothing" is measured by what was STORED, not by seeds: a non-history
  // engine (LLM/trending) legitimately has 0 watch-history seeds yet stores
  // candidates. Keying off seeds alone left such a build perpetually "skipped" — it
  // never stamped built_at, so needsBuild re-fired every tick (churn) and, worse,
  // buildPool skipped the age gate over rows that WERE stored. A build that stored
  // anything is a real build. (An engine with 0 seeds stores nothing → still skipped.)
  const ranAny = !m.skipped || !sr.skipped;
  const builtSeeds = m.seeds + sr.seeds;
  const builtStored = (m.stored || 0) + (sr.stored || 0);
  if (!ranAny || (builtSeeds === 0 && builtStored === 0)) {
    const reason = !ranAny
      ? `engine not ready — missing ${[...new Set(missing)].join(', ') || 'requirements'}`
      : 'no watched titles to seed from';
    const skipped = { skipped: true, reason, engines: engineIds, movie: m, series: sr };
    if (animeEngine) skipped.anime = results.anime;
    return skipped;
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
  // Trainer T2 (N8): stamp the last successful build's view of the change
  // cursor (spec §8: a successful build resets changes_since_build — the
  // reset happens inside markTrainingBuilt, only while the cursor is still
  // the snapshot, so a mid-build edit keeps its count).
  tasteFeedback.markTrainingBuilt(profile.id, trainingSnap.changed_at);

  const seeds = m.seeds + sr.seeds;
  const stored = m.stored + sr.stored;
  const purged = m.purged + sr.purged;
  const animeLog = animeEngine && results.anime && !results.anime.skipped ? ` + anime ${results.anime.stored} via marquee-anime` : '';
  log.log(`[rec] ${profile.name}: ${seeds} seed(s) → ${m.strong + sr.strong} unique → ${stored} servable (movies ${m.stored} via ${engineIds.movie}, series ${sr.stored} via ${engineIds.series})${animeLog}${purged ? `, ${purged} purged below vote floor` : ''}${refreshed.updated ? `, ${refreshed.updated} rating(s) refreshed` : ''} (total ${countRecommended(profile.id)})`);
  const result = {
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
  if (animeEngine) result.anime = results.anime;
  return result;
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
// profile the serve-time re-check first reads the stored verdict (no network);
// if no verdict exists, it judges the row's own stored classification against
// the tier (MAL band, certification stamp, or raw cert). An unrated/unknown
// row is never "too old" (fail-open). This is the cheap cert/MAL safety net
// selectServe and the Companion's "entire list" view share. NOT a substitute
// for the build-time chain gate (the pool is already chain-vetted).
function passesAgeBand(row, filters = {}) {
  const ageVerify = require('./ageVerification');
  const tier = ageVerify.tierFor(filters);
  if (!tier) return true;                           // no limit: unchanged
  // 1. A stored verdict for THIS tier wins.
  if (row.type && row.tmdb_id) {
    const v = require('./ageVerification/store').getVerdict(lanes.lookupType(row.type), row.tmdb_id, tier.id);
    if (v) return v.verdict === 'allow';
  }
  // 2. No verdict: judge the row's OWN stored classification against the tier (no network).
  //    a) MAL band in age_classification: reuse certMinAge() (G 0, PG 8, PG-13 13, R 17, R+ 17)
  //       → block if minAge > tier.malMaxAge.
  const mal = certMinAge(row.age_classification);
  if (mal !== null && mal > tier.malMaxAge) return false;
  //    b) certification: either an AGE stamp '<source>:<rating>' or a raw cert (Marquee rows).
  const raw = row.certification ? String(row.certification) : null;
  if (raw) {
    const [src, rest] = raw.includes(':') ? raw.split(/:(.*)/s) : [null, raw];
    if (src === 'csm') { const n = parseInt(rest, 10); if (Number.isFinite(n) && n > tier.csmMaxAge) return false; }
    else if (src === 'llm') { if (rest === 'no') return false; }
    else if (require('./ageVerification/ratings').classify(rest, lanes.lookupType(row.type || 'movie'), tier) === 'block') return false;
  }
  // 3. Unknown stays KEPT (unchanged rule).
  return true;
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

// PURE serve-time filter over stored pool rows: applies the user's serve-time
// preferences (rating floor, excluded genres, movies-only recency) + a cheap
// age-band re-check. Exported for testing. Nothing here touches the network.
function filterServable(rows, filters = {}, { nowYear = new Date().getFullYear() } = {}) {
  const minRating = filters.min_rating || 0;
  const excluded = new Set(filters.excluded_genres || []);
  const excludedNoAnime = new Set([...excluded].filter((g) => g !== 'Anime'));
  const excludedLane = (r) => (r.type === 'anime' ? excludedNoAnime : excluded);
  const minYear = recency.minYearOf(filters, nowYear); // decade floor (src/recency.js); 0 = none

  return (rows || []).filter((r) => {
    if (!r.imdb_id) return false;                                             // not servable
    // Rating floor: judged against the IMDb rating shown on the poster (via
    // MDBList) when we have it, falling back to TMDB's rating only for titles
    // with no IMDb rating. Neither known -> kept ("no rating" isn't "bad").
    const shownRating = r.imdb_rating > 0 ? r.imdb_rating : (r.vote_average || 0);
    if (minRating > 0 && shownRating > 0 && shownRating < minRating) return false;
    const genres = (r.genres || '').split(',').filter(Boolean);
    if (genres.some((g) => excludedLane(r).has(g))) return false;            // excluded genre (full list, incl. Anime)
    // Release-year floor — MOVIES ONLY. Series run for years from an old first-air
    // date, so a recency cut-off would wrongly drop still-running shows.
    if (minYear > 0 && r.type === 'movie' && r.year && r.year < minYear) return false;
    if (!passesAgeBand(r, filters)) return false;                            // lowered-limit safety net (adult profile: always true)
    return true;
  });
}

// PURE serve-time selection over stored pool rows. Applies USER PREFERENCES
// (rating floor, excluded genres, recency) + a cheap age-band re-check, then
// balances across genres. Exported for testing. Nothing here touches the network.
function selectServe(rows, filters = {}, { nowYear = new Date().getFullYear(), limit = SERVE_LIMIT } = {}) {
  return balanceByGenre(filterServable(rows, filters, { nowYear }), limit);
}

// Convert a snake_case serve config (config.js DEFAULTS.serve) to the camelCase
// opts calibratedOrder expects (window_factor → windowFactor, kl_alpha →
// klAlpha, wildcard_slots → wildcardSlots, wildcard_max_share →
// wildcardMaxShare, wildcard_position → wildcardPosition).
const camelServeOpts = (o) => {
  if (!o || typeof o !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};

// One serve entry point (spec §16, C7): every serve surface (Stremio catalogs,
// the portal View, the companion) takes a prefix of the SAME calibrated full
// ordering, so the served list for any limit is `order.slice(0, limit)` (C3).
// Part B: the fallback warning is emitted at most once per (profileId, type,
// reason) per process. The keys are cleared on a successful calibrated serve so
// a later regression (e.g. the target is deleted) warns again.
const warnedServe = new Set();
function _resetServeWarnings() { warnedServe.clear(); }

// For a Marquee profile with a stored taste target, the served genre mix is
// calibrated to that taste (Steck, RecSys 2018); otherwise — Genesis, Glass, no
// target, engine id mismatch, strategy 'round_robin', or any calibration
// failure — it falls back to the existing strict genre rotation (C6). Serving
// must never fail because of calibration. `selectServe` stays exported and
// unchanged for the regression guard (K17).
function selectServeFor(profile, type, rows, { limit = SERVE_LIMIT } = {}) {
  const nowYear = new Date().getFullYear();
  // Filter, then sort by affinity DESC (ties by tmdb_id) — the calibrated order
  // expects the pool already sorted by score descending (C9).
  const passed = filterServable(rows, profile?.filters || {}, { nowYear })
    .sort((a, b) => {
      const sa = a.affinity || 0, sb = b.affinity || 0;
      if (sb !== sa) return sb - sa;
      return String(a.tmdb_id) < String(b.tmdb_id) ? -1 : 1;
    });
  const engine = require('./engines').resolveFor(profile, type); // lazy (avoids a require cycle)
  if (!engine) return balanceByGenre(passed, limit); // anime lane: no engine → plain genre balance
  const opts = engine.serveOptions ? engine.serveOptions(settings.getSettings()) : null;
  const t = serveCalibration.getTarget(profile.id, type);
  const p = t ? serveCalibration.applyExclusions(t.target, (profile?.filters || {}).excluded_genres) : null;
  const calibrated =
    engine.capabilities.serveOrder === 'calibrated' &&
    opts && opts.strategy === 'calibrated' &&
    t && t.engine_id === engine.id &&
    p && Object.keys(p).length > 0;
  if (!calibrated) {
    // A calibrated engine that can't serve calibrated (no target / mismatched /
    // empty) warns once per (profileId, type, reason) per process (C6, ids only);
    // a non-calibrated engine (Genesis/Glass) or a deliberate 'round_robin'
    // strategy is not.
    if (engine.capabilities.serveOrder === 'calibrated' && !(opts && opts.strategy === 'round_robin')) {
      const reason = !t ? 'no-target' : (t.engine_id !== engine.id ? 'engine-mismatch' : 'empty-after-exclusions');
      const key = `${profile.id}|${type}|${reason}`;
      if (!warnedServe.has(key)) {
        warnedServe.add(key);
        console.warn(`[serve] ${profile.id}/${type}: no usable calibrated target (${reason}) — serving genre-balanced`);
      }
    }
    return balanceByGenre(passed, limit);
  }
  try {
    const picked = serveCalibration.calibratedOrder(passed, p, { listSize: listSizeFor(profile), ...camelServeOpts(opts) }).slice(0, limit);
    // A successful calibrated serve clears this profile/type's warning keys so a
    // later regression (e.g. the target is deleted) warns again.
    for (const key of [...warnedServe]) {
      if (key.startsWith(`${profile.id}|${type}|`)) warnedServe.delete(key);
    }
    return picked;
  } catch (err) {
    const key = `${profile.id}|${type}|calibration-error`;
    if (!warnedServe.has(key)) {
      warnedServe.add(key);
      console.warn(`[serve] ${profile.id}/${type}: calibrated serving failed (${err.message}) — serving genre-balanced`);
    }
    return balanceByGenre(passed, limit);
  }
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

// Shared row selection (watched-first): the ONE place every serve surface
// (the AI catalog, the portal Advanced view) selects the user-visible titles.
// It filters the profile's watched IMDb ids out of the stored candidate rows
// BEFORE selectServeFor applies filters, genre/calibrated ordering, and the
// limit — so a watched title is replaced by a valid pool row instead of
// shrinking the catalog after the limit is applied. The watched set unions
// authoritative + pending watches across movie/show types
// (watchedStore.watchedIdSets). Returns the selected RAW pool rows (no meta
// projection, no impression recording), so callers keep their own projection.
// `getRecommended` initialises the store; no external call or write happens here.
function selectedRecommendationRows(profile, type, { limit } = {}) {
  const rows = getRecommended(profile.id, { type, limit: 100000 });
  const watchedImdb = watchedStore.watchedIdSets(profile.id).imdb;
  const dnr = dontRecommendKeys(profile.id);
  const unwatched = rows.filter((row) => !watchedImdb.has(row.imdb_id) && !lanes.dnrTypes(type).some((t) => dnr.has(`${t}:${row.tmdb_id}`)));
  return selectServeFor(profile, type, unwatched, {
    limit: limit ?? listSizeFor(profile),
  });
}

// Build Stremio catalog metas for a profile's AI recommendations of one type.
// Cache-only + cheap (local writes only, no external calls) — safe for the addon
// request path. Records one impression per served title (fuels decay). The served
// count is the profile's list_size filter (an explicit `limit` still overrides).
// `record` defaults ON (a real serve is an impression); the read-only portal /
// companion preview (CP-01) passes record:false so peeking at a catalog never
// advances the decay lifecycle.
function serveRecommendations(profile, type, { limit, record = true } = {}) {
  init();
  const picked = selectedRecommendationRows(profile, type, { limit });
  if (record) recordImpressions(profile.id, picked);
  return picked.map((r) => ({
    id: r.imdb_id,
    type: lanes.itemType(type),
    name: r.title,
    poster: r.poster || null,
    releaseInfo: r.year ? String(r.year) : null,
    genres: (r.genres || '').split(',').filter(Boolean),
    // CP-03: surface the rating the pool already maintains (imdb_rating, kept
    // fresh by refreshStaleRatings) so the CP-01/CP-02 preview badge and the
    // addon-served meta carry it — TMDB vote_average as the fallback, null when
    // neither exists. Projection only: no fetch, no cost on the serve path.
    imdbRating: r.imdb_rating != null ? r.imdb_rating.toFixed(1)
      : (r.vote_average ? r.vote_average.toFixed(1) : null),
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
    'SELECT type, tmdb_id, imdb_id, streak_started_at, times_shown_in_streak, engaged_at FROM recommended WHERE profile_id = ?',
  ).all(profileId);
  let decayed = 0;
  for (const r of rows) {
    // Carry the pool row's imdb_id (MW-03) so a decayed title is filtered from
    // curated catalogs too, not just the AI pool.
    if (shouldDecay(r, nowMs, windowMs)) { addDontRecommend(profileId, r.type, r.tmdb_id, 'decayed', nowMs, r.imdb_id); decayed++; }
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
// time, so they never trigger a rebuild. Trainer T2 (N8): a Trainer edit
// (rating / ignore / finished) ALSO triggers a rebuild — only when the profile's
// movie engine is Marquee (the only engine that reads the taste-feedback store),
// only when the change is NEWER than the last build that included it, and only
// after a 10-minute quiet period. A change landing DURING a build stays newer
// than the build's stamp and triggers the NEXT build.
function needsBuild(profileId, { profile = null, now = Date.now() } = {}) {
  if (countRecommended(profileId) === 0) return true;
  if (watchedStore.newestWatchedMs(profileId) > getBuiltAt(profileId)) return true;
  // Trainer T2 (N8) + TV-R §4: a Trainer edit (rating / ignore / finished)
  // triggers a rebuild when the profile's movie engine is Marquee (the only
  // engine that reads the taste-feedback store for films) OR its series engine
  // is Marquee TV (which reads it for shows). Keep the Marquee Cinema result
  // exactly as before; only add the Marquee TV case.
  if (profile) {
    const engines = require('./engines');
    if (engines.resolveFor(profile, 'movie').id === 'marquee' || engines.resolveFor(profile, 'series').id === 'marquee-tv') {
      if (tasteFeedback.trainingDue(profileId, now)) return true;
    }
  }
  return false;
}

// Build the pool NOW (buildRecommendations + ageGatePool) with progress. This is
// the unit of work the job queue runs; callers should route it through
// jobs.enqueue so builds serialise + report a percentage. Exported so the portal
// and the tick share one implementation.
//
// `{ kind, anchor, startHash }` (feature/ai-catalog-cadence, Stage 2): when
// present, runs the STAGED path (stagedBuildPool) — generate in memory, age-gate
// in memory, acceptance gate, atomic promotion. A failed/partial build never
// mutates the live pool (M6). When absent, runs the existing urgent path
// (buildRecommendations + ageGatePool).
async function buildPool(profile, log = console, onProgress = () => {}, opts = {}) {
  init();
  if (opts.kind) {
    // Staged path (scheduled daily/weekly builds).
    return stagedBuildPool(profile, log, onProgress, {
      kind: opts.kind,
      anchor: opts.anchor,
      startHash: opts.startHash,
    });
  }
  const r = await buildRecommendations(profile, log, (pct, label) => onProgress(pct * 0.85, label)); // 0–85%
  // Age-gate (I1) whenever this build STORED candidates. buildRecommendations no
  // longer reports `skipped` once rows were stored (so `!r.skipped` already covers
  // the normal case), but the `stored > 0` clause is a deliberate belt-and-braces
  // floor: the age gate is the child-safety authority, so it must run over anything
  // that reached the pool regardless of how the skip decision above is computed — a
  // future regression in that logic can never let un-vetted rows serve. The
  // serve-time band re-check is only a lowered-limit net (unrated → kept, no LLM),
  // so this is the real gate. (An engine with 0 seeds stores nothing → no-op.)
  const stored = (r.movie?.stored || 0) + (r.series?.stored || 0);
  if (!r.skipped || stored > 0) await ageGatePool(profile, log, (pct, label) => onProgress(85 + pct * 0.15, label)); // 85–100%
  return r;
}

// Background trigger from the tick: enqueue a pool build only when it's needed.
async function ensureBuilt(profile, log = console) {
  init();
  if (!needsBuild(profile.id, { profile })) return { skipped: 'fresh' };
  const jobs = require('./jobs');
  return jobs.enqueue(profile.id, 'recs', (progress) => buildPool(profile, log, progress));
}

// ENG-1: a settings/engine change must ALWAYS take effect, even while a build
// for this profile is running. Unlike ensureBuilt (which joins the in-flight
// build), this queues a NEW build with afterActive — it runs AFTER the running
// one and reads the profile FRESH when it starts, so the change is never lost.
// The running build holds the profile object captured when it started (still
// the old engine), so joining it would silently drop the change until the next
// scheduled rebuild.
function rebuildAfterChange(profileId, log = console) {
  const jobs = require('./jobs');
  return jobs.enqueue(profileId, 'recs', (progress) => {
    const fresh = require('./config').getProfile(profileId);
    if (!fresh) return { skipped: true, reason: 'profile removed' };
    return buildPool(fresh, log, progress);
  }, { afterActive: true });
}

// ENG-1 (E2): after a successful build of a type, the type's slice must hold
// ONLY the rows produced by that build's engine. Rows of that type with another
// engine_id (including NULL, i.e. legacy rows) are deleted. Only when the build
// stored at least one row — an empty or failed build never prunes. A row the new
// engine re-produced keeps its row and takes the new engine_id via upsert's
// conflict clause, so only true leftovers are removed.
function pruneOtherEngines(profileId, type, engineId) {
  init();
  if (!engineId) return 0;
  const r = db.get().prepare(`
    DELETE FROM recommended
    WHERE profile_id = ? AND type = ? AND (engine_id IS NULL OR engine_id != ?)
  `).run(profileId, String(type), String(engineId));
  return Number(r.changes || 0);
}

module.exports = {
  init,
  buildRecommendations,
  ageGatePool,
  buildPool,
  // feature/ai-catalog-cadence (Stage 2): the staged build path.
  stagedBuildPool,
  stagedAgeGate,
  acceptanceGate,
  atomicPromotion,
  ensureBuilt,
  rebuildAfterChange,
  pruneOtherEngines,
  needsBuild,
  resetRecommendations,
  clearType,
  upsertCandidates,
  setAgeClassification,
  setCertification,
  purgeBelowVoteFloor,
  pruneSupersededVersions,
  refreshStaleRatings,
  getRecommended,
  countRecommended,
  dontRecommendKeys,
  dontRecommendImdbSet,
  getDontRecommendRows,
  addDontRecommend,
  removeDontRecommend,
  deleteForProfile,
  selectServe,
  filterServable,
  selectServeFor,
  selectedRecommendationRows,
  _resetServeWarnings,
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
  SERVE_LIMIT,
  DECAY_WINDOW_MS,
  FALLOFF_GAP_MS,
  DECAY_COOLDOWN_MS,
  DECAY_MIN_DAYS,
};
