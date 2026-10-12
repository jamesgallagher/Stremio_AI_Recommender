// TD-1 — Title detail: one server function behind two thin routes.
// Resolves a title's poster, synopsis, cast, age rating, genres, runtime.
// Caches the result per-title (shared across profiles, like store.saveMeta).
// Never throws; returns null on any failure.
const path = require('path');
const fs = require('fs');
const tmdb = require('./services/tmdb');
const anilist = require('./services/anilist');
const certs = require('./certs');
const settings = require('./settings');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DETAIL_DIR = path.join(DATA_DIR, 'cache', 'detail');
const TTL_7D = 7 * 24 * 3600e3;
const TTL_24H = 24 * 3600e3;

function detailFile(type, tmdbId) {
  return path.join(DETAIL_DIR, `detail-${type}-${String(tmdbId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function detailFileImdb(type, imdbId) {
  return path.join(DETAIL_DIR, `detail-imdb-${type}-${String(imdbId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function loadCache(type, tmdbId) {
  try {
    const rec = JSON.parse(fs.readFileSync(detailFile(type, tmdbId), 'utf8'));
    if (!rec?.at || Date.now() - rec.at > (rec.ttl || TTL_7D)) return null;
    return rec.detail;
  } catch {
    return null;
  }
}

function loadCacheImdb(type, imdbId) {
  try {
    const rec = JSON.parse(fs.readFileSync(detailFileImdb(type, imdbId), 'utf8'));
    if (!rec?.at || Date.now() - rec.at > (rec.ttl || TTL_7D)) return null;
    return rec.detail;
  } catch {
    return null;
  }
}

function saveCache(type, tmdbId, detail, ttlMs) {
  try {
    fs.mkdirSync(DETAIL_DIR, { recursive: true });
    const file = detailFile(type, tmdbId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), ttl: ttlMs, detail }, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* cache write failure is non-fatal */ }
}

function saveCacheImdb(type, imdbId, detail, ttlMs) {
  try {
    fs.mkdirSync(DETAIL_DIR, { recursive: true });
    const file = detailFileImdb(type, imdbId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), ttl: ttlMs, detail }, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* cache write failure is non-fatal */ }
}

// getTitleDetail(profile, {type, imdbId, tmdbId}, log, deps)
//   deps: { tmdbTitleDetail, anilistCharacters, animeLookup, now, cacheDir }
//   Defaults are the real functions. Returns the stable contract object or null.
async function getTitleDetail(profile, { type, imdbId = null, tmdbId = null } = {}, log = console, deps = {}) {
  const D = {
    tmdbTitleDetail: deps.tmdbTitleDetail || tmdb.titleDetail,
    anilistCharacters: deps.anilistCharacters || anilist.charactersFor,
    animeLookup: deps.animeLookup || require('./services/animeMap').lookup,
    now: deps.now || Date.now,
    cacheDir: deps.cacheDir || null,
  };

  // Validate type.
  if (type !== 'movie' && type !== 'series' && type !== 'anime') return null;
  const tmdbType = type === 'anime' ? 'series' : type;

  // Cache check: key by request type (movie/series/anime) so anime and series
  // with the same tmdb id never share a cache entry. Also check the imdb-keyed
  // cache for imdb-only requests.
  if (tmdbId != null && tmdbId !== '') {
    const cached = loadCache(type, tmdbId);
    if (cached) return cached;
  }
  if (imdbId) {
    const cachedImdb = loadCacheImdb(type, imdbId);
    if (cachedImdb) return cachedImdb;
  }

  const apiKey = settings.keyFor(profile, 'tmdb_api_key');
  if (!apiKey) return null; // no key and no cache

  // Fetch TMDB detail.
  let raw;
  try {
    raw = await D.tmdbTitleDetail(apiKey, tmdbType, { imdbId, tmdbId }, log);
  } catch {
    return null;
  }
  if (!raw) return null;

  // Anime: try AniList characters to replace TMDB cast.
  let cast = (raw.cast || []).slice(0, 8);
  let castSource = 'tmdb';
  if (type === 'anime' && D.animeLookup) {
    try {
      const lookup = D.animeLookup(imdbId, tmdbId);
      const anilistId = lookup?.anilist;
      if (anilistId) {
        const chars = await D.anilistCharacters(anilistId, log);
        if (chars && chars.length) {
          cast = chars;
          castSource = 'anilist';
        }
      }
    } catch { /* AniList failure keeps TMDB cast */ }
  }

  // Rating: pick AU if present, else US, else first non-empty of GB, IE, NZ, CA.
  const certCountries = ['AU', 'US', 'GB', 'IE', 'NZ', 'CA'];
  let rating = null;
  for (const cc of certCountries) {
    const rawCert = raw.certs?.[cc];
    if (rawCert) {
      const label = certs.normalizeCert(rawCert);
      if (label) {
        rating = { label, country: cc };
        break;
      }
    }
  }

  const result = {
    type,
    imdb_id: imdbId || null,
    tmdb_id: raw.tmdbId || null,
    title: raw.title,
    year: raw.year,
    poster: raw.poster,
    synopsis: raw.synopsis,
    runtime: raw.runtime,
    genres: raw.genres,
    rating,
    cast,
    castSource,
  };

  // Cache: 7 days default, 24h for returning/in-production series.
  // Key by request type (movie/series/anime) so anime and series with the
  // same tmdb id never share a cache entry.
  const ttl = /returning|in production/i.test(raw.status || '') ? TTL_24H : TTL_7D;
  if (raw.tmdbId) {
    saveCache(type, raw.tmdbId, result, ttl);
  }
  if (imdbId) {
    saveCacheImdb(type, imdbId, result, ttl);
  }

  return result;
}

module.exports = { getTitleDetail, detailFile, detailFileImdb, loadCache, loadCacheImdb, saveCache, saveCacheImdb };
