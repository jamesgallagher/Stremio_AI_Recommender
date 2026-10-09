// AN-1b card 1: age-appropriate trending anime for the Marquee Anime lane.
// Sources: Simkl anime trending (cached CDN list), AniList trending, and — for
// 10+/12+ profiles only — a kid-friendly AniList list. Every entry is mapped to
// its TV show (Fribb), so seasons merge into one title. No age logic here: the
// lane's age gate (recommendationStore) decides what is allowed.
const DEFAULT_DEPS = {
  simklList: () => require('../../services/simklTrending').getList('anime'),
  anilistList: (list, page) => require('../../services/anilist').trendingAnime({ list, page }),
  animeMap: require('../../services/animeMap'),
  listSize: (p) => require('../../recommendationStore').listSizeFor(p),
  tier: (p) => require('../../ageVerification').tierFor(p.filters || {}),
  tvMeta: (apiKey, ids, log) => require('../marqueeTv/meta').ensureTvMeta(apiKey, ids, { log }),
  decisions: require('../../anime/decisionLog'),
};

const isShowType = (t) => t === 'TV' || t === 'ONA';

// The Simkl MAL rating (0–10) from an item's ratings block, tolerant of the
// two shapes (a bare number or a { rating, votes } object).
const simklMalOf = (item) => {
  const r = item && item.ratings ? item.ratings.mal : null;
  if (r == null) return null;
  return typeof r === 'number' ? r : (r.rating != null ? r.rating : null);
};

