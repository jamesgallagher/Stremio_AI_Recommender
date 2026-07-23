// Anime id mapping, from Fribb's anime-lists (anime-list-full.json).
// Maps mal/anilist/kitsu/anidb/imdb/tmdb/tvdb ids for essentially every anime.
//
// Two jobs here:
//  1. Tell us whether a title IS anime. Presence in this map is a far better
//     detector than the old `original_language === 'ja' && Animation` guess,
//     which both over- and under-matched.
//  2. Give us the MAL id, which unlocks a real age classification (see mal.js).
//
// The published file is ~7.5 MB and serves an ETag, so the steady-state cost
// is ONE HEAD request per day. We never keep the raw file: it's reduced to a
// slim index at build time and only that is stored.
const store = require('../store');

const REMOTE_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const REFRESH_MS = 24 * 3600e3;
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';

let index = null;   // { at, etag, byImdb, byTmdb }
let inFlight = null;

// Fribb collapses multi-part franchises into ONE entry, so imdb_id and
// themoviedb_id are sometimes ARRAYS (Kizumonogatari Part 1/2/3). Every id has
// to be indexed — treating the scalar as canonical silently resolves the wrong
// part. themoviedb_id is also sometimes an object of { tv, movie }.
function toIdList(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== '');
}

function tmdbIdsOf(item) {
  const t = item.themoviedb_id;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    return [...toIdList(t.tv), ...toIdList(t.movie)];
  }
  return toIdList(t);
}

// Reduce each record to the four fields we use. Holding the parsed 7.5 MB
// resident buys nothing.
function buildIndex(list) {
  const byImdb = Object.create(null);
  const byTmdb = Object.create(null);
  let count = 0;
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.mal_id) continue;
    const rec = { mal: item.mal_id };
    if (item.kitsu_id) rec.kitsu = item.kitsu_id;
    if (item.anilist_id) rec.anilist = item.anilist_id;
    if (item.type) rec.type = item.type;
    count++;
    for (const id of toIdList(item.imdb_id)) {
      if (!byImdb[id]) byImdb[id] = rec;
    }
    for (const id of tmdbIdsOf(item)) {
      if (!byTmdb[id]) byTmdb[id] = rec;
    }
  }
  return { byImdb, byTmdb, count };
}

async function head(url) {
  return fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
}

// Refresh if stale. ETag-conditional: a matching ETag costs one HEAD and no
// download. Returns true when the index changed.
async function refresh(log = console, { force = false } = {}) {
  const cached = index || store.loadAnimeIndex();
  if (cached && !force && Date.now() - cached.at < REFRESH_MS) {
    index = cached;
    return false;
  }
  try {
    if (cached?.etag && !force) {
      const res = await head(REMOTE_URL);
      const etag = res.headers.get('etag');
      if (res.ok && etag && etag === cached.etag) {
        // Unchanged upstream — stamp it so we don't re-check for another day.
        index = { ...cached, at: Date.now() };
        store.saveAnimeIndex(index);
        log.log('[anime] id map unchanged upstream (ETag match)');
        return false;
      }
    }
    const res = await fetch(REMOTE_URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const etag = res.headers.get('etag') || '';
    const built = buildIndex(await res.json());
    index = { at: Date.now(), etag, byImdb: built.byImdb, byTmdb: built.byTmdb };
    store.saveAnimeIndex(index);
    log.log(`[anime] id map refreshed — ${built.count} anime indexed`);
    return true;
  } catch (err) {
    // Keep the last good index. With none, anime detection is simply off and
    // everything takes the LLM path — today's behaviour, never an open gate.
    if (cached) {
      index = cached;
      log.warn(`[anime] id map refresh failed (${err.message}) — using cached map`);
    } else {
      log.warn(`[anime] id map unavailable (${err.message}) — anime detection disabled this run`);
    }
    return false;
  }
}

// Idempotent, concurrency-safe load. Multiple profiles rebuilding at once must
// not each download the file.
async function ensureLoaded(log = console) {
  if (index && Date.now() - index.at < REFRESH_MS) return index;
  if (!inFlight) {
    inFlight = refresh(log).finally(() => { inFlight = null; });
  }
  await inFlight;
  return index;
}

// Returns { mal, kitsu, anilist, type } or null. Synchronous — call
// ensureLoaded() once per batch first.
function lookup(imdbId, tmdbId) {
  if (!index) return null;
  return (imdbId && index.byImdb[imdbId]) || (tmdbId && index.byTmdb[tmdbId]) || null;
}

const isAnime = (imdbId, tmdbId) => !!lookup(imdbId, tmdbId);

// Test seam
function _setIndex(i) { index = i; }

module.exports = { ensureLoaded, refresh, lookup, isAnime, buildIndex, toIdList, tmdbIdsOf, REMOTE_URL, _setIndex };
