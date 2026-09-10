// Glass Engine (Phase A) — the first real SECOND engine behind the engine
// abstraction (SC-01…07). A deterministic candidate producer that blends the
// profile's Simkl watch history with what's trending this week, matched to the
// genres/directors/franchises/eras it gravitates to. NO LLM, NO embeddings in
// Phase A — those are Phases B/C. See docs/engine-glass/.
//
// It is a PURE CANDIDATE PRODUCER (like Genesis): given (profile, type) it
// returns NormalizedCandidate[] with rankScore + score_components; the shared
// pipeline age-gates/upserts/purges and the shared serve path filters/balances/
// sizes. Glass never age-gates, excludes-watched-as-the-guarantee, or serves
// (I1–I7). It IS preResolved: it makes one TMDB append call per returned
// candidate (GE-03/06) — carrying imdb_id + poster + genres — so the pipeline
// skips its own resolve (design §5.5).
//
// Ships GLOBALLY DISABLED (SC-07): registered but dark until an admin enables it
// in Server Config — a user-visible no-op until then.
//
// generate() pipeline (all in the background build, never on serve):
//   trending cache (GE-02) → watched enrichment (GE-04) → taste model (GE-05)
//   → candidate generation A–G + GI-1 truncate (GE-05) → enrich + weighted score
//   → rankScore + score_components (GE-06).
const settings = require('../settings');
const tmdb = require('../services/tmdb');
const watchedStore = require('../watchedStore');
const simklTrending = require('../services/simklTrending');
const glassConfig = require('./glass/config');
const tasteModel = require('./glass/tasteModel');
const candidates = require('./glass/candidates');
const scoring = require('./glass/scoring');
const rerank = require('./glass/rerank');
const watchedEnrichment = require('./glass/watchedEnrichment');
const llm = require('../services/llm');

// The trending items for one engine type: movie ← movies; series ← tv ∪ anime
// (mirrors simkl.js's shows+anime merge; anime keeps its own age band downstream).
function trendingFor(type) {
  if (type === 'movie') return simklTrending.getList('movies');
  return [...simklTrending.getList('tv'), ...simklTrending.getList('anime')];
}

async function generate(profile, type, ctx, onProgress = () => {}) {
  const { tmdbKey, log = console } = ctx;
  const cfg = glassConfig.resolveConfig(ctx.settings);

  // 1. Trending cache — refresh if stale (server-wide, one fetch/day, graceful).
  onProgress(2, 'Glass: refreshing trending…');
  await simklTrending.ensureFresh({ log }).catch((err) => log.warn(`[glass] trending ensureFresh: ${err.message}`));
  const trendingItems = trendingFor(type);

  // 2. Enrich a paced batch of recent watched seeds (GE-04) so the taste model has
  //    director/franchise/actor dims. Bounded per build; degrades if incomplete.
  onProgress(6, 'Glass: enriching watch history…');
  try {
    await watchedEnrichment.enrichWatchedBatch(profile.id, type, tmdbKey, {
      log, onProgress: (p) => onProgress(6 + (p / 100) * 12, `Glass: enriching watch history (${type})…`),
    });
  } catch (err) { log.warn(`[glass] watched enrichment (${type}) failed: ${err.message}`); }

  // 3. Taste model v2 (GE-05) — type-scoped, from the enriched history.
  const taste = tasteModel.buildTasteModel(profile.id, type, cfg);
  const watched = watchedStore.getWatched(profile.id, { type });
  if (!watched.length && !trendingItems.length) { onProgress(100, `Glass: no ${type} inputs`); return []; }

  // 4. Candidate generation A–G + dedupe + exploration + GI-1 truncate (GE-05).
  onProgress(20, `Glass: generating ${type} candidates…`);
  const genreMap = await tmdb.getGenreMap(tmdbKey);
  const cands = await candidates.generateCandidates(profile, type, ctx, taste, cfg, {
    trendingItems, watched, genreMap, log,
    // Test seam: the shared build passes no fetcher, so this defaults to the live
    // governed tmdb.getRecommendations. A hermetic test injects ctx.glassRecsFetcher.
    recsFetcher: ctx.glassRecsFetcher || tmdb.getRecommendations,
  });
  if (!cands.length) { onProgress(100, `Glass: 0 ${type} candidates`); return []; }

  // 5. Enrich + weighted score → rankScore + score_components (GE-06). Returns
  //    preResolved candidates (≤ resolve_cap), rankScore-sorted.
  const scored = await scoring.scoreAll(profile, type, cands, taste, cfg, ctx, {
    log, onProgress: (p, l) => onProgress(45 + (p / 100) * 45, l),
  });
  if (ctx.stats) ctx.stats.kept = scored.length;

  // 6. LLM semantic rerank + "because…" reasons (Phase B / GE-08). PREFER-LOCAL:
  //    only the custom/local provider is used — never Groq (no rerank spill onto
  //    cloud quota). Degrades to the deterministic order on any failure/absence.
  //    Test seam: ctx.glassChat injects the chat fn (defaults to llm.chat).
  const localChain = settings.llmChain(ctx.settings).filter((p) => p.type === 'custom');
  const finalCands = await rerank.rerankCandidates(type, scored, taste, cfg, {
    chain: localChain, chat: ctx.glassChat || llm.chat, log,
    onProgress: (p, l) => onProgress(90 + (p / 100) * 10, l),
  });
  onProgress(100, `Glass: ${finalCands.length} ${type} candidate(s)`);
  return finalCands;
}

// User-facing copy (GD-8, frozen slug; copy iterable). Shown verbatim in the
// portal + companion engine selectors.
const DESCRIPTION = "Blends your Simkl watch history with what's popular right now. "
  + 'It learns the genres, directors, franchises and eras you gravitate to — counting '
  + "what you've watched recently more heavily — then mixes in titles trending this "
  + 'week that fit those tastes. Genre-balanced, and it never shows something '
  + "you've already watched.";

/** @type {import('./types').Engine} */
module.exports = {
  id: 'glass',                 // FROZEN slug — persisted in profiles; never reuse/rename (GD-8)
  name: 'Glass Engine',
  description: DESCRIPTION,
  supportedTypes: ['movie', 'series'],
  capabilities: {
    providesRankScore: true,
    preResolved: true,         // Glass makes the append call in generate() → carries imdb_id/poster/genres (§5.5)
    serveOrder: 'affinity',
    unrestricted: false,       // GD-7: age-GATED, safe for any profile via the shared age gate
  },
  requirements(profile) {
    const missing = [];
    if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    if (!profile?.simkl_auth?.access_token) missing.push('Simkl connection');
    return { ok: missing.length === 0, missing };
  },
  generate,
  // Exposed for tests / diagnostics.
  trendingFor,
  ALGORITHM_VERSION: glassConfig.ALGORITHM_VERSION,
};
