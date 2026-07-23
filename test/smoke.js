// Smoke test: no network calls — exercises store, filters, prompt/parse logic,
// genre mapping, and the HTTP surface with a seeded cache.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-test-' + Date.now();
process.env.PORT = '7311';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const config = require('../src/config');
const rebuild = require('../src/rebuild');
const groq = require('../src/services/groq');
const tmdb = require('../src/services/tmdb');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('unit:');

ok('store: atomic swap preserves other catalog type', () => {
  store.swapCatalog('p1', 'movie', [{ id: 'tt1' }], [], 'llm');
  store.swapCatalog('p1', 'series', [{ id: 'tt2' }], [], 'discover');
  const c = store.loadCache('p1');
  assert.strictEqual(c.movie.metas[0].id, 'tt1');
  assert.strictEqual(c.series.metas[0].id, 'tt2');
  assert.strictEqual(c.series.source, 'discover');
  store.deleteCache('p1');
});

ok('store: pruneWatched removes watched + backfills displayed from bench', () => {
  // display_size 3 + one bench item: watching a displayed title promotes bench.
  store.swapCatalog('p2', 'movie',
    [{ id: 'tt1' }, { id: 'tt2' }, { id: 'tt3' }], [{ id: 'tt4' }], 'llm', 3);
  const removed = store.pruneWatched('p2', 'movie', new Set(['tt2', 'tt9']));
  assert.strictEqual(removed, 1);
  const c = store.loadCache('p2');
  assert.deepStrictEqual(c.movie.metas.map(m => m.id), ['tt1', 'tt3', 'tt4']); // bench promoted in
  assert.strictEqual(c.movie.bench.length, 0);
  assert.strictEqual(store.pruneWatched('p2', 'series', new Set(['tt1'])), 0); // no series cache: no-op
  store.deleteCache('p2');
});

ok('store: watched activity snapshot + touch', () => {
  store.saveWatchedActivity('p4', { movies: '2026-07-01T00:00:00Z', episodes: null });
  const c = store.loadCache('p4');
  assert.strictEqual(c.watched_activity.movies, '2026-07-01T00:00:00Z');
  assert.ok(c.watched_synced_at > 0);
  const before = c.watched_synced_at;
  store.touchWatchedSync('p4');
  const c2 = store.loadCache('p4');
  assert.ok(c2.watched_synced_at >= before);
  assert.strictEqual(c2.watched_activity.movies, '2026-07-01T00:00:00Z'); // untouched
  store.deleteCache('p4');
});

ok('trakt: watched parse — ID sets + recency-ordered taste seed', () => {
  const { parseWatchedItems } = require('../src/services/trakt');
  const items = [
    { last_watched_at: '2026-01-01T00:00:00Z', movie: { title: 'Old', year: 2000, ids: { imdb: 'tt1', tmdb: 1 } } },
    { last_watched_at: '2026-06-01T00:00:00Z', movie: { title: 'New', year: 2024, ids: { imdb: 'tt2', tmdb: 2 } } },
    { last_watched_at: '2026-03-01T00:00:00Z', movie: { title: 'Mid', year: 2020, ids: { tmdb: 3 } } }, // no imdb id
    { movie: { title: 'NoIds' } }, // dropped entirely
  ];
  const w = parseWatchedItems(items, 'movie');
  assert.deepStrictEqual([...w.imdbIds].sort(), ['tt1', 'tt2']);
  assert.deepStrictEqual([...w.tmdbIds].sort(), [1, 2, 3]);
  assert.deepStrictEqual(w.recent.map(r => r.title), ['New', 'Mid', 'Old']); // newest first
  assert.strictEqual(w.recent[0].tmdb_id, 2); // seed carries ids for enrichment
  const shows = parseWatchedItems([
    { last_watched_at: '2026-05-01T00:00:00Z', show: { title: 'Show', year: 2023, ids: { imdb: 'tt9', tmdb: 9 } } },
  ], 'series');
  assert.deepStrictEqual(shows.recent, [{ title: 'Show', year: 2023, tmdb_id: 9, imdb_id: 'tt9' }]);
});

ok('trakt: recommendations parse — fields, wrapped shapes, dropped junk', () => {
  const { parseRecommendations } = require('../src/services/trakt');
  const raw = [
    { title: 'Dune', year: 2021, ids: { tmdb: 438631, imdb: 'tt1160419' }, rating: 7.7, votes: 32000, genres: ['science-fiction', 'adventure'], status: 'released', certification: 'PG-13', language: 'en', overview: 'Spice.' },
    { show: { title: 'Silo', year: 2023, ids: { tmdb: 125988, imdb: 'tt14688458' }, rating: 7.8, votes: 9000, genres: ['drama'], status: 'returning series' } }, // wrapped shape
    { title: 'NoIds' }, // dropped
  ];
  const movies = parseRecommendations(raw, 'movie');
  assert.strictEqual(movies.length, 1); // wrapped show not a movie; NoIds dropped
  assert.deepStrictEqual(movies[0], {
    title: 'Dune', year: 2021, tmdb_id: 438631, imdb_id: 'tt1160419', rating: 7.7,
    votes: 32000, genres: ['science-fiction', 'adventure'], status: 'released',
    certification: 'PG-13', language: 'en', overview: 'Spice.',
  });
  const shows = parseRecommendations([raw[1]], 'series');
  assert.strictEqual(shows[0].title, 'Silo');
  assert.strictEqual(shows[0].status, 'returning series');
  assert.strictEqual(shows[0].overview, ''); // absent fields default sanely
});

