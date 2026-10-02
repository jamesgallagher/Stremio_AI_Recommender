// AGE-1: the TV-14 age verification service (the public API).
//
// `verify` runs the decision chain over a batch of titles and records every
// definitive verdict in the `age_verdicts` table (mandate A7). `passesStored`
// is the serve-time re-check: it reads the stored verdict without network.
//
// `tierFor` / `usesChain` are re-exported so the gates have ONE import for the
// whole service.
const { tierFor, usesChain } = require('./tiers');
const chain = require('./chain');
const verdictStore = require('./store');

// Run the chain over `titles` (the chain's shape: { key: `${type}:${tmdbId}`,
// imdb_id, adult, title, year, genres, certification }) and record every
// definitive verdict in the `age_verdicts` table. Returns the chain's result
// (Map<key, { verdict, source, rating }>). An "unknown" verdict (the LLM
// omitted the title) is NOT recorded (A5: it stays kept and is re-judged next
// time).
//
// Cache-first (F3): a fresh stored verdict (within its TTL, for THIS tier) is
// answered from the store without any source call; only the misses go to the
// chain. The new definitive verdicts are recorded, and the merged Map is
// returned. A title whose verdict expired (past its TTL) is a miss again.
async function verify(titles, type, tier, sources, log = console) {
  const now = Date.now();
  const tmdbIds = titles.map((t) => t.key.split(':')[1]);
  // (1) fresh stored verdicts for this tier (TTL-aware; expired = absent).
  const cached = verdictStore.getVerdicts(type, tier.id, tmdbIds, now);
  const result = new Map();
  const misses = [];
  for (const t of titles) {
    const v = cached.get(t.key.split(':')[1]);
    if (v) {
      // (2) answered from cache (source/rating as stored).
      result.set(t.key, { verdict: v.verdict, source: v.source, rating: v.rating });
    } else {
      misses.push(t);
    }
  }
  // (3) only the misses go to the chain.
  if (misses.length) {
    const decided = await chain.decide(misses, type, tier, sources, log);
    for (const [key, v] of decided) {
      result.set(key, v);
      // (4) record the new definitive verdicts (unknown is never stored, A5).
      if (v.verdict === 'allow' || v.verdict === 'block') {
        verdictStore.recordVerdict(type, key.split(':')[1], tier.id, v.verdict, v.source, v.rating);
      }
    }
  }
  // (5) the merged Map (cache + newly decided).
  return result;
}

// Serve-time re-check (TV-14 only): reads the stored verdict without network.
// A block verdict is rejected; an allow verdict is kept; an unknown/absent
// verdict is kept (fail-open — the title was never judged, so it stays until a
// build judges it). `tierId` is the tier's id (e.g. 'tv14') — the verdict is
// read for that tier only. Returns true if the title is kept.
function passesStored(type, tmdbId, tierId, now = Date.now()) {
  const v = verdictStore.getVerdict(type, tmdbId, tierId, now);
  if (!v) return true; // unknown/absent → kept (fail-open)
  return v.verdict === 'allow';
}

module.exports = { tierFor, usesChain, verify, passesStored };
