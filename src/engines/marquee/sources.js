// Marquee ME-05 (spec §5) — gather ~1,500 raw movie candidates from seven
// sources (S1–S7), merge them, drop what the envelope rejects cheaply,
// pre-score, and keep the best ~400 (the MI-5 resolve budget).
//
// MI-3 graceful degradation: every source is isolated in its own try/catch —
// a failing source means fewer candidates, never a failed build. MI-4 Simkl
// etiquette: the S2 fetcher is simklCache.ensureRecs (governed, sequential,
// capped, no retry loops). MD-2: trending items enter whether or not they
// match taste — the taste gate in ME-06 keeps off-taste blockbusters low.
//
// Every network call is behind an injectable fetcher; the defaults are the live
// functions bound to ctx.tmdbKey / profile.
const crypto = require('crypto');
const recency = require('../../recency');
const tmdb = require('../../services/tmdb');
const llm = require('../../services/llm');
const watchedStore = require('../../watchedStore');
const simklCache = require('./simklCache');
const trendingCache = require('./trendingCache');
const simklTrending = require('../../services/simklTrending');
const llmCache = require('./llmCache');
const sharedCandidates = require('../shared/candidates');
const sharedTaste = require('../shared/tasteModel');
const metaStore = require('../shared/metaStore');
const features = require('./features');

// The fixed TMDB movie-genre id set (spec §3.1): getGenreMap merges the tv
// namespace too, so a name must map to its MOVIE id for discover with_genres.
const MOVIE_GENRE_IDS = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);

// ── PURE: parse + prompt the S6 LLM suggestions ──

// PURE (spec §5 S6): parse the LLM's suggestion array. llm.extractArray, then
// keep only items with a non-empty string title (≤ 120 chars) and an optional
// integer year in 1900..nowYear+1, dedupe by lowercased title + year. Throw if
// no valid items remain (makes chat try the next model/provider).
function parseSuggestions(text, { nowYear = new Date().getFullYear() } = {}) {
  const arr = llm.extractArray(text);
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    if (!title || title.length > 120) continue;
    let year = null;
    if (it.year != null) {
      const y = Number(it.year);
      if (!Number.isInteger(y) || y < 1900 || y > nowYear + 1) continue; // invalid year → dropped
      year = y;
    }
    const key = title.toLowerCase() + '|' + (year == null ? '' : year);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, year });
  }
  if (!out.length) throw new Error('no valid suggestions');
  return out;
}

// PURE (spec §5 S6): the S6 prompt. Carries the taste brief, the filter rules
// IN WORDS ("released in or after YEAR", "rated at least N on IMDb", "not these
// genres"), and the recent watched titles to avoid. Deliberately says NOTHING
// about age, suitability or classification — the envelope and the shared gate
// handle age (I1). Exported so a test can assert the exact prompt shape.
function buildSuggestPrompt(input) {
  const lines = [];
  lines.push('You are suggesting movie titles for a recommendation engine.');
  lines.push("The viewer's taste profile:");
  lines.push(input.brief ? JSON.stringify(input.brief) : '(no profile)');
  lines.push('');
  lines.push('Rules for every suggestion:');
  if (input.minYear != null) lines.push(`- released in or after ${input.minYear}`);
  if (input.minRating > 0) lines.push(`- rated at least ${input.minRating} on IMDb`);
  if (input.excludedGenres && input.excludedGenres.length) lines.push(`- not these genres: ${input.excludedGenres.join(', ')}`);
  lines.push('');
  if (input.avoidRecent && input.avoidRecent.length) {
    lines.push('Do not suggest these recently watched titles:');
    for (const t of input.avoidRecent) lines.push(`- ${t.title} (${t.year == null ? 'n.d.' : t.year})`);
  }
  lines.push('');
  lines.push(`Respond with a JSON array of ${input.count} objects, each exactly {"title": "...", "year": 1999}.`);
  lines.push('Output ONLY the JSON array.');
  return lines.join('\n');
}

