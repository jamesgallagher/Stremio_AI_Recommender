// Marquee ME-01 (spec §3): the FilterEnvelope — the profile's filters compiled
// into the three stages Marquee applies them at: TMDB discover params (§3.1),
// a cheap prefilter on list payloads (§3.2), and the hard filter on fully
// looked-up data (§3.3).
//
// PURE: no network, no DB, no Date.now() — nowYear is passed in.
//
// MI-1 (spec §10): the envelope must NEVER be looser than the serve rule
// (recommendationStore.selectServe). The rating and recency rules below are
// copied character for character from selectServe; the smoke parity matrix
// proves it. The envelope may be STRICTER only via cert/availability/vote
// floor (the serve rule has no vote floor and no cert knowledge for movies).
const tmdb = require('../../services/tmdb');
const certs = require('../../certs');
const recency = require('../../recency');
const ratings = require('../../ageVerification/ratings');

// Re-export the shared cert table for convenience (ME-01).
const {
  normalizeCert, certMinAge, strictestMinAge, strictestCert, anyCertMinAge, auCeilingFor,
} = certs;

// The fixed TMDB movie-genre id set (spec §3.1): getGenreMap merges the tv
// namespace too, so without_genres must be restricted to movie ids or a
// tv-only id could leak in.
const MOVIE_GENRE_IDS = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);

// rebuild.js pulls in the heavy build pipeline; require it lazily so the
// envelope stays light for callers that only need the pure stages.
let _rebuild = null;
function judgementAgeOf(filters) {
  if (!_rebuild) _rebuild = require('../../rebuild');
  return _rebuild.judgementAge(filters);
}

