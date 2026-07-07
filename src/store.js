// Disk-backed JSON store with atomic writes (write temp file, then rename).
// Used for both profile config and per-profile recommendation caches.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
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
//   movie:  { metas: [], generated_at: ms, source: 'gemini'|'discover' },
//   series: { metas: [], generated_at: ms, source: ... },
//   last_attempt_at: ms   // last rebuild attempt (success or failure), for backoff
// }
function cacheFile(profileId) {
  return path.join(CACHE_DIR, `${profileId}.json`);
}

function loadCache(profileId) {
  return readJson(cacheFile(profileId), { movie: null, series: null, last_attempt_at: 0 });
}

// Atomic swap of a single catalog type. Old data for the other type is preserved.
// Never called on failure — a failed rebuild leaves the previous list untouched.
function swapCatalog(profileId, type, metas, source) {
  const cache = loadCache(profileId);
  cache[type] = { metas, generated_at: Date.now(), source };
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

// Drop newly-watched titles from a catalog without touching generated_at/
// source. Load-filter-write happens synchronously in one call, so a rebuild
// finishing mid-refresh can never be clobbered with a stale meta list.
// Returns the number of titles removed.
function pruneWatched(profileId, type, imdbIds) {
  const cache = loadCache(profileId);
  if (!cache[type]) return 0;
  const before = cache[type].metas.length;
  cache[type].metas = cache[type].metas.filter((m) => !imdbIds.has(m.id));
  const removed = before - cache[type].metas.length;
  if (removed > 0) writeJsonAtomic(cacheFile(profileId), cache);
  return removed;
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
  saveWatched,
  pruneWatched,
  markAttempt,
  deleteCache,
};
