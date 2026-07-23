// Optional extra catalogs, toggleable per profile in the portal's Catalogs
// section (the two AI catalogs are always on and are not defined here).
// Two sources:
// - source 'trakt_watchlist' (Watch Later, decided 2026-07-15): mirrors the
//   profile's built-in Trakt watchlist — the list Stremio/Nuvio's long-press
//   "add to watchlist" writes to. Default ON (default_on), requires Trakt.
//   Served verbatim in the user's own order; watched titles ARE pruned (a
//   watch-later list must not show what's been seen).
// - source 'trakt_list' (public Trakt lists, added 2026-07-23): any user's
//   public list, fetched with the client ID alone. Rating-gated like the
//   curated lists; the site-URL view filters are NOT applied by the API and
//   are re-implemented in the pipeline.
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
  // Kids lists (added 2026-07-22): bigger targets (50) and rating-gated at 6.0
  // (the site's "60"). On age-limited profiles they get the full protection
  // stack like every other surface — CSM gate + AI age goalkeeper.
  { id: 'mdb-kids-movies', type: 'movie', name: 'Trending Kids Movies', source: 'mdblist', user: 'snoak', slug: 'trending-kids-movies', min_imdb: 6, sort: 'tmdbpopular', target: 50 },
  { id: 'mdb-kids-series', type: 'series', name: 'Trending Kids TV', source: 'mdblist', user: 'tvgeniekodi', slug: 'trending-kids-tv-shows', min_imdb: 6, sort: 'tmdbpopular', target: 50 },
  // Anime TV-14 (added 2026-07-23): a public Trakt list. The certification /
  // ratings / ignore_watched filters in the list's web URL are SITE view
  // filters — the API returns the list unfiltered — so they're re-applied
  // here: min_imdb 6 covers imdb_ratings=6-10, the AI age gate covers
  // certifications=all_ages,parental_guidance,teens, and watched exclusion
  // covers ignore_watched.
  { id: 'trakt-anime-teen-series', type: 'series', name: 'Anime TV-14', source: 'trakt_list', user: 'snoak', slug: 'trending-anime-shows', min_imdb: 6, target: 50, prune_watched: true },
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
  if (def.source === 'trakt_watchlist') return !!profile.trakt_auth?.access_token;
  // Public lists need only the client ID — they aren't this profile's data.
  if (def.source === 'trakt_list') return !!profile.keys.trakt_client_id;
  return !!profile.keys.mdblist_api_key;
}

module.exports = { EXTRA_CATALOGS, getExtra, isEnabled, enabledExtras, requirementMet };
