// TMDB: title resolution (Gemini suggestions -> canonical IDs + IMDb tt IDs),
// cold-start discover path, and the official genre vocabulary.
// Resolution fallback logic adapted from the reference addon:
// search with year -> retry without year -> external_ids for imdb_id -> drop if absent.
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

function toMeta(item, type, imdbId) {
  return {
    id: imdbId,
    type,
    name: type === 'series' ? item.name : item.title,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
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

// Resolve a Gemini suggestion to a canonical TMDB item + IMDb tt ID.
// Returns meta or null (unresolvable suggestions are dropped).
async function resolveTitle(apiKey, type, title, year, log = console) {
  const endpoint = type === 'series' ? 'search/tv' : 'search/movie';
  const yearParam = type === 'series' ? 'first_air_date_year' : 'year';
  try {
    let data = await get(apiKey, endpoint, {
      query: title, language: 'en-US',
      ...(year ? { [yearParam]: year } : {}),
    });
    // Gemini sometimes reports the wrong year (season vs. premiere) — retry without it
    if (!data.results?.length && year) {
      data = await get(apiKey, endpoint, { query: title, language: 'en-US' });
    }
    const item = data.results?.[0];
    if (!item) {
      log.warn(`[tmdb] no match for "${title}" (${year ?? '?'}) — dropped`);
      return null;
    }
    const extEndpoint = type === 'series' ? `tv/${item.id}/external_ids` : `movie/${item.id}/external_ids`;
    const ext = await get(apiKey, extEndpoint);
    if (!ext.imdb_id) {
      log.warn(`[tmdb] no imdb_id for "${title}" — dropped (Stremio needs tt IDs)`);
      return null;
    }
    return toMeta(item, type, ext.imdb_id);
  } catch (err) {
    log.warn(`[tmdb] resolve "${title}" error: ${err.message}`);
    return null;
  }
}

// Cold-start path: no Gemini, just TMDB discover driven by the same profile
// filters. One page per call — the rebuild pipeline walks pages until its
// quota is filled (post-filtering can discard many results per page).
async function discoverPage(apiKey, type, filters, page = 1, log = console, excludeTmdbIds = new Set()) {
  const endpoint = type === 'series' ? 'discover/tv' : 'discover/movie';
  const dateField = type === 'series' ? 'first_air_date' : 'primary_release_date';
  const params = {
    language: 'en-US',
    sort_by: 'popularity.desc',
    'vote_average.gte': filters.min_rating || 0,
    'vote_count.gte': type === 'series' ? 100 : 200, // avoid obscure high-rated titles
    include_adult: false,
    page,
  };
  if (filters.max_age_years > 0) {
    const from = new Date();
    from.setFullYear(from.getFullYear() - filters.max_age_years);
    params[`${dateField}.gte`] = from.toISOString().substring(0, 10);
  }
  const excludeIds = excludedGenreIds(filters.excluded_genres, type);
  if (excludeIds.size) params.without_genres = [...excludeIds].join(',');

  const data = await get(apiKey, endpoint, params);
  if (page > (data.total_pages || 1)) return [];
  // Skip known-watched titles by TMDB id BEFORE the per-item external_ids
  // call (the main source of wasted lookups), then resolve the survivors in
  // parallel — a page is at most 20 items.
  const candidates = (data.results || []).filter((item) => !excludeTmdbIds.has(item.id));
  const metas = await Promise.all(candidates.map(async (item) => {
    const extEndpoint = type === 'series' ? `tv/${item.id}/external_ids` : `movie/${item.id}/external_ids`;
    try {
      const ext = await get(apiKey, extEndpoint);
      return ext.imdb_id ? toMeta(item, type, ext.imdb_id) : null;
    } catch (err) {
      log.warn(`[tmdb] discover external_ids error: ${err.message}`);
      return null;
    }
  }));
  return metas.filter(Boolean);
}

module.exports = {
  MOVIE_GENRES,
  TV_GENRES,
  GENRE_ALIASES,
  excludedGenreIds,
  resolveTitle,
  discoverPage,
};