ok('catalogs: registry, defaults, and per-source requirements', () => {
  const catalogs = require('../src/catalogs');
  assert.strictEqual(catalogs.EXTRA_CATALOGS.length, 11);
  // Kids lists: 50 titles, rating-gated at 6.0 (the site's "60"), off by default
  const kidsM = catalogs.getExtra('mdb-kids-movies');
  const kidsS = catalogs.getExtra('mdb-kids-series');
  assert.strictEqual(kidsM.target, 50);
  assert.strictEqual(kidsS.target, 50);
  assert.strictEqual(kidsM.min_imdb, 6);
  assert.strictEqual(kidsS.type, 'series');
  assert.ok(!kidsM.default_on && !kidsS.default_on); // opt-in per profile
  assert.strictEqual(catalogs.getExtra('mdb-action-movies').target, undefined); // others keep the 20 default
  const ids = catalogs.EXTRA_CATALOGS.map(d => d.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(catalogs.EXTRA_CATALOGS.every(d => d.type === 'movie' || d.type === 'series'));
  assert.strictEqual(catalogs.getExtra('mdb-popular-movies').min_imdb, 0); // popular: no rating gate
  assert.strictEqual(catalogs.getExtra('mdb-action-movies').min_imdb, 6);
  assert.strictEqual(catalogs.getExtra('nope'), null);
  // Watch Later: default ON, trakt-sourced, first among extras (the "3rd catalog")
  const wl = catalogs.getExtra('trakt-watchlist-movies');
  assert.strictEqual(wl.source, 'trakt_watchlist');
  assert.strictEqual(wl.default_on, true);
  assert.deepStrictEqual(ids.slice(0, 2), ['trakt-watchlist-movies', 'trakt-watchlist-series']);
  // Default-on semantics: absent = on for watchlist, off for curated lists
  assert.deepStrictEqual(catalogs.enabledExtras({}).map(d => d.id),
    ['trakt-watchlist-movies', 'trakt-watchlist-series']);
  assert.deepStrictEqual(
    catalogs.enabledExtras({ catalogs: { 'mdb-action-movies': true, 'trakt-watchlist-movies': false } }).map(d => d.id),
    ['trakt-watchlist-series', 'mdb-action-movies']); // explicit false opts out of a default-on
  // Requirements: watchlist needs Trakt OAuth; curated lists need the MDBList
  // key; a PUBLIC Trakt list needs only the client id (it isn't our data)
  assert.strictEqual(catalogs.requirementMet({ keys: {}, trakt_auth: { access_token: 't' } }, wl), true);
  assert.strictEqual(catalogs.requirementMet({ keys: { mdblist_api_key: 'k' }, trakt_auth: null }, wl), false);
  assert.strictEqual(catalogs.requirementMet({ keys: { mdblist_api_key: 'k' } }, catalogs.getExtra('mdb-action-movies')), true);
  const anime = catalogs.getExtra('trakt-anime-teen-series');
  assert.strictEqual(anime.source, 'trakt_list');
  assert.strictEqual(anime.type, 'series');
  assert.strictEqual(anime.target, 50);
  assert.strictEqual(anime.min_imdb, 6);   // list URL's imdb_ratings=6-10
  assert.strictEqual(anime.prune_watched, true); // list URL's ignore_watched
  assert.ok(!anime.default_on);
  assert.strictEqual(catalogs.requirementMet({ keys: { trakt_client_id: 'c' }, trakt_auth: null }, anime), true);
  assert.strictEqual(catalogs.requirementMet({ keys: {}, trakt_auth: { access_token: 't' } }, anime), false);

  // Catalog-level age band (TV-14 -> 13+). A profile limited below the band
  // never sees it; adults (no limit) always do. This is a catalog floor, NOT a
  // per-title certification lookup — it can't drop titles for being unrated.
  assert.strictEqual(anime.min_profile_age, 13);
  assert.strictEqual(catalogs.ageAppropriate({ filters: { age_limit: 13 } }, anime), true);
  assert.strictEqual(catalogs.ageAppropriate({ filters: { age_limit: 15 } }, anime), true);
  assert.strictEqual(catalogs.ageAppropriate({ filters: { age_limit: 8 } }, anime), false);
  assert.strictEqual(catalogs.ageAppropriate({ filters: { age_limit: 0 } }, anime), true); // adult
  assert.strictEqual(catalogs.ageAppropriate({}, anime), true);
  assert.strictEqual(catalogs.ageAppropriate({ filters: { age_limit: 8 } }, wl), true); // no band
  // ...and enabling it on an under-age profile must not surface it anyway
  const under = { filters: { age_limit: 8 }, catalogs: { 'trakt-anime-teen-series': true } };
  assert.ok(!catalogs.enabledExtras(under).some(d => d.id === 'trakt-anime-teen-series'));
  const ok13 = { filters: { age_limit: 13 }, catalogs: { 'trakt-anime-teen-series': true } };
  assert.ok(catalogs.enabledExtras(ok13).some(d => d.id === 'trakt-anime-teen-series'));
});

ok('store: swapExtra keeps AI catalogs untouched', () => {
  store.swapCatalog('p5', 'movie', [{ id: 'tt1' }], [], 'llm');
  store.swapExtra('p5', 'mdb-action-movies', [{ id: 'tt2' }]);
  const c = store.loadCache('p5');
  assert.strictEqual(c.movie.metas[0].id, 'tt1');
  assert.strictEqual(c.extras['mdb-action-movies'].metas[0].id, 'tt2');
  assert.ok(c.extras['mdb-action-movies'].generated_at > 0);
  store.deleteCache('p5');
});

ok('mdblist: Common Sense age comes from age_rating, not the commonsense flag', () => {
  const { parseCommonSenseAge } = require('../src/services/mdblist');
  // Real MDBList shape: `commonsense` is a BOOLEAN availability flag and the
  // age is `age_rating`. Parsing the flag as the age gave NaN, so every title
  // looked unrated and strict mode emptied entire kids catalogs.
  assert.strictEqual(parseCommonSenseAge({ certification: 'PG', commonsense: true, age_rating: 13 }), 13);
  assert.strictEqual(parseCommonSenseAge({ commonsense: true }), null); // flag alone is not an age
  assert.strictEqual(parseCommonSenseAge({ commonsense: false, age_rating: 8 }), 8);
  assert.strictEqual(parseCommonSenseAge({ age_rating: '10+' }), 10);
  // Legacy/alternate shapes still honored
  assert.strictEqual(parseCommonSenseAge({ commonsense: 8 }), 8);
  assert.strictEqual(parseCommonSenseAge({ ratings: [{ source: 'commonsense', value: 13 }] }), 13);
  assert.strictEqual(parseCommonSenseAge({ ratings: [{ source: 'imdb', value: 9 }] }), null);
  assert.strictEqual(parseCommonSenseAge({}), null);
  assert.strictEqual(parseCommonSenseAge(null), null);
});

ok('mdblist: IMDb rating parse from list items and media info', () => {
  const { parseImdbRating } = require('../src/services/mdblist');
  assert.strictEqual(parseImdbRating({ ratings: [{ source: 'imdb', value: 7.4 }] }), 7.4);
  assert.strictEqual(parseImdbRating({ imdbrating: '6.1' }), 6.1);
  assert.strictEqual(parseImdbRating({ ratings: [{ source: 'metacritic', value: 88 }] }), null);
  assert.strictEqual(parseImdbRating({}), null);
  assert.strictEqual(parseImdbRating(null), null);
});

ok('config: profile CRUD + filter clamping', () => {
  const p = config.addProfile('Test');
  assert.ok(p.token.length === 32);
  assert.strictEqual(p.filters.min_rating, 6.0); // v4: Trakt 60% floor start point
  assert.strictEqual(p.filters.max_age_years, 0); // v4: all years by default
  assert.strictEqual(p.filters.rating_source, 'trakt');
  assert.strictEqual(p.keys.rpdb_api_key, 't0-free-rpdb'); // free RPDB key pre-set
  assert.strictEqual(p.filters.age_limit, 0); // age gate off by default
  assert.strictEqual(p.filters.list_size, 20); // fill-to-quota default
  assert.strictEqual(p.filters.engine, 'trakt'); // v5: existing behaviour is the default
  config.updateProfile(p.id, { filters: { min_rating: -3, excluded_genres: ['Horror'] } });
  const p2 = config.getProfile(p.id);
  assert.strictEqual(p2.filters.min_rating, 0); // clamped

  // Engine is a whitelist — an unknown value must never disable the age gating
  // that a kids profile depends on, so it falls back to trakt.
  config.updateProfile(p.id, { filters: { engine: 'ai' } });
  assert.strictEqual(config.getProfile(p.id).filters.engine, 'ai');
  config.updateProfile(p.id, { filters: { engine: 'skynet' } });
  assert.strictEqual(config.getProfile(p.id).filters.engine, 'trakt');
  assert.deepStrictEqual(p2.filters.excluded_genres, ['Horror']);
  assert.deepStrictEqual(p2.catalogs, {}); // extra catalogs default off
  config.updateProfile(p.id, { catalogs: { 'mdb-action-movies': true, 'bogus-id': true, 'mdb-popular-movies': false, 'trakt-watchlist-movies': false } });
  // Unknown ids dropped; false stored explicitly (needed to opt out of default-on Watch Later)
  assert.deepStrictEqual(config.getProfile(p.id).catalogs,
    { 'mdb-action-movies': true, 'mdb-popular-movies': false, 'trakt-watchlist-movies': false });
  assert.ok(config.getProfileByToken(p.token));
  config.removeProfile(p.id);
  assert.strictEqual(config.getProfile(p.id), null);
});

ok('filters: cleanMetas strips every internal (_-prefixed) field', () => {
  const out = rebuild.cleanMetas([{ id: 'tt1', name: 'X', _tmdb_id: 9, _genre_ids: [1], _vote_average: 8, _vote_count: 10, _release_date: '2024-01-01', _imdb_rating: 7.7, _original_language: 'ja', _genre_names: ['Anime'], _future_field: 1 }]);
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['id', 'name']); // incl. fields added later
});

