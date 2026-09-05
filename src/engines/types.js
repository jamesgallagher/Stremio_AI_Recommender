// Engine abstraction — type contracts (SC-01).
//
// JSDoc typedefs only (no TypeScript). These describe the shapes every
// recommendation engine and the shared candidate pipeline agree on. The pool
// row is the single output contract (overview §4, invariant I4): an engine is a
// CANDIDATE PRODUCER — given (profile, type) it returns NormalizedCandidate[] —
// and the shared pipeline resolves/enriches/upserts/purges them into the pool.
// Everything downstream of the pool (serve filters, genre-balance, decay,
// impressions, age gate, Stremio metas, companion DTO) is engine-agnostic.

/**
 * Is an engine usable for a given profile right now? (keys present, source
 * connected, …). Surfaced by the UI in cards 04/05; not consulted on the build
 * path in SC-01.
 * @typedef {Object} EngineRequirement
 * @property {boolean} ok
 * @property {string[]} missing   // e.g. ['TMDB key (Server Config)', 'Simkl connection']
 * @property {string} [note]
 */

/**
 * Serve hints + safety flags. All are read by the SHARED pipeline/serve, never
 * acted on by an engine itself.
 * @typedef {Object} EngineCapabilities
 * @property {boolean} providesRankScore   // must be true in v1 (drives order + genre-balance, I6)
 * @property {boolean} preResolved         // true → candidates already carry imdb_id + poster + genres,
 *                                         //   so the pipeline skips the TMDB resolve step
 * @property {'affinity'|'preserve'} serveOrder  // v1: always 'affinity' (mostly latent)
 * @property {boolean} unrestricted        // true = "all ages"/fully open, NO age classification;
 *                                         //   available ONLY to profiles with age_limit === 0 (I7).
 *                                         //   The NSFW/porn blacklist stays absolute regardless.
 */

/**
 * The canonical engine output. Required: type, tmdb_id, rankScore. Everything
 * else the pipeline can backfill on resolve. See overview §4.2 for the full
 * field→column mapping.
 * @typedef {Object} NormalizedCandidate
 * @property {'movie'|'series'} type       // must equal the type being built
 * @property {string} tmdb_id             // canonical key (string); v1 pool is TMDB-keyed
 * @property {number} rankScore           // → the `affinity` column; higher = stronger (I6)
 * @property {string} [imdb_id]           // if absent, pipeline resolves via tmdb.imdbFor; no tt → dropped
 * @property {string} [title]
 * @property {number} [year]
 * @property {string} [poster]            // bare TMDB path or full URL; pipeline normalizes
 * @property {number[]} [genre_ids]       // pipeline resolves ids → names + tags Anime
 * @property {string} [genres]            // CSV names, if the engine already resolved them (preResolved)
 * @property {number} [vote_average]      // rating-floor fallback
 * @property {number} [vote_count]        // vote-floor purge (I3)
 * @property {number} [popularity]        // tie-break
 * @property {boolean} [adult]            // TMDB porn flag → dropped at build
 * @property {string} [reason]            // → because_title ("because you watched X")
 * @property {number} [recCount]          // → rec_count (informational)
 */

/**
 * Everything an engine needs to run, assembled once per build by the caller.
 * `watchedIds`/`dont`/`stats` are populated by the shared pipeline before it
 * calls generate() so an engine can pre-exclude and report without reaching back
 * into recommendationStore (keeps engines depending only on ctx + leaf services).
 * @typedef {Object} EngineContext
 * @property {string} tmdbKey
 * @property {string} mdblistKey
 * @property {object} settings          // settings.getSettings()
 * @property {object} filters           // profile.filters
 * @property {Console} log
 * @property {{tmdb:Set<string>, imdb:Set<string>}} [watchedIds]  // pipeline-supplied (I5)
 * @property {Set<string>} [dont]       // pipeline-supplied `type:tmdb_id` rejection keys (I5)
 * @property {object} [stats]           // optional side-channel an engine may fill for logging
 */

/**
 * @typedef {Object} Engine
 * @property {string} id                                 // stable slug, stored in profile config
 * @property {string} name                               // display name
 * @property {string} description                        // user-facing, shown in both UIs
 * @property {('movie'|'series')[]} supportedTypes
 * @property {EngineCapabilities} capabilities
 * @property {(profile:object)=>EngineRequirement} requirements
 * @property {(profile:object, type:'movie'|'series', ctx:EngineContext,
 *            onProgress:(pct:number,label:string)=>void)=>Promise<NormalizedCandidate[]>} generate
 */

module.exports = {}; // typedefs only