// Compile the profile's filters into the envelope. `genreMap` is the
// tmdb.getGenreMap shape (id -> name).
function compileEnvelope(filters, { nowYear, genreMap }) {
  const f = filters || {};
  const voteFloor = tmdb.voteFloor(f, 'movie');
  const minRating = f.min_rating || 0;
  const maxAge = recency.maxAgeOf(f, nowYear); // decade floor → equivalent window (src/recency.js)
  const excluded = new Set(f.excluded_genres || []);
  const kids = (f.age_limit || 0) > 0;
  const ageVerification = require('../../ageVerification');
  const chainTier = ageVerification.usesChain(f) ? ageVerification.tierFor(f) : null;
  const judgementAge = judgementAgeOf(f);
  // Reject counters, incremented by BOTH prefilter and hardFilter on each
  // rejection (P4 uses them to explain a shortfall, spec §8.3).
  const stats = {
    adult: 0, votes: 0, recency: 0, genre: 0, rating: 0,
    no_imdb: 0, unavailable: 0, cert_unknown: 0, cert_over: 0,
  };

  // §3.1: the TMDB discover params, string values.
  function discoverParams() {
    const p = {
      include_adult: 'false',
      with_release_type: '4|5|6', // home release (see ME-00 check V4)
      'vote_count.gte': String(voteFloor),
    };
    if (maxAge > 0) p['primary_release_date.gte'] = `${nowYear - maxAge}-01-01`;
    // Deliberately loose: TMDB's rating is not IMDb's; the hard filter decides.
    if (minRating > 0) p['vote_average.gte'] = String(minRating - 0.5);
    if (excluded.size) {
      const ids = [];
      for (const name of excluded) {
        for (const [id, gname] of Object.entries(genreMap || {})) {
          if (gname === name && MOVIE_GENRE_IDS.has(Number(id))) { ids.push(id); break; }
        }
        // "Anime" and "Kids" have no movie id and are skipped here; the hard
        // filter handles them by name.
      }
      if (ids.length) p.without_genres = ids.join(',');
    }
    if (kids) {
      if (chainTier) {
        p.certification_country = 'AU';
        p['certification.lte'] = 'MA 15+'; // TV-14: only R 18+ and above are cut at the source
      } else {
        const ceiling = auCeilingFor(judgementAge); // legacy tiers: UNCHANGED
        if (ceiling) {
          p.certification_country = 'AU';
          p['certification.lte'] = ceiling;
        }
      }
    }
    return p;
  }

  // §3.2: the cheap prefilter on a list payload
  // {year, vote_average, vote_count, genre_ids, adult}. First failing reason,
  // in order.
  function prefilter(item) {
    const it = item || {};
    if (it.adult) { stats.adult += 1; return { ok: false, reason: 'adult' }; }
    if ((it.vote_count || 0) < voteFloor) { stats.votes += 1; return { ok: false, reason: 'votes' }; }
    // Recency: the serve rule (movies only, only when year is known).
    if (maxAge > 0 && it.year && it.year < nowYear - maxAge) { stats.recency += 1; return { ok: false, reason: 'recency' }; }
    const genreNames = (it.genre_ids || []).map((id) => (genreMap || {})[id]).filter(Boolean);
    if (genreNames.some((g) => excluded.has(g))) { stats.genre += 1; return { ok: false, reason: 'genre' }; }
    // Wide margin: the payload has no IMDb rating, so only clearly-below
    // titles are dropped here (spec §3.2).
    if (minRating > 0 && (it.vote_average || 0) > 0 && (it.vote_average || 0) < minRating - 1.0) {
      stats.rating += 1;
      return { ok: false, reason: 'rating' };
    }
    return { ok: true };
  }

  // §3.3: the hard filter on fully looked-up data
  // {imdb_id, imdb_rating, vote_average, vote_count, year, genres: [names],
  //  availability, certAU, certUS}. First failing reason, in order.
  function hardFilter(row) {
    const r = row || {};
    if (!r.imdb_id) { stats.no_imdb += 1; return { ok: false, reason: 'no_imdb' }; }
    // Rating: EXACTLY the selectServe rule, including "unknown rating is kept".
    const shown = r.imdb_rating > 0 ? r.imdb_rating : (r.vote_average || 0);
    if (minRating > 0 && shown > 0 && shown < minRating) { stats.rating += 1; return { ok: false, reason: 'rating' }; }
    // Recency: exactly the serve rule (movies only; year known).
    if (maxAge > 0 && r.year && r.year < nowYear - maxAge) { stats.recency += 1; return { ok: false, reason: 'recency' }; }
    const genres = r.genres || [];
    if (genres.some((g) => excluded.has(g))) { stats.genre += 1; return { ok: false, reason: 'genre' }; }
    if ((r.vote_count || 0) < voteFloor) { stats.votes += 1; return { ok: false, reason: 'votes' }; }
    // UNKNOWN passes (fail open, like the serve path).
    if (r.availability === 'NOT_YET') { stats.unavailable += 1; return { ok: false, reason: 'unavailable' }; }
    if (kids) {
      if (chainTier) {
        // TV-14: hard floor only (AU R18+/X18+/RC, US NC-17). Unknown or other
        // certificates PASS here — ageGatePool's verify() decides after the build.
        if (ratings.isHardFloor(r.certAU, r.certUS, chainTier)) { stats.cert_over += 1; return { ok: false, reason: 'cert_over' }; }
      } else {
        // legacy tiers: UNCHANGED
        const m = strictestMinAge(r.certAU, r.certUS);
        if (m === null) { stats.cert_unknown += 1; return { ok: false, reason: 'cert_unknown' }; }
        if (m > judgementAge) { stats.cert_over += 1; return { ok: false, reason: 'cert_over' }; }
      }
    }
    return { ok: true };
  }

  return {
    discoverParams,
    prefilter,
    hardFilter,
    stats: () => ({ ...stats }),
    kids,
    judgementAge,
  };
}

module.exports = {
  compileEnvelope,
  normalizeCert,
  certMinAge,
  strictestMinAge,
  strictestCert,
  anyCertMinAge,
  auCeilingFor,
};