ok('tmdb: voteFloor scales the series floor down', () => {
  const tmdbSvc = require('../src/services/tmdb');
  assert.strictEqual(tmdbSvc.voteFloor({ vote_count_floor: 1000 }, 'movie'), 1000);
  assert.strictEqual(tmdbSvc.voteFloor({ vote_count_floor: 1000 }, 'series'), 200); // TV vote counts run ~5x lower
  assert.strictEqual(tmdbSvc.voteFloor({ vote_count_floor: 0 }, 'series'), 0); // explicit 0 respected
  assert.strictEqual(tmdbSvc.voteFloor({}, 'movie'), 200); // legacy defaults when unset
});

ok('groq: age-gate prompt carries age, ACB standard, and candidates', () => {
  const p = groq.buildAgePrompt('movie', 8, [
    { id: 'tt1', title: 'Bluey: The Movie', year: 2026, genres: ['family'], certification: 'G', overview: 'Dog.' },
  ]);
  assert.ok(p.includes('aged 8'));
  assert.ok(/Australian classification/i.test(p));
  assert.ok(/err on the side of exclusion/i.test(p));
  assert.ok(p.includes('tt1'));
});

ok('groq: parseVerdicts validates ids, dedupes, tolerates wrappers', () => {
  const valid = new Set(['tt1', 'tt2']);
  const m1 = groq.parseVerdicts('[{"id":"tt1","ok":true},{"id":"tt2","ok":false}]', valid);
  assert.strictEqual(m1.get('tt1'), true);
  assert.strictEqual(m1.get('tt2'), false);
  const m2 = groq.parseVerdicts('{"results":[{"id":"tt9","ok":false},{"id":"tt1","ok":false},{"id":"tt1","ok":true}]}', valid);
  assert.strictEqual(m2.has('tt9'), false); // hallucinated id dropped
  assert.strictEqual(m2.get('tt1'), false); // first verdict wins
  assert.throws(() => groq.parseVerdicts('no json here', valid));
});

ok('rebuild: recPasses enforces status, rating, votes, recency, genres', () => {
  const f = { min_rating: 6, rating_source: 'trakt', vote_count_floor: 1000, max_age_years: 0, excluded_genres: [] };
  const base = { title: 'X', status: 'released', rating: 7.5, votes: 5000, year: 2020, genres: ['drama'], language: 'en' };
  const quiet = { log() {} };
  assert.ok(rebuild.recPasses(base, 'movie', f, quiet));
  assert.ok(!rebuild.recPasses({ ...base, rating: 5.9 }, 'movie', f, quiet)); // below Trakt floor
  assert.ok(rebuild.recPasses({ ...base, rating: null }, 'movie', f, quiet)); // unrated kept
  assert.ok(!rebuild.recPasses({ ...base, votes: 100 }, 'movie', f, quiet)); // vote floor
  assert.ok(rebuild.recPasses({ ...base, votes: 300, status: 'returning series' }, 'series', f, quiet)); // series floor = 1/5
  assert.ok(!rebuild.recPasses({ ...base, status: 'in production' }, 'movie', f, quiet)); // unreleased movie
  assert.ok(!rebuild.recPasses({ ...base, status: 'canceled' }, 'series', f, quiet)); // dead show
  assert.ok(rebuild.recPasses({ ...base, status: 'ended' }, 'series', f, quiet)); // finished shows are fine
  assert.ok(!rebuild.recPasses({ ...base, year: 2001 }, 'movie', { ...f, max_age_years: 5 }, quiet)); // recency honored when set
  assert.ok(!rebuild.recPasses({ ...base, genres: ['horror', 'drama'] }, 'movie', { ...f, excluded_genres: ['Horror'] }, quiet));
});

ok('rebuild: recPasses "Anime" exclusion — native tag + ja fallback', () => {
  const f = { min_rating: 0, rating_source: 'trakt', vote_count_floor: 0, max_age_years: 0, excluded_genres: ['Anime'] };
  const quiet = { log() {} };
  const tagged = { title: 'A', status: 'released', rating: 8, votes: 9000, year: 2023, genres: ['anime', 'animation', 'action'], language: 'ja' };
  const untagged = { ...tagged, genres: ['animation', 'action'] }; // ja animation without the anime tag
  const pixar = { ...tagged, genres: ['animation', 'family'], language: 'en' };
  const jaDrama = { ...tagged, genres: ['drama'], language: 'ja' };
  assert.ok(!rebuild.recPasses(tagged, 'movie', f, quiet));
  assert.ok(!rebuild.recPasses(untagged, 'movie', f, quiet));
  assert.ok(rebuild.recPasses(pixar, 'movie', f, quiet)); // family animation stays
  assert.ok(rebuild.recPasses(jaDrama, 'movie', f, quiet)); // ja live-action stays
  // Excluding "Animation" removes all animation, anime included
  assert.ok(!rebuild.recPasses(pixar, 'movie', { ...f, excluded_genres: ['Animation'] }, quiet));
  assert.ok(!rebuild.recPasses(tagged, 'movie', { ...f, excluded_genres: ['Animation'] }, quiet));
});

ok('tmdb: pickLogo prefers English, builds URL, handles empty', () => {
  assert.strictEqual(
    tmdb.pickLogo([{ iso_639_1: 'de', file_path: '/de.png' }, { iso_639_1: 'en', file_path: '/en.png' }]),
    'https://image.tmdb.org/t/p/w500/en.png'
  );
  assert.strictEqual(
    tmdb.pickLogo([{ iso_639_1: 'fr', file_path: '/fr.png' }]),
    'https://image.tmdb.org/t/p/w500/fr.png' // no English — first available
  );
  assert.strictEqual(tmdb.pickLogo([]), null);
  assert.strictEqual(tmdb.pickLogo(undefined), null);
});

ok('groq: generation prompt is age-aware, carries seeds and exclusions', () => {
  const prompt = groq.buildGeneratePrompt('series', {
    ageLimit: 14, count: 50, excludedGenres: ['Horror'],
    seeds: [{ title: 'Demon Slayer', year: 2019 }],
  });
  assert.ok(prompt.includes('14-year-old'));
  assert.ok(prompt.includes('Australian classification standards (ACB)'));
  assert.ok(prompt.includes('Demon Slayer (2019)'));
  assert.ok(prompt.includes('Horror'));
  assert.ok(/anime/i.test(prompt)); // anime gets called out — it's the failure case
  assert.ok(prompt.includes('50'));

  // Adults: no age constraint at all, and no empty-history confusion
  const adult = groq.buildGeneratePrompt('movie', { ageLimit: 0, seeds: [], count: 50 });
  assert.ok(!adult.includes('year-old'));
  assert.ok(adult.includes('no watch history yet'));
});

