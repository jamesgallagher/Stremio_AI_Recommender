// Glass feature calc + weighted base scoring (GE-06, design §4.2/§4.3) — turns
// the GI-1-truncated candidate slice into stored pool rows: enrich each (one TMDB
// append call, GE-03, cached), compute the normalized 0–1 features, combine them
// by the configurable weight vector into a single comparable rankScore (→ the
// `affinity` column, I6), and emit the per-feature breakdown as score_components
// (GE-01) with algorithm_version stamped.
//
// Because Glass enriches here, the returned candidates are preResolved (imdb_id +
// poster + genres from the append call) — the shared pipeline skips its own
// imdbFor (design §5.5). A candidate TMDB can't resolve to a tt id is dropped
// (preResolved contract). quality is scored on TMDB vote_average, NEVER a
// finalised IMDb rating (P4/I4 — the pipeline enriches that AFTER generate()).
const metaStore = require('./metaStore');
const animeMap = require('../../services/animeMap');
const { ALGORITHM_VERSION } = require('./config');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const { runtimeBand } = require('./tasteModel');

// ── individual features (all pure, all 0–1) ──

// Best SIGNED affinity among the candidate's keys that appear in the taste map;
// 0 when none appear (GE-10). A liked key (positive) wins over a rejected one, but
// a candidate whose ONLY shared key was rejected goes negative — pulling
// taste_match down. Absent key → 0 (neutral), never a penalty.
function bestAff(keys, map) {
  let best = 0; let hit = false;
  for (const k of keys) {
    const v = map[k];
    if (v === undefined || v === 0) continue;
    if (!hit || v > best) { best = v; hit = true; }
  }
  return hit ? best : 0;
}

// taste_match: dim-intersect affinity vs the taste model. Genre/decade/language/
// runtime are the dense BASE; director/franchise/cast/keyword are sparse BONUSES
// (design §5.5). Signed (GE-10): a rejected dim contributes NEGATIVELY, and the
// final score is clamped to [0,1]. `matched` records only the POSITIVE hits (the
// "because…" explanation never cites a rejection).
function tasteMatch(meta, taste, cfg) {
  const d = taste.dims;
  const sw = cfg.taste_dims;
  const matched = {};

  const genreAff = bestAff(meta.genres || [], d.genres);
  const decadeAff = meta.decade != null ? (d.decades[String(meta.decade)] || 0) : 0;
  const langAff = meta.original_language ? (d.languages[meta.original_language] || 0) : 0;
  const band = runtimeBand(meta.runtime, meta.type);
  const runtimeAff = band ? (d.runtimeBands[band] || 0) : 0;

  const directorAff = bestAff(meta.director || [], d.directors);
  const dirPos = (meta.director || []).filter((x) => (d.directors[x] || 0) > 0);
  if (dirPos.length) matched.director = dirPos;

  const frKeys = [];
  if (meta.collection?.id != null) frKeys.push(`c:${meta.collection.id}`);
  for (const n of meta.networks || []) frKeys.push(`n:${n}`);
  const franchiseAff = bestAff(frKeys, d.franchises);
  const frPos = frKeys.filter((k) => (d.franchises[k] || 0) > 0)
    .map((k) => (k.startsWith('c:') ? (meta.collection?.name || k) : k.slice(2)));
  if (frPos.length) matched.franchise = frPos;

  const castAff = bestAff(meta.cast || [], d.cast);
  const castPos = (meta.cast || []).filter((x) => (d.cast[x] || 0) > 0);
  if (castPos.length) matched.cast = castPos;

  // keyword: gated by a minimum shared-count floor (any non-zero shared keyword
  // counts, liked or rejected), then the best signed affinity.
  const kwShared = (meta.keywords || []).filter((x) => (d.keywords[x] ?? 0) !== 0);
  let keywordAff = 0;
  if (kwShared.length >= (cfg.keyword_min_shared || 1)) {
    keywordAff = bestAff(meta.keywords || [], d.keywords);
    const kwPos = kwShared.filter((x) => d.keywords[x] > 0);
    if (kwPos.length) matched.keywords = kwPos;
  }

  const score = sw.genres * genreAff + sw.decade * decadeAff + sw.language * langAff
    + sw.runtime * runtimeAff + sw.director * directorAff + sw.franchise * franchiseAff
    + sw.cast * castAff + sw.keywords * keywordAff;
  return { score: clamp01(score), matched };
}

function quality(meta) {
  const v = meta.vote_average || 0;   // TMDB (P4-clean); NOT the shared IMDb enrich
  return clamp01(v / 10);
}

function popularity(meta) {
  const p = meta.popularity || 0;
  return p > 0 ? clamp01(Math.log1p(p) / Math.log1p(1000)) : 0;
}

// trending_momentum from the Simkl in-file signals (calibrated to the real CDN,
// verified 2026-09-10): velocity = recent viewers `watched` (max observed ~1500,
// so log-damped against WATCHED_SCALE) + stickiness = 1 − drop_rate% (a positive
// % decline, p50 ~0.3, tail to ~20; low drop = sticky/rising). 0 for a candidate
// with no trending signal (recommendations-only) — momentum rewards what's moving.
const WATCHED_SCALE = 2000;
const DROP_MAX = 10;   // % decline at which stickiness reaches 0
function trendingMomentum(cand) {
  const velocity = cand.watched24h > 0 ? clamp01(Math.log1p(cand.watched24h) / Math.log1p(WATCHED_SCALE)) : 0;
  if (velocity === 0 && cand.drop_rate == null) return 0;
  const stickiness = cand.drop_rate != null ? clamp01(1 - cand.drop_rate / DROP_MAX) : 0.6;
  return clamp01(0.75 * velocity + 0.25 * stickiness);
}

