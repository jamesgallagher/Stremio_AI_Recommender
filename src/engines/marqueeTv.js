// Marquee TV (TV-2 §3) — the descriptor + orchestrator for the Marquee TV
// engine. Shows picked from how far you really got into what you've watched
// (the engagement ladder), what people who loved the same shows went on to
// watch (Simkl/TMDB collaborative recs), and what's airing now — filtered to
// your formats, eras and age rating, never anime.
//
// It is a PURE CANDIDATE PRODUCER (like Glass/Genesis): given (profile,
// 'series') it returns pre-resolved NormalizedCandidate[] with rankScore +
// scoreComponents; the shared pipeline subtracts watched/dont_recommend and
// stores it as is (preResolved → the pipeline skips its own resolve).
//
// MI-3: no stage throws out of generate() for a missing optional input — no
// MDBList key → no IMDb ratings (quality falls back to TMDB); no Simkl
// trending → no trending feature; a failing source → the others stand.
//
// Ships GLOBALLY DISABLED (SC-07): registered but dark until an admin enables
// it in Server Config — a user-visible no-op until then (M1).
const settings = require('../settings');
const tmdb = require('../services/tmdb');
const mdblist = require('../services/mdblist');
const simklTrending = require('../services/simklTrending');
const seriesEngagement = require('../seriesEngagement');
const recommendationStore = require('../recommendationStore');
const watchedStore = require('../watchedStore');
const tasteFeedback = require('../tasteFeedback');
const animeMap = require('../services/animeMap');
const glassTaste = require('./glass/tasteModel');
const glassConfig = require('./glass/config');
const marqueeTvConfig = require('./marqueeTv/config');
const meta = require('./marqueeTv/meta');
const simklRecs = require('./marqueeTv/simklRecs');
const taste = require('./marqueeTv/taste');
const filters = require('./marqueeTv/filters');
const sources = require('./marqueeTv/sources');
const scoring = require('./marqueeTv/scoring');
const tvLlm = require('./marqueeTv/llm');
const llm = require('../services/llm');
const serveCalibration = require('../serveCalibration');
const { tierFor } = require('../ageVerification/tiers');
const mqFeatures = require('./marquee/features');

// The TV genre id → name map (the inverse of sources.TV_GENRE_IDS), for turning
// a list payload's genre_ids into the genre names the taste model uses.
const GENRE_ID_TO_NAME = {};
for (const [name, id] of Object.entries(sources.TV_GENRE_IDS)) GENRE_ID_TO_NAME[id] = name;

// The default fetchers (M6): every network call goes through these, and
// ctx.marqueeTvFetchers is merged on top for tests. `ladder` is a DB read (not
// network) but is a seam so a test can drive the history.
function defaultFetchers(ctx, profile, cfg, nowMs, log) {
  return {
    ladder: (profileId) => seriesEngagement.ladderFor(profileId, { now: nowMs, kind: 'show' }),
    tvMeta: (apiKey, ids) => meta.ensureTvMeta(apiKey, ids, { now: nowMs, log }),
    // L2 (TV-3 §5): one batch call per build — the uncached cap is per build.
    simklRecs: (p, ids) => simklRecs.ensureShowRecs(p, ids, { cap: cfg.t1_uncached_cap, now: nowMs, log }),
    tmdbRecs: (apiKey, tmdbId) => tmdb.getRecommendations(apiKey, 'series', tmdbId),
    discover: (apiKey, params, opts) => tmdb.discoverTv(apiKey, params, opts),
    trending: (lt) => simklTrending.getList(lt),
    imdbRatings: (apiKey, ids) => mdblist.cachedImdbRatings(apiKey, 'series', ids, log),
  };
}

// §4.6 commitment comfort: median total_eps of the profile's finished +
// committed shows (non-anime, total known); cfg.default_comfort_eps when none.
function comfortOf(ladderEntries, isAnimeRow, cfg) {
  const totals = ladderEntries
    .filter((e) => ['finished', 'committed'].includes(e.rung) && !isAnimeRow(e.row) && e.row.total_eps != null)
    .map((e) => e.row.total_eps);
  if (!totals.length) return cfg.default_comfort_eps;
  totals.sort((a, b) => a - b);
  const mid = Math.floor(totals.length / 2);
  return totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
}