ok('rebuild: seedsFor weights own history 70/30 and fades borrowing with use', () => {
  const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ title: `${p}${i}`, year: 2000 + i }));
  const split = (seeds, t) => [seeds.filter(s => s.type === t).length, seeds.filter(s => s.type !== t).length];

  // Established profile: 70/30, so even a full history gets a second angle
  let seeds = rebuild.seedsFor({ movie: { recent: mk(30, 'M') }, series: { recent: mk(30, 'S') } }, 'movie');
  assert.deepStrictEqual(split(seeds, 'movie'), [14, 6]);
  assert.strictEqual(seeds.length, 20);

  // Ciara: no movie history at all -> 100% borrowed, and a usable list on day one
  seeds = rebuild.seedsFor({ movie: { recent: [] }, series: { recent: mk(30, 'S') } }, 'movie');
  assert.deepStrictEqual(split(seeds, 'movie'), [0, 20]);
  assert.strictEqual(seeds[0].type, 'series'); // labelled, so the prompt can group them

  // A SHORT but real history must not be swamped: 7 on-taste seeds beat 20
  // off-taste ones. Backfilling to 20 here turned Ciara's anime series list
  // into Bakugan and Sofia the First.
  seeds = rebuild.seedsFor({ movie: { recent: mk(30, 'M') }, series: { recent: mk(7, 'S') } }, 'series');
  assert.deepStrictEqual(split(seeds, 'series'), [7, 3]); // still 70/30, just smaller
  seeds = rebuild.seedsFor({ movie: { recent: mk(30, 'M') }, series: { recent: mk(5, 'S') } }, 'series');
  assert.deepStrictEqual(split(seeds, 'series'), [5, 2]);

  // Only a genuine cold start (< 3) borrows beyond the 30% share
  seeds = rebuild.seedsFor({ movie: { recent: mk(30, 'M') }, series: { recent: mk(2, 'S') } }, 'series');
  assert.deepStrictEqual(split(seeds, 'series'), [2, 18]);

  // Neither type populated, and missing types, must not throw
  assert.deepStrictEqual(rebuild.seedsFor({ movie: {}, series: {} }, 'series'), []);
});

ok('groq: cross-type seeds render as separate labelled groups', () => {
  const seeds = [
    { title: 'Your Name', year: 2016, type: 'movie' },
    { title: 'Haikyu!!', year: 2014, type: 'series' },
  ];
  const prompt = groq.buildGeneratePrompt('movie', { seeds, count: 50 });
  assert.ok(prompt.includes('Recently watched films:'));
  assert.ok(prompt.includes('Recently watched TV series'));
  // The series group must be marked as a different format, or the model
  // proposes spin-offs of shows instead of films
  assert.ok(/different format/.test(prompt));

  // Cold start on this type: tell it to infer, and explicitly not to fall back
  // on crowd-pleasers — that fallback is what produced Free Willy for Ciara
  const borrowed = groq.buildGeneratePrompt('movie', { seeds: [seeds[1]], count: 50 });
  assert.ok(borrowed.includes('has not watched many films yet'));
  assert.ok(borrowed.includes('generic crowd-pleasers'));
  assert.ok(!borrowed.includes('Recently watched films:')); // no empty group
  // Untyped seeds (older callers) still count as own-type
  assert.ok(groq.buildGeneratePrompt('movie', { seeds: [{ title: 'X', year: 1999 }] }).includes('Recently watched films:'));
});

ok('groq: parseTitles dedupes, tolerates wrappers, survives a missing year', () => {
  const parsed = groq.parseTitles('```json\n{"results":[{"title":"Spirited Away","year":2001},'
    + '{"title":"spirited away","year":2001},{"title":"My Neighbour Totoro"},'
    + '{"title":"","year":1999},{"year":2000}]}\n```');
  assert.deepStrictEqual(parsed, [
    { title: 'Spirited Away', year: 2001 },
    { title: 'My Neighbour Totoro', year: null }, // year is optional
  ]);
  assert.strictEqual(groq.parseTitles('[{"title":"A"},{"title":"B"}]', 1).length, 1); // limit honoured
});

ok('rebuild: judgement age is one year above the limit (off when no limit)', () => {
  assert.strictEqual(rebuild.judgementAge({ age_limit: 13 }), 14);
  assert.strictEqual(rebuild.judgementAge({ age_limit: 8 }), 9);
  assert.strictEqual(rebuild.judgementAge({}), 1); // callers only use this when age_limit > 0
});

ok('rebuild: aiPasses filters on TMDB fields (rating, votes, genres, recency)', () => {
  const filters = { min_rating: 6, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [] };
  const base = { releaseInfo: '2020', _vote_average: 7.5, _vote_count: 5000, _genre_names: ['Animation'], _original_language: 'en' };
  assert.strictEqual(rebuild.aiPasses(base, 'movie', filters), true);
  assert.strictEqual(rebuild.aiPasses({ ...base, _vote_average: 5.1 }, 'movie', filters), false);
  // Unrated is not "below the bar" — same semantics as the rest of the pipeline
  assert.strictEqual(rebuild.aiPasses({ ...base, _vote_average: 0 }, 'movie', filters), true);
  assert.strictEqual(rebuild.aiPasses({ ...base, _vote_count: 200 }, 'movie', filters), false);
  assert.strictEqual(rebuild.aiPasses({ ...base, _vote_count: 200 }, 'series', filters), true); // series use 1/5

  const noHorror = { ...filters, excluded_genres: ['Horror'] };
  assert.strictEqual(rebuild.aiPasses({ ...base, _genre_names: ['Horror'] }, 'movie', noHorror), false);
  // Anime is a pseudo-genre: Japanese + Animation, since TMDB has no such genre
  const noAnime = { ...filters, excluded_genres: ['Anime'] };
  assert.strictEqual(rebuild.aiPasses({ ...base, _original_language: 'ja' }, 'movie', noAnime), false);
  assert.strictEqual(rebuild.aiPasses(base, 'movie', noAnime), true); // English animation stays

  const recent = { ...filters, max_age_years: 5 };
  assert.strictEqual(rebuild.aiPasses({ ...base, releaseInfo: '1999' }, 'movie', recent), false);
});

ok('tmdb: seasonAppendGroups batches seasons into one call under the API cap', () => {
  // The whole point: a 10-season show must cost ONE request, not eleven.
  assert.deepStrictEqual(
    tmdb.seasonAppendGroups([0, 1, 2, 3]),
    ['season/0,season/1,season/2,season/3']
  );
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.strictEqual(tmdb.seasonAppendGroups(twenty).length, 1); // exactly at the cap
  const twentyFive = Array.from({ length: 25 }, (_, i) => i + 1);
  const groups = tmdb.seasonAppendGroups(twentyFive);
  assert.strictEqual(groups.length, 2); // ceil(25/20)
  assert.strictEqual(groups[1], 'season/21,season/22,season/23,season/24,season/25');
  assert.deepStrictEqual(tmdb.seasonAppendGroups([]), []);
});

ok('tmdb: buildVideos builds playable episode ids, sorts, flags unaired', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  const videos = tmdb.buildVideos([
    {
      id: 999, // non-season keys must be ignored
      'season/2': { episodes: [{ season_number: 2, episode_number: 1, name: 'Later', air_date: '2030-01-01' }] },
      'season/1': {
        episodes: [
          { season_number: 1, episode_number: 2, name: 'Two', air_date: '2020-05-02', still_path: '/s.jpg' },
          { season_number: 1, episode_number: 1, name: '', air_date: '2020-05-01' },
          { season_number: 1, episode_number: null, name: 'Junk' }, // no episode number -> dropped
        ],
      },
    },
  ], 'tt1234567', now);

  assert.deepStrictEqual(videos.map(v => v.id), [
    'tt1234567:1:1', 'tt1234567:1:2', 'tt1234567:2:1', // season then episode order
  ]);
  assert.strictEqual(videos[0].title, 'Episode 1'); // blank name gets a fallback
  assert.strictEqual(videos[1].thumbnail, 'https://image.tmdb.org/t/p/w500/s.jpg');
  assert.strictEqual(videos[0].released, '2020-05-01T00:00:00.000Z');
  assert.strictEqual(videos[0].available, true);
  assert.strictEqual(videos[2].available, false); // airs 2030 — not playable yet
  assert.deepStrictEqual(tmdb.buildVideos([], 'tt1', now), []);
});

