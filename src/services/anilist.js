// AniList fallback for anime adult signals when MAL/Tenrai is down (v6.26).
//
// Queried by the SAME MAL id (`idMal`) the anime map already hands us, so it
// slots in directly behind Tenrai with no new id mapping — see mal.ratings.
//
// WHAT ANILIST CAN AND CANNOT TELL US — do not confuse the two:
//   * isAdult / a Hentai|Erotica genre -> the terminal NSFW blacklist. Reliable,
//     and terminal for EVERY profile, so it is the signal worth rescuing.
//   * There is NO age-classification band. AniList has no equivalent of MAL's
//     G/PG/PG-13/R/R+/Rx, so a NON-adult AniList verdict carries minAge=null:
//     "not blocked, no age band" -> the title falls through to the LLM, exactly
//     as an unrated title does. AniList rescues the blacklist, not the age band.
const governor = require('./governor');

const API = 'https://graphql.anilist.co';
const ADULT_GENRES = /^(hentai|erotica)$/i;
// Minimal query — only the fields that feed a verdict. Adult flag + genres.
const QUERY = 'query($id:Int){Media(idMal:$id,type:ANIME){isAdult genres}}';
const REQUEST_TIMEOUT_MS = 10000;

const LIST_QUERY = `query($page:Int,$sort:[MediaSort],$tagIn:[String],$genreNotIn:[String],$tagNotIn:[String]){
  Page(page:$page, perPage:50){
    media(type:ANIME, isAdult:false, format_in:[TV,ONA,TV_SHORT], status_not_in:[NOT_YET_RELEASED],
          sort:$sort, tag_in:$tagIn, genre_not_in:$genreNotIn, tag_not_in:$tagNotIn){
      id idMal format genres averageScore popularity startDate{year} title{romaji english}
    }
  }
}`;
// AGE-3b: content evidence for the borderline review — adult flag, genres and
// the ranked content tags for a batch of AniList ids (id_in, perPage 50).
const TAGS_QUERY = `query($ids:[Int],$page:Int){ Page(page:$page, perPage:50){ media(id_in:$ids, type:ANIME){
  id isAdult genres tags{ name rank isMediaSpoiler } } } }`;
const LISTS = {
  trending: { sort: ['TRENDING_DESC'] },
  // Kid-friendly: popular, the AniList 'Kids' demographic tag; never these genres or content tags.
  kids: {
    sort: ['POPULARITY_DESC'],
    tagIn: ['Kids'],
    genreNotIn: ['Ecchi', 'Hentai', 'Horror', 'Psychological', 'Thriller'],
    tagNotIn: ['Nudity', 'Gore', 'Suicide', 'Torture'],
  },
};

const UNRATED = () => ({ code: null, minAge: null, adult: false, adultish: false });

// Map an AniList Media node into our verdict shape. Pure, for testability.
// Adult -> mirror MAL's Rx tier so downstream logging/handling is identical.
// Everything else -> unrated (minAge null), which means "LLM decides".
function parseMedia(media) {
  if (!media) return null;
  const genres = media.genres || [];
  const adult = media.isAdult === true || genres.some((g) => ADULT_GENRES.test(g));
  return adult
    ? { code: 'Rx', minAge: 99, adult: true, adultish: false }
    : UNRATED();
}