// L1 (TV-3 §5): Simkl trending genre names → TMDB raw TV genre names. The
// pre-score genre affinity must use raw names because taste.dims.genres is
// keyed by raw names (Sci-Fi & Fantasy, Action & Adventure, …); the other
// trending names pass through unchanged. The hard filter and output genres
// are unchanged (they still use tvGenres).
const SIMKL_TRENDING_GENRE_MAP = {
  'Science-Fiction': 'Sci-Fi & Fantasy',
  'Fantasy': 'Sci-Fi & Fantasy',
  'Action': 'Action & Adventure',
  'Adventure': 'Action & Adventure',
  'War': 'War & Politics',
  'Politics': 'War & Politics',
  'Children': 'Kids',
};

// The candidate's list-payload genre names (raw names): from its genre names
// (trending) or genre_ids (TMDB list items) → the raw genre names.
function listGenreNames(c) {
  const names = new Set();
  if (Array.isArray(c.genres) && c.genres.length) {
    for (const g of c.genres) names.add(SIMKL_TRENDING_GENRE_MAP[g] || g);
  } else if (Array.isArray(c.genre_ids) && c.genre_ids.length) {
    for (const id of c.genre_ids) {
      const name = GENRE_ID_TO_NAME[id];
      if (name) names.add(name);
    }
  }
  return [...names];
}

// Merge the raw source payloads into a single pool keyed by tmdb_id, keeping
// per-candidate sources (group Set) and seedHits (Map<seedTmdbId, Set<group>>).
function mergePool(raws) {
  const pool = new Map();
  for (const { item, group, seed } of raws) {
    if (!item || item.tmdb_id == null) continue;
    const id = String(item.tmdb_id);
    let c = pool.get(id);
    if (!c) {
      c = {
        type: 'series',
        tmdb_id: id,
        title: item.title || null,
        year: item.year != null ? Number(item.year) : null,
        genre_ids: item.genre_ids || [],
        genres: Array.isArray(item.genres) ? item.genres : [],
        vote_average: item.vote_average || 0,
        vote_count: item.vote_count || 0,
        popularity: item.popularity || 0,
        adult: !!item.adult,
        poster: item.poster || null,
        imdb_id: item.imdb_id || null,
        simkl_id: item.simkl_id != null ? item.simkl_id : null,
        rank: item.rank != null ? item.rank : null,
        sources: new Set(),
        seedHits: new Map(),
      };
      pool.set(id, c);
    }
    c.sources.add(group);
    if (!c.title && item.title) c.title = item.title;
    if (c.year == null && item.year != null) c.year = Number(item.year);
    if (!c.imdb_id && item.imdb_id) c.imdb_id = item.imdb_id;
    if (c.simkl_id == null && item.simkl_id != null) c.simkl_id = item.simkl_id;
    if (!c.genres.length && Array.isArray(item.genres) && item.genres.length) c.genres = item.genres;
    if (c.rank == null && item.rank != null) c.rank = item.rank;
    if (item.vote_average) c.vote_average = item.vote_average;
    if (item.vote_count) c.vote_count = item.vote_count;
    if (item.popularity) c.popularity = item.popularity;
    if (item.poster) c.poster = item.poster;
    if (item.genre_ids && item.genre_ids.length) c.genre_ids = item.genre_ids;
    if (seed) {
      if (!c.seedHits.has(seed)) c.seedHits.set(seed, new Set());
      c.seedHits.get(seed).add(group);
    }
  }
  return pool;
}

// §7 summary line, exactly this shape (the TV-2 line + the LLM tail):
// [marquee-tv] <name>: seeds <n> → raw <n> → looked up <n> → passed <n> → stored <n>
//   (dropped: …) · llm: brief on|off, suggest <resolved>/<total> resolved, fit <scored> (<cached> cached)
// `brief off` when there's no brief; `suggest 0/0` and `fit 0 (0 cached)` when skipped.
function summaryLine(profile, stats, dropped) {
  const d = (k) => dropped[k] || 0;
  const llm = stats.llm || {};
  const briefPart = llm.brief ? 'brief on' : 'brief off';
  const suggestPart = `suggest ${llm.suggest?.resolved ?? 0}/${llm.suggest?.total ?? 0} resolved`;
  const fitPart = `fit ${llm.fit?.scored ?? 0} (${llm.fit?.cached ?? 0} cached)`;
  return `[marquee-tv] ${profile.name}: seeds ${stats.seeds ?? 0} → raw ${stats.raw ?? 0} → looked up ${stats.strong ?? 0} → passed ${stats.passed ?? 0} → stored ${stats.kept ?? 0} (dropped: anime ${d('anime')}, format ${d('format')}, genre ${d('genre')}, recency ${d('recency')}, rating ${d('rating')}, votes ${d('votes')}, age-floor ${d('age_floor')}, no_imdb ${d('no_imdb')}) · llm: ${briefPart}, ${suggestPart}, ${fitPart}`;
}