ok('store: meta cache roundtrip, per-title files, TTL expiry', () => {
  store.saveMeta('series', 'tt0903747', { id: 'tt0903747', name: 'Cached', videos: [] }, 60000);
  assert.strictEqual(store.loadMeta('series', 'tt0903747').name, 'Cached');
  assert.strictEqual(store.loadMeta('movie', 'tt0903747'), null); // type-scoped
  assert.strictEqual(store.loadMeta('series', 'tt0000000'), null); // miss

  // Expired entries must not be served — a stale series meta means missing episodes
  store.saveMeta('movie', 'tt0111161', { id: 'tt0111161', name: 'Old' }, -1);
  assert.strictEqual(store.loadMeta('movie', 'tt0111161'), null);

  // ids come off the wire: path traversal must not escape the cache dir
  store.saveMeta('movie', '../../evil', { id: 'x' });
  assert.ok(fs.existsSync(path.join(store.DATA_DIR, 'cache', 'meta', 'movie-evil.json')));
});

ok('crypto: encrypt/decrypt roundtrip + tamper detection', () => {
  const cr = require('../src/services/crypto');
  assert.ok(cr.encryptionAvailable());
  const blob = cr.encrypt('hunter2');
  assert.ok(blob.startsWith('v1:') && !blob.includes('hunter2'));
  assert.strictEqual(cr.decrypt(blob), 'hunter2');
  // GCM auth tag must reject tampered ciphertext
  const parts = blob.split(':');
  parts[3] = Buffer.from('tampered-ciphertext').toString('base64');
  assert.throws(() => cr.decrypt(parts.join(':')));
});

ok('crypto: seal/unseal, marker, legacy plaintext passthrough', () => {
  const cr = require('../src/services/crypto');
  const sealed = cr.seal('tt-api-key');
  assert.ok(cr.isSealed(sealed) && sealed.startsWith('enc::') && !sealed.includes('tt-api-key'));
  assert.strictEqual(cr.unseal(sealed), 'tt-api-key');
  // legacy plaintext (no marker) passes through untouched
  assert.strictEqual(cr.unseal('plain-key'), 'plain-key');
  assert.strictEqual(cr.isSealed('plain-key'), false);
  // empty stays empty; seal is idempotent
  assert.strictEqual(cr.seal(''), '');
  assert.strictEqual(cr.seal(sealed), sealed);
  // wrong key can't unseal (GCM auth) -> throws so callers can lock
  const orig = process.env.SECRET_KEY;
  process.env.SECRET_KEY = 'a-different-key';
  assert.throws(() => cr.unseal(sealed));
  process.env.SECRET_KEY = orig;
});

ok('stremio: normalizeItems reads episode from video_id (not season/episode)', () => {
  const stremio = require('../src/services/stremio');
  const rows = [
    { _id: 'tt1375666', type: 'movie', state: { flaggedWatched: 1, lastWatched: '2026-07-01T00:00:00.000Z' } },
    { _id: 'tt0898266', type: 'series', state: { video_id: 'tt0898266:9:18', timesWatched: 3, lastWatched: '2026-07-10T00:00:00.000Z' } },
    { _id: 'tt0944947', type: 'series', state: { video_id: 'tt0944947:1:1', watched: 'AQ==:1', lastWatched: '' } }, // watched via bitfield, no date
    { _id: 'tt0000000', type: 'series', state: { video_id: 'tt0000000', timesWatched: 2 } }, // series id only -> skipped
    { _id: 'tt1111111', type: 'series', state: { video_id: 'tt1111111:2:5' } },              // not watched -> skipped
    { _id: 'kitsu:42', type: 'series', state: { video_id: 'kitsu:42:1:3', timesWatched: 1 } }, // non-tt -> skipped
  ];
  const out = stremio.normalizeItems(rows);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.find(x => x.imdbId === 'tt0898266'),
    { type: 'series', imdbId: 'tt0898266', season: 9, episode: 18, watchedAtMs: Date.parse('2026-07-10T00:00:00.000Z') });
  assert.ok(out.some(x => x.imdbId === 'tt0944947' && x.season === 1 && x.episode === 1 && x.watchedAtMs === 0));
  assert.ok(!out.some(x => x.imdbId === 'tt0000000')); // no episode pointer
  assert.ok(!out.some(x => x.imdbId === 'tt1111111')); // not watched
  assert.strictEqual(out.filter(x => x.type === 'movie').length, 1);
  // parseEpisode edge cases
  assert.deepStrictEqual(stremio.parseEpisode({ video_id: 'tt5:2:7' }), { season: 2, episode: 7 });
  assert.strictEqual(stremio.parseEpisode({ video_id: 'tt5' }), null);
  assert.strictEqual(stremio.parseEpisode({}), null);
});

ok('scrobble: computeDelta excludes already-on-Trakt, groups episodes', () => {
  const { computeDelta } = require('../src/services/scrobble');
  const items = [
    { type: 'movie', imdbId: 'tt1', watchedAtMs: 1700000000000 }, // already watched -> dropped
    { type: 'movie', imdbId: 'tt2', watchedAtMs: 0 },             // new, no date
    { type: 'movie', imdbId: 'tt3', watchedAtMs: 1700000000000 }, // new, dated
    { type: 'series', imdbId: 'tt9', season: 1, episode: 2 },     // already watched -> dropped
    { type: 'series', imdbId: 'tt9', season: 1, episode: 3 },     // new
  ];
  const body = computeDelta(items, new Set(['tt1']), new Set(['tt9:1:2']));
  assert.deepStrictEqual(body.movies.map(m => m.ids.imdb).sort(), ['tt2', 'tt3']);
  assert.strictEqual(body.movies.find(m => m.ids.imdb === 'tt2').watched_at, undefined); // 0 omitted
  assert.ok(body.movies.find(m => m.ids.imdb === 'tt3').watched_at.startsWith('20')); // ISO present
  assert.strictEqual(body.shows.length, 1);
  assert.strictEqual(body.shows[0].ids.imdb, 'tt9');
  assert.deepStrictEqual(body.shows[0].seasons[0].episodes.map(e => e.number), [3]);
  // nothing missing -> null
  assert.strictEqual(computeDelta(items, new Set(['tt1', 'tt2', 'tt3']), new Set(['tt9:1:2', 'tt9:1:3'])), null);
  // full rebuild = empty exclusion sets -> everything is pushed (nothing dropped)
  const fullBody = computeDelta(items, new Set(), new Set());
  assert.deepStrictEqual(fullBody.movies.map(m => m.ids.imdb).sort(), ['tt1', 'tt2', 'tt3']);
  assert.deepStrictEqual(fullBody.shows[0].seasons[0].episodes.map(e => e.number).sort(), [2, 3]);
});

ok('config: scrobble defaults, migration, provider whitelist', () => {
  const p = config.addProfile('ScrobbleCfg');
  assert.strictEqual(p.scrobble.enabled, false);
  assert.strictEqual(p.scrobble.provider, 'nuvio');
  assert.strictEqual(p.scrobble.password_enc, '');
  config.updateProfile(p.id, { scrobble: { enabled: true, provider: 'stremio', email: 'a@b.c', password_enc: 'v1:x:y:z', nuvio_profile_index: '3', nuvio_profile_name: 'Kid' } });
  const p2 = config.getProfile(p.id);
  assert.strictEqual(p2.scrobble.enabled, true);
  assert.strictEqual(p2.scrobble.provider, 'stremio');
  assert.strictEqual(p2.scrobble.email, 'a@b.c');
  assert.strictEqual(p2.scrobble.nuvio_profile_index, 3); // coerced to int
  config.updateProfile(p.id, { scrobble: { provider: 'bogus' } }); // unknown provider ignored
  assert.strictEqual(config.getProfile(p.id).scrobble.provider, 'stremio');
  config.removeProfile(p.id);
});

