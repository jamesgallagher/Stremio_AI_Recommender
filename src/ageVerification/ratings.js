// AGE-1: rating normalisation + classification (pure).
//
// A raw rating string from any source (TMDB, TVDB, Simkl, MDBList) is normalised
// (upper case, all whitespace removed) and then mapped to allow / block / null
// ("no rating — the next step decides"). The tier carries the per-type allow/block
// lists (mandate A4) and the hard-floor sets (A3).
//
// PURE: no network, no DB, no Date.now().

// The no-rating set (A4): these all mean "no rating" — the next step decides.
// `E` is unrated (D9); `NOT RATED` normalises to `NOTRATED`.
const NO_RATING = new Set(['E', 'NR', 'UNRATED', 'NOTRATED']);

// Upper case, remove ALL whitespace. The no-rating set and the empty string → null.
function normalizeRating(s) {
  if (s == null) return null;
  const n = String(s).trim().toUpperCase().replace(/\s+/g, '');
  if (!n || NO_RATING.has(n)) return null;
  return n;
}

// Classify a normalisable rating against a tier's per-type lists (A4). Returns
// 'allow' | 'block' | null. First the requested type's lists, then the OTHER type's
// lists (a show rated `PG-13`, a film rated `TV-14`), then null.
function classify(rating, type, tier) {
  const n = normalizeRating(rating);
  if (!n) return null;
  const lists = tier.lists;
  const other = type === 'series' ? 'movie' : 'series';
  for (const t of [type, other]) {
    const l = lists[t];
    if (l.allow.includes(n)) return 'allow';
    if (l.block.includes(n)) return 'block';
  }
  return null;
}

// Foreign (country) classification. Countries are 2-letter (TMDB) or 3-letter
// (TVDB): GB/GBR, IE/IRL, NZ/NZL, CA/CAN. Anything else → null.
const FOREIGN = {
  GB: { allow: ['U', 'PG', '12', '12A'], block: ['15', '18', 'R18'] },
  IE: { allow: ['G', 'PG', '12', '12A', '12PG'], block: ['15A', '15', '16', '18'] },
  NZ: { allow: ['G', 'PG', 'R13', 'RP13'], block: ['M', 'R15', 'R16', 'RP16', 'R18', 'R'] },
  CA: { allow: ['G', 'PG', '14A', 'C', 'C8', '14+'], block: ['18A', 'R', 'A', '18+'] },
};
const COUNTRY_MAP = { GB: 'GB', GBR: 'GB', IE: 'IE', IRL: 'IE', NZ: 'NZ', NZL: 'NZ', CA: 'CA', CAN: 'CA' };

function classifyForeign(country, rating, tier) {
  const cc = COUNTRY_MAP[String(country || '').trim().toUpperCase()];
  if (!cc || !FOREIGN[cc]) return null;
  const n = normalizeRating(rating);
  if (!n) return null;
  const l = FOREIGN[cc];
  if (l.allow.includes(n)) return 'allow';
  if (l.block.includes(n)) return 'block';
  return null;
}

// Loose classification for MDBList's country-less `certification`. First try the
// strict per-type lists (both types); else the first number in the string
// (≤ foreignMaxAge allow, ≥ foreignMaxAge+1 block); else null.
function classifyLoose(rating, tier) {
  const n = normalizeRating(rating);
  if (!n) return null;
  const strict = classify(rating, 'series', tier) || classify(rating, 'movie', tier);
  if (strict) return strict;
  const m = n.match(/\d+/);
  if (m) {
    const num = parseInt(m[0], 10);
    if (num <= tier.foreignMaxAge) return 'allow';
    if (num >= tier.foreignMaxAge + 1) return 'block';
  }
  return null;
}

// The hard floor (A3/D10): a normalised AU or US rating in the tier's hard-floor
// sets → true. Nothing else can override it.
function isHardFloor(au, us, tier) {
  const a = normalizeRating(au);
  const u = normalizeRating(us);
  if (a && tier.hardFloor.AU.includes(a)) return true;
  if (u && tier.hardFloor.US.includes(u)) return true;
  return false;
}

module.exports = { normalizeRating, classify, classifyForeign, classifyLoose, isHardFloor };
