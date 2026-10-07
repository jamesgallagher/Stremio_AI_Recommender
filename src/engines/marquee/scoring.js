// Marquee ME-06 (spec §4.5/§7/§8.4) — look up full metadata for the ~400
// candidates ME-05 kept, apply the hard filter (MI-1: every returned row
// passes it), compute the deterministic score, and return pre-resolved,
// sorted candidates for the shared pipeline.
//
// MI-5: lookups are chunked (cfg.lookup_chunk) and ≤ candidates.length ≤
// lookup_cap per build. I4: the engine NEVER writes imdb_rating — the pipeline
// owns that column; the MDBList value is carried only in scoreComponents.inputs.
// MD-2: trending_eff = trending_raw × tasteGate(taste_match) — trending only
// lifts films that already fit the viewer.
const metaStore = require('../shared/metaStore');
const sharedScoring = require('../shared/scoring');
const features = require('./features');
const recency = require('../../recency');
const tmdb = require('../../services/tmdb');
const mdblist = require('../../services/mdblist');
const animeMap = require('../../services/animeMap');
const recommendationStore = require('../../recommendationStore');
const { strictestCert } = require('../../certs');
const { ALGORITHM_VERSION } = require('./config');

const DAY_MS = 24 * 3600e3;

// The decayed-collection penalty map, built ONCE per build (spec §4.5.5):
// dont_recommend rows with reason 'decayed' → their deep meta → counted by
// collection.id. A candidate in a collection the user decayed twice loses
// 2 × cfg.decayed_collection_penalty.
function decayedCollectionCounts(profileId) {
  const rows = recommendationStore.getDontRecommendRows(profileId, 'movie').filter((r) => r.reason === 'decayed');
  const metas = metaStore.getMany('movie', rows.map((r) => r.tmdb_id));
  const counts = {};
  for (const r of rows) {
    const id = metas.get(String(r.tmdb_id))?.collection?.id;
    if (id != null) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

// The live fetchers, bound to ctx (spec §4.5).
function defaultFetchers(ctx, log) {
  return {
    deepMeta: (apiKey, type, id, l) => tmdb.deepMeta(apiKey, type, id, l),
    // Only called when ctx.mdblistKey is set (the caller guards it).
    imdbRatings: (ids) => mdblist.cachedImdbRatings(ctx.mdblistKey, 'movie', ids, log),
  };
}

// ME-06 entry (spec §4.5). `candidates` are ME-05's output (≤ lookup_cap);
// `gatherMeta` is ME-05's meta ({ weekN, dayN, hadTrending }). Returns
// { scored: NormalizedCandidate[] (sorted rankScore desc), envelopeStats }.
async function scoreCandidates(profile, ctx, candidates, {
  taste, envelope, cfg, gatherMeta, fetchers, nowYear = new Date().getFullYear(), nowMs = Date.now(), log = console, onProgress = () => {},
} = {}) {
  const f = fetchers || defaultFetchers(ctx, log);
  const filters = ctx.filters || {};
  const type = 'movie';

  // Anime map once per build (graceful: a failure just disables the tag).
  await animeMap.ensureLoaded(log).catch(() => {});

  const decayedCount = decayedCollectionCounts(profile.id);
  // m4 (spec §17): genre-fair agreement — the seed affinity and consensus
  // features blend the global normalisation with a within-genre one. β=0
  // reproduces m3 exactly (the off-switch: settings.marquee.agreement).
  const agreementBlend = cfg.agreement?.genre_blend ?? 0;
  const agreementMinSize = cfg.agreement?.min_genre_size ?? 5;
  // m2 diagnostics (see sources.js): record where a looked-up title is lost.
  const trace = ctx.marqueeTrace || null;

  // 1. Lookup in chunks of cfg.lookup_chunk (MI-5). Refetch (spec §4.5.1):
  // no cached row; a pre-ME-02 row (no availability key); or a NOT_YET row
  // older than availability_recheck_days. A null refetch falls back to the
  // cached meta when there is one; otherwise the candidate is dropped.
  const looked = []; // { cand, meta }
  let lookups = 0;   // deepMeta calls actually made (cache hits cost 0)
  let noImdb = 0;
  for (let i = 0; i < candidates.length; i += cfg.lookup_chunk) {
    const chunk = candidates.slice(i, i + cfg.lookup_chunk);
    await Promise.all(chunk.map(async (cand) => {
      const cached = metaStore.getWithAge(type, cand.tmdb_id);
      let meta = cached ? cached.meta : null;
      const fetchedAt = cached ? cached.fetched_at : null;
      const stale = meta == null
        || !('availability' in meta)
        || (meta.availability === 'NOT_YET' && (fetchedAt == null || nowMs - fetchedAt > cfg.availability_recheck_days * DAY_MS));
      if (stale) {
        lookups += 1;
        const fresh = await f.deepMeta(ctx.tmdbKey, type, cand.tmdb_id, log);
        if (fresh) { metaStore.put(type, cand.tmdb_id, fresh); meta = fresh; }
        // null refetch: keep the cached meta if there is one.
      }
      if (!meta) { noImdb += 1; if (trace?.dropped) trace.dropped.set(cand.tmdb_id, 'lookup_failed'); return; }
      looked.push({ cand, meta });
    }));
    onProgress(Math.round((Math.min(i + cfg.lookup_chunk, candidates.length) / (candidates.length || 1)) * 100), `Looked up ${Math.min(i + cfg.lookup_chunk, candidates.length)}/${candidates.length} candidate(s)`);
  }

  // m4 (spec §17): the genre-fair agreement normalisations, built over the
  // SCORED candidates (the same set the m3 global max used). The genre group
  // is the deep-meta primary genre; a candidate whose lookup failed has no
  // group (global normalisation only).
  const metaOf = new Map(looked.map(({ cand, meta }) => [cand.tmdb_id, meta]));
  const groupOf = (c) => {
    const meta = metaOf.get(c.tmdb_id);
    if (!meta) return null;
    return (meta.genres || [])[0] || 'Other';
  };
  const saNorm = features.genreRelativeNormalizer(candidates, features.seedAffinityRaw, groupOf,
    { blend: agreementBlend, minGroupSize: agreementMinSize });
  // m4: consensus is NOT global-normalised in m3, so its within-genre term
  // divides by the group max and falls back to the RAW value (not a global
  // normalisation) — β=0 stays exact (spec §17).
  const consensusRaw = (c) => features.consensus(c.sources, c.seeds);
  const consensusGroupMax = {};
  const consensusGroupSize = {};
  for (const c of candidates) {
    const v = consensusRaw(c);
    const g = groupOf(c);
    if (g != null) {
      if (v > (consensusGroupMax[g] || 0)) consensusGroupMax[g] = v;
      consensusGroupSize[g] = (consensusGroupSize[g] || 0) + 1;
    }
  }
  const consNorm = (c) => {
    const raw = consensusRaw(c);
    const g = groupOf(c);
    const genreNorm = (g != null && (consensusGroupSize[g] || 0) >= agreementMinSize && (consensusGroupMax[g] || 0) > 0)
      ? Math.min(1, raw / consensusGroupMax[g])
      : raw;
    return (1 - agreementBlend) * raw + agreementBlend * genreNorm;
  };

  // 3. One IMDb-rating call for the whole build (I4: the engine never writes
  // the column; the value lives only in scoreComponents.inputs). A failure
  // means an empty map (ratings fall back to TMDB vote_average).
  let ratings = new Map();
  if (ctx.mdblistKey && looked.length) {
    const allImdbIds = [...new Set(looked.map(({ meta }) => meta.imdb_id).filter(Boolean))];
    try { ratings = (await f.imdbRatings(allImdbIds)) || new Map(); } catch { ratings = new Map(); }
  }

  // 4/5/6/7. Hard filter + features + renormalized weights + pre-resolved rows.
  const scored = [];
  for (const { cand, meta } of looked) {
    // Anime tag for MOVIES (spec §4.5.2): parity with the shared resolve path —
    // without it, excluded_genres: ['Anime'] would leak anime films at serve.
    let genres = (meta.genres || []).slice();
    if (animeMap.isAnime(meta.imdb_id, cand.tmdb_id) && !genres.includes('Anime')) genres = ['Anime', ...genres];

    const imdbRating = meta.imdb_id ? (ratings.get(meta.imdb_id) ?? null) : null;
    const verdict = envelope.hardFilter({
      imdb_id: meta.imdb_id, imdb_rating: imdbRating,
      vote_average: meta.vote_average, vote_count: meta.vote_count,
      year: meta.year, genres, availability: meta.availability,
      certAU: meta.certAU, certUS: meta.certUS,
    });
    if (!verdict.ok) { // MI-1: never return a row the envelope rejects
      if (trace?.dropped) trace.dropped.set(cand.tmdb_id, `hard_filter:${verdict.reason}`);
      continue;
    }

    const tm = sharedScoring.tasteMatch(meta, taste, cfg);
    const trendingRaw = features.trendingRaw(cand.trending, { ...gatherMeta, risingTop: cfg.trending.rising_top, risingBonus: cfg.trending.rising_bonus });
    const cert = strictestCert(meta.certAU, meta.certUS);
    const feat = {
      taste_match: tm.score,
      trending_raw: trendingRaw,
      // MD-2: trending only lifts films that already fit the viewer.
      trending_eff: trendingRaw * features.tasteGate(tm.score, cfg.trending_gate),
      quality: features.quality({ imdbRating, voteAverage: meta.vote_average, voteCount: meta.vote_count }, cfg.quality_prior),
      // m4 (spec §17): genre-fair agreement — both features blend the global
      // normalisation with the within-genre one (β = cfg.agreement.genre_blend).
      consensus: consNorm(cand),
      // m2: Genesis's recency-weighted seed agreement, normalised per build.
      seed_affinity: saNorm(cand),
      freshness: features.freshness(meta.year, { nowYear, maxAgeYears: recency.maxAgeOf(filters, nowYear), defaultWindow: cfg.freshness_default_window, floor: cfg.freshness_floor }),
    };
    // llm_fit is always absent here (P4 adds it); trending_eff is absent when
    // no trending list existed (spec §4.5.6). Renormalize keeps ratios.
    const available = Object.keys(cfg.weights).filter((k) => k !== 'llm_fit' && !(k === 'trending_eff' && !gatherMeta.hadTrending));
    const w = features.renormalize(cfg.weights, available);
    const penalty = cfg.decayed_collection_penalty * (meta.collection?.id != null ? (decayedCount[meta.collection.id] || 0) : 0);
    const rankScore = features.weightedSum(feat, w) - penalty;

    // _fit.seedTitle: the strongest seed (highest weight) — P4's "because you
    // watched …" fallback. Fallback to the first seed when no weights are recorded.
    let seedTitle = null;
    if (cand._seedWeights?.size) {
      let best = null;
      for (const [sid, wgt] of cand._seedWeights) if (best == null || wgt > best[1]) best = [sid, wgt];
      seedTitle = best ? (cand.seedTitles.get(best[0]) || null) : null;
    } else if (cand.seeds?.size) {
      seedTitle = cand.seedTitles.get([...cand.seeds][0]) || null;
    }

    scored.push({
      type,
      tmdb_id: cand.tmdb_id,
      imdb_id: meta.imdb_id,
      title: meta.title || cand.title,
      year: meta.year ?? cand.year,
      poster: meta.poster, // ALREADY a full URL in metaStore — do not prefix again
      genres: genres.join(','), // CSV string (the pipeline/upsert contract)
      primary_genre: genres[0] || null,
      vote_average: meta.vote_average,
      vote_count: meta.vote_count,
      popularity: meta.popularity || cand.popularity || 0,
      certification: cert, // ignored by upsert until P5 adds the column; harmless now
      rankScore,
      reason: null, // P4 fills it
      recCount: cand.sources.size,
      // The version constant, not cfg: resolveConfig never carries it, so the
      // old `cfg.ALGORITHM_VERSION || 'marquee-m1'` stamped m1 on every row forever.
      algorithmVersion: ALGORITHM_VERSION,
      scoreComponents: {
        features: feat, weights: w, penalty, matched: tm.matched,
        sources: [...cand.sources], seeds: [...cand.seeds],
        trending: { ...cand.trending },
        // m4 (spec §17): the genre-fair agreement trace — which genre group
        // the candidate was judged in, and the blend actually applied.
        agreement: { group: groupOf(cand) || 'Other', blend: agreementBlend },
        // I4: the imdb rating lives ONLY here, never as a top-level key.
        inputs: { imdb_rating: imdbRating, collection_id: meta.collection?.id ?? null, cert, availability: meta.availability },
      },
      _fit: {
        overview: (meta.overview || '').slice(0, 160),
        director: (meta.director || [])[0] || null,
        keywords: (meta.keywords || []).slice(0, 5),
        seedTitle,
      },
    });
  }

  if (ctx.stats) {
    ctx.stats.lookups = lookups;
    ctx.stats.no_imdb = noImdb;
    ctx.stats.scored = scored.length;
  }
  // rankScore desc, ties broken by tmdb_id (spec §4.5.8).
  scored.sort((a, b) => (b.rankScore - a.rankScore) || (a.tmdb_id < b.tmdb_id ? -1 : 1));
  onProgress(100, `Scored ${scored.length} candidate(s)`);
  // Review round 1 (S2): candidates whose lookup returns nothing are counted
  // in no_imdb, not just in ctx.stats — P4's shortfall log reads envelopeStats.
  const stats = envelope.stats();
  return { scored, envelopeStats: { ...stats, no_imdb: stats.no_imdb + noImdb } };
}

module.exports = { scoreCandidates, defaultFetchers, decayedCollectionCounts };
