// Auto-scrobble: mirror a profile's Nuvio/Stremio watched history into Simkl.
//
// Why this exists: the native apps only scrobble reliably while their own
// tracker session is healthy, and they swallow write failures silently — so
// watched items drift out of Simkl and leak back into recommendations. This
// server holds a per-profile Simkl token, so it reconciles the provider's
// watched state into Simkl on the hourly tick (v6: destination is Simkl, not
// Trakt).
//
// Discipline (matches the rebuild pipeline): per-profile, best-effort, and
// FAIL-CLOSED — any provider/Simkl error logs a warning and changes nothing.
// Isolation: creds are per profile; the delta is pushed only to THAT profile's
// own Simkl token. There is no shared path between profiles.
const crypto = require('./crypto');
const simkl = require('./simkl');
const watchedStore = require('../watchedStore');
const nuvio = require('./nuvio');
const stremio = require('./stremio');

const PROVIDERS = { nuvio, stremio };
const SYNC_INTERVAL_MS = 60 * 60e3; // hourly, aligned with the scheduler tick
const locks = new Set(); // profile ids currently scrobbling

function providerFor(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown scrobble provider "${name}"`);
  return p;
}

function epochMsToIso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

// Pure: given the provider's normalized watched items and the current watched
// state, return the { movies, shows } /sync/history body for what's missing
// (or null if nothing is missing). The body shape is shared by Trakt and Simkl.
// Exported for tests.
function computeDelta(items, watchedMovieIds, watchedEpisodeKeys) {
  const movies = [];
  const showMap = new Map(); // imdb -> Map(season -> [episodes])
  for (const it of items) {
    if (!it.imdbId) continue;
    if (it.type === 'movie') {
      if (watchedMovieIds.has(it.imdbId)) continue;
      movies.push({ ids: { imdb: it.imdbId }, ...(epochMsToIso(it.watchedAtMs) ? { watched_at: epochMsToIso(it.watchedAtMs) } : {}) });
    } else if (it.type === 'series' && it.season != null && it.episode != null) {
      if (watchedEpisodeKeys.has(`${it.imdbId}:${it.season}:${it.episode}`)) continue;
      if (!showMap.has(it.imdbId)) showMap.set(it.imdbId, new Map());
      const seasons = showMap.get(it.imdbId);
      if (!seasons.has(it.season)) seasons.set(it.season, []);
      seasons.get(it.season).push({ number: it.episode, ...(epochMsToIso(it.watchedAtMs) ? { watched_at: epochMsToIso(it.watchedAtMs) } : {}) });
    }
  }
  const shows = [...showMap].map(([imdb, seasons]) => ({
    ids: { imdb },
    seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })),
  }));
  if (!movies.length && !shows.length) return null;
  return { movies, shows };
}

function decodeCreds(cfg) {
  return { email: cfg.email, password: crypto.decrypt(cfg.password_enc) };
}

// Pull the provider's watched list for a configured profile (throws on any
// provider/credential error). Shared by the sync and the portal Test button.
async function pullProviderWatched(cfg) {
  const { email, password } = decodeCreds(cfg);
  return providerFor(cfg.provider).pullWatched({
    email, password, profileIndex: cfg.nuvio_profile_index,
  });
}

// One reconcile pass. Returns { pulled, added } or { skipped } / throws.
// full=true ignores what's already on Trakt and re-pushes the provider's
// ENTIRE watched list (Trakt de-dupes/re-marks; harmless). Doubles as a
// diagnostic — the logged pull breakdown shows whether series are pulled at all.
async function syncProfile(profile, log = console, { full = false } = {}) {
  const cfg = profile.scrobble;
  if (!cfg?.enabled) return { skipped: 'disabled' };
  if (!cfg.password_enc) return { skipped: 'no credentials' };
  if (!profile.simkl_auth?.access_token) return { skipped: 'simkl not connected' };

  const items = await pullProviderWatched(cfg);
  const pulled = {
    movies: items.filter((i) => i.type === 'movie').length,
    series: items.filter((i) => i.type === 'series').length,
  };
  log.log(`[scrobble] ${profile.name}: pulled ${items.length} from ${cfg.provider} (${pulled.movies} movies, ${pulled.series} episodes)${full ? ' — FULL REBUILD' : ''}`);

  // Normal sync excludes movies already known-watched on Simkl (from the local
  // watched store). Per-episode state isn't tracked locally, so episodes are
  // always pushed — Simkl de-dupes re-marks. full=true pushes everything.
  const watchedMovieIds = full ? new Set() : watchedStore.watchedIdSets(profile.id).imdb;
  const body = computeDelta(items, watchedMovieIds, new Set());
  if (!body) {
    log.log(`[scrobble] ${profile.name}: nothing to scrobble (all ${items.length} watched items already on Simkl)`);
    return { pulled: items.length, pulledBreakdown: pulled, added: { movies: 0, episodes: 0 } };
  }
  await simkl.addToHistory(profile, body);
  const added = {
    movies: body.movies.length,
    episodes: body.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0),
  };
  log.log(`[scrobble] ${profile.name}: added ${added.movies} movie(s) + ${added.episodes} episode(s) to Simkl from ${cfg.provider}${full ? ' (full rebuild)' : ''}`);
  return { pulled: items.length, pulledBreakdown: pulled, added };
}

// Fire-and-forget hourly reconcile (called from the scheduler tick). Guarded by
// a per-profile lock and cadence; never throws into the caller.
const lastSyncedAt = new Map();
function ensureSynced(profile, log = console) {
  const cfg = profile.scrobble;
  if (!cfg?.enabled || !cfg.password_enc || !profile.simkl_auth?.access_token) return false;
  if (locks.has(profile.id)) return false;
  if (Date.now() - (lastSyncedAt.get(profile.id) || 0) < SYNC_INTERVAL_MS) return false;
  locks.add(profile.id);
  lastSyncedAt.set(profile.id, Date.now());
  syncProfile(profile, log)
    .catch((err) => log.warn(`[scrobble] ${profile.name}: sync failed: ${err.message} — Trakt left unchanged`))
    .finally(() => locks.delete(profile.id));
  return true;
}

// ---- Portal helpers ----
// Validate credentials and (for Nuvio) return the selectable profile list.
// Accepts an explicit password (unsaved, from the Test button) or falls back to
// the stored encrypted one.
async function testCredentials({ provider, email, password, passwordEnc }) {
  const pw = password || (passwordEnc ? crypto.decrypt(passwordEnc) : '');
  if (!email || !pw) throw new Error('Email and password are required');
  if (provider === 'nuvio') {
    const profiles = await nuvio.listProfiles(email, pw);
    return { ok: true, provider, profiles };
  }
  if (provider === 'stremio') {
    const items = await stremio.pullWatched({ email, password: pw });
    return { ok: true, provider, watched_count: items.length };
  }
  throw new Error(`Unknown provider "${provider}"`);
}

module.exports = { computeDelta, syncProfile, ensureSynced, testCredentials, pullProviderWatched };
