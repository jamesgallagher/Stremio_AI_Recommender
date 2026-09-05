// Genesis Engine (SC-01) — the ORIGINAL recommendation engine, extracted as the
// first plug-in behind the engine abstraction. Its behaviour is IDENTICAL to
// the pre-abstraction monolith in recommendationStore.buildRecommendations: for
// the SEED_CAP most-recent watched titles OF ONE TYPE it pulls TMDB's per-title
// /recommendations, keeps the strongest few per title (clearing the vote-count
// floor), scores by RECENCY-WEIGHTED AFFINITY, excludes watched + rejected, and
// returns the top STORE_CAP candidates.
//
// It is a pure CANDIDATE PRODUCER: it does NOT resolve tt-ids/posters/genres,
// IMDb-enrich, upsert, purge, or age-gate — the shared pipeline
// (src/engines/pipeline.js) does all of that from any engine's output.
//
// This file OWNS the Genesis parameters (SEED_CAP / HALF_LIFE_DAYS /
// PER_TITLE_CAP / STORE_CAP) and the Genesis-specific pure candidate logic
// (selectStrong, computeAffinity). recommendationStore re-exports selectStrong /
// computeAffinity / HALF_LIFE_DAYS / PER_TITLE_CAP so existing imports and the
// smoke tests keep resolving them from their old home.
const tmdb = require('../services/tmdb');
const watchedStore = require('../watchedStore');
const settings = require('../settings');

const HALF_LIFE_DAYS = 90;  // recency weight = 0.5 ^ (days_since_watched / this)
// PER-TYPE seed caps: the N most-recent watched titles of each type seed recs.
// Movies get a higher cap (deeper back-catalogue); series (shows + anime, which
// share the `series` type) get their own so a run of freshly-watched shows can't
// crowd movies out and vice versa.
const SEED_CAP = { movie: 150, series: 100 };
const seedCapFor = (type) => SEED_CAP[type] ?? 100;
const STORE_CAP = 300;      // keep the top-N candidates by affinity, PER TYPE
const PER_TITLE_CAP = 5;    // strongest recommendations kept per source title
const DAY_MS = 24 * 3600e3;

const key = (type, tmdbId) => `${type}:${tmdbId}`;

// The strongest ≤N recommendations for one source title (relevance order), gated
// by the porn flag and a vote-count floor (0 = no gate; callers pass the profile's).
// The vote-count floor is enforced HERE, at build, ON PURPOSE (decided
// 2026-08-27): a sub-floor title must never be STORED, not merely hidden at
// serve. It can return on a later build once its vote count climbs past the floor.
function selectStrong(recs, voteFloor = 0) {
  return (recs || [])
    .filter((r) => !r.adult && (r.vote_count || 0) >= voteFloor)
    .slice(0, PER_TITLE_CAP); // TMDB relevance order preserved
}

// PURE: aggregate recommendations into scored candidates. Exported (via
// recommendationStore) for testing.
//   seeds:          [{ tmdb_id, type, watched_at, title }]
//   recsBySeed:     Map<`type:tmdb_id`, recs[]>  (recs from tmdb.getRecommendations)
// Returns Map<`type:tmdb_id`, candidate> with affinity + rec_count + because_title
// (the strongest-contributing watched title — the "because you watched X" reason;
// _because_weight is a transient field used only to pick it, not stored).
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
      if (!c) { c = { ...r, affinity: 0, rec_count: 0, because_title: null, _because_weight: -1 }; out.set(k, c); }
      c.affinity += weight;
      c.rec_count += 1;
      // Strongest contributor wins the reason. Strict `>` + most-recent-first
      // seed order means ties go to the most recently watched title.
      if (weight > c._because_weight) { c._because_weight = weight; c.because_title = seed.title || null; }
    }
  }
  return out;
}

