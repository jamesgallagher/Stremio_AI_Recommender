// Marquee TV (TV-2 §4.6/§4.7) — the pure scoring pieces.
//
// `commitmentFit` (Q6) penalises a show that is much longer than the profile's
// comfort (median total_eps of finished + committed shows); shorter or similar
// shows are never penalised. `airing` rewards a show that has an episode airing
// near now (last or next), else a Returning Series gets a half credit and
// anything else gets 0. Both are pure (no network, no DB).
//
// `scoreTv` (spec §4.7): the full feature×weight sum plus the one-season-
// cancelled penalty. `c` is the candidate's merged meta ({ ...deep, ...extras }
// + imdb_rating); `meta` is the same meta for the Glass taste match; `taste`
// is the profile's Glass taste model; `glassCfg` is the resolved Glass config.
const glassScoring = require('../glass/scoring');
const mqFeatures = require('../marquee/features');

function scoreTv(c, meta, taste, glassCfg, { collabNorm, trendingRaw, comfort, nowMs, cfg }) {
  const tasteScore = glassScoring.tasteMatch(meta, taste, glassCfg).score;
  const features = {
    taste: tasteScore,
    collab: collabNorm,
    quality: mqFeatures.quality({ imdbRating: c.imdb_rating || 0, voteAverage: c.vote_average || 0, voteCount: c.vote_count || 0 }, cfg.quality_prior),
    trending: trendingRaw * mqFeatures.tasteGate(tasteScore, cfg.trending_gate),
    commitment: commitmentFit(c.number_of_episodes, comfort),
    airing: airing(c, nowMs, cfg.t6_window_days),
  };
  const penalty = (c.status === 'Canceled' && c.number_of_seasons === 1) ? cfg.cancelled_one_season_penalty : 0;
  let score = 0;
  for (const [k, w] of Object.entries(cfg.weights)) score += (features[k] || 0) * w;
  score -= penalty;
  return { features, penalty, score };
}

// Commitment comfort (spec §4.6): median total_eps of the profile's finished +
// committed shows (non-anime, total known); cfg.default_comfort_eps when there
// are none.
function commitmentFit(candEps, comfort) {
  if (!candEps || !comfort) return 0.5;               // unknown → neutral
  const r = candEps / comfort;
  if (r <= 2) return 1;                               // shorter or similar: never penalised
  return Math.max(0, 1 - Math.log2(r / 2) / 3);       // 4× → 0.667, 8× → 0.333, 16× → 0
}

// Airing (spec §4.7): an episode airing within windowDays of now (last or next)
// → 1; else a Returning Series → 0.5; anything else → 0.
function airing(c, nowMs, windowDays) {
  const near = (d) => d && Math.abs(nowMs - Date.parse(d)) <= windowDays * 86400e3;
  if (near(c.last_episode_air_date) || near(c.next_episode_air_date)) return 1;
  return c.status === 'Returning Series' ? 0.5 : 0;
}

module.exports = { commitmentFit, airing, scoreTv };
