// TMDB: candidate-pool generation (discover + recommendations/similar),
// per-candidate enrichment (external_ids -> IMDb tt id, + logo), taste-seed
// details, and the official genre vocabulary. Phase 1 (inverted pipeline):
// code builds the pool here; the LLM only ranks it. No title search/resolution.
const API = 'https://api.themoviedb.org/3';

const MOVIE_GENRES = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80,
  Documentary: 99, Drama: 18, Family: 10751, Fantasy: 14, History: 36,
  Horror: 27, Music: 10402, Mystery: 9648, Romance: 10749,
  'Science Fiction': 878, 'TV Movie': 10770, Thriller: 53, War: 10752, Western: 37,
};

const TV_GENRES = {
  'Action & Adventure': 10759, Animation: 16, Comedy: 35, Crime: 80,
  Documentary: 99, Drama: 18, Family: 10751, Kids: 10762, Mystery: 9648,
  News: 10763, Reality: 10764, 'Sci-Fi & Fantasy': 10765, Soap: 10766,
  Talk: 10767, 'War & Politics': 10768, Western: 37,
};

// Merged, de-duplicated list for the portal UI. Cross-type aliases let a single
// checkbox (e.g. "Action") also exclude the TV equivalent ("Action & Adventure").
const GENRE_ALIASES = {
  Action: { movie: ['Action'], tv: ['Action & Adventure'] },
  Adventure: { movie: ['Adventure'], tv: ['Action & Adventure'] },
  Animation: { movie: ['Animation'], tv: ['Animation'] },
  Comedy: { movie: ['Comedy'], tv: ['Comedy'] },
  Crime: { movie: ['Crime'], tv: ['Crime'] },
  Documentary: { movie: ['Documentary'], tv: ['Documentary'] },
  Drama: { movie: ['Drama'], tv: ['Drama'] },
  Family: { movie: ['Family'], tv: ['Family'] },
  Fantasy: { movie: ['Fantasy'], tv: ['Sci-Fi & Fantasy'] },
  History: { movie: ['History'], tv: [] },
  Horror: { movie: ['Horror'], tv: [] },
  Kids: { movie: [], tv: ['Kids'] },
  Music: { movie: ['Music'], tv: [] },
  Mystery: { movie: ['Mystery'], tv: ['Mystery'] },
  News: { movie: [], tv: ['News'] },
  Reality: { movie: [], tv: ['Reality'] },
  Romance: { movie: ['Romance'], tv: [] },
  'Science Fiction': { movie: ['Science Fiction'], tv: ['Sci-Fi & Fantasy'] },
  Soap: { movie: [], tv: ['Soap'] },
  Talk: { movie: [], tv: ['Talk'] },
  Thriller: { movie: ['Thriller'], tv: [] },
  'TV Movie': { movie: ['TV Movie'], tv: [] },
  War: { movie: ['War'], tv: ['War & Politics'] },
  Western: { movie: ['Western'], tv: ['Western'] },
};

function excludedGenreIds(excludedNames, type /* 'movie' | 'series' */) {
  const table = type === 'series' ? TV_GENRES : MOVIE_GENRES;
  const key = type === 'series' ? 'tv' : 'movie';
  const ids = new Set();
  for (const name of excludedNames) {
    const alias = GENRE_ALIASES[name];
    const mapped = alias ? alias[key] : [name];
    for (const g of mapped) {
      if (table[g] !== undefined) ids.add(table[g]);
    }
  }
  return ids;
}

// Reverse maps (genre id -> name) for turning TMDB genre_ids into names for the
// ranking prompt.
const MOVIE_GENRE_NAMES = Object.fromEntries(Object.entries(MOVIE_GENRES).map(([n, id]) => [id, n]));
const TV_GENRE_NAMES = Object.fromEntries(Object.entries(TV_GENRES).map(([n, id]) => [id, n]));
function genreNames(genreIds, type) {
  const rev = type === 'series' ? TV_GENRE_NAMES : MOVIE_GENRE_NAMES;
  return (genreIds || []).map((id) => rev[id]).filter(Boolean);
}

function authHeaders(apiKey) {
  // Support both v4 bearer tokens (long) and v3 api keys (short), like the reference.
  return apiKey.length > 50 ? { Authorization: `Bearer ${apiKey}` } : {};
}

function authParams(apiKey) {
  return apiKey.length > 50 ? {} : { api_key: apiKey };
}

async function get(apiKey, endpoint, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...authParams(apiKey), ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`TMDB ${endpoint} failed (${res.status})`);
  return res.json();
}

