// Glass candidate generation (GE-05, design §4.2) — the strategies A–G that
// widen the candidate set beyond Genesis's "recommendations of what you watched",
// deduped with a retained sources[] (for explanations), exploration injected, and
// GI-1 truncation to a resolve-affordable slice BEFORE the return.
//
// Strategies:
//   A/B  Taste similarity / Because-you-liked — TMDB /recommendations per strong
//        recent seed (Genesis's mechanism; the only NETWORK step here).
//   C/D/E/F  Recent / Trending / Popular / Hidden gems — from the Simkl trending
//        cache (GE-02), filtered by the profile's top-genre affinities. movie ←
//        movies; series ← tv ∪ anime. No extra calls (in-file fields only).
//   G    Exploration — high-quality trending OUTSIDE the profile's top genres,
//        reserved a slice of the output so the pool always has some reach.
//
// GI-1 (performance invariant): however wide the internal set, this returns
// ≤ resolve_cap candidates, because GE-06 makes ONE TMDB append call per returned
// candidate. Truncation is by a CHEAP pre-score over free/in-file fields only (no
// per-candidate network) — the deep intersect scoring happens in GE-06 on the
// kept set.
const tmdb = require('../../services/tmdb');

const key = (type, tmdbId) => `${type}:${tmdbId}`;
const num = (v) => (Number.isFinite(v) ? v : 0);

// Map a Simkl trending item (GE-02 normalized) → a Glass candidate.
function mapTrending(item, type) {
  return {
    type,
    tmdb_id: String(item.tmdb_id),
    imdb_id: item.imdb_id || null,
    title: item.title,
    year: item.year,
    genres: Array.isArray(item.genres) ? item.genres : [],
    vote_average: item.ratings?.imdb?.rating ?? item.ratings?.simkl?.rating ?? 0,
    vote_count: item.ratings?.imdb?.votes ?? 0,
    imdb_rating_infile: item.ratings?.imdb?.rating ?? null,   // in-file quality (P4-clean)
    popularity: 0,                                            // trending has no TMDB popularity; velocity stands in
    watched24h: num(item.watched),
    drop_rate: item.drop_rate,
    original_language: item.original_language || null,
    poster: null,
    sources: [],
    reason: null,
  };
}

// Map a TMDB /recommendations item (tmdb.getRecommendations) → a Glass candidate.
// `genreMap` (id→name) converts genre_ids to the same NAME space trending uses.
function mapRec(r, type, seedTitle, genreMap) {
  const genres = (r.genre_ids || []).map((g) => genreMap[g]).filter(Boolean);
  return {
    type,
    tmdb_id: String(r.tmdb_id),
    imdb_id: null,                       // recs don't carry a tt id (resolved later)
    title: r.title,
    year: r.year,
    genres,
    vote_average: num(r.vote_average),
    vote_count: num(r.vote_count),
    imdb_rating_infile: null,
    popularity: num(r.popularity),
    watched24h: 0,
    drop_rate: null,
    original_language: null,
    adult: !!r.adult,
    poster: r.poster || null,
    sources: [],
    reason: seedTitle ? `because you watched ${seedTitle}` : null,
  };
}

// Merge candidate `b` into existing `a` (same title from >1 strategy): union
// sources, keep the first non-null of each optional field, prefer a because-reason.
function merge(a, b) {
  a.sources = [...new Set([...(a.sources || []), ...(b.sources || [])])];
  a.imdb_id = a.imdb_id || b.imdb_id;
  a.poster = a.poster || b.poster;
  a.reason = a.reason || b.reason;
  a.genres = (a.genres && a.genres.length) ? a.genres : b.genres;
  a.vote_average = a.vote_average || b.vote_average;
  a.vote_count = a.vote_count || b.vote_count;
  a.popularity = a.popularity || b.popularity;
  a.imdb_rating_infile = a.imdb_rating_infile ?? b.imdb_rating_infile;
  a.watched24h = Math.max(num(a.watched24h), num(b.watched24h));
  if (a.drop_rate == null) a.drop_rate = b.drop_rate;
  a.original_language = a.original_language || b.original_language;
  return a;
}

// De-dupe a candidate list by (type, tmdb_id), merging sources/fields. Preserves
// first-seen order. Exported for tests.
function dedupe(cands) {
  const byKey = new Map();
  for (const c of cands) {
    const k = key(c.type, c.tmdb_id);
    const ex = byKey.get(k);
    if (ex) merge(ex, c); else byKey.set(k, c);
  }
  return [...byKey.values()];
}

// Genre affinity of a candidate vs the taste model (max over its genres). 0..1.
function genreAffinity(cand, taste) {
  const g = taste.dims?.genres || {};
  let best = 0;
  for (const name of cand.genres || []) best = Math.max(best, g[name] || 0);
  return best;
}

// CHEAP pre-score for GI-1 truncation: free/in-file fields only, NO network.
// Genre affinity (base) + trending velocity + momentum + quality + popularity.
// Deliberately coarse — GE-06 does the real weighted scoring on the kept set.
function preScore(cand, taste) {
  const ga = genreAffinity(cand, taste);
  // Calibrated to the real Simkl CDN (verified 2026-09-10): watched maxes ~1500;
  // drop_rate is a positive % decline (low = sticky).
  const velocity = cand.watched24h > 0 ? Math.log1p(cand.watched24h) / Math.log1p(2000) : 0;
  const stickiness = cand.drop_rate != null ? Math.max(0, Math.min(1, 1 - cand.drop_rate / 10)) : 0.6;
  const q = (cand.imdb_rating_infile ?? cand.vote_average ?? 0) / 10;
  const pop = cand.popularity > 0 ? Math.log1p(cand.popularity) / Math.log1p(1000) : 0;
  return 0.45 * ga + 0.20 * velocity + 0.12 * stickiness + 0.15 * q + 0.08 * pop;
}

