// Glass watched-history enrichment (GE-04) — fills the Glass-owned metadata
// store (GE-03) with the deep dims (director / franchise / lead cast / keywords /
// decade) for the titles a profile has WATCHED, so the taste model (GE-05) has
// something to intersect candidates against. Without this the taste model has no
// director/franchise/actor affinities and Glass degrades to "trending filtered by
// genre + ratings" (design §5.3/§5.5) — it still works, just shallower.
//
// COST MODEL (design §5.5): one TMDB append call per watched title, cached
// PERMANENTLY (deep metadata is static). Steady state = one call per newly-
// watched title. The only real cost is a ONE-TIME backfill of an existing
// library, which is why this is governor-paced and CAPPED per run — a big
// library enriches over several builds/ticks rather than one long stall, exactly
// like watchedStore.enrichPending. Every call rides governor.schedule('tmdb')
// inside tmdb.deepMeta.
const watchedStore = require('../../watchedStore');
const metaStore = require('./metaStore');

const DEFAULT_CAP = 60;   // max NEW enrich calls per (profile, type) per run

// Watched titles of one type that Glass has NOT enriched yet, most-recent first
// (recent taste is enriched first — it drives the taste model hardest). PURE-ish:
// reads the watched store + the Glass meta cache, no network.
function pendingFor(profileId, type) {
  const watched = watchedStore.getWatched(profileId, { type }).filter((w) => w.tmdb_id);
  const cached = metaStore.getMany(type, watched.map((w) => w.tmdb_id));
  return watched.filter((w) => !cached.has(String(w.tmdb_id)));
}

// Enrich up to `cap` not-yet-cached watched titles of one type. Governor-paced
// (deepMeta is), capped, and idempotent — a title already cached is skipped, and
// a failed fetch is left for a later run (metaStore.enrich doesn't cache nulls).
// `fetcher` is injectable for tests. Returns { enriched, remaining, total }.
async function enrichWatchedBatch(profileId, type, apiKey, { cap = DEFAULT_CAP, fetcher, log = console, onProgress = () => {} } = {}) {
  if (!apiKey) return { enriched: 0, remaining: 0, total: 0, skipped: 'no TMDB key' };
  const pending = pendingFor(profileId, type);
  const batch = pending.slice(0, cap);
  let enriched = 0;
  for (let i = 0; i < batch.length; i += 8) {
    const chunk = batch.slice(i, i + 8);
    await Promise.all(chunk.map(async (w) => {
      const meta = await metaStore.enrich(apiKey, type, w.tmdb_id, log, fetcher ? { fetcher } : {});
      if (meta) enriched++;
    }));
    onProgress(Math.round(((i + chunk.length) / batch.length) * 100), `Enriching watch history (${type})…`);
  }
  return { enriched, remaining: pending.length - enriched, total: watchedStore.getWatched(profileId, { type }).filter((w) => w.tmdb_id).length };
}

// One-time / catch-up backfill of a profile's whole watched library across BOTH
// types. A job body (route through jobs.enqueue for progress). Each run enriches
// up to `cap` per type; call again (next tick/build) until `remaining` hits 0.
// Returns { movie, series } batch results.
async function backfillProfile(profile, apiKey, { cap = DEFAULT_CAP, fetcher, log = console, onProgress = () => {} } = {}) {
  const out = {};
  const spans = { movie: [0, 50], series: [50, 100] };
  for (const type of ['movie', 'series']) {
    const [lo, hi] = spans[type];
    out[type] = await enrichWatchedBatch(profile.id, type, apiKey, {
      cap, fetcher, log,
      onProgress: (pct, label) => onProgress(lo + (pct / 100) * (hi - lo), label),
    });
  }
  const remaining = (out.movie.remaining || 0) + (out.series.remaining || 0);
  log.log(`[glass] ${profile.name}: watched enrichment — movie +${out.movie.enriched}, series +${out.series.enriched} (${remaining} still pending)`);
  return { ...out, remaining };
}

module.exports = { pendingFor, enrichWatchedBatch, backfillProfile, DEFAULT_CAP };
