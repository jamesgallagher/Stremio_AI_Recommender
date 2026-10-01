// Marquee Engine (ME-09) — the descriptor + orchestrator for the Marquee
// pipeline (docs/engine-marquee/). Movies picked from what you've watched and
// how you rated it (ME-04), what people like you enjoyed (S2 collaborative),
// and what's popular right now (S5 trending) — only titles that match your
// filters and are already out to watch at home.
//
// It is a PURE CANDIDATE PRODUCER (like Glass/Genesis): given (profile,
// 'movie') it returns NormalizedCandidate[] with rankScore + score_components;
// the shared pipeline age-gates/upserts/purges and the shared serve path
// filters/balances/sizes. Marquee never age-gates, excludes-watched-as-the-
// guarantee, or serves (I1–I7). It IS preResolved: ME-06 carries imdb_id +
// poster + genres on every row, so the pipeline skips its own resolve (§5.5).
//
// generate() stages (all in the background build, never on serve):
//   0–5   Simkl ratings sync (ME-03; skipped when ctx.marqueeSkipSync)
//   5–20  taste model + seeds + cached local-LLM brief (ME-04)
//   20–45 candidate gather S1–S7 (ME-05)
//   45–75 lookup + hard filter + deterministic score (ME-06)
//   75–95 local-LLM fit (ME-07)
//   95–100 output shaping (ME-08)
//
// MI-3: no stage throws out of generate() for a missing optional input — no
// local LLM → no brief → no fit (the P3 output stands); no trending → no
// trending feature; a failing ratings sync → ratings fall back to watched-only.
//
// Ships GLOBALLY DISABLED (SC-07): registered but dark until an admin enables
// it in Server Config — a user-visible no-op until then.
const settings = require('../settings');
const tmdb = require('../services/tmdb');
const llm = require('../services/llm');
const marqueeConfig = require('./marquee/config');
const taste = require('./marquee/taste');
const filters = require('./marquee/filters');
const sources = require('./marquee/sources');
const scoring = require('./marquee/scoring');
const llmFit = require('./marquee/llmFit');
const shape = require('./marquee/shape');
const simklCache = require('./marquee/simklCache');
const engagement = require('./marquee/engagement');
const recommendationStore = require('../recommendationStore');
const serveCalibration = require('../serveCalibration');

// Test-only seam (ME-09): a process-wide injection for the Tier-2 rebuild
// path, which runs generate() inside buildRecommendations — where the ctx has
// no marqueeFetchers/marqueeChat/marqueeChain of its own. Set it, run the
// build, clear it in a finally. Never used in production code paths.
let _testSeams = null;
function _setTestSeams(seams) {
  _testSeams = seams;
  return () => { _testSeams = null; };
}