async function generate(profile, type, ctx, onProgress = () => {}) {
  if (type !== 'series') return []; // series-only
  const { log = console } = ctx;
  const cfg = marqueeTvConfig.resolveConfig(ctx.settings);
  const nowMs = ctx.nowMs || Date.now();
  const nowYear = new Date(nowMs).getFullYear();
  const profileFilters = ctx.filters || profile.filters || {};

  // Every network call goes through the ctx.marqueeTvFetchers seam (M6), merged
  // over the live defaults.
  const f = {
    ...defaultFetchers(ctx, profile, cfg, nowMs, log),
    ...(ctx.marqueeTvFetchers || {}),
  };

  // TV-R §4: pull show ratings made elsewhere before the history is read, so the
  // ladder (which joins taste_ratings type='series') sees them. Skipped by the
  // bench (ctx.marqueeSkipSync). A failure only logs — the build continues.
  if (!ctx.marqueeSkipSync) {
    try { await tasteFeedback.syncRatings(profile, { type: 'series', log }); }
    catch (err) { log.warn(`[marquee-tv] show ratings sync failed: ${err.message}`); }
  }

  // 1. History: the engagement ladder (kind 'show' excludes anime by kind; §4.2
  //    is applied to every row too). Never throws for a missing input.
  let ladder = new Map();
  try { ladder = await f.ladder(profile.id); }
  catch (err) { log.warn(`[marquee-tv] ladder failed: ${err.message}`); }
  // TV-R §4: ignored shows are removed from Marquee TV's history (taste, seeds,
  // brief, format history, comfort, serve target). They're still watched, so
  // they're never candidates.
  const ignoredShows = tasteFeedback.ignoredSet(profile.id, 'series');
  const ladderEntries = [...ladder.values()].filter((e) => !ignoredShows.has(String(e.row.tmdb_id)));

  // Anime detection needs the map loaded once per build (M3).
  try { await animeMap.ensureLoaded(log).catch(() => {}); } catch { /* detection off */ }
  const isAnimeRow = (row) => filters.isAnimeShow(row, { animeMap });

  // TV meta for the history (highest value first, capped) — the format history
  // reads it. A failure leaves an empty map (cold start → scripted).
  const historyIds = ladderEntries
    .filter((e) => e.value > 0 && e.row.tmdb_id)
    .sort((a, b) => b.value - a.value)
    .slice(0, cfg.history_meta_cap)
    .map((e) => String(e.row.tmdb_id));
  let historyMeta = new Map();
  try { historyMeta = await f.tvMeta(ctx.tmdbKey, historyIds); }
  catch (err) { log.warn(`[marquee-tv] history meta failed: ${err.message}`); }

  // Format history (Q4) + commitment comfort (§4.6).
  const formatsAllowed = taste.formatHistory(ladderEntries, historyMeta);
  const comfort = comfortOf(ladderEntries, isAnimeRow, cfg);

  // 2. Taste: the Glass taste model over ladder-weighted events (§4.5) + seeds.
  const dontRows = recommendationStore.getDontRecommendRows(profile.id, 'series');
  const events = taste.tasteEvents(ladderEntries, dontRows, nowMs, isAnimeRow);
  const glassCfg = glassConfig.resolveConfig(ctx.settings);
  const tasteModel = glassTaste.buildTasteModel(profile.id, 'series', glassCfg, { nowMs, events });
  const seedList = taste.seeds(ladderEntries, cfg, isAnimeRow);
  const seedValue = new Map();
  const seedTitles = new Map();
  for (const e of seedList) {
    seedValue.set(String(e.row.tmdb_id), e.value);
    seedTitles.set(String(e.row.tmdb_id), e.row.title);
  }

  ctx.stats = ctx.stats || {};
  ctx.stats.seeds = seedList.length;

  // TV-3 §3.1 (the §7 order, step 5): the taste brief — LOCAL LLM only
  // (custom chain; N3), cached per history key, null when no chain or on a
  // failure (the build continues without it; N4 / MI-3).
  const tvLlmChain = ctx.marqueeTvChain || settings.llmChain(ctx.settings).filter((p) => p.type === 'custom');
  const llmChat = ctx.marqueeTvChat || llm.chat;
  const brief = await tvLlm.tvBrief(profile.id, ladderEntries, historyMeta, {
    chain: tvLlmChain,
    chat: llmChat,
    cfg, log, now: nowMs, isAnimeRow,
    filters: profileFilters,
  });
  ctx.stats.llm = { brief: !!brief };

  // 3. Gather (§5.4): T1/T2/T3/T5/T6, merged by tmdb_id.
  const sctx = { ...ctx, profile, apiKey: ctx.tmdbKey };
  const tasteGenresTop = glassTaste.topGenres(tasteModel, 6);
  const raws = [];
  raws.push(...(await sources.sourceSimklRecs(sctx, seedList, { fetcher: f.simklRecs, log })));
  raws.push(...(await sources.sourceTmdbRecs(sctx, seedList, { fetcher: f.tmdbRecs, t2PerSeed: cfg.t2_per_seed, log })));
  raws.push(...(await sources.sourceDiscover(sctx, tasteGenresTop, { fetcher: f.discover, cfg, voteFloor: tmdb.voteFloor(profileFilters, 'series'), log })));
  const trendingItems = sources.sourceTrending(sctx, { fetcher: f.trending });
  raws.push(...trendingItems);
  raws.push(...(await sources.sourceAiring(sctx, tasteGenresTop, { fetcher: f.discover, cfg, now: nowMs, log })));
  // T7 (TV-3 §3.2): the local-LLM suggestions — only when a brief exists;
  // the resolved candidates join the pool with group 'llm' (N6: untrusted
  // output, resolved through TMDB, then the same hard filter).
  const llmRecs = await tvLlm.tvSuggest(profile, sctx, cfg, {
    brief,
    briefHash: brief ? tvLlm.briefHash(brief) : null,
    chain: tvLlmChain,
    chat: llmChat,
    resolve: ctx.marqueeTvResolve || ((title, year) => tmdb.resolveTitle(ctx.tmdbKey, 'series', title, year, log)),
    formatsAllowed,
    nowYear,
    log,
    now: nowMs,
  });
  for (const r of llmRecs) raws.push({ item: r, group: 'llm' });
  ctx.stats.llm.suggest = { resolved: llmRecs.filter((r) => r.tmdb_id != null).length, total: llmRecs.length };
  const trendingN = trendingItems.length;

  const pool = mergePool(raws);
  ctx.stats.raw = pool.size;

  // Subtract series_progress / watched / dont_recommend.
  const progressIds = new Set(ladderEntries.map((e) => String(e.row.tmdb_id)));
  const watchedIds = ctx.watchedIds || watchedStore.watchedIdSets(profile.id);
  const dont = ctx.dont || recommendationStore.dontRecommendKeys(profile.id);
  for (const id of [...pool.keys()]) {
    if (progressIds.has(id) || watchedIds.tmdb.has(id) || dont.has(`series:${id}`)) pool.delete(id);
  }

  if (!pool.size) {
    ctx.stats.strong = 0;
    ctx.stats.passed = 0;
    ctx.stats.kept = 0;
    log.log(summaryLine(profile, ctx.stats, {}));
    return [];
  }

  // 4. Pre-score + cut to lookup_cap (§4.6).
  const rawCollab = new Map();
  for (const [id, c] of pool) rawCollab.set(id, sources.collabRaw(c, seedValue, cfg.source_weights));
  const collabNorm = sources.normalizeCollab(rawCollab);
  const preScored = [];
  for (const [id, c] of pool) {
    const genres = listGenreNames(c);
    const trendingRaw = c.rank != null ? mqFeatures.rankScore01(c.rank, trendingN) : 0;
    const p = sources.prescore({
      collabNorm: collabNorm.get(id) || 0,
      genreAff: sources.genreAff(genres, tasteModel),
      trendingRaw,
      voteAverage: c.vote_average || 0,
    }, cfg.prescore);
    preScored.push({ id, c, p, trendingRaw });
  }
  preScored.sort((a, b) => b.p - a.p);
  // T7 (TV-3 §3.2): the llm candidates are ADDITIONAL to the lookup cap —
  // the cap keeps the top non-llm candidates in pre-score order, and every
  // llm candidate joins them (≤ suggest.count), so LLM suggestions never
  // displace pre-scored candidates.
  const llmCands = preScored.filter((k) => k.c.sources.has('llm'));
  const others   = preScored.filter((k) => !k.c.sources.has('llm')).slice(0, cfg.lookup_cap);
  const kept     = [...others, ...llmCands];          // lookup = lookup_cap + all llm (≤ suggest.count)

  // 5. Look up each kept candidate's TV meta (§5.2, cached) + IMDb ratings.
  const keptIds = kept.map((k) => k.id);
  let metaById = new Map();
  try { metaById = await f.tvMeta(ctx.tmdbKey, keptIds); }
  catch (err) { log.warn(`[marquee-tv] candidate meta failed: ${err.message}`); }
  let imdbRatings = new Map();
  if (ctx.mdblistKey) {
    try {
      const ids = kept.filter((k) => metaById.get(k.id)?.imdb_id).map((k) => metaById.get(k.id).imdb_id);
      if (ids.length) imdbRatings = await f.imdbRatings(ctx.mdblistKey, ids);
    } catch (err) { log.warn(`[marquee-tv] imdb ratings failed: ${err.message}`); }
  }
  ctx.stats.strong = keptIds.length;

  // 6. Hard filter (§4.3). Rejected candidates are counted by reason.
  const tier = tierFor(profileFilters);
  const filter = filters.compileTvFilter(profileFilters, { nowYear, formatsAllowed, tier });
  let scored = [];
  for (const k of kept) {
    const m = metaById.get(k.id);
    if (!m) continue; // no meta → can't filter/score
    const c = { ...m, imdb_rating: (m.imdb_id && imdbRatings.has(m.imdb_id)) ? (imdbRatings.get(m.imdb_id) || 0) : 0 };
    if (!filter.check(c).ok) continue;
    // 7. Score (§4.7).
    const { features, penalty, score } = scoring.scoreTv(c, m, tasteModel, glassCfg, {
      collabNorm: collabNorm.get(k.id) || 0,
      trendingRaw: k.trendingRaw,
      comfort,
      nowMs,
      cfg,
    });
    // The because-seed reason (the §7 step-11 row carries it so the fit fold
    // (step 12) can keep it when the LLM gives no reason of its own).
    const becauseId = sources.becauseSeed(k.c, seedValue, cfg.source_weights);
    const reason = becauseId ? (seedTitles.get(becauseId) || null) : null;
    scored.push({
      tmdb_id: k.id,
      c,
      pool: k.c,
      rankScore: score,
      reason,
      scoreComponents: { features, weights: cfg.weights, penalty },
    });
  }
  ctx.stats.passed = scored.length;

  // TV-3 §3.3 (the §7 order, step 12): the LLM fit fold — only when a brief
  // exists, the local chain is non-empty and the feature is enabled; otherwise
  // the rows pass through unchanged (same array, no re-sort; N4 / MI-3).
  scored = await tvLlm.tvFit(profile.id, scored, {
    brief,
    briefHash: brief ? tvLlm.briefHash(brief) : null,
    cfg,
    chain: tvLlmChain,
    chat: llmChat,
    log,
    onProgress,
    now: nowMs,
  });
  // The fit stats for the summary line (step 16): the rows the fold scored
  // (the candidate cap) and how many came from the cache.
  if (brief && tvLlmChain.length && cfg.llm_fit.enabled !== false) {
    const top = scored.slice(0, cfg.llm_fit.candidate_cap);
    ctx.stats.llm.fit = {
      scored: top.length,
      cached: top.filter((r) => r.scoreComponents.llm && r.scoreComponents.llm.cached).length,
    };
  } else {
    ctx.stats.llm.fit = { scored: 0, cached: 0 };
  }

  // Sort by rankScore (the fold already re-sorted when it ran — the same
  // comparator keeps that order), cut to store_cap, emit pre-resolved
  // candidates (§4.8).
  scored.sort((a, b) => (b.rankScore - a.rankScore) || (a.tmdb_id < b.tmdb_id ? -1 : 1));
  const final = scored.slice(0, cfg.store_cap);
  const out = final.map((s) => {
    const m = metaById.get(s.tmdb_id);
    const genres = filters.tvGenres(m);
    const seedTitlesList = [...s.pool.seedHits.keys()].map((id) => seedTitles.get(id) || null).filter(Boolean);
    return {
      type: 'series',
      tmdb_id: s.tmdb_id,
      imdb_id: m.imdb_id,
      title: m.title || s.pool.title,
      year: m.year,
      poster: m.poster || s.pool.poster || null,
      genres: genres.join(','),
      primary_genre: genres[0] || null,
      vote_average: m.vote_average,
      vote_count: m.vote_count,
      popularity: m.popularity,
      imdb_rating: s.c.imdb_rating,
      certification: m.certAU || m.certUS || null,
      rankScore: s.rankScore,
      reason: s.reason,
      scoreComponents: {
        ...s.scoreComponents,
        sources: [...s.pool.sources],
        seeds: seedTitlesList,
        format: m.tvType,
        status: m.status,
        episodes: m.number_of_episodes,
      },
      algorithmVersion: marqueeTvConfig.ALGORITHM_VERSION,
    };
  });

  ctx.stats.kept = out.length;

  // TV-3 §4: the calibrated serve target — only when rows are stored. Built
  // from the same SPLIT genre names the served rows carry (tvGenres). A
  // failure only logs — it never fails the build.
  if (out.length > 0) {
    try {
      const shows = [];
      for (const e of ladderEntries) {
        if (e.value <= 0 || isAnimeRow(e.row)) continue;
        const m = historyMeta.get(String(e.row.tmdb_id));
        if (!m) continue;
        const genres = filters.tvGenres(m); // SPLIT names — the same names the served rows carry
        if (genres.length) shows.push({ genres, weight: e.value });
      }
      const target = serveCalibration.computeTarget(shows);
      serveCalibration.setTarget(profile.id, 'series', 'marquee-tv', target, shows.length, nowMs);
      const top = Object.entries(target).slice(0, 3).map(([g, v]) => `${g} ${Math.round(v * 100)}%`);
      log.log(`[marquee-tv] ${profile.name}: serve target from ${shows.length} shows — top: ${top.join(', ')}${Object.keys(target).length > 3 ? ' …' : ''}`);
    } catch (err) {
      log.warn(`[marquee-tv] serve target failed: ${err.message}`);
    }
  }

  log.log(summaryLine(profile, ctx.stats, filter.stats()));
  return out;
}

