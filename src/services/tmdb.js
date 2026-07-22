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
    // Names as well as ids: the v5 'ai' engine filters excluded genres by the
    // portal's genre NAMES, and only a details call carries them.
    _genre_names: (item.genres || []).map((g) => g.name).filter(Boolean),
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

// Resolve an LLM-suggested title to a real TMDB entry — the step that turns a
// model's suggestion into something we can verify. A title that doesn't
// resolve is dropped, so hallucinated films never reach a catalog. The year
// disambiguates remakes; if it's wrong we retry without it rather than lose a
// real title to a bad year.
async function resolveTitle(apiKey, type, title, year, log = console) {
  const endpoint = type === 'series' ? 'search/tv' : 'search/movie';
  const base = { query: title, language: 'en-US', include_adult: false };
  const yearKey = type === 'series' ? 'first_air_date_year' : 'primary_release_year';
  try {
    let results = (await get(apiKey, endpoint, year ? { ...base, [yearKey]: year } : base)).results || [];
    if (!results.length && year) results = (await get(apiKey, endpoint, base)).results || [];
    if (!results.length) return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const want = norm(title);
    const exact = results.find((r) => norm(type === 'series' ? r.name : r.title) === want);
    return await metaByTmdbId(apiKey, type, (exact || results[0]).id, log);
  } catch (err) {
    log.warn(`[tmdb] resolve "${title}" failed: ${err.message}`);
    return null;
  }
}

// ---- Metadata service (v5) ----
// Full Stremio `meta` objects so a device can run THIS addon + a stream addon
// only — no third-party metadata addon answering search unfiltered next to our
// gated results.
const IMG = 'https://image.tmdb.org/t/p';
const META_TTL_STATIC_MS = 7 * 24 * 3600e3; // movies, ended series
const META_TTL_LIVE_MS = 24 * 3600e3;       // returning series (new episodes land)

// tt id -> TMDB id.
async function findByImdbId(apiKey, type, imdbId) {
  const data = await get(apiKey, `find/${imdbId}`, { external_source: 'imdb_id' });
  const arr = type === 'series' ? data.tv_results : data.movie_results;
  return arr?.[0]?.id || null;
}

// TMDB accepts up to 20 append_to_response items, so a show's ENTIRE season
// list usually arrives in one request ("season/1,season/2,…") — a 10-season
// show costs 1 call, not 11. >20 seasons chunks into ceil(n/20).
// (Strategy borrowed from cedya77/aiometadata's genSeasonsString.)
function seasonAppendGroups(seasonNumbers, size = 20) {
  const groups = [];
  for (let i = 0; i < seasonNumbers.length; i += size) {
    groups.push(seasonNumbers.slice(i, i + size).map((n) => `season/${n}`).join(','));
  }
  return groups;
}

// Flatten TMDB season payloads into Stremio's `videos` array — the thing that
// actually makes episodes playable. `available` marks whether an episode has
// aired, so unaired ones don't present as playable.
function buildVideos(seasonPayloads, imdbId, nowMs = Date.now()) {
  const videos = [];
  for (const payload of seasonPayloads) {
    for (const [key, season] of Object.entries(payload || {})) {
      if (!key.startsWith('season/') || !Array.isArray(season?.episodes)) continue;
      for (const ep of season.episodes) {
        if (!Number.isInteger(ep.season_number) || !Number.isInteger(ep.episode_number)) continue;
        const parsed = ep.air_date ? Date.parse(`${ep.air_date}T00:00:00Z`) : NaN;
        const ts = Number.isNaN(parsed) ? null : parsed;
        videos.push({
          id: `${imdbId}:${ep.season_number}:${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: ep.season_number,
          episode: ep.episode_number,
          released: ts ? new Date(ts).toISOString() : null,
          available: ts ? ts <= nowMs : false,
          overview: ep.overview || '',
          thumbnail: ep.still_path ? `${IMG}/w500${ep.still_path}` : null,
        });
      }
    }
  }
  return videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

const peopleNames = (list, limit) => (list || []).slice(0, limit).map((p) => p.name).filter(Boolean);
const crewNames = (crew, job) => (crew || []).filter((c) => c.job === job).map((c) => c.name);
const trailerStreams = (vids) => (vids?.results || [])
  .filter((v) => v.site === 'YouTube' && /trailer/i.test(v.type || ''))
  .slice(0, 3)
  .map((v) => ({ title: v.name, ytId: v.key }));

function commonMeta(d, type, imdbId) {
  const date = type === 'series' ? d.first_air_date : d.release_date;
  return {
    id: imdbId,
    type,
    name: type === 'series' ? d.name : d.title,
    poster: d.poster_path ? `${IMG}/w500${d.poster_path}` : null,
    background: d.backdrop_path ? `${IMG}/original${d.backdrop_path}` : null,
    logo: pickLogo(d.images?.logos),
    description: d.overview || '',
    releaseInfo: date ? date.substring(0, 4) : null,
    released: date ? new Date(`${date}T00:00:00Z`).toISOString() : null,
    imdbRating: d.vote_average ? d.vote_average.toFixed(1) : null,
    genres: (d.genres || []).map((g) => g.name),
    cast: peopleNames(d.credits?.cast, 10),
    country: d.production_countries?.[0]?.name || null,
    trailerStreams: trailerStreams(d.videos),
  };
}

// Full meta for a tt id. Returns { meta, ttlMs } or null when TMDB can't
// resolve it. One request for movies; for series, one for the show plus the
// batched season group(s).
async function fullMeta(apiKey, type, imdbId, log = console) {
  const tmdbId = await findByImdbId(apiKey, type, imdbId);
  if (!tmdbId) {
    log.warn(`[meta] TMDB has no ${type} for ${imdbId}`);
    return null;
  }
  if (type === 'movie') {
    const d = await get(apiKey, `movie/${tmdbId}`, {
      language: 'en-US',
      append_to_response: 'credits,external_ids,images,release_dates,videos',
      include_image_language: 'en,null',
    });
    return {
      meta: {
        ...commonMeta(d, 'movie', imdbId),
        director: crewNames(d.credits?.crew, 'Director'),
        writer: crewNames(d.credits?.crew, 'Writer'),
        runtime: d.runtime ? `${d.runtime} min` : null,
      },
      ttlMs: META_TTL_STATIC_MS,
    };
  }
  const d = await get(apiKey, `tv/${tmdbId}`, {
    language: 'en-US',
    append_to_response: 'credits,external_ids,images,content_ratings,videos',
    include_image_language: 'en,null',
  });
  const seasonNumbers = (d.seasons || []).map((s) => s.season_number).filter((n) => Number.isInteger(n));
  const payloads = await Promise.all(
    seasonAppendGroups(seasonNumbers).map((g) => get(apiKey, `tv/${tmdbId}`, { language: 'en-US', append_to_response: g })),
  );
  const returning = /returning|in production/i.test(d.status || '');
  return {
    meta: {
      ...commonMeta(d, 'series', imdbId),
      director: peopleNames(d.created_by, 5),
      writer: peopleNames(d.created_by, 5),
      runtime: d.episode_run_time?.[0] ? `${d.episode_run_time[0]} min` : null,
      videos: buildVideos(payloads, imdbId),
    },
    ttlMs: returning ? META_TTL_LIVE_MS : META_TTL_STATIC_MS,
  };
}

module.exports = {
  GENRE_ALIASES,
  voteFloor,
  toMeta,
  pickLogo,
  metaByTmdbId,
  searchTitles,
  resolveTitle,
  findByImdbId,
  seasonAppendGroups,
  buildVideos,
  fullMeta,
};
