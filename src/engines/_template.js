// A worked template for a NEW recommendation engine (SC-06, Part C).
//
// The leading underscore means this file is NOT imported by src/engines/index.js
// and so is NEVER registered — it is a skeleton, not a live engine. Copy it to
// `src/engines/<id>.js`, fill in generate(), and register it ONLY after the two
// gates below are cleared.
//
// ── GATE 1: the SOURCE is James's call ───────────────────────────────────────
// A real engine that pulls from a new data source, list, or catalog is a
// catalog/source decision, which is surfaced as options and confirmed by James —
// never chosen or substituted by the implementer. Do not register an engine that
// introduces a source until that sign-off exists. (See docs/engine-abstraction/
// 06-conformance-and-second-engine-template.md, "Source-choice guardrail", and
// the illustrative candidate engines listed there.)
//
// ── GATE 2: CONFORMANCE ──────────────────────────────────────────────────────
// The engine must pass every item in docs/engine-abstraction/CONFORMANCE.md
// (the definition of done). The comments below map each field to the part of the
// contract it satisfies; the checklist is the authority.
//
// Once registered in src/engines/index.js, the engine ships GLOBALLY DISABLED by
// default (SC-07): the admin turns it on in Server Config before it appears in any
// dropdown. So a new engine is user-visible only when it is BOTH registered AND
// enabled.
//
// Typical dependencies (require what you use):
//   const settings = require('../settings');  // keys/LLM availability for requirements()
//   const tmdb = require('../services/tmdb');  // resolve a non-TMDB source to a tmdb_id

/** @type {import('./types').Engine} */
module.exports = {
  // Stable slug, unique in the registry, PERSISTED in profiles — never reuse it
  // for a different engine (CONFORMANCE.md "Contract").
  id: 'REPLACE_ME',
  // Display name shown in both the portal and companion selectors.
  name: 'REPLACE_ME',
  // User-facing: how this engine picks titles, in plain language for a
  // non-technical family member (it is shown verbatim in both UIs).
  description: 'How this engine picks titles, in plain language for a family member.',

  // Trim to ['movie'] or ['series'] if the engine only does one — a type's
  // dropdown lists only engines that support it.
  supportedTypes: ['movie', 'series'],

  capabilities: {
    providesRankScore: true,   // must be true in v1 — rankScore drives order + genre-balance (I6)
    preResolved: false,        // false → the shared pipeline resolves tt-id/poster/genres.
                               //   true → YOU guarantee a valid `tt` id + poster on every candidate
                               //   (no-tt candidates are dropped) AND set primary_genre + genres
                               //   yourself (the pipeline only derives those on the resolve path).
    serveOrder: 'affinity',    // leave 'affinity' unless the serve path has been taught 'preserve'
    unrestricted: false,       // false = age-GATED (safe for any profile via the shared age gate).
                               //   Set true ONLY for a genuinely "all ages"/fully-open engine that
                               //   applies NO age classification; the registry then hides it from any
                               //   age-limited profile (I7). The NSFW/porn blacklist stays absolute
                               //   regardless — "open" is no age classification, not NSFW.
  },

  // Is this engine usable for THIS profile right now? Return the missing inputs
  // truthfully — when ok is false the type is SKIPPED (its existing rows are left
  // serving, not wiped) and the reason surfaces in logs/Advanced.
  requirements(profile) {
    const missing = [];
    // e.g. if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    // e.g. if (!settings.hasLlm()) missing.push('an LLM (Server Config)');
    return { ok: missing.length === 0, missing };
  },

  // Produce NormalizedCandidate[] for EXACTLY the requested `type`. This runs only
  // in the background build, never on the serve path. Return [] (not an error)
  // when there is nothing to produce. Do NOT age-gate, serve-filter, or write
  // pipeline-owned columns (imdb_rating / age_classification / impression+decay) —
  // the shared pipeline and age gate own all of that (I1–I7).
  //
  // ctx carries: { tmdbKey, mdblistKey, settings, filters, log, watchedIds, dont }.
  // watchedIds/dont are pre-resolved exclusion sets you MAY pre-filter against as
  // an optimization; the pipeline re-subtracts them regardless (I5).
  async generate(profile, type, ctx, onProgress = () => {}) {
    // 1. Gather this engine's raw source for `type` (its own logic).
    // 2. Map each item to a NormalizedCandidate:
    //      { type, tmdb_id, rankScore, ...optional }
    //    - required: `type` (=== the requested type), `tmdb_id` (string, the
    //      canonical key), `rankScore` (higher = stronger → the `affinity` column).
    //    - a non-TMDB source must resolve to a tmdb_id here (or, if preResolved,
    //      also supply imdb_id + poster + genres).
    //    - optional passthroughs the pipeline uses: imdb_id, title, year, poster,
    //      genre_ids | genres, vote_average, vote_count, popularity, reason
    //      (→ because_title), recCount.
    // 3. Report progress and return.
    onProgress(100, 'REPLACE_ME: 0 candidates');
    return [];
  },
};