// User-facing copy (frozen slug; copy iterable). Shown verbatim in the portal
// + companion engine selectors.
const DESCRIPTION = "Shows picked from how far you really got into what you've watched, what people who loved the same shows went on to watch, and what's airing now — filtered to your formats, eras and age rating, never anime.";

/** @type {import('./types').Engine} */
module.exports = {
  id: 'marquee-tv',            // FROZEN slug — persisted in profiles; never reuse/rename
  name: 'Marquee TV',
  description: DESCRIPTION,
  supportedTypes: ['series'],
  capabilities: {
    providesRankScore: true,
    preResolved: true,          // §4.8 carries imdb_id/poster/genres → the pipeline skips its own resolve
    serveOrder: 'calibrated',   // TV-3 §4: the served genre mix is calibrated to the profile's taste
    unrestricted: false,         // M5: age-GATED, safe for any profile via the shared age gate
  },
  // Calibrated serving (TV-3 §4): the serve-time tunables, read from the
  // resolved Marquee TV config (Tier-1 defaults + Tier-2 settings.marquee_tv.serve).
  serveOptions(settings) {
    return marqueeTvConfig.resolveConfig(settings).serve;
  },
  // Exactly Marquee Cinema's: TMDB key + Simkl connection (MDBList + a local
  // LLM are optional and deliberately NOT listed).
  requirements(profile) {
    const missing = [];
    if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    if (!profile?.simkl_auth?.access_token) missing.push('Simkl connection');
    return { ok: missing.length === 0, missing };
  },
  generate,
  ALGORITHM_VERSION: marqueeTvConfig.ALGORITHM_VERSION,
  // Exported for the L1 test (TV-3 §5).
  listGenreNames,
};
