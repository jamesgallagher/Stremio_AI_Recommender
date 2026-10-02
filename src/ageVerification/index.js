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
async function verify(titles, type, tier, sources, log = console) {
  const result = await chain.decide(titles, type, tier, sources, log);
  for (const [key, v] of result) {
    const tmdbId = key.split(':')[1];
    verdictStore.recordVerdict(type, tmdbId, v.verdict, v.source, v.rating);
  }
  return result;
}

// Serve-time re-check (TV-14 only): reads the stored verdict without network.
// A block verdict is rejected; an allow verdict is kept; an unknown/absent
// verdict is kept (fail-open — the title was never judged, so it stays until a
// build judges it). Returns true if the title is kept.
function passesStored(type, tmdbId, now = Date.now()) {
  const v = verdictStore.getVerdict(type, tmdbId, now);
  if (!v) return true; // unknown/absent → kept (fail-open)
  return v.verdict === 'allow';
}

module.exports = { tierFor, usesChain, verify, passesStored };
