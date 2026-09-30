// Marquee ME-01 (spec §3.4): the shared certification → minimum-age table.
//
// Lives OUTSIDE the Marquee folder on purpose: P5 (SH-01) will point the
// shared serve-time age check at this same table, so there is only ever ONE
// table. Pure: no network, no DB, no Date.now().
//
// AU (ACB) and US (MPA) certifications arrive from TMDB release_dates with
// spaces ("MA 15+", "R 18+") and arbitrary case. All lookups go through
// normalizeCert, so the table keys are the normalized (whitespace-free,
// upper-case) strings.
const AU_MIN_AGE = {
  E: 0, G: 0, PG: 8, M: 15, 'MA15+': 15,
  'R18+': Infinity, 'X18+': Infinity, RC: Infinity,
};
// AU M maps to 15 on purpose (spec §3.4): ACB recommends it for 15+, and on a
// kids profile we err towards exclusion.
const US_MIN_AGE = {
  G: 0, PG: 8, 'PG-13': 13, R: 17, 'NC-17': Infinity,
};

// Trim, upper-case, remove ALL whitespace: 'MA 15+' -> 'MA15+', 'pg-13' ->
// 'PG-13'. Empty / unrated strings count as no certification (null).
function normalizeCert(cert) {
  if (cert == null) return null;
  const s = String(cert).trim().toUpperCase().replace(/\s+/g, '');
  if (!s || s === 'NR' || s === 'UNRATED' || s === 'NOTRATED') return null;
  return s;
}

// Minimum age for one country's certification, or null when unknown (ME-01).
function certMinAge(country, cert) {
  const n = normalizeCert(cert);
  if (!n) return null;
  const table = country === 'US' ? US_MIN_AGE : AU_MIN_AGE;
  return n in table ? table[n] : null;
}

// The larger known min age of the two; null only if BOTH are unknown (ME-01).
function strictestMinAge(certAU, certUS) {
  const a = certMinAge('AU', certAU);
  const b = certMinAge('US', certUS);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

// The cert STRING whose min age is the strictest (AU wins a tie), or null
// (ME-01). Returns the normalized spelling.
function strictestCert(certAU, certUS) {
  const a = certMinAge('AU', certAU);
  const b = certMinAge('US', certUS);
  if (a === null && b === null) return null;
  if (a === null) return normalizeCert(certUS);
  if (b === null) return normalizeCert(certAU);
  return a >= b ? normalizeCert(certAU) : normalizeCert(certUS);
}

// A stored cert has no country (P5's serve check): look it up in AU, then US
// (ME-01).
function anyCertMinAge(cert) {
  const n = normalizeCert(cert);
  if (!n) return null;
  if (n in AU_MIN_AGE) return AU_MIN_AGE[n];
  if (n in US_MIN_AGE) return US_MIN_AGE[n];
  return null;
}

// The highest AU cert whose min age <= judgementAge, in TMDB's spelling (the
// certification.lte value, which keeps the space: 'MA 15+'). Ceiling order
// G < PG < M < MA 15+ (spec §3.4). null when the judgement age is negative.
const AU_CEILING = [
  { cert: 'G', minAge: 0 },
  { cert: 'PG', minAge: 8 },
  { cert: 'M', minAge: 15 },
  { cert: 'MA 15+', minAge: 15 },
];
function auCeilingFor(judgementAge) {
  if (judgementAge == null || judgementAge < 0) return null;
  let out = null;
  for (const c of AU_CEILING) {
    if (c.minAge <= judgementAge) out = c.cert;
  }
  return out;
}

module.exports = {
  normalizeCert,
  certMinAge,
  strictestMinAge,
  strictestCert,
  anyCertMinAge,
  auCeilingFor,
};
