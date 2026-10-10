// FG-1: the pure filter rules.
//
// compileRules(filters, type, { nowYear }) returns { needs, evaluate(facts) }:
// - `needs` is the set of facts the ACTIVE filters require (empty = no-op).
// - `evaluate(facts)` returns { ok: true } or { ok: false, reason, detail }.
//
// Pure: no network, no DB, no Date.now() (nowYear is passed in).
const recency = require('../recency');
const tmdb = require('../services/tmdb');

function compileRules(filters, type, { nowYear }) {
  const f = filters || {};
  const minRating = f.min_rating || 0;
  const minYear = recency.minYearOf(f, nowYear);
  const voteFloor = tmdb.voteFloor(f, type);
  const excluded = new Set(f.excluded_genres || []);

  // The set of facts the ACTIVE filters require.
  const needs = new Set();
  if (minRating > 0) needs.add('rating');
  if (minYear > 0) needs.add('year');
  if (voteFloor > 0) needs.add('votes');
  if (excluded.size > 0) needs.add('genres');

  function evaluate(facts) {
    const fact = (name) => {
      const v = facts?.[name];
      return v === null || v === undefined ? null : v;
    };

    // Genre: any of the title's genre names is in the excluded set.
    if (excluded.size > 0) {
      const genres = fact('genres') || [];
      const hit = genres.find((g) => excluded.has(g));
      if (hit) return { ok: false, reason: 'genre', detail: hit };
    }

    // Recency: minYear > 0 && year && year < minYear.
    if (minYear > 0) {
      const year = fact('year');
      if (year && year < minYear) return { ok: false, reason: 'recency', detail: `${year} < ${minYear}` };
    }

    // Votes: votes < voteFloor.
    if (voteFloor > 0) {
      const votes = fact('votes');
      if (votes !== null && votes < voteFloor) return { ok: false, reason: 'votes', detail: `${votes} < ${voteFloor}` };
    }

    // Rating: minRating > 0 && shown > 0 && shown < minRating.
    // The shown rating: IMDb number if > 0, else TMDB vote_average.
    if (minRating > 0) {
      const rating = fact('rating');
      // A rating of 0 means "no rating" and counts as missing.
      const shown = rating > 0 ? rating : null;
      if (shown !== null && shown < minRating) {
        return { ok: false, reason: 'rating', detail: `${shown} < ${minRating}` };
      }
    }

    // A needed fact is still missing => no_data.
    // A rating of 0 means "no rating" and also counts as missing.
    for (const name of needs) {
      const v = fact(name);
      if (v === null) return { ok: false, reason: 'no_data', detail: `${name} missing` };
      if (name === 'rating' && v === 0) return { ok: false, reason: 'no_data', detail: 'rating missing' };
    }

    return { ok: true };
  }

  return { needs, evaluate };
}

module.exports = { compileRules };
