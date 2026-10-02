// Marquee TV TV-1: the pure engagement ladder for shows.
//
// Turns a per-show progress row (watchedStore.getSeriesProgress, parsed by
// simkl.parseSeriesProgress) into a rung, a taste weight, and seed eligibility.
// Pure: no network, no DB. The only DB-reading helper is ladderFor, which reads
// getSeriesProgress and joins taste_ratings (type='series' by tmdb_id).
//
// Rungs (first match wins, spec §2.3): finished, committed, engaged, tried,
// sampled_left, sampling. Bulk stamps never drive speed/active (V4): speed uses
// real stamps only, and activeNow uses last_real_at — a recent bulk "mark
// season watched" never counts as active. Recency uses last_watched_at — for a
// bulk-imported show that is the import time, so the show reads as old (never a
// penalty, just old).
//
// V3: engine-agnostic. The engine's Tier-2 config may override cfg (DEFAULTS is
// fully overridable by callers); the rung weights and the film rating table
// (Q9: a show rating overrides its rung weight, rated per SHOW, never per
// episode) live in DEFAULTS so cfg can tune them.

const DAY_MS = 86400e3;

// Tier-1 thresholds (tunable). `weights` and `rating_weights` are nested so
// callers can override individual rungs / rating bands via cfg (V3).
const DEFAULTS = {
  sampled_max_eps: 2,
  sampled_idle_days: 60,
  tried_max_eps: 5,
  engaged_min_eps: 6,
  committed_share: 0.6,
  committed_min_eps: 6,
  committed_any_eps: 24,
  recency_half_life_days: 180,
  active_days: 30,
  active_factor: 1.3,
  binge_eps_per_week: 5,
  binge_min_real: 4,
  binge_bonus: 0.3,
  // §2.3 limited-series engaged rule: aired <= 10, share >= 0.5, w >= 3.
  limited_max_aired: 10,
  limited_share: 0.5,
  limited_min_eps: 3,
  // §2.3 L2: a 10/10 ("Loved") floors recency at this value.
  loved_decay_floor: 0.5,
  // §2.3 L2: rated shows' seed eligibility — >= rated_seed_min seed-eligible,
  // <= rated_no_seed_max not.
  rated_seed_min: 7,
  rated_no_seed_max: 4,
  // Rung base taste weights (spec §2.3).
  weights: { finished: 2.0, committed: 1.5, engaged: 1.0, tried: 0.3, sampled_left: 0, sampling: 0.3 },
  // The film rating table (same as Marquee Cinema, Q9). A show rating overrides
  // its rung weight; a 10/10 is "Loved".
  rating_weights: { r10: 3.0, r9: 2.0, r7_8: 1.2, r5_6: 0.4, r1_4: -1.2 },
};

// Aliases kept for callers/tests that read the tables directly.
const RUNG_WEIGHTS = DEFAULTS.weights;
const RATING_WEIGHTS = DEFAULTS.rating_weights;

// Rungs that count as "engaged or better" (seed-eligible by rung, binge-eligible).
const ENGAGED_PLUS = new Set(['engaged', 'committed', 'finished']);

// PURE: the film rating → weight (null when unrated / out of range).
function ratingWeight(rating, rw = DEFAULTS.rating_weights) {
  if (rating == null || !Number.isFinite(Number(rating))) return null;
  const r = Number(rating);
  if (r === 10) return rw.r10;
  if (r === 9) return rw.r9;
  if (r >= 7) return rw.r7_8;
  if (r >= 5) return rw.r5_6;
  if (r >= 1) return rw.r1_4;
  return null;
}

