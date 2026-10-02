// Marquee TV TV-1: the pure engagement ladder for shows.
//
// Turns a per-show progress row (watchedStore.getSeriesProgress, parsed by
// simkl.parseSeriesProgress) into a rung, a taste weight, and seed eligibility.
// Pure: no network, no DB. The only DB-reading helper is ladderFor, which reads
// getSeriesProgress and joins taste_ratings (type='series' by tmdb_id).
//
// Rungs (first match wins, spec §3.1): finished, committed, engaged, tried,
// sampled_left, sampling. Bulk stamps never drive speed/active (V4): speed uses
// real stamps only, and recency uses last_watched_at — for a bulk-imported show
// that is the import time, so the show reads as old (never a penalty, just old).
//
// V3: engine-agnostic. The engine's Tier-2 config may override cfg; the rung
// weights and the film rating table are fixed (Q9: a show rating overrides its
// rung weight, rated per SHOW, never per episode).

const DAY_MS = 86400e3;

// Tier-1 thresholds (tunable).
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
};

// Rung base taste weights (spec §3.1).
const RUNG_WEIGHTS = {
  finished: 2.0,
  committed: 1.5,
  engaged: 1.0,
  tried: 0.3,
  sampled_left: 0,
  sampling: 0.3,
};

// Rung → seed eligibility (spec §3.1).
const RUNG_SEED = {
  finished: true,
  committed: true,
  engaged: true,
  tried: false,
  sampled_left: false,
  sampling: false,
};

// The film rating table (same as Marquee Cinema, Q9). A show rating overrides
// its rung weight; a 10/10 is "Loved".
const RATING_WEIGHTS = { r10: 3.0, r9: 2.0, r7_8: 1.2, r5_6: 0.4, r1_4: -1.2 };

// PURE: the film rating → weight (null when unrated / out of range).
function ratingWeight(rating) {
  if (rating == null || !Number.isFinite(Number(rating))) return null;
  const r = Number(rating);
  if (r === 10) return RATING_WEIGHTS.r10;
  if (r === 9) return RATING_WEIGHTS.r9;
  if (r >= 7) return RATING_WEIGHTS.r7_8;
  if (r >= 5) return RATING_WEIGHTS.r5_6;
  if (r >= 1) return RATING_WEIGHTS.r1_4;
  return null;
}

// PURE: the rung for a progress row (first match wins). `now` (ms) defaults to
// Date.now() so the sampled_left/sampling split honours the same clock as
// recency/active (ladder passes its `now` through).
function rungOf(row, cfg, now = Date.now()) {
  const w = row.watched_eps || 0;
  const aired = row.total_eps != null ? row.total_eps - (row.not_aired_eps || 0) : null;
  // Finished / caught up: completed, or watched >= aired.
  if (row.status === 'completed' || (aired != null && w >= aired)) return 'finished';
  // Committed: >= 60% of aired, or >= committed_any_eps (any show).
  if (aired != null && w >= cfg.committed_share * aired) return 'committed';
  if (w >= cfg.committed_any_eps) return 'committed';
  // Engaged: >= engaged_min_eps.
  if (w >= cfg.engaged_min_eps) return 'engaged';
  // Tried: 3..tried_max_eps.
  if (w >= 3 && w <= cfg.tried_max_eps) return 'tried';
  // Sampled (w <= sampled_max_eps): left (idle >= idle_days, more aired) vs
  // sampling now (touched recently).
  const idleDays = row.last_watched_at != null ? (now - row.last_watched_at) / DAY_MS : Infinity;
  const moreAired = aired != null && aired > w;
  if (idleDays >= cfg.sampled_idle_days && moreAired) return 'sampled_left';
  return 'sampling';
}

// PURE: the engagement ladder for one progress row.
//   row:   a series_progress row (watchedStore.getSeriesProgress shape).
//   opts:  { now, rating, cfg } — now (ms) defaults to Date.now(); rating (1-10)
//           overrides the rung weight; cfg merges over DEFAULTS.
// Returns { rung, weight, recency, activeNow, binge, seedEligible, rated, value }.
function ladder(row, { now = Date.now(), rating = null, cfg = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const rung = rungOf(row, c, now);
  const rated = rating != null && Number.isFinite(Number(rating)) && Number(rating) >= 1 && Number(rating) <= 10;
  const rw = rated ? ratingWeight(rating) : null;
  const weight = rw != null ? rw : RUNG_WEIGHTS[rung];

  // Recency: half-life on last_watched_at (bulk-imported shows read as old).
  const ageDays = row.last_watched_at != null ? (now - row.last_watched_at) / DAY_MS : Infinity;
  const recency = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / c.recency_half_life_days) : 0;

  // Active now: watched within active_days.
  const activeNow = row.last_watched_at != null && ageDays <= c.active_days;

  // Binge bonus: >= binge_eps_per_week sustained, from real stamps only (V4).
  const binge = (row.eps_per_week != null && row.eps_per_week >= c.binge_eps_per_week && row.real_stamps >= c.binge_min_real) ? c.binge_bonus : 0;

  const seedEligible = RUNG_SEED[rung];
  const value = weight * recency * (activeNow ? c.active_factor : 1) + binge;

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
  RUNG_SEED,
  RATING_WEIGHTS,
  ratingWeight,
  rungOf,
  ladder,
  ladderFor,
};