// Verdict for one MAL id via AniList, or throws. Same contract as
// mal.fetchRating so mal.ratings can treat the two interchangeably.
async function fetchRating(malId) {
  const res = await governor.schedule('anilist', () => fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: Number(malId) } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  if (res.status === 404) return UNRATED();
  if (!res.ok) {
    const err = new Error(`AniList idMal/${malId} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json().catch(() => null);
  const media = body?.data?.Media;
  if (media) return parseMedia(media);
  // AniList reports "not in the database" as a 200 with a 404 in errors[] and
  // a null Media. That is a definitive "no record", not a failure -> unrated.
  if ((body?.errors || []).some((e) => e?.status === 404)) return UNRATED();
  const err = new Error(`AniList idMal/${malId}: no Media in response`);
  throw err;
}

// AN-1b: one page of an AniList trending/kids list. Throws (with .status) on
// 429 or any non-OK status — no retry; the caller skips that source.
async function trendingAnime({ list, page }) {
  const spec = LISTS[list];
  if (!spec) throw new Error(`Unknown AniList list: ${list}`);
  const variables = { page, ...spec };
  const res = await governor.schedule('anilist', () => fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: LIST_QUERY, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  if (!res.ok) {
    const err = new Error(`AniList ${list} page ${page} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json().catch(() => null);
  return body?.data?.Page?.media || [];
}

// AGE-3b: content evidence for a batch of AniList ids. Returns
// Map<anilistId(number), { isAdult, genres, tags: [{ name, rank }] }>. Batches
// of 50 ids per request (id_in, perPage 50) through the 'anilist' governor lane
// with the same headers/timeout as trendingAnime. Drops tags with
// isMediaSpoiler === true; missing ids are absent. A non-OK status throws with
// `.status` (no retry — the caller treats it as "no evidence").
async function tagsFor(ids) {
  const unique = [...new Set(ids)];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const res = await governor.schedule('anilist', () => fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: TAGS_QUERY, variables: { ids: batch, page: 1 } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    if (!res.ok) {
      const err = new Error(`AniList tags batch ${Math.floor(i / 50) + 1} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json().catch(() => null);
    const media = body?.data?.Page?.media || [];
    for (const m of media) {
      const tags = (m.tags || [])
        .filter((t) => t.isMediaSpoiler !== true)
        .map((t) => ({ name: t.name, rank: t.rank }));
      out.set(m.id, { isAdult: m.isAdult === true, genres: m.genres || [], tags });
    }
  }
  return out;
}

// AN-2: community recommendations for a batch of seed AniList ids.
// Map<seedAnilistId(number), Rec[]> where Rec = { id, idMal, format, genres,
// averageScore, popularity, year, title, rating, isAdult }. Batches of 10 ids
// per request (AniList rejects larger nested pages). A seed AniList doesn't
// return is simply absent from the Map. Non-OK status throws with .status.
const RECS_QUERY = `query($ids:[Int],$page:Int){ Page(page:$page, perPage:10){ media(id_in:$ids, type:ANIME){
  id recommendations(sort:RATING_DESC, perPage:20){ nodes{ rating mediaRecommendation{
    id idMal format genres averageScore popularity isAdult startDate{year} title{romaji english} } } } } } }`;

async function recommendationsFor(anilistIds) {
  const unique = [...new Set(anilistIds)];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 10) {
    const batch = unique.slice(i, i + 10);
    const res = await governor.schedule('anilist', () => fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: RECS_QUERY, variables: { ids: batch, page: 1 } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    if (!res.ok) {
      const err = new Error(`AniList recommendations batch ${Math.floor(i / 10) + 1} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json().catch(() => null);
    const media = body?.data?.Page?.media || [];
    for (const m of media) {
      const recs = (m.recommendations?.nodes || [])
        .filter((n) => n.mediaRecommendation != null && n.mediaRecommendation.isAdult !== true && n.rating > 0)
        .map((n) => {
          const r = n.mediaRecommendation;
          return {
            id: r.id,
            idMal: r.idMal,
            format: r.format,
            genres: r.genres || [],
            averageScore: r.averageScore,
            popularity: r.popularity,
            year: r.startDate ? r.startDate.year : null,
            title: (r.title && (r.title.english || r.title.romaji)) || null,
            rating: n.rating,
            isAdult: r.isAdult === true,
          };
        });
      if (recs.length) out.set(m.id, recs);
    }
  }
  return out;
}

// AN-2: tag search — the media array (same node fields as trendingAnime).
// Reuses LIST_QUERY with POPULARITY_DESC sort and tagIn. `safe` adds the
// kid-friendly genre/tag exclusions. Non-OK status throws with .status.
async function tagSearch({ tags, page = 1, safe = false }) {
  const genreNotIn = safe
    ? ['Hentai', 'Ecchi', 'Horror', 'Psychological', 'Thriller']
    : ['Hentai'];
  const tagNotIn = safe ? ['Nudity', 'Gore', 'Suicide', 'Torture'] : [];
  const variables = { page, sort: ['POPULARITY_DESC'], tagIn: tags, genreNotIn, tagNotIn };
  const res = await governor.schedule('anilist', () => fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: LIST_QUERY, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  if (!res.ok) {
    const err = new Error(`AniList tag search page ${page} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json().catch(() => null);
  return body?.data?.Page?.media || [];
}

module.exports = { fetchRating, parseMedia, trendingAnime, tagsFor, recommendationsFor, tagSearch };
