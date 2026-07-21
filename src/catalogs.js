// Optional extra catalogs, toggleable per profile in the portal's Catalogs
// section (the two AI catalogs are always on and are not defined here).
// Two sources:
// - source 'trakt_watchlist' (Watch Later, decided 2026-07-15): mirrors the
//   profile's built-in Trakt watchlist — the list Stremio/Nuvio's long-press
//   "add to watchlist" writes to. Default ON (default_on), requires Trakt.
//   Served verbatim in the user's own order; watched titles ARE pruned (a
//   watch-later list must not show what's been seen).
// - source 'mdblist' (curated lists, decided 2026-07-08): popular charts keep
//   every item unfiltered (max 20); rating-gated catalogs (min_imdb) drop
//   items below the bar and keep paging until 20; final order shuffled per
//   rebuild; watched status deliberately ignored. Requires the MDBList key.
const EXTRA_CATALOGS = [
  // Watch Later first — the "3rd catalog" straight after the two AI rows.
  { id: 'trakt-watchlist-movies', type: 'movie', name: 'Watch Later', source: 'trakt_watchlist', default_on: true },
  { id: 'trakt-watchlist-series', type: 'series', name: 'Watch Later', source: 'trakt_watchlist', default_on: true },
  // The JustWatch streaming charts list holds movies and shows in one list;
  // the API returns them as separate arrays, so two catalogs share one slug.
  { id: 'mdb-popular-movies', type: 'movie', name: 'Popular Movies', source: 'mdblist', user: 'official', slug: 'justwatch-streaming-charts', min_imdb: 0 },
  { id: 'mdb-popular-series', type: 'series', name: 'Popular Series', source: 'mdblist', user: 'official', slug: 'justwatch-streaming-charts', min_imdb: 0 },
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

function enabledExtras(profile) {
  return EXTRA_CATALOGS.filter((d) => isEnabled(profile, d));
}

// The profile-side prerequisite for a catalog's data source.
function requirementMet(profile, def) {
  return def.source === 'trakt_watchlist'
    ? !!profile.trakt_auth?.access_token
    : !!profile.keys.mdblist_api_key;
}

module.exports = { EXTRA_CATALOGS, getExtra, isEnabled, enabledExtras, requirementMet };
