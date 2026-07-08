// MDBList (mdblist.com) — sole source for Common Sense Media age ratings.
// STRICT by design: kids/age-limited profiles only list titles that HAVE a
// Common Sense rating at or below the limit. No rating -> not listed. We do
// not fall back to MPAA/TMDB certifications or any other source.
const { USER_AGENT } = require('./trakt');
const store = require('../store');

const NOT_RATED = null;
const CSM_TTL_MS = 30 * 24 * 3600e3; // ratings are near-static; refresh monthly
const BATCH_SIZE = 50;

function parseCommonSenseAge(data) {
  // Field observed as `commonsense` (number, or string like "10+"); some
  // responses carry it in the ratings array instead. Both are CSM data.
  const direct = data?.commonsense;
  if (direct !== undefined && direct !== null && direct !== '') {
    const n = parseInt(String(direct), 10);
    if (!Number.isNaN(n)) return n;
  }
  const entry = (data?.ratings || []).find(
    (r) => r.source === 'commonsense' || r.source === 'common_sense' || r.source === 'commonsensemedia'
  );
  if (entry && entry.value !== undefined && entry.value !== null && entry.value !== '') {
    const n = parseInt(String(entry.value), 10);
    if (!Number.isNaN(n)) return n;
  }
  return NOT_RATED;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    const err = new Error(`MDBList request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Returns the Common Sense age (number) or null if CSM has not rated it.
// Throws on transport/auth errors so callers can distinguish "not rated"
// (drop the title) from "lookup broken" (fail the rebuild, keep old list).
async function commonSenseAge(apiKey, type, imdbId) {
  const mediaType = type === 'series' ? 'show' : 'movie';
  try {
    const data = await fetchJson(
      `https://api.mdblist.com/imdb/${mediaType}/${encodeURIComponent(imdbId)}?apikey=${encodeURIComponent(apiKey)}`
    );
    return parseCommonSenseAge(data);
  } catch (err) {
    if (err.status && err.status !== 404) throw err; // auth/rate-limit/etc.
    // 404 on the modern endpoint or older deployments: try the legacy API
    const data = await fetchJson(
      `https://mdblist.com/api/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbId)}`
    );
    return parseCommonSenseAge(data);
  }
}

// Look up many titles cheaply, in three tiers (kids-mode refills can gate
// hundreds of candidates per rebuild — free tier is 1000 req/day):
// 1. Disk cache (30-day TTL, unrated results cached too): repeat rebuilds of
//    mostly-unchanged lists cost near zero.
// 2. Batch media-info POST (one call per 50 misses). If the batch response
//    carries no Common Sense data at all across >= 5 titles, it is distrusted
//    (endpoint variant without CSM fields) rather than mass-dropping titles.
// 3. Per-title lookups for whatever is left. Transport/auth errors here still
//    abort — an unverifiable list must not be served (strict, fail-closed).
async function commonSenseAges(apiKey, type, imdbIds, log = console) {
  const results = new Map();
  const now = Date.now();
  const prefix = type === 'series' ? 'show' : 'movie';
  const cache = store.loadCsmCache();
  const misses = [];
  for (const id of imdbIds) {
    const entry = cache[`${prefix}:${id}`];
    if (entry && now - entry.at < CSM_TTL_MS) results.set(id, entry.age);
    else misses.push(id);
  }
  if (!misses.length) return results;

  const fetched = new Map();
  try {
    for (let i = 0; i < misses.length; i += BATCH_SIZE) {
      const chunk = misses.slice(i, i + BATCH_SIZE);
      const infoMap = await mediaInfoBatch(apiKey, type, chunk);
      for (const id of chunk) {
        const info = infoMap.get(id);
        if (info) fetched.set(id, parseCommonSenseAge(info));
      }
    }
    if (misses.length >= 5 && fetched.size && [...fetched.values()].every((v) => v === NOT_RATED)) {
      log.warn('[csm] batch response carried no Common Sense data — falling back to per-title lookups');
      fetched.clear();
    }
  } catch (err) {
    log.warn(`[csm] batch lookup failed (${err.message}) — falling back to per-title lookups`);
    fetched.clear();
  }

  const remaining = misses.filter((id) => !fetched.has(id));
  const queue = [...remaining];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        fetched.set(id, await commonSenseAge(apiKey, type, id));
      } catch (err) {
        log.error(`[mdblist] lookup ${id} failed: ${err.message}`);
        throw err; // abort — an unverifiable list must not be served
      }
    }
  });
  await Promise.all(workers);

  // Persist (reload first — another profile's gate may have written since),
  // dropping expired entries so the file stays bounded.
  const merged = store.loadCsmCache();
  for (const [key, entry] of Object.entries(merged)) {
    if (now - entry.at >= CSM_TTL_MS) delete merged[key];
  }
  for (const [id, age] of fetched) {
    merged[`${prefix}:${id}`] = { age, at: now };
    results.set(id, age);
  }
  store.saveCsmCache(merged);
  return results;
}

// ---- List catalogs (extra-catalog feature) ----
const API = 'https://api.mdblist.com';

// One page of a list's items for one media type. The API returns
// { movies: [], shows: [] }; items carry imdb_id/title/release_year and —
// with append_to_response — poster/description/ratings when available.
// Unknown sort values are retried without sort rather than failing the list.
async function listItemsPage(apiKey, user, slug, type, { limit = 50, offset = 0, sort } = {}) {
  const params = new URLSearchParams({
    apikey: apiKey,
    limit: String(limit),
    offset: String(offset),
    append_to_response: 'poster,description,ratings',
  });
  if (sort) {
    params.set('sort', sort);
    params.set('order', 'asc');
  }
  const url = `${API}/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/items?${params}`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    if (!sort) throw err;
    // sort vocabulary differs between site and API — fall back to list order
    params.delete('sort');
    params.delete('order');
    data = await fetchJson(`${API}/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/items?${params}`);
  }
  if (Array.isArray(data)) return data; // older deployments: flat array
  return data?.[type === 'series' ? 'shows' : 'movies'] || [];
}

// Batch media info (POST /imdb/{movie|show}) — fills in ratings/poster/
// description for items whose list entry didn't carry them. Returns a Map
// keyed by IMDb id.
async function mediaInfoBatch(apiKey, type, imdbIds) {
  if (!imdbIds.length) return new Map();
  const mediaType = type === 'series' ? 'show' : 'movie';
  const res = await fetch(`${API}/imdb/${mediaType}?apikey=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ ids: imdbIds }),
  });
  if (!res.ok) {
    const err = new Error(`MDBList batch lookup failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const arr = await res.json();
  const map = new Map();
  for (const m of Array.isArray(arr) ? arr : []) {
    const id = m?.ids?.imdb || m?.imdbid;
    if (id) map.set(id, m);
  }
  return map;
}

// IMDb rating from either a list item (append_to_response=ratings) or a
// media-info object. null = not rated / not present.
function parseImdbRating(item) {
  if (!item) return null;
  const entry = (item.ratings || []).find((r) => r.source === 'imdb');
  const v = entry?.value ?? item.imdbrating ?? item.imdb_rating;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function testKey(apiKey) {
  // A title guaranteed to exist; validates the key end-to-end.
  const age = await commonSenseAge(apiKey, 'movie', 'tt0111161');
  return { valid: true, sampleAge: age };
}

module.exports = {
  commonSenseAge,
  commonSenseAges,
  parseCommonSenseAge,
  listItemsPage,
  mediaInfoBatch,
  parseImdbRating,
  testKey,
};