// PURE: the rung for a progress row (first match wins). `now` (ms) defaults to
// Date.now() so the sampled_left/sampling split honours the same clock as
// recency/active (ladder passes its `now` through).
function rungOf(row, c, now = Date.now()) {
  const w = row.watched_eps || 0;
  const aired = row.total_eps != null ? Math.max(0, row.total_eps - (row.not_aired_eps || 0)) : null;
  const share = aired > 0 ? w / aired : null;
  const idleDays = row.last_watched_at != null ? (now - row.last_watched_at) / DAY_MS : Infinity;
  // Finished / caught up: completed, or watched >= aired (needs aired > 0, L7).
  if (row.status === 'completed' || (aired > 0 && w >= aired)) return 'finished';
  // Committed: >= 60% of aired AND >= committed_min_eps (L4), or >= committed_any_eps.
  if ((share != null && share >= c.committed_share && w >= c.committed_min_eps) || w >= c.committed_any_eps) return 'committed';
  // Engaged: >= engaged_min_eps, or the limited-series rule (short show, half
  // watched, >= 3 eps) (L5).
  if (w >= c.engaged_min_eps
      || (aired != null && aired > 0 && aired <= c.limited_max_aired && share >= c.limited_share && w >= c.limited_min_eps)) return 'engaged';
  // Tried: more than sampled_max_eps (but not engaged/committed).
  if (w > c.sampled_max_eps) return 'tried';
  // Sampled (w <= sampled_max_eps): left (idle >= idle_days, aired unknown or
  // more aired) (L6) vs sampling now (touched recently).
  if (idleDays >= c.sampled_idle_days && (aired == null || aired > w)) return 'sampled_left';
  return 'sampling';
}

// PURE: the engagement ladder for one progress row.
//   row:   a series_progress row (watchedStore.getSeriesProgress shape).
//   opts:  { now, rating, cfg } — now (ms) defaults to Date.now(); rating (1-10)
//           overrides the rung weight; cfg merges over DEFAULTS (V3).
// Returns { rung, weight, recency, activeNow, binge, seedEligible, rated, value }.
function ladder(row, { now = Date.now(), rating = null, cfg = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg,
    weights: { ...DEFAULTS.weights, ...(cfg.weights || {}) },
    rating_weights: { ...DEFAULTS.rating_weights, ...(cfg.rating_weights || {}) } };
  const rung = rungOf(row, c, now);
  const rw = ratingWeight(rating, c.rating_weights);
  const rated = rw != null;
  const weight = rated ? rw : c.weights[rung];

  // Recency: half-life on last_watched_at (bulk-imported shows read as old).
  // A null last_watched_at decays as 730 days old (2 years) (L8).
  const days = (t) => (now - t) / DAY_MS;
  let recency = row.last_watched_at != null
    ? Math.pow(0.5, days(row.last_watched_at) / c.recency_half_life_days)
    : Math.pow(0.5, 730 / c.recency_half_life_days);
  // L2: a 10/10 ("Loved") floors recency at loved_decay_floor.
  if (rated && Number(rating) === 10) recency = Math.max(recency, c.loved_decay_floor);

  // Active now (V4, L1): a REAL stamp within active_days — bulk imports never count.
  const activeNow = row.last_real_at != null && days(row.last_real_at) <= c.active_days;

  // Binge bonus (L3): >= binge_eps_per_week sustained, from real stamps only
  // (V4), and only on engaged-or-better rungs.
  const binge = (ENGAGED_PLUS.has(rung) && row.eps_per_week != null
    && row.eps_per_week >= c.binge_eps_per_week && (row.real_stamps || 0) >= c.binge_min_real) ? c.binge_bonus : 0;

  // Seed eligibility (L2): engaged-or-better by rung, then the rating override.
  let seedEligible = ENGAGED_PLUS.has(rung);
  if (rated) {
    if (Number(rating) >= c.rated_seed_min) seedEligible = true;
    if (Number(rating) <= c.rated_no_seed_max) seedEligible = false;
  }

  const value = (weight + binge) * recency * (activeNow ? c.active_factor : 1);
  return { rung, weight, recency, activeNow, binge, seedEligible, rated, value };
}

// The only DB-reading helper: the ladder for every show in a profile's
// series_progress, joined with taste_ratings (type='series' by tmdb_id).
// Returns Map<simkl_id, { row, ...ladder }>.
function ladderFor(profileId, { now = Date.now(), kind, cfg = {} } = {}) {
  const watchedStore = require('./watchedStore');
  const tasteFeedback = require('./tasteFeedback');
  const rows = watchedStore.getSeriesProgress(profileId, kind ? { kind } : {});
  const ratings = tasteFeedback.getRatingsMap(profileId, 'series'); // Map<tmdb_id, rating>
  const out = new Map();
  for (const row of rows) {
    const rating = row.tmdb_id != null ? ratings.get(String(row.tmdb_id)) : null;
    out.set(row.simkl_id, { row, ...ladder(row, { now, rating, cfg }) });
  }
  return out;
}

module.exports = {
  DEFAULTS,
  RUNG_WEIGHTS,
  RATING_WEIGHTS,
  ratingWeight,
  rungOf,
  ladder,
  ladderFor,
};
