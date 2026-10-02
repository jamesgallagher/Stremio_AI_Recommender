// AGE-1/AGE-2: the age tier table.
//
// A profile's `filters.age_limit` (a number) selects a tier. After AGE-2 every
// positive limit is a chain tier: 10+, 12+, TV-14 (14+) and 15+. `tierFor`
// rounds the limit down to a tier (1–11 → 10, 12–13 → 12, 14 → 14, 15+ → 15)
// and returns that tier object, or `null` for an unlimited (adult) profile
// (`age_limit === 0`). `usesChain` is the single predicate every gate uses to
// decide whether to branch into the chain.
//
// PURE: no network, no DB, no Date.now().

// Shared allow lists (mandate B1: use constants, not copies). Normalised
// (upper case, whitespace-free) rating strings.
const KIDS_SERIES_ALLOW = ['TV-Y', 'TV-Y7', 'TV-Y7-FV', 'P', 'C', 'TV-G', 'G', 'TV-PG', 'PG'];
const KIDS_FILM_ALLOW = ['G', 'PG'];

// `lists` are the per-type allow/block lists (mandate B1, normalised).
// `hardFloor` is the set of ratings that block whatever any other source says.
// `foreignMaxAge` drives the age-based foreign table (ratings.js §2.2).
// `discoverCeilingAU` is TMDB's spelling (with the space) of the highest AU
// rating NOT on the tier's hard floor (Common Sense may still allow below it).
// `malMaxAge` is the MAL anime band's max age for this tier.
const TIERS = {
  10: {
    id: 'age10',
    label: '10+ (TV-PG / PG)',
    mode: 'chain',
    csmMaxAge: 10,
    foreignMaxAge: 10,
    lists: {
      series: { allow: KIDS_SERIES_ALLOW, block: ['TV-14', 'M', 'TV-MA', 'MA15+', 'AV15+', 'R', 'R18+', 'X18+', 'RC'] },
      movie: { allow: KIDS_FILM_ALLOW, block: ['PG-13', 'M', 'MA15+', 'R', 'R18+', 'X18+', 'RC', 'NC-17'] },
    },
    hardFloor: { AU: ['MA15+', 'AV15+', 'R18+', 'X18+', 'RC'], US: ['TV-MA', 'R', 'NC-17'] },
    discoverCeilingAU: 'M',
    malMaxAge: 10,
    llm: {
      age: 10,
      cacheKey: 'age10',
      wording: 'You are reviewing {kind} for a 10-year-old in Australia. The standard is US TV-PG / PG / Australian PG: suitable. Not suitable: anything at the level of TV-14, PG-13, M or above (violence, frightening scenes, sexual content, drug use or coarse language beyond PG). Err on the side of exclusion: if in doubt, mark it not OK.',
    },
  },
  12: {
    id: 'age12',
    label: '12+ (PG, UK 12)',
    mode: 'chain',
    csmMaxAge: 12,
    foreignMaxAge: 12,
    lists: {
      series: { allow: KIDS_SERIES_ALLOW, block: ['TV-14', 'M', 'TV-MA', 'MA15+', 'AV15+', 'R', 'R18+', 'X18+', 'RC'] },
      movie: { allow: KIDS_FILM_ALLOW, block: ['PG-13', 'M', 'MA15+', 'R', 'R18+', 'X18+', 'RC', 'NC-17'] },
    },
    hardFloor: { AU: ['MA15+', 'AV15+', 'R18+', 'X18+', 'RC'], US: ['TV-MA', 'R', 'NC-17'] },
    discoverCeilingAU: 'M',
    malMaxAge: 12,
    llm: {
      age: 12,
      cacheKey: 'age12',
      wording: 'You are reviewing {kind} for a 12-year-old in Australia. The standard is US TV-PG / PG / Australian PG / UK 12: suitable. Not suitable: anything at the level of TV-14, PG-13, M or above (strong violence, sexual content, drug use or coarse language beyond that). Err on the side of exclusion: if in doubt, mark it not OK.',
    },
  },
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
    discoverCeilingAU: 'MA 15+',
    malMaxAge: 14,
    // D2: a one-time re-judge under the TV-14 wording. `cacheKey` scopes the LLM
    // verdict cache so TV-14 judgements never mix with the other tiers' caches.
    llm: {
      age: 14,
      cacheKey: 'tv14',
      wording: 'You are reviewing {kind} for a 14-year-old in Australia. The standard is US TV-14 / PG-13 / Australian M: suitable. Not suitable: anything at the level of TV-MA, MA 15+, R or R 18+ (strong violence, sex, nudity, drug use or coarse language beyond M). Err on the side of exclusion: if in doubt, mark it not OK.',
    },
  },
  15: {
    id: 'age15',
    label: '15+ (MA 15+)',
    mode: 'chain',
    csmMaxAge: 15,
    foreignMaxAge: 15,
    lists: {
      series: { allow: [...KIDS_SERIES_ALLOW, 'TV-14', 'M', 'MA15+', 'AV15+'], block: ['TV-MA', 'R', 'R18+', 'X18+', 'RC'] },
      movie: { allow: ['G', 'PG', 'PG-13', 'M', 'MA15+'], block: ['R', 'R18+', 'X18+', 'RC', 'NC-17'] },
    },
    hardFloor: { AU: ['R18+', 'X18+', 'RC'], US: ['NC-17'] },
    discoverCeilingAU: 'MA 15+',
    malMaxAge: 15,
    llm: {
      age: 15,
      cacheKey: 'age15',
      wording: 'You are reviewing {kind} for a 15-year-old in Australia. The standard is Australian MA 15+ / US TV-14 / PG-13: suitable. Not suitable: anything at the level of R 18+, R or TV-MA (graphic violence, explicit sex, or drug use beyond MA 15+). Err on the side of exclusion: if in doubt, mark it not OK.',
    },
  },
};

// Resolve the tier for a profile's filters. `null` = adult (no age limit).
// Otherwise round down to a tier: 1–11 → 10, 12–13 → 12, 14 → 14, 15+ → 15.
function tierFor(filters) {
  const n = filters?.age_limit || 0;
  if (n <= 0) return null;
  const t = n >= 15 ? 15 : n >= 14 ? 14 : n >= 12 ? 12 : 10;
  return TIERS[t];
}

// The single predicate every age gate uses to branch into the chain.
function usesChain(filters) {
  return tierFor(filters) !== null;
}

module.exports = { TIERS, tierFor, usesChain };
