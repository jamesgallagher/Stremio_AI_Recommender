// Release-year filter (movies only). James, 2026-10-02: the filter is a DECADE
// floor — "2020 onwards", "2010 onwards", … "1980 onwards", or no limit — stored
// as filters.min_year (0 = no limit). It replaces the old rolling window
// filters.max_age_years (1/2/5/10/20 years).
//
// Every consumer goes through this module so the two forms can't drift:
//   minYearOf  → the earliest release year allowed (0 = none) — serve filter, prompts
//   maxAgeOf   → the equivalent window in years (nowYear − min_year) for code that
//                is written in window terms (Marquee's envelope + freshness), so an
//                equivalent setting behaves EXACTLY as before.
// A profile not yet migrated (max_age_years set, min_year absent) still works.

const DECADE_CHOICES = [2020, 2010, 2000, 1990, 1980];

function minYearOf(filters, nowYear = new Date().getFullYear()) {
  const f = filters || {};
  const my = parseInt(f.min_year, 10) || 0;
  if (my > 0) return my;
  const ma = parseInt(f.max_age_years, 10) || 0;
  return ma > 0 ? nowYear - ma : 0;
}

function maxAgeOf(filters, nowYear = new Date().getFullYear()) {
  const my = minYearOf(filters, nowYear);
  return my > 0 ? Math.max(0, nowYear - my) : 0;
}

// Migration: an old rolling window → the decade floor that never hides MORE than
// before (round the earliest year DOWN to its decade). 10 years in 2026 (2016+)
// → 2010; 1/2/5 years → 2020; 20 years (2006+) → 2000; 0 → 0 (no limit).
function decadeFromMaxAge(maxAgeYears, nowYear = new Date().getFullYear()) {
  const ma = parseInt(maxAgeYears, 10) || 0;
  if (ma <= 0) return 0;
  return Math.floor((nowYear - ma) / 10) * 10;
}

// Validate a requested min_year: 0, or a year in [1900, nowYear]. Anything else → 0.
function normalizeMinYear(v, nowYear = new Date().getFullYear()) {
  const y = parseInt(v, 10) || 0;
  return y >= 1900 && y <= nowYear ? y : 0;
}

module.exports = { DECADE_CHOICES, minYearOf, maxAgeOf, decadeFromMaxAge, normalizeMinYear };