ok('config: secrets sealed on disk, plaintext in memory, locked mode recovers', () => {
  const fs = require('fs'); const path = require('path');
  const file = path.join(process.env.DATA_DIR, 'profiles.json');
  const p = config.addProfile('SecretsTest');
  config.updateProfile(p.id, { keys: { tmdb_api_key: 'plain-tmdb-123', groq_api_key: 'plain-groq-456' } });
  // On disk: sealed (enc::), plaintext never written
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('plain-tmdb-123') && !raw.includes('plain-groq-456'), 'plaintext must not hit disk');
  const onDisk = JSON.parse(raw).profiles.find((x) => x.id === p.id);
  assert.ok(onDisk.keys.tmdb_api_key.startsWith('enc::'), 'stored key is sealed');
  assert.strictEqual(onDisk.token, config.getProfile(p.id).token); // install token left plaintext
  // In memory: plaintext
  assert.strictEqual(config.getProfile(p.id).keys.tmdb_api_key, 'plain-tmdb-123');

  // Locked mode: wrong key -> secrets blank, lock flagged, writes refused, disk intact
  const orig = process.env.SECRET_KEY;
  const cipher = onDisk.keys.tmdb_api_key;
  process.env.SECRET_KEY = 'a-completely-different-key';
  assert.strictEqual(config.getProfile(p.id).keys.tmdb_api_key, '', 'secret blanked under wrong key');
  assert.strictEqual(config.secretsLocked(), true);
  assert.throws(() => config.updateProfile(p.id, { name: 'nope' }), /locked/i);
  assert.strictEqual(fs.readFileSync(file, 'utf8').includes(cipher), true, 'ciphertext preserved on disk');
  // Restore key -> full recovery
  process.env.SECRET_KEY = orig;
  assert.strictEqual(config.getProfile(p.id).keys.tmdb_api_key, 'plain-tmdb-123');
  assert.strictEqual(config.secretsLocked(), false);
  config.removeProfile(p.id);
});

// ---- HTTP surface ----
console.log('http:');
require('../src/server');
const BASE = `http://localhost:${process.env.PORT}`;