// ── candidate construction + merge ──

// Map a list item → a Marquee candidate (spec §4.3). `genreMap` (id→name)
// converts genre_ids to the same NAME space the taste model and trending use.
function makeCand(item, genreMap) {
  const genreIds = item.genre_ids || [];
  return {
    type: 'movie',
    tmdb_id: String(item.tmdb_id),
    title: item.title || null,
    year: item.year ?? null,
    genre_ids: genreIds,
    genres: genreIds.map((g) => genreMap[g]).filter(Boolean),
    vote_average: Number.isFinite(item.vote_average) ? item.vote_average : 0,
    vote_count: Number.isFinite(item.vote_count) ? item.vote_count : 0,
    popularity: Number.isFinite(item.popularity) ? item.popularity : 0,
    adult: !!item.adult,
    poster: item.poster || null,
    sources: new Set(),
    seeds: new Set(),
    seedTitles: new Map(),
    _seedWeights: new Map(),   // internal: seed tmdb_id → weight (for _fit.seedTitle)
    trending: { tmdbWeekRank: null, tmdbDayRank: null, simklWatched: 0, simklDrop: null },
    _preScore: 0,
  };
}

const bestRank = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));

// Merge candidate `b` into existing `a` (same title from >1 source, spec §4.3):
// union sources/seeds/seedTitles; keep the best (lowest) non-null trending
// ranks; keep the max simklWatched; take simklDrop from the item with the max
// simklWatched; take the first non-empty value of every other field.
function mergeCand(a, b) {
  for (const s of b.sources) a.sources.add(s);
  for (const s of b.seeds) a.seeds.add(s);
  for (const [k, v] of b.seedTitles) a.seedTitles.set(k, v);
  for (const [k, v] of b._seedWeights) a._seedWeights.set(k, v);
  a.trending.tmdbWeekRank = bestRank(a.trending.tmdbWeekRank, b.trending.tmdbWeekRank);
  a.trending.tmdbDayRank = bestRank(a.trending.tmdbDayRank, b.trending.tmdbDayRank);
  const aW = a.trending.simklWatched || 0, bW = b.trending.simklWatched || 0;
  a.trending.simklWatched = Math.max(aW, bW);
  if (aW > bW) a.trending.simklDrop = a.trending.simklDrop;
  else if (bW > aW) a.trending.simklDrop = b.trending.simklDrop;
  else a.trending.simklDrop = a.trending.simklDrop ?? b.trending.simklDrop;
  if (!a.title) a.title = b.title;
  if (a.year == null) a.year = b.year;
  if (!a.genre_ids.length) a.genre_ids = b.genre_ids;
  if (!a.genres.length) a.genres = b.genres;
  if (!a.vote_average) a.vote_average = b.vote_average;
  if (!a.vote_count) a.vote_count = b.vote_count;
  if (!a.popularity) a.popularity = b.popularity;
  a.adult = a.adult || b.adult;
  if (!a.poster) a.poster = b.poster;
  return a;
}

// De-dupe a candidate pool by tmdb_id, merging sources/fields.
function dedupePool(pool) {
  const byId = new Map();
  for (const c of pool) {
    const ex = byId.get(c.tmdb_id);
    if (ex) mergeCand(ex, c);
    else byId.set(c.tmdb_id, c);
  }
  return [...byId.values()];
}

// ── S3/S4 query builders (pure) ──

// name → movie genre id, over the P1 movie-genre id set (spec §5 S3: discover
// needs ids, not names).
function nameToMovieId(genreMap) {
  const out = {};
  for (const [id, name] of Object.entries(genreMap || {})) {
    if (MOVIE_GENRE_IDS.has(Number(id))) out[name] = Number(id);
  }
  return out;
}

