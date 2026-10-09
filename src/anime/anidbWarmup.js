// AGE-3c: AniDB warm-up — drip-feed the cache so the borderline review has AniDB data.
// Each hourly tick, for profiles with Marquee Anime on, look up a few uncached
// AniDB entries for that profile's anime pool, slowly, inside AniDB's rules.
// Builds never wait on AniDB.
const anidb = require('../services/anidb');
const animeMap = require('../services/animeMap');
const recommendationStore = require('../recommendationStore');
const settings = require('../settings');

const WARM_PER_TICK = 10;   // network lookups per profile per hourly tick (≈ 45 s at 4 s spacing)
const WARM_DAILY_MAX = 100; // never let warm-up push a client past this many requests today
                            // (the 150/day cap keeps 50 spare for the Test button and retries)

const DEFAULT_DEPS = {
  anidb,
  animeMap,
  getPool: (profileId) => recommendationStore.getRecommended(profileId, { type: 'anime', limit: 500 }),
  settings,
};

async function warmUp(profile, { log = console, deps = DEFAULT_DEPS } = {}) {
  const { anidb: anidbMod, animeMap: am, getPool, settings: settingsMod } = deps;
  const result = { fetched: 0, cached: 0, pending: 0, stopped: null };
  try {
    // 1. Engine off
    if (!profile.filters?.engine_anime || profile.filters.engine_anime === 'off') {
      return { ...result, stopped: 'engine-off' };
    }

    // 2. No client
    const client = settingsMod.resolveAnidbClient(profile);
    if (client.source === 'none') {
      return { ...result, stopped: 'no-client' };
    }

    // 3. Load animeMap and build candidates from the pool
    await am.ensureLoaded(log);
    const pool = getPool(profile.id);
    const seen = new Set();
    const candidates = [];
    for (const row of pool) {
      const lookup = am.lookup(row.imdb_id, row.tmdb_id);
      const aid = lookup?.anidb;
      if (aid != null && !seen.has(aid)) {
        seen.add(aid);
        candidates.push(aid);
      }
    }

    if (candidates.length === 0) {
      return result; // nothing to do, log nothing
    }

    // 4. Split into cached and pending
    const pendingAids = [];
    for (const aid of candidates) {
      if (anidbMod.cachedAnime(aid)) {
        result.cached++;
      } else {
        pendingAids.push(aid);
      }
    }
    result.pending = pendingAids.length;

    // 5. Budget
    const st = anidbMod.clientStatus(profile);
    if (st.banned_until && st.banned_until > Date.now()) {
      return { ...result, stopped: 'banned' };
    }
    const headroom = WARM_DAILY_MAX - st.today;
    if (headroom <= 0) {
      return { ...result, stopped: 'daily-limit' };
    }
    let budget = Math.min(WARM_PER_TICK, headroom);

    // 6. Walk pending in order, one at a time
    let consecutiveErrors = 0;
    for (const aid of pendingAids) {
      if (budget <= 0) break;
      const r = await anidbMod.getAnime(aid, profile, log);
      if (r.cached) {
        result.cached++;
        result.pending--;
        consecutiveErrors = 0;
      } else if (r.data) {
        result.fetched++;
        result.pending--;
        budget--;
        consecutiveErrors = 0;
      } else if (r.skipped === 'repeat') {
        // tried within 24h — leave pending, no budget used
      } else if (r.error) {
        budget--;
        // A rejected client name will fail every time: stop now, do not hammer AniDB
        // with a bad client every tick. Three failures in a row mean AniDB is down
        // or unhappy: stop and try again next tick.
        if (r.error === 'client') { result.stopped = 'client'; break; }
        if (++consecutiveErrors >= 3) { result.stopped = 'errors'; break; }
        // otherwise a single failed lookup — leave pending, continue
      } else if (r.skipped) {
        result.stopped = r.skipped;
        break;
      }
    }

    // 7. Log one line
    const stAfter = anidbMod.clientStatus(profile);
    let line = `[anidb] warm-up ${profile.name}: ${result.fetched} fetched, ${result.cached} cached, ${result.pending} pending, today ${stAfter.today}/${stAfter.cap}`;
    if (result.stopped) line += ` — stopped: ${result.stopped}`;
    log.log(line);
  } catch (err) {
    log.warn(`[anidb] warm-up ${profile.name} failed (${err.message})`);
    return { fetched: 0, cached: 0, pending: 0, stopped: 'error' };
  }
  return result;
}

module.exports = { warmUp, WARM_PER_TICK, WARM_DAILY_MAX, DEFAULT_DEPS };
