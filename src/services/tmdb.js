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
  // Anime is OUR pseudo-genre (Japanese-language animation), not a TMDB
  // genre — it maps to no TMDB ids here; exclusion is enforced in the
  // pipeline's raw filter on original_language + the Animation tag.
  // Excluding "Animation" still excludes ALL animation, anime included.
  Anime: { movie: [], tv: [] },
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
    _original_language: item.original_language || null,
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

// TMDB's "Animation" genre lumps Pixar-style family animation and Japanese
// anime into one bucket — a couple of family-animation watches would otherwise
// buy anime a seat in the distribution guard (and vice versa). Japanese-
// language animation is surfaced as its own pseudo-genre "Anime" everywhere
// genres are compared: taste distribution, candidate genres, primary-genre
// guard.
function effectiveGenres(names, originalLanguage) {
  if (originalLanguage !== 'ja' || !names.includes('Animation')) return names;
  return names.map((g) => (g === 'Animation' ? 'Anime' : g));
}

// Effective vote-count floor per media type. TMDB TV vote counts run roughly
// 5-10x lower than movies (a hit show peaks where a mid-tier movie starts), so
// a floor tuned for movies would starve the series pool — series use 1/5.
function voteFloor(filters, type) {
  const base = filters.vote_count_floor ?? (type === 'series' ? 100 : 200);
  return type === 'series' ? Math.round(base / 5) : base;
}

// Taste-seed enrichment: genres + one-line overview for a history item by TMDB
// id. Lets recent/unknown titles still steer ranking. Genres are effective
// genres (Japanese animation reported as "Anime").
async function detailsForSeed(apiKey, type, tmdbId) {
  const base = type === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  const data = await get(apiKey, base, { language: 'en-US' });
  const names = (data.genres || []).map((g) => g.name);
  return { genres: effectiveGenres(names, data.original_language), overview: data.overview || '' };
}

// Bulk raw candidates from TMDB Discover — NO per-item external_ids (cheap;
// enrichment happens later, only for survivors). vote_count / recency / genre
// are exact; the rating floor is applied loosely here for the imdb source (the
// precise IMDb gate runs after enrichment, since it needs the imdb id).
async function discoverRaw(apiKey, type, filters, { fromPage = 1, pages = 3 } = {}) {
  const endpoint = type === 'series' ? 'discover/tv' : 'discover/movie';
  const dateField = type === 'series' ? 'first_air_date' : 'primary_release_date';
  const params = {
    language: 'en-US',
    sort_by: 'popularity.desc',
    'vote_count.gte': voteFloor(filters, type),
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
  for (let page = fromPage; page < fromPage + pages; page++) {
    const data = await get(apiKey, endpoint, { ...params, page });
    for (const item of data.results || []) out.push(item);
    if (page >= (data.total_pages || 1)) break;
  }
  return out;
}

// Personalized raw candidates: /recommendations + /similar for each seed TMDB
// id (top history titles). Surfaces the long tail that filter-only Discover
// misses. Per-seed FAIRNESS: each seed's results are capped and the buckets
// are round-robin interleaved, so one outlier seed (e.g. a single anime in an
// otherwise drama-heavy history) cannot flood the personalized slice —
// downstream dedupe/caps keep first occurrences, making interleave order the
// fairness mechanism. Same item shape as discover.
const SEED_BUCKET_CAP = 16;

async function similarAndRecommended(apiKey, type, tmdbIds, log = console, page = 1) {
  const base = type === 'series' ? 'tv' : 'movie';
  const buckets = await Promise.all(tmdbIds.map(async (id) => {
    const bucket = [];
    await Promise.all(['recommendations', 'similar'].map(async (kind) => {
      try {
        const data = await get(apiKey, `${base}/${id}/${kind}`, { language: 'en-US', page });
        for (const item of data.results || []) bucket.push(item);
      } catch (err) {
        log.warn(`[tmdb] ${kind} for ${id} failed: ${err.message}`);
      }
    }));
    return bucket.slice(0, SEED_BUCKET_CAP);
  }));
  const out = [];
  for (let i = 0; buckets.some((b) => i < b.length); i++) {
    for (const b of buckets) if (i < b.length) out.push(b[i]);
  }
  return out;
}

// Full meta straight from a TMDB details call, for id-only sources like the
// Trakt watchlist: details + external_ids + images in ONE request. The
// details response carries everything toMeta needs (title, poster, overview,
// dates, votes) plus full genre objects, mapped back to genre_ids.
// Returns null when there's no IMDb id (Stremio needs tt ids).
async function metaByTmdbId(apiKey, type, tmdbId, log = console) {
  try {
    const base = type === 'series' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
    const data = await get(apiKey, base, {
      language: 'en-US',
      append_to_response: 'external_ids,images',
      include_image_language: 'en,null',
    });
    const imdbId = data.external_ids?.imdb_id;
    if (!imdbId) return null;
    const item = { ...data, genre_ids: (data.genres || []).map((g) => g.id) };
    return toMeta(item, type, imdbId, pickLogo(data.images?.logos));
  } catch (err) {
    log.warn(`[tmdb] metaByTmdbId ${type}/${tmdbId} failed: ${err.message}`);
    return null;
  }
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
  effectiveGenres,
  voteFloor,
  detailsForSeed,
  discoverRaw,
  similarAndRecommended,
  enrichCandidate,
  metaByTmdbId,
  pickLogo,
};
