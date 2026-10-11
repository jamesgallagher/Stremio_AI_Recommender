// WD-1 — Resolve the release date to stamp on a watched mark.
//
// When a title is marked watched, we stamp its release date (movies:
// release_date; series/anime: first_air_date) rather than "now", so the taste
// engines don't treat it as watched today. We don't know the real watch date,
// so the release date is the best proxy. James decided this.
//
// Rules:
//   - TMDB full date → use it as YYYY-MM-DDT00:00:00Z.
//   - TMDB gives nothing but caller passed a plausible year (1870..current) →
//     use YYYY-01-01T00:00:00Z.
//   - If the resulting instant is in the future → clamp to now (unreleased
//     title stamps "now").
//   - Never throws. Returns null when nothing is known.
const tmdb = require('./services/tmdb');
const settings = require('./settings');

// resolveReleaseDate(profile, {type, imdbId, tmdbId, year}, log, {fetchDate, now})
//   fetchDate: (apiKey, type, ids, log) => {date, year} — injectable for tests.
//   now: () => number (ms) — injectable for tests.
// Returns an ISO string 'YYYY-MM-DDT00:00:00.000Z' or null.
async function resolveReleaseDate(profile, { type, imdbId = null, tmdbId = null, year = null } = {}, log = console, { fetchDate = tmdb.releaseDateFor, now = Date.now } = {}) {
  // Anime is treated as series for the date lookup.
  const tmdbType = type === 'anime' ? 'series' : type;
  if (tmdbType !== 'movie' && tmdbType !== 'series') return null;

  const apiKey = settings.keyFor(profile, 'tmdb_api_key');
  let result = null;

  if (apiKey) {
    try {
      const fetched = await fetchDate(apiKey, tmdbType, { imdbId, tmdbId }, log);
      if (fetched && fetched.date) {
        result = `${fetched.date}T00:00:00.000Z`;
      }
    } catch {
      result = null; // fetcher failure → fall through to year fallback
    }
  }

  // Year fallback: no TMDB date, but caller passed a plausible year.
  if (!result && year != null && Number.isInteger(year) && year >= 1870 && year <= new Date().getUTCFullYear()) {
    result = `${year}-01-01T00:00:00.000Z`;
  }

  if (!result) return null;

  // Clamp: if the resulting instant is in the future, return now.
  const nowMs = now();
  const resultMs = Date.parse(result);
  if (resultMs > nowMs) {
    return new Date(nowMs).toISOString();
  }

  return result;
}

module.exports = { resolveReleaseDate };