// S3 genre queries (spec §5 S3): the top-3 positive-affinity genres one at a
// time, then the strongest genre pairs (TMDB treats a,b as AND) until
// cfg.discover.queries. Keywords and people are DELIBERATELY not queried —
// TMDB's with_keywords/with_people need TMDB ids and the taste model stores
// NAMES; resolving them would add search calls to every build (known gap,
// spec §5 S3 names these axes).
function buildDiscoverQueries(taste, genreMap, cfg) {
  const pos = Object.entries(taste?.dims?.genres || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const nameToId = nameToMovieId(genreMap);
  const queries = [];
  for (const [name] of pos.slice(0, 3)) {
    const id = nameToId[name];
    if (id) queries.push({ with_genres: String(id) });
  }
  const pairs = [];
  for (let i = 0; i < pos.length; i += 1) {
    for (let j = i + 1; j < pos.length; j += 1) {
      const a = nameToId[pos[i][0]], b = nameToId[pos[j][0]];
      if (a && b) pairs.push({ with_genres: `${a},${b}`, aff: pos[i][1] + pos[j][1] });
    }
  }
  pairs.sort((a, b) => b.aff - a.aff);
  for (const p of pairs) {
    if (queries.length >= cfg.discover.queries) break;
    queries.push({ with_genres: p.with_genres });
  }
  return queries.slice(0, cfg.discover.queries);
}

// S4 collection ids (spec §5 S4): positive-affinity franchises (keys
// 'c:<collectionId>'), strongest first, up to cfg.collections.max.
function buildCollectionIds(taste, cfg) {
  const fr = Object.entries(taste?.dims?.franchises || {})
    .filter(([k, v]) => v > 0 && k.startsWith('c:'))
    .sort((a, b) => b[1] - a[1]);
  return fr.map(([k]) => k.slice(2)).slice(0, cfg.collections.max);
}

// ── S6: the cached LLM suggestion list ──

// S6 (spec §5 S6): the LLM suggestions, cached in marquee_llm_cache (kind
// 'suggest') keyed by briefHash + filterKey. The cached value is the RESOLVED
// list (including tmdb_id:null rows, so a dud is not re-searched every build).
// On a miss: build the prompt, call chat, resolve each title SEQUENTIALLY
// (untrusted LLM output — only title + year are taken, resolved through TMDB).
async function gatherSuggestions(profile, ctx, cfg, { brief, briefHash, chain, fetchers, log, nowYear }) {
  const filters = ctx.filters || {};
  const filterKey = JSON.stringify({
    min_rating: filters.min_rating || 0,
    min_year: recency.minYearOf(filters, nowYear),
    excluded_genres: (filters.excluded_genres || []).slice().sort(),
    age_limit: filters.age_limit || 0,
  });
  const key = crypto.createHash('sha256').update(briefHash + '|' + filterKey).digest('hex');
  const cached = llmCache.get(profile.id, 'suggest', key, { ttlMs: cfg.suggest.ttl_days * 86400e3, now: Date.now() });
  if (cached) return cached;

  const recent = watchedStore.getWatched(profile.id, { type: 'movie' })
    .sort((a, b) => (b.watched_at || '').localeCompare(a.watched_at || ''))
    .slice(0, cfg.suggest.avoid_recent)
    .map((w) => ({ title: w.title, year: w.year }));

  const prompt = buildSuggestPrompt({
    brief,
    minYear: recency.minYearOf(filters, nowYear) || null,
    minRating: filters.min_rating || 0,
    excludedGenres: filters.excluded_genres || [],
    avoidRecent: recent,
    count: cfg.suggest.count,
  });
  const timeoutMs = Number(process.env.MARQUEE_LLM_TIMEOUT_MS) || cfg.llm_timeout_ms;
  const suggestions = await fetchers.chat(chain, [{ role: 'user', content: prompt }], {
    temperature: 0.3, timeoutMs, validate: (text) => parseSuggestions(text, { nowYear }),
  }, log);

  const resolved = [];
  for (const s of suggestions) {
    let meta = null;
    try { meta = await fetchers.resolve(s.title, s.year); } catch { meta = null; }
    if (meta && meta._tmdb_id) {
      resolved.push({
        title: s.title,
        year: meta.releaseInfo ? parseInt(meta.releaseInfo, 10) : s.year,
        tmdb_id: String(meta._tmdb_id),
        genre_ids: meta._genre_ids || [],
        vote_average: meta._vote_average || 0,
        vote_count: meta._vote_count || 0,
      });
    } else {
      resolved.push({ title: s.title, year: s.year, tmdb_id: null }); // dud — cached so it is not re-searched
    }
  }
  llmCache.put(profile.id, 'suggest', key, resolved, Date.now());
  return resolved;
}

// ── ME-05 entry ──

// The live fetchers, bound to ctx.tmdbKey / profile (spec §4.4).
function defaultFetchers(ctx, profile, cfg, log) {
  return {
    recs: (tmdbId) => tmdb.getRecommendations(ctx.tmdbKey, 'movie', tmdbId),
    similar: (tmdbId) => tmdb.getSimilar(ctx.tmdbKey, tmdbId),
    discover: (params, page) => tmdb.discoverMovies(ctx.tmdbKey, params, { page }),
    collection: (id) => tmdb.collectionParts(ctx.tmdbKey, id),
    trendingWeek: async () => { await trendingCache.ensureFresh({ apiKey: ctx.tmdbKey, log }); return trendingCache.getWindow('week'); },
    trendingDay: async () => { await trendingCache.ensureFresh({ apiKey: ctx.tmdbKey, log }); return trendingCache.getWindow('day'); },
    simklTrending: async () => { await simklTrending.ensureFresh({ log }); return simklTrending.getList('movies'); },
    simklRecs: (simklIds) => simklCache.ensureRecs(profile, simklIds, { maxUncached: cfg.simkl.recs_max_uncached, log }),
    chat: llm.chat,
    resolve: (title, year) => tmdb.resolveTitle(ctx.tmdbKey, 'movie', title, year, log),
  };
}

// Gather the raw candidate set (spec §4.4). Returns
// { candidates: Candidate[] (≤ cfg.lookup_cap), meta: { weekN, dayN, hadTrending } }.
async function gatherCandidates(profile, ctx, {
  taste, brief, briefHash, seeds, envelope, cfg, genreMap, fetchers, chain = [], log = console, onProgress = () => {},
} = {}) {
  const f = fetchers || defaultFetchers(ctx, profile, cfg, log);
  const nowYear = new Date().getFullYear();
  const watchedTmdb = ctx.watchedIds?.tmdb || new Set();
  const dont = ctx.dont || new Set();
  const pool = [];
  const srcCounts = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0, S7: 0, S2_reserved: 0 };

  // S1 — TMDB /recommendations + /similar per seed, chunks of 5 (like Glass).
  try {
    for (let i = 0; i < seeds.length; i += 5) {
      const chunk = seeds.slice(i, i + 5);
      await Promise.all(chunk.map(async (seed) => {
        try {
          const recs = await f.recs(seed.tmdb_id);
          for (const r of recs.slice(0, cfg.recs_per_seed)) {
            const c = makeCand(r, genreMap);
            c.sources.add('tmdb_recs');
            c.seeds.add(seed.tmdb_id);
            c.seedTitles.set(seed.tmdb_id, seed.title);
            c._seedWeights.set(seed.tmdb_id, seed.weight);
            pool.push(c);
            srcCounts.S1 += 1;
          }
        } catch (err) { log.warn(`[marquee] S1 recs for ${seed.title} failed: ${err.message}`); }
        try {
          const sim = await f.similar(seed.tmdb_id);
          // m2: /similar is genre/keyword-based and noisier — fewer per seed.
          for (const s of sim.slice(0, cfg.similar_per_seed ?? cfg.recs_per_seed)) {
            const c = makeCand(s, genreMap);
            c.sources.add('tmdb_similar');
            c.seeds.add(seed.tmdb_id);
            c.seedTitles.set(seed.tmdb_id, seed.title);
            c._seedWeights.set(seed.tmdb_id, seed.weight);
            pool.push(c);
            srcCounts.S1 += 1;
          }
        } catch (err) { log.warn(`[marquee] S1 similar for ${seed.title} failed: ${err.message}`); }
      }));
    }
  } catch (err) { log.warn(`[marquee] S1 failed: ${err.message}`); }
  onProgress(10, 'Gathered TMDB recs + similar');

  // S2 — Simkl collaborative recs (users_recommendations) per seed. Recs without
  // a tmdb_id are dropped here (do not resolve 40×N imdb ids per build). These
  // carry no list payload — vote/genre fields are filled only if the same title
  // arrives from another source during the merge.
  try {
    const simklIds = seeds.filter((s) => s.simkl_id).map((s) => s.simkl_id);
    if (simklIds.length) {
      const simklToSeed = new Map(seeds.filter((s) => s.simkl_id).map((s) => [s.simkl_id, s]));
      const recsBySeed = await f.simklRecs(simklIds);
      for (const [simklId, recs] of recsBySeed) {
        const seed = simklToSeed.get(simklId);
        if (!seed) continue;
        for (const r of recs) {
          if (!r.tmdb_id) continue;
          const c = makeCand({ tmdb_id: r.tmdb_id, title: r.title, year: r.year, genre_ids: [], vote_average: 0, vote_count: 0, popularity: 0, adult: false, poster: null }, genreMap);
          c.sources.add('simkl_recs');
          c.seeds.add(seed.tmdb_id);
          c.seedTitles.set(seed.tmdb_id, seed.title);
          c._seedWeights.set(seed.tmdb_id, seed.weight);
          pool.push(c);
          srcCounts.S2 += 1;
        }
      }
    }
  } catch (err) { log.warn(`[marquee] S2 failed: ${err.message}`); }
  onProgress(20, 'Gathered Simkl recs');

  // S3 — discover by taste (genre queries, envelope params always applied).
  try {
    const queries = buildDiscoverQueries(taste, genreMap, cfg);
    for (let qi = 0; qi < queries.length; qi += 1) {
      const sort_by = qi % 2 === 0 ? 'vote_average.desc' : 'popularity.desc';
      for (let page = 1; page <= cfg.discover.pages; page += 1) {
        try {
          const items = await f.discover({ ...envelope.discoverParams(), with_genres: queries[qi].with_genres, sort_by }, page);
          for (const it of items) {
            const c = makeCand(it, genreMap);
            c.sources.add('discover');
            pool.push(c);
            srcCounts.S3 += 1;
          }
        } catch (err) { log.warn(`[marquee] S3 discover failed: ${err.message}`); }
      }
    }
  } catch (err) { log.warn(`[marquee] S3 failed: ${err.message}`); }
  onProgress(30, 'Gathered discover by taste');

  // S4 — franchise continuation: unwatched, released parts of positive-affinity
  // collections.
  try {
    const collIds = buildCollectionIds(taste, cfg);
    const today = new Date().toISOString().slice(0, 10);
    for (const id of collIds) {
      try {
        const parts = await f.collection(id);
        for (const p of parts) {
          if (watchedTmdb.has(String(p.tmdb_id))) continue;
          if (!p.release_date || p.release_date > today) continue;
          const c = makeCand(p, genreMap);
          c.sources.add('collection');
          pool.push(c);
          srcCounts.S4 += 1;
        }
      } catch (err) { log.warn(`[marquee] S4 collection failed: ${err.message}`); }
    }
  } catch (err) { log.warn(`[marquee] S4 failed: ${err.message}`); }
  onProgress(40, 'Gathered franchise continuation');

  // S5 — trending (TMDB week/day + Simkl). Trending items enter whether or not
  // they match taste (MD-2 — the taste gate in ME-06 keeps off-taste low).
  // Review round 1 (S1): each list has its OWN try/catch — one CDN failing must
  // not throw away the other lists (which would also flip hadTrending and drop
  // trending_eff from the ME-06 weights).
  let weekN = 0, dayN = 0, hadTrending = false;
  let week = [];
  let day = [];
  let simkl = [];
  try { week = (await f.trendingWeek()) || []; } catch (err) { log.warn(`[marquee] S5 trendingWeek failed: ${err.message}`); }
  try { day = (await f.trendingDay()) || []; } catch (err) { log.warn(`[marquee] S5 trendingDay failed: ${err.message}`); }
  try { simkl = (await f.simklTrending()) || []; } catch (err) { log.warn(`[marquee] S5 simklTrending failed: ${err.message}`); }
  // m2: take only the top cfg.trending.simkl_take of Simkl's week_500 list (by
  // its own rank; unranked last). The full list flooded the lookup budget with
  // generic popular titles — the first backtest's top 20 was 95% trending-tagged.
  {
    const take = cfg.trending?.simkl_take;
    if (Number.isFinite(take) && take >= 0 && simkl.length > take) {
      const rankOf = (it) => (Number.isFinite(it?.rank) ? it.rank : Infinity);
      simkl = simkl.slice().sort((a, b) => rankOf(a) - rankOf(b)).slice(0, take);
    }
  }
  weekN = week.length;
  dayN = day.length;
  hadTrending = weekN > 0 || dayN > 0 || simkl.length > 0;
  for (const it of week) {
    const c = makeCand(it, genreMap);
    c.trending.tmdbWeekRank = it.rank;
    c.sources.add('trending');
    pool.push(c);
    srcCounts.S5 += 1;
  }
  for (const it of day) {
    const c = makeCand(it, genreMap);
    c.trending.tmdbDayRank = it.rank;
    c.sources.add('trending');
    pool.push(c);
    srcCounts.S5 += 1;
  }
  for (const it of simkl) {
    const c = makeCand({ tmdb_id: it.tmdb_id, title: it.title, year: it.year, genre_ids: [], vote_average: it.ratings?.imdb?.rating ?? 0, vote_count: it.ratings?.imdb?.votes ?? 0, popularity: 0, adult: false, poster: null }, genreMap);
    c.genres = it.genres || [];
    c.trending.simklWatched = it.watched || 0;
    c.trending.simklDrop = it.drop_rate ?? null;
    c.sources.add('trending');
    pool.push(c);
    srcCounts.S5 += 1;
  }
  onProgress(50, 'Gathered trending');

  // S6 — LLM suggestions (only when brief is non-null and a local chain is set).
  if (brief && chain.length > 0) {
    try {
      const resolved = await gatherSuggestions(profile, ctx, cfg, { brief, briefHash, chain, fetchers: f, log, nowYear });
      for (const r of resolved) {
        if (!r.tmdb_id) continue; // unresolved → dropped
        const c = makeCand({ tmdb_id: r.tmdb_id, title: r.title, year: r.year, genre_ids: r.genre_ids || [], vote_average: r.vote_average || 0, vote_count: r.vote_count || 0, popularity: 0, adult: false, poster: null }, genreMap);
        c.sources.add('llm');
        pool.push(c);
        srcCounts.S6 += 1;
      }
    } catch (err) { log.warn(`[marquee] S6 LLM suggestions failed: ${err.message}`); }
  }
  onProgress(60, 'Gathered LLM suggestions');

  // Merge, then exclude watched / dont_recommend / adult, then the envelope
  // prefilter. Exception (spec §4.4 step 7): a candidate whose ONLY sources are
  // simkl_recs and/or llm and that has vote_count === 0 runs the prefilter with
  // the vote + rating checks skipped (those fields are unknown until lookup; the
  // hard filter enforces them) — implemented as prefilter on a copy with
  // vote_count = Infinity and vote_average = 0.
  let merged = dedupePool(pool);
  const raw = srcCounts.S1 + srcCounts.S2 + srcCounts.S3 + srcCounts.S4 + srcCounts.S5 + srcCounts.S6;

  // F1 (review round 1): hydrate S2/LLM-only candidates from the meta cache —
  // free, no network. They arrive with no list payload (genres: [], votes 0);
  // where a cached deep meta exists, fill genres/votes so the title pre-scores
  // normally (and takes the normal prefilter, not the vote+rating exception).
  {
    const need = merged.filter((c) => [...c.sources].every((s) => s === 'simkl_recs' || s === 'llm') && !c.genres.length);
    if (need.length) {
      const metas = metaStore.getMany('movie', need.map((c) => c.tmdb_id));
      for (const c of need) {
        const m = metas.get(c.tmdb_id);
        if (m) {
          if (!c.genres.length) c.genres = (m.genres || []).slice();
          if (!c.vote_average) c.vote_average = m.vote_average || 0;
          if (!c.vote_count) c.vote_count = m.vote_count || 0;
        }
      }
    }
  }

  // m2 diagnostics: when the caller passes ctx.marqueeTrace (the backtest
  // does), record every generated title and the stage that dropped it, so a
  // miss can be explained instead of guessed at. Zero cost when absent.
  const trace = ctx.marqueeTrace || null;
  if (trace) {
    trace.generated = trace.generated || new Map();
    trace.dropped = trace.dropped || new Map();
    for (const c of merged) trace.generated.set(c.tmdb_id, [...c.sources]);
  }
  const drop = (c, why) => { if (trace) trace.dropped.set(c.tmdb_id, why); return false; };

  merged = merged.filter((c) => {
    if (watchedTmdb.has(c.tmdb_id)) return drop(c, 'watched');
    if (dont.has(`movie:${c.tmdb_id}`)) return drop(c, 'dont_recommend');
    // m2 engagement: a film this profile started and abandoned before halfway
    // is never recommended back by Marquee (Marquee-only by design).
    if (ctx.marqueeAbandoned && ctx.marqueeAbandoned.has(c.tmdb_id)) return drop(c, 'abandoned');
    if (c.adult) return drop(c, 'adult');
    const onlyS2orLLM = [...c.sources].every((s) => s === 'simkl_recs' || s === 'llm');
    const item = (onlyS2orLLM && c.vote_count === 0) ? { ...c, vote_count: Infinity, vote_average: 0 } : c;
    const v = envelope.prefilter(item);
    return v.ok ? true : drop(c, `prefilter:${v.reason}`);
  });
  const strong = merged.length;

  // S7 — exploration reserve: high-quality trending OUTSIDE the top-6 genres.
  const reserve = Math.round(cfg.lookup_cap * cfg.exploration_pct);
  const topSet = new Set(sharedTaste.topGenres(taste, 6));
  const explore = merged
    .filter((c) => c.sources.has('trending') && !c.sources.has('exploration'))
    .filter((c) => sharedCandidates.outsideTopGenres(c, topSet))
    .filter((c) => (c.vote_average || 0) >= 6.5)
    .sort((a, b) => features.trendingRaw(b.trending, { weekN, dayN }) - features.trendingRaw(a.trending, { weekN, dayN }))
    .slice(0, reserve);
  for (const c of explore) c.sources.add('exploration');
  srcCounts.S7 = explore.length;

  // Pre-score + truncate to the MI-5 resolve budget.
  // m2: seed agreement is normalised to this build's strongest title.
  // m4 (spec §17): the seed affinity is genre-fair — the global normalisation
  // blended with the within-genre normalisation (cfg.agreement.genre_blend),
  // so a strong film in a small genre can compete with a hub film in a big one.
  // β=0 reproduces the m2 global normalisation exactly.
  const saNorm = features.genreRelativeNormalizer(merged, features.seedAffinityRaw, features.primaryGenreOf,
    { blend: cfg.agreement?.genre_blend ?? 0, minGroupSize: cfg.agreement?.min_genre_size ?? 5 });
  for (const c of merged) c._preScore = features.preScore(c, taste, { weekN, dayN, seedAffinityNorm: saNorm(c), weights: cfg.prescore });
  const nonExplore = merged.filter((c) => !c.sources.has('exploration'));
  nonExplore.sort((a, b) => (b._preScore - a._preScore) || (a.tmdb_id < b.tmdb_id ? -1 : 1));

  // F1 (review round 1): the Simkl collaborative reserve. S2-only candidates
  // pre-score ~0.067 (no list payload), so a pure pre-score truncation would
  // starve the collaborative signal (spec §2 pillar). Take up to
  // cfg.simkl.collab_reserve candidates whose sources include simkl_recs and
  // that do NOT already rank inside the main slice, ranked by distinct-seed
  // count, then max seed weight, then tmdb_id. The 'collab_reserve' tag is
  // deliberately NOT counted by features.countedGroups (no consensus change).
  //
  // P4 carry-over (build prompt §4.0): the reserve's pool extends to every
  // title OUTSIDE the final main slice — from rank (mainCap − collab_reserve),
  // not mainCap. A title ranked between the two was previously dropped by BOTH
  // the pool (slice(mainCap)) and the main slice (mainCap − collab_reserve),
  // while weaker S2 titles below mainCap got reserved instead.
  const mainCap = Math.max(0, cfg.lookup_cap - explore.length);
  const maxSeedWeight = (c) => { let m = null; for (const [, w] of c._seedWeights) if (m == null || w > m) m = w; return m; };
  const poolStart = Math.max(0, mainCap - cfg.simkl.collab_reserve);
  const collab = nonExplore
    .slice(poolStart)
    .filter((c) => c.sources.has('simkl_recs'))
    .sort((a, b) => (b.seeds.size - a.seeds.size) || ((maxSeedWeight(b) || 0) - (maxSeedWeight(a) || 0)) || (a.tmdb_id < b.tmdb_id ? -1 : 1))
    .slice(0, cfg.simkl.collab_reserve);
  for (const c of collab) c.sources.add('collab_reserve');
  srcCounts.S2_reserved = collab.length;

  // Main slice = the top (mainCap − collab) of nonExplore, excluding anything
  // reserved (a reserved title inside the main range must not appear twice);
  // total stays ≤ lookup_cap (MI-5 unchanged).
  const collabSet = new Set(collab.map((c) => c.tmdb_id));
  const mainSlice = nonExplore
    .filter((c) => !collabSet.has(c.tmdb_id))
    .slice(0, Math.max(0, mainCap - collab.length));
  const candidates = [...mainSlice, ...collab, ...explore];
  const kept = candidates.length;
  if (trace) {
    const keptSet = new Set(candidates.map((c) => c.tmdb_id));
    nonExplore.forEach((c, i) => { if (!keptSet.has(c.tmdb_id)) drop(c, `truncated (pre-score rank ${i + 1}/${nonExplore.length})`); });
  }

  if (ctx.stats) {
    ctx.stats.seeds = seeds.length;
    ctx.stats.raw = raw;
    ctx.stats.strong = strong;
    ctx.stats.kept = kept;
    ctx.stats.sources = { ...srcCounts };
  }
  onProgress(100, `Gathered ${kept} candidate(s)`);
  return { candidates, meta: { weekN, dayN, hadTrending } };
}

module.exports = {
  gatherCandidates,
  defaultFetchers,
  parseSuggestions,
  buildSuggestPrompt,
  buildDiscoverQueries,
  buildCollectionIds,
  makeCand,
  mergeCand,
  dedupePool,
};
