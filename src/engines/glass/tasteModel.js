// Glass taste model v2 (GE-05, design §4.1) — the profile's taste, per type,
// across many dimensions, built from the watched history decayed over THREE
// horizons (recent "mood" / medium / long "established"). One watch list, decayed
// three ways, blended α·long + β·medium + γ·recent — so a current binge steers
// without overwriting long-term taste, the submitted spec's key insight, achieved
// with no schema change.
//
// Type-scoped by construction (design §9): seeds come only from
// getWatched(profileId, { type }). Reads the Glass metadata store (GE-03/04) for
// the deep dims (director/franchise/cast/keywords/decade/language/runtime); a
// not-yet-enriched title contributes only its thin watched-store genre (graceful
// degradation — the model just gets shallower, never wrong). PURE of network.
const metaStore = require('./metaStore');
const { halfLivesFor } = require('./config');
const { buildEventList } = require('./events');

const DAY_MS = 24 * 3600e3;

// Runtime band label for a minutes value, per type (a film "completes"; a show
// episode is short). Null when unknown.
function runtimeBand(minutes, type) {
  if (!minutes) return null;
  if (type === 'series') return minutes < 30 ? 's_short' : minutes <= 60 ? 's_mid' : 's_long';
  return minutes < 90 ? 'm_short' : minutes <= 150 ? 'm_mid' : 'm_long';
}

// Blended recency weight for one watched title across the three half-lives.
function blendedWeight(days, hl, blend) {
  const wl = 0.5 ** (days / hl.long);
  const wm = 0.5 ** (days / hl.medium);
  const wr = 0.5 ** (days / hl.recent);
  return blend.long * wl + blend.medium * wm + blend.recent * wr;
}

// Add `weight` to a name/id key in a dim accumulator object.
function bump(map, k, weight) {
  if (k == null || k === '') return;
  map[k] = (map[k] || 0) + weight;
}

// Normalize a dim accumulator to [-1, 1] by its MAX ABSOLUTE value, preserving
// sign — so the strongest-magnitude value in a dim → ±1 and a REJECTED value
// stays negative (GE-10). Identical to a plain max-normalize when every value is
// positive (the pre-feedback case). Returns a fresh object.
function normByMax(map) {
  const vals = Object.values(map);
  const max = vals.length ? Math.max(...vals.map((v) => Math.abs(v))) : 0;
  if (max <= 0) return {};
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = v / max;
  return out;
}

// Build the taste model for one (profile, type) from the WEIGHTED EVENT LIST
// (GE-10): watched titles (positive) + dont_recommend (negative) each contribute
// their SIGNED event weight × recency to every dim, so a rejected title's
// director/genre/franchise steer taste away from similar candidates. `cfg` is the
// resolved Glass config; `nowMs`/`events` injectable for tests. Returns dims as
// [-1,1] affinity objects plus the raw seed/weight totals (novelty + summaries).
function buildTasteModel(profileId, type, cfg, { nowMs = Date.now(), events } = {}) {
  const hl = halfLivesFor(cfg, type);
  const blend = cfg.horizon_blend;
  const evs = events || buildEventList(profileId, type, cfg, { nowMs });
  const metas = metaStore.getMany(type, evs.map((e) => e.tmdb_id));

  const acc = { genres: {}, keywords: {}, directors: {}, cast: {}, franchises: {}, decades: {}, languages: {}, runtimeBands: {} };
  // Raw genre mass for the novelty feature — how represented a genre is in what
  // the profile WATCHES. Positive (watched) events only: a rejection doesn't make
  // a genre "over-watched".
  const genreMass = {};
  let totalWeight = 0;
  let enrichedCount = 0;
  let seedCount = 0;

  for (const ev of evs) {
    if (ev.kind === 'watched') seedCount++;
    const days = Number.isNaN(ev.ts) ? 0 : Math.max(0, (nowMs - ev.ts) / DAY_MS);
    const weight = ev.weight * blendedWeight(days, hl, blend);   // SIGNED
    totalWeight += Math.abs(weight);
    const m = metas.get(ev.tmdb_id);
    if (m) {
      enrichedCount++;
      for (const g of m.genres || []) { bump(acc.genres, g, weight); if (weight > 0) bump(genreMass, g, weight); }
      for (const k of m.keywords || []) bump(acc.keywords, k, weight);
      for (const d of m.director || []) bump(acc.directors, d, weight);
      for (const c of m.cast || []) bump(acc.cast, c, weight);
      // Franchise: collection (movie) or networks (series proxy).
      if (m.collection?.id != null) bump(acc.franchises, `c:${m.collection.id}`, weight);
      for (const n of m.networks || []) bump(acc.franchises, `n:${n}`, weight);
      if (m.decade != null) bump(acc.decades, String(m.decade), weight);
      if (m.original_language) bump(acc.languages, m.original_language, weight);
      const band = runtimeBand(m.runtime, type);
      if (band) bump(acc.runtimeBands, band, weight);
    } else if (ev.fallback_genre) {
      // Thin fallback for a not-yet-enriched WATCHED title.
      bump(acc.genres, ev.fallback_genre, weight);
      if (weight > 0) bump(genreMass, ev.fallback_genre, weight);
    }
  }

  return {
    type,
    seedCount,
    enrichedCount,
    totalWeight,
    genreMass,   // raw (un-normalized) POSITIVE blended mass per genre → novelty
    dims: {
      genres: normByMax(acc.genres),
      keywords: normByMax(acc.keywords),
      directors: normByMax(acc.directors),
      cast: normByMax(acc.cast),
      franchises: normByMax(acc.franchises),
      decades: normByMax(acc.decades),
      languages: normByMax(acc.languages),
      runtimeBands: normByMax(acc.runtimeBands),
    },
  };
}

// The profile's top-N genres by affinity (for the trending genre filter, §4.2).
function topGenres(taste, n = 6) {
  return Object.entries(taste.dims.genres || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([g]) => g);
}

module.exports = { buildTasteModel, topGenres, runtimeBand, blendedWeight, normByMax };
