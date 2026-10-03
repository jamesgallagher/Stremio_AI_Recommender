// Marquee TV (TV-2 §4.6/§5.4) — the pure collaboration + pre-score logic and
// the candidate sources.
//
// The pure pieces (collabRaw, normalizeCollab, becauseSeed, genreAff, prescore)
// are network-free and tested directly (F5–F7). The source functions (T1–T6)
// gather candidate list payloads through the ctx.marqueeTvFetchers seam (M6);
// they are wired together by the orchestrator.
const tmdb = require('../../services/tmdb');
const simklTrending = require('../../services/simklTrending');
const { tvGenres } = require('./filters');

// §4.6 Collaboration: each seed counts once per source group; value-weighted.
// `cand.seedHits` is Map<seedTmdbId, Set<'simkl'|'tmdb'>>; `seedValue` is
// Map<seedTmdbId, value>; `sw` is cfg.source_weights.
function collabRaw(cand, seedValue, sw) {
  let s = 0;
  for (const [seed, groups] of cand.seedHits) for (const g of groups) s += (seedValue.get(seed) || 0) * (sw[g] || 0);
  return s;
}

// normalized collab = raw / max(raw over all candidates) (0 when the max is 0).
// `raws` is Map<candidateTmdbId, raw>.
function normalizeCollab(raws) {
  let max = 0;
  for (const v of raws.values()) max = Math.max(max, v);
  const out = new Map();
  for (const [k, v] of raws) out.set(k, max > 0 ? v / max : 0);
  return out;
}

// The "because" seed: the seed whose contribution to the collab raw score is
// the highest (the reason the candidate was recommended). Returns the seed's
// tmdb_id, or null when there is no hit.
function becauseSeed(cand, seedValue, sw) {
  let best = null, bestScore = 0;
  for (const [seed, groups] of cand.seedHits) {
    let s = 0;
    for (const g of groups) s += (seedValue.get(seed) || 0) * (sw[g] || 0);
    if (s > bestScore) { bestScore = s; best = seed; }
  }
  return best;
}

// §4.6 genre affinity: max over the candidate's list genre names (tvGenres-split)
// of taste.dims.genres[g], floored at 0.
function genreAff(genres, taste) {
  const dims = taste?.dims?.genres || {};
  let max = 0;
  for (const g of genres) max = Math.max(max, dims[g] || 0);
  return max;
}

// §4.6 Pre-score (list payload only, no network):
//   p = pw.collab·collabNorm + pw.genre·genreAff + pw.trending·trendingRaw + pw.quality·(vote_average/10)
// `pw` is cfg.prescore.
function prescore({ collabNorm, genreAff: genre, trendingRaw, voteAverage }, pw) {
  return pw.collab * collabNorm + pw.genre * genre + pw.trending * trendingRaw + pw.quality * (voteAverage / 10);
}

// §5.4 TV genre ids (TMDB's TV genre table). Used by T3 (discover by genre) and
// T6 (airing-now discover by genre).
const TV_GENRE_IDS = { 'Action & Adventure': 10759, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18, Family: 10751, Kids: 10762, Mystery: 9648, News: 10763, Reality: 10764, 'Sci-Fi & Fantasy': 10765, Soap: 10766, Talk: 10767, 'War & Politics': 10768, Western: 37 };

// ---- §5.4 The candidate sources. Each returns a list of candidate list
// payloads; the orchestrator merges them into a single candidate pool with
// per-candidate seedHits (Map<seedTmdbId, Set<group>>) and sources (group list).
// Every network call goes through the ctx.marqueeTvFetchers seam (M6).

// T1: Simkl users_recs per seed (group 'simkl'). `fetcher` is a BATCH fetcher
// (profile, simklIds) → Map<simkl_id, recs[]> (the §5.3 ensureShowRecs fetcher),
// called once with all the seeds' Simkl ids — the uncached cap is per build
// (L2, TV-3 §5).
async function sourceSimklRecs(ctx, seeds, { fetcher, log = console } = {}) {
  const ids = [...new Set(seeds.map((s) => s.row.simkl_id).filter((id) => id != null))];
  if (!ids.length) return [];
  let bySeed;
  try {
    bySeed = await fetcher(ctx.profile, ids);
  } catch (err) {
    log.warn(`[marquee-tv] T1 simkl recs failed: ${err.message}`);
    return [];
  }
  const out = [];
  for (const s of seeds) {
    const recs = bySeed.get(s.row.simkl_id);
    if (!recs) continue;
    for (const r of recs) out.push({ item: r, group: 'simkl', seed: String(s.row.tmdb_id) });
  }
  return out;
}