async function build(profile, ctx, deps = DEFAULT_DEPS) {
  const log = ctx.log || console;
  const name = (profile && (profile.name || profile.id)) || 'profile';
  const sink = deps.decisions || null;
  const decisionRows = new Map();

  // 1. Load the anime id map (the reverse lookups the entries are mapped onto).
  await deps.animeMap.ensureLoaded(log);

  // 2. Fetch each source in its own try/catch — a failed source logs one line
  //    and contributes nothing; the others still stand.
  const tier = deps.tier(profile);
  const kidsOn = tier != null && tier.csmMaxAge <= 12;

  let simklItems = [];
  try {
    simklItems = (await deps.simklList()) || [];
  } catch (err) {
    log.warn(`[marquee-anime] ${name}: Simkl trending unavailable (${err.message})`);
  }

  let anilistItems = [];
  try {
    anilistItems = (await deps.anilistList('trending', 1)) || [];
    anilistItems = anilistItems.concat((await deps.anilistList('trending', 2)) || []);
  } catch (err) {
    log.warn(`[marquee-anime] ${name}: AniList trending unavailable (${err.message})`);
  }

  let kidsItems = [];
  if (kidsOn) {
    try {
      // 4 pages: on live data 2 pages left a 10+ profile at 22 of 30 after the age gate; 4 pages gave 44.
      for (let pg = 1; pg <= 4; pg++) kidsItems = kidsItems.concat((await deps.anilistList('kids', pg)) || []);
    } catch (err) {
      log.warn(`[marquee-anime] ${name}: AniList kids list unavailable (${err.message})`);
    }
  }

  // 3 + 4. Map each entry to its TV show and merge by show.tv, keeping the best
  // (lowest) position per source plus the AniList fields (averageScore, genres,
  // popularity, English/romaji title) and the Simkl fields (MAL rating, title,
  // year). A kids hit marks the show kid-friendly.
  const shows = new Map();
  const record = (show) => {
    let rec = shows.get(show.tv);
    if (!rec) {
      rec = {
        show,
        simklPos: null,
        aniPos: null,
        kidsPos: null,
        averageScore: null,
        genres: [],
        popularity: null,
        titleAni: null,
        titleSimkl: null,
        simklMal: null,
        yearSimkl: null,
        yearAni: null,
        isKids: false,
      };
      shows.set(show.tv, rec);
    }
    return rec;
  };
  const better = (rec, key, pos) => {
    if (rec[key] == null || pos < rec[key]) rec[key] = pos;
  };
  const applyAni = (rec, media) => {
    if (media.averageScore != null) rec.averageScore = media.averageScore;
    if (Array.isArray(media.genres) && media.genres.length) rec.genres = media.genres;
    if (media.popularity != null) rec.popularity = media.popularity;
    const t = media.title && (media.title.english || media.title.romaji);
    if (t) rec.titleAni = t;
    const ay = media.startDate && media.startDate.year;
    if (ay != null) rec.yearAni = ay;
  };

  simklItems.forEach((item, i) => {
    const show = deps.animeMap.byMal(item.mal);
    if (!show) {
      if (sink) {
        decisionRows.set(`mal:${item.mal}`, {
          item_key: `mal:${item.mal}`,
          title: item.title ?? null,
          stage: 'no-tt',
          outcome: 'filtered',
          source: 'simkl',
          reason: 'No TMDB show + IMDb id in the anime map',
        });
      }
      return;
    }
    if (!isShowType(show.type)) {
      if (sink) {
        decisionRows.set(show.tv, {
          item_key: show.tv,
          title: item.title ?? null,
          stage: 'format',
          outcome: 'filtered',
          source: 'simkl',
          reason: `Format ${show.type} is not TV or ONA`,
        });
      }
      return;
    }
    const rec = record(show);
    better(rec, 'simklPos', i);
    const mal = simklMalOf(item);
    if (mal != null) rec.simklMal = mal;
    if (item.title) rec.titleSimkl = item.title;
    if (item.year != null) rec.yearSimkl = item.year;
  });

  anilistItems.forEach((media, i) => {
    const show = deps.animeMap.byAnilist(media.id) || deps.animeMap.byMal(media.idMal);
    if (!show) {
      if (sink) {
        decisionRows.set(`anilist:${media.id}`, {
          item_key: `anilist:${media.id}`,
          title: (media.title && (media.title.english || media.title.romaji)) ?? null,
          stage: 'no-tt',
          outcome: 'filtered',
          source: 'anilist',
          reason: 'No TMDB show + IMDb id in the anime map',
        });
      }
      return;
    }
    if (!isShowType(show.type)) {
      if (sink) {
        decisionRows.set(show.tv, {
          item_key: show.tv,
          title: (media.title && (media.title.english || media.title.romaji)) ?? null,
          stage: 'format',
          outcome: 'filtered',
          source: 'anilist',
          reason: `Format ${show.type} is not TV or ONA`,
        });
      }
      return;
    }
    const rec = record(show);
    better(rec, 'aniPos', i);
    applyAni(rec, media);
  });

  kidsItems.forEach((media, i) => {
    const show = deps.animeMap.byAnilist(media.id) || deps.animeMap.byMal(media.idMal);
    if (!show) {
      if (sink) {
        decisionRows.set(`anilist:${media.id}`, {
          item_key: `anilist:${media.id}`,
          title: (media.title && (media.title.english || media.title.romaji)) ?? null,
          stage: 'no-tt',
          outcome: 'filtered',
          source: 'kids',
          reason: 'No TMDB show + IMDb id in the anime map',
        });
      }
      return;
    }
    if (!isShowType(show.type)) {
      if (sink) {
        decisionRows.set(show.tv, {
          item_key: show.tv,
          title: (media.title && (media.title.english || media.title.romaji)) ?? null,
          stage: 'format',
          outcome: 'filtered',
          source: 'kids',
          reason: `Format ${show.type} is not TV or ONA`,
        });
      }
      return;
    }
    const rec = record(show);
    better(rec, 'kidsPos', i);
    applyAni(rec, media);
    rec.isKids = true;
  });

  // 5. Score each show (0..1).
  const pos = (p, n) => (p == null ? 0 : 1 - p / n); // p is 0-based, n = that list's length
  const candidates = [];
  for (const rec of shows.values()) {
    const { show } = rec;
    const trend = Math.max(pos(rec.simklPos, simklItems.length), pos(rec.aniPos, anilistItems.length), pos(rec.kidsPos, kidsItems.length));
    const quality = rec.averageScore != null ? rec.averageScore / 100 : (rec.simklMal != null ? rec.simklMal / 10 : 0.6);
    const rankScore = 0.6 * trend + 0.4 * quality + (rec.isKids ? 0.15 : 0);
    const title = rec.titleAni || rec.titleSimkl || null;
    const year = rec.yearSimkl != null ? rec.yearSimkl : (rec.yearAni != null ? rec.yearAni : null);
    const genres = rec.genres;
    candidates.push({
      type: 'anime',
      tmdb_id: show.tv,
      imdb_id: show.imdb,
      title,
      year,
      poster: `https://images.metahub.space/poster/medium/${show.imdb}/img`,
      primary_genre: genres[0] || null,
      genres: genres.join(','),
      vote_average: rec.averageScore != null ? rec.averageScore / 10 : null,
      vote_count: null,
      popularity: rec.popularity != null ? rec.popularity : null,
      rankScore,
      reason: rec.isKids ? 'Popular with younger viewers' : 'Trending anime',
      algorithmVersion: 'marquee-anime-a1',
    });
  }

  // 6. Pool size: 4 × the profile's list size (no literal sizes). Sort by
  //    rankScore desc (ties: tv asc) and keep the top `target`.
  const target = 4 * deps.listSize(profile);
  candidates.sort((a, b) => (b.rankScore - a.rankScore) || (a.tmdb_id < b.tmdb_id ? -1 : a.tmdb_id > b.tmdb_id ? 1 : 0));
  const kept = candidates.slice(0, target);

  // Name each show from TMDB (its real show title, first-air year and poster), not the
  // per-season AniList/Simkl name. Best effort: a failed lookup keeps the source name.
  let metas = new Map();
  try { metas = await deps.tvMeta(ctx.tmdbKey, kept.map((c) => c.tmdb_id), log); }
  catch (err) { log.warn(`[marquee-anime] ${name}: TMDB naming failed (${err.message}) — keeping source names`); }
  for (const c of kept) {
    const m = metas.get(c.tmdb_id);
    if (!m) continue;
    if (m.title) c.title = m.title;
    if (m.year) c.year = m.year;
    if (m.poster) c.poster = m.poster;
  }

  // 7. Decision log: pool-cap (cut by the pool target) and engine (kept,
  //    final title after TMDB naming).
  if (sink) {
    const sourceOf = (rec) => {
      const sources = [];
      if (rec.simklPos != null) sources.push('simkl');
      if (rec.aniPos != null) sources.push('anilist');
      if (rec.kidsPos != null) sources.push('kids');
      return sources.join('+');
    };
    for (const c of candidates.slice(target)) {
      const rec = shows.get(c.tmdb_id);
      decisionRows.set(c.tmdb_id, {
        item_key: c.tmdb_id,
        title: c.title,
        stage: 'pool-cap',
        outcome: 'filtered',
        source: rec ? sourceOf(rec) : null,
        reason: `Below the pool cut-off (${target})`,
      });
    }
    for (const c of kept) {
      const rec = shows.get(c.tmdb_id);
      decisionRows.set(c.tmdb_id, {
        item_key: c.tmdb_id,
        title: c.title,
        year: c.year,
        poster: c.poster,
        imdb_id: c.imdb_id,
        mal_rating: rec ? rec.simklMal : null,
        stage: 'engine',
        outcome: 'selected',
        source: rec ? sourceOf(rec) : null,
        reason: c.reason,
        because: null,
      });
    }
    try {
      const buildId = sink.newBuildId();
      ctx.animeBuildId = buildId;
      sink.record(profile.id, 'anime', buildId, [...decisionRows.values()]);
      sink.prune(profile.id, 'anime');
    } catch (err) {
      log.warn(`[marquee-anime] ${name}: decision log failed (${err.message})`);
    }
  }

  // 8. Stats.
  ctx.stats = { seeds: 0, raw: simklItems.length + anilistItems.length + kidsItems.length, strong: shows.size, kept: kept.length };

  // 9. One line.
  const kidsLabel = kidsOn ? String(kidsItems.length) : 'off';
  const tierLabel = tier ? tier.label : 'none';
  log.log(`[marquee-anime] ${name}: trending — simkl ${simklItems.length}, anilist ${anilistItems.length}, kids ${kidsLabel} → ${shows.size} shows → pool ${kept.length} (tier ${tierLabel})`);

  return kept;
}

module.exports = { build, DEFAULT_DEPS };
