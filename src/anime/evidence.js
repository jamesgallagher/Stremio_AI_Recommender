// AGE-3b: content evidence for the anime borderline LLM review.
//
// For each allowed anime title, gather the content signals from the four
// sources (MAL band, Kitsu rating, AniList adult flag + genres + ranked
// content tags, AniDB restricted flag + content indicators) and compute the
// hard-floor reason and the LLM trigger. AniDB data is read from cache only
// (AGE-3c fills that cache in the background); a missing AniDB entry simply
// means the AniDB triggers don't fire.
const animeMap = require('../services/animeMap');
const mal = require('../services/mal');
const kitsu = require('../services/kitsu');
const anidb = require('../services/anidb');
const anilist = require('../services/anilist');

const DEFAULT_DEPS = { animeMap, mal, kitsu, anidb, anilist };

// The content tags that flag a title for the borderline review. Ecchi is an
// AniList *genre*, the rest are tags (see triggerFor).
const WATCH_TAGS = ['Nudity', 'Ecchi', 'Gore', 'Sexual Content', 'Suicide', 'Torture'];

// Tuning thresholds from env vars (no portal UI yet). Non-numeric → default.
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.floor(v) : def;
}

// { anidbWeight, anilistRank } — AniDB weights run 0–600, AniList ranks 0–100.
function config() {
  return {
    anidbWeight: intEnv('ANIME_REVIEW_ANIDB_WEIGHT', 300),
    anilistRank: intEnv('ANIME_REVIEW_ANILIST_RANK', 60),
  };
}

// De-duplicate a genre list (case-insensitive, order-preserving).
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const g of arr) {
    if (g == null) continue;
    const key = String(g).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

// Gather the content evidence for a batch of titles. Each title is
// { key, tmdb_id, imdb_id, title, year, genres: [string] }. Returns
// Map<key, evidence> where evidence is:
//   { mal: band|null, kitsu: {rating,guide}|null,
//     anilist: { isAdult, genres, tags:[{name,rank}] }|null,
//     anidb: { restricted, content: {sex,nudity,violence,gore} }|null,
//     genres: [...] }  // the title's own genres plus AniList's, de-duplicated
//
// Ids come from animeMap.lookup(imdb_id, tmdb_id) (ensureLoaded first). MAL is
// mal.cachedVerdict; Kitsu is kitsu.cached; AniDB is anidb.cachedAnime (cache
// only); AniList is ONE anilist.tagsFor call for all ids (a failure logs one
// warn line and leaves anilist: null for everyone; it never throws).
async function gather(titles, log = console, deps = DEFAULT_DEPS) {
  const { animeMap: am, mal: malMod, kitsu: kitsuMod, anidb: anidbMod, anilist: anilistMod } = deps;
  await am.ensureLoaded(log);

  const lookups = titles.map((t) => am.lookup(t.imdb_id, t.tmdb_id));

  // Kitsu: one cache-only call for all kitsu ids.
  const kitsuIds = lookups.map((l) => l?.kitsu).filter((x) => x != null);
  const kitsuMap = kitsuMod.cached(kitsuIds);

  // AniList: one tagsFor call for all anilist ids (failure → null for everyone).
  const anilistIds = lookups.map((l) => l?.anilist).filter((x) => x != null);
  let anilistMap = new Map();
  try {
    anilistMap = await anilistMod.tagsFor(anilistIds);
  } catch (err) {
    log.warn(`[anime] AniList tagsFor failed (${err.message}) — no AniList evidence`);
    anilistMap = new Map();
  }

  const out = new Map();
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    const lookup = lookups[i];
    const malId = lookup?.mal;
    const kitsuId = lookup?.kitsu;
    const anilistId = lookup?.anilist;
    const anidbId = lookup?.anidb;

    const malBand = malId != null ? malMod.cachedVerdict(malId) : null;
    const kitsuEv = kitsuId != null ? (kitsuMap.get(String(kitsuId)) || null) : null;
    const anilistEv = anilistId != null ? (anilistMap.get(anilistId) || null) : null;
    const anidbRaw = anidbId != null ? anidbMod.cachedAnime(anidbId) : null;
    const anidbEv = anidbRaw ? { restricted: anidbRaw.restricted, content: anidbRaw.content || {} } : null;

    const genres = dedupe([...(t.genres || []), ...((anilistEv && anilistEv.genres) || [])]);

    out.set(t.key, {
      mal: malBand,
      kitsu: kitsuEv,
      anilist: anilistEv,
      anidb: anidbEv,
      genres,
    });
  }
  return out;
}

// The effective rank of a watch tag for a title. Ecchi is an AniList genre
// (rank 100) or a tag; the others are tags only.
function tagRank(ev, name) {
  if (name === 'Ecchi' && ev.genres && ev.genres.some((g) => String(g).toLowerCase() === 'ecchi')) {
    return 100;
  }
  if (ev.anilist && ev.anilist.tags) {
    const t = ev.anilist.tags.find((x) => x.name === name);
    if (t) return t.rank;
  }
  return null;
}

// The hard-floor reason: a signal that blocks outright with no LLM.
// AniList isAdult, AniDB restricted, Kitsu R18. Otherwise null.
function floorReason(ev) {
  if (ev.anilist && ev.anilist.isAdult) {
    return { rating: 'anilist:isAdult', reason: 'AniList marks it adult' };
  }
  if (ev.anidb && ev.anidb.restricted) {
    return { rating: 'anidb:restricted', reason: 'AniDB marks it restricted (18+)' };
  }
  if (ev.kitsu && ev.kitsu.rating === 'R18') {
    return { rating: 'kitsu:R18', reason: 'Kitsu rates it R18' };
  }
  return null;
}

// The LLM trigger: a short string naming why a title is risky, or null.
// First match wins, in this order: mal-pg13, anidb:<field>, anilist:<tag>.
function triggerFor(ev, tier, cfg = config()) {
  // 1. MAL PG-13 — only at 14+ (at 10+/12+ a PG-13 was already blocked upstream).
  if (ev.mal && ev.mal.code === 'PG-13' && tier.malMaxAge >= 14) {
    return 'mal-pg13';
  }
  // 2. AniDB content indicators (weight >= anidbWeight).
  if (ev.anidb && ev.anidb.content) {
    for (const field of ['sex', 'nudity', 'violence', 'gore']) {
      const w = ev.anidb.content[field];
      if (w != null && w >= cfg.anidbWeight) return `anidb:${field}`;
    }
  }
  // 3. AniList watch tags (rank >= anilistRank). Ecchi is a genre (rank 100) or a tag.
  for (const name of WATCH_TAGS) {
    const rank = tagRank(ev, name);
    if (rank != null && rank >= cfg.anilistRank) return `anilist:${name}`;
  }
  return null;
}

module.exports = { gather, floorReason, triggerFor, config, WATCH_TAGS, DEFAULT_DEPS };
