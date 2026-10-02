// Marquee TV (TV-2 §3) — the engine's own config.
//
// The Tier-1 defaults below are the frozen §3 values (caps, source weights,
// feature weights, the pre-score, the quality prior, the trending gate, the
// one-season-cancelled penalty and the default commitment comfort). Tier-2 is a
// global admin override merged from settings.marquee_tv section-wise — the same
// pattern as Marquee Cinema's resolveConfig (marquee/config.js) and Glass's
// (glass/config.js). Unknown sections are ignored; a malformed blob never
// throws — it just doesn't apply. No UI.
const ALGORITHM_VERSION = 'marquee-tv-t1';

const DEFAULTS = {
  seed_cap: 50, history_meta_cap: 150, lookup_cap: 250, store_cap: 300,
  t1_uncached_cap: 40,                 // Simkl /tv/{id} GETs per build (cached 30 days)
  t2_per_seed: 12,                     // TMDB recommendations kept per seed
  t3_genres: 3, t3_pages: 2,           // discover queries
  t6_window_days: 60, t6_pages: 2,     // airing now
  source_weights: { simkl: 1.0, tmdb: 0.6 },
  weights: { taste: 0.30, collab: 0.30, quality: 0.15, trending: 0.10, commitment: 0.08, airing: 0.07 },
  prescore: { collab: 0.5, genre: 0.2, trending: 0.15, quality: 0.15 },
  quality_prior: { m: 300, C: 7.0 },
  trending_gate: 0.35,
  cancelled_one_season_penalty: 0.05,
  default_comfort_eps: 20,
};

// Resolve the EFFECTIVE Marquee TV config for a build: Tier-1 defaults with a
// Tier-2 global admin override (settings.marquee_tv) shallow-merged per section.
// Unknown sections are ignored; a malformed blob never throws — it just doesn't
// apply.
const clone = (o) => JSON.parse(JSON.stringify(o));
function resolveConfig(settings) {
  const cfg = clone(DEFAULTS);
  const over = settings && typeof settings.marquee_tv === 'object' ? settings.marquee_tv : null;
  if (over) {
    for (const section of Object.keys(DEFAULTS)) {
      if (over[section] && typeof over[section] === 'object' && typeof DEFAULTS[section] === 'object') {
        Object.assign(cfg[section], over[section]);
      } else if (over[section] !== undefined && typeof DEFAULTS[section] !== 'object') {
        cfg[section] = over[section];
      }
    }
  }
  return cfg;
}

module.exports = { ALGORITHM_VERSION, DEFAULTS, resolveConfig };