function toMeta(item, type, imdbId, logo = null) {
  return {
    id: imdbId,
    type,
    name: type === 'series' ? item.name : item.title,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
    logo, // transparent title logo (TMDB) for the logo-over-art treatment; null if none
    description: item.overview || '',
    releaseInfo: (type === 'series' ? item.first_air_date : item.release_date)?.substring(0, 4) || null,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : null,
    // internal fields for filtering; stripped before serving
    _tmdb_id: item.id,
    _genre_ids: item.genre_ids || [],
    _vote_average: item.vote_average || 0,
    _vote_count: item.vote_count || 0,
    _release_date: (type === 'series' ? item.first_air_date : item.release_date) || null,
  };
}

// Pick the best logo (transparent PNG) from a TMDB images.logos array —
// English first, then whatever's available. w500 is ample for overlays.
function pickLogo(logos) {
  if (!Array.isArray(logos) || !logos.length) return null;
  const chosen = logos.find((l) => l.iso_639_1 === 'en') || logos[0];
  return chosen.file_path ? `https://image.tmdb.org/t/p/w500${chosen.file_path}` : null;
}

// Fetch the IMDb id AND a logo in one details call via append_to_response,
// replacing what used to be a bare external_ids lookup — same request count,
// now with the logo. include_image_language keeps the images payload small.
async function fetchIdsAndLogo(apiKey, type, tmdbId) {
  const base = type === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  const data = await get(apiKey, base, {
    append_to_response: 'external_ids,images',
    include_image_language: 'en,null',
  });
  return { imdbId: data.external_ids?.imdb_id || null, logo: pickLogo(data.images?.logos) };
}

// Taste-seed enrichment: genres + one-line overview for a history item by TMDB
// id. Lets recent/unknown titles still steer ranking.
async function detailsForSeed(apiKey, type, tmdbId) {
  const base = type === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  const data = await get(apiKey, base, { language: 'en-US' });
  return { genres: (data.genres || []).map((g) => g.name), overview: data.overview || '' };
}

// Bulk raw candidates from TMDB Discover — NO per-item external_ids (cheap;
// enrichment happens later, only for survivors). vote_count / recency / genre
// are exact; the rating floor is applied loosely here for the imdb source (the
// precise IMDb gate runs after enrichment, since it needs the imdb id).
async function discoverRaw(apiKey, type, filters, { pages = 3 } = {}) {
  const endpoint = type === 'series' ? 'discover/tv' : 'discover/movie';
  const dateField = type === 'series' ? 'first_air_date' : 'primary_release_date';
  const params = {
    language: 'en-US',
    sort_by: 'popularity.desc',
    'vote_count.gte': filters.vote_count_floor ?? (type === 'series' ? 100 : 200),
    include_adult: false,
  };
  const tmdbFloor = (filters.rating_source || 'imdb') === 'imdb'
    ? Math.max(0, (filters.min_rating || 0) - 1.0) // TMDB audience scores run ~1 below IMDb
    : (filters.min_rating || 0);
  if (tmdbFloor > 0) params['vote_average.gte'] = tmdbFloor;
  if (filters.max_age_years > 0) {
    const from = new Date();
    from.setFullYear(from.getFullYear() - filters.max_age_years);
    params[`${dateField}.gte`] = from.toISOString().substring(0, 10);
  }
  const excludeIds = excludedGenreIds(filters.excluded_genres, type);
  if (excludeIds.size) params.without_genres = [...excludeIds].join(',');

  const out = [];
  for (let page = 1; page <= pages; page++) {
    const data = await get(apiKey, endpoint, { ...params, page });
    for (const item of data.results || []) out.push(item);
    if (page >= (data.total_pages || 1)) break;
  }
  return out;
}

// Personalized raw candidates: /recommendations + /similar for each seed TMDB
// id (top history titles). Surfaces the long tail that filter-only Discover
// misses. Same item shape as discover.
async function similarAndRecommended(apiKey, type, tmdbIds, log = console) {
  const base = type === 'series' ? 'tv' : 'movie';
  const out = [];
  await Promise.all(tmdbIds.flatMap((id) => ['recommendations', 'similar'].map(async (kind) => {
    try {
      const data = await get(apiKey, `${base}/${id}/${kind}`, { language: 'en-US', page: 1 });
      for (const item of data.results || []) out.push(item);
    } catch (err) {
      log.warn(`[tmdb] ${kind} for ${id} failed: ${err.message}`);
    }
  })));
  return out;
}

// Enrich a raw TMDB item into a full meta (external_ids -> tt id, + logo).
// Returns null when there's no IMDb id (Stremio needs tt ids).
async function enrichCandidate(apiKey, type, item, log = console) {
  try {
    const { imdbId, logo } = await fetchIdsAndLogo(apiKey, type, item.id);
    return imdbId ? toMeta(item, type, imdbId, logo) : null;
  } catch (err) {
    log.warn(`[tmdb] enrich ${item.id} failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  MOVIE_GENRES,
  TV_GENRES,
  GENRE_ALIASES,
  excludedGenreIds,
  genreNames,
  detailsForSeed,
  discoverRaw,
  similarAndRecommended,
  enrichCandidate,
  pickLogo,
};
