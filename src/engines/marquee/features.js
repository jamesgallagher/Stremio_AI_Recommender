// Marquee ME-05/ME-06 (spec §5/§7) — the shared PURE feature functions used by
// both the ME-05 pre-score (cheap truncation) and the ME-06 deterministic score.
//
// Everything returns a number in [0, 1] unless stated. No network, no DB, no
// Date.now() — the inputs are passed in. MD-2: trending only lifts films that
// already fit the viewer (the taste gate), and trending is NOT counted in
// consensus (it is its own feature, no double count).
const glassScoring = require('../glass/scoring');
const glassCandidates = require('../glass/candidates');

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// 1 − ln(rank)/ln(N+1): rank 1 → 1, rank N → ~0. Null/≤0 rank or N ≤ 0 → 0.
function rankScore01(rank, N) {
  if (rank == null || rank <= 0 || N == null || N <= 0) return 0;
  return clamp01(1 - Math.log(rank) / Math.log(N + 1));
}

// trending_raw (spec §7): max of the three velocity signals. `tr` =
// { tmdbWeekRank, tmdbDayRank, simklWatched, simklDrop }. The +0.1 rising bonus
// applies when a title is in the day list but OUTSIDE the week top-50 (MD-2:
// trending only lifts films that already fit — the taste gate is applied
// separately in scoring). Simkl momentum reuses Glass's trendingMomentum.
function trendingRaw(tr, { weekN, dayN, risingTop = 50, risingBonus = 0.1 } = {}) {
  const t = tr || {};
  const week = rankScore01(t.tmdbWeekRank, weekN);
  let day = rankScore01(t.tmdbDayRank, dayN);
  // +0.1 rising bonus: in the day list but OUTSIDE the week top-50 (spec §7).
  const hasDay = t.tmdbDayRank != null && t.tmdbDayRank > 0;
  const inWeekTop = t.tmdbWeekRank != null && t.tmdbWeekRank > 0 && t.tmdbWeekRank <= risingTop;
  if (hasDay && !inWeekTop) day += risingBonus;
  const simkl = glassScoring.trendingMomentum({ watched24h: t.simklWatched || 0, drop_rate: t.simklDrop ?? null });
  return clamp01(Math.max(week, day, simkl));
}

// tasteGate (MD-2, spec §7): clamp01(tasteMatch / gate). tasteMatch 0 → 0;
// ≥ gate → 1.
function tasteGate(tasteMatch, gate = 0.35) {
  return clamp01(tasteMatch / gate);
}

// quality (spec §7): Bayesian average (v·R + m·C)/(v + m), R = IMDb rating if
// known else TMDB, v = TMDB votes, m/C the prior, then /10. R = 0 → 0.
function quality({ imdbRating, voteAverage, voteCount } = {}, { m, C } = {}) {
  const R = imdbRating > 0 ? imdbRating : (voteAverage || 0);
  const v = voteCount || 0;
  if (R === 0) return 0;
  return clamp01(((v * R + m * C) / (v + m)) / 10);
}

// The distinct COUNTED groups among the source tags (spec §7 consensus):
// S1 = 'tmdb_recs' or 'tmdb_similar' (one group), 'simkl_recs', 'discover',
// 'collection', 'llm'. trending/exploration are NOT counted (MD-2, no double
// count — trending is its own feature).
function countedGroups(sources) {
  const s = sources instanceof Set ? sources : new Set(sources || []);
  let n = 0;
  if (s.has('tmdb_recs') || s.has('tmdb_similar')) n += 1;
  if (s.has('simkl_recs')) n += 1;
  if (s.has('discover')) n += 1;
  if (s.has('collection')) n += 1;
  if (s.has('llm')) n += 1;
  return n;
}

// consensus (spec §7): min(1, ln(1 + S + 0.5·extraSeeds)/ln(8)), S = distinct
// counted groups, extraSeeds = max(0, seeds − 1).
function consensus(sources, seeds) {
  const S = countedGroups(sources);
  const seedCount = seeds instanceof Set ? seeds.size : (seeds || []).length;
  const extra = Math.max(0, seedCount - 1);
  return clamp01(Math.log(1 + S + 0.5 * extra) / Math.log(8));
}

// freshness (spec §7): linear in year across the recency window (max_age_years,
// or the 30-year default when unlimited), floored. Unknown year → floor.
function freshness(year, { nowYear, maxAgeYears, defaultWindow = 30, floor = 0.2 } = {}) {
  const W = maxAgeYears > 0 ? maxAgeYears : defaultWindow;
  if (year == null || year === 0) return floor;
  return Math.max(floor, clamp01((year - (nowYear - W)) / W));
}

// renormalize (spec §7): a new object over `availableKeys` only, summing to 1
// (all-zero → {}). P4 removes llm_fit and rebalances the rest this way.
function renormalize(weights, availableKeys) {
  const keys = availableKeys || Object.keys(weights || {});
  const vals = {};
  let sum = 0;
  for (const k of keys) {
    const w = (weights || {})[k];
    if (w != null && w > 0) { vals[k] = w; sum += w; }
  }
  if (sum <= 0) return {};
  const out = {};
  for (const k of keys) if (vals[k]) out[k] = vals[k] / sum;
  return out;
}

// weightedSum (spec §7): Σ features[k] · weights[k] over keys in weights.
function weightedSum(features, weights) {
  let sum = 0;
  for (const [k, w] of Object.entries(weights || {})) sum += (features[k] || 0) * w;
  return sum;
}

// preScore (spec §5): the CHEAP truncation score over free/in-file fields only
// (no network). 0.45·genreAffinity + 0.20·trending_raw + 0.15·(vote_average/10)
// + 0.20·min(1, countedSources/3). genreAffinity is Glass's (cand.genres as
// names). countedSources uses the same groups as consensus.
function preScore(cand, taste, { weekN, dayN } = {}) {
  const ga = glassCandidates.genreAffinity(cand, taste);
  const tr = trendingRaw(cand.trending, { weekN, dayN });
  const q = (cand.vote_average || 0) / 10;
  const cs = countedGroups(cand.sources);
  return 0.45 * ga + 0.20 * tr + 0.15 * q + 0.20 * Math.min(1, cs / 3);
}

module.exports = {
  rankScore01,
  trendingRaw,
  tasteGate,
  quality,
  countedGroups,
  consensus,
  freshness,
  renormalize,
  weightedSum,
  preScore,
};
