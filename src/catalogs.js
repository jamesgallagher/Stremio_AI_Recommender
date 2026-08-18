// Optional extra catalogs, toggleable per profile in the portal's Catalogs
// section (the two AI catalogs are always on and are not defined here).
// Two sources:
// - source 'simkl_plantowatch' (Watch Later, v6): mirrors the profile's Simkl
//   plan-to-watch list (movies + shows + anime). Default ON (default_on),
//   requires Simkl. Served in the user's own order; watched titles ARE pruned
//   (a watch-later list must not show what's been seen).
// - source 'mdblist' (curated lists, decided 2026-07-08): popular charts keep
//   every item unfiltered (max 20); rating-gated catalogs (min_imdb) drop
//   items below the bar and keep paging until 20; final order shuffled per
//   rebuild; watched status deliberately ignored. Requires the MDBList key.
//   Anime TV-14 is one of these (snoak/trending-anime-shows on MDBList).
const EXTRA_CATALOGS = [
  // Watch Later first — the "3rd catalog" straight after the two AI rows.
  { id: 'trakt-watchlist-movies', type: 'movie', name: 'Watch Later', source: 'simkl_plantowatch', default_on: true },
  { id: 'trakt-watchlist-series', type: 'series', name: 'Watch Later', source: 'simkl_plantowatch', default_on: true },
  // The JustWatch streaming charts list holds movies and shows in one list;
  // the API returns them as separate arrays, so two catalogs share one slug.
  { id: 'mdb-popular-movies', type: 'movie', name: 'Popular Movies', source: 'mdblist', user: 'official', slug: 'justwatch-streaming-charts', min_imdb: 0 },
  { id: 'mdb-popular-series', type: 'series', name: 'Popular Series', source: 'mdblist', user: 'official', slug: 'justwatch-streaming-charts', min_imdb: 0 },
  // Kids lists (added 2026-07-22): bigger targets (50) and rating-gated at 6.0
  // (the site's "60"). On age-limited profiles they get the full protection
  // stack like every other surface — CSM gate + AI age goalkeeper.
  { id: 'mdb-kids-movies', type: 'movie', name: 'Trending Kids Movies', source: 'mdblist', user: 'snoak', slug: 'trending-kids-movies', min_imdb: 6, sort: 'tmdbpopular', target: 50 },
  { id: 'mdb-kids-series', type: 'series', name: 'Trending Kids TV', source: 'mdblist', user: 'tvgeniekodi', slug: 'trending-kids-tv-shows', min_imdb: 6, sort: 'tmdbpopular', target: 50 },
  // Anime TV-14 (v6: snoak/trending-anime-shows on MDBList — was a public Trakt
  // list). A plain curated MDBList catalog now: min_imdb 6 gates rating, the
  // anime/AI age gate handles certifications, IDs kept for manifest stability.
  // min_profile_age: the catalog itself is pitched at a rating band, so a
  // profile limited below it never sees the option. This is a CATALOG-level
  // floor, not a per-title certification lookup — it cannot drop titles for
  // being unrated, which is the failure that retired the CSM gate.
  { id: 'trakt-anime-teen-series', type: 'series', name: 'Anime TV-14', source: 'mdblist', user: 'snoak', slug: 'trending-anime-shows', min_imdb: 6, sort: 'tmdbpopular', target: 50, min_profile_age: 13 },
  { id: 'mdb-christmas-movies', type: 'movie', name: 'Christmas Movies', source: 'mdblist', user: 'jbeasley74', slug: 'christmas-movies', min_imdb: 6, sort: 'imdbpopular' },
  { id: 'mdb-comedy-movies', type: 'movie', name: 'Comedy Movies', source: 'mdblist', user: 'hdlists', slug: 'comedy-movies-2001-2020', min_imdb: 6, sort: 'imdbpopular' },
  { id: 'mdb-action-movies', type: 'movie', name: 'Action Movies', source: 'mdblist', user: 'garycrawfordgc', slug: 'action', min_imdb: 6, sort: 'imdbpopular' },
  { id: 'mdb-thriller-movies', type: 'movie', name: 'Thriller Movies', source: 'mdblist', user: 'garycrawfordgc', slug: 'thriller', min_imdb: 6, sort: 'imdbpopular' },
];

const byId = new Map(EXTRA_CATALOGS.map((d) => [d.id, d]));

function getExtra(id) {
  return byId.get(id) || null;
}

// Effective toggle state: absent from profile.catalogs falls back to the
// definition's default (Watch Later ships ON; curated lists ship OFF).
function isEnabled(profile, def) {
  return (profile.catalogs?.[def.id] ?? def.default_on ?? false) === true;
}

// Is this catalog's rating band within the profile's age limit? A catalog
// marked min_profile_age 13 (TV-14) is hidden from a profile limited to 8.
// No age limit = adult profile = everything available.
//
// Note this lines up with judgementAge(): a 13+ profile is judged at 14, so a
// TV-14 catalog and the gate reviewing it agree on the bar.
function ageAppropriate(profile, def) {
  const floor = def.min_profile_age || 0;
  if (!floor) return true;
  const limit = profile.filters?.age_limit || 0;
  return limit === 0 || limit >= floor;
}

// Enabled AND age-appropriate. Used for the manifest and every rebuild, so a
// profile whose age limit drops below a catalog's band loses it automatically.
function enabledExtras(profile) {
  return EXTRA_CATALOGS.filter((d) => isEnabled(profile, d) && ageAppropriate(profile, d));
}

// The profile-side prerequisite for a catalog's data source.
function requirementMet(profile, def) {
  if (def.source === 'simkl_plantowatch') return !!profile.simkl_auth?.access_token;
  return !!profile.keys.mdblist_api_key;
}

module.exports = { EXTRA_CATALOGS, getExtra, isEnabled, enabledExtras, ageAppropriate, requirementMet };
