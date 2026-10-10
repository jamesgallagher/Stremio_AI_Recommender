// AN-2: personalised Marquee Anime — history → recommendations, with "because you watched X".
// Deterministic (no LLM). Sources: AniList community recommendations (collaborative),
// AniList tag search (taste), and the existing trending list. Score = collaborative
// weight + tag-taste similarity + quality + a little trending. The existing age gate
// runs afterwards exactly as for trending.

const DEFAULT_DEPS = {
  ladder: (id) => require('../../seriesEngagement').ladderFor(id),
  isAnimeRow: (row) => require('../../anime/history').isAnimeProgressRow(row),
  ignored: (id) => require('../../tasteFeedback').ignoredSet(id, 'series'),
  watchedIds: (id) => require('../../watchedStore').watchedIdSets(id),
  dontKeys: (id) => require('../../recommendationStore').dontRecommendKeys(id),
  animeMap: require('../../services/animeMap'),
  anilist: require('../../services/anilist'),
  trending: require('./trending'),
  trendingDeps: undefined,
  tvMeta: (key, ids, log) => require('../marqueeTv/meta').ensureTvMeta(key, ids, { log }),
  listSize: (p) => require('../../recommendationStore').listSizeFor(p),
  tier: (p) => require('../../ageVerification').tierFor(p.filters || {}),
  decisions: require('../../anime/decisionLog'),
};

const ALGORITHM_VERSION = 'marquee-anime-a2';

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Pure score function (step 5) — exported for tests.
function score({ collabNorm, tasteCos, quality, trend }) {
  return 0.45 * collabNorm + 0.35 * tasteCos + 0.15 * quality + 0.05 * trend;
}