function releaseRecency(meta, nowYear) {
  if (!meta.year) return 0.4;
  const base = clamp01((meta.year - (nowYear - 20)) / 20);
  // A film "completes"; a show runs for years — so old-but-running series aren't
  // punished. Series recency is pulled toward neutral.
  return meta.type === 'series' ? clamp01(0.5 + 0.5 * base) : base;
}

// novelty: away from the profile's OVER-represented genres. A candidate whose
// primary genre dominates the history scores low; a fresh genre scores high.
function novelty(meta, taste) {
  const mass = taste.genreMass || {};
  const max = Math.max(0, ...Object.values(mass), 0);
  if (max <= 0) return 0.5;
  const g = meta.primary_genre;
  const share = g ? (mass[g] || 0) / max : 0;
  return clamp01(1 - share);
}

// Compute every feature for one enriched candidate. Returns { features, matched }.
function computeFeatures(cand, meta, taste, cfg, { nowYear = new Date().getFullYear() } = {}) {
  const tm = tasteMatch(meta, taste, cfg);
  return {
    features: {
      taste_match: tm.score,
      quality: quality(meta),
      trending_momentum: trendingMomentum(cand),
      popularity: popularity(meta),
      release_recency: releaseRecency(meta, nowYear),
      novelty: novelty(meta, taste),
      exploration: (cand.sources || []).includes('exploration') ? 1 : 0,
    },
    matched: tm.matched,
  };
}

// The weighted sum → rankScore. Only weights whose feature is present contribute;
// an absent feature (e.g. semantic_similarity in Phase A) is simply not in the
// vector, so weights effectively renormalise (design §52). Returns a number.
function weightedScore(features, weights) {
  let sum = 0;
  for (const [f, w] of Object.entries(weights)) sum += (features[f] || 0) * w;
  return sum;
}

// Score ONE candidate against its enriched meta: fills the preResolved contract
// fields (imdb_id/poster/genres/primary_genre), the pipeline passthroughs
// (vote_average/vote_count/popularity), rankScore, score_components +
// algorithm_version + reason. Returns the candidate, or null if it has no tt id
// (unservable → dropped, per the preResolved contract).
function scoreCandidate(cand, meta, taste, cfg, { nowYear, animeLoaded = true } = {}) {
  if (!meta || !meta.imdb_id) return null;               // preResolved: no tt → drop
  const { features, matched } = computeFeatures(cand, meta, taste, cfg, { nowYear });
  const rankScore = weightedScore(features, cfg.weights);

  // preResolved fields from the append call (pipeline skips its own resolve).
  cand.imdb_id = meta.imdb_id;
  cand.poster = meta.poster || null;
  let genres = (meta.genres || []).slice();
  // Anime pseudo-genre parity with the shared resolve path (serve-time excluded-
  // genre fidelity; the age BAND is handled independently by the shared gate).
  if (cand.type === 'series' && animeLoaded && animeMap.isAnime(meta.imdb_id, cand.tmdb_id) && !genres.includes('Anime')) {
    genres = ['Anime', ...genres];
  }
  cand.genres = genres.join(',');
  cand.primary_genre = genres[0] || null;
  cand.vote_average = meta.vote_average || cand.vote_average || null;
  cand.vote_count = meta.vote_count || cand.vote_count || null;
  cand.popularity = meta.popularity || cand.popularity || 0;
  cand.title = cand.title || meta.title;
  cand.year = cand.year || meta.year;

  cand.rankScore = rankScore;
  cand.algorithm_version = ALGORITHM_VERSION;
  cand.score_components = { features, weights: cfg.weights, matched, sources: cand.sources || [] };
  return cand;
}

// GE-06 entry: enrich (network, cached) + score the truncated candidate slice,
// drop tt-less, sort by rankScore desc, cap at resolve_cap. `enrichFetcher` is
// injectable (→ metaStore.enrich → tmdb.deepMeta). Returns NormalizedCandidate[].
async function scoreAll(profile, type, cands, taste, cfg, ctx, { fetcher, nowYear = new Date().getFullYear(), log = console, onProgress = () => {} } = {}) {
  await animeMap.ensureLoaded(log).catch(() => {});
  const animeLoaded = true;
  const out = [];
  let done = 0;
  for (let i = 0; i < cands.length; i += 8) {
    const chunk = cands.slice(i, i + 8);
    await Promise.all(chunk.map(async (c) => {
      const meta = await metaStore.enrich(ctx.tmdbKey, type, c.tmdb_id, log, fetcher ? { fetcher } : {});
      const scored = scoreCandidate(c, meta, taste, cfg, { nowYear, animeLoaded });
      if (scored) out.push(scored);
      done++;
    }));
    onProgress(Math.round((done / (cands.length || 1)) * 100), `Scoring ${done}/${cands.length} ${type} candidate(s)…`);
  }
  out.sort((a, b) => b.rankScore - a.rankScore);
  return out.slice(0, cfg.resolve_cap);
}

module.exports = {
  computeFeatures,
  tasteMatch,
  weightedScore,
  scoreCandidate,
  scoreAll,
  quality,
  popularity,
  trendingMomentum,
  releaseRecency,
  novelty,
};