// Does a candidate fall OUTSIDE the profile's top genres? (exploration eligibility)
function outsideTopGenres(cand, topSet) {
  if (!cand.genres || !cand.genres.length) return false;
  return !cand.genres.some((g) => topSet.has(g));
}

// The strongest recent watched titles that seed A/B recommendations, newest-first.
function seedsFor(watched, seedCap) {
  const ts = (w) => { const t = w.watched_at ? Date.parse(w.watched_at) : NaN; return Number.isNaN(t) ? 0 : t; };
  return watched.filter((w) => w.tmdb_id).sort((a, b) => ts(b) - ts(a)).slice(0, seedCap);
}

// Generate + dedupe + explore-reserve + GI-1-truncate the candidate set for one
// type. Returns ≤ cfg.resolve_cap candidates, each carrying sources[] + a cheap
// _preScore (GE-06 replaces it with the real rankScore). NETWORK only via
// `recsFetcher` (default tmdb.getRecommendations); trending is passed in already-
// fetched. Injectables keep it fully testable offline.
async function generateCandidates(profile, type, ctx, taste, cfg, {
  trendingItems = [],              // GE-02 normalized items for this type (movie: movies; series: tv∪anime)
  watched = [],                    // watchedStore rows for this type (seed source)
  recsFetcher = tmdb.getRecommendations,
  genreMap = {},
  log = console,
} = {}) {
  const st = cfg.strategies;
  const watchedTmdb = ctx?.watchedIds?.tmdb || new Set();
  const dont = ctx?.dont || new Set();
  const notExcluded = (c) => !watchedTmdb.has(c.tmdb_id) && !dont.has(key(c.type, c.tmdb_id)) && !c.adult;

  const pool = [];

  // A/B — TMDB /recommendations per strong recent seed (network, governed).
  const seeds = seedsFor(watched, st.seed_cap[type] ?? 40);
  let recFetched = 0;
  for (let i = 0; i < seeds.length; i += 5) {
    const chunk = seeds.slice(i, i + 5);
    await Promise.all(chunk.map(async (seed) => {
      try {
        const recs = await recsFetcher(ctx.tmdbKey, type, seed.tmdb_id);
        recFetched += recs.length;
        for (const r of recs.slice(0, st.recs_per_seed)) {
          const c = mapRec(r, type, seed.title, genreMap);
          c.sources.push('recommendations');
          pool.push(c);
        }
      } catch (err) { log.warn(`[glass] recs for ${seed.title} failed: ${err.message}`); }
    }));
  }

  // C–F — trending, genre-filtered by the profile's top affinities. Tag sub-
  // strategies from in-file predicates (recent release / hidden gem) for reasons.
  const topGenresList = require('./tasteModel').topGenres(taste, 6);
  const topSet = new Set(topGenresList);
  const nowYear = new Date().getFullYear();
  const trend = trendingItems.slice(0, st.trending_take).map((it) => mapTrending(it, type));
  // Rating for the source-tag predicates: in-file imdb, else vote_average (which
  // already falls back imdb→simkl, so anime — which carries no imdb — still counts).
  const ratingOf = (c) => (c.imdb_rating_infile ?? c.vote_average ?? 0);
  for (const c of trend) {
    const inTaste = (c.genres || []).some((g) => topSet.has(g));
    if (!inTaste) continue;                         // C–F are taste-filtered; G handles the rest
    c.sources.push('trending');
    if (c.year && c.year >= nowYear - 1) c.sources.push('recent');
    // Hidden gem = well-rated but LOWER visibility (watched p90 ≈ 100 on the real feed).
    if (ratingOf(c) >= 7.5 && (c.watched24h || 0) < 100) c.sources.push('hidden_gem');
    pool.push(c);
  }

  // De-dupe A/B + C–F, then apply the shared exclusions (optimization; the
  // pipeline re-subtracts — I5).
  let merged = dedupe(pool).filter(notExcluded);
  for (const c of merged) c._preScore = preScore(c, taste);

  // G — exploration reserve. High-quality trending OUTSIDE the top genres, not
  // already in the merged set. Reserve a fraction of the output for these.
  const pct = Math.max(0, Math.min(0.10, st.exploration_pct || 0));
  const cap = cfg.resolve_cap;
  const reserve = Math.round(cap * pct);
  const have = new Set(merged.map((c) => key(c.type, c.tmdb_id)));
  const explore = trendingItems
    .map((it) => mapTrending(it, type))
    .filter((c) => notExcluded(c) && !have.has(key(c.type, c.tmdb_id)) && outsideTopGenres(c, topSet) && (c.imdb_rating_infile ?? c.vote_average ?? 0) >= 6.5)
    .sort((a, b) => num(b.watched24h) - num(a.watched24h))
    .slice(0, reserve)
    .map((c) => { c.sources.push('exploration'); c._preScore = preScore(c, taste) + 0.001; return c; });

  // GI-1 truncation: fill (cap − reserve) from the taste-matched set by pre-score,
  // then add the exploration reserve. Final length ≤ cap.
  merged.sort((a, b) => b._preScore - a._preScore);
  const mainSlice = merged.slice(0, Math.max(0, cap - explore.length));
  const out = dedupe([...mainSlice, ...explore]);

  if (ctx.stats) {
    ctx.stats.seeds = seeds.length;
    ctx.stats.raw = recFetched + trend.length;
    ctx.stats.strong = merged.length;
    ctx.stats.explore = explore.length;
  }
  return out.slice(0, cap);
}

module.exports = {
  generateCandidates,
  mapTrending,
  mapRec,
  dedupe,
  preScore,
  genreAffinity,
  seedsFor,
  outsideTopGenres,
};
