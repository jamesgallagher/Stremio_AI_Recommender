// Optional extra catalogs backed by curated MDBList lists, toggleable per
// profile in the portal's Catalogs section (the two AI catalogs are always
// on and are not defined here). Rules (decided 2026-07-08):
// - Popular charts serve list order unfiltered, max 20.
// - Rating-gated catalogs (min_imdb) drop items whose IMDb rating is below
//   the bar and keep paging the list until 20 titles are collected.
// - Watched status is deliberately ignored — only the AI catalogs exclude
//   watched titles.
// - Requires the profile's MDBList API key.
const EXTRA_CATALOGS = [
  // The JustWatch streaming charts list holds movies and shows in one list;
  // the API returns them as separate arrays, so two catalogs share one slug.
  { id: 'mdb-popular-movies', type: 'movie', name: 'Popular Movies', user: 'official', slug: 'justwatch-streaming-charts', min_imdb: 0 },
  { id: 'mdb-popular-series', type: 'series', name: 'Popular Series', user: 'official', slug: 'justwatch-streaming-charts', min_imdb: 0 },
  { id: 'mdb-christmas-movies', type: 'movie', name: 'Christmas Movies', user: 'jbeasley74', slug: 'christmas-movies', min_imdb: 6, sort: 'imdbpopular' },
  { id: 'mdb-comedy-movies', type: 'movie', name: 'Comedy Movies', user: 'hdlists', slug: 'comedy-movies-2001-2020', min_imdb: 6, sort: 'imdbpopular' },
  { id: 'mdb-action-movies', type: 'movie', name: 'Action Movies', user: 'garycrawfordgc', slug: 'action', min_imdb: 6, sort: 'imdbpopular' },
  { id: 'mdb-thriller-movies', type: 'movie', name: 'Thriller Movies', user: 'garycrawfordgc', slug: 'thriller', min_imdb: 6, sort: 'imdbpopular' },
];

const byId = new Map(EXTRA_CATALOGS.map((d) => [d.id, d]));

function getExtra(id) {
  return byId.get(id) || null;
}

function enabledExtras(profile) {
  return EXTRA_CATALOGS.filter((d) => profile.catalogs?.[d.id]);
}

module.exports = { EXTRA_CATALOGS, getExtra, enabledExtras };