// T2: tmdb.getRecommendations per seed (group 'tmdb'), first cfg.t2_per_seed.
async function sourceTmdbRecs(ctx, seeds, { fetcher, t2PerSeed, log = console } = {}) {
  const out = [];
  for (const s of seeds) {
    if (!s.row.tmdb_id) continue;
    let recs;
    try {
      recs = await fetcher(ctx.apiKey, 'series', s.row.tmdb_id);
    } catch (err) {
      log.warn(`[marquee-tv] T2 tmdb recs failed for seed ${s.row.tmdb_id}: ${err.message}`);
      continue;
    }
    for (const r of (recs || []).slice(0, t2PerSeed)) out.push({ item: r, group: 'tmdb', seed: String(s.row.tmdb_id) });
  }
  return out;
}

// T3: discoverTv × the top cfg.t3_genres taste genres that exist in
// TV_GENRE_IDS, sort_by alternating vote_average.desc / popularity.desc,
// vote_count.gte = the vote floor, cfg.t3_pages pages (group 'discover').
async function sourceDiscover(ctx, tasteGenresTop, { fetcher, cfg, voteFloor, log = console } = {}) {
  const out = [];
  const genres = tasteGenresTop.filter((g) => TV_GENRE_IDS[g] != null).slice(0, cfg.t3_genres);
  for (let i = 0; i < genres.length; i++) {
    const params = { with_genres: TV_GENRE_IDS[genres[i]], sort_by: i % 2 === 0 ? 'vote_average.desc' : 'popularity.desc', 'vote_count.gte': voteFloor };
    for (let page = 1; page <= cfg.t3_pages; page++) {
      let items;
      try {
        items = await fetcher(ctx.apiKey, params, { page });
      } catch (err) {
        log.warn(`[marquee-tv] T3 discover failed for genre ${genres[i]} page ${page}: ${err.message}`);
        continue;
      }
      for (const r of items || []) out.push({ item: r, group: 'discover' });
    }
  }
  return out;
}

// T5: simklTrending.getList('tv') (cached; never fetched here); rank →
// trendingRaw (group 'trending').
function sourceTrending(ctx, { fetcher } = {}) {
  const items = fetcher('tv') || [];
  const out = [];
  for (const r of items) out.push({ item: r, group: 'trending' });
  return out;
}

// T6: discoverTv with air_date.gte = today − cfg.t6_window_days,
// sort_by=popularity.desc, with_genres = the top 3 taste genres OR-joined
// (a|b|c), cfg.t6_pages pages (group 'airing').
async function sourceAiring(ctx, tasteGenresTop, { fetcher, cfg, now = new Date(), log = console } = {}) {
  const out = [];
  const genres = tasteGenresTop.filter((g) => TV_GENRE_IDS[g] != null).slice(0, 3);
  if (!genres.length) return out;
  const airDateGte = new Date(now);
  airDateGte.setDate(airDateGte.getDate() - cfg.t6_window_days);
  const params = { 'air_date.gte': airDateGte.toISOString().slice(0, 10), sort_by: 'popularity.desc', with_genres: genres.map((g) => TV_GENRE_IDS[g]).join('|') };
  for (let page = 1; page <= cfg.t6_pages; page++) {
    let items;
    try {
      items = await fetcher(ctx.apiKey, params, { page });
    } catch (err) {
      log.warn(`[marquee-tv] T6 airing discover failed page ${page}: ${err.message}`);
      continue;
    }
    for (const r of items || []) out.push({ item: r, group: 'airing' });
  }
  return out;
}

module.exports = { collabRaw, normalizeCollab, becauseSeed, genreAff, prescore, TV_GENRE_IDS, sourceSimklRecs, sourceTmdbRecs, sourceDiscover, sourceTrending, sourceAiring };