async function generate(profile, type, ctx, onProgress = () => {}) {
  if (type !== 'movie') return []; // movie-only (ME-09)
  const { log = console } = ctx;
  const cfg = marqueeConfig.resolveConfig(ctx.settings);
  const nowMs = ctx.nowMs || Date.now();
  const nowYear = new Date(nowMs).getFullYear();

  // Test seams: every fetcher P2/P3 accept (sources + scoring), plus
  // syncRatings, with the live defaults underneath. A hermetic test injects
  // ctx.marqueeFetchers (merged on top), ctx.marqueeChat, ctx.marqueeChain;
  // _setTestSeams covers the buildRecommendations path (no ctx injection).
  const f = {
    ...sources.defaultFetchers(ctx, profile, cfg, log),
    ...scoring.defaultFetchers(ctx, log),
    syncRatings: simklCache.syncRatings,
    pullProgress: undefined, // engagement: default = the profile's watch provider (Nuvio)
    ...(ctx.marqueeFetchers || {}),
    ...(_testSeams?.fetchers || {}),
  };
  const chat = ctx.marqueeChat || _testSeams?.chat || llm.chat;
  const chain = ctx.marqueeChain || _testSeams?.chain || settings.llmChain(ctx.settings).filter((p) => p.type === 'custom');

  // 0–5: Simkl ratings sync (ME-03) — activities-gated, never throws (MI-3).
  // Skipped when ctx.marqueeSkipSync (P5 backtest seam).
  if (ctx.marqueeSkipSync !== true) {
    onProgress(0, 'Marquee: syncing Simkl ratings…');
    try { await f.syncRatings(profile, { now: nowMs, log }); }
    catch (err) { log.warn(`[marquee] ratings sync failed: ${err.message}`); }
  }

  // m2 engagement (0–5): the watch provider's progress — finished = liked (the
  // watched base), abandoned before halfway = didn't enjoy it. Skipped with the
  // ratings sync in the backtest (the snapshot's stored observations are used).
  if (ctx.marqueeSkipSync !== true) {
    await engagement.syncEngagement(profile, cfg, { pull: f.pullProgress, resolveTmdb: f.resolveTmdb, now: nowMs, log });
  }
  const abandoned = engagement.abandonedFor(profile.id, cfg, { now: nowMs });
  ctx.marqueeAbandoned = abandoned;

  // 5–20: the rating-weighted taste model + seeds + the cached local-LLM brief
  // (ME-04). Enrichment rides the deepMeta seam (hermetic under a stub).
  onProgress(5, 'Marquee: building taste model…');
  // Trainer T2 (N5): abandoned films are NEUTRAL — no taste event of any kind —
  // so buildTaste no longer takes the abandoned set. It is still used to drop
  // the films as candidates (ctx.marqueeAbandoned) and in the build log.
  const tasteModel = await taste.buildTaste(profile.id, ctx.tmdbKey, cfg, { nowMs, enrichFetcher: f.deepMeta, log });
  const seeds = taste.seedsFor(profile.id, cfg, { nowMs });
  onProgress(12, 'Marquee: building taste brief…');
  const brief = await taste.tasteBrief(profile.id, tasteModel, { chain, chat, cfg, log, now: nowMs });
  const briefHash = brief ? taste.briefHash(brief) : null;
  const fitOn = !!brief && chain.length > 0 && cfg.llm_fit.enabled !== false;

  // The filter envelope (MI-1), compiled once from the profile's filters.
  let genreMap = {};
  try {
    genreMap = (f.genreMap ? await f.genreMap() : await tmdb.getGenreMap(ctx.tmdbKey)) || {};
  } catch (err) { log.warn(`[marquee] genre map failed: ${err.message} — continuing without genre names`); }
  const envelope = filters.compileEnvelope(ctx.filters || profile.filters || {}, { nowYear, genreMap });

  // 20–45: gather candidates S1–S7 (ME-05).
  onProgress(20, 'Marquee: gathering candidates…');
  const { candidates, meta } = await sources.gatherCandidates(profile, ctx, {
    taste: tasteModel, brief, briefHash, seeds, envelope, cfg, genreMap, fetchers: f, chain, log,
    onProgress: (p, l) => onProgress(20 + (p / 100) * 25, l),
  });

  let final = [];
  if (candidates.length) {
    // 45–75: lookup + hard filter + deterministic score (ME-06).
    onProgress(45, 'Marquee: scoring candidates…');
    const { scored, envelopeStats } = await scoring.scoreCandidates(profile, ctx, candidates, {
      taste: tasteModel, envelope, cfg, gatherMeta: meta, fetchers: f, nowYear, nowMs, log,
      onProgress: (p, l) => onProgress(45 + (p / 100) * 30, l),
    });

    // 75–95: local-LLM fit (ME-07) — degrades to the P3 output when absent.
    onProgress(75, 'Marquee: applying LLM fit…');
    const fitScored = await llmFit.applyLlmFit(profile.id, scored, {
      brief, briefHash, cfg, chain, chat, log, now: nowMs,
      onProgress: (p, l) => onProgress(75 + (p / 100) * 20, l),
    });

    // 95–100: output shaping (ME-08) — franchise cap, store cap, shortfall log.
    onProgress(95, 'Marquee: shaping output…');
    final = shape.shapeOutput(fitScored, {
      cfg, listSize: recommendationStore.listSizeFor(profile), envelopeStats, log, profileName: profile.name,
      trace: ctx.marqueeTrace || null, // m2 diagnostics (backtest only)
    });
  }
  if (ctx.stats) ctx.stats.kept = final.length;
  const st = ctx.stats || {};
  log.log(`[marquee] ${profile.name}: seeds ${st.seeds ?? 0} → raw ${st.raw ?? 0} → strong ${st.strong ?? 0} → scored ${st.scored ?? 0} → stored ${final.length} (llm fit: ${fitOn ? 'on' : 'off'}, brief: ${brief ? 'on' : 'off'}, abandoned: ${abandoned.size})`);

  // Calibrated serving (spec §16, C4): store the per-profile taste target at
  // build time (only when the build produced films) so serving stays
  // instant/local/network-free. A failure here NEVER fails the build (C6).
  if (final.length > 0) {
    try {
      const gt = taste.genreTarget(profile.id, cfg, { nowMs });
      serveCalibration.setTarget(profile.id, 'movie', 'marquee', gt.target, gt.filmCount, nowMs);
      const top = Object.entries(gt.target).slice(0, 3).map(([g, v]) => `${g} ${(v * 100).toFixed(0)}%`);
      log.log(`[marquee] ${profile.name}: serve target from ${gt.filmCount} films — top: ${top.join(', ')}${Object.keys(gt.target).length > 3 ? ' …' : ''}`);
    } catch (err) {
      log.warn(`[marquee] ${profile.name}: serve target failed: ${err.message}`);
    }
  }

  onProgress(100, `Marquee: ${final.length} movie(s)`);
  return final;
}

// User-facing copy (frozen slug; copy iterable). Shown verbatim in the portal
// + companion engine selectors.
const DESCRIPTION = "Movies picked from what you've watched and how you rated it, what people like you enjoyed, and what's popular right now — only titles that match your filters and are already out to watch at home.";

/** @type {import('./types').Engine} */
module.exports = {
  id: 'marquee',              // FROZEN slug — persisted in profiles; never reuse/rename
  name: 'Marquee Engine',
  description: DESCRIPTION,
  supportedTypes: ['movie'],
  capabilities: {
    providesRankScore: true,
    preResolved: true,         // ME-06 carries imdb_id/poster/genres → the pipeline skips its own resolve (§5.5)
    serveOrder: 'affinity',
    unrestricted: false,       // I7: age-GATED, safe for any profile via the shared age gate
  },
  // MDBList + a local LLM are OPTIONAL (they degrade: no IMDb ratings / no
  // brief / no fit) — deliberately NOT listed, exactly Glass's two checks.
  requirements(profile) {
    const missing = [];
    if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    if (!profile?.simkl_auth?.access_token) missing.push('Simkl connection');
    return { ok: missing.length === 0, missing };
  },
  generate,
  ALGORITHM_VERSION: marqueeConfig.ALGORITHM_VERSION,
  _setTestSeams, // test-only (ME-09); cleared by the returned reset
};
