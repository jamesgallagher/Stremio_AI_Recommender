// AGE-1: the age tier table.
//
// A profile's `filters.age_limit` (a number) selects a tier. ONLY `age_limit === 14`
// (TV-14) uses the new multi-source decision chain; every other value keeps today's
// legacy code path (judged at age+1 by the LLM). `tierFor` returns the tier object
// for a chain tier, a `{ mode: 'legacy', age }` stub for other positive limits, and
// `null` for an unlimited (adult) profile. `usesChain` is the single predicate every
// gate uses to decide whether to branch into the TV-14 path.
//
// PURE: no network, no DB, no Date.now().

// The TV-14 tier. `lists` are the normalised (upper-case, whitespace-free) rating
// strings James approved (D1/D7/D9): the allow list first, the block list second.
// `hardFloor` (D10) is the set of ratings that block whatever any other source says.
// `foreignMaxAge` drives the loose numeric fallback (foreign/age-only ratings:
// ≤ 14 allow, ≥ 15 block).
const TIERS = {
  14: {
    id: 'tv14',
    label: 'TV-14 (14+, AU M)',
    mode: 'chain',
    csmMaxAge: 14,
    lists: {
      series: {
        allow: ['TV-Y', 'TV-Y7', 'TV-Y7-FV', 'P', 'C', 'TV-G', 'TV-PG', 'G', 'PG', 'TV-14', 'M'],
        block: ['TV-MA', 'MA15+', 'AV15+', 'R', 'R18+', 'X18+', 'RC'],
      },
      movie: {
        allow: ['G', 'PG', 'PG-13', 'M'],
        block: ['MA15+', 'R', 'R18+', 'X18+', 'RC', 'NC-17'],
      },
    },
    hardFloor: { AU: ['R18+', 'X18+', 'RC'], US: ['NC-17'] },
    foreignMaxAge: 14,
    // D2: a one-time re-judge under the TV-14 wording. `cacheKey` scopes the LLM
    // verdict cache so TV-14 judgements never mix with the legacy age-14/15 caches.
    llm: {
      age: 14,
      cacheKey: 'tv14',
      wording: 'You are reviewing {kind} for a 14-year-old in Australia. The standard is US TV-14 / PG-13 / Australian M: suitable. Not suitable: anything at the level of TV-MA, MA 15+, R or R 18+ (strong violence, sex, nudity, drug use or coarse language beyond M). Err on the side of exclusion: if in doubt, mark it not OK.',
    },
  },
};

// Resolve the tier for a profile's filters. `null` = adult (no age limit). A
// positive limit that isn't a chain tier returns a legacy stub (the legacy path is
// unchanged; the stub carries the limit so the legacy code can keep judging at
// age+1 exactly as today).
function tierFor(filters) {
  const n = filters?.age_limit || 0;
  return TIERS[n] || (n > 0 ? { mode: 'legacy', age: n } : null);
}

// The single predicate every age gate uses to branch into the TV-14 chain.
function usesChain(filters) {
  return tierFor(filters)?.mode === 'chain';
}

module.exports = { TIERS, tierFor, usesChain };