// Cosine similarity between two Map vectors (0 when either is empty).
function cosine(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (const [k, v] of a) {
    normA += v * v;
    const bv = b.get(k);
    if (bv != null) dot += v * bv;
  }
  for (const [, v] of b) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const isShowType = (t) => t === 'TV' || t === 'ONA';

async function build(profile, ctx, deps = DEFAULT_DEPS) {
  const log = ctx.log || console;
  const name = (profile && (profile.name || profile.id)) || 'profile';

  // AN-4: bench override — force trending-only (the baseline comparison).
  if (ctx.animeMode === 'trending') {
    ctx.animeEngaged = 0;
    return deps.trending.build(profile, ctx, deps.trendingDeps);
  }

  // 1. History and mode.
  await deps.animeMap.ensureLoaded(log);
  const ladder = await deps.ladder(profile.id);
  const ignored = deps.ignored(profile.id);
  const entries = [...ladder.values()]
    .filter((e) => deps.isAnimeRow(e.row))
    .filter((e) => !ignored.has(String(e.row.tmdb_id)));
  const engaged = entries.filter((e) => e.seedEligible).length;
  const T = 4 * deps.listSize(profile);

  if (engaged === 0) {
    ctx.animeMode = 'trending';
    ctx.animeEngaged = 0;
    return deps.trending.build(profile, ctx, deps.trendingDeps);
  }

  const mode = engaged >= 5 ? 'personalised' : 'mixed';
  ctx.animeMode = mode;
  ctx.animeEngaged = engaged;

  // 2. Seeds and taste.
  const seedEntries = entries
    .filter((e) => e.seedEligible)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  const seedAnilistIds = [];
  const seedByAnilist = new Map(); // anilistId → { entry, value }
  for (const e of seedEntries) {
    const lookup = deps.animeMap.lookup(e.row.imdb_id, e.row.tmdb_id);
    const anilistId = lookup ? lookup.anilist : null;
    if (anilistId != null) {
      seedAnilistIds.push(anilistId);
      seedByAnilist.set(anilistId, { entry: e, value: e.value });
    }
  }

  let seedTags = new Map();
  if (seedAnilistIds.length) {
    try {
      seedTags = await deps.anilist.tagsFor(seedAnilistIds);
    } catch (err) {
      log.warn(`[marquee-anime] ${name}: tagsFor unavailable (${err.message})`);
    }
  }

  // Taste vector.
  const taste = new Map();
  for (const [anilistId, { entry, value }] of seedByAnilist) {
    const tagData = seedTags.get(anilistId);
    if (!tagData) continue;
    for (const tag of tagData.tags || []) {
      taste.set('tag:' + tag.name, (taste.get('tag:' + tag.name) || 0) + value * (tag.rank / 100));
    }
    for (const genre of tagData.genres || []) {
      taste.set('genre:' + genre, (taste.get('genre:' + genre) || 0) + value * 0.6);
    }
  }

  // 3. Sources.
  // A1: recs
  let recsMap = new Map();
  try {
    recsMap = await deps.anilist.recommendationsFor(seedAnilistIds);
  } catch (err) {
    log.warn(`[marquee-anime] ${name}: recs unavailable (${err.message})`);
  }

  // A4: tag search
  const tier = deps.tier(profile);
  const safe = tier != null && tier.csmMaxAge <= 12;
  let tagSearchItems = [];
  try {
    const topTags = [...taste.entries()]
      .filter(([k]) => k.startsWith('tag:'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k.slice(4));
    if (topTags.length) {
      tagSearchItems = (await deps.anilist.tagSearch({ tags: topTags, page: 1, safe })) || [];
      tagSearchItems = tagSearchItems.concat((await deps.anilist.tagSearch({ tags: topTags, page: 2, safe })) || []);
    }
  } catch (err) {
    log.warn(`[marquee-anime] ${name}: tag-search unavailable (${err.message})`);
  }

  // A5: trending
  const rowsOut = [];
  let trendingCandidates = [];
  try {
    trendingCandidates = (await deps.trending.build(profile, { ...ctx, decisionRowsOut: rowsOut }, deps.trendingDeps)) || [];
  } catch (err) {
    log.warn(`[marquee-anime] ${name}: trending unavailable (${err.message})`);
  }
  const trendingN = trendingCandidates.length;
  const trendingByTv = new Map();
  for (const c of trendingCandidates) {
    trendingByTv.set(c.tmdb_id, c);
  }

  // 4. Roll-up.
  const watched = deps.watchedIds(profile.id);
  const dontKeys = deps.dontKeys(profile.id);
  const historyTmdb = new Set(entries.map((e) => String(e.row.tmdb_id)).filter(Boolean));

  // byTv: Map<show.tv, candidate>
  const byTv = new Map();
  // filteredRows: Map<item_key, { row, sources: Set }>
  const filteredRows = new Map();

  const addFiltered = (itemKey, title, stage, source, reason) => {
    let entry = filteredRows.get(itemKey);
    if (!entry) {
      entry = { row: { item_key: itemKey, title, stage, outcome: 'filtered', source: null, reason }, sources: new Set() };
      filteredRows.set(itemKey, entry);
    }
    entry.sources.add(source);
    entry.row.source = [...entry.sources].join('+');
  };

  const addCandidate = (media, source, seedEntry, collabValue, bestSeed) => {
    const title = (media.title && (media.title.english || media.title.romaji)) || null;
    const show = deps.animeMap.byAnilist(media.id) || deps.animeMap.byMal(media.idMal);
    // Drop: no show or no imdb
    if (!show || !show.imdb) {
      addFiltered(`anilist:${media.id}`, title, 'no-tt', source, 'No TMDB show + IMDb id in the anime map');
      return;
    }
    // Drop: format
    if (!isShowType(show.type)) {
      addFiltered(show.tv, title, 'format', source, `Format ${show.type} is not TV or ONA`);
      return;
    }
    // Drop: franchise (in history)
    if (historyTmdb.has(String(show.tv))) {
      addFiltered(show.tv, title, 'franchise', source, 'Already in your history');
      return;
    }
    // Drop: watched / dont / ignored
    if (watched.tmdb.has(String(show.tv)) || dontKeys.has(`series:${show.tv}`) || dontKeys.has(`anime:${show.tv}`) || ignored.has(String(show.tv))) {
      addFiltered(show.tv, title, 'watched', source, 'Rejected or ignored');
      return;
    }
    // Merge by show.tv
    let rec = byTv.get(show.tv);
    if (!rec) {
      rec = {
        show,
        sources: new Set(),
        bestSeed: null,
        collab: 0,
        anilistId: media.id,
        idMal: media.idMal,
        averageScore: media.averageScore,
        genres: media.genres || [],
        popularity: media.popularity,
        year: media.year,
        title,
      };
      byTv.set(show.tv, rec);
    }
    rec.sources.add(source);
    if (collabValue != null) {
      rec.collab += collabValue;
    }
    if (bestSeed != null) {
      if (rec.bestSeed == null || bestSeed.contribution > rec.bestSeed.contribution) {
        rec.bestSeed = bestSeed;
      }
    }
  };

  // A1: recs
  for (const [seedId, recs] of recsMap) {
    const seedInfo = seedByAnilist.get(seedId);
    if (!seedInfo) continue;
    const { entry, value } = seedInfo;
    const maxRating = Math.max(...recs.map((r) => r.rating));
    for (const r of recs) {
      const w = r.rating / maxRating;
      const contribution = value * w;
      addCandidate(r, 'rec', entry, contribution, { entry, contribution });
    }
  }

  // A4: tag search
  for (const media of tagSearchItems) {
    addCandidate(media, 'tag', null, null, null);
  }

  // 5. Score.
  let candidates = [...byTv.values()];
  const maxCollab = candidates.length ? Math.max(...candidates.map((c) => c.collab)) : 0;
  const collabNormOf = (c) => (maxCollab > 0 ? c.collab / maxCollab : 0);
  const qualityOf = (c) => (c.averageScore != null ? c.averageScore / 100 : 0.6);
  // Cap: top 200 by (collabNorm + quality)
  candidates.sort((a, b) => (collabNormOf(b) + qualityOf(b)) - (collabNormOf(a) + qualityOf(a)));
  candidates = candidates.slice(0, 200);

  // Fetch tags for the scored set.
  const candAnilistIds = candidates.map((c) => c.anilistId);
  let candTags = new Map();
  if (candAnilistIds.length) {
    try {
      candTags = await deps.anilist.tagsFor(candAnilistIds);
    } catch (err) {
      log.warn(`[marquee-anime] ${name}: candidate tags unavailable (${err.message})`);
    }
  }

  // Score each candidate.
  for (const c of candidates) {
    const collabNorm = collabNormOf(c);
    const quality = qualityOf(c);
    const candVec = new Map();
    const tagData = candTags.get(c.anilistId);
    if (tagData) {
      for (const tag of tagData.tags || []) {
        candVec.set('tag:' + tag.name, tag.rank / 100);
      }
      for (const genre of tagData.genres || []) {
        candVec.set('genre:' + genre, 0.6);
      }
    }
    const tasteCos = cosine(candVec, taste);
    const trendCand = trendingByTv.get(c.show.tv);
    const trend = trendCand ? (trendCand.position != null ? 1 - trendCand.position / trendingN : 0) : 0;
    c.score = score({ collabNorm, tasteCos, quality, trend });
  }

  // Sort by score desc, ties by tv ascending.
  candidates.sort((a, b) => (b.score - a.score) || (a.show.tv < b.show.tv ? -1 : a.show.tv > b.show.tv ? 1 : 0));

  // 6. Compose the pool.
  const personalised = candidates;
  const personalisedTvSet = new Set(candidates.map((c) => c.show.tv));
  const trendingList = trendingCandidates.filter((c) => !personalisedTvSet.has(c.tmdb_id));

  let pool;
  if (personalised.length === 0) {
    log.log(`[marquee-anime] ${name}: personalisation produced nothing — using trending`);
    ctx.animeMode = 'trending';
    ctx.animeEngaged = engaged;
    pool = trendingList.slice(0, T);
  } else if (mode === 'mixed') {
    pool = [];
    let pIdx = 0, tIdx = 0;
    while (pool.length < T) {
      // Block: engaged personalised, then 5-engaged trending
      for (let i = 0; i < engaged && pool.length < T; i++) {
        if (pIdx < personalised.length) {
          pool.push(personalised[pIdx++]);
        } else if (tIdx < trendingList.length) {
          pool.push(trendingList[tIdx++]);
        } else {
          break;
        }
      }
      for (let i = 0; i < 5 - engaged && pool.length < T; i++) {
        if (tIdx < trendingList.length) {
          pool.push(trendingList[tIdx++]);
        } else if (pIdx < personalised.length) {
          pool.push(personalised[pIdx++]);
        } else {
          break;
        }
      }
      if (pIdx >= personalised.length && tIdx >= trendingList.length) break;
    }
    pool = pool.slice(0, T);
  } else {
    // personalised mode
    pool = [...personalised];
    for (const c of trendingList) {
      if (pool.length >= T) break;
      pool.push(c);
    }
    pool = pool.slice(0, T);
  }

  // Final rankScore.
  const N = pool.length;
  for (let i = 0; i < N; i++) {
    pool[i].rankScore = round6(1 - i / (N + 1));
  }

  // Set reason for personalised items.
  for (const c of pool) {
    if (c.bestSeed) {
      c.reason = 'because you watched ' + (c.bestSeed.entry.row.title || c.bestSeed.entry.row.tmdb_id);
    }
  }

  // Names/years/posters from TMDB (personalised items only; trending items
  // already have their names from the trending build).
  const tvIds = pool.filter((c) => c.show).map((c) => c.show.tv);
  let metas = new Map();
  if (tvIds.length) {
    try { metas = await deps.tvMeta(ctx.tmdbKey, tvIds, log); }
    catch (err) { log.warn(`[marquee-anime] ${name}: TMDB naming failed (${err.message}) — keeping source names`); }
  }

  // Build the final candidate objects.
  const finalCandidates = pool.map((c) => {
    if (c.show) {
      // Personalised candidate
      const m = metas.get(c.show.tv);
      const title = m && m.title ? m.title : (c.title || null);
      const year = m && m.year ? m.year : (c.year != null ? c.year : null);
      const poster = m && m.poster ? m.poster : `https://images.metahub.space/poster/medium/${c.show.imdb}/img`;
      return {
        type: 'anime',
        tmdb_id: c.show.tv,
        imdb_id: c.show.imdb,
        title,
        year,
        poster,
        primary_genre: c.genres[0] || null,
        genres: c.genres.join(','),
        vote_average: c.averageScore != null ? c.averageScore / 10 : null,
        vote_count: null,
        popularity: c.popularity != null ? c.popularity : null,
        rankScore: c.rankScore,
        // A personalised pick with no best seed came from the tag search only.
        reason: c.reason || 'Matches the tags you watch',
        algorithmVersion: ALGORITHM_VERSION,
      };
    } else {
      // Trending candidate (already has all fields from trending.build)
      return { ...c, algorithmVersion: ALGORITHM_VERSION };
    }
  });

  // 7. Decision log.
  const sink = deps.decisions || null;
  if (sink) {
    const selectedRows = [];
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const fc = finalCandidates[i];
      const sourceStr = c.show ? [...c.sources].join('+') : 'trending';
      const because = c.bestSeed ? (c.bestSeed.entry.row.title || null) : null;
      selectedRows.push({
        item_key: fc.tmdb_id,
        imdb_id: fc.imdb_id,
        title: fc.title,
        year: fc.year,
        poster: fc.poster,
        mal_rating: null,
        stage: 'engine',
        outcome: 'selected',
        source: sourceStr,
        reason: fc.reason,
        because,
      });
    }
    // Rewrite trending rows that were cut by the pool.
    const finalTvSet = new Set(finalCandidates.map((c) => c.tmdb_id));
    const trendingRows = rowsOut.map((r) => {
      if (r.outcome === 'selected' && !finalTvSet.has(r.item_key)) {
        return { ...r, outcome: 'filtered', stage: 'pool-cap', reason: `Below the pool cut-off (${T})` };
      }
      return r;
    });
    const allRows = [...filteredRows.values()].map((e) => e.row).concat(trendingRows).concat(selectedRows);
    try {
      const buildId = sink.newBuildId();
      ctx.animeBuildId = buildId;
      sink.record(profile.id, 'anime', buildId, allRows);
      // ctx.animeMode, not the local `mode`: a fallback to trending changes it.
      sink.recordMeta(profile.id, 'anime', buildId, { mode: ctx.animeMode, engaged });
      sink.prune(profile.id, 'anime');
    } catch (err) {
      log.warn(`[marquee-anime] ${name}: decision log failed (${err.message})`);
    }
  }

  // Stats.
  ctx.stats = {
    seeds: seedAnilistIds.length,
    raw: tagSearchItems.length + trendingN,
    strong: byTv.size,
    kept: finalCandidates.length,
  };

  // One line.
  const tierLabel = tier ? tier.label : 'none';
  const recCount = [...recsMap.values()].reduce((sum, recs) => sum + recs.length, 0);
  log.log(`[marquee-anime] ${name}: ${mode} — engaged ${engaged}, seeds ${seedAnilistIds.length}, recs ${recCount}, tag-search ${tagSearchItems.length}, trending ${trendingN} → pool ${finalCandidates.length} (tier ${tierLabel})`);

  return finalCandidates;
}

module.exports = { build, DEFAULT_DEPS, ALGORITHM_VERSION, score };
