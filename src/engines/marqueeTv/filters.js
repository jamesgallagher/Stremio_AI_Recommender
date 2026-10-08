// Marquee TV (TV-2 §4.1–4.4) — the pure TV filters.
//
// Everything here is pure (no network, no DB): the genre split + Horror
// derivation, the anime detector, the format family, and the hard filter
// (the first failing reason in order wins). The engine orchestrator calls
// these on each candidate's merged meta ({ ...deep, ...extras } + imdb_rating).
const recency = require('../../recency');
const tmdb = require('../../services/tmdb');
const ratings = require('../../ageVerification/ratings');
const animeMap = require('../../services/animeMap');

// §4.1 TV genres: TMDB's TV genres are coarse and have no Horror. Split the
// combined genres and derive Horror from keywords (the TV-0 research: Simkl
// Horror agreed with this keyword rule on 13 of 14 shows).
const SPLIT = { 'Action & Adventure': ['Action', 'Adventure'], 'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'], 'War & Politics': ['War', 'Politics'] };
const HORROR_KW = /horror|slasher|zombie|vampire|haunt|demon|supernatural horror|ghost|gore/i;
function tvGenres(meta) {
  const out = [];
  for (const g of meta.genres || []) for (const x of (SPLIT[g] || [g])) if (!out.includes(x)) out.push(x);
  if (!out.includes('Horror') && (meta.keywords || []).some((k) => HORROR_KW.test(k))) out.push('Horror');
  return out;
}

// §4.2 Anime detector — moved to src/anime/detect.js (AN-1a §2.4); re-exported
// so every existing caller in this file keeps working.
const { isAnimeShow } = require('../../anime/detect');

// §4.4 Formats: the format family of a TMDB tv type (unknown type → scripted).
const FAMILY = { Scripted: 'scripted', Miniseries: 'scripted', Reality: 'reality', Documentary: 'documentary', 'Talk Show': 'talk', News: 'news', Video: 'video' };
function formatFamily(tvType) { return FAMILY[tvType] || 'scripted'; }

// The year of an ISO date string (null when absent/unparseable).
const yearOf = (date) => {
  if (!date) return null;
  const y = parseInt(String(date).slice(0, 4), 10);
  return Number.isNaN(y) ? null : y;
};

// §4.3 The hard filter: the first failing reason in order wins. `check` returns
// { ok: true } or { ok: false, reason }; `stats()` returns the per-reason counts
// (for the summary line). `formatsAllowed` is the Set of format families with
// history (Q4); `tier` is the age tier (null for adults — no age floor).
function compileTvFilter(filters, { nowYear, formatsAllowed, tier }) {
  const counts = {};
  const bump = (reason) => { counts[reason] = (counts[reason] || 0) + 1; };
  const check = (c) => {
    if (!c.imdb_id) { bump('no_imdb'); return { ok: false, reason: 'no_imdb' }; }
    if (isAnimeShow(c, { animeMap: animeMap })) { bump('anime'); return { ok: false, reason: 'anime' }; }
    if (!formatsAllowed.has(formatFamily(c.tvType))) { bump('format'); return { ok: false, reason: 'format' }; }
    const excluded = new Set(filters.excluded_genres || []);
    if (tvGenres(c).some((g) => excluded.has(g))) { bump('genre'); return { ok: false, reason: 'genre' }; }
    const minYear = recency.minYearOf(filters, nowYear);
    const lastAirYear = yearOf(c.last_air_date) || yearOf(c.first_air_date);
    if (minYear > 0 && lastAirYear && lastAirYear < minYear) { bump('recency'); return { ok: false, reason: 'recency' }; }
    if ((c.vote_count || 0) < tmdb.voteFloor(filters, 'series')) { bump('votes'); return { ok: false, reason: 'votes' }; }
    const shown = c.imdb_rating > 0 ? c.imdb_rating : (c.vote_average || 0);
    if (filters.min_rating > 0 && shown > 0 && shown < filters.min_rating) { bump('rating'); return { ok: false, reason: 'rating' }; }
    if (tier && ratings.isHardFloor(c.certAU, c.certUS, tier)) { bump('age_floor'); return { ok: false, reason: 'age_floor' }; }
    return { ok: true };
  };
  const stats = () => counts;
  return { check, stats };
}

module.exports = { tvGenres, isAnimeShow, compileTvFilter, formatFamily };
