// Shared tunable configuration (GD-6 — tiered; v1 = Tier-1 defaults). Every
// knob here is EXTERNALISED, VERSIONED config, not a code constant baked into
// the algorithm (design §7). A change to any of it alters the stored rankScore
// ordering, so it is BUILD-AFFECTING.
//
//   Tier 1 — these versioned defaults ("the algorithm").
//   Tier 2 (settings.glass) was retired with the Glass engine (ENG-R, 7.44): these Tier-1 defaults are the config.
//   Tier 3 — 1–2 friendly per-profile sliders — DEFERRED (design §7).
//
// ⚠ Starting weights are v1 DEFAULTS, chosen to be sensible and explicitly
// ITERABLE (design §4.3 calls them iterable and Tier-1). They are NOT a
// source/catalog decision; they are calibrated centrally once the score-
// components store (GE-01) shows real distributions. algorithm_version is stamped
// on every stored row so a later reweight stays interpretable.

const ALGORITHM_VERSION = 'glass-a1';

// Deep clone so a caller can't mutate the frozen defaults through the returned
// object (each resolveConfig returns a fresh, independent config).
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULTS = {
  // ── Taste model (§4.1) ──
  // Three half-lives (days). One watch list decayed three ways: recent = "current
  // mood" (short), long = "established taste". Per-type so a film (recency matters
  // more, it "completes") differs from a show (runs for years). w = 0.5^(days/H).
  half_life_days: {
    movie: { recent: 21, medium: 120, long: 540 },
    series: { recent: 30, medium: 180, long: 720 },
  },
  // Horizon blend α·long + β·medium + γ·recent (sum ≈ 1). Reacts to a current
  // binge without overwriting long-term taste (a recent title gets all three;
  // an old title mostly α·long).
  horizon_blend: { long: 0.45, medium: 0.30, recent: 0.25 },

  // ── Candidate generation (§4.2) — per-strategy counts ──
  strategies: {
    seed_cap: { movie: 40, series: 30 },   // strongest recent watched titles seeding A/B recommendations
    recs_per_seed: 12,                      // TMDB /recommendations kept per seed
    trending_take: 200,                     // items pulled from each mapped trending list (C–F base)
    exploration_pct: 0.05,                  // G: fraction of the returned slice reserved for exploration (3–10%)
  },

  // ── Feature weights (§4.3) — the weighted sum → rankScore, all features 0–1 ──
  weights: {
    taste_match: 0.40,          // the core: dim-intersect affinity vs the taste model
    quality: 0.15,              // TMDB vote_average / in-file imdb rating (NOT the shared IMDb enrich — P4)
    trending_momentum: 0.12,    // Simkl drop_rate/watched (velocity + direction)
    popularity: 0.10,           // log-damped TMDB popularity
    release_recency: 0.08,      // newer titles nudged up (movies-scoped semantics)
    novelty: 0.08,              // away from the profile's over-represented genres
    exploration: 0.07,          // the reserved exploration candidates
  },

  // ── taste_match sub-weights: how each enriched dim contributes to taste_match.
  // Genre/decade/language/runtime are the BASE (dense — every title has them);
  // director/franchise/cast/keyword are BONUSES (sparse — most candidates share
  // none), never the base (design §5.5). ──
  taste_dims: {
    genres: 0.34,
    decade: 0.10,
    language: 0.06,
    runtime: 0.05,
    director: 0.16,
    franchise: 0.13,     // collection (movie) / networks (series proxy)
    cast: 0.09,
    keywords: 0.07,
  },
  keyword_min_shared: 1,        // floor: keyword intersect needs ≥ this many shared to count

  // ── Output (§4.7, GI-1) ──
  resolve_cap: 300,             // ≤ this many candidates are enriched + returned (≈ STORE_CAP; the resolve budget)

  // ── Feedback event weights (Phase D / GE-10, design §4.1/§5.4) ──
  // The taste model is a WEIGHTED EVENT LIST, not just "watched titles at +1", so
  // richer signals slot in without a rewrite. v1 maps only what already exists as
  // durable data: watched (positive base) + dont_recommend (negative — a rejected
  // title's dims push taste AWAY from similar candidates). Recency-decayed by the
  // same three-horizon blend as watched, so old rejections fade.
  feedback: {
    watched: 1.0,
    dont_recommend_user: -1.5,      // an explicit "not interested" — strong negative
    dont_recommend_decayed: -0.5,   // shown repeatedly, never engaged — mild negative
  },
};

// Resolve the EFFECTIVE config for a build: the Tier-1 defaults. The Tier-2
// global admin override (settings.glass) was retired with the Glass engine
// (ENG-R, 7.44) — these Tier-1 defaults are the config. The `settings` argument
// is kept for call-site compatibility but is ignored.
function resolveConfig(settings) {
  return clone(DEFAULTS);
}

function halfLivesFor(cfg, type) {
  return cfg.half_life_days[type] || cfg.half_life_days.movie;
}

module.exports = { ALGORITHM_VERSION, DEFAULTS, resolveConfig, halfLivesFor };
