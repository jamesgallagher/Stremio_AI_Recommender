// Marquee ME-04 (spec §4.5) — the Marquee engine's own config.
//
// MD-4: Marquee REUSES Glass's taste model / event list / metadata store, so it
// needs the same knobs (half-lives, horizon blend, feedback weights, taste
// dims). Those values are COPIES (not references) of Glass's — they
// intentionally START equal to Glass's (engines/glass/config.js DEFAULTS) but
// are independent: a Marquee tuning change must not move Glass, and vice versa.
// Do NOT import Glass's resolveConfig here (spec §4.5) — that would couple the
// two engines' config blobs.
// m2 (2026-09-30, after the first live backtest): seed agreement became a
// first-class signal (pre-score + final score), more seeds, a capped + taste-
// gated trending intake. See spec §15.
// Trainer T2: the Marquee taste model now acts on the Trainer feedback store
// (ignore, Loved tier, neutral abandoned) — see docs/trainer/.
const ALGORITHM_VERSION = 'marquee-m4';

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
  // Rating → event weight bands (Trainer T2, N4): 10 → +3.0 (Loved), 9 → +2.0,
  // 7–8 → +1.2, 5–6 → +0.4, 1–4 → −1.2. Rated 1–4 is never a seed.
  rating_weights: { r10: 3.0, r9: 2.0, r7_8: 1.2, r5_6: 0.4, r1_4: -1.2 },
  // Trainer T2 (N3): the Loved tier — a 10/10 is stronger (r10), its recency
  // decay never drops below decay_floor, and it's always seeded (pinned at the
  // front of the seed list, at most pinned_seed_cap). Computed from the rating,
  // never stored.
  loved: { decay_floor: 0.5, pinned_seed_cap: 15 },
  // m2: 100 seeds (was 40). The backtest showed Genesis — 150 seeds, ranked by
  // how many recent watches point at a title — out-recalling Marquee; more
  // seeds is the cheapest way to widen that agreement signal (2 TMDB calls/seed).
  seed_cap: 100,
  // m2 ENGAGEMENT (James, 2026-09-30): this family doesn't rate films. A film
  // watched to the end = liked (the watched base); a film started but left
  // below abandon_below % and untouched for grace_days = didn't enjoy it.
  // Trainer T2 (TD-4): an abandoned film is now NEUTRAL — no taste event of any
  // kind; it's still dropped as a candidate (sources.js) and never a seed.
  // finish_pct / credits_min keep credits + rewatches out of the abandoned set
  // (N6). Source: the watch provider's progress (Nuvio). Marquee only.
  engagement: { enabled: true, abandon_below: 50, grace_days: 7, finish_pct: 90, credits_min: 20, sync_hours: 6, resolve_cap: 30 },
  enrich_cap: 60,
  llm_timeout_ms: 60000,
  brief: { input_cap: 60 },
  simkl: {
    recs_max_uncached: 40,
    recs_ttl_days: 30,
    ratings_resolve_cap: 50,
    // F1 (review round 1): S2-only candidates carry no list payload (pre-score
    // ~0.067), so pure pre-score truncation starves the collaborative signal.
    // A reserved slice (10% of lookup_cap) keeps the best of them.
    collab_reserve: 40,
  },

  // ── ME-05/ME-06 (spec §4.4/§4.5/§5/§7/§8) ──
  lookup_cap: 400,                 // MI-5: resolve budget — ≤ this many lookups per build
  recs_per_seed: 12,              // S1: top N of /recommendations per seed
  similar_per_seed: 6,            // m2: /similar is genre/keyword-based and noisier than /recommendations
  discover: { queries: 8, pages: 2 },
  collections: { max: 10 },        // S4: at most N collections expanded per build
  // m2: simkl_take caps Simkl's week_500 list to its top N by rank. The full
  // 500 flooded the 400-slot lookup budget with generic popular titles
  // (backtest: 95% of Marquee's top 20 carried the trending tag).
  trending: { week_pages: 5, day_pages: 2, rising_top: 50, rising_bonus: 0.1, simkl_take: 100 },
  exploration_pct: 0.05,           // S7
  suggest: { count: 60, avoid_recent: 40, ttl_days: 7 },
  // m2 weights. seed_affinity = the summed (recency × rating) weight of every
  // seed that recommended the title, normalised to the build's max — Genesis's
  // winning signal. consensus (distinct SOURCE groups) is kept but smaller.
  weights: { taste_match: 0.24, seed_affinity: 0.20, llm_fit: 0.18, trending_eff: 0.16, quality: 0.10, consensus: 0.06, freshness: 0.06 },
  // m2: the cheap pre-score that picks the 400 titles worth a lookup. Seed
  // agreement leads; trending only counts in proportion to genre fit
  // (trending_genre_gate), so off-taste blockbusters stop crowding the budget.
  prescore: { seed_affinity: 0.35, genre: 0.30, trending: 0.15, quality: 0.10, sources: 0.10, trending_genre_gate: 0.5 },
  // m4 (spec §17): genre-fair agreement — the seed affinity and consensus
  // features blend the global normalisation with a within-genre one
  // (value = (1 − β)·global + β·genre), so a strong film in a small genre
  // can compete with a hub film in a big one. β=0 reproduces m3 exactly
  // (Tier-2 off-switch: settings.marquee.agreement.genre_blend). A genre
  // group with fewer than min_genre_size candidates uses the global
  // normalisation only.
  agreement: { genre_blend: 0.5, min_genre_size: 5 },
  trending_gate: 0.35,
  quality_prior: { m: 2000, C: 6.5 },
  freshness_default_window: 30,
  freshness_floor: 0.2,
  decayed_collection_penalty: 0.05,
  lookup_chunk: 8,
  availability_recheck_days: 7,

  // ── ME-07 (spec §4.6/§6.2) — LLM fit ──
  // The LOCAL LLM judges the top candidate_cap by the taste brief, in batches
  // of `batch`, sequential (single GPU). ttl_days bounds the fit cache.
  llm_fit: { enabled: true, candidate_cap: 250, batch: 20, ttl_days: 14, timeout_ms: 60000 },

  // ── ME-08 (spec §8.3) — output shaping ──
  franchise_cap: 2,    // at most N titles per collection in the final output
  store_cap: 300,      // the stored slice is capped at this
  min_supply: 150,     // shortfall target floor
  supply_factor: 6,    // shortfall target = max(min_supply, listSize × supply_factor)

  // ── Calibrated serving (spec §16) ──
  // Calibrated serving (spec §16): the served genre mix matches the profile's taste,
  // built from the highest-scored films in a quality window. 'round_robin' = the old
  // strict genre rotation.
  serve: { strategy: 'calibrated', lambda: 0.5, window_factor: 3, kl_alpha: 0.01,
           wildcard_slots: 0, wildcard_max_share: 0.05, wildcard_position: 6 },
};

// Resolve the EFFECTIVE Marquee config for a build: Tier-1 defaults with a
// Tier-2 global admin override (settings.marquee) shallow-merged per section —
// the same pattern as Glass's resolveConfig (glass/config.js), but on
// Marquee's own blob (spec §4.5: do NOT import Glass's). Unknown sections are
// ignored; a malformed blob never throws — it just doesn't apply.
const clone = (o) => JSON.parse(JSON.stringify(o));
function resolveConfig(settings) {
  const cfg = clone(DEFAULTS);
  const over = settings && typeof settings.marquee === 'object' ? settings.marquee : null;
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
