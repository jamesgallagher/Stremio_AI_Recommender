// Disk-backed JSON store with atomic writes (write temp file, then rename).
// Used for both profile config and per-profile recommendation caches.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const META_DIR = path.join(CACHE_DIR, 'meta');

function ensureDirs() {
  fs.mkdirSync(META_DIR, { recursive: true }); // creates CACHE_DIR too
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDirs();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic on same filesystem
}

// ---- Profile config ----
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

function loadProfiles() {
  return readJson(PROFILES_FILE, { profiles: [] });
}

function saveProfiles(data) {
  writeJsonAtomic(PROFILES_FILE, data);
}

// ---- Per-profile recommendation cache ----
// Shape: {
//   movie:  { metas: [<displayed>], bench: [<reserve>], display_size, generated_at, source: 'llm'|'discover' },
//   series: { ... },
//   last_attempt_at: ms   // last rebuild attempt (success or failure), for backoff
// }
// `metas` is the DISPLAYED list the addon serves; `bench` is a hidden reserve
// that backfills `metas` when displayed items are watched (free, no rebuild).
const DEFAULT_DISPLAY_SIZE = 20;

function cacheFile(profileId) {
  return path.join(CACHE_DIR, `${profileId}.json`);
}

function loadCache(profileId) {
  return readJson(cacheFile(profileId), { movie: null, series: null, last_attempt_at: 0 });
}

// Atomic swap of a single catalog type (displayed + bench). Old data for the
// other type is preserved. Never called on failure — a failed rebuild leaves
// the previous list untouched.
function swapCatalog(profileId, type, metas, bench = [], source, displaySize = DEFAULT_DISPLAY_SIZE) {
  const cache = loadCache(profileId);
  cache[type] = { metas, bench, display_size: displaySize, generated_at: Date.now(), source };
  writeJsonAtomic(cacheFile(profileId), cache);
}

// Persist the watched-ID snapshot (per type) so the addon can prune watched
// titles at serve time without touching Trakt in the request path.
function saveWatched(profileId, type, sets) {
  const cache = loadCache(profileId);
  cache.watched = cache.watched || {};
  cache.watched[type] = { imdb: [...sets.imdbIds], tmdb: [...sets.tmdbIds] };
  cache.watched_synced_at = Date.now();
  writeJsonAtomic(cacheFile(profileId), cache);
}

// Drop newly-watched titles from a catalog's displayed list AND bench, then
// backfill the displayed list from the bench up to its display_size — free
// promote-on-watch, no LLM. Synchronous load-filter-write, so a rebuild
// finishing mid-refresh can't be clobbered. Returns how many displayed titles
// were removed (for logging).
function pruneWatched(profileId, type, imdbIds) {
  const cache = loadCache(profileId);
  const entry = cache[type];
  if (!entry) return 0;
  const displayBefore = entry.metas.length;
  const totalBefore = displayBefore + (entry.bench?.length || 0);
  entry.metas = entry.metas.filter((m) => !imdbIds.has(m.id));
  entry.bench = (entry.bench || []).filter((m) => !imdbIds.has(m.id));
  const removed = displayBefore - entry.metas.length;
  const target = entry.display_size || DEFAULT_DISPLAY_SIZE;
  while (entry.metas.length < target && entry.bench.length) entry.metas.push(entry.bench.shift());
  if (entry.metas.length + entry.bench.length !== totalBefore) writeJsonAtomic(cacheFile(profileId), cache);
  return removed;
}

// Extra (MDBList-backed) catalog cache, keyed by catalog id. Same atomic-swap
// discipline as the AI catalogs: only called on successful builds.
function swapExtra(profileId, catalogId, metas) {
  const cache = loadCache(profileId);
  cache.extras = cache.extras || {};
  cache.extras[catalogId] = { metas, generated_at: Date.now() };
  writeJsonAtomic(cacheFile(profileId), cache);
}

// Record the Trakt last_activities timestamps that the current watched
// snapshot corresponds to, so the hourly refresh can skip the full watched
// downloads when nothing changed. Also bumps watched_synced_at.
function saveWatchedActivity(profileId, activity) {
  const cache = loadCache(profileId);
  cache.watched_activity = activity;
  cache.watched_synced_at = Date.now();
  writeJsonAtomic(cacheFile(profileId), cache);
}

// Bump watched_synced_at without touching the snapshot (change detection
// said nothing was watched since last sync).
function touchWatchedSync(profileId) {
  const cache = loadCache(profileId);
  cache.watched_synced_at = Date.now();
  writeJsonAtomic(cacheFile(profileId), cache);
}

// ---- Global Common Sense rating cache ----
// CSM ages are facts about titles, not per-profile data, and they rarely
// change — shared across profiles so kids-mode refills don't re-hit MDBList
// for the same titles every day. Entries: { "movie:tt123": { age, at } }
// where age is a number or null (unrated — cached too; it's the repeat case).
const CSM_FILE = path.join(CACHE_DIR, 'csm-ratings.json');

function loadCsmCache() {
  return readJson(CSM_FILE, {});
}

function saveCsmCache(entries) {
  writeJsonAtomic(CSM_FILE, entries);
}

// ---- Meta cache (v5 metadata service) ----
// Meta is a fact about a title, not about a profile, so it's shared. One file
// PER TITLE rather than one big map: a series meta carries every episode, and
// rewriting a single multi-megabyte file on every cache miss would be both
// slow and a corruption risk. `meta` is called on every title open, so this
// cache is what keeps the endpoint viable.
const META_TTL_DEFAULT_MS = 7 * 24 * 3600e3;

function metaFile(type, id) {
  // ids come off the wire — keep them to a safe filename charset
  return path.join(META_DIR, `${type}-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function loadMeta(type, id) {
  const rec = readJson(metaFile(type, id), null);
  if (!rec?.at || Date.now() - rec.at > (rec.ttl || META_TTL_DEFAULT_MS)) return null;
  return rec.meta;
}

function saveMeta(type, id, meta, ttlMs) {
  writeJsonAtomic(metaFile(type, id), { at: Date.now(), ttl: ttlMs || META_TTL_DEFAULT_MS, meta });
}

function markAttempt(profileId) {
  const cache = loadCache(profileId);
  cache.last_attempt_at = Date.now();
  writeJsonAtomic(cacheFile(profileId), cache);
}

function deleteCache(profileId) {
  try { fs.unlinkSync(cacheFile(profileId)); } catch { /* ignore */ }
}

module.exports = {
  DATA_DIR,
  ensureDirs,
  loadProfiles,
  saveProfiles,
  loadCache,
  swapCatalog,
  swapExtra,
  saveWatched,
  pruneWatched,
  saveWatchedActivity,
  touchWatchedSync,
  loadCsmCache,
  saveCsmCache,
  loadMeta,
  saveMeta,
  markAttempt,
  deleteCache,
};
