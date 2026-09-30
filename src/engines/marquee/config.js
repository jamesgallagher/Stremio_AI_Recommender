// Marquee ME-04 (spec §4.5) — the Marquee engine's own config.
//
// MD-4: Marquee REUSES Glass's taste model / event list / metadata store, so it
// needs the same knobs (half-lives, horizon blend, feedback weights, taste
// dims). Those values are COPIES (not references) of Glass's — they
// intentionally START equal to Glass's (engines/glass/config.js DEFAULTS) but
// are independent: a Marquee tuning change must not move Glass, and vice versa.
// Do NOT import Glass's resolveConfig here (spec §4.5) — that would couple the
// two engines' config blobs.
const ALGORITHM_VERSION = 'marquee-m1';

const DEFAULTS = {
  // ── Copies of Glass's taste-model knobs (spec §4.5) ──
  half_life_days: {
    movie: { recent: 21, medium: 120, long: 540 },
    series: { recent: 30, medium: 180, long: 720 },
  },
  horizon_blend: { long: 0.45, medium: 0.30, recent: 0.25 },
  feedback: {
    watched: 1.0,
    dont_recommend_user: -1.5,
    dont_recommend_decayed: -0.5,
  },
  taste_dims: {
    genres: 0.34,
    decade: 0.10,
    language: 0.06,
    runtime: 0.05,
    director: 0.16,
    franchise: 0.13,
    cast: 0.09,
    keywords: 0.07,
  },
  keyword_min_shared: 1,

  // ── Marquee-specific (spec §4.3 / §4.5) ──
  // Rating → event weight bands (spec §4.3): 9–10 → +2.0, 7–8 → +1.2,
  // 5–6 → +0.4, 1–4 → −1.2.
  rating_weights: { r9_10: 2.0, r7_8: 1.2, r5_6: 0.4, r1_4: -1.2 },
  seed_cap: 40,
  enrich_cap: 60,
  llm_timeout_ms: 60000,
  brief: { input_cap: 60 },
  simkl: {
    recs_max_uncached: 40,
    recs_ttl_days: 30,
    ratings_resolve_cap: 50,
  },

  // ── ME-05/ME-06 (spec §4.4/§4.5/§5/§7/§8) ──
  lookup_cap: 400,                 // MI-5: resolve budget — ≤ this many lookups per build
  recs_per_seed: 12,              // S1: top N of /recommendations AND /similar, per seed
  discover: { queries: 8, pages: 2 },
  collections: { max: 10 },        // S4: at most N collections expanded per build
  trending: { week_pages: 5, day_pages: 2, rising_top: 50, rising_bonus: 0.1 },
  exploration_pct: 0.05,           // S7
  suggest: { count: 60, avoid_recent: 40, ttl_days: 7 },
  weights: { taste_match: 0.28, llm_fit: 0.20, trending_eff: 0.20, quality: 0.14, consensus: 0.12, freshness: 0.06 },
  trending_gate: 0.35,
  quality_prior: { m: 2000, C: 6.5 },
  freshness_default_window: 30,
  freshness_floor: 0.2,
  decayed_collection_penalty: 0.05,
  lookup_chunk: 8,
  availability_recheck_days: 7,
};

// For now returns a deep clone of DEFAULTS, ignoring `settings` — P4 adds the
// Tier-2 merge (a Marquee admin blob over these defaults), the same pattern as
// Glass's resolveConfig but on Marquee's own blob.
function resolveConfig(settings) {
  void settings;
  return JSON.parse(JSON.stringify(DEFAULTS));
}

module.exports = { ALGORITHM_VERSION, DEFAULTS, resolveConfig };