// Produce candidates for ONE type. Slices STORE_CAP AFTER the watched/rejected
// exclusion (exactly as the monolith did) so the stored slice is byte-identical;
// the pipeline re-subtracts the same sets as the shared invariant (I5). Returns
// NormalizedCandidate[] with rankScore set — NOT resolved/enriched.
async function generate(profile, type, ctx, onProgress = () => {}) {
  const { tmdbKey, filters = {}, log = console } = ctx;

  // 1. Seed: the SEED_CAP[type] most-recent watched titles OF THIS TYPE, newest
  //    first (so computeAffinity's recency tie-break credits the latest watch).
  const seedTs = (w) => { const t = w.watched_at ? Date.parse(w.watched_at) : NaN; return Number.isNaN(t) ? 0 : t; };
  const seeds = watchedStore.getWatched(profile.id, { type })
    .filter((w) => w.tmdb_id)
    .slice(0, seedCapFor(type))
    .sort((a, b) => seedTs(b) - seedTs(a));
  if (ctx.stats) ctx.stats.seeds = seeds.length;
  if (!seeds.length) { onProgress(100, `Genesis: no ${type} seeds`); return []; }

  // 2. TMDB per-seed recs → strongest few/title, gated by the vote-count floor
  //    (the ONE build-time user preference) + the porn flag.
  const recsBySeed = new Map();
  let rawFetched = 0;
  let seedsDone = 0;
  onProgress(0, `Scanning ${seeds.length} watched ${type}(s) for recommendations…`);
  for (let i = 0; i < seeds.length; i += 5) {
    const chunk = seeds.slice(i, i + 5);
    await Promise.all(chunk.map(async (w) => {
      try {
        const recs = await tmdb.getRecommendations(tmdbKey, w.type, w.tmdb_id);
        rawFetched += recs.length;
        recsBySeed.set(key(w.type, w.tmdb_id), selectStrong(recs, tmdb.voteFloor(filters, w.type)));
      } catch (err) { log.warn(`[rec] recs for ${w.title} failed: ${err.message}`); }
      seedsDone++;
    }));
    onProgress((seedsDone / seeds.length) * 90, `Scanned ${seedsDone}/${seeds.length} watched ${type}(s)`);
  }

  // 3. Recency-weighted affinity.
  const candidates = computeAffinity(seeds, recsBySeed);
  if (ctx.stats) { ctx.stats.raw = rawFetched; ctx.stats.strong = candidates.size; }

  // 4. Exclude watched + dont_recommend BEFORE the STORE_CAP slice (the pipeline
  //    resolved these sets into ctx). Genesis pre-excludes as an optimization;
  //    the pipeline re-subtracts the same sets to guarantee I5 for every engine.
  const watchedTmdb = ctx.watchedIds?.tmdb || new Set();
  const dont = ctx.dont || new Set();
  const kept = [];
  for (const c of candidates.values()) {
    if (watchedTmdb.has(c.tmdb_id)) continue;             // already watched
    if (dont.has(key(c.type, c.tmdb_id))) continue;       // user-rejected / decayed
    kept.push(c);
  }
  kept.sort((a, b) => b.affinity - a.affinity || b.popularity - a.popularity);
  const top = kept.slice(0, STORE_CAP);
  if (ctx.stats) ctx.stats.kept = kept.length;

  // 5. rankScore is exactly today's affinity — expose the contract field (I6).
  //    Candidates still carry genre_ids + bare poster path; the pipeline resolves.
  for (const c of top) c.rankScore = c.affinity;
  onProgress(100, `Genesis: ${top.length} ${type} candidate(s)`);
  return top;
}

// User-facing engine description (overview §6). Shown in the portal + companion
// engine selectors (cards 04/05).
const DESCRIPTION = 'Builds from your Simkl watch history. For every title '
  + 'you\'ve watched it pulls TMDB\'s "more like this" recommendations, weights '
  + 'them so what you watched recently counts for more, and blends them into one '
  + 'ranked, genre-balanced list. Recency-weighted collaborative filtering — the '
  + 'original engine.';

/** @type {import('./types').Engine} */
module.exports = {
  id: 'genesis',
  name: 'Genesis Engine',
  description: DESCRIPTION,
  supportedTypes: ['movie', 'series'],
  capabilities: {
    providesRankScore: true,
    preResolved: false,       // pipeline resolves tt-id / poster / genres
    serveOrder: 'affinity',
    unrestricted: false,      // age-GATED — safe for any profile via the shared age gate
  },
  requirements(profile) {
    const missing = [];
    if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    if (!profile?.simkl_auth?.access_token) missing.push('Simkl connection');
    return { ok: missing.length === 0, missing };
  },
  generate,
  // Genesis parameters + pure candidate logic — re-exported by recommendationStore
  // so existing imports/tests keep resolving them from their old home.
  selectStrong,
  computeAffinity,
  seedCapFor,
  HALF_LIFE_DAYS,
  SEED_CAP,
  STORE_CAP,
  PER_TITLE_CAP,
};