async function httpTests() {
  // Async unit check: fully-cached CSM lookups must answer without network
  // (the dummy key would fail loudly on any request).
  const mdblist = require('../src/services/mdblist');
  store.saveCsmCache({
    'movie:tt50': { age: 8, at: Date.now() },
    'movie:tt51': { age: null, at: Date.now() }, // unrated is cached too
  });
  const ages = await mdblist.commonSenseAges('dummy-key', 'movie', ['tt50', 'tt51']);
  assert.strictEqual(ages.get('tt50'), 8);
  assert.strictEqual(ages.get('tt51'), null);
  store.saveCsmCache({});
  console.log('  ✓ CSM disk cache answers without network');

  // v5: the CSM gate is retired. A kids profile with NO MDBList key must pass
  // straight through instead of throwing — its anime coverage was so thin that
  // "unrated" was the common case, which emptied whole catalogs. The AI gate
  // is the sole age authority now.
  const kidsNoMdb = { filters: { age_limit: 8 }, keys: {} };
  const through = await rebuild.applyCsmGate(
    [{ id: 'tt60', name: 'Unrated By CSM' }], 'series', kidsNoMdb, { log() {} },
  );
  assert.deepStrictEqual(through.map(m => m.id), ['tt60']);
  console.log('  ✓ CSM gate retired — no longer drops unrated titles or needs MDBList');

  // Hard requirement: no Groq key -> AI catalogs are disabled before any
  // network call (fake trakt_auth would explode if Trakt were contacted).
  const rebuildMod = require('../src/rebuild');
  const noGroq = {
    id: 'no-groq-test', name: 'NoGroq', keys: {},
    trakt_auth: { access_token: 'fake' }, filters: { age_limit: 8 }, catalogs: {},
  };
  const res0 = await rebuildMod.rebuildProfile(noGroq, { log() {}, warn() {}, error() {} }, { extras: false });
  assert.ok(res0.movie.error.includes('Groq API key missing'));
  assert.ok(res0.series.error.includes('kids-mode'));
  store.deleteCache('no-groq-test');
  console.log('  ✓ kids profile without Groq key disabled (no network)');

  // Extra-catalog age gate: adult profiles untouched (no LLM), kids profiles
  // without a Groq key FAIL CLOSED (caller keeps the previous list rather than
  // publishing an unvetted one). No network in either path.
  const def = require('../src/catalogs').getExtra('mdb-kids-movies');
  const metas = [{ id: 'tt1', name: 'A' }, { id: 'tt2', name: 'B' }];
  const quiet = { log() {}, warn() {} };
  assert.deepStrictEqual(
    await rebuildMod.applyExtraAgeGate({ name: 'Adult', filters: { age_limit: 0 }, keys: {} }, def, metas, quiet),
    metas); // no age limit -> passthrough
  await assert.rejects(
    () => rebuildMod.applyExtraAgeGate({ name: 'Kid', filters: { age_limit: 8 }, keys: {} }, def, metas, quiet),
    /Groq API key missing/);
  console.log('  ✓ extra-catalog age gate: passthrough for adults, fail-closed for kids');

  await new Promise(r => setTimeout(r, 400)); // let server bind

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.strictEqual(health.ok, true);
  console.log('  ✓ /health');

  const pkgVersion = require('../package.json').version;
  const ver = await (await fetch(`${BASE}/api/version`)).json();
  assert.strictEqual(ver.version, pkgVersion);
  console.log('  ✓ /api/version matches package.json');

  const genres = await (await fetch(`${BASE}/api/genres`)).json();
  assert.ok(genres.genres.includes('Horror') && genres.genres.includes('Kids'));
  console.log('  ✓ /api/genres');

  // Create a profile through the API
  let res = await fetch(`${BASE}/api/profiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SmokeTest' }),
  });
  const { profile } = await res.json();
  assert.ok(profile.token);
  console.log('  ✓ POST /api/profiles');

  // Manifest via install token — AI catalogs + default-on Watch Later
  const manifest = await (await fetch(`${BASE}/addon/${profile.token}/manifest.json`)).json();
  assert.strictEqual(manifest.version, pkgVersion); // manifest version from package.json
  // An empty Watch Later is dropped rather than advertised as a permanent
  // "warming up" row — its list mirrors the Trakt watchlist, so empty is a
  // real and lasting state, not a pending one.
  assert.deepStrictEqual(
    manifest.catalogs.map(c => c.id),
    ['ai-recs-movies', 'ai-recs-series', 'ai-search-movies', 'ai-search-series']
  );
  assert.strictEqual(manifest.catalogs[0].name, 'Movies recommended for you');
  assert.deepStrictEqual(manifest.catalogs[2].extraRequired, ['search']); // search-only catalog
  assert.ok(manifest.name.includes('SmokeTest'));
  // ...and it comes back once the watchlist actually has something in it
  store.swapExtra(profile.id, 'trakt-watchlist-movies', [{ id: 'tt0111161', type: 'movie', name: 'Later' }]);
  const withLater = await (await fetch(`${BASE}/addon/${profile.token}/manifest.json`)).json();
  assert.ok(withLater.catalogs.some(c => c.id === 'trakt-watchlist-movies'));
  assert.ok(!withLater.catalogs.some(c => c.id === 'trakt-watchlist-series')); // still empty
  // A client holding a cached manifest may still ask for the empty one:
  // answer with nothing, not a warming-up card.
  const emptyLater = await (await fetch(`${BASE}/addon/${profile.token}/catalog/series/trakt-watchlist-series.json`)).json();
  assert.deepStrictEqual(emptyLater.metas, []);
  store.swapExtra(profile.id, 'trakt-watchlist-movies', []); // restore for later assertions
  // meta is what lets a device drop the third-party metadata addon that was
  // answering search unfiltered next to our gated results
  assert.deepStrictEqual(manifest.resources, ['catalog', 'meta']);
  console.log('  ✓ /addon/:token/manifest.json (Watch Later on by default, serves meta)');

  // Admin portal API exposes full key values (for pre-filled inputs)
  const listed = (await (await fetch(`${BASE}/api/profiles`)).json()).profiles.find(pp => pp.id === profile.id);
  assert.strictEqual(listed.keys.rpdb_api_key, 't0-free-rpdb'); // default pre-fill
  assert.ok('tmdb_api_key' in listed.keys && 'mdblist_api_key' in listed.keys);
  console.log('  ✓ profile API exposes full keys for portal pre-fill');

  // Unknown token -> 404
  res = await fetch(`${BASE}/addon/deadbeef/manifest.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ unknown token rejected');

  // Empty cache -> warming-up card, short client cache
  let cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas.length, 1);
  assert.ok(cat.metas[0].name.includes('warming up') || cat.metas[0].name.includes('List warming up'));
  assert.strictEqual(cat.cacheMaxAge, 300);
  console.log('  ✓ empty cache serves warming-up card');

  // Seed cache, then catalog serves it instantly
  store.swapCatalog(profile.id, 'movie', [
    { id: 'tt0111161', type: 'movie', name: 'Test Movie', poster: null, description: '', releaseInfo: '2024' },
  ], [], 'llm');
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas[0].id, 'tt0111161');
  assert.strictEqual(cat.cacheMaxAge, 3600); // short hint so pruned lists appear fast
  assert.strictEqual(cat.staleRevalidate, 43200);
  console.log('  ✓ seeded cache served with SWR headers');

  // ---- Metadata service ----
  // Seed the meta cache so this stays a no-network test.
  store.saveMeta('series', 'tt0944947', {
    id: 'tt0944947', type: 'series', name: 'Seeded Show',
    videos: [{ id: 'tt0944947:1:1', season: 1, episode: 1, title: 'Pilot', available: true }],
  }, 3600e3);
  let meta = await (await fetch(`${BASE}/addon/${profile.token}/meta/series/tt0944947.json`)).json();
  assert.strictEqual(meta.meta.id, 'tt0944947');
  assert.strictEqual(meta.meta.videos[0].id, 'tt0944947:1:1'); // episodes = playable
  assert.strictEqual(meta.cacheMaxAge, 43200);
  console.log('  ✓ /meta/:type/:id.json serves cached meta with episodes');

  // Non-tt ids and unknown types are ours to reject, not to guess at
  res = await fetch(`${BASE}/addon/${profile.token}/meta/series/kitsu:123.json`);
  assert.strictEqual(res.status, 404);
  res = await fetch(`${BASE}/addon/${profile.token}/meta/channel/tt0944947.json`);
  assert.strictEqual(res.status, 404);
  // No TMDB key configured -> 404 rather than a hang or a 500
  res = await fetch(`${BASE}/addon/${profile.token}/meta/movie/tt0111161.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ meta rejects non-tt ids, unknown types, missing key');

  // RPDB: setting a key rewrites poster URLs at serve time (no rebuild)
  await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: { rpdb_api_key: 't0-testkey' } }),
  });
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas[0].poster, 'https://api.ratingposterdb.com/t0-testkey/imdb/poster-default/tt0111161.jpg?fallback=true');
  console.log('  ✓ RPDB poster substitution at serve time');

  // Serve-time watched pruning: watched snapshot removes titles immediately
  store.saveWatched(profile.id, 'movie', { imdbIds: new Set(['tt0111161']), tmdbIds: new Set() });
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas.length, 0);
  console.log('  ✓ serve-time watched pruning');
  store.saveWatched(profile.id, 'movie', { imdbIds: new Set(), tmdbIds: new Set() });

  // Cross-type pruning: a title Trakt logged as a SHOW never shows in the
  // movie catalog either (IMDb IDs are global; Trakt/TMDB types can disagree)
  store.saveWatched(profile.id, 'series', { imdbIds: new Set(['tt0111161']), tmdbIds: new Set() });
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas.length, 0);
  console.log('  ✓ cross-type serve-time pruning');
  store.saveWatched(profile.id, 'series', { imdbIds: new Set(), tmdbIds: new Set() });

  // Diagnose endpoint requires Trakt auth
  res = await fetch(`${BASE}/api/profiles/${profile.id}/diagnose`);
  assert.strictEqual(res.status, 400);
  console.log('  ✓ diagnose without Trakt auth rejected cleanly');

  // Age-limit + list-size filters persist and clamp
  res = await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { age_limit: 8, list_size: 999 } }),
  });
  const f = (await res.json()).profile.filters;
  assert.strictEqual(f.age_limit, 8);
  assert.strictEqual(f.list_size, 50); // clamped to max
  console.log('  ✓ age limit + list size persisted (clamped)');

  // Pagination extra: skip past end -> empty
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies/skip=20.json`)).json();
  assert.deepStrictEqual(cat.metas, []);
  console.log('  ✓ skip pagination');

  // Filters update via API
  res = await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { min_rating: 8, max_age_years: 0, excluded_genres: ['Horror', 'Reality'] } }),
  });
  const updated = (await res.json()).profile;
  assert.strictEqual(updated.filters.min_rating, 8);
  assert.deepStrictEqual(updated.filters.excluded_genres, ['Horror', 'Reality']);
  console.log('  ✓ PUT /api/profiles/:id filters');

  // Rebuild without Trakt auth -> clean 400
  res = await fetch(`${BASE}/api/profiles/${profile.id}/rebuild`, { method: 'POST' });
  assert.strictEqual(res.status, 400);
  console.log('  ✓ rebuild without Trakt auth rejected cleanly');

  // ---- Extra catalogs (second profile keeps earlier assertions intact) ----
  const defs = await (await fetch(`${BASE}/api/catalogs`)).json();
  assert.strictEqual(defs.catalogs.length, 11);
  assert.ok(defs.catalogs.some(c => c.id === 'mdb-popular-series' && c.type === 'series'));
  assert.ok(defs.catalogs.some(c => c.id === 'trakt-anime-teen-series' && c.source === 'trakt_list'));
  assert.ok(defs.catalogs.some(c => c.id === 'trakt-watchlist-movies' && c.source === 'trakt_watchlist' && c.default_on === true));
  console.log('  ✓ GET /api/catalogs lists extra-catalog definitions');

  res = await fetch(`${BASE}/api/profiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ExtraCats' }),
  });
  const p2 = (await res.json()).profile;

  // Disabled extra catalog -> 404 even though the id is known
  res = await fetch(`${BASE}/addon/${p2.token}/catalog/movie/mdb-action-movies.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ disabled extra catalog rejected');

  // Enable two extras (no MDBList key set -> no background build/network)
  res = await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogs: { 'mdb-action-movies': true, 'mdb-popular-series': true } }),
  });
  const p2u = (await res.json()).profile;
  assert.deepStrictEqual(p2u.catalogs, { 'mdb-action-movies': true, 'mdb-popular-series': true });
  console.log('  ✓ PUT /api/profiles/:id catalogs persisted');

  // Manifest advertises AI + enabled extras. Watch Later is default-on but
  // empty here, so it's dropped; MDBList extras are kept while empty (empty
  // there means not-built-yet, and the warming-up card is the right answer).
  const man2 = await (await fetch(`${BASE}/addon/${p2.token}/manifest.json`)).json();
  assert.deepStrictEqual(
    man2.catalogs.map(c => c.id),
    // AI first, then extras in registry order (stable regardless of toggle order)
    ['ai-recs-movies', 'ai-recs-series', 'mdb-popular-series', 'mdb-action-movies', 'ai-search-movies', 'ai-search-series']
  );
  assert.strictEqual(man2.catalogs.find(c => c.id === 'mdb-popular-series').type, 'series');
  console.log('  ✓ manifest includes enabled extra catalogs');

  // Age-banded catalog: enabled on an 8+ profile, it must be absent from the
  // manifest AND refused at the catalog route — a client holding a cached
  // manifest must not keep pulling a TV-14 list after the limit is lowered.
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { age_limit: 8 }, catalogs: { 'trakt-anime-teen-series': true } }),
  });
  let man3 = await (await fetch(`${BASE}/addon/${p2.token}/manifest.json`)).json();
  assert.ok(!man3.catalogs.some(c => c.id === 'trakt-anime-teen-series'));
  res = await fetch(`${BASE}/addon/${p2.token}/catalog/series/trakt-anime-teen-series.json`);
  assert.strictEqual(res.status, 404);
  // Raise the limit to 13+ and it becomes available
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { age_limit: 13 }, catalogs: { 'trakt-anime-teen-series': true } }),
  });
  man3 = await (await fetch(`${BASE}/addon/${p2.token}/manifest.json`)).json();
  assert.ok(man3.catalogs.some(c => c.id === 'trakt-anime-teen-series'));
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { age_limit: 0 }, catalogs: {} }), // restore
  });
  console.log('  ✓ TV-14 catalog hidden and refused below its age band');

  // Watch Later without Trakt: dropped from the manifest, and answers empty
  // rather than a card. The card told users to connect Trakt, but the row it
  // appeared on no longer exists — the configure portal is where that state is
  // surfaced now.
  let wcat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/trakt-watchlist-movies.json`)).json();
  assert.deepStrictEqual(wcat.metas, []);
  console.log('  ✓ empty Watch Later serves nothing, not a placeholder card');

  // Watch Later IS pruned by watched status (unlike curated extras)
  store.swapExtra(p2.id, 'trakt-watchlist-movies', [
    { id: 'tt0111161', type: 'movie', name: 'Seen Pick', poster: null, description: '', releaseInfo: '2020' },
    { id: 'tt0068646', type: 'movie', name: 'Unseen Pick', poster: null, description: '', releaseInfo: '1972' },
  ]);
  store.saveWatched(p2.id, 'movie', { imdbIds: new Set(['tt0111161']), tmdbIds: new Set() });
  wcat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/trakt-watchlist-movies.json`)).json();
  assert.deepStrictEqual(wcat.metas.map(m => m.id), ['tt0068646']);
  console.log('  ✓ Watch Later prunes watched titles at serve time');
  store.saveWatched(p2.id, 'movie', { imdbIds: new Set(), tmdbIds: new Set() });

  // Watch Later toggled off -> 404 (explicit false beats default-on)
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogs: { 'trakt-watchlist-movies': false, 'mdb-action-movies': true, 'mdb-popular-series': true } }),
  });
  res = await fetch(`${BASE}/addon/${p2.token}/catalog/movie/trakt-watchlist-movies.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ Watch Later opt-out rejected with 404');

  // Enabled but not built yet -> warming card mentioning the MDBList key
  let ecat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/mdb-action-movies.json`)).json();
  assert.strictEqual(ecat.metas.length, 1);
  assert.ok(ecat.metas[0].description.includes('MDBList'));
  console.log('  ✓ unbuilt extra catalog serves setup card');

  // Seeded extra catalog is served, and watched status does NOT prune it
  store.swapExtra(p2.id, 'mdb-action-movies', [
    { id: 'tt0111161', type: 'movie', name: 'Action Pick', poster: null, description: '', releaseInfo: '2020' },
  ]);
  store.saveWatched(p2.id, 'movie', { imdbIds: new Set(['tt0111161']), tmdbIds: new Set() });
  ecat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/mdb-action-movies.json`)).json();
  assert.strictEqual(ecat.metas.length, 1); // watched, but extras ignore watched status
  assert.strictEqual(ecat.metas[0].id, 'tt0111161');
  console.log('  ✓ extra catalog served from cache, watched status ignored');

  // Wrong type for a known extra id -> 404
  res = await fetch(`${BASE}/addon/${p2.token}/catalog/series/mdb-action-movies.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ extra catalog type mismatch rejected');

  // Async rebuild: endpoint answers 202 immediately (no held-open response —
  // proxies kill those), then status.rebuilding flips false and last_results
  // carries the per-catalog outcomes. This profile has extras enabled but no
  // keys, so the rebuild finishes instantly with recorded errors, no network.
  res = await fetch(`${BASE}/api/profiles/${p2.id}/rebuild`, { method: 'POST' });
  assert.strictEqual(res.status, 202);
  assert.strictEqual((await res.json()).started, true);
  let st = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 50));
    const { profiles } = await (await fetch(`${BASE}/api/profiles`)).json();
    st = profiles.find(p => p.id === p2.id).status;
    if (!st.rebuilding && st.last_results) break;
  }
  assert.ok(st.last_results, 'last_results recorded after rebuild');
  const lr = st.last_results.results;
  assert.strictEqual(lr.movie.ok, false); // Trakt not connected
  assert.ok(/MDBList/i.test(lr['mdb-action-movies'].error)); // extras need a key
  console.log('  ✓ async rebuild: 202 + polled status carries results');

  await fetch(`${BASE}/api/profiles/${p2.id}`, { method: 'DELETE' });

  // Auto-scrobble: saving a password encrypts it (never round-trips plaintext),
  // and password_set is exposed without the value.
  res = await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scrobble: { provider: 'stremio', email: 'm@ex.com', password: 'secret-pw' } }),
  });
  const sc = (await res.json()).profile.scrobble;
  assert.strictEqual(sc.provider, 'stremio');
  assert.strictEqual(sc.email, 'm@ex.com');
  assert.strictEqual(sc.password_set, true);
  assert.strictEqual(sc.password, undefined); // password never returned
  // Stored value is ciphertext, not the plaintext
  const raw = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'profiles.json'), 'utf8');
  assert.ok(!raw.includes('secret-pw') && raw.includes('v1:'));
  console.log('  ✓ scrobble password stored encrypted, never returned');

  // Enabling without a usable credential is rejected
  res = await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scrobble: { enabled: true, password: null } }), // clears pw + enables
  });
  assert.strictEqual(res.status, 400);
  console.log('  ✓ scrobble enable without credentials rejected');

  // ---- Search catalogs (no-network paths) ----
  // Short/missing query -> empty result set, no external calls
  let scat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-search-movies/search=a.json`)).json();
  assert.deepStrictEqual(scat.metas, []);
  // No TMDB key on the profile -> empty (guard runs before any fetch)
  scat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-search-movies/search=batman.json`)).json();
  assert.deepStrictEqual(scat.metas, []);
  console.log('  ✓ search: short query + missing TMDB key fail safe (empty)');
  // Wrong type for a search catalog -> 404
  res = await fetch(`${BASE}/addon/${profile.token}/catalog/series/ai-search-movies/search=batman.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ search: type mismatch rejected');

  // Portal page served
  const html = await (await fetch(`${BASE}/configure/`)).text();
  assert.ok(html.includes('AI Recommender'));
  console.log('  ✓ /configure/ portal served');

  console.log(`\nAll checks passed (${passed} unit + 40 async/http).`);
  process.exit(0);
}

httpTests().catch(err => {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
});
