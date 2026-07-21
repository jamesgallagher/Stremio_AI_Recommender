// TMDB: meta enrichment for id-based sources (posters, logos, descriptions)
// and the portal's genre vocabulary. v4: TMDB is no longer a recommendation
// source — Trakt recommends; TMDB dresses the survivors for Stremio.
const API = 'https://api.themoviedb.org/3';

// Portal genre vocabulary (checkbox names). Values are legacy TMDB alias
// mappings; only the KEYS matter now — exclusion is enforced on Trakt genre
// slugs in the rebuild pipeline (see rebuild.TRAKT_SLUGS). "Anime" is our
// pseudo-genre for Japanese animation.
const GENRE_ALIASES = {
  Action: {}, Adventure: {}, Anime: {}, Animation: {}, Comedy: {}, Crime: {},
  Documentary: {}, Drama: {}, Family: {}, Fantasy: {}, History: {}, Horror: {},
  Kids: {}, Music: {}, Mystery: {}, News: {}, Reality: {}, Romance: {},
  'Science Fiction': {}, Soap: {}, Talk: {}, Thriller: {}, 'TV Movie': {},
  War: {}, Western: {},
};

// Effective vote-count floor per media type, now measured in TRAKT votes
// (the v4 pool source). TV vote counts run well below movie counts on every
// platform, so series use 1/5 of the configured floor.
function voteFloor(filters, type) {
  const base = filters.vote_count_floor ?? (type === 'series' ? 100 : 200);
  return type === 'series' ? Math.round(base / 5) : base;
}

function authHeaders(apiKey) {
  // Support both v4 bearer tokens (long) and v3 api keys (short).
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
    logo, // transparent title logo for the logo-over-art treatment; null if none
    description: item.overview || '',
    releaseInfo: (type === 'series' ? item.first_air_date : item.release_date)?.substring(0, 4) || null,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : null,
    // internal fields; stripped by cleanMetas before serving
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

// Full meta straight from a TMDB details call, for id-based sources (Trakt
// recommendations, the Trakt watchlist): details + external_ids + images in
// ONE request. Returns null when there's no IMDb id (Stremio needs tt ids).
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

// Live title search -> full metas for the top results (search + one details
// call each). Used by the search catalogs — the only request-path external
// calls in the addon, so results are capped small.
async function searchTitles(apiKey, type, query, limit = 10, log = console) {
  const endpoint = type === 'series' ? 'search/tv' : 'search/movie';
  const data = await get(apiKey, endpoint, { query, language: 'en-US', include_adult: false });
  const items = (data.results || []).slice(0, limit);
  const metas = [];
  for (let i = 0; i < items.length; i += 5) {
    const chunk = items.slice(i, i + 5);
    metas.push(...await Promise.all(chunk.map((it) => metaByTmdbId(apiKey, type, it.id, log))));
  }
  return metas.filter(Boolean);
}

module.exports = {
  GENRE_ALIASES,
  voteFloor,
  toMeta,
  pickLogo,
  metaByTmdbId,
  searchTitles,
};
