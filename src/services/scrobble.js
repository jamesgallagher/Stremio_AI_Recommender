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
const tmdb = require('./tmdb');
const settings = require('../settings');
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

// PURE (Part A, S1): read Simkl's own not_found answer. Simkl's /sync/history
// response carries `not_found: { movies: [{ ids: { imdb } }] }` — the films it
// could not match. A missing or malformed not_found means "everything matched"
// and never throws. Returns a Set<imdb>.
function notFoundImdb(resp) {
  const out = new Set();
  if (!resp || typeof resp !== 'object') return out;
  const movies = resp.not_found?.movies;
  if (!Array.isArray(movies)) return out;
  for (const m of movies) {
    const imdb = m?.ids?.imdb;
    if (typeof imdb === 'string' && imdb) out.add(imdb);
  }
  return out;
}

// PURE (Part A, S3): drop the movies whose imdb id is in the backoff set (the
// ones Simkl still couldn't match within the weekly window) — unless `full`,
// which re-pushes everything. Episodes are untouched. Returns the filtered
// items; the caller derives the skip count from the length difference.
function filterBackoff(items, backoffSet, full) {
  if (full || !backoffSet || !backoffSet.size) return items;
  return items.filter((it) => !(it.type === 'movie' && backoffSet.has(it.imdbId)));
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

  let items = await pullProviderWatched(cfg);
  const pulled = {
    movies: items.filter((i) => i.type === 'movie').length,
    series: items.filter((i) => i.type === 'series').length,
  };
  log.log(`[scrobble] ${profile.name}: pulled ${items.length} from ${cfg.provider} (${pulled.movies} movies, ${pulled.series} episodes)${full ? ' — FULL REBUILD' : ''}`);

  // Trainer T3.1 (R5): a film the user marked unwatched must not be re-added.
  // A provider movie whose imdb id is blocked AND whose provider watchedAtMs is
  // ≤ the block time (or missing) is dropped; a provider watch NEWER than the
  // block (a genuine rewatch) is pushed and its block entry is deleted. Applies
  // to `full` too. Episodes are unaffected.
  const blocks = watchedStore.unwatchedBlocks(profile.id, 'movie');
  if (blocks.size) {
    let skipped = 0;
    const filtered = items.filter((it) => {
      if (it.type !== 'movie' || !blocks.has(it.imdbId)) return true;
      if (it.watchedAtMs != null && it.watchedAtMs > blocks.get(it.imdbId)) {
        watchedStore.clearUnwatchedBlock(profile.id, 'movie', it.imdbId);
        return true;
      }
      skipped += 1;
      return false;
    });
    if (skipped) log.log(`[scrobble] ${profile.name}: ${skipped} movie(s) skipped (unwatched by the user)`);
    items = filtered;
  }

  // Part A (S3): a film Simkl still couldn't match (recorded from a prior run)
  // is skipped until 7 days after its last attempt, then tried once again.
  // `full` re-pushes everything (ignores the backoff) but still records/clears.
  const now = Date.now();
  const backoff = watchedStore.unmatchedBackoff(profile.id, now);
  const before = items.length;
  items = filterBackoff(items, backoff, full);
  const skippedBackoff = before - items.length;
  if (skippedBackoff) log.log(`[scrobble] ${profile.name}: ${skippedBackoff} movie(s) skipped (Simkl couldn't match — retrying weekly)`);

  // Normal sync excludes movies already known-watched on Simkl (from the local
  // watched store) and episodes this app already pushed (the scrobble ledger —
  // without it every hourly run re-sent the whole episode history). full=true
  // ignores both and pushes everything (Simkl de-dupes re-marks).
  const watchedMovieIds = full ? new Set() : watchedStore.watchedIdSets(profile.id).imdb;
  const pushedEpisodes = full ? new Set() : watchedStore.pushedEpisodeKeys(profile.id);
  const body = computeDelta(items, watchedMovieIds, pushedEpisodes);

  // Part A (S3): a recorded film that now appears in the local watched store
  // (a later Simkl sync found it) is cleared — independent of whether there's
  // a body this run (the film may be in backoff and skipped above, so the
  // early return must not bypass this).
  const watchedImdb = watchedStore.watchedIdSets(profile.id).imdb;
  {
    const clearIds = new Set();
    for (const r of watchedStore.listUnmatched(profile.id)) {
      if (watchedImdb.has(r.imdb_id)) clearIds.add(r.imdb_id);
    }
    if (clearIds.size) watchedStore.clearUnmatched(profile.id, [...clearIds]);
  }

  if (!body) {
    log.log(`[scrobble] ${profile.name}: nothing to scrobble (all ${items.length} watched items already on Simkl)`);
    return { pulled: items.length, pulledBreakdown: pulled, added: { movies: 0, episodes: 0 } };
  }
  const resp = await simkl.addToHistory(profile, body);
  // Only after Simkl accepted the write: remember the episodes so the next run
  // doesn't re-send them. A failed write throws above and records nothing.
  watchedStore.recordPushedEpisodes(profile.id, body);

  // Part A (S1/S2): read Simkl's own not_found answer, retry once with a TMDB
  // id (at most 10 lookups, one extra POST), and remember what still doesn't
  // match (S3). Episodes and shows are out of scope — untouched.
  const bodyImdb = new Set(body.movies.map((m) => m.ids.imdb));
  const nf = new Set([...notFoundImdb(resp)].filter((imdb) => bodyImdb.has(imdb)));
  const resolved = new Map(); // imdb -> tmdb (string)
  let stillNf = new Set(nf);
  let matchedOnRetry = 0;
  let retryBody = null;
  if (nf.size) {
    const tmdbKey = settings.keyFor(profile, 'tmdb_api_key');
    if (tmdbKey) {
      for (const imdb of nf) {
        if (resolved.size >= 10) break; // S2: max 10 lookups per run
        try {
          const tmdbId = await tmdb.findByImdbId(tmdbKey, 'movie', imdb);
          if (tmdbId != null) resolved.set(imdb, String(tmdbId));
        } catch { /* a lookup failure just means no retry for this film */ }
      }
    }
    if (resolved.size) {
      retryBody = { movies: [...resolved].map(([imdb, tmdb]) => ({ ids: { imdb, tmdb } })), shows: [] };
      let resp2 = null;
      try {
        resp2 = await simkl.addToHistory(profile, retryBody);
      } catch (err) {
        log.warn(`[scrobble] ${profile.name}: retry with TMDB id failed — ${err.message}`);
      }
      // stillNf = (nf - resolved) ∪ (notFoundImdb(resp2) ∩ resolved); a thrown
      // retry (resp2 null) treats every resolved film as still not found.
      const still = new Set();
      for (const imdb of nf) {
        if (!resolved.has(imdb)) still.add(imdb);
      }
      const nf2 = notFoundImdb(resp2);
      for (const imdb of resolved.keys()) {
        if (resp2 == null || nf2.has(imdb)) still.add(imdb);
        else matchedOnRetry += 1;
      }
      stillNf = still;
    }
  }
  for (const imdb of stillNf) {
    watchedStore.recordUnmatched(profile.id, { imdbId: imdb, tmdbId: resolved.get(imdb) || null }, now);
  }

  // Part A (S3): clear the films that matched this run (not in stillNf) —
  // from both the main body and the retry body. (Any recorded film found in
  // the local watched store was cleared before the early return above.)
  const clearIds = new Set();
  for (const m of body.movies) {
    const imdb = m.ids.imdb;
    if (imdb && !stillNf.has(imdb)) clearIds.add(imdb);
  }
  if (retryBody) {
    for (const m of retryBody.movies) {
      const imdb = m.ids.imdb;
      if (imdb && !stillNf.has(imdb)) clearIds.add(imdb);
    }
  }
  if (clearIds.size) watchedStore.clearUnmatched(profile.id, [...clearIds]);

  const added = {
    movies: body.movies.length,
    episodes: body.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0),
  };
  log.log(`[scrobble] ${profile.name}: added ${added.movies} movie(s) + ${added.episodes} episode(s) to Simkl from ${cfg.provider}${full ? ' (full rebuild)' : ''}`);
  if (nf.size) {
    log.log(`[scrobble] ${profile.name}: ${nf.size} movie(s) not matched by Simkl (${matchedOnRetry} matched on retry with TMDB id)`);
  }
  return { pulled: items.length, pulledBreakdown: pulled, added, unmatched: stillNf.size, matchedOnRetry };
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

// Marquee engagement: the provider's watch-PROGRESS rows (how far into each
// title the profile got), or null when the provider has no progress source.
// Nuvio only for now (Stremio's library carries state.timeOffset/duration and
// can be added the same way). Throws on provider/credential errors; the caller
// degrades.
async function pullProviderProgress(cfg) {
  if (!cfg?.enabled || !cfg.password_enc) return null;
  const provider = providerFor(cfg.provider);
  if (typeof provider.pullWatchProgress !== 'function') return null;
  const { email, password } = decodeCreds(cfg);
  return provider.pullWatchProgress({ email, password, profileIndex: cfg.nuvio_profile_index });
}

module.exports = { computeDelta, notFoundImdb, filterBackoff, syncProfile, ensureSynced, testCredentials, pullProviderWatched, pullProviderProgress };
