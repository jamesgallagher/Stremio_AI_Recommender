// Smoke test: no network calls — exercises store, filters, prompt/parse logic,
// genre mapping, and the HTTP surface with a seeded cache.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-test-' + Date.now();
process.env.PORT = '7311';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
// Hermetic: src/server requires dotenv, which loads a developer's real .env when
// present. Pin the vars the tests assume (empty, not deleted — dotenv won't
// override an already-set var): admin creds OFF (open portal), and no
// EXTERNAL_URL so install/dnr links use the request host (localhost:7311).
process.env.ADMIN_USER = '';
process.env.ADMIN_PASSWORD = '';
process.env.EXTERNAL_URL = '';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const config = require('../src/config');
const rebuild = require('../src/rebuild');
const groq = require('../src/services/groq');
const tmdb = require('../src/services/tmdb');
const serveCalibration = require('../src/serveCalibration');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
// Async unit tests (e.g. the AGE-1 decision chain): the promise is collected and
// awaited at the top of the HTTP section, so a failure still fails the run and the
// pass count lands in `passed`.
const asyncPending = [];
function okAsync(name, fn) {
  asyncPending.push(new Promise((resolve, reject) => {
    Promise.resolve(fn()).then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
      resolve();
    }, reject);
  }));
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

ok('catalogs: registry, defaults, and per-source requirements', () => {
  const catalogs = require('../src/catalogs');
  assert.strictEqual(catalogs.EXTRA_CATALOGS.length, 14); // v6 registry: 2 Watch Later + 12 curated
  // New genre lists from the overhaul are present
  assert.ok(catalogs.getExtra('mdb-romcom-movies') && catalogs.getExtra('mdb-war-movies') && catalogs.getExtra('mdb-horror-movies'));
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
  // Watch Later: default ON, Simkl plan-to-watch sourced, first among extras
  const wl = catalogs.getExtra('trakt-watchlist-movies');
  assert.strictEqual(wl.source, 'simkl_plantowatch');
  assert.strictEqual(wl.default_on, true);
  // WL-KW: both Watch Later rows KEEP watched titles (dedupe_watched:false), the
  // same opt-out Christmas uses — a hand-added plan-to-watch title must not be
  // silently pruned because it's also in the watched store.
  assert.strictEqual(wl.dedupe_watched, false);
  assert.strictEqual(catalogs.getExtra('trakt-watchlist-series').dedupe_watched, false);
  assert.deepStrictEqual(ids.slice(0, 2), ['trakt-watchlist-movies', 'trakt-watchlist-series']);
  // Default-on semantics: absent = on for watchlist, off for curated lists
  assert.deepStrictEqual(catalogs.enabledExtras({}).map(d => d.id),
    ['trakt-watchlist-movies', 'trakt-watchlist-series']);
  assert.deepStrictEqual(
    catalogs.enabledExtras({ catalogs: { 'mdb-action-movies': true, 'trakt-watchlist-movies': false } }).map(d => d.id),
    ['trakt-watchlist-series', 'mdb-action-movies']); // explicit false opts out of a default-on
  // Requirements: Watch Later needs Simkl OAuth; curated lists need the MDBList
  // key; a PUBLIC Trakt list needs only the client id (it isn't our data)
  assert.strictEqual(catalogs.requirementMet({ keys: {}, simkl_auth: { access_token: 't' } }, wl), true);
  assert.strictEqual(catalogs.requirementMet({ keys: { mdblist_api_key: 'k' }, simkl_auth: null }, wl), false);
  assert.strictEqual(catalogs.requirementMet({ keys: { mdblist_api_key: 'k' } }, catalogs.getExtra('mdb-action-movies')), true);
  const anime = catalogs.getExtra('trakt-anime-teen-series');
  assert.strictEqual(anime.source, 'mdblist'); // v6: snoak/trending-anime-shows on MDBList
  assert.strictEqual(anime.type, 'series');
  assert.strictEqual(anime.target, 50);
  assert.strictEqual(anime.min_imdb, 6);   // list's imdb_ratings=6-10
  assert.strictEqual(anime.min_profile_age, 13); // TV-14 band
  assert.ok(!anime.default_on);
  assert.strictEqual(catalogs.requirementMet({ keys: { mdblist_api_key: 'k' } }, anime), true);
  assert.strictEqual(catalogs.requirementMet({ keys: {} }, anime), false);

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
  assert.ok(!('rating_source' in p.filters)); // retired in v6.34 — floor always prefers IMDb
  assert.strictEqual(p.keys.rpdb_api_key, 't0-free-rpdb'); // free RPDB key pre-set
  assert.strictEqual(p.filters.age_limit, 0); // age gate off by default
  assert.strictEqual(p.filters.list_size, 20); // fill-to-quota default
  assert.strictEqual(p.filters.engine_movie, 'genesis');  // v7: per-type engine, defaults to the original engine
  assert.strictEqual(p.filters.engine_series, 'genesis'); // Movies + Series each default to Genesis
  assert.ok(!('engine' in p.filters));                    // v5 single-engine field retired
  assert.strictEqual(p.filters.title_decay_enabled, false); // v6.37: title decay is opt-in, off by default
  assert.strictEqual(p.filters.title_decay_days, 60); // default sustained-visibility window when enabled
  config.updateProfile(p.id, { filters: { min_rating: -3, excluded_genres: ['Horror'] } });
  const p2 = config.getProfile(p.id);
  assert.strictEqual(p2.filters.min_rating, 0); // clamped

  // v7: per-type engine choice validated against the registry. A known id
  // persists per type; an unknown id (or the retired 'trakt'/'ai') falls back to
  // Genesis — never a disabled type. (Age-gating of unrestricted engines has its
  // own test below.)
  config.updateProfile(p.id, { filters: { engine_movie: 'genesis', engine_series: 'genesis' } });
  assert.strictEqual(config.getProfile(p.id).filters.engine_movie, 'genesis');
  assert.strictEqual(config.getProfile(p.id).filters.engine_series, 'genesis');
  config.updateProfile(p.id, { filters: { engine_movie: 'skynet', engine_series: 'trakt' } });
  assert.strictEqual(config.getProfile(p.id).filters.engine_movie, 'genesis');  // unknown id → Genesis
  assert.strictEqual(config.getProfile(p.id).filters.engine_series, 'genesis'); // retired id → Genesis

  // Title decay (v6.37): enabled coerces to a bool; the window clamps to 14–365
  // (a sub-8-day window could never fire against the 8-distinct-day floor).
  config.updateProfile(p.id, { filters: { title_decay_enabled: 1, title_decay_days: 5 } });
  const pd1 = config.getProfile(p.id).filters;
  assert.strictEqual(pd1.title_decay_enabled, true); // truthy -> true
  assert.strictEqual(pd1.title_decay_days, 14);      // clamped up to the floor
  config.updateProfile(p.id, { filters: { title_decay_enabled: 0, title_decay_days: 9999 } });
  const pd2 = config.getProfile(p.id).filters;
  assert.strictEqual(pd2.title_decay_enabled, false); // falsy -> false
  assert.strictEqual(pd2.title_decay_days, 365);      // clamped down to the ceiling

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

ok('config: legacy `engine` → per-type engine_movie/engine_series migration + I7 age-gating of unrestricted engines (SC-02)', () => {
  const engines = require('../src/engines');
  const store = require('../src/store');

  // ---- Migration. A pre-v7 profile carries the retired single `engine` field
  //      and NO per-type fields. On load it upgrades: `engine` dropped, both
  //      types default to Genesis. Seed the raw file (filters aren't sealed).
  const legacy = config.addProfile('Legacy');
  {
    const data = store.loadProfiles();
    const raw = data.profiles.find((x) => x.id === legacy.id);
    raw.filters.engine = 'trakt';     // resurrect the dead field
    delete raw.filters.engine_movie;  // simulate a pre-v7 shape
    delete raw.filters.engine_series;
    store.saveProfiles(data);
  }
  const migrated = config.getProfile(legacy.id).filters;
  assert.strictEqual(migrated.engine_movie, 'genesis');
  assert.strictEqual(migrated.engine_series, 'genesis');
  assert.ok(!('engine' in migrated)); // legacy field gone on read…
  config.updateProfile(legacy.id, { name: 'Legacy' }); // …and not re-persisted after the next write
  assert.ok(!('engine' in store.loadProfiles().profiles.find((x) => x.id === legacy.id).filters));

  // ---- Age-gating (I7) at the WRITE boundary, using a registered unrestricted stub.
  const dispose = engines._register({
    id: 'open-stub', name: 'Open', description: 't', supportedTypes: ['movie', 'series'],
    capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: true },
    requirements: () => ({ ok: true, missing: [] }), generate: async () => [],
  });
  try {
    // Adult profile (age_limit 0): the open stub is a legal selection and persists.
    config.updateProfile(legacy.id, { filters: { engine_movie: 'open-stub' } });
    assert.strictEqual(config.getProfile(legacy.id).filters.engine_movie, 'open-stub');
    // Selecting it on an age-limited profile coerces to Genesis (never open content on a kid).
    const kid = config.addProfile('Kid');
    config.updateProfile(kid.id, { filters: { age_limit: 12, engine_series: 'open-stub' } });
    assert.strictEqual(config.getProfile(kid.id).filters.engine_series, 'genesis');
    // RAISING age_limit on a profile already holding the stub REVOKES it → Genesis,
    // even though engine_movie isn't in this patch (§5.5 point 3).
    config.updateProfile(legacy.id, { filters: { age_limit: 5 } });
    assert.strictEqual(config.getProfile(legacy.id).filters.engine_movie, 'genesis');
    config.removeProfile(kid.id);
  } finally { dispose(); }
  config.removeProfile(legacy.id);
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

ok('tmdb: pickCertification prefers AU, then US, then any (movie + tv)', () => {
  const t = require('../src/services/tmdb');
  // Movie release_dates: AU wins over US
  const movie = [
    { iso_3166_1: 'US', release_dates: [{ certification: 'R' }] },
    { iso_3166_1: 'AU', release_dates: [{ certification: 'MA15+' }] },
  ];
  assert.strictEqual(t.pickCertification(movie, 'movie'), 'MA15+');
  // No AU -> US
  assert.strictEqual(t.pickCertification([{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }], 'movie'), 'PG-13');
  // TV uses .rating; AU preferred
  const tv = [{ iso_3166_1: 'US', rating: 'TV-14' }, { iso_3166_1: 'AU', rating: 'M' }];
  assert.strictEqual(t.pickCertification(tv, 'tv'), 'M');
  // Neither AU nor US -> first non-empty
  assert.strictEqual(t.pickCertification([{ iso_3166_1: 'GB', rating: '15' }], 'tv'), '15');
  assert.strictEqual(t.pickCertification([], 'movie'), null);
  assert.strictEqual(t.pickCertification(undefined, 'tv'), null);
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

ok('animeMap: index handles franchise arrays and { tv, movie } tmdb objects', () => {
  const animeMap = require('../src/services/animeMap');
  // Fribb collapses multi-part franchises into ONE entry, so imdb_id and
  // themoviedb_id can be arrays. Indexing only the scalar silently resolves
  // the wrong part — this is the trap aiometadata warns about.
  const built = animeMap.buildIndex([
    { mal_id: 1, imdb_id: ['tt1', 'tt2', 'tt3'], themoviedb_id: { movie: [10, 11] }, kitsu_id: 5, type: 'movie' },
    { mal_id: 2, imdb_id: 'tt9', themoviedb_id: { tv: 20 }, anilist_id: 7 },
    { mal_id: 3, imdb_id: null, themoviedb_id: 30 },
    { imdb_id: 'tt404' }, // no mal id -> not indexed, nothing to look up by
  ]);
  assert.strictEqual(built.count, 3);
  animeMap._setIndex({ at: Date.now(), etag: 'x', byImdb: built.byImdb, byTmdb: built.byTmdb });

  assert.strictEqual(animeMap.lookup('tt3', null).mal, 1); // every part resolves
  assert.strictEqual(animeMap.lookup('tt1', null).kitsu, 5);
  assert.strictEqual(animeMap.lookup(null, 11).mal, 1);
  assert.strictEqual(animeMap.lookup(null, 20).anilist, 7);
  assert.strictEqual(animeMap.lookup(null, 30).mal, 3); // imdb-less entries still map by tmdb
  assert.strictEqual(animeMap.lookup('tt404', null), null);
  assert.strictEqual(animeMap.isAnime('tt9', null), true);
  assert.strictEqual(animeMap.isAnime('tt-unknown', 99999), false);

  assert.deepStrictEqual(animeMap.tmdbIdsOf({ themoviedb_id: { tv: 1, movie: [2, 3] } }), [1, 2, 3]);
  assert.deepStrictEqual(animeMap.toIdList(null), []);

  // Leave an EMPTY but fresh index installed. The map lives in module state,
  // so the fixture above (tt1/tt2!) would otherwise leak into later tests and
  // silently classify their placeholder ids as anime. A fresh empty index also
  // keeps ensureLoaded() from reaching for the network, so the rest of the
  // suite stays offline.
  animeMap._setIndex({ at: Date.now(), etag: 'test', byImdb: {}, byTmdb: {} });
  assert.strictEqual(animeMap.lookup('tt1', null), null);
});

ok('mal: rating classification, NSFW blacklist, and age banding', () => {
  const mal = require('../src/services/mal');
  assert.strictEqual(mal.classify('PG-13 - Teens 13 or older').minAge, 13);
  assert.strictEqual(mal.classify('R - 17+ (violence & profanity)').minAge, 17);
  assert.strictEqual(mal.classify('G - All Ages').minAge, 0);
  assert.strictEqual(mal.classify('PG - Children').minAge, 6);
  assert.strictEqual(mal.classify('Rx - Hentai').adult, true);
  assert.strictEqual(mal.classify('R+ - Mild Nudity').adultish, true);
  assert.strictEqual(mal.classify(''), null);
  assert.strictEqual(mal.classify(undefined), null);

  // Genres are a second adult signal from the same payload — no extra call
  const byGenre = mal.parseAnime({ rating: 'PG-13 - Teens 13 or older', explicit_genres: [{ name: 'Hentai' }] });
  assert.strictEqual(byGenre.adult, true);

  // Blacklist is permanent and NOT tied to an age limit — adults too
  assert.strictEqual(mal.isBlacklisted({ adult: true }), true);
  assert.strictEqual(mal.blockedForAge({ adultish: true, minAge: 17 }, 0), false); // adult profile keeps R+
  assert.strictEqual(mal.blockedForAge({ adultish: true, minAge: 17 }, 14), true); // never for a minor

  // AGE rule is the OPPOSITE of the blacklist: only a KNOWN rating above the
  // limit drops. Unrated falls through to the LLM — never to deletion. This is
  // the exact conflation that emptied the kids catalogs under CSM.
  assert.strictEqual(mal.blockedForAge({ minAge: null, code: null }, 14), false);
  assert.strictEqual(mal.blockedForAge(null, 14), false);
  assert.strictEqual(mal.blockedForAge({ minAge: 13 }, 14), false); // PG-13 at judged-14
  assert.strictEqual(mal.blockedForAge({ minAge: 17 }, 14), true);  // R at judged-14
  assert.strictEqual(mal.blockedForAge({ minAge: 17 }, 0), false);  // adult profile
});

ok('anilist: fallback maps isAdult/genre to the blacklist, else unrated', () => {
  const anilist = require('../src/services/anilist');
  const mal = require('../src/services/mal');
  // isAdult -> terminal blacklist (mirrors MAL Rx)
  assert.strictEqual(anilist.parseMedia({ isAdult: true, genres: [] }).adult, true);
  // Hentai/Erotica genre is a second adult signal, same as MAL
  assert.strictEqual(anilist.parseMedia({ isAdult: false, genres: ['Hentai'] }).adult, true);
  // Non-adult carries NO age band — minAge null means "LLM decides", never a drop
  const safe = anilist.parseMedia({ isAdult: false, genres: ['Action', 'Sci-Fi'] });
  assert.strictEqual(safe.adult, false);
  assert.strictEqual(safe.minAge, null);
  assert.strictEqual(safe.adultish, false);
  assert.strictEqual(anilist.parseMedia(null), null);
  // A non-adult AniList verdict must not be blocked by the age gate at any limit
  assert.strictEqual(mal.blockedForAge(safe, 14), false);
});

ok('rebuild: judgement age is one year above the limit (off when no limit)', () => {
  assert.strictEqual(rebuild.judgementAge({ age_limit: 13 }), 14);
  assert.strictEqual(rebuild.judgementAge({ age_limit: 8 }), 9);
  assert.strictEqual(rebuild.judgementAge({}), 1); // callers only use this when age_limit > 0
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

ok('tmdb: movieAvailability — home-release verdict, any country, no theatrical-age assumption (WL-AV)', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const at = (opts) => ({ nowMs: now, ...opts });
  const country = (cc, rels) => ({ iso_3166_1: cc, release_dates: rels });
  const rel = (type, date) => ({ type, release_date: date });

  // Past Digital (4) -> AVAILABLE.
  assert.strictEqual(tmdb.movieAvailability([country('US', [rel(4, '2026-01-01')])], at()), 'AVAILABLE');
  // Past Physical (5) only -> AVAILABLE.
  assert.strictEqual(tmdb.movieAvailability([country('US', [rel(5, '2025-06-01')])], at()), 'AVAILABLE');
  // Past TV (6) only -> AVAILABLE.
  assert.strictEqual(tmdb.movieAvailability([country('US', [rel(6, '2024-06-01')])], at()), 'AVAILABLE');
  // A home release in a NON-AU country only still counts (region-agnostic).
  assert.strictEqual(tmdb.movieAvailability([country('FR', [rel(4, '2026-02-02')])], at()), 'AVAILABLE');
  // Digital exists but in the FUTURE -> NOT_YET.
  assert.strictEqual(tmdb.movieAvailability([country('US', [rel(4, '2027-01-01')])], at()), 'NOT_YET');
  // Theatrical (3) only, recent -> NOT_YET (theatrical is not a home release).
  assert.strictEqual(tmdb.movieAvailability([country('US', [rel(3, '2026-08-01')])], at()), 'NOT_YET');
  // Theatrical (3) only, YEARS ago -> still NOT_YET (no time-window assumption).
  assert.strictEqual(tmdb.movieAvailability([country('US', [rel(3, '2010-01-01')])], at()), 'NOT_YET');
  // Mixed: future digital + past theatrical -> NOT_YET (only the theatrical is past).
  assert.strictEqual(
    tmdb.movieAvailability([country('US', [rel(3, '2026-06-01'), rel(4, '2027-01-01')])], at()), 'NOT_YET');
  // No usable rows / null / not-an-array -> UNKNOWN (soft gate).
  assert.strictEqual(tmdb.movieAvailability([], at()), 'UNKNOWN');
  assert.strictEqual(tmdb.movieAvailability(null, at()), 'UNKNOWN');
  assert.strictEqual(tmdb.movieAvailability(undefined, at()), 'UNKNOWN');
  assert.strictEqual(tmdb.movieAvailability([country('US', [])], at()), 'NOT_YET'); // a row, but no releases
});

ok('tmdb: seriesAvailability — aired = available, future = not yet, missing = unknown (WL-AV)', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  assert.strictEqual(tmdb.seriesAvailability('2020-01-01', { nowMs: now }), 'AVAILABLE');
  assert.strictEqual(tmdb.seriesAvailability('2030-01-01', { nowMs: now }), 'NOT_YET');
  assert.strictEqual(tmdb.seriesAvailability(null, { nowMs: now }), 'UNKNOWN');
  assert.strictEqual(tmdb.seriesAvailability('', { nowMs: now }), 'UNKNOWN');
  assert.strictEqual(tmdb.seriesAvailability('not-a-date', { nowMs: now }), 'UNKNOWN');
});

ok('store: released cache roundtrip (WL-AV)', () => {
  store.saveReleasedCache({ 'movie:tt0111161': true });
  assert.strictEqual(store.loadReleasedCache()['movie:tt0111161'], true);
  store.saveReleasedCache({}); // reset for other tests
  assert.deepStrictEqual(store.loadReleasedCache(), {});
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

ok('settings: roundtrip, migration seeds from "James", isComplete, llmChain', () => {
  const settings = require('../src/settings');
  // Fresh: never set up
  assert.strictEqual(settings.getSettings(), null);
  assert.strictEqual(settings.isComplete(), false);

  // Migration prefers the "James" profile over an older non-James one
  const seeded = settings.migrateFromProfiles([
    { name: 'Ciara', created_at: 1, keys: { tmdb_api_key: 'CIARA' } },
    { name: 'James', created_at: 2, keys: { tmdb_api_key: 'JAMES-TMDB', groq_api_key: 'JAMES-GROQ', mdblist_api_key: 'JAMES-MDB' } },
  ]);
  assert.strictEqual(seeded.seededFrom, 'James');
  let s = settings.getSettings();
  assert.strictEqual(s.keys.tmdb_api_key, 'JAMES-TMDB'); // unsealed back to plaintext
  assert.strictEqual(s.llm.groq_api_key, 'JAMES-GROQ');
  assert.deepStrictEqual(s.engines, {}); // SC-07: engine-enablement map seeds empty (Genesis is on in code)
  assert.strictEqual(settings.isComplete(s), true); // TMDB + a groq key

  // Migration is one-time — a second call is a no-op
  assert.strictEqual(settings.migrateFromProfiles([{ name: 'James', keys: { tmdb_api_key: 'X' } }]), null);

  // Add a custom LLM → chain is custom → groq primary (no backup set)
  settings.updateSettings({ llm: { custom_uri: 'http://localhost:11434/v1', custom_name: 'qwen3.5:9b' } });
  const chain = settings.llmChain();
  assert.deepStrictEqual(chain.map((p) => p.type), ['custom', 'groq']);
  assert.strictEqual(chain[0].name, 'qwen3.5:9b');
  assert.strictEqual(chain[1].label, 'groq-primary');

  // Secrets are sealed on disk, plaintext in memory
  const raw = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('JAMES-GROQ')); // groq key sealed, not plaintext on disk
  assert.ok(!raw.includes('JAMES-TMDB'));

  // GE-07: Glass Tier-2 config roundtrips as PLAINTEXT (not a secret), seeds {} on
  // older files, REPLACES-whole (unmentioned sections revert to Tier-1 default via
  // resolveConfig), and `{}` is a true reset.
  assert.deepStrictEqual(s.glass, {});
  settings.updateSettings({ glass: { weights: { taste_match: 0.6 } } });
  assert.deepStrictEqual(settings.getSettings().glass, { weights: { taste_match: 0.6 } });
  const raw2 = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'settings.json'), 'utf8');
  assert.ok(raw2.includes('taste_match')); // plaintext on disk (config metadata, not a secret)
  settings.updateSettings({ glass: {} }); // true reset for other tests
  assert.deepStrictEqual(settings.getSettings().glass, {});
});

ok('glass/config: GE-07 resolveConfig merges Tier-2 over Tier-1 by section, ignores unknown keys, clones', () => {
  const { resolveConfig, DEFAULTS, ALGORITHM_VERSION } = require('../src/engines/glass/config');
  const base = resolveConfig(null);
  assert.strictEqual(base.weights.taste_match, DEFAULTS.weights.taste_match);
  assert.strictEqual(ALGORITHM_VERSION, 'glass-a1');
  // Tier-2 overrides only the named section keys; other sections stay default.
  const over = resolveConfig({ glass: { weights: { taste_match: 0.6 }, resolve_cap: 150, bogus: 1 } });
  assert.strictEqual(over.weights.taste_match, 0.6);
  assert.strictEqual(over.weights.quality, DEFAULTS.weights.quality); // sibling key preserved
  assert.strictEqual(over.resolve_cap, 150);
  assert.ok(!('bogus' in over)); // unknown top-level key ignored
  // Returned config is an independent clone (mutating it can't corrupt DEFAULTS).
  over.weights.taste_match = 0.99;
  assert.strictEqual(resolveConfig(null).weights.taste_match, DEFAULTS.weights.taste_match);
});

ok('simkl: parseWatchedItems maps the real all-items shape (verified fixtures)', () => {
  const simkl = require('../src/services/simkl');
  // Exact shapes captured live from James's account (2026-08-18).
  const movies = [{
    last_watched_at: '2026-08-18T03:49:25Z', status: 'completed',
    movie: { title: 'Terminator 2: Judgment Day', year: 1991, ids: { simkl: 53510, imdb: 'tt0103064', tmdb: '280', tvdb: '412' } },
  }];
  const shows = [{
    last_watched_at: '2026-08-18T03:46:48Z', status: 'completed', watched_episodes_count: 16,
    show: { title: '1943', year: 2013, ids: { simkl: 1587730, imdb: 'tt4516770', tmdb: '130065' } },
  }];
  const m = simkl.parseWatchedItems(movies, 'movies');
  assert.deepStrictEqual(m, [{
    type: 'movie', title: 'Terminator 2: Judgment Day', year: 1991,
    tmdb_id: '280', imdb_id: 'tt0103064', simkl_id: 53510, watched_at: '2026-08-18T03:49:25Z',
  }]);
  const s = simkl.parseWatchedItems(shows, 'shows');
  assert.strictEqual(s[0].type, 'series');
  assert.strictEqual(s[0].tmdb_id, '130065'); // stringified, feeds TMDB /recommendations
  assert.strictEqual(s[0].imdb_id, 'tt4516770');
  assert.strictEqual(s[0].watched_at, '2026-08-18T03:46:48Z');
  // Entries with no ids are dropped, not thrown on
  assert.deepStrictEqual(simkl.parseWatchedItems([{ movie: { title: 'x' } }], 'movies'), []);
  assert.deepStrictEqual(simkl.parseWatchedItems(null, 'movies'), []);
});

ok('watchedStore: upsert dedupes by simkl_id, exclusion sets, delete (SQLite)', () => {
  const ws = require('../src/watchedStore');
  const pid = 'ws-test';
  const n = ws.upsertMany(pid, [
    { type: 'movie', title: 'Terminator 2', year: 1991, tmdb_id: '280', imdb_id: 'tt0103064', simkl_id: 53510, watched_at: '2026-08-18T03:49:25Z' },
    { type: 'series', title: '1943', year: 2013, tmdb_id: '130065', imdb_id: 'tt4516770', simkl_id: 1587730, watched_at: '2026-08-18T03:46:48Z' },
  ]);
  assert.strictEqual(n, 2);
  assert.strictEqual(ws.countWatched(pid), 2);
  // Re-upsert the same simkl_id with a newer date -> UPDATE, not a duplicate row
  ws.upsertMany(pid, [{ type: 'movie', title: 'Terminator 2', year: 1991, tmdb_id: '280', imdb_id: 'tt0103064', simkl_id: 53510, watched_at: '2026-08-19T00:00:00Z' }]);
  assert.strictEqual(ws.countWatched(pid), 2);
  assert.strictEqual(ws.getWatched(pid, { type: 'movie' })[0].watched_at, '2026-08-19T00:00:00Z');
  // Exclusion sets for de-duping recommendations
  const sets = ws.watchedIdSets(pid);
  assert.ok(sets.imdb.has('tt0103064') && sets.imdb.has('tt4516770'));
  assert.ok(sets.tmdb.has('280') && sets.tmdb.has('130065'));
  // Items with no simkl_id are skipped (it's the primary key)
  assert.strictEqual(ws.upsertMany(pid, [{ type: 'movie', title: 'noid', imdb_id: 'ttX' }]), 0);

  // Enrichment: both rows start unenriched; fill-nulls updates only nulls
  assert.strictEqual(ws.getUnenriched(pid).length, 2);
  ws.updateEnrichment(pid, 53510, { genre: 'Action', age: 'MA15+' });
  assert.strictEqual(ws.getUnenriched(pid).length, 1); // one still missing
  const t2 = ws.getWatched(pid, { type: 'movie' })[0];
  assert.strictEqual(t2.primary_genre, 'Action');
  assert.strictEqual(t2.age_classification, 'MA15+');
  // A null value must not wipe an existing one (COALESCE)
  ws.updateEnrichment(pid, 53510, { genre: null, age: null });
  assert.strictEqual(ws.getWatched(pid, { type: 'movie' })[0].primary_genre, 'Action');

  ws.deleteForProfile(pid);
  assert.strictEqual(ws.countWatched(pid), 0);
});

ok('recommendationStore: recency-weighted affinity (the Pirates behaviour)', () => {
  const rs = require('../src/recommendationStore');
  const now = Date.parse('2026-08-18T00:00:00Z');
  const day = 24 * 3600e3;
  const seeds = [
    { type: 'movie', tmdb_id: 'S1', title: 'Terminator 2', watched_at: '2026-08-18T00:00:00Z' },        // today -> weight 1.0
    { type: 'movie', tmdb_id: 'S2', title: 'Predator', watched_at: new Date(now - 90 * day).toISOString() }, // 90d -> weight 0.5
  ];
  const recsBySeed = new Map([
    ['movie:S1', [{ type: 'movie', tmdb_id: 'A', title: 'A' }, { type: 'movie', tmdb_id: 'B', title: 'B' }]],
    ['movie:S2', [{ type: 'movie', tmdb_id: 'A', title: 'A' }, { type: 'movie', tmdb_id: 'C', title: 'C' }]],
  ]);
  const out = rs.computeAffinity(seeds, recsBySeed, { halfLifeDays: 90, nowMs: now });
  // A recommended by both (recent 1.0 + old 0.5 = 1.5); B by recent only (1.0); C by old only (0.5)
  assert.ok(Math.abs(out.get('movie:A').affinity - 1.5) < 1e-9);
  assert.strictEqual(out.get('movie:A').rec_count, 2);
  assert.ok(Math.abs(out.get('movie:B').affinity - 1.0) < 1e-9);
  assert.ok(Math.abs(out.get('movie:C').affinity - 0.5) < 1e-9);
  // A (intersection of taste) outranks B, which outranks C
  assert.ok(out.get('movie:A').affinity > out.get('movie:B').affinity);
  assert.ok(out.get('movie:B').affinity > out.get('movie:C').affinity);
  // "because you watched": strongest contributor wins — A came from both, but the
  // recent seed (weight 1.0) beats the old one (0.5), so it credits Terminator 2.
  assert.strictEqual(out.get('movie:A').because_title, 'Terminator 2');
  assert.strictEqual(out.get('movie:C').because_title, 'Predator'); // C only came from the old seed
});

ok('recommendationStore: selectStrong gates on the supplied vote floor (NOT rating), caps at 5, keeps TMDB order', () => {
  const rs = require('../src/recommendationStore');
  const mk = (id, va, vc, adult = false, type = 'movie') => ({ type, tmdb_id: id, vote_average: va, vote_count: vc, adult });
  const recs = [
    mk('A', 8, 1000), mk('low-rating', 5, 1000), mk('B', 7, 1000), mk('low-votes', 9, 10),
    mk('adult', 8, 1000, true), mk('C', 6, 200), mk('D', 8, 1000), mk('E', 7, 1000),
  ];
  // Rating floor is NOT applied here (moved to serve time) — low-rating stays; the
  // caller-supplied vote floor (here 150) drops low-votes; porn is dropped. Top-5 in ORDER.
  assert.deepStrictEqual(rs.selectStrong(recs, 150).map((r) => r.tmdb_id), ['A', 'low-rating', 'B', 'C', 'D']);
  // low-votes and adult are excluded regardless of position
  assert.ok(!rs.selectStrong(recs, 150).some((r) => r.tmdb_id === 'low-votes' || r.tmdb_id === 'adult'));
  // A higher floor rejects more — C (200 votes) now drops under a 500 floor
  assert.deepStrictEqual(rs.selectStrong(recs, 500).map((r) => r.tmdb_id), ['A', 'low-rating', 'B', 'D', 'E']);
  // Floor 0 = "No minimum": no vote gate (porn still dropped)
  assert.ok(rs.selectStrong(recs, 0).some((r) => r.tmdb_id === 'low-votes'));
  assert.ok(!rs.selectStrong(recs, 0).some((r) => r.tmdb_id === 'adult'));
});

ok('recommendationStore: SH-01 passesAgeBand — real cert + MAL band, stricter-only', () => {
  const rs = require('../src/recommendationStore');
  const row = (certification, age_classification = null) => ({ certification, age_classification });
  // Age 10 (judged at 11):
  assert.strictEqual(rs.passesAgeBand(row('MA 15+'), { age_limit: 10 }), false, 'MA 15+ (15) rejected at 10');
  assert.strictEqual(rs.passesAgeBand(row('PG'), { age_limit: 10 }), true, 'PG (8) kept at 10');
  assert.strictEqual(rs.passesAgeBand(row('M'), { age_limit: 10 }), false, 'M (15) rejected at 10');
  assert.strictEqual(rs.passesAgeBand(row('PG-13'), { age_limit: 10 }), false, 'PG-13 (13) rejected at 10');
  // Age 12 (judged at 13):
  assert.strictEqual(rs.passesAgeBand(row('PG-13'), { age_limit: 12 }), true, 'PG-13 (13) kept at 12');
  // R 18+ (Infinity) is rejected at EVERY age limit:
  for (const age of [1, 10, 12, 17, 99]) assert.strictEqual(rs.passesAgeBand(row('R 18+'), { age_limit: age }), false);
  // Unknown cert (null / 'NR') stays KEPT (unchanged rule):
  assert.strictEqual(rs.passesAgeBand(row(null), { age_limit: 10 }), true);
  assert.strictEqual(rs.passesAgeBand(row('NR'), { age_limit: 10 }), true);
  // MAL band + real cert: the STRICTER source wins (MAL 'R+' = 17 beats 'PG' = 8):
  assert.strictEqual(rs.passesAgeBand(row('PG', 'R+'), { age_limit: 10 }), false);
  assert.strictEqual(rs.passesAgeBand(row('PG', 'R+'), { age_limit: 17 }), true);
  // Adult profile (no age limit): always true, whatever the certs.
  for (const c of [null, 'NR', 'M', 'MA 15+', 'R 18+']) assert.strictEqual(rs.passesAgeBand(row(c, 'R+'), { age_limit: 0 }), true);
});

ok('recommendationStore: SH-01 stricter-only matrix — new passesAgeBand never keeps what the old MAL-only logic rejected', () => {
  const rs = require('../src/recommendationStore');
  // The OLD logic, kept as a local copy: MAL band only.
  const CERT_MIN_AGE = { G: 0, PG: 8, 'PG-13': 13, R: 17, 'R+': 17 };
  const oldPasses = (row, filters) => {
    const limit = filters.age_limit || 0;
    if (limit <= 0) return true;
    const m = row.age_classification && row.age_classification in CERT_MIN_AGE ? CERT_MIN_AGE[row.age_classification] : null;
    return m === null || m <= limit + 1;
  };
  const malValues = [null, 'G', 'PG', 'PG-13', 'R', 'R+'];
  const certValues = [null, 'NR', 'G', 'PG', 'M', 'MA 15+', 'PG-13', 'R', 'R 18+', 'X18+'];
  for (const mal of malValues) for (const cert of certValues) for (const age of [0, 5, 10, 14, 17]) {
    const row = { age_classification: mal, certification: cert };
    const filters = { age_limit: age };
    if (rs.passesAgeBand(row, filters)) assert.ok(oldPasses(row, filters), `new kept but old rejected: mal=${mal} cert=${cert} age=${age}`);
  }
  // Sanity: the new logic is actually STRICTER somewhere (a real cert adds a rejection the MAL-only logic missed).
  assert.strictEqual(rs.passesAgeBand({ age_classification: null, certification: 'MA 15+' }, { age_limit: 10 }), false);
  assert.strictEqual(oldPasses({ age_classification: null, certification: 'MA 15+' }, { age_limit: 10 }), true);
});

ok('engines: registry lists Genesis, resolveFor/availableFor honour age gating (I7) + global enablement (SC-07)', () => {
  const engines = require('../src/engines');
  const settings = require('../src/settings');
  // The registry lists Genesis + Glass for both types, and Marquee (movie-only)
  // for movie. All ship globally DISABLED, so each is in listForType yet absent
  // from availableFor until an admin enables it (SC-07).
  assert.deepStrictEqual(engines.listForType('movie').map((e) => e.id), ['genesis', 'glass', 'marquee']);
  assert.deepStrictEqual(engines.listForType('series').map((e) => e.id), ['genesis', 'glass']);
  // Genesis is the permanent default + safe floor — always enabled (SC-07).
  assert.strictEqual(engines.isEnabled('genesis'), true);
  // resolveFor falls back to Genesis for any profile, incl. a vestigial old id.
  assert.strictEqual(engines.resolveFor({ filters: { engine_movie: 'trakt' } }, 'movie').id, 'genesis');
  assert.strictEqual(engines.resolveFor({ filters: {} }, 'series').id, 'genesis');
  assert.strictEqual(engines.resolveFor({}, 'movie').id, 'genesis');
  // Genesis (unrestricted:false) is available to adult AND age-limited profiles.
  assert.deepStrictEqual(engines.availableFor({ filters: {} }, 'movie').map((e) => e.id), ['genesis']);
  assert.deepStrictEqual(engines.availableFor({ filters: { age_limit: 12 } }, 'movie').map((e) => e.id), ['genesis']);

  // Register an unrestricted ("all ages") stub and prove BOTH gates: global
  // enablement (SC-07) and the age-selection gate (I7) compose.
  const dispose = engines._register({
    id: 'open-stub', name: 'Open', description: 't', supportedTypes: ['movie', 'series'],
    capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: true },
    requirements: () => ({ ok: true, missing: [] }), generate: async () => [],
  });
  try {
    const adult = { filters: {} };
    const kid = { filters: { age_limit: 12, engine_movie: 'open-stub' } };
    // SC-07: a freshly registered engine ships DISABLED — absent from dropdowns and
    // never resolved, even on an adult profile, until an admin enables it.
    assert.strictEqual(engines.isEnabled('open-stub'), false);
    assert.ok(!engines.availableFor(adult, 'movie').some((e) => e.id === 'open-stub'));
    assert.strictEqual(engines.resolveFor({ filters: { engine_movie: 'open-stub' } }, 'movie').id, 'genesis');
    // Enable it (admin Server Config toggle). Now the age gate is the only filter.
    settings.updateSettings({ engines: { 'open-stub': true } });
    assert.strictEqual(engines.isEnabled('open-stub'), true);
    // Adult profile: the open stub is offered and resolvable.
    assert.ok(engines.availableFor(adult, 'movie').some((e) => e.id === 'open-stub'));
    assert.strictEqual(engines.resolveFor({ filters: { engine_movie: 'open-stub' } }, 'movie').id, 'open-stub');
    // Age-limited profile: the open stub is hidden from the dropdown…
    assert.ok(!engines.availableFor(kid, 'movie').some((e) => e.id === 'open-stub'));
    // …and never resolved even if hand-stored — Genesis is the safe floor (I7).
    assert.strictEqual(engines.resolveFor(kid, 'movie').id, 'genesis');
  } finally { dispose(); settings.updateSettings({ engines: { 'open-stub': false } }); }
  // Registry restored to the built-in engines after the stub is disposed.
  assert.deepStrictEqual(engines.listForType('movie').map((e) => e.id), ['genesis', 'glass', 'marquee']);

  // GE-07 conformance: Glass ships DISABLED (absent from dropdowns), and once
  // enabled it is a GATED engine (unrestricted:false) — offered to an age-limited
  // profile too (the shared age gate makes it safe), unlike an open engine.
  assert.strictEqual(engines.isEnabled('glass'), false);
  assert.ok(!engines.availableFor({ filters: {} }, 'movie').some((e) => e.id === 'glass'));
  try {
    settings.updateSettings({ engines: { glass: true } });
    assert.ok(engines.availableFor({ filters: {} }, 'movie').some((e) => e.id === 'glass'));         // adult
    assert.ok(engines.availableFor({ filters: { age_limit: 8 } }, 'series').some((e) => e.id === 'glass')); // kid: gated engine IS offered
    assert.strictEqual(engines.resolveFor({ filters: { age_limit: 8, engine_series: 'glass' } }, 'series').id, 'glass');
  } finally { settings.updateSettings({ engines: { glass: false } }); }
});

ok('recommendationStore: purgeBelowVoteFloor drops stored rows under the profile vote floor (movies vs series ⅕)', () => {
  const rs = require('../src/recommendationStore');
  const pid = 'vc-purge';
  const mk = (id, type, vc) => ({ type, tmdb_id: id, imdb_id: 'tt' + id, title: id, year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: vc, affinity: 1, rec_count: 1, popularity: 1, poster: null });
  rs.upsertCandidates(pid, [mk('hi', 'movie', 5000), mk('lo', 'movie', 100), mk('shi', 'series', 300), mk('slo', 'series', 100)]);
  // floor 1000 -> movies gate at 1000, series at 200 (⅕). 'lo' (100) and 'slo' (100) go; 'hi'/'shi' stay.
  assert.strictEqual(rs.purgeBelowVoteFloor(pid, { vote_count_floor: 1000 }), 2);
  assert.deepStrictEqual(rs.getRecommended(pid, { limit: 100 }).map((r) => r.tmdb_id).sort(), ['hi', 'shi']);
  // "No minimum" (0) purges nothing
  rs.upsertCandidates(pid, [mk('tiny', 'movie', 1)]);
  assert.strictEqual(rs.purgeBelowVoteFloor(pid, { vote_count_floor: 0 }), 0);
});

ok('recommendationStore: GE-01 persists score_components (JSON) + algorithm_version + engine_id, engine-agnostic', () => {
  const rs = require('../src/recommendationStore');
  const pid = 'ge01-store';
  rs.upsertCandidates(pid, [
    // An engine that emits the components store (object → JSON) + version + id.
    { type: 'movie', tmdb_id: 'gc1', imdb_id: 'ttgc1', title: 'X', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null,
      score_components: { taste_match: 0.8, quality: 0.6 }, algorithm_version: 'glass-1', engine_id: 'glass' },
    // A legacy engine that emits none of it → all three stay null (no crash).
    { type: 'movie', tmdb_id: 'gc2', imdb_id: 'ttgc2', title: 'Y', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null },
  ]);
  const rows = rs.getRecommended(pid, { type: 'movie', limit: 10 });
  const a = rows.find((r) => r.tmdb_id === 'gc1');
  const b = rows.find((r) => r.tmdb_id === 'gc2');
  assert.deepStrictEqual(JSON.parse(a.score_components), { taste_match: 0.8, quality: 0.6 });
  assert.strictEqual(a.algorithm_version, 'glass-1');
  assert.strictEqual(a.engine_id, 'glass');
  assert.strictEqual(b.score_components, null);
  assert.strictEqual(b.algorithm_version, null);
  assert.strictEqual(b.engine_id, null);
  // A pre-stringified components value is stored verbatim (not double-encoded).
  rs.upsertCandidates(pid, [{ type: 'movie', tmdb_id: 'gc1', imdb_id: 'ttgc1', title: 'X', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, score_components: '{"popularity":0.3}', algorithm_version: 'glass-2', engine_id: 'glass' }]);
  const a2 = rs.getRecommended(pid, { type: 'movie', limit: 10 }).find((r) => r.tmdb_id === 'gc1');
  assert.deepStrictEqual(JSON.parse(a2.score_components), { popularity: 0.3 });
  assert.strictEqual(a2.algorithm_version, 'glass-2');
  rs.deleteForProfile(pid);
});

ok('simklTrending: GE-02 parseTrendingItem normalizes ids/ratings/velocity, drops tmdb-less, tolerant rating shapes', () => {
  const st = require('../src/services/simklTrending');
  // Nested rating shape + full ids + velocity/momentum.
  const a = st.parseTrendingItem({
    ids: { tmdb: 603, imdb: 'tt0133093', simkl: 12345 }, title: 'The Matrix', year: 1999,
    genres: ['Action', 'Science Fiction'], release_date: '1999-03-31', runtime: 136,
    country: 'us', original_language: 'en', watched: 4200, drop_rate: -3, rank: 5,
    ratings: { imdb: { rating: 8.7, votes: 2000000 }, simkl: { rating: 9.0, votes: 5000 } },
  }, 'movies');
  assert.strictEqual(a.tmdb_id, '603');       // stringified
  assert.strictEqual(a.imdb_id, 'tt0133093');
  assert.strictEqual(a.simkl_id, 12345);
  assert.strictEqual(a.watched, 4200);
  assert.strictEqual(a.drop_rate, -3);
  assert.strictEqual(a.ratings.imdb.rating, 8.7);
  assert.strictEqual(a.ratings.imdb.votes, 2000000);
  assert.deepStrictEqual(a.genres, ['Action', 'Science Fiction']);
  // Flat rating shape + anime cross-ids + numeric-string tmdb.
  const b = st.parseTrendingItem({ ids: { tmdb: '1', mal: 30, anilist: 21 }, name: 'One Piece', ratings: { mal: 8.6 } }, 'anime');
  assert.strictEqual(b.tmdb_id, '1');
  assert.strictEqual(b.mal, 30);
  assert.strictEqual(b.ratings.mal.rating, 8.6);
  assert.strictEqual(b.ratings.mal.votes, null);
  // No tmdb id → dropped (unresolvable into the TMDB-keyed pool).
  assert.strictEqual(st.parseTrendingItem({ ids: { imdb: 'tt9' }, title: 'X' }, 'movies'), null);
  assert.strictEqual(st.parseTrendingItem(null, 'movies'), null);
  // REAL Simkl CDN shape (verified live 2026-09-10): MM/DD/YYYY release_date,
  // drop_rate as a "0.5%" string, duplicate genres, ids.simkl_id.
  const real = st.parseTrendingItem({
    ids: { simkl_id: 2185181, imdb: 'tt28014327', tmdb: '1137844' }, title: 'Mayday',
    release_date: '09/03/2026', drop_rate: '0.5%', watched: 1504, rank: 8892,
    genres: ['Action', 'Action', 'Adventure'], ratings: { imdb: { rating: 6.9, votes: 16627 } },
  }, 'movies');
  assert.strictEqual(real.year, 2026);                 // MM/DD/YYYY parsed, not "09/0"→9
  assert.strictEqual(real.drop_rate, 0.5);             // "0.5%" → 0.5
  assert.strictEqual(real.simkl_id, 2185181);          // ids.simkl_id
  assert.deepStrictEqual(real.genres, ['Action', 'Adventure']); // deduped
  // ISO dates still parse (backward compatible).
  assert.strictEqual(st.parseTrendingItem({ ids: { tmdb: 1 }, release_date: '1999-03-31' }, 'movies').year, 1999);
});

ok('simklTrending: GE-02 parseCombined splits movies/tv/anime; tv falls back to shows', () => {
  const st = require('../src/services/simklTrending');
  const out = st.parseCombined({
    movies: [{ ids: { tmdb: 1 } }, { ids: { imdb: 'tt' } }],  // 2nd has no tmdb → dropped
    shows: [{ ids: { tmdb: 2 } }],                             // `shows` alias for tv
    anime: [{ ids: { tmdb: 3 } }],
  });
  assert.deepStrictEqual(out.movies.map((x) => x.tmdb_id), ['1']);
  assert.deepStrictEqual(out.tv.map((x) => x.tmdb_id), ['2']);
  assert.deepStrictEqual(out.anime.map((x) => x.tmdb_id), ['3']);
});

ok('tmdb: GE-03 normalizeDeepMeta — movie director+collection, series showrunner+networks, keyword-key asymmetry', () => {
  const movie = tmdb.normalizeDeepMeta({
    title: 'Inception', release_date: '2010-07-16', runtime: 148, original_language: 'en',
    genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
    vote_average: 8.4, vote_count: 34000, popularity: 90,
    credits: { crew: [{ job: 'Director', name: 'Christopher Nolan' }, { job: 'Writer', name: 'x' }], cast: [{ name: 'Leonardo DiCaprio' }, { name: 'Joseph Gordon-Levitt' }, { name: 'Elliot Page' }, { name: 'Tom Hardy' }] },
    keywords: { keywords: [{ name: 'dream' }, { name: 'heist' }] },
    external_ids: { imdb_id: 'tt1375666' },
    belongs_to_collection: null,
  }, 'movie', 27205);
  assert.strictEqual(movie.tmdb_id, '27205');
  assert.strictEqual(movie.imdb_id, 'tt1375666');
  assert.strictEqual(movie.year, 2010);
  assert.strictEqual(movie.decade, 2010);
  assert.deepStrictEqual(movie.director, ['Christopher Nolan']);   // Director crew only
  assert.deepStrictEqual(movie.cast, ['Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Elliot Page']); // top-3
  assert.deepStrictEqual(movie.keywords, ['dream', 'heist']);      // movie: keywords.keywords
  assert.strictEqual(movie.primary_genre, 'Action');
  assert.strictEqual(movie.runtime, 148);

  const withColl = tmdb.normalizeDeepMeta({ title: 'X', release_date: '2003-07-09', genres: [], belongs_to_collection: { id: 295, name: 'Pirates Collection' }, external_ids: {} }, 'movie', 22);
  assert.deepStrictEqual(withColl.collection, { id: 295, name: 'Pirates Collection' });

  const series = tmdb.normalizeDeepMeta({
    name: 'Breaking Bad', first_air_date: '2008-01-20', episode_run_time: [47], genres: [{ id: 18, name: 'Drama' }],
    created_by: [{ name: 'Vince Gilligan' }], networks: [{ name: 'AMC' }],
    credits: { cast: [{ name: 'Bryan Cranston' }, { name: 'Aaron Paul' }] },
    keywords: { results: [{ name: 'drugs' }] },   // tv: keywords.results
    external_ids: { imdb_id: 'tt0903747' },
  }, 'series', 1396);
  assert.deepStrictEqual(series.director, ['Vince Gilligan']);     // showrunner proxy
  assert.deepStrictEqual(series.networks, ['AMC']);                // franchise proxy
  assert.deepStrictEqual(series.keywords, ['drugs']);
  assert.strictEqual(series.collection, null);                     // movie-only
  assert.strictEqual(series.runtime, 47);
  assert.strictEqual(tmdb.normalizeDeepMeta(null, 'movie', 1), null);
});

ok('glass/metaStore: GE-03 put/get/getMany round-trip + imdb index', () => {
  const metaStore = require('../src/engines/glass/metaStore');
  metaStore._clear();
  metaStore.put('movie', 27205, { tmdb_id: '27205', imdb_id: 'tt1375666', director: ['Nolan'], keywords: ['dream'] });
  metaStore.put('movie', 22, { tmdb_id: '22', imdb_id: 'tt0325980', collection: { id: 295, name: 'Pirates' } });
  const got = metaStore.get('movie', 27205);
  assert.strictEqual(got.imdb_id, 'tt1375666');
  assert.deepStrictEqual(got.director, ['Nolan']);
  assert.strictEqual(metaStore.get('movie', 999), null);
  assert.strictEqual(metaStore.has('movie', 22), true);
  const many = metaStore.getMany('movie', [27205, 22, 999]);
  assert.strictEqual(many.size, 2);
  assert.strictEqual(many.get('27205').imdb_id, 'tt1375666');
  metaStore._clear();
  assert.strictEqual(metaStore.count(), 0);
});

ok('glass/tasteModel: GE-05 builds 3-horizon dims, recency-weighted, normalized 0–1, type-scoped', () => {
  const watchedStore = require('../src/watchedStore');
  const metaStore = require('../src/engines/glass/metaStore');
  const { buildTasteModel, topGenres } = require('../src/engines/glass/tasteModel');
  const { resolveConfig } = require('../src/engines/glass/config');
  const cfg = resolveConfig(null);
  const pid = 'glass-taste';
  const now = Date.parse('2026-09-10T00:00:00Z');
  watchedStore.deleteForProfile(pid); metaStore._clear();
  // A recently-watched Drama and a long-ago Comedy (same type).
  watchedStore.upsertMany(pid, [
    { type: 'movie', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '101', title: 'Recent', year: 2025, watched_at: '2026-09-08T00:00:00Z' },
    { type: 'movie', simkl_id: 2, imdb_id: 'tt2', tmdb_id: '102', title: 'Old', year: 2001, watched_at: '2022-01-01T00:00:00Z' },
    { type: 'series', simkl_id: 3, imdb_id: 'tt3', tmdb_id: '201', title: 'Show', year: 2020, watched_at: '2026-09-01T00:00:00Z' },
  ]);
  metaStore.put('movie', 101, { tmdb_id: '101', imdb_id: 'tt1', type: 'movie', genres: ['Drama'], director: ['Nolan'], cast: ['A'], keywords: ['dream'], decade: 2020, original_language: 'en', runtime: 120, collection: { id: 9, name: 'C' } });
  metaStore.put('movie', 102, { tmdb_id: '102', imdb_id: 'tt2', type: 'movie', genres: ['Comedy'], director: ['X'], decade: 2000, original_language: 'en', runtime: 95 });
  metaStore.put('series', 201, { tmdb_id: '201', imdb_id: 'tt3', type: 'series', genres: ['Drama'], networks: ['HBO'], decade: 2020, original_language: 'en', runtime: 50 });

  const t = buildTasteModel(pid, 'movie', cfg, { nowMs: now });
  assert.strictEqual(t.type, 'movie');
  assert.strictEqual(t.seedCount, 2);                         // type-scoped: series excluded
  assert.strictEqual(t.enrichedCount, 2);
  // Recency: the recent Drama outweighs the old Comedy → Drama affinity is the max (1.0).
  assert.strictEqual(t.dims.genres.Drama, 1);
  assert.ok(t.dims.genres.Comedy < t.dims.genres.Drama);
  assert.strictEqual(t.dims.directors.Nolan, 1);
  assert.ok('c:9' in t.dims.franchises);                      // movie franchise = collection
  assert.deepStrictEqual(topGenres(t, 1), ['Drama']);
  // Series model is isolated (only the show seeds it; franchise = network proxy).
  const ts = buildTasteModel(pid, 'series', cfg, { nowMs: now });
  assert.strictEqual(ts.seedCount, 1);
  assert.ok('n:HBO' in ts.dims.franchises);
  watchedStore.deleteForProfile(pid); metaStore._clear();
});

ok('glass/candidates: GE-05 dedupe unions sources, preScore ranks, exploration eligibility', () => {
  const c = require('../src/engines/glass/candidates');
  const taste = { dims: { genres: { Drama: 1, Action: 0.5 } } };
  // dedupe merges the same title from two strategies, unioning sources + keeping fields.
  const merged = c.dedupe([
    { type: 'movie', tmdb_id: '1', genres: ['Drama'], sources: ['recommendations'], imdb_id: null, reason: 'because you watched X', watched24h: 0 },
    { type: 'movie', tmdb_id: '1', genres: ['Drama'], sources: ['trending'], imdb_id: 'tt1', reason: null, watched24h: 500 },
    { type: 'movie', tmdb_id: '2', genres: ['Action'], sources: ['trending'], watched24h: 10 },
  ]);
  assert.strictEqual(merged.length, 2);
  const one = merged.find((x) => x.tmdb_id === '1');
  assert.deepStrictEqual(one.sources.sort(), ['recommendations', 'trending']);
  assert.strictEqual(one.imdb_id, 'tt1');            // filled from the trending copy
  assert.strictEqual(one.reason, 'because you watched X');
  assert.strictEqual(one.watched24h, 500);           // max
  // preScore: a Drama (top affinity) outranks an Action title, all else equal.
  const drama = { genres: ['Drama'], watched24h: 0, drop_rate: null, vote_average: 7, popularity: 0 };
  const action = { genres: ['Action'], watched24h: 0, drop_rate: null, vote_average: 7, popularity: 0 };
  assert.ok(c.preScore(drama, taste) > c.preScore(action, taste));
  // exploration eligibility: outside the top-genre set.
  assert.strictEqual(c.outsideTopGenres({ genres: ['Horror'] }, new Set(['Drama'])), true);
  assert.strictEqual(c.outsideTopGenres({ genres: ['Drama'] }, new Set(['Drama'])), false);
});

ok('glass/scoring: GE-06 features 0–1, weighted rankScore, preResolved fields, intersect bonuses, tt-less dropped', () => {
  const scoring = require('../src/engines/glass/scoring');
  const { resolveConfig } = require('../src/engines/glass/config');
  const cfg = resolveConfig(null);
  const taste = {
    genreMass: { Drama: 10, Comedy: 2 },
    dims: {
      genres: { Drama: 1 }, decades: { 2020: 1 }, languages: { en: 1 }, runtimeBands: { m_mid: 1 },
      directors: { Nolan: 1 }, franchises: { 'c:9': 1 }, cast: { A: 1 }, keywords: { dream: 1 },
    },
  };
  const meta = { type: 'movie', imdb_id: 'tt1', poster: 'http://p', genres: ['Drama'], primary_genre: 'Drama', vote_average: 8, vote_count: 5000, popularity: 50, original_language: 'en', runtime: 120, decade: 2020, director: ['Nolan'], cast: ['A'], keywords: ['dream'], collection: { id: 9, name: 'C' }, year: 2024 };
  const { features, matched } = scoring.computeFeatures({ sources: ['recommendations'], watched24h: 0, drop_rate: null }, meta, taste, cfg, { nowYear: 2026 });
  for (const v of Object.values(features)) assert.ok(v >= 0 && v <= 1, 'features are 0–1');
  assert.ok(features.taste_match > 0.9, 'a full-intersect candidate scores near-max taste_match');
  assert.deepStrictEqual(matched.director, ['Nolan']);
  assert.deepStrictEqual(matched.franchise, ['C']);
  // weightedScore matches the manual dot product.
  const manual = Object.entries(cfg.weights).reduce((s, [f, w]) => s + (features[f] || 0) * w, 0);
  assert.ok(Math.abs(scoring.weightedScore(features, cfg.weights) - manual) < 1e-9);
  // scoreCandidate fills preResolved fields + components + version.
  const cand = { type: 'movie', tmdb_id: '1', sources: ['recommendations'], watched24h: 0, drop_rate: null };
  const scored = scoring.scoreCandidate(cand, meta, taste, cfg, { nowYear: 2026, animeLoaded: false });
  assert.strictEqual(scored.imdb_id, 'tt1');
  assert.strictEqual(scored.genres, 'Drama');
  assert.strictEqual(scored.primary_genre, 'Drama');
  assert.strictEqual(scored.algorithm_version, 'glass-a1');
  assert.ok(scored.score_components.features.taste_match > 0.9);
  assert.strictEqual(typeof scored.rankScore, 'number');
  // A candidate whose meta has no tt id is dropped (preResolved contract).
  assert.strictEqual(scoring.scoreCandidate({ type: 'movie', tmdb_id: '2', sources: [] }, { imdb_id: null, genres: [] }, taste, cfg, { animeLoaded: false }), null);
  // novelty: an over-represented genre scores LOW; a fresh genre scores HIGH.
  const fresh = scoring.computeFeatures({ sources: [] }, { ...meta, primary_genre: 'Western', genres: ['Western'] }, taste, cfg, { nowYear: 2026 }).features.novelty;
  const heavy = scoring.computeFeatures({ sources: [] }, meta, taste, cfg, { nowYear: 2026 }).features.novelty;
  assert.ok(fresh > heavy);
});

ok('embeddings: GE-09 cosine (identical/orthogonal/opposite/zero/mismatch) + settings.embedConfig', () => {
  const emb = require('../src/services/embeddings');
  assert.ok(Math.abs(emb.cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);   // identical
  assert.ok(Math.abs(emb.cosine([1, 0], [0, 1])) < 1e-9);             // orthogonal
  assert.ok(Math.abs(emb.cosine([1, 0], [-1, 0]) + 1) < 1e-9);        // opposite
  assert.strictEqual(emb.cosine([0, 0], [1, 1]), 0);                  // zero vector → 0 (never NaN)
  assert.strictEqual(emb.cosine([1, 2, 3], [1, 2]), 0);              // length mismatch → 0
  // embedConfig: null until embed_model set; falls back to custom_uri/custom_api_key; embed_uri wins.
  const settings = require('../src/settings');
  assert.strictEqual(settings.embedConfig({ llm: { embed_model: '', custom_uri: 'http://c' } }), null);
  assert.deepStrictEqual(settings.embedConfig({ llm: { embed_model: 'nomic', custom_uri: 'http://c', custom_api_key: 'k' } }), { uri: 'http://c', model: 'nomic', apiKey: 'k' });
  assert.strictEqual(settings.embedConfig({ llm: { embed_model: 'nomic', embed_uri: 'http://e', custom_uri: 'http://c' } }).uri, 'http://e');
});

ok('glass/embedStore + semantic.contentString: GE-09 Float32 BLOB round-trip, cross-model guard, content text', () => {
  const embedStore = require('../src/engines/glass/embedStore');
  const { contentString } = require('../src/engines/glass/semantic');
  embedStore._clear();
  embedStore.put('movie', 1, 'nomic', [0.5, -0.25, 1]);
  const v = embedStore.get('movie', 1, 'nomic');
  assert.strictEqual(v.length, 3);
  assert.ok(Math.abs(v[0] - 0.5) < 1e-6 && Math.abs(v[1] + 0.25) < 1e-6);   // Float32 round-trip
  assert.strictEqual(embedStore.get('movie', 1, 'other-model'), null);       // cross-model → miss (re-embed)
  const many = embedStore.getMany('movie', [1, 2], 'nomic');
  assert.strictEqual(many.size, 1);
  embedStore._clear();
  const text = contentString({ title: 'Dune', year: 2021, genres: ['Sci-Fi'], overview: 'A boy on a desert planet.', director: ['Villeneuve'], cast: ['Chalamet'], keywords: ['spice'] });
  assert.ok(text.includes('Dune (2021)') && text.includes('desert planet') && text.includes('Directed by Villeneuve') && text.includes('Themes: spice'));
});

ok('glass/events: GE-10 weighted event list — watched positive, dont_recommend negative by reason', () => {
  const watchedStore = require('../src/watchedStore');
  const rs = require('../src/recommendationStore');
  const { buildEventList } = require('../src/engines/glass/events');
  const { resolveConfig } = require('../src/engines/glass/config');
  const cfg = resolveConfig(null);
  const pid = 'glass-events';
  watchedStore.deleteForProfile(pid); rs.deleteForProfile(pid);
  watchedStore.upsertMany(pid, [{ type: 'movie', simkl_id: 1, imdb_id: 'ttw', tmdb_id: '10', title: 'W', year: 2024, watched_at: '2026-09-01T00:00:00Z' }]);
  rs.addDontRecommend(pid, 'movie', '20', 'user', Date.parse('2026-09-05T00:00:00Z'));
  rs.addDontRecommend(pid, 'movie', '30', 'decayed', Date.parse('2026-08-01T00:00:00Z'));
  const evs = buildEventList(pid, 'movie', cfg, {});
  const byId = Object.fromEntries(evs.map((e) => [e.tmdb_id, e]));
  assert.strictEqual(byId['10'].weight, 1.0);         // watched +
  assert.strictEqual(byId['10'].kind, 'watched');
  assert.strictEqual(byId['20'].weight, -1.5);        // user rejection strong-negative
  assert.strictEqual(byId['30'].weight, -0.5);        // decayed mild-negative
  assert.ok(Number.isFinite(byId['20'].ts));
  // Series is type-scoped: no movie events leak in.
  assert.strictEqual(buildEventList(pid, 'series', cfg, {}).length, 0);
  watchedStore.deleteForProfile(pid); rs.deleteForProfile(pid);
});

ok('glass/tasteModel+scoring: GE-10 a rejected dim goes negative and PENALIZES similar candidates', () => {
  const { buildTasteModel } = require('../src/engines/glass/tasteModel');
  const metaStore = require('../src/engines/glass/metaStore');
  const scoring = require('../src/engines/glass/scoring');
  const { resolveConfig } = require('../src/engines/glass/config');
  const cfg = resolveConfig(null);
  metaStore._clear();
  // Enrich a watched title (dir Villeneuve, Drama) and a REJECTED title (dir Bay, Action).
  metaStore.put('movie', 1, { tmdb_id: '1', imdb_id: 'tt1', type: 'movie', genres: ['Drama'], director: ['Villeneuve'], decade: 2020, cast: [], keywords: [], networks: [] });
  metaStore.put('movie', 2, { tmdb_id: '2', imdb_id: 'tt2', type: 'movie', genres: ['Action'], director: ['Bay'], decade: 2020, cast: [], keywords: [], networks: [] });
  const now = Date.parse('2026-09-10T00:00:00Z');
  const events = [
    { type: 'movie', tmdb_id: '1', weight: 1.0, ts: Date.parse('2026-09-08T00:00:00Z'), kind: 'watched', fallback_genre: null },
    { type: 'movie', tmdb_id: '2', weight: -1.5, ts: Date.parse('2026-09-07T00:00:00Z'), kind: 'rejected_user', fallback_genre: null },
  ];
  const taste = buildTasteModel('x', 'movie', cfg, { nowMs: now, events });
  assert.ok(taste.dims.directors.Villeneuve > 0, 'liked director positive');
  assert.ok(taste.dims.directors.Bay < 0, 'rejected director negative');
  assert.ok(!('Action' in taste.genreMass), 'a rejected genre is NOT counted as over-watched (novelty)');
  // A candidate by the rejected director scores LOWER taste_match than an identical
  // one by an unknown (neutral) director.
  const base = { type: 'movie', imdb_id: 'tt', genres: ['Drama'], primary_genre: 'Drama', decade: 2010, cast: [], keywords: [], networks: [], vote_average: 7, year: 2024 };
  const rejectedDir = scoring.computeFeatures({ sources: [] }, { ...base, director: ['Bay'] }, taste, cfg, { nowYear: 2026 }).features.taste_match;
  const unknownDir = scoring.computeFeatures({ sources: [] }, { ...base, director: ['Nobody'] }, taste, cfg, { nowYear: 2026 }).features.taste_match;
  assert.ok(rejectedDir < unknownDir, 'sharing a rejected director penalizes taste_match');
  metaStore._clear();
});

ok('glass/rerank: GE-08 taste summary (names only), match hint, prompt shape', () => {
  const rr = require('../src/engines/glass/rerank');
  const taste = { dims: { genres: { Drama: 1, Action: 0.4 }, directors: { Nolan: 1 }, franchises: { 'c:9': 1, 'n:HBO': 0.8 }, keywords: { heist: 1 }, decades: { 2010: 1 } } };
  const s = rr.tasteSummary(taste);
  assert.deepStrictEqual(s.genres, ['Drama', 'Action']);
  assert.deepStrictEqual(s.directors, ['Nolan']);
  assert.deepStrictEqual(s.franchises, ['HBO']);   // collection-id key `c:9` excluded (not human-readable)
  // match hint from stored intersects.
  const hint = rr.matchHint({ score_components: { matched: { director: ['Nolan'], franchise: ['Pirates'] } }, sources: ['exploration'] });
  assert.ok(hint.includes('director Nolan') && hint.includes('franchise Pirates') && hint.includes('fresh direction'));
  // prompt carries the ids + is JSON-only instruction.
  const prompt = rr.buildUserPrompt('movie', s, [{ id: '1', title: 'Heat', year: 1995, genres: ['Crime'], why: 'director Mann' }]);
  assert.ok(prompt.includes('1: "Heat" (1995)') && /JSON array/i.test(prompt) && /each exactly once/i.test(prompt));
});

ok('recommendationStore: selectServe applies rating/genre/recency at serve time', () => {
  const rs = require('../src/recommendationStore');
  const mk = (o) => ({ imdb_id: 'tt' + o.id, tmdb_id: o.id, type: o.type || 'movie', title: o.id, year: o.year || 2024, primary_genre: o.g, genres: o.genres || o.g, vote_average: o.va ?? 8, imdb_rating: o.imdb, age_classification: o.age || null, affinity: o.aff ?? 1 });
  const rows = [
    mk({ id: 'A', g: 'Drama' }),
    mk({ id: 'B', g: 'Horror' }),                          // excluded primary genre
    mk({ id: 'C', g: 'Drama', va: 4 }),                    // below rating floor (TMDB fallback)
    mk({ id: 'D', g: 'Action', genres: 'Action,Horror' }), // excluded SECONDARY genre
    mk({ id: 'E', g: 'Drama', year: 1990 }),               // too old (movie)
  ];
  const out = rs.selectServe(rows, { min_rating: 6, excluded_genres: ['Horror'], max_age_years: 5 }, { nowYear: 2026 });
  assert.deepStrictEqual(out.map((r) => r.tmdb_id), ['A']);
  // no filters -> all pass
  assert.strictEqual(rs.selectServe(rows, {}, { nowYear: 2026 }).length, 5);
  // unrated (no IMDb, vote_average 0) is KEPT despite a rating floor — "no rating" isn't "bad"
  assert.strictEqual(rs.selectServe([mk({ id: 'Z', g: 'Drama', va: 0 })], { min_rating: 9 }, { nowYear: 2026 }).length, 1);
  // rows without a tt id are never servable
  assert.strictEqual(rs.selectServe([{ tmdb_id: 'X', primary_genre: 'Drama', genres: 'Drama', vote_average: 8, year: 2024 }], {}, { nowYear: 2026 }).length, 0);

  // Rating floor prefers the IMDb rating (the poster badge) over TMDB's vote_average.
  const rate = (imdb, va) => rs.selectServe([mk({ id: 'R', g: 'Drama', imdb, va })], { min_rating: 6 }, { nowYear: 2026 }).length;
  assert.strictEqual(rate(5.5, 8), 0);        // IMDb 5.5 < 6 -> dropped even though TMDB 8 passes
  assert.strictEqual(rate(6.5, 4), 1);        // IMDb 6.5 >= 6 -> kept even though TMDB 4 would fail
  assert.strictEqual(rate(undefined, 7), 1);  // no IMDb -> fall back to TMDB 7 -> kept
  assert.strictEqual(rate(undefined, 4), 0);  // no IMDb -> fall back to TMDB 4 -> dropped

  // Recency window is MOVIES ONLY — an old series is never cut off by it.
  const oldMovie = mk({ id: 'OM', g: 'Drama', type: 'movie', year: 1990 });
  const oldSeries = mk({ id: 'OS', g: 'Drama', type: 'series', year: 1990 });
  assert.deepStrictEqual(
    rs.selectServe([oldMovie, oldSeries], { max_age_years: 5 }, { nowYear: 2026 }).map((r) => r.tmdb_id),
    ['OS'],
  );
});

ok('recommendationStore: selectServe age re-check drops classified titles above the band', () => {
  const rs = require('../src/recommendationStore');
  const mk = (id, age) => ({ imdb_id: 'tt' + id, tmdb_id: id, title: id, year: 2020, primary_genre: 'Anime', genres: 'Anime', vote_average: 8, age_classification: age, affinity: 1 });
  const rows = [mk('G', 'G'), mk('R', 'R'), mk('U', null)];
  // age_limit 12 -> judgementAge 13; 'R' (17+) dropped, 'G' (0) kept, unclassified kept
  assert.deepStrictEqual(rs.selectServe(rows, { age_limit: 12 }, { nowYear: 2026 }).map((r) => r.tmdb_id).sort(), ['G', 'U']);
  // no age limit -> nothing age-dropped
  assert.strictEqual(rs.selectServe(rows, {}, { nowYear: 2026 }).length, 3);
  assert.strictEqual(rs.certMinAge('R'), 17);
  assert.strictEqual(rs.certMinAge('unknown-code'), null);
});

ok('recommendationStore: balanceByGenre round-robins and never force-fills', () => {
  const rs = require('../src/recommendationStore');
  const mk = (id, g, aff) => ({ imdb_id: 'tt' + id, primary_genre: g, affinity: aff });
  const rows = [
    mk('a1', 'Drama', 9), mk('a2', 'Drama', 8), mk('a3', 'Drama', 7),
    mk('b1', 'Action', 6), mk('c1', 'Comedy', 5),
  ];
  // strongest bucket leads, then round-robin across genres before returning to Drama
  assert.deepStrictEqual(rs.balanceByGenre(rows, 10).map((r) => r.imdb_id), ['tta1', 'ttb1', 'ttc1', 'tta2', 'tta3']);
  assert.strictEqual(rs.balanceByGenre(rows, 3).length, 3);   // limit caps output
  assert.strictEqual(rs.balanceByGenre(rows, 99).length, 5);  // never force-fills past what's available
});

ok('recommendationStore: listSizeFor clamps to the portal [5,50] band, defaults to 20', () => {
  const rs = require('../src/recommendationStore');
  assert.strictEqual(rs.listSizeFor({ filters: { list_size: 10 } }), 10);
  assert.strictEqual(rs.listSizeFor({ filters: { list_size: 999 } }), 50);  // clamped up-bound
  assert.strictEqual(rs.listSizeFor({ filters: { list_size: 1 } }), 5);     // clamped low-bound
  assert.strictEqual(rs.listSizeFor({ filters: {} }), 20);                  // unset -> shipped default
  assert.strictEqual(rs.listSizeFor({}), 20);
});

ok('recommendationStore: serveRecommendations serves list_size, not the 100 cap', () => {
  const rs = require('../src/recommendationStore');
  const pid = 'ls-test';
  const genres = ['Drama', 'Action', 'Comedy'];
  const cands = [];
  for (let i = 0; i < 60; i++) {
    cands.push({
      type: 'movie', tmdb_id: 'ls' + i, imdb_id: 'ttls' + i, title: 'T' + i, year: 2024,
      primary_genre: genres[i % 3], genres: genres[i % 3], vote_average: 8, affinity: 60 - i,
      rec_count: 1, popularity: 1, poster: null,
    });
  }
  rs.upsertCandidates(pid, cands);
  const serve = (list_size) => rs.serveRecommendations({ id: pid, filters: { list_size } }, 'movie').length;
  assert.strictEqual(serve(10), 10);   // honours the configured size (was ignored -> 60/SERVE_LIMIT)
  assert.strictEqual(serve(30), 30);
  assert.strictEqual(serve(999), 50);  // clamped to the band, NOT the old 100 cap
  assert.strictEqual(rs.serveRecommendations({ id: pid, filters: {} }, 'movie').length, 20); // default
});

ok('recommendationStore: serveRecommendations projects imdbRating — imdb_rating, else vote_average, else null (CP-03)', () => {
  const rs = require('../src/recommendationStore');
  const pid = 'cp03-ai';
  rs.upsertCandidates(pid, [
    // imdb_rating present -> it wins (one decimal), even over a different TMDB score
    { type: 'movie', tmdb_id: 'c1', imdb_id: 'ttc1', title: 'HasImdb', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 7.0, imdb_rating: 8.3, affinity: 3, rec_count: 1, popularity: 1, poster: null },
    // no imdb_rating -> TMDB vote_average fallback
    { type: 'movie', tmdb_id: 'c2', imdb_id: 'ttc2', title: 'TmdbOnly', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 6.2, imdb_rating: null, affinity: 2, rec_count: 1, popularity: 1, poster: null },
    // neither -> null (no fabricated 0.0 badge)
    { type: 'movie', tmdb_id: 'c3', imdb_id: 'ttc3', title: 'Unrated', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: null, imdb_rating: null, affinity: 1, rec_count: 1, popularity: 1, poster: null },
  ]);
  const byId = new Map(rs.serveRecommendations({ id: pid, filters: {} }, 'movie').map((m) => [m.id, m.imdbRating]));
  assert.strictEqual(byId.get('ttc1'), '8.3'); // imdb_rating projected as a string
  assert.strictEqual(byId.get('ttc2'), '6.2'); // vote_average fallback
  assert.strictEqual(byId.get('ttc3'), null);  // neither present
});

ok('recommendationStore: upsert, dont_recommend suppresses + drops from pool', () => {
  const rs = require('../src/recommendationStore');
  const pid = 'rec-test';
  rs.upsertCandidates(pid, [
    { type: 'movie', tmdb_id: '280', title: 'T2', year: 1991, primary_genre: 'Action', genres: 'Action,Science Fiction', vote_average: 8.1, affinity: 2.0, rec_count: 2, because_title: 'The Terminator', popularity: 50, poster: null },
    { type: 'series', tmdb_id: '1399', title: 'GoT', year: 2011, primary_genre: 'Drama', genres: 'Drama,Fantasy', vote_average: 8.4, affinity: 1.0, rec_count: 1, popularity: 90, poster: null },
  ]);
  assert.strictEqual(rs.countRecommended(pid), 2);
  const t2 = rs.getRecommended(pid, { type: 'movie' })[0];
  assert.strictEqual(t2.title, 'T2');
  // serve-time filter columns round-trip: full genre list + rating + the debug reason
  assert.strictEqual(t2.genres, 'Action,Science Fiction');
  assert.strictEqual(t2.vote_average, 8.1);
  assert.strictEqual(t2.because_title, 'The Terminator');
  // Suppress the movie -> gone from the pool + in the dont_recommend set
  rs.addDontRecommend(pid, 'movie', '280', 'user');
  assert.strictEqual(rs.countRecommended(pid), 1);
  assert.ok(rs.dontRecommendKeys(pid).has('movie:280'));
  // Reset wipes BOTH the pool and the don't-recommend flags
  rs.resetRecommendations(pid);
  assert.strictEqual(rs.countRecommended(pid), 0);
  assert.strictEqual(rs.dontRecommendKeys(pid).size, 0);
  rs.deleteForProfile(pid);
});

ok('recommendationStore: decay — impressionStep counts once/day + resets on fall-off; shouldDecay gates', () => {
  const rs = require('../src/recommendationStore');
  const DAY = 24 * 3600e3;
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // First impression -> fresh streak of 1
  let s = rs.impressionStep({}, t0);
  assert.strictEqual(s.times_shown_in_streak, 1);
  assert.strictEqual(s.streak_started_at, t0);
  // Same calendar day -> count unchanged
  s = rs.impressionStep({ streak_started_at: t0, times_shown_in_streak: 1, last_shown_at: t0, times_shown: 1 }, t0 + 3600e3);
  assert.strictEqual(s.times_shown_in_streak, 1);
  // Next day -> +1, same streak
  s = rs.impressionStep({ streak_started_at: t0, times_shown_in_streak: 1, last_shown_at: t0, times_shown: 1 }, t0 + DAY);
  assert.strictEqual(s.times_shown_in_streak, 2);
  assert.strictEqual(s.streak_started_at, t0);
  // Fall-off gap (>14d) -> streak resets to a fresh 1
  s = rs.impressionStep({ streak_started_at: t0, times_shown_in_streak: 9, last_shown_at: t0, times_shown: 9 }, t0 + 20 * DAY);
  assert.strictEqual(s.times_shown_in_streak, 1);
  assert.strictEqual(s.streak_started_at, t0 + 20 * DAY);
  // shouldDecay: past the 60d window AND >= 8-day floor AND not engaged
  const base = { streak_started_at: t0, times_shown_in_streak: 8 };
  assert.strictEqual(rs.shouldDecay(base, t0 + 61 * DAY), true);
  assert.strictEqual(rs.shouldDecay(base, t0 + 40 * DAY), false); // inside window
  assert.strictEqual(rs.shouldDecay({ streak_started_at: t0, times_shown_in_streak: 7 }, t0 + 61 * DAY), false); // below floor
  assert.strictEqual(rs.shouldDecay({ ...base, engaged_at: t0 }, t0 + 61 * DAY), false); // engaged
  assert.strictEqual(rs.shouldDecay({ times_shown_in_streak: 8 }, t0 + 61 * DAY), false); // no streak
});

ok('recommendationStore: decayWindowMsFor gates opt-in + maps days→window; applyDecay honours the window', () => {
  const rs = require('../src/recommendationStore');
  const DAY = 24 * 3600e3;
  // OFF (default, or flag false) -> null, so the scheduler skips the profile entirely.
  assert.strictEqual(rs.decayWindowMsFor({ filters: {} }), null);
  assert.strictEqual(rs.decayWindowMsFor({ filters: { title_decay_enabled: false, title_decay_days: 30 } }), null);
  // ON -> the configured window in ms; a missing days value falls back to the 60d default.
  assert.strictEqual(rs.decayWindowMsFor({ filters: { title_decay_enabled: true, title_decay_days: 30 } }), 30 * DAY);
  assert.strictEqual(rs.decayWindowMsFor({ filters: { title_decay_enabled: true } }), 60 * DAY);
  // shouldDecay respects the passed window: a 30d streak decays at a 20d window, survives at 60d.
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const row = { streak_started_at: t0, times_shown_in_streak: 8 };
  assert.strictEqual(rs.shouldDecay(row, t0 + 30 * DAY, 20 * DAY), true);
  assert.strictEqual(rs.shouldDecay(row, t0 + 30 * DAY, 60 * DAY), false);
  // End-to-end: a title safe under the default 60d window decays under a short 20d one.
  const pid = 'decay-window-test';
  const quiet = { log() {} };
  const now = Date.parse('2026-06-01T00:00:00Z');
  rs.upsertCandidates(pid, [
    { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', title: 'Ignored', year: 2020, primary_genre: 'Drama', genres: 'Drama', vote_average: 7, affinity: 1, rec_count: 1, popularity: 1, poster: null },
  ]);
  for (let d = 0; d < 8; d++) rs.recordImpressions(pid, rs.getRecommended(pid, { type: 'movie', limit: 100 }), now + d * DAY);
  assert.strictEqual(rs.applyDecay(pid, { nowMs: now + 30 * DAY, log: quiet, windowMs: 60 * DAY }).decayed, 0); // default window: safe
  assert.strictEqual(rs.applyDecay(pid, { nowMs: now + 30 * DAY, log: quiet, windowMs: 20 * DAY }).decayed, 1); // short window: decays out
  rs.deleteForProfile(pid);
});

ok('recommendationStore: decay — record → decay-out → cooldown expiry; meta open spares a title', () => {
  const rs = require('../src/recommendationStore');
  const DAY = 24 * 3600e3;
  const pid = 'decay-test';
  const now = Date.parse('2026-06-01T00:00:00Z');
  const quiet = { log() {} };
  rs.upsertCandidates(pid, [
    { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', title: 'Ignored', year: 2020, primary_genre: 'Drama', genres: 'Drama', vote_average: 7, affinity: 1, rec_count: 1, popularity: 1, poster: null },
    { type: 'movie', tmdb_id: '2', imdb_id: 'tt2', title: 'Opened', year: 2020, primary_genre: 'Drama', genres: 'Drama', vote_average: 7, affinity: 1, rec_count: 1, popularity: 1, poster: null },
  ]);
  // Impressions on 8 distinct days for both titles
  for (let d = 0; d < 8; d++) {
    rs.recordImpressions(pid, rs.getRecommended(pid, { type: 'movie', limit: 100 }), now + d * DAY);
  }
  assert.strictEqual(rs.getRecommended(pid, { type: 'movie' }).find((r) => r.tmdb_id === '1').times_shown_in_streak, 8);
  // Inside the window -> nothing decays
  assert.strictEqual(rs.applyDecay(pid, { nowMs: now + 30 * DAY, log: quiet }).decayed, 0);
  assert.strictEqual(rs.countRecommended(pid), 2);
  // tt2's detail page is opened late -> streak resets, so it survives the sweep
  rs.noteMetaOpen(pid, 'movie', 'tt2', now + 59 * DAY);
  const res = rs.applyDecay(pid, { nowMs: now + 61 * DAY, log: quiet });
  assert.strictEqual(res.decayed, 1);
  assert.strictEqual(rs.countRecommended(pid), 1);
  assert.strictEqual(rs.getRecommended(pid, { type: 'movie' })[0].tmdb_id, '2'); // Opened survived
  // Decayed title is suppressed now, but returns after the 90-day cooldown
  assert.ok(rs.dontRecommendKeys(pid, now + 61 * DAY).has('movie:1'));
  assert.ok(!rs.dontRecommendKeys(pid, now + 61 * DAY + 91 * DAY).has('movie:1'));
  rs.deleteForProfile(pid);
});

// ---- MW-00: mark-as-watched core ----
ok('markWatched: buildWatchedHistoryBody — movie vs whole-show shape, id preference, no watched_at / no seasons', () => {
  const mw = require('../src/markWatched');
  const mov = mw.buildWatchedHistoryBody({ type: 'movie', imdbId: 'tt0133093', tmdbId: '603' });
  assert.deepStrictEqual(mov, { movies: [{ ids: { imdb: 'tt0133093', tmdb: '603' } }], shows: [] });
  assert.ok(!('watched_at' in mov.movies[0]), 'no explicit date — Simkl stamps "now"');
  const ser = mw.buildWatchedHistoryBody({ type: 'series', imdbId: 'tt0944947' });
  assert.deepStrictEqual(ser, { movies: [], shows: [{ ids: { imdb: 'tt0944947' } }] });
  assert.ok(!('seasons' in ser.shows[0]), 'whole-show mark, never per-episode');
  // tmdb-only stringifies; neither id -> empty body (nothing to match on).
  assert.deepStrictEqual(mw.buildWatchedHistoryBody({ type: 'movie', tmdbId: 27205 }).movies[0].ids, { tmdb: '27205' });
  assert.deepStrictEqual(mw.buildWatchedHistoryBody({ type: 'movie' }), { movies: [], shows: [] });
});

ok('watchedStore: pending-watched unions into id sets, retired by supersession, never a timer (MW-00 I4)', () => {
  const wStore = require('../src/watchedStore');
  const pid = 'pending-' + Date.now();
  // A movie mark (imdb+tmdb) and a series mark (tmdb-only) both union in.
  assert.strictEqual(wStore.addPendingWatched(pid, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603' }), true);
  wStore.addPendingWatched(pid, { type: 'series', tmdbId: '1399' });
  let sets = wStore.watchedIdSets(pid);
  assert.ok(sets.imdb.has('tt0133093') && sets.tmdb.has('603') && sets.tmdb.has('1399'));
  // A no-id mark is a harmless no-op.
  assert.strictEqual(wStore.addPendingWatched(pid, { type: 'movie' }), false);
  // Re-tap upserts on the dedupe key (no duplicate row).
  wStore.addPendingWatched(pid, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603' });
  // The real synced row lands -> upsertMany supersedes the MATCHING shim only.
  wStore.upsertMany(pid, [{ type: 'movie', title: 'M', year: 1999, tmdb_id: '603', imdb_id: 'tt0133093', simkl_id: 603, watched_at: '2026-09-09T00:00:00Z' }]);
  sets = wStore.watchedIdSets(pid);
  assert.ok(sets.imdb.has('tt0133093'), 'now backed by the real watched row');
  assert.ok(sets.tmdb.has('1399'), 'the series shim (no real row) is still pending');
  // The movie shim was cleared by upsertMany (I4): a second sweep finds nothing
  // to clear — had it not been cleared, it would still match the real row (→ 1).
  assert.strictEqual(wStore.clearSupersededPending(pid), 0);
  wStore.deleteForProfile(pid);
});

// ---- MW-03: "not interested" reaches every catalog ----
ok('recommendationStore: dontRecommendImdbSet — user kept, decayed expires, null-imdb skipped; addDontRecommend persists imdb', () => {
  const rs = require('../src/recommendationStore');
  const DAY = 24 * 3600e3;
  const pid = 'dnr-imdb-' + Date.now();
  const now = Date.parse('2026-06-01T00:00:00Z');
  rs.addDontRecommend(pid, 'movie', '10', 'user', now, 'tt0000010');      // user + imdb
  rs.addDontRecommend(pid, 'series', '20', 'decayed', now, 'tt0000020');  // decayed + imdb
  rs.addDontRecommend(pid, 'movie', '30', 'user', now);                   // user, NO imdb -> skipped
  let set = rs.dontRecommendImdbSet(pid, now);
  assert.deepStrictEqual([...set].sort(), ['tt0000010', 'tt0000020']);    // both present, null-imdb absent
  // After the 90-day decay cooldown the decayed imdb drops out; the user one stays.
  set = rs.dontRecommendImdbSet(pid, now + 91 * DAY);
  assert.deepStrictEqual([...set], ['tt0000010']);
  rs.deleteForProfile(pid);
});

ok('llm: chatUrl joins, extractArray tolerates wrappers, groq model list', () => {
  const llm = require('../src/services/llm');
  assert.strictEqual(llm.chatUrl('http://h:1/v1/'), 'http://h:1/v1/chat/completions');
  assert.strictEqual(llm.chatUrl('http://h:1/v1'), 'http://h:1/v1/chat/completions');
  assert.deepStrictEqual(llm.extractArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepStrictEqual(llm.extractArray('sure: [{"id":"tt1","ok":true}] done'), [{ id: 'tt1', ok: true }]);
  assert.deepStrictEqual(llm.extractArray('{"results":[{"x":2}]}'), [{ x: 2 }]); // json-mode wrapper
  assert.throws(() => llm.extractArray('not json at all'));
  assert.ok(llm.GROQ_MODELS.includes('openai/gpt-oss-120b'));
  assert.deepStrictEqual(llm.TEST_STEPS, ['shape', 'generation', 'agegate']);
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

ok('governor: reserve paces per-service, 429 backs off, stats reports', () => {
  const g = require('../src/services/governor');
  g._reset();
  // First call runs now (0); concurrent calls are spaced by the interval (tmdb 25ms)
  assert.strictEqual(g.reserve('tmdb', 0), 0);
  assert.strictEqual(g.reserve('tmdb', 0), 25);
  assert.strictEqual(g.reserve('tmdb', 0), 50);
  assert.strictEqual(g.reserve('tmdb', 1000), 0); // arriving after the window waits nothing
  // Simkl POST is the hard 1/s write cap
  g._reset();
  assert.strictEqual(g.reserve('simkl_post', 0), 0);
  assert.strictEqual(g.reserve('simkl_post', 0), 1100);
  // A 429 with Retry-After pushes the next slot out by that window
  g._reset();
  g.noteResponse('groq', { status: 429, headers: { get: (k) => (k === 'retry-after' ? '2' : null) } }, 0);
  assert.strictEqual(g.reserve('groq', 0), 2000); // 2s honoured
  // A non-429 response is a no-op; an unknown service is not paced
  g._reset();
  g.noteResponse('tmdb', { status: 200, headers: { get: () => null } }, 0);
  assert.strictEqual(g.reserve('tmdb', 0), 0);
  assert.strictEqual(g.reserve('nope', 0), 0);
  assert.strictEqual(g.reserve('nope', 0), 0);
  // Stats snapshot shape (MDBList carries a daily cap)
  g._reset();
  g.reserve('mdblist', 0);
  const st = g.stats(0);
  assert.strictEqual(st.mdblist.calls, 1);
  assert.strictEqual(st.mdblist.today, 1);
  assert.strictEqual(st.mdblist.daily_cap, 1000);
  assert.strictEqual(st.mdblist.backing_off, false);
});

ok('scrobble: computeDelta excludes already-watched, groups episodes', () => {
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

ok('config: Simkl fields present + simkl_auth token sealed at rest (v6)', () => {
  const fs = require('fs'); const path = require('path');
  const p = config.addProfile('SimklTest');
  // New profiles carry the Simkl fields
  assert.strictEqual(p.keys.simkl_client_id, '');
  assert.strictEqual(p.keys.simkl_client_secret, '');
  assert.strictEqual(p.simkl_auth, null);
  // Store a client id + a connected token
  config.updateProfile(p.id, {
    keys: { simkl_client_id: 'simkl-cid-abc' },
    simkl_auth: { access_token: 'simkl-token-xyz', username: 'james', connected_at: 1 },
  });
  // On disk: both the client id and the auth token are sealed, plaintext absent
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'profiles.json'), 'utf8');
  assert.ok(!raw.includes('simkl-token-xyz'), 'simkl token must be sealed on disk');
  assert.ok(!raw.includes('simkl-cid-abc'), 'simkl client id must be sealed on disk');
  // In memory: plaintext, and updateProfile accepted simkl_auth
  const fresh = config.getProfile(p.id);
  assert.strictEqual(fresh.keys.simkl_client_id, 'simkl-cid-abc');
  assert.strictEqual(fresh.simkl_auth.access_token, 'simkl-token-xyz');
  assert.strictEqual(fresh.simkl_auth.username, 'james');
  config.removeProfile(p.id);
});

// ---- Marquee ME-01: shared cert table + FilterEnvelope (pure) ----
ok('marquee certs: normalizeCert trims/uppercases/whitespace-free, unrated → null', () => {
  const certs = require('../src/certs');
  assert.strictEqual(certs.normalizeCert('MA 15+'), 'MA15+');
  assert.strictEqual(certs.normalizeCert('ma 15+'), 'MA15+');
  assert.strictEqual(certs.normalizeCert('pg-13'), 'PG-13');
  assert.strictEqual(certs.normalizeCert(' G '), 'G');
  assert.strictEqual(certs.normalizeCert('R 18+'), 'R18+');
  assert.strictEqual(certs.normalizeCert(null), null);
  assert.strictEqual(certs.normalizeCert(undefined), null);
  assert.strictEqual(certs.normalizeCert(''), null);
  assert.strictEqual(certs.normalizeCert('NR'), null);
  assert.strictEqual(certs.normalizeCert('unrated'), null);
  assert.strictEqual(certs.normalizeCert('notrated'), null);
});

ok('marquee certs: min-age table (spec §3.4) + strictest/any/auCeiling', () => {
  const certs = require('../src/certs');
  // AU (ACB)
  assert.strictEqual(certs.certMinAge('AU', 'E'), 0);
  assert.strictEqual(certs.certMinAge('AU', 'G'), 0);
  assert.strictEqual(certs.certMinAge('AU', 'PG'), 8);
  assert.strictEqual(certs.certMinAge('AU', 'M'), 15);
  assert.strictEqual(certs.certMinAge('AU', 'MA 15+'), 15);
  assert.strictEqual(certs.certMinAge('AU', 'R 18+'), Infinity);
  assert.strictEqual(certs.certMinAge('AU', 'X 18+'), Infinity);
  assert.strictEqual(certs.certMinAge('AU', 'RC'), Infinity);
  // US (MPA)
  assert.strictEqual(certs.certMinAge('US', 'G'), 0);
  assert.strictEqual(certs.certMinAge('US', 'PG'), 8);
  assert.strictEqual(certs.certMinAge('US', 'PG-13'), 13);
  assert.strictEqual(certs.certMinAge('US', 'R'), 17);
  assert.strictEqual(certs.certMinAge('US', 'NC-17'), Infinity);
  // Unknown → null
  assert.strictEqual(certs.certMinAge('AU', '12'), null);
  assert.strictEqual(certs.certMinAge('US', '15'), null);
  assert.strictEqual(certs.certMinAge('AU', 'NR'), null);

  // strictestMinAge: larger known min age; null only if BOTH unknown
  assert.strictEqual(certs.strictestMinAge('M', 'PG-13'), 15);
  assert.strictEqual(certs.strictestMinAge('PG', 'R'), 17);
  assert.strictEqual(certs.strictestMinAge(null, 'PG-13'), 13);
  assert.strictEqual(certs.strictestMinAge('R 18+', null), Infinity);
  assert.strictEqual(certs.strictestMinAge(null, null), null);
  assert.strictEqual(certs.strictestMinAge('G', 'R'), 17);

  // strictestCert: cert string whose min age is strictest, AU wins a tie
  assert.strictEqual(certs.strictestCert('M', 'PG-13'), 'M');
  assert.strictEqual(certs.strictestCert('PG', 'R'), 'R');
  assert.strictEqual(certs.strictestCert(null, 'PG-13'), 'PG-13');
  assert.strictEqual(certs.strictestCert('R 18+', null), 'R18+');
  assert.strictEqual(certs.strictestCert(null, null), null);
  assert.strictEqual(certs.strictestCert('PG', 'PG'), 'PG'); // tie → AU wins

  // anyCertMinAge: stored cert has no country → AU then US
  assert.strictEqual(certs.anyCertMinAge('M'), 15);
  assert.strictEqual(certs.anyCertMinAge('PG-13'), 13);
  assert.strictEqual(certs.anyCertMinAge('G'), 0);
  assert.strictEqual(certs.anyCertMinAge('12'), null);
  assert.strictEqual(certs.anyCertMinAge('NR'), null);

  // auCeilingFor: highest AU cert with minAge <= judgementAge (TMDB spelling)
  assert.strictEqual(certs.auCeilingFor(0), 'G');
  assert.strictEqual(certs.auCeilingFor(8), 'PG');
  assert.strictEqual(certs.auCeilingFor(11), 'PG');
  assert.strictEqual(certs.auCeilingFor(14), 'PG');
  assert.strictEqual(certs.auCeilingFor(15), 'MA 15+');
  assert.strictEqual(certs.auCeilingFor(30), 'MA 15+');
  assert.strictEqual(certs.auCeilingFor(-1), null);
});

ok('marquee envelope: MI-1 parity matrix (envelope never looser than selectServe)', () => {
  const marquee = require('../src/engines/marquee/filters');
  const recommendationStore = require('../src/recommendationStore');
  const genreMap = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
    99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
    27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
    878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  };
  const configs = {
    adult:    { min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 0 },
    minRating:{ min_rating: 7, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 0 },
    recency:  { min_rating: 0, vote_count_floor: 1000, max_age_years: 10, excluded_genres: [], age_limit: 0 },
    genres:   { min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: ['Horror', 'Anime'], age_limit: 0 },
    kids:     { min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 10 },
    combined: { min_rating: 7, vote_count_floor: 1000, max_age_years: 10, excluded_genres: ['Horror', 'Anime'], age_limit: 0 },
  };
  // 40 fixture rows covering every edge of the hard filter.
  const R = (over) => ({
    imdb_id: 'tt', imdb_rating: 8.0, vote_average: 8.0, vote_count: 5000,
    year: 2020, genres: ['Drama'], availability: 'AVAILABLE', certAU: 'PG', certUS: 'PG', ...over,
  });
  const rows = [
    R({}),                                                        // 1  clean base
    R({ imdb_rating: 7.0, vote_average: 7.0 }),                  // 2  rating exactly at floor
    R({ imdb_rating: 6.9, vote_average: 6.9 }),                  // 3  rating just below floor
    R({ imdb_rating: 6.99, vote_average: 6.99 }),                // 4  rating below floor
    R({ imdb_rating: 0, vote_average: 8.0 }),                   // 5  no imdb, vote 8
    R({ imdb_rating: 0, vote_average: 6.5 }),                   // 6  no imdb, vote 6.5
    R({ imdb_rating: 0, vote_average: 0 }),                     // 7  both ratings 0 (unknown)
    R({ vote_count: 1000 }),                                    // 8  vote_count exactly at floor
    R({ vote_count: 999 }),                                     // 9  vote_count below floor
    R({ vote_count: 0 }),                                       // 10 vote_count 0
    R({ year: null }),                                          // 11 year unknown
    R({ year: 2016 }),                                          // 12 recency boundary (kept)
    R({ year: 2015 }),                                          // 13 recency (rejected)
    R({ year: 2000 }),                                          // 14 recency (rejected)
    R({ genres: ['Horror'] }),                                  // 15 excluded genre
    R({ genres: ['Anime'] }),                                   // 16 excluded pseudo-genre
    R({ availability: 'NOT_YET' }),                             // 17 not streamable
    R({ availability: 'UNKNOWN' }),                             // 18 unknown availability (kept)
    R({ availability: null }),                                  // 19 null availability (kept)
    R({ imdb_id: null }),                                       // 20 not servable
    R({ certAU: null, certUS: null }),                          // 21 kids: unknown cert
    R({ certAU: 'PG', certUS: 'PG' }),                          // 22 kids: PG (kept)
    R({ certAU: 'M', certUS: null }),                           // 23 kids: M (rejected)
    R({ certAU: 'MA 15+', certUS: null }),                      // 24 kids: MA 15+ (rejected)
    R({ certAU: null, certUS: 'PG-13' }),                       // 25 kids: PG-13 (rejected)
    R({ certAU: 'PG', certUS: 'R' }),                           // 26 kids: PG+R strictest 17 (rejected)
    R({ certAU: 'R 18+', certUS: null }),                       // 27 kids: R 18+ (rejected)
    R({ certAU: null, certUS: 'G' }),                           // 28 kids: US-only G (kept)
    R({ certAU: 'M', certUS: 'PG' }),                           // 29 kids: M+PG strictest 15 (rejected)
    R({ imdb_rating: 0, vote_average: 0, year: 2016 }),         // 30 recency kept + unknown rating
    R({ genres: ['Horror'], availability: 'NOT_YET' }),         // 31 genre + unavailable
    R({ vote_count: 0 }),                                       // 32 vote floor rejected
    R({ year: 2015 }),                                          // 33 recency rejected
    R({ certAU: 'G', certUS: null }),                           // 34 kids: AU G (kept)
    R({ certAU: null, certUS: 'PG' }),                          // 35 kids: US PG (kept)
    R({ certAU: 'M', certUS: 'PG-13' }),                        // 36 kids: M+PG-13 strictest 15 (rejected)
    R({ year: 2025 }),                                          // 37 recent (kept)
    R({ imdb_rating: 0, vote_average: 8.5 }),                  // 38 no imdb, vote 8.5
    R({ certAU: 'RC', certUS: null }),                          // 39 kids: RC (rejected)
    R({ genres: ['Drama', 'Horror'] }),                         // 40 mixed genres incl. excluded
  ];
  const asPoolRow = (row) => ({
    type: 'movie',
    imdb_id: row.imdb_id,
    imdb_rating: row.imdb_rating,
    vote_average: row.vote_average,
    vote_count: row.vote_count,
    year: row.year,
    genres: (row.genres || []).join(','),
    primary_genre: (row.genres || [])[0] || null,
    age_classification: null, // serve's age band is a MAL-band safety net; null → kept
  });
  let kept = 0;
  let rejected = 0;
  for (const [name, cfg] of Object.entries(configs)) {
    const env = marquee.compileEnvelope(cfg, { nowYear: 2026, genreMap });
    for (const [idx, row] of rows.entries()) {
      const res = env.hardFilter(row);
      if (res.ok) {
        kept += 1;
        const served = recommendationStore.selectServe([asPoolRow(row)], cfg, { nowYear: 2026 });
        assert.strictEqual(served.length, 1,
          `MI-1 violated: ${name} kept row ${idx + 1} that selectServe dropped`);
      } else {
        rejected += 1;
      }
    }
  }
  assert.ok(kept > 0, 'matrix kept some rows');
  assert.ok(rejected > 0, 'matrix rejected some rows');
});

ok('marquee envelope: kids cert filtering (MD-3)', () => {
  const marquee = require('../src/engines/marquee/filters');
  const genreMap = { 18: 'Drama', 27: 'Horror' };
  const base = { imdb_id: 'tt', imdb_rating: 8, vote_average: 8, vote_count: 5000, year: 2020, genres: ['Drama'], availability: 'AVAILABLE' };
  const kids = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 10 }, { nowYear: 2026, genreMap });
  assert.strictEqual(kids.kids, true);
  assert.strictEqual(kids.judgementAge, 11); // age_limit + 1
  const run = (certAU, certUS) => kids.hardFilter({ ...base, certAU, certUS });
  // unknown cert → cert_unknown
  assert.deepStrictEqual(run(null, null), { ok: false, reason: 'cert_unknown' });
  // PG (8 <= 11) → kept
  assert.deepStrictEqual(run('PG', 'PG'), { ok: true });
  // M (15 > 11) → cert_over
  assert.deepStrictEqual(run('M', null), { ok: false, reason: 'cert_over' });
  // PG-13 (13 > 11) → cert_over
  assert.deepStrictEqual(run(null, 'PG-13'), { ok: false, reason: 'cert_over' });
  // PG + R (strictest 17 > 11) → cert_over
  assert.deepStrictEqual(run('PG', 'R'), { ok: false, reason: 'cert_over' });
  // US-only G (0 <= 11) → kept
  assert.deepStrictEqual(run(null, 'G'), { ok: true });
  // R 18+ (Infinity) → cert_over
  assert.deepStrictEqual(run('R 18+', null), { ok: false, reason: 'cert_over' });
  // age_limit 14 (judgement 15): M and MA 15+ kept, R over (T1)
  const kids14 = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 14 }, { nowYear: 2026, genreMap });
  assert.strictEqual(kids14.judgementAge, 15);
  assert.deepStrictEqual(kids14.hardFilter({ ...base, certAU: 'M', certUS: null }), { ok: true });
  assert.deepStrictEqual(kids14.hardFilter({ ...base, certAU: 'MA 15+', certUS: null }), { ok: true });
  assert.deepStrictEqual(kids14.hardFilter({ ...base, certAU: null, certUS: 'R' }), { ok: false, reason: 'cert_over' });
  // strictestMinAge('M','PG') === 15 (the prompt's example)
  assert.strictEqual(marquee.strictestMinAge('M', 'PG'), 15);
  // an adult envelope (age_limit 0) ignores certs entirely
  const adult = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 0 }, { nowYear: 2026, genreMap });
  assert.strictEqual(adult.kids, false);
  assert.deepStrictEqual(adult.hardFilter({ ...base, certAU: null, certUS: null }), { ok: true });
});

ok('marquee live-verify: describeRatings/seedIdsFrom nested + flat shapes (F1)', () => {
  const live = require('./verify-marquee-live');
  // Nested shape — the real Simkl shape, ids under movie.ids.
  const nested = {
    movies: [
      { user_rating: 9, user_rated_at: '2026-01-01', movie: { title: 'Alpha One', year: 2020, ids: { simkl: 's1', imdb: 'tt1', tmdb: '100' } } },
      { user_rating: 8, user_rated_at: '2026-01-02', movie: { title: 'Beta Two', year: 2021, ids: { simkl: 's2', imdb: 'tt2', tmdb: '200' } } },
    ],
  };
  const d1 = live.describeRatings(nested);
  assert.ok(d1.ok, 'nested describeRatings ok');
  assert.ok(d1.detail.includes('id path: movie.ids'), `nested id path is movie.ids: ${d1.detail}`);
  assert.ok(d1.detail.includes('tmdb=present'), `nested tmdb present: ${d1.detail}`);
  assert.ok(d1.detail.includes('imdb=present'), `nested imdb present: ${d1.detail}`);
  assert.ok(d1.detail.includes('simkl=present'), `nested simkl present: ${d1.detail}`);
  assert.ok(d1.detail.includes('entry keys:'), `nested entry key list present: ${d1.detail}`);
  assert.ok(d1.detail.includes('movie keys:'), `nested movie key list present: ${d1.detail}`);
  assert.ok(d1.detail.includes('rating field "user_rating"'), `nested rating field name: ${d1.detail}`);
  assert.ok(d1.detail.includes('rated-at "user_rated_at"'), `nested rated-at field name: ${d1.detail}`);
  assert.deepStrictEqual(live.seedIdsFrom(d1.entries), ['s1', 's2'], 'nested seed ids from movie.ids.simkl');
  // Flat shape — ids under top-level ids.
  const flat = [
    { rating: 7, rated_at: '2026-02-01', ids: { simkl: 'f1', imdb: 'tt3', tmdb: '300' } },
    { rating: 6, rated_at: '2026-02-02', ids: { simkl: 'f2', imdb: 'tt4', tmdb: '400' } },
  ];
  const d2 = live.describeRatings(flat);
  assert.ok(d2.ok, 'flat describeRatings ok');
  assert.ok(d2.detail.includes('id path: ids'), `flat id path is ids: ${d2.detail}`);
  assert.ok(!d2.detail.includes('movie.ids'), `flat id path is not movie.ids: ${d2.detail}`);
  assert.ok(d2.detail.includes('tmdb=present'), `flat tmdb present: ${d2.detail}`);
  assert.deepStrictEqual(live.seedIdsFrom(d2.entries), ['f1', 'f2'], 'flat seed ids from ids.simkl');
});

ok('marquee envelope: discoverParams (spec §3.1)', () => {
  const marquee = require('../src/engines/marquee/filters');
  const genreMap = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
    99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
    27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
    878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  };
  const compile = (filters) => marquee.compileEnvelope(filters, { nowYear: 2026, genreMap }).discoverParams();
  // adult default → exactly the three always-on params
  assert.deepStrictEqual(
    compile({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 0 }),
    { include_adult: 'false', with_release_type: '4|5|6', 'vote_count.gte': '1000' });
  // kids 10 → certification_country AU + certification.lte PG (judgementAge 11 → ceiling PG)
  assert.deepStrictEqual(
    compile({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 10 }),
    { include_adult: 'false', with_release_type: '4|5|6', 'vote_count.gte': '1000', certification_country: 'AU', 'certification.lte': 'PG' });
  // recency 10 → primary_release_date.gte 2016-01-01
  assert.deepStrictEqual(
    compile({ min_rating: 0, vote_count_floor: 1000, max_age_years: 10, excluded_genres: [], age_limit: 0 }),
    { include_adult: 'false', with_release_type: '4|5|6', 'vote_count.gte': '1000', 'primary_release_date.gte': '2016-01-01' });
  // excluded genres → without_genres (movie ids only; Anime/Kids have no movie id)
  assert.deepStrictEqual(
    compile({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: ['Horror', 'Anime', 'Kids'], age_limit: 0 }),
    { include_adult: 'false', with_release_type: '4|5|6', 'vote_count.gte': '1000', without_genres: '27' });
  // min_rating 7 → vote_average.gte 6.5
  assert.deepStrictEqual(
    compile({ min_rating: 7, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 0 }),
    { include_adult: 'false', with_release_type: '4|5|6', 'vote_count.gte': '1000', 'vote_average.gte': '6.5' });
});

ok('marquee envelope: prefilter reasons in order (spec §3.2)', () => {
  const marquee = require('../src/engines/marquee/filters');
  const genreMap = { 18: 'Drama', 27: 'Horror' };
  const env = marquee.compileEnvelope(
    { min_rating: 7, vote_count_floor: 1000, max_age_years: 10, excluded_genres: ['Horror'], age_limit: 0 },
    { nowYear: 2026, genreMap });
  // each reason, in order
  assert.deepStrictEqual(env.prefilter({ adult: true, vote_count: 5000, year: 2020, genre_ids: [18] }), { ok: false, reason: 'adult' });
  assert.deepStrictEqual(env.prefilter({ adult: false, vote_count: 999, year: 2020, genre_ids: [18] }), { ok: false, reason: 'votes' });
  assert.deepStrictEqual(env.prefilter({ adult: false, vote_count: 5000, year: 2015, genre_ids: [18] }), { ok: false, reason: 'recency' });
  assert.deepStrictEqual(env.prefilter({ adult: false, vote_count: 5000, year: 2020, genre_ids: [27] }), { ok: false, reason: 'genre' });
  // rating margin: vote_average 6.1 passes (>= min_rating - 1.0), 5.9 fails
  assert.deepStrictEqual(env.prefilter({ adult: false, vote_count: 5000, year: 2020, genre_ids: [18], vote_average: 6.1 }), { ok: true });
  assert.deepStrictEqual(env.prefilter({ adult: false, vote_count: 5000, year: 2020, genre_ids: [18], vote_average: 5.9 }), { ok: false, reason: 'rating' });
  // order: adult beats votes
  assert.deepStrictEqual(env.prefilter({ adult: true, vote_count: 0, year: 2010, genre_ids: [27], vote_average: 1 }), { ok: false, reason: 'adult' });
  // order: votes beats recency
  assert.deepStrictEqual(env.prefilter({ adult: false, vote_count: 999, year: 2010, genre_ids: [27], vote_average: 1 }), { ok: false, reason: 'votes' });
});

ok('marquee envelope: stats counters (both stages + copy semantics)', () => {
  const marquee = require('../src/engines/marquee/filters');
  const genreMap = { 18: 'Drama', 27: 'Horror' };
  const env = marquee.compileEnvelope(
    { min_rating: 7, vote_count_floor: 1000, max_age_years: 10, excluded_genres: ['Horror'], age_limit: 10 },
    { nowYear: 2026, genreMap });
  // prefilter rejections (one per reason)
  env.prefilter({ adult: true });                                  // adult
  env.prefilter({ vote_count: 999, year: 2020, genre_ids: [18] }); // votes
  env.prefilter({ vote_count: 5000, year: 2015, genre_ids: [18] }); // recency
  env.prefilter({ vote_count: 5000, year: 2020, genre_ids: [27] }); // genre
  env.prefilter({ vote_count: 5000, year: 2020, genre_ids: [18], vote_average: 5.9 }); // rating
  // hardFilter rejections (one per reason)
  const H = (over) => ({ imdb_id: 'tt', imdb_rating: 8, vote_average: 8, vote_count: 5000, year: 2020, genres: ['Drama'], availability: 'AVAILABLE', certAU: 'PG', certUS: 'PG', ...over });
  env.hardFilter(H({ imdb_id: null }));                              // no_imdb
  env.hardFilter(H({ imdb_rating: 0, vote_average: 6.9 }));          // rating
  env.hardFilter(H({ year: 2015 }));                                 // recency
  env.hardFilter(H({ genres: ['Horror'] }));                         // genre
  env.hardFilter(H({ vote_count: 999 }));                            // votes
  env.hardFilter(H({ availability: 'NOT_YET' }));                    // unavailable
  env.hardFilter(H({ certAU: null, certUS: null }));                 // cert_unknown
  env.hardFilter(H({ certAU: 'M', certUS: null }));                  // cert_over
  const s = env.stats();
  assert.deepStrictEqual(s, {
    adult: 1, votes: 2, recency: 2, genre: 2, rating: 2,
    no_imdb: 1, unavailable: 1, cert_unknown: 1, cert_over: 1,
  });
  // copy semantics: mutating the returned object doesn't affect the envelope
  s.adult = 999;
  assert.strictEqual(env.stats().adult, 1);
});

ok('tmdb: normalizeDeepMeta movie cert/availability + series has no keys (ME-02)', () => {
  const tmdb = require('../src/services/tmdb');
  // movie with AU + US certs and a past home release → AVAILABLE
  const movie = {
    id: 603, title: 'Inception', release_date: '2010-07-16',
    genres: [{ id: 18, name: 'Drama' }],
    keywords: { keywords: [{ name: 'dream' }] },
    credits: { crew: [{ name: 'N', job: 'Director' }], cast: [{ name: 'A' }, { name: 'B' }] },
    external_ids: { imdb_id: 'tt1375666' },
    poster_path: '/p.jpg', vote_average: 8.8, vote_count: 15000, popularity: 5,
    original_language: 'en', runtime: 148,
    belongs_to_collection: { id: 123, name: 'C' },
    overview: 'o',
    release_dates: { results: [
      { iso_3166_1: 'AU', release_dates: [{ certification: 'M', release_date: '2010-09-01', type: 3 }, { certification: 'M', release_date: '2010-09-15', type: 4 }] },
      { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', release_date: '2010-07-16', type: 3 }] },
    ] },
  };
  const m = tmdb.normalizeDeepMeta(movie, 'movie', 603);
  assert.strictEqual(m.certAU, 'M');
  assert.strictEqual(m.certUS, 'PG-13');
  assert.strictEqual(m.availability, 'AVAILABLE');
  // theatrical-only → NOT_YET
  const theatrical = { ...movie, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', release_date: '2010-07-16', type: 3 }] }] } };
  const t = tmdb.normalizeDeepMeta(theatrical, 'movie', 603);
  assert.strictEqual(t.availability, 'NOT_YET');
  assert.strictEqual(t.certUS, 'R');
  // no release_dates → UNKNOWN + null certs
  const noRel = { ...movie }; delete noRel.release_dates;
  const n = tmdb.normalizeDeepMeta(noRel, 'movie', 603);
  assert.strictEqual(n.availability, 'UNKNOWN');
  assert.strictEqual(n.certAU, null);
  assert.strictEqual(n.certUS, null);
  // series → NO cert/availability keys
  const series = {
    id: 1234, name: 'Show', first_air_date: '2020-01-01',
    genres: [{ id: 18, name: 'Drama' }],
    keywords: { results: [{ name: 'k' }] },
    created_by: [{ name: 'C' }],
    external_ids: { imdb_id: 'tt1' },
    poster_path: '/s.jpg', vote_average: 8, vote_count: 1000, popularity: 2,
    original_language: 'en', episode_run_time: [30],
    networks: [{ name: 'Net' }],
  };
  const s = tmdb.normalizeDeepMeta(series, 'series', 1234);
  assert.ok(!('certAU' in s), 'series has no certAU');
  assert.ok(!('certUS' in s), 'series has no certUS');
  assert.ok(!('availability' in s), 'series has no availability');
});

ok('tmdb: pickCertification unchanged (ME-02 refactor)', () => {
  const tmdb = require('../src/services/tmdb');
  // AU + US → AU first
  assert.strictEqual(tmdb.pickCertification([
    { iso_3166_1: 'AU', release_dates: [{ certification: 'M' }] },
    { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] },
  ], 'movie'), 'M');
  // US only → US
  assert.strictEqual(tmdb.pickCertification([{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }], 'movie'), 'PG-13');
  // other only (GB '12') → '12'
  assert.strictEqual(tmdb.pickCertification([{ iso_3166_1: 'GB', release_dates: [{ certification: '12' }] }], 'movie'), '12');
  // empty certifications → null
  assert.strictEqual(tmdb.pickCertification([{ iso_3166_1: 'US', release_dates: [{ certification: '' }] }], 'movie'), null);
});

// ---- Marquee ME-03/ME-04 (pure) ----

ok('marquee ME-03: parseRatings keeps integer 1–10 ratings, ids from movie.ids, drops id-less (B1)', () => {
  const simkl = require('../src/services/simkl');
  const body = { movies: [
    { user_rating: 8, user_rated_at: '2026-01-01T00:00:00Z', movie: { title: 'T1', ids: { simkl: 53078, imdb: 'tt1', tmdb: '603' } } },
    { user_rating: null, user_rated_at: null, movie: { title: 'T2', ids: { simkl: 1, imdb: 'tt2', tmdb: '2' } } }, // unrated → dropped
    { user_rating: 10, user_rated_at: '2026-01-02T00:00:00Z', movie: { title: 'T3', ids: { simkl: 2, imdb: 'tt3', tmdb: '3' } } },
    { user_rating: 0, movie: { title: 'T4', ids: { simkl: 3, imdb: 'tt4', tmdb: '4' } } }, // out of range → dropped
    { user_rating: 11, movie: { title: 'T5', ids: { simkl: 4, imdb: 'tt5', tmdb: '5' } } }, // out of range → dropped
    { user_rating: 4.5, movie: { title: 'T6', ids: { simkl: 5, imdb: 'tt6', tmdb: '6' } } }, // non-integer → dropped
    { user_rating: 1, movie: { title: 'T7', ids: { simkl: 6, imdb: 'tt7', tmdb: '7' } } }, // 1 → kept
    { user_rating: 4, movie: { title: 'T8', ids: { simkl: 7, imdb: 'tt8', tmdb: '8' } } }, // 4 → kept
    { user_rating: 5, movie: { title: 'no ids' } }, // no ids anywhere → dropped
    { user_rating: 9, ids: { simkl: 9, imdb: 'tt9', tmdb: '9' } }, // flat ids fallback → kept
  ] };
  assert.deepStrictEqual(simkl.parseRatings(body), [
    { tmdb_id: '603', imdb_id: 'tt1', simkl_id: 53078, rating: 8, rated_at: '2026-01-01T00:00:00Z' },
    { tmdb_id: '3', imdb_id: 'tt3', simkl_id: 2, rating: 10, rated_at: '2026-01-02T00:00:00Z' },
    { tmdb_id: '7', imdb_id: 'tt7', simkl_id: 6, rating: 1, rated_at: null },
    { tmdb_id: '8', imdb_id: 'tt8', simkl_id: 7, rating: 4, rated_at: null },
    { tmdb_id: '9', imdb_id: 'tt9', simkl_id: 9, rating: 9, rated_at: null },
  ]);
  // bare array tolerated; missing movies key / null body → []
  assert.deepStrictEqual(simkl.parseRatings([{ user_rating: 6, movie: { ids: { tmdb: '11' } } }]),
    [{ tmdb_id: '11', imdb_id: null, simkl_id: null, rating: 6, rated_at: null }]);
  assert.deepStrictEqual(simkl.parseRatings({}), []);
  assert.deepStrictEqual(simkl.parseRatings(null), []);
});

ok('marquee ME-03: parseMovieSummary users_recommendations, ids from item.ids, missing → [] (B2)', () => {
  const simkl = require('../src/services/simkl');
  const body = {
    movie: { title: 'Seed', ids: { simkl: 53078 } },
    users_recommendations: [
      { title: 'R1', year: 2010, type: 'movie', ids: { simkl: 101, imdb: 'tt101', tmdb: '11' } },
      { title: 'R2', year: 2011, type: 'movie', ids: { simkl: 102, imdb: 'tt102', tmdb: '12' } },
      { title: 'no-ids' },
    ],
  };
  assert.deepStrictEqual(simkl.parseMovieSummary(body), { users_recommendations: [
    { simkl_id: 101, tmdb_id: '11', imdb_id: 'tt101', title: 'R1', year: 2010 },
    { simkl_id: 102, tmdb_id: '12', imdb_id: 'tt102', title: 'R2', year: 2011 },
  ] });
  assert.deepStrictEqual(simkl.parseMovieSummary({}), { users_recommendations: [] });
  assert.deepStrictEqual(simkl.parseMovieSummary(null), { users_recommendations: [] });
});

ok('marquee ME-04: ratingWeight bands (spec §4.3) + unrated → null (B7)', () => {
  const taste = require('../src/engines/marquee/taste');
  const cfg = require('../src/engines/marquee/config').DEFAULTS;
  assert.strictEqual(taste.ratingWeight(10, cfg), 3.0);
  assert.strictEqual(taste.ratingWeight(9, cfg), 2.0);
  assert.strictEqual(taste.ratingWeight(8, cfg), 1.2);
  assert.strictEqual(taste.ratingWeight(7, cfg), 1.2);
  assert.strictEqual(taste.ratingWeight(6, cfg), 0.4);
  assert.strictEqual(taste.ratingWeight(5, cfg), 0.4);
  assert.strictEqual(taste.ratingWeight(4, cfg), -1.2);
  assert.strictEqual(taste.ratingWeight(3, cfg), -1.2);
  assert.strictEqual(taste.ratingWeight(1, cfg), -1.2);
  assert.strictEqual(taste.ratingWeight(null, cfg), null);
  assert.strictEqual(taste.ratingWeight(undefined, cfg), null);
  assert.strictEqual(taste.ratingWeight(0, cfg), null);
});

ok('marquee ME-04: parseBrief — fences/prose, five keys, coerce, throw on empty (B10)', () => {
  const taste = require('../src/engines/marquee/taste');
  const b = taste.parseBrief('{"loves":["Sci-fi","Heist"],"avoids":["Horror"],"moods":["tense"],"eras":["2010s"],"standout_titles":["Inception"]}');
  assert.deepStrictEqual(b, { loves: ['Sci-fi', 'Heist'], avoids: ['Horror'], moods: ['tense'], eras: ['2010s'], standout_titles: ['Inception'] });
  // code fence + leading prose
  const fenced = taste.parseBrief('Here is the brief:\n```json\n{"loves":["A"],"avoids":[],"moods":["B"],"eras":["C"],"standout_titles":["D"]}\n```');
  assert.deepStrictEqual(fenced, { loves: ['A'], avoids: [], moods: ['B'], eras: ['C'], standout_titles: ['D'] });
  // coerce: non-array → [value]; trim; drop empties; cap 8; cap 60 chars
  const coerced = taste.parseBrief(JSON.stringify({
    loves: 'One', avoids: ['  x  ', '', 'y'], moods: Array(9).fill('m'), eras: null, standout_titles: ['a'.repeat(80)],
  }));
  assert.deepStrictEqual(coerced.loves, ['One']);
  assert.deepStrictEqual(coerced.avoids, ['x', 'y']);
  assert.strictEqual(coerced.moods.length, 8);
  assert.deepStrictEqual(coerced.eras, []);
  assert.strictEqual(coerced.standout_titles[0].length, 60);
  // all five empty → throw (makes chat try the next model/provider)
  assert.throws(() => taste.parseBrief('{"loves":[],"avoids":[],"moods":[],"eras":[],"standout_titles":[]}'));
  assert.throws(() => taste.parseBrief('no json here'));
});

ok('marquee ME-04: buildBriefPrompt carries history + dims, never age/classification (B10)', () => {
  const taste = require('../src/engines/marquee/taste');
  const prompt = taste.buildBriefPrompt({
    watch_history: [
      { title: 'Inception', year: 2010, rating: 9, genres: ['Sci-Fi', 'Thriller'] },
      { title: 'Old Movie', year: null, rating: null, genres: [] },
    ],
    tastes: [{ dim: 'genres', values: ['Sci-Fi', 'Drama'] }, { dim: 'decades', values: ['2010'] }],
  });
  assert.ok(prompt.includes('Inception (2010) — rated 9/10 — Sci-Fi, Thriller'));
  assert.ok(prompt.includes('Old Movie (n.d.) — unrated — genre unknown'));
  assert.ok(prompt.includes('genres: Sci-Fi, Drama'));
  assert.ok(prompt.includes('decades: 2010'));
  // age belongs to the shared gate (I1) — the brief must not mention it
  assert.ok(!/age|classification|suitable|child|kid/i.test(prompt), 'prompt must not mention age/classification/children');
});

ok('marquee ME-04: config copies Glass values independently + resolveConfig deep clone (spec §4.5)', () => {
  const marqueeCfg = require('../src/engines/marquee/config');
  const glassCfg = require('../src/engines/glass/config');
  // intentionally start equal to Glass's (spec §4.5), but independent copies
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.half_life_days, glassCfg.DEFAULTS.half_life_days);
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.horizon_blend, glassCfg.DEFAULTS.horizon_blend);
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.feedback, glassCfg.DEFAULTS.feedback);
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.taste_dims, glassCfg.DEFAULTS.taste_dims);
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.keyword_min_shared, glassCfg.DEFAULTS.keyword_min_shared);
  // Marquee-specific knobs
  // Trainer T2 (N4): the rating bands — 10 → +3.0 (Loved), 9 → +2.0, 7–8 → +1.2, 5–6 → +0.4, 1–4 → −1.2.
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.rating_weights, { r10: 3.0, r9: 2.0, r7_8: 1.2, r5_6: 0.4, r1_4: -1.2 });
  // Trainer T2 (N3): the Loved tier knobs (decay floor + pinned seed cap).
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.loved, { decay_floor: 0.5, pinned_seed_cap: 15 });
  assert.strictEqual(marqueeCfg.DEFAULTS.seed_cap, 100); // m2: 40 → 100
  assert.strictEqual(marqueeCfg.DEFAULTS.enrich_cap, 60);
  assert.strictEqual(marqueeCfg.DEFAULTS.llm_timeout_ms, 60000);
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.brief, { input_cap: 60 });
  // collab_reserve added in review round 1 (F1): the S2 collaborative reserve.
  assert.deepStrictEqual(marqueeCfg.DEFAULTS.simkl, { recs_max_uncached: 40, recs_ttl_days: 30, ratings_resolve_cap: 50, collab_reserve: 40 });
  assert.strictEqual(marqueeCfg.ALGORITHM_VERSION, 'marquee-m4');
  // resolveConfig: deep clone — mutating the result must not touch DEFAULTS
  const resolved = marqueeCfg.resolveConfig({});
  resolved.half_life_days.movie.recent = 999;
  resolved.seed_cap = 1;
  assert.strictEqual(marqueeCfg.DEFAULTS.half_life_days.movie.recent, 21);
  assert.strictEqual(marqueeCfg.DEFAULTS.seed_cap, 100); // m2: 40 → 100
});

ok('marquee ME-04: llmCache put/get/getMany/prune + expired/corrupt = miss (spec §4.4)', () => {
  const llmCache = require('../src/engines/marquee/llmCache');
  llmCache._clear();
  llmCache.put('p1', 'brief', 'k1', { loves: ['A'] }, 1000);
  assert.deepStrictEqual(llmCache.get('p1', 'brief', 'k1', { now: 1010 }), { loves: ['A'] });
  // expired → miss
  assert.strictEqual(llmCache.get('p1', 'brief', 'k1', { now: 1010, ttlMs: 5 }), null);
  // corrupt value → miss
  require('../src/db').get().prepare('UPDATE marquee_llm_cache SET value = ? WHERE profile_id = ? AND key = ?').run('not json{', 'p1', 'k1');
  assert.strictEqual(llmCache.get('p1', 'brief', 'k1', { now: 1010 }), null);
  // getMany: corrupt + absent keys are misses
  llmCache.put('p1', 'brief', 'k2', { avoids: ['B'] }, 1000);
  const many = llmCache.getMany('p1', 'brief', ['k1', 'k2', 'k3'], { now: 1010 });
  assert.strictEqual(many.size, 1);
  assert.deepStrictEqual(many.get('k2'), { avoids: ['B'] });
  // prune drops the oldest row
  llmCache.put('p1', 'brief', 'k4', { moods: ['C'] }, 100);
  assert.strictEqual(llmCache.prune('p1', 'brief', 500, 1000), 1); // k4 at 100 < 500
  assert.strictEqual(llmCache.get('p1', 'brief', 'k4', { now: 1000 }), null);
  llmCache._clear();
});

ok('marquee ME-04: historyHash stable across calls, changes on a rating or watch change (spec §4.3)', () => {
  const taste = require('../src/engines/marquee/taste');
  const watchedStore = require('../src/watchedStore');
  watchedStore.upsertMany('p-h', [
    { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'T1', year: 2010, watched_at: '2026-01-01T00:00:00Z' },
    { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'T2', year: 2011, watched_at: '2026-02-01T00:00:00Z' },
  ]);
  const ratings = new Map([['1', 9], ['2', 3]]);
  const h1 = taste.historyHash('p-h', { ratings });
  assert.strictEqual(h1, taste.historyHash('p-h', { ratings })); // stable
  // a rating change → different hash
  assert.notStrictEqual(h1, taste.historyHash('p-h', { ratings: new Map([['1', 9], ['2', 5]]) }));
  // an unrated title (no entry in the map) → '' in the hash → different hash
  assert.notStrictEqual(h1, taste.historyHash('p-h', { ratings: new Map([['1', 9]]) }));
  // a new watch → different hash
  watchedStore.upsertMany('p-h', [{ simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: '3', title: 'T3', year: 2012, watched_at: '2026-03-01T00:00:00Z' }]);
  assert.notStrictEqual(h1, taste.historyHash('p-h', { ratings }));
  watchedStore.deleteForProfile('p-h');
});

ok('marquee ME-04: briefHash stable per JSON content (spec §4.3)', () => {
  const taste = require('../src/engines/marquee/taste');
  const a = { loves: ['A'], avoids: [], moods: [], eras: [], standout_titles: [] };
  assert.strictEqual(taste.briefHash(a), taste.briefHash({ ...a }));
  assert.notStrictEqual(taste.briefHash(a), taste.briefHash({ ...a, loves: ['B'] }));
});

// ---- Marquee ME-05/ME-06: pure features + S6 parsers (spec §4.2/§5) ----
ok('marquee ME-06: rankScore01 — rank 1 → 1, rank N → small, null/≤0 → 0', () => {
  const f = require('../src/engines/marquee/features');
  assert.strictEqual(f.rankScore01(1, 100), 1);
  assert.ok(f.rankScore01(100, 100) > 0 && f.rankScore01(100, 100) < 0.01, 'rank N is near 0');
  assert.strictEqual(f.rankScore01(null, 100), 0);
  assert.strictEqual(f.rankScore01(0, 100), 0);
  assert.strictEqual(f.rankScore01(1, 0), 0);
  assert.ok(f.rankScore01(10, 100) > f.rankScore01(50, 100), 'lower rank scores higher');
});

ok('marquee ME-06: trendingRaw — week/day/Simkl, rising bonus, max, clamp', () => {
  const f = require('../src/engines/marquee/features');
  // week-only: rank 5 of 100.
  const weekOnly = f.trendingRaw({ tmdbWeekRank: 5, tmdbDayRank: null, simklWatched: 0, simklDrop: null }, { weekN: 100, dayN: 40 });
  assert.ok(Math.abs(weekOnly - (1 - Math.log(5) / Math.log(101))) < 1e-9);
  // day-only OUTSIDE the week top-50 gets the +0.1 rising bonus.
  const dayOnly = f.trendingRaw({ tmdbWeekRank: null, tmdbDayRank: 10, simklWatched: 0, simklDrop: null }, { weekN: 100, dayN: 40 });
  assert.ok(Math.abs(dayOnly - (1 - Math.log(10) / Math.log(41)) - 0.1) < 1e-9, 'rising bonus applied');
  // day INSIDE the week top-50 gets NO bonus; the week rank wins the max.
  const inTop = f.trendingRaw({ tmdbWeekRank: 5, tmdbDayRank: 10, simklWatched: 0, simklDrop: null }, { weekN: 100, dayN: 40 });
  assert.ok(Math.abs(inTop - (1 - Math.log(5) / Math.log(101))) < 1e-9, 'no bonus inside top-50');
  // Simkl momentum only.
  const simklOnly = f.trendingRaw({ tmdbWeekRank: null, tmdbDayRank: null, simklWatched: 500, simklDrop: 0.3 }, { weekN: 100, dayN: 40 });
  assert.ok(simklOnly > 0 && simklOnly < 1);
  // the max of the three: a strong Simkl signal beats a weak week rank.
  const maxCase = f.trendingRaw({ tmdbWeekRank: 90, tmdbDayRank: null, simklWatched: 500, simklDrop: 0.3 }, { weekN: 100, dayN: 40 });
  assert.ok(Math.abs(maxCase - simklOnly) < 1e-9, 'Simkl momentum wins the max');
  // clamped to 1.
  assert.strictEqual(f.trendingRaw({ tmdbDayRank: 1, simklWatched: 2000, simklDrop: 0 }, { weekN: 100, dayN: 40 }), 1);
});

ok('marquee ME-06: trending gate (MD-2) — 0 → 0, half-gate → half, ≥ gate → full', () => {
  const f = require('../src/engines/marquee/features');
  assert.strictEqual(f.tasteGate(0, 0.35), 0);
  assert.ok(Math.abs(f.tasteGate(0.175, 0.35) - 0.5) < 1e-9, 'half the gate → half');
  assert.strictEqual(f.tasteGate(0.35, 0.35), 1);
  assert.strictEqual(f.tasteGate(0.5, 0.35), 1, 'above the gate clamps to 1');
  // trending_eff = trending_raw × gate: off-taste (taste_match 0) → 0.
  assert.strictEqual(0.8 * f.tasteGate(0, 0.35), 0);
});

ok('marquee ME-06: quality — Bayesian prior, IMDb preferred, R=0 → 0', () => {
  const f = require('../src/engines/marquee/features');
  // R = 9, v = 10, m = 2000, C = 6.5 → (90 + 13000)/2010/10 ≈ 0.651.
  const q1 = f.quality({ imdbRating: 9, voteAverage: 7, voteCount: 10 }, { m: 2000, C: 6.5 });
  assert.ok(Math.abs(q1 - ((10 * 9 + 2000 * 6.5) / 2010 / 10)) < 1e-9);
  assert.ok(Math.abs(q1 - 0.651) < 0.001, '≈ 0.651');
  // many votes approach R/10.
  const q2 = f.quality({ imdbRating: 8, voteCount: 100000 }, { m: 2000, C: 6.5 });
  assert.ok(Math.abs(q2 - 0.8) < 0.01);
  // IMDb preferred over TMDB when present.
  const q3 = f.quality({ imdbRating: 4, voteAverage: 9, voteCount: 1000 }, { m: 2000, C: 6.5 });
  assert.ok(Math.abs(q3 - ((1000 * 4 + 2000 * 6.5) / 3000 / 10)) < 1e-9);
  // R = 0 → 0.
  assert.strictEqual(f.quality({ imdbRating: 0, voteAverage: 0, voteCount: 100 }, { m: 2000, C: 6.5 }), 0);
});

ok('marquee ME-06: consensus — S1 tags one group, trending/exploration not counted, seeds add 0.5', () => {
  const f = require('../src/engines/marquee/features');
  // tmdb_recs + tmdb_similar = ONE group, one seed → ln(2)/ln(8).
  assert.ok(Math.abs(f.consensus(new Set(['tmdb_recs', 'tmdb_similar']), new Set(['s1'])) - Math.log(2) / Math.log(8)) < 1e-9);
  // all five counted groups + 3 seeds (extra 2 × 0.5) → ln(7)/ln(8).
  assert.ok(Math.abs(f.consensus(new Set(['tmdb_recs', 'simkl_recs', 'discover', 'collection', 'llm']), new Set(['a', 'b', 'c'])) - Math.log(7) / Math.log(8)) < 1e-9);
  // trending/exploration are NOT counted (MD-2: no double count).
  assert.strictEqual(f.consensus(new Set(['trending', 'exploration']), new Set()), 0);
  // clamped at 1.
  assert.strictEqual(f.consensus(new Set(['tmdb_recs', 'simkl_recs', 'discover', 'collection', 'llm']), new Set(['1', '2', '3', '4', '5', '6', '7', '8'])), 1);
});

ok('marquee ME-06: freshness — max_age_years window, default 30, unknown/old → floor', () => {
  const f = require('../src/engines/marquee/features');
  // window from max_age_years.
  assert.ok(Math.abs(f.freshness(2020, { nowYear: 2026, maxAgeYears: 10 }) - 0.4) < 1e-9);
  assert.ok(Math.abs(f.freshness(2025, { nowYear: 2026, maxAgeYears: 10 }) - 0.9) < 1e-9);
  assert.strictEqual(f.freshness(2026, { nowYear: 2026, maxAgeYears: 10 }), 1);
  // very old → floor.
  assert.strictEqual(f.freshness(2000, { nowYear: 2026, maxAgeYears: 10 }), 0.2);
  // default 30-year window when unlimited.
  assert.ok(Math.abs(f.freshness(2010, { nowYear: 2026, maxAgeYears: 0 }) - (2010 - 1996) / 30) < 1e-9);
  // unknown year → floor.
  assert.strictEqual(f.freshness(null, { nowYear: 2026 }), 0.2);
  assert.strictEqual(f.freshness(0, { nowYear: 2026 }), 0.2);
});

ok('marquee ME-06: renormalize — sums to 1 without llm_fit / without trending_eff, ratios preserved', () => {
  const f = require('../src/engines/marquee/features');
  const weights = { taste_match: 0.28, llm_fit: 0.20, trending_eff: 0.20, quality: 0.14, consensus: 0.12, freshness: 0.06 };
  // without llm_fit: sum to 1, ratios preserved.
  const w1 = f.renormalize(weights, ['taste_match', 'trending_eff', 'quality', 'consensus', 'freshness']);
  assert.ok(Math.abs(Object.values(w1).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(w1.taste_match - 0.28 / 0.8) < 1e-9);
  assert.ok(Math.abs(w1.taste_match / w1.quality - 2) < 1e-9, 'taste_match:quality ratio preserved');
  // without llm_fit AND trending_eff: sum to 1.
  const w2 = f.renormalize(weights, ['taste_match', 'quality', 'consensus', 'freshness']);
  assert.ok(Math.abs(Object.values(w2).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(w2.taste_match - 0.28 / 0.6) < 1e-9);
  // all-zero → {}.
  assert.deepStrictEqual(f.renormalize({ a: 0, b: 0 }, ['a', 'b']), {});
});

ok('nuvio: normalizeProgressRow — Nuvio unit rules, percent, movie vs series (m2 engagement)', () => {
  const nuvio = require('../src/services/nuvio');
  // Explicit *_ms pair.
  let r = nuvio.normalizeProgressRow({ content_id: 'tt1', content_type: 'movie', position_ms: 1800000, duration_ms: 7200000, updated_at: '2026-05-01T00:00:00Z' });
  assert.strictEqual(r.type, 'movie'); assert.strictEqual(r.percent, 25); assert.strictEqual(r.updatedAtMs, Date.parse('2026-05-01T00:00:00Z'));
  // Legacy unitless pair in SECONDS (duration ≤ 8 h) → ms.
  r = nuvio.normalizeProgressRow({ content_id: 'tt2', position: 3600, duration: 7200 });
  assert.strictEqual(r.positionMs, 3600000); assert.strictEqual(r.durationMs, 7200000); assert.strictEqual(r.percent, 50);
  // Legacy unitless pair already in MILLISECONDS (duration > 8 h as seconds) → kept.
  r = nuvio.normalizeProgressRow({ content_id: 'tt3', position: 720000, duration: 7200000 });
  assert.strictEqual(r.durationMs, 7200000); assert.strictEqual(r.percent, 10);
  // The row's own progress_percent wins; trakt_history counts as finished.
  assert.strictEqual(nuvio.normalizeProgressRow({ content_id: 'tt4', progress_percent: 42, position_ms: 1, duration_ms: 100 }).percent, 42);
  assert.strictEqual(nuvio.normalizeProgressRow({ content_id: 'tt5', progress_percent: 60, source: 'trakt_history' }).percent, 100);
  // Episodes are series; non-tt ids are dropped; epoch-seconds timestamps convert.
  assert.strictEqual(nuvio.normalizeProgressRow({ content_id: 'tt6', content_type: 'series', season: 1, episode: 2, position_ms: 1, duration_ms: 2 }).type, 'series');
  assert.strictEqual(nuvio.normalizeProgressRow({ content_id: 'kitsu:1', position_ms: 1, duration_ms: 2 }), null);
  assert.strictEqual(nuvio.normalizeProgressRow({ content_id: 'tt7', position_ms: 1, duration_ms: 2, updated_at: 1780000000 }).updatedAtMs, 1780000000000);
});

ok('marquee m2: preScore — seed agreement leads; trending counts only in proportion to genre fit', () => {
  const f = require('../src/engines/marquee/features');
  const taste = { dims: { genres: { Action: 0.8 } } };
  const cand = {
    genres: ['Action'],
    sources: new Set(['tmdb_recs', 'simkl_recs']),
    _seedWeights: new Map([['s1', 0.6], ['s2', 0.2]]),
    trending: { tmdbWeekRank: 5, tmdbDayRank: null, simklWatched: 0, simklDrop: null },
    vote_average: 8,
  };
  const w = f.PRESCORE_DEFAULTS;
  const ga = 0.8;
  const sa = 0.8 / 1.6;                                   // seedAffinityRaw 0.8 over a build max of 1.6
  const tr = (1 - Math.log(5) / Math.log(101)) * Math.min(1, ga / w.trending_genre_gate);
  const expected = w.seed_affinity * sa + w.genre * ga + w.trending * tr + w.quality * 0.8 + w.sources * Math.min(1, 2 / 3);
  assert.ok(Math.abs(f.preScore(cand, taste, { weekN: 100, dayN: 40, maxSeedAff: 1.6 }) - expected) < 1e-9);
  assert.strictEqual(f.seedAffinityRaw(cand), 0.8);

  // Seed agreement beats a better genre match: a title four recent watches point
  // at outranks a single-seed title with a perfect genre fit.
  const agreed = { genres: ['Drama'], sources: new Set(['tmdb_recs']), _seedWeights: new Map([['a', 1], ['b', 1], ['c', 1], ['d', 1]]), trending: {}, vote_average: 7 };
  const lone = { genres: ['Action'], sources: new Set(['tmdb_recs']), _seedWeights: new Map([['a', 1]]), trending: {}, vote_average: 7 };
  const t2 = { dims: { genres: { Action: 1, Drama: 0.3 } } };
  assert.ok(f.preScore(agreed, t2, { maxSeedAff: 4 }) > f.preScore(lone, t2, { maxSeedAff: 4 }), 'seed agreement wins');

  // An off-taste trending blockbuster gets no trending credit at all.
  const offTaste = { genres: ['Horror'], sources: new Set(['trending']), trending: { tmdbWeekRank: 1 }, vote_average: 7 };
  const onTaste = { genres: ['Action'], sources: new Set(['trending']), trending: { tmdbWeekRank: 1 }, vote_average: 7 };
  const base = { genres: ['Horror'], sources: new Set(['trending']), trending: {}, vote_average: 7 };
  assert.strictEqual(f.preScore(offTaste, taste, { weekN: 100 }), f.preScore(base, taste, { weekN: 100 }), 'off-taste trending adds nothing');
  assert.ok(f.preScore(onTaste, taste, { weekN: 100 }) > f.preScore({ ...onTaste, trending: {} }, taste, { weekN: 100 }), 'on-taste trending adds');
});

ok('marquee m4 T1: genreRelativeNormalizer — blend of global + within-genre (spec §17)', () => {
  const f = require('../src/engines/marquee/features');
  // Group A: 6 candidates, values 10, 8, 7, 6, 5, 4 (the hub group).
  // Group B: 5 candidates, values 4, 3, 2, 1, 0.5 (the small genre).
  const cands = [...[10, 8, 7, 6, 5, 4].map((v) => ({ g: 'A', v })), ...[4, 3, 2, 1, 0.5].map((v) => ({ g: 'B', v }))];
  const valueOf = (c) => c.v;
  const groupOf = (c) => c.g;
  const bestB = { g: 'B', v: 4 };
  const normHalf = f.genreRelativeNormalizer(cands, valueOf, groupOf, { blend: 0.5, minGroupSize: 5 });
  assert.ok(Math.abs(normHalf(bestB) - (0.5 * (4 / 10) + 0.5 * 1)) < 1e-9, 'β=0.5 → 0.5·global + 0.5·genre = 0.7');
  const normZero = f.genreRelativeNormalizer(cands, valueOf, groupOf, { blend: 0, minGroupSize: 5 });
  assert.ok(Math.abs(normZero(bestB) - 0.4) < 1e-9, 'β=0 → pure global');
  const normOne = f.genreRelativeNormalizer(cands, valueOf, groupOf, { blend: 1, minGroupSize: 5 });
  assert.ok(Math.abs(normOne(bestB) - 1) < 1e-9, 'β=1 → pure within-genre');
  // The hub's best stays 1 under any blend.
  assert.ok(Math.abs(normHalf({ g: 'A', v: 10 }) - 1) < 1e-9, 'hub best stays 1');
  // A candidate not in cands is computed as if it were (group stats reused).
  assert.ok(Math.abs(normHalf({ g: 'B', v: 2 }) - (0.5 * 0.2 + 0.5 * 0.5)) < 1e-9, 'outside candidate uses group stats');
  // An unknown group falls back to the global normalisation.
  assert.ok(Math.abs(normHalf({ g: 'X', v: 4 }) - 0.4) < 1e-9, 'unknown group → global');
  // Blend is clamped to [0, 1].
  const normClamped = f.genreRelativeNormalizer(cands, valueOf, groupOf, { blend: 7, minGroupSize: 5 });
  assert.ok(Math.abs(normClamped(bestB) - 1) < 1e-9, 'blend > 1 clamps to 1');
});

ok('marquee m4 T2: genreRelativeNormalizer — small-group guard (minGroupSize)', () => {
  const f = require('../src/engines/marquee/features');
  // Group C has only 3 candidates → below minGroupSize 5 → global only.
  const cands = [...[10, 8, 7, 6, 5, 4].map((v) => ({ g: 'A', v })), ...[2, 1, 0.5].map((v) => ({ g: 'C', v }))];
  const bestC = { g: 'C', v: 2 };
  const normHalf = f.genreRelativeNormalizer(cands, (c) => c.v, (c) => c.g, { blend: 0.5, minGroupSize: 5 });
  const normZero = f.genreRelativeNormalizer(cands, (c) => c.v, (c) => c.g, { blend: 0, minGroupSize: 5 });
  assert.ok(Math.abs(normHalf(bestC) - normZero(bestC)) < 1e-9, 'small group → genreNorm = globalNorm (β=0 value)');
  assert.ok(Math.abs(normHalf(bestC) - 0.2) < 1e-9, 'value is the global-normalised 2/10');
  // A group of exactly minGroupSize keeps the within-genre normalisation.
  const cands5 = [...[10, 8, 7, 6, 5, 4].map((v) => ({ g: 'A', v })), ...[2, 1, 0.5, 0.4, 0.3].map((v) => ({ g: 'C', v }))];
  const normHalf5 = f.genreRelativeNormalizer(cands5, (c) => c.v, (c) => c.g, { blend: 0.5, minGroupSize: 5 });
  assert.ok(Math.abs(normHalf5(bestC) - (0.5 * 0.2 + 0.5 * 1)) < 1e-9, 'group of exactly 5 → within-genre applies');
});

ok('marquee m4 T3: primaryGenreOf — first genre of an array or comma string, else Other', () => {
  const f = require('../src/engines/marquee/features');
  assert.strictEqual(f.primaryGenreOf({ genres: ['Comedy', 'Drama'] }), 'Comedy', 'array → first');
  assert.strictEqual(f.primaryGenreOf({ genres: 'Comedy, Drama' }), 'Comedy', 'comma string → first trimmed');
  assert.strictEqual(f.primaryGenreOf({ genres: ' , Drama' }), 'Drama', 'skips empty entries');
  assert.strictEqual(f.primaryGenreOf({ genres: [] }), 'Other', 'empty array → Other');
  assert.strictEqual(f.primaryGenreOf({ genres: '' }), 'Other', 'empty string → Other');
  assert.strictEqual(f.primaryGenreOf({ genres: ',,' }), 'Other', 'only empty entries → Other');
  assert.strictEqual(f.primaryGenreOf({}), 'Other', 'no genres → Other');
  assert.strictEqual(f.primaryGenreOf(null), 'Other', 'null candidate → Other');
});

ok('marquee ME-05: parseSuggestions — fenced JSON, invalid year/title dropped, dedupe, all-invalid throws', () => {
  const sources = require('../src/engines/marquee/sources');
  // fenced JSON + a valid item.
  const ok1 = sources.parseSuggestions('```json\n[{"title": "Alpha", "year": 2010}, {"title": "Beta"}]\n```', { nowYear: 2026 });
  assert.deepStrictEqual(ok1, [{ title: 'Alpha', year: 2010 }, { title: 'Beta', year: null }]);
  // invalid year (out of range) dropped; non-string title dropped; dedupe by lowercased title+year.
  const ok2 = sources.parseSuggestions('[{"title": "Alpha", "year": 2010}, {"title": "alpha", "year": 2010}, {"title": "BadYear", "year": 1899}, {"title": 42}, {"title": "LongTitleOverOneHundredTwentyCharactersLongTitleOverOneHundredTwentyCharactersLongTitleOverOneHundredTwentyCharactersLongTitleOverOneHundredTwentyCharacters", "year": 2010}]', { nowYear: 2026 });
  assert.deepStrictEqual(ok2, [{ title: 'Alpha', year: 2010 }]);
  // all-invalid throws.
  assert.throws(() => sources.parseSuggestions('[{"title": "BadYear", "year": 1899}]', { nowYear: 2026 }));
});

ok('marquee ME-05: buildSuggestPrompt — filter rules in words, never age/suitability/classification (kids included)', () => {
  const sources = require('../src/engines/marquee/sources');
  const p = sources.buildSuggestPrompt({
    brief: { loves: ['Sci-Fi'], avoids: ['Horror'], moods: ['tense'], eras: ['2010s'], standout_titles: ['A'] },
    minYear: 2016, minRating: 6, excludedGenres: ['Anime', 'Kids'],
    avoidRecent: [{ title: 'Recent One', year: 2025 }],
    count: 60,
  });
  assert.ok(p.includes('released in or after 2016'));
  assert.ok(p.includes('rated at least 6 on IMDb'));
  assert.ok(p.includes('not these genres: Anime, Kids'));
  assert.ok(p.includes('Recent One (2025)'));
  // never age/suitability/classification/child wording — even for a kids-profile
  // input. (Genre NAMES from the brief's avoids list, e.g. 'Kids', are data the
  // viewer asked for, not classification wording.)
  assert.ok(!/age|suitab|classif|child/i.test(p), 'no age wording: ' + p);
});

// ---- Marquee ME-07 (pure) ----
ok('marquee ME-07: parseFit — invented id ignored, duplicate first wins, clamp, non-number missing, reason truncate', () => {
  const llmFit = require('../src/engines/marquee/llmFit');
  const words20 = Array.from({ length: 20 }, (_, i) => 'w' + i).join(' ');
  const m = llmFit.parseFit([
    { id: 'x', fit: 9 }, // invented (not in the batch) → ignored
    { id: '1', fit: -3 }, // clamp → 0
    { id: '1', fit: 14 }, // duplicate → first wins
    { id: '2', fit: 'high' }, // non-number → missing
    { id: '3', fit: 8, reason: words20 }, // 20 words → truncated to 14
    { id: '4', fit: 5, reason: null },
  ], ['1', '2', '3', '4']);
  assert.ok(!m.has('x'), 'invented id ignored');
  assert.deepStrictEqual(m.get('1'), { fit: 0, reason: null }, 'fit -3 → 0, duplicate first wins');
  assert.ok(!m.has('2'), 'non-number fit → item missing');
  assert.strictEqual(m.get('3').fit, 8);
  assert.strictEqual(m.get('3').reason.split(/\s+/).length, 14, '20-word reason truncated to 14 words');
  assert.deepStrictEqual(m.get('4'), { fit: 5, reason: null });
});

ok('marquee ME-07: buildFitPrompt — brief + item data, cert as context only, no age/suitability wording', () => {
  const llmFit = require('../src/engines/marquee/llmFit');
  const p = llmFit.buildFitPrompt(
    { loves: ['Action'], avoids: ['Horror'], moods: ['thrilling'], eras: ['2010s'], standout_titles: ['Inception'] },
    [{ id: '1', title: 'Alpha', year: 2020, overview: 'ov', director: 'D', keywords: ['k1'], cert: 'M' }],
  );
  assert.ok(p.includes('Action') && p.includes('Horror'), 'brief content present');
  assert.ok(p.includes('Alpha'), 'item title present');
  assert.ok(p.includes('Classification: M'), 'cert as descriptive context');
  assert.ok(!/suitab|appropriate|child|kid|age limit|for ages/i.test(p), 'no age/suitability wording: ' + p);
});

// ---- Marquee ME-08 (pure) ----
ok('marquee ME-08: shapeOutput — franchise cap, store cap, exact shortfall line, _fit/_preScore stripped', () => {
  const shape = require('../src/engines/marquee/shape');
  const cfg = require('../src/engines/marquee/config').DEFAULTS;
  const mk = (id, cid, score) => ({
    type: 'movie', tmdb_id: id, rankScore: score, reason: null,
    scoreComponents: { features: {}, weights: {}, penalty: 0, inputs: { collection_id: cid }, llm: { fit: 5, reason: null, cached: false } },
    _fit: { overview: 'x' }, _preScore: 0.5,
  });
  const warn = [];
  const log = { log() {}, warn(m) { warn.push(m); }, error() {} };

  // 5 rows, one collection → at most 2 of it kept; no-collection rows uncapped.
  const rows = [mk('a1', 1, 5), mk('a2', 1, 4), mk('a3', 1, 3), mk('b1', null, 2), mk('b2', null, 1)];
  const out = shape.shapeOutput(rows, { cfg, listSize: 20, envelopeStats: {}, log });
  assert.deepStrictEqual(out.map((r) => r.tmdb_id), ['a1', 'a2', 'b1', 'b2'], 'franchise cap 2 on the collection');
  assert.ok(out.every((r) => !('_fit' in r) && !('_preScore' in r)), '_fit/_preScore stripped');

  // Store cap.
  const outCap = shape.shapeOutput(rows, { cfg: { ...cfg, store_cap: 3 }, listSize: 20, envelopeStats: {}, log });
  assert.deepStrictEqual(outCap.map((r) => r.tmdb_id), ['a1', 'a2', 'b1'], 'store cap 3');

  // Exact shortfall line — the 4 largest non-zero counters, descending.
  warn.length = 0;
  shape.shapeOutput(rows, { cfg, listSize: 20, envelopeStats: { cert_over: 10, votes: 7, genre: 3, adult: 2, rating: 1 }, log });
  assert.deepStrictEqual(warn, ['[marquee] : shortfall 4/150 — blockers: cert_over 10, votes 7, genre 3, adult 2'], 'shortfall line, dominant blocker first');

  // No non-zero counters → 'blockers: none recorded'.
  warn.length = 0;
  shape.shapeOutput(rows, { cfg, listSize: 20, envelopeStats: { no_imdb: 0, votes: 0 }, log });
  assert.deepStrictEqual(warn, ['[marquee] : shortfall 4/150 — blockers: none recorded'], 'none recorded');

  // No shortfall → no warn.
  warn.length = 0;
  const big = Array.from({ length: 150 }, (_, i) => mk('z' + i, null, 150 - i));
  shape.shapeOutput(big, { cfg, listSize: 20, envelopeStats: {}, log });
  assert.deepStrictEqual(warn, [], 'no warn at target');
});

// ---- Marquee ME-09 (pure) ----
ok('marquee ME-09: resolveConfig — Tier-2 merge semantics (spec §4.5)', () => {
  const mc = require('../src/engines/marquee/config');

  // A nested override changes only that leaf; siblings keep defaults.
  const r1 = mc.resolveConfig({ marquee: { weights: { quality: 0.5 } } });
  assert.strictEqual(r1.weights.quality, 0.5, 'weights.quality overridden');
  assert.strictEqual(r1.weights.taste_match, 0.24, 'sibling weight untouched');
  assert.strictEqual(r1.franchise_cap, 2, 'unrelated section untouched');

  // Top-level scalar override.
  const r2 = mc.resolveConfig({ marquee: { franchise_cap: 1, store_cap: 50 } });
  assert.strictEqual(r2.franchise_cap, 1, 'franchise_cap overridden');
  assert.strictEqual(r2.store_cap, 50, 'store_cap overridden');
  assert.strictEqual(r2.min_supply, 150, 'min_supply untouched');

  // Unknown sections are ignored (no throw, no leak into cfg).
  const r3 = mc.resolveConfig({ marquee: { bogus: { x: 1 }, other: 42 } });
  assert.ok(!('bogus' in r3) && !('other' in r3), 'unknown sections ignored');
  assert.deepStrictEqual(r3, mc.resolveConfig({}), 'unknown-only blob → pure defaults');

  // Malformed blob: non-object marquee → defaults, never throws.
  assert.deepStrictEqual(mc.resolveConfig({ marquee: 'x' }), mc.resolveConfig({}), "marquee: 'x' → defaults");
  assert.deepStrictEqual(mc.resolveConfig({ marquee: null }), mc.resolveConfig({}), 'marquee: null → defaults');
  assert.deepStrictEqual(mc.resolveConfig({}), mc.resolveConfig(null), 'no settings → defaults');

  // A glass blob never touches Marquee's config (independent blobs, spec §4.5).
  const r4 = mc.resolveConfig({ glass: { weights: { quality: 0.99 } }, marquee: {} });
  assert.strictEqual(r4.weights.quality, 0.10, 'glass blob does not leak into Marquee');

  // The result is a fresh clone — mutating it never touches DEFAULTS.
  const r5 = mc.resolveConfig({ marquee: { franchise_cap: 7 } });
  r5.franchise_cap = 999;
  r5.weights.quality = 999;
  assert.strictEqual(mc.DEFAULTS.franchise_cap, 2, 'DEFAULTS untouched');
  assert.strictEqual(mc.DEFAULTS.weights.quality, 0.10, 'DEFAULTS untouched');
});

// ---- Trainer UI (T3): the pure helpers in public/trainer-ui.js ----
const TrainerUI = require('../public/trainer-ui');

ok('trainer: esc escapes all 5 chars, null/undefined → empty', () => {
  assert.strictEqual(TrainerUI.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(TrainerUI.esc('a&b"c\'d'), 'a&amp;b&quot;c&#39;d');
  assert.strictEqual(TrainerUI.esc(null), '');
  assert.strictEqual(TrainerUI.esc(undefined), '');
  assert.strictEqual(TrainerUI.esc(42), '42');
});

ok('trainer: whenText — today, yesterday, N days ago, en-AU date, null → —', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  assert.strictEqual(TrainerUI.whenText('2026-03-15T08:00:00Z', now), 'today');
  assert.strictEqual(TrainerUI.whenText('2026-03-14T12:00:00Z', now), 'yesterday');
  assert.strictEqual(TrainerUI.whenText('2026-03-10T12:00:00Z', now), '5 days ago');
  assert.strictEqual(TrainerUI.whenText('2026-02-01T12:00:00Z', now), '1 Feb 2026');
  assert.strictEqual(TrainerUI.whenText(null, now), '—');
  assert.strictEqual(TrainerUI.whenText('not-a-date', now), '—');
});

ok('trainer: starsFromRating + ratingFromStarClick round trip', () => {
  assert.deepStrictEqual(TrainerUI.starsFromRating(null), [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(TrainerUI.starsFromRating(1), [0.5, 0, 0, 0, 0]);
  assert.deepStrictEqual(TrainerUI.starsFromRating(2), [1, 0, 0, 0, 0]);
  assert.deepStrictEqual(TrainerUI.starsFromRating(7), [1, 1, 1, 0.5, 0]);
  assert.deepStrictEqual(TrainerUI.starsFromRating(10), [1, 1, 1, 1, 1]);
  assert.strictEqual(TrainerUI.ratingFromStarClick(3, 'left'), 7);
  assert.strictEqual(TrainerUI.ratingFromStarClick(3, 'right'), 8);
  // All 10 halves: the clicked half is lit, earlier stars full, later empty.
  for (let i = 0; i < 5; i++) {
    for (const half of ['left', 'right']) {
      const r = TrainerUI.ratingFromStarClick(i, half);
      const levels = TrainerUI.starsFromRating(r);
      assert.strictEqual(levels[i], half === 'left' ? 0.5 : 1);
      assert.ok(levels.slice(0, i).every(x => x === 1));
      assert.ok(levels.slice(i + 1).every(x => x === 0));
    }
  }
});

ok('trainer: nextRatingForHeart — 10 clears, anything else loves', () => {
  assert.strictEqual(TrainerUI.nextRatingForHeart(10), null);
  assert.strictEqual(TrainerUI.nextRatingForHeart(7), 10);
  assert.strictEqual(TrainerUI.nextRatingForHeart(null), 10);
});

ok('trainer: chipsHtml — 6 chips with counts, exactly one aria-pressed=true', () => {
  const counts = { all: 10, unrated: 4, rated: 3, loved: 1, ignored: 2, unfinished: 5 };
  const html = TrainerUI.chipsHtml(counts, 'loved');
  for (const [id, label] of TrainerUI.VIEWS) {
    assert.ok(html.includes(`data-view="${id}"`), 'chip ' + id);
    assert.ok(html.includes(label), 'label ' + label);
  }
  assert.ok(html.includes('<span class="tr-count">10</span>'));
  assert.ok(html.includes('<span class="tr-count">5</span>'));
  assert.strictEqual((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.ok(html.includes('data-view="loved" title="Films you rated 10/10" aria-pressed="true"'));
  assert.ok(html.includes('data-view="all" title="Everything you&#39;ve watched (except ignored)" aria-pressed="false"'));
});

ok('trainer: rowHtml — stars, actions, disabled states, XSS title', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: null, loved: false, ignored: false, status: 'watched', percent: 100 };
  // Watched item: 10 star buttons with the right aria-labels, group labelled.
  let html = TrainerUI.rowHtml(base, { canRate: true, now });
  for (let n = 1; n <= 10; n++) assert.ok(html.includes(`aria-label="Rate ${n} out of 10"`), 'aria ' + n);
  assert.strictEqual(html.match(/data-rating="/g).length, 10);
  assert.ok(html.includes('role="group"') && html.includes('aria-label="Your rating"'));
  // Loved: ♥ aria-pressed=true; a clear button appears once rated.
  html = TrainerUI.rowHtml({ ...base, rating: 10, loved: true }, { canRate: true, now });
  assert.ok(html.includes('data-act="love" aria-pressed="true"'));
  assert.ok(html.includes('data-act="clear"'));
  html = TrainerUI.rowHtml(base, { canRate: true, now });
  assert.ok(!html.includes('data-act="clear"'));
  // Ignored: Unignore action, stars still rendered but disabled.
  html = TrainerUI.rowHtml({ ...base, ignored: true, rating: 5, loved: false }, { canRate: true, now });
  assert.ok(html.includes('data-act="unignore"'));
  assert.ok(html.includes('disabled'));
  assert.ok(!html.includes('data-act="love"'));
  // Unfinished: Stopped at 30%, no star buttons, "I finished it".
  html = TrainerUI.rowHtml({ ...base, status: 'unfinished', percent: 30, rating: null }, { canRate: true, now });
  assert.ok(html.includes('Stopped at 30%'));
  assert.ok(html.includes('data-act="finished"'));
  assert.ok(!html.includes('data-rating'));
  assert.ok(!html.includes('data-act="clear"'));
  // canRate=false: every rating control disabled (ignore stays enabled).
  const disabledCount = (h) => (h.match(/title="Connect Simkl to rate"/g) || []).length;
  assert.strictEqual(disabledCount(TrainerUI.rowHtml(base, { canRate: false, now })), 12); // 10 stars + ♥ + unwatch
  assert.strictEqual(disabledCount(TrainerUI.rowHtml({ ...base, rating: 7 }, { canRate: false, now })), 13); // + clear
  assert.strictEqual(disabledCount(TrainerUI.rowHtml({ ...base, status: 'unfinished', percent: 30 }, { canRate: false, now })), 1); // finished
  // XSS title is escaped: with poster null the output has no raw <img.
  const xss = TrainerUI.rowHtml({ ...base, poster: null, title: '<img src=x onerror=alert(1)>' }, { canRate: true, now });
  assert.ok(!xss.includes('<img'));
  assert.ok(xss.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

ok('trainer r1: rowHtml — 10 star hit areas with data-act="star"', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: null, loved: false, ignored: false, status: 'watched', percent: 100 };
  const html = TrainerUI.rowHtml(base, { canRate: true, now });
  assert.strictEqual(html.match(/data-act="star"/g).length, 10);
});

ok('trainer r1: every data-act value is in TrainerUI.ACTIONS', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: 7, loved: false, ignored: false, status: 'watched', percent: 100 };
  const variants = [
    TrainerUI.rowHtml(base, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, ignored: true }, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, status: 'unfinished', percent: 30, rating: null }, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, rating: 10, loved: true }, { canRate: true, now }),
    TrainerUI.bannerHtml({ changes_since_build: 3, changed_at: now - 60000, rebuild_due_at: now + 7 * 60000, built_changed_at: now - 3600e3 }, now, { rebuilding: false }),
    TrainerUI.pagerText(1, 25, 40),
  ];
  for (const html of variants) {
    for (const m of html.matchAll(/data-act="([^"]+)"/g)) {
      assert.ok(TrainerUI.ACTIONS.includes(m[1]), 'data-act ' + m[1] + ' not in ACTIONS');
    }
  }
});

ok('trainer r1: star wrap has glyph, fill, two hit areas; no clip-path', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: 7, loved: false, ignored: false, status: 'watched', percent: 100 };
  const html = TrainerUI.rowHtml(base, { canRate: true, now });
  assert.strictEqual(html.match(/class="tr-star-wrap"/g).length, 5);
  assert.strictEqual(html.match(/class="tr-glyph"/g).length, 5);
  assert.strictEqual(html.match(/class="tr-fill"/g).length, 5);
  assert.strictEqual(html.match(/class="tr-star"/g).length, 10);
  // Rating 7 → stars 1–3 full (100%), star 4 half (50%), star 5 empty (0%).
  const fills = [...html.matchAll(/class="tr-fill"[^>]*style="width:([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(fills, ['100%', '100%', '100%', '50%', '0%']);
  assert.ok(!html.includes('clip-path'));
});

ok('trainer: bannerHtml — empty, about M min, due within the hour, rebuilding', () => {
  const now = 1_700_000_000_000;
  const none = { changes_since_build: 0, changed_at: null, rebuild_due_at: null, built_changed_at: null };
  assert.strictEqual(TrainerUI.bannerHtml(none, now, { rebuilding: false }), '');
  let html = TrainerUI.bannerHtml({ changes_since_build: 3, changed_at: now - 60000, rebuild_due_at: now + 7 * 60000, built_changed_at: now - 3600e3 }, now, { rebuilding: false });
  assert.ok(html.includes('3 changes since the last build'));
  assert.ok(html.includes('rebuild in about 7 min'));
  assert.ok(html.includes('data-act="rebuild"'));
  assert.ok(html.includes('Rebuild now'));
  html = TrainerUI.bannerHtml({ changes_since_build: 1, changed_at: now - 60000, rebuild_due_at: now - 60000, built_changed_at: null }, now, { rebuilding: false });
  assert.ok(html.includes('1 change since the last build'));
  assert.ok(html.includes('rebuild due within the hour'));
  html = TrainerUI.bannerHtml(none, now, { rebuilding: true });
  assert.ok(html.includes('Rebuilding…'));
  assert.ok(html.includes('tr-joblabel'));
  assert.ok(html.includes('Rebuild now'));
});

ok('trainer: createRateQueue — debounce, one in flight, next after settle', () => {
  const mkHarness = () => {
    const timers = [];
    const setTimer = (fn) => { timers.push({ fn, cancelled: false }); return timers.length - 1; };
    const clearTimer = (id) => { timers[id].cancelled = true; };
    const fire = (id) => { if (!timers[id].cancelled) timers[id].fn(); };
    return { timers, setTimer, clearTimer, fire, latest: () => timers.length - 1 };
  };
  // 3 pushes within 800 ms → exactly 1 send, with the last value.
  let h = mkHarness();
  let sends = [];
  let settles = [];
  let q = TrainerUI.createRateQueue({ send: (k, r) => { sends.push({ k, r }); return { ok: true }; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, (e, r) => settles.push({ e: !!e, r }));
  q.push('a', 5, (e, r) => settles.push({ e: !!e, r }));
  q.push('a', 7, (e, r) => settles.push({ e: !!e, r }));
  assert.strictEqual(h.timers[0].cancelled, true);
  assert.strictEqual(h.timers[1].cancelled, true);
  assert.strictEqual(q.pending('a'), true);
  h.fire(h.latest());
  assert.deepStrictEqual(sends, [{ k: 'a', r: 7 }]);
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(q.pending('a'), false);
  assert.strictEqual(q.pending('b'), false);
  // A push while one is in flight → sent right after it settles.
  h = mkHarness();
  sends = [];
  let inFlight = false;
  q = TrainerUI.createRateQueue({
    send: (k, r) => {
      sends.push({ k, r });
      if (!inFlight) { inFlight = true; q.push(k, 5, () => {}); h.fire(h.latest()); }
      return { ok: true };
    },
    delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer,
  });
  q.push('a', 3, () => {});
  h.fire(h.latest());
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }, { k: 'a', r: 5 }]);
  assert.strictEqual(q.pending('a'), false);
  // A "next" equal to the in-flight value → not resent.
  h = mkHarness();
  sends = [];
  let pushed = false;
  q = TrainerUI.createRateQueue({
    send: (k, r) => {
      sends.push({ k, r });
      if (!pushed) { pushed = true; q.push(k, 3, () => {}); h.fire(h.latest()); }
      return { ok: true };
    },
    delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer,
  });
  q.push('a', 3, () => {});
  h.fire(h.latest());
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }]);
  // Two different keys are independent.
  h = mkHarness();
  sends = [];
  q = TrainerUI.createRateQueue({ send: (k, r) => { sends.push({ k, r }); return {}; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, () => {});
  q.push('b', 5, () => {});
  h.fire(h.latest());
  h.fire(h.timers.length - 2);
  assert.deepStrictEqual(sends.sort((x, y) => x.k.localeCompare(y.k)), [{ k: 'a', r: 3 }, { k: 'b', r: 5 }]);
  // onSettle gets the error on failure.
  h = mkHarness();
  let settled = null;
  q = TrainerUI.createRateQueue({ send: () => { throw new Error('boom'); }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, (e, r) => { settled = { e: e && e.message, r }; });
  h.fire(h.latest());
  assert.strictEqual(settled.e, 'boom');
  assert.strictEqual(settled.r, null);
  assert.strictEqual(q.pending('a'), false);
});

// H4a: settle order — a newer value queued while one is in flight is moved into
// inflight before onSettle fires, so pending(key) is true inside the settled
// value's onSettle. The newer value is sent right after.
ok('trainer r1: H4a — settle order, pending reflects the queued next', () => {
  const mkHarness = () => {
    const timers = [];
    const setTimer = (fn) => { timers.push({ fn, cancelled: false }); return timers.length - 1; };
    const clearTimer = (id) => { timers[id].cancelled = true; };
    const fire = (id) => { if (!timers[id].cancelled) timers[id].fn(); };
    return { timers, setTimer, clearTimer, fire, latest: () => timers.length - 1 };
  };
  const h = mkHarness();
  const sends = [];
  const thenables = [];
  // A thenable whose settle() invokes the .then callback synchronously, so the
  // settle (and its onSettle) runs inside the call — the ok() harness is sync.
  const makeThenable = () => {
    let resolve = null;
    return { then: (res) => { resolve = res; }, settle: (value) => { if (resolve) resolve(value); } };
  };
  const q = TrainerUI.createRateQueue({
    send: (k, r) => {
      const t = makeThenable();
      thenables.push(t);
      sends.push({ k, r });
      return t;
    },
    delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer,
  });
  let pendingInA = null, pendingInB = null;
  q.push('a', 3, (e, r) => { pendingInA = q.pending('a'); });
  h.fire(h.latest()); // 3 goes in flight (send returns a pending thenable)
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }]);
  q.push('a', 7, (e, r) => { pendingInB = q.pending('a'); });
  h.fire(h.latest()); // 7 is queued as "next" while 3 is still in flight
  thenables[0].settle({ ok: true }); // settle 3 (synchronous)
  assert.strictEqual(pendingInA, true); // inside 3's onSettle, pending is true (7 on its way)
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }, { k: 'a', r: 7 }]); // 7 sent right after
  thenables[1].settle({ ok: true }); // settle 7
  assert.strictEqual(pendingInB, false); // inside 7's onSettle, pending is false
});

// H4b: a "next" equal to the in-flight value is NOT resent — no second send,
// and pending(key) is false inside onSettle.
ok('trainer r1: H4b — an equal next is not resent', () => {
  const mkHarness = () => {
    const timers = [];
    const setTimer = (fn) => { timers.push({ fn, cancelled: false }); return timers.length - 1; };
    const clearTimer = (id) => { timers[id].cancelled = true; };
    const fire = (id) => { if (!timers[id].cancelled) timers[id].fn(); };
    return { timers, setTimer, clearTimer, fire, latest: () => timers.length - 1 };
  };
  const h = mkHarness();
  const sends = [];
  const thenables = [];
  const makeThenable = () => {
    let resolve = null;
    return { then: (res) => { resolve = res; }, settle: (value) => { if (resolve) resolve(value); } };
  };
  const q = TrainerUI.createRateQueue({
    send: (k, r) => {
      const t = makeThenable();
      thenables.push(t);
      sends.push({ k, r });
      return t;
    },
    delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer,
  });
  let pendingInA = null;
  q.push('a', 3, (e, r) => { pendingInA = q.pending('a'); });
  h.fire(h.latest()); // 3 goes in flight
  q.push('a', 3, (e, r) => {}); // same value again
  h.fire(h.latest()); // "next" is 3, equal to the in-flight 3
  thenables[0].settle({ ok: true }); // settle 3 (synchronous)
  assert.strictEqual(pendingInA, false); // no newer value, so pending is false
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }]); // exactly one send, no second
});

// F1: flush() sends every pending-timer value now — used when the page is
// hidden/closing, so a rating made just before leaving is never lost.
ok('trainer T4.1 F1: flush sends pending ratings on page hide', () => {
  const mkHarness = () => {
    const timers = [];
    const setTimer = (fn) => { timers.push({ fn, cancelled: false }); return timers.length - 1; };
    const clearTimer = (id) => { timers[id].cancelled = true; };
    const fire = (id) => { if (!timers[id].cancelled) timers[id].fn(); };
    return { timers, setTimer, clearTimer, fire, latest: () => timers.length - 1 };
  };
  const makeThenable = () => {
    let resolve = null;
    return { then: (res) => { resolve = res; }, settle: (value) => { if (resolve) resolve(value); } };
  };
  // F1a: push A, then flush() before the timer → exactly 1 send of A with
  // { keepalive:true }, and the timer is cancelled (firing it later sends nothing).
  let h = mkHarness();
  let sends = [];
  let q = TrainerUI.createRateQueue({ send: (k, r, o) => { sends.push({ k, r, keepalive: !!o.keepalive }); return { ok: true }; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 7, () => {});
  assert.strictEqual(q.flush(), 1);
  assert.deepStrictEqual(sends, [{ k: 'a', r: 7, keepalive: true }]);
  h.fire(h.latest()); // the cancelled timer does not send again
  assert.deepStrictEqual(sends, [{ k: 'a', r: 7, keepalive: true }]);
  // F1b: with nothing pending → flush() returns 0 and sends nothing.
  h = mkHarness();
  sends = [];
  q = TrainerUI.createRateQueue({ send: (k, r, o) => { sends.push({ k, r }); return { ok: true }; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  assert.strictEqual(q.flush(), 0);
  assert.deepStrictEqual(sends, []);
  // F1c: A in flight and B pending on a timer → flush() sends B immediately;
  // if B equals A → no send.
  h = mkHarness();
  sends = [];
  q = TrainerUI.createRateQueue({ send: (k, r, o) => { const t = makeThenable(); sends.push({ k, r }); return t; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, () => {});
  h.fire(h.latest()); // A (3) goes in flight
  q.push('a', 7, () => {}); // B (7) pending on a timer
  assert.strictEqual(q.flush(), 1);
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }, { k: 'a', r: 7 }]);
  h = mkHarness();
  sends = [];
  q = TrainerUI.createRateQueue({ send: (k, r, o) => { const t = makeThenable(); sends.push({ k, r }); return t; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, () => {});
  h.fire(h.latest()); // A (3) goes in flight
  q.push('a', 3, () => {}); // B equals A
  assert.strictEqual(q.flush(), 0);
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }]);
  // F1d: two keys pending → 2 sends.
  h = mkHarness();
  sends = [];
  q = TrainerUI.createRateQueue({ send: (k, r, o) => { sends.push({ k, r }); return { ok: true }; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, () => {});
  q.push('b', 5, () => {});
  assert.strictEqual(q.flush(), 2);
  assert.deepStrictEqual(sends.sort((x, y) => x.k.localeCompare(y.k)), [{ k: 'a', r: 3 }, { k: 'b', r: 5 }]);
  // B1: A in flight, B already queued as `next` behind it (timer fired) →
  // flush() sends B immediately with { keepalive:true }; settling A later does
  // not resend B. (Part B — a value queued behind an in-flight save now flushes.)
  h = mkHarness();
  sends = [];
  let aThenable = null;
  q = TrainerUI.createRateQueue({ send: (k, r, o) => { const t = makeThenable(); sends.push({ k, r, keepalive: !!o.keepalive }); if (r === 3) aThenable = t; return t; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, () => {});
  h.fire(h.latest()); // A (3) goes in flight
  q.push('a', 7, () => {});
  h.fire(h.latest()); // B (7) queued as next behind the in-flight A
  assert.strictEqual(q.flush(), 1);
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3, keepalive: false }, { k: 'a', r: 7, keepalive: true }]);
  aThenable.settle({ ok: true }); // settling A later does not resend B
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3, keepalive: false }, { k: 'a', r: 7, keepalive: true }]);
  // B2: same but B equals A → flush() sends nothing and clears next.
  h = mkHarness();
  sends = [];
  q = TrainerUI.createRateQueue({ send: (k, r, o) => { const t = makeThenable(); sends.push({ k, r }); return t; }, delayMs: 800, setTimer: h.setTimer, clearTimer: h.clearTimer });
  q.push('a', 3, () => {});
  h.fire(h.latest()); // A (3) goes in flight
  q.push('a', 3, () => {});
  h.fire(h.latest()); // B (3) equals A, queued as next behind the in-flight A
  assert.strictEqual(q.flush(), 0);
  assert.deepStrictEqual(sends, [{ k: 'a', r: 3 }]);
  // B3: the existing F1a–F1d cases above are unchanged and still pass.
});

// ---- Trainer T3.1 refinements: tooltips, unwatch button, rows stay put ----
ok('trainer T3.1 U1: every button/chip has a title; disabled rate controls say "Connect Simkl to rate"', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: 7, loved: false, ignored: false, status: 'watched', percent: 100 };
  const variants = [
    TrainerUI.rowHtml(base, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, rating: 10, loved: true }, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, ignored: true }, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, status: 'unfinished', percent: 30, rating: null }, { canRate: true, now }),
    TrainerUI.rowHtml(base, { canRate: false, now }),
  ];
  for (const html of variants) {
    for (const b of [...html.matchAll(/<button[^>]*>/g)].map(m => m[0])) assert.ok(b.includes('title="'), 'row button has a title: ' + b);
  }
  const chips = TrainerUI.chipsHtml({ all: 1, unrated: 1, rated: 1, loved: 1, ignored: 1, unfinished: 1 }, 'all');
  for (const b of [...chips.matchAll(/<button[^>]*>/g)].map(m => m[0])) assert.ok(b.includes('title="'), 'chip has a title: ' + b);
  const banner = TrainerUI.bannerHtml({ changes_since_build: 3, changed_at: now - 60000, rebuild_due_at: now + 7 * 60000, built_changed_at: now - 3600e3 }, now, { rebuilding: false });
  for (const b of [...banner.matchAll(/<button[^>]*>/g)].map(m => m[0])) assert.ok(b.includes('title="'), 'banner button has a title: ' + b);
  // the disabled rate controls (canRate:false) say "Connect Simkl to rate"
  const dis = TrainerUI.rowHtml(base, { canRate: false, now });
  const disButtons = [...dis.matchAll(/<button[^>]*>/g)].map(m => m[0]).filter(b => b.includes('disabled'));
  assert.ok(disButtons.length >= 10, 'rate controls are disabled');
  for (const b of disButtons) assert.ok(b.includes('title="Connect Simkl to rate"'), 'disabled rate control says Connect Simkl to rate: ' + b);
});

ok('trainer T3.1 U2: star titles read "Rate N/10"; ♥ uses unlove when loved, love otherwise', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: 7, loved: false, ignored: false, status: 'watched', percent: 100 };
  const html = TrainerUI.rowHtml(base, { canRate: true, now });
  for (const m of html.matchAll(/<button[^>]*data-act="star"[^>]*data-rating="(\d+)"[^>]*title="([^"]*)"/g)) {
    assert.ok(m[2].startsWith('Rate ' + m[1] + '/10'), 'star title for rating ' + m[1] + ': ' + m[2]);
  }
  const star7 = html.match(/<button[^>]*data-rating="7"[^>]*title="([^"]*)"/);
  assert.ok(star7 && star7[1].startsWith('Rate 7/10'), 'data-rating="7" → Rate 7/10 title');
  const loved = TrainerUI.rowHtml({ ...base, rating: 10, loved: true }, { canRate: true, now });
  assert.ok(loved.includes('title="Remove love — clears the 10/10 rating"'), 'unlove tip when loved');
  assert.ok(loved.includes('title="Love it — rates 10/10. Loved films always count as a favourite in Marquee"') === false, 'no love tip when loved');
  const notLoved = TrainerUI.rowHtml(base, { canRate: true, now });
  assert.ok(notLoved.includes('title="Love it — rates 10/10. Loved films always count as a favourite in Marquee"'), 'love tip when not loved');
});

ok('trainer T3.1 U3: a watched row (ignored or not) has exactly one unwatch; an unfinished row has none', () => {
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: 7, loved: false, ignored: false, status: 'watched', percent: 100 };
  const count = (h) => (h.match(/data-act="unwatch"/g) || []).length;
  assert.strictEqual(count(TrainerUI.rowHtml(base, { canRate: true, now })), 1, 'non-ignored watched row');
  assert.strictEqual(count(TrainerUI.rowHtml({ ...base, ignored: true }, { canRate: true, now })), 1, 'ignored watched row');
  assert.strictEqual(count(TrainerUI.rowHtml({ ...base, status: 'unfinished', percent: 30, rating: null }, { canRate: true, now })), 0, 'unfinished row');
});

ok('trainer T3.1 U4: ACTIONS includes unwatch; every emitted data-act is in ACTIONS', () => {
  assert.ok(TrainerUI.ACTIONS.includes('unwatch'), 'ACTIONS includes unwatch');
  const now = Date.parse('2026-03-15T12:00:00Z');
  const base = { key: '1', type: 'movie', simkl_id: 11, tmdb_id: '1', imdb_id: 'tt1', title: 'The Film', year: 2024, genre: 'Drama', poster: 'https://img.example/p.jpg', watched_at: '2026-03-10T12:00:00Z', rating: 7, loved: false, ignored: false, status: 'watched', percent: 100 };
  const variants = [
    TrainerUI.rowHtml(base, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, ignored: true }, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, status: 'unfinished', percent: 30, rating: null }, { canRate: true, now }),
    TrainerUI.rowHtml({ ...base, rating: 10, loved: true }, { canRate: true, now }),
    TrainerUI.chipsHtml({ all: 1, unrated: 1, rated: 1, loved: 1, ignored: 1, unfinished: 1 }, 'all'),
    TrainerUI.bannerHtml({ changes_since_build: 3, changed_at: now - 60000, rebuild_due_at: now + 7 * 60000, built_changed_at: now - 3600e3 }, now, { rebuilding: false }),
  ];
  for (const html of variants) {
    for (const m of html.matchAll(/data-act="([^"]+)"/g)) {
      assert.ok(TrainerUI.ACTIONS.includes(m[1]), 'data-act ' + m[1] + ' not in ACTIONS');
    }
  }
});

ok('trainer T3.1 U5: TIPS has every key with the exact texts', () => {
  const T = TrainerUI.TIPS;
  assert.strictEqual(T.star, 'Rate {n}/10 — saves to your Simkl ratings and steers Marquee');
  assert.strictEqual(T.clear, 'Clear your rating (also removes it from Simkl)');
  assert.strictEqual(T.love, 'Love it — rates 10/10. Loved films always count as a favourite in Marquee');
  assert.strictEqual(T.unlove, 'Remove love — clears the 10/10 rating');
  assert.strictEqual(T.ignore, "Ignore — keep it in your history but stop it shaping recommendations. It won't be recommended again");
  assert.strictEqual(T.unignore, 'Stop ignoring — let this film shape recommendations again');
  assert.strictEqual(T.undo, 'Undo the ignore');
  assert.strictEqual(T.unwatch, 'Mark unwatched — removes it from your Simkl watch history (for films marked watched by mistake). It can be recommended again');
  assert.strictEqual(T.finished, 'I finished it — marks it watched on Simkl and moves it into your history');
  assert.strictEqual(T.rebuild, "Rebuild this profile's recommendations now instead of waiting for the hourly check");
  assert.strictEqual(T.search, 'Search your watch history by title');
  assert.strictEqual(T.prev, 'Previous page');
  assert.strictEqual(T.next, 'Next page');
  assert.strictEqual(T.chip_all, "Everything you've watched (except ignored)");
  assert.strictEqual(T.chip_unrated, "Watched films you haven't rated yet");
  assert.strictEqual(T.chip_rated, "Films you've rated (including loved)");
  assert.strictEqual(T.chip_loved, 'Films you rated 10/10');
  assert.strictEqual(T.chip_ignored, 'Films you told the recommender to ignore');
  assert.strictEqual(T.chip_unfinished, 'Films you started but stopped before halfway — never recommended back');
});

ok('trainer T3.1 U7: ratingFromPointer maps pointer x to half-star ratings', () => {
  const rects = [
    { left: 0, width: 20 }, { left: 24, width: 20 }, { left: 48, width: 20 },
    { left: 72, width: 20 }, { left: 96, width: 20 },
  ];
  assert.strictEqual(TrainerUI.ratingFromPointer(5, rects), 1);
  assert.strictEqual(TrainerUI.ratingFromPointer(15, rects), 2);
  assert.strictEqual(TrainerUI.ratingFromPointer(22, rects), 2); // gap after star 0
  assert.strictEqual(TrainerUI.ratingFromPointer(30, rects), 3);
  assert.strictEqual(TrainerUI.ratingFromPointer(110, rects), 10);
  assert.strictEqual(TrainerUI.ratingFromPointer(200, rects), 10);
  assert.strictEqual(TrainerUI.ratingFromPointer(-3, rects), null);
  // Every half of every star maps correctly (loop over all 10).
  for (let i = 0; i < 5; i++) {
    const { left, width } = rects[i];
    const mid = left + width / 2;
    assert.strictEqual(TrainerUI.ratingFromPointer(left, rects), 2 * i + 1, 'left edge star ' + i);
    assert.strictEqual(TrainerUI.ratingFromPointer(left + width * 0.25, rects), 2 * i + 1, 'left half star ' + i);
    assert.strictEqual(TrainerUI.ratingFromPointer(mid, rects), 2 * i + 2, 'mid star ' + i);
    assert.strictEqual(TrainerUI.ratingFromPointer(left + width * 0.75, rects), 2 * i + 2, 'right half star ' + i);
  }
});

ok('trainer T3.1 U8: fillsForRating maps a rating to the 5 fill widths', () => {
  assert.deepStrictEqual(TrainerUI.fillsForRating(7), ['100%', '100%', '100%', '50%', '0%']);
  assert.deepStrictEqual(TrainerUI.fillsForRating(null), ['0%', '0%', '0%', '0%', '0%']);
  assert.deepStrictEqual(TrainerUI.fillsForRating(10), ['100%', '100%', '100%', '100%', '100%']);
});

// A fake .tr-stars group: records listeners by type and pointer-capture calls,
// and can dispatch a fake pointer event to the recorded listener.
function fakeStarGroup() {
  const listeners = {};
  const caps = { set: [], release: [] };
  return {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type, fn) => { if (listeners[type] === fn) delete listeners[type]; },
    setPointerCapture: (id) => { caps.set.push(id); },
    releasePointerCapture: (id) => { caps.release.push(id); },
    _listeners: listeners,
    _caps: caps,
    fire: (type, e) => { if (listeners[type]) listeners[type](e); },
  };
}

ok('trainer T3.1 U9: bindStarScrub — hover, touch scrub, scroll cancel, disabled, unbind', () => {
  const rects = [
    { left: 0, width: 20 }, { left: 24, width: 20 }, { left: 48, width: 20 },
    { left: 72, width: 20 }, { left: 96, width: 20 },
  ];
  const mk = (isEnabled) => {
    const el = fakeStarGroup();
    const preview = [];
    const commit = [];
    const cancel = [];
    const binding = TrainerUI.bindStarScrub(el, {
      getRects: () => rects,
      isEnabled: () => isEnabled,
      onPreview: (r) => preview.push(r),
      onCommit: (r) => commit.push(r),
      onCancel: () => cancel.push(1),
    });
    return { el, preview, commit, cancel, binding };
  };

  // Hover — mouse moves with buttons:0 → onPreview values, no onCommit; pointerleave → onCancel.
  {
    const { el, preview, commit, cancel } = mk(true);
    el.fire('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 5 });
    el.fire('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 30 });
    assert.deepStrictEqual(preview, [1, 3], 'hover previews');
    assert.deepStrictEqual(commit, [], 'no commit on hover');
    el.fire('pointerleave', { pointerType: 'mouse' });
    assert.strictEqual(cancel.length, 1, 'pointerleave cancels');
  }
  // Touch scrub — pointerdown(x=5) → preview 1; moves to 30 and 55 → previews 3 and 5 (each change once); pointerup → one onCommit(5).
  {
    const { el, preview, commit, cancel } = mk(true);
    el.fire('pointerdown', { pointerType: 'touch', button: 0, pointerId: 1, clientX: 5 });
    assert.deepStrictEqual(preview, [1], 'down previews');
    assert.strictEqual(el._caps.set.length, 1, 'capture on down');
    el.fire('pointermove', { pointerType: 'touch', buttons: 1, pointerId: 1, clientX: 30 });
    el.fire('pointermove', { pointerType: 'touch', buttons: 1, pointerId: 1, clientX: 55 });
    assert.deepStrictEqual(preview, [1, 3, 5], 'scrub previews (each change once)');
    el.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 55 });
    assert.deepStrictEqual(commit, [5], 'one commit on up');
    assert.strictEqual(el._caps.release.length, 1, 'release on up');
    assert.deepStrictEqual(cancel, [], 'no cancel on a clean scrub');
  }
  // Scroll — pointerdown then pointercancel → onCancel, no commit.
  {
    const { el, preview, commit, cancel } = mk(true);
    el.fire('pointerdown', { pointerType: 'touch', button: 0, pointerId: 1, clientX: 5 });
    el.fire('pointercancel', { pointerType: 'touch', pointerId: 1, clientX: 5 });
    assert.deepStrictEqual(commit, [], 'no commit on cancel');
    assert.strictEqual(cancel.length, 1, 'pointercancel cancels');
    assert.strictEqual(el._caps.release.length, 1, 'release on cancel');
  }
  // Disabled — isEnabled false → nothing is called.
  {
    const { el, preview, commit, cancel } = mk(false);
    el.fire('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 5 });
    el.fire('pointerdown', { pointerType: 'touch', button: 0, pointerId: 1, clientX: 5 });
    el.fire('pointermove', { pointerType: 'touch', buttons: 1, pointerId: 1, clientX: 30 });
    el.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 30 });
    assert.deepStrictEqual(preview, [], 'no preview when disabled');
    assert.deepStrictEqual(commit, [], 'no commit when disabled');
    assert.deepStrictEqual(cancel, [], 'no cancel when disabled');
    assert.strictEqual(el._caps.set.length, 0, 'no capture when disabled');
  }
  // unbind() removes every listener.
  {
    const { el, binding } = mk(true);
    binding();
    assert.deepStrictEqual(Object.keys(el._listeners), [], 'all listeners removed');
  }
});

// ---- Trainer T4: the new pure helpers in public/trainer-ui.js ----

ok('trainer T4 M1: ratingText — null, 1, 2, 7, 9, 10 exactly as specified', () => {
  assert.strictEqual(TrainerUI.ratingText(null), 'Not rated');
  assert.strictEqual(TrainerUI.ratingText(1), '½★ · 1/10');
  assert.strictEqual(TrainerUI.ratingText(2), '1★ · 2/10');
  assert.strictEqual(TrainerUI.ratingText(7), '3½★ · 7/10');
  assert.strictEqual(TrainerUI.ratingText(9), '4½★ · 9/10');
  assert.strictEqual(TrainerUI.ratingText(10), '5★ · 10/10 · Loved');
});

ok('trainer T4 M2: cardSwipeOutcome — none, ignore, skip, love, live feedback', () => {
  const w = 360, h = 640;
  // (0,0) → none, no label, progress 0.
  assert.deepStrictEqual(TrainerUI.cardSwipeOutcome(0, 0, w, h), { action: 'none', label: '', progress: 0 });
  // (-0.30w, 0) → ignore (past the 28% threshold).
  assert.deepStrictEqual(TrainerUI.cardSwipeOutcome(-0.30 * w, 0, w, h), { action: 'ignore', label: 'Ignore', progress: 1 });
  // (-0.1w, 0) → below threshold: action none, but label 'Ignore', progress ≈ 0.357.
  {
    const o = TrainerUI.cardSwipeOutcome(-0.1 * w, 0, w, h);
    assert.strictEqual(o.action, 'none');
    assert.strictEqual(o.label, 'Ignore');
    assert.ok(Math.abs(o.progress - 0.357) < 0.01, 'progress ≈ 0.357, got ' + o.progress);
  }
  // (0.3w, 0) → skip (past the 28% threshold).
  assert.deepStrictEqual(TrainerUI.cardSwipeOutcome(0.3 * w, 0, w, h), { action: 'skip', label: 'Skip', progress: 1 });
  // (10, -0.25h) → love (up dominates, past the 22% threshold).
  assert.deepStrictEqual(TrainerUI.cardSwipeOutcome(10, -0.25 * h, w, h), { action: 'love', label: 'Love ♥', progress: 1 });
  // (-0.3w, -0.1h) → ignore (horizontal dominates).
  assert.deepStrictEqual(TrainerUI.cardSwipeOutcome(-0.3 * w, -0.1 * h, w, h), { action: 'ignore', label: 'Ignore', progress: 1 });
  // (5, -0.1h) → up but below threshold: action none, progress < 1.
  {
    const o = TrainerUI.cardSwipeOutcome(5, -0.1 * h, w, h);
    assert.strictEqual(o.action, 'none');
    assert.strictEqual(o.label, 'Love ♥');
    assert.ok(o.progress < 1, 'progress < 1, got ' + o.progress);
  }
});

ok('trainer T4 M3: pickQuickBatch — excludes rated/ignored/unfinished/handled, preserves order', () => {
  const items = [
    { key: 'a', status: 'watched', ignored: false, rating: null },
    { key: 'b', status: 'watched', ignored: true, rating: null },        // ignored → excluded
    { key: 'c', status: 'watched', ignored: false, rating: 5 },          // rated → excluded
    { key: 'd', status: 'unfinished', ignored: false, rating: null },    // unfinished → excluded
    { key: 'e', status: 'watched', ignored: false, rating: null },
    { key: 'f', status: 'watched', ignored: false, rating: 0 },          // rating 0 is non-null → excluded
  ];
  const handled = new Set(['e']);
  const batch = TrainerUI.pickQuickBatch(items, handled);
  assert.deepStrictEqual(batch.map(i => i.key), ['a'], 'only watched, unignored, unrated, unhandled remain, in order');
});

ok('trainer T4 M4: QUICK_ACTIONS is exactly the list', () => {
  assert.deepStrictEqual(TrainerUI.QUICK_ACTIONS, ['love', 'ignore', 'skip', 'unwatch', 'undo']);
});

ok('trainer T4 K1a: jsonRequest — object body → JSON string; string/no body unchanged; input never mutated', () => {
  // Object body → a JSON string (the fix for the "[object Object]" 400).
  const obj = { method: 'POST', body: { type: 'movie', tmdb_id: '1', ignored: true } };
  const r1 = TrainerUI.jsonRequest(obj);
  assert.strictEqual(r1.body, JSON.stringify(obj.body));
  assert.strictEqual(r1.method, 'POST'); // other opts preserved
  // The result is a fresh copy, not the input.
  assert.notStrictEqual(r1, obj);
  // String body → unchanged (same reference).
  const str = { method: 'POST', body: '{"a":1}' };
  assert.strictEqual(TrainerUI.jsonRequest(str), str);
  // No body → unchanged (same reference).
  const nob = { method: 'POST' };
  assert.strictEqual(TrainerUI.jsonRequest(nob), nob);
  // The input is never mutated.
  assert.deepStrictEqual(obj, { method: 'POST', body: { type: 'movie', tmdb_id: '1', ignored: true } });
  r1.body = 'mutated';
  assert.deepStrictEqual(obj.body, { type: 'movie', tmdb_id: '1', ignored: true });
});

ok('trainer T4 K3a: shouldAdvance — only advance if the current card is still the key', () => {
  assert.strictEqual(TrainerUI.shouldAdvance('a', 'a'), true);
  assert.strictEqual(TrainerUI.shouldAdvance('b', 'a'), false);
});

// ---- Calibrated serving (spec §16): pure helpers + ordering (K1–K9) ----
ok('calibrated K1: rowGenres strips Anime, trims, de-dups', () => {
  assert.deepStrictEqual(serveCalibration.rowGenres({ genres: 'Action, Drama ,Action, Anime' }), ['Action', 'Drama']);
  assert.deepStrictEqual(serveCalibration.rowGenres({ genres: '  Comedy ,  Comedy' }), ['Comedy']);
  assert.deepStrictEqual(serveCalibration.rowGenres({ primary_genre: 'Horror' }), ['Horror']);
  assert.deepStrictEqual(serveCalibration.rowGenres({ genres: 'Anime' }), []);
  assert.deepStrictEqual(serveCalibration.rowGenres({}), []);
});

ok('calibrated K2: genreMix fractional 1/k, sums to 1', () => {
  const rows = [
    { genres: 'Action,Drama' },   // 1/2 each
    { genres: 'Action' },          // 1 Action
    { genres: 'Comedy,Horror' },   // 1/2 each
  ];
  const mix = serveCalibration.genreMix(rows);
  assert.ok(Math.abs(mix.get('Action') - 0.5) < 1e-9);
  assert.ok(Math.abs(mix.get('Drama') - 1 / 6) < 1e-9);
  assert.ok(Math.abs(mix.get('Comedy') - 1 / 6) < 1e-9);
  assert.ok(Math.abs(mix.get('Horror') - 1 / 6) < 1e-9);
  const total = [...mix.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.deepStrictEqual([...serveCalibration.genreMix([]).entries()], []);
});

ok('calibrated K3: computeTarget ignores weight ≤0, splits multi-genre, sorts, {} empty', () => {
  const films = [
    { genres: ['Action', 'Drama'], weight: 2 },  // 1 each
    { genres: ['Action'], weight: 2 },            // 2 Action
    { genres: ['Comedy'], weight: -1 },           // ignored
    { genres: ['Comedy'], weight: 0 },           // ignored
  ];
  const t = serveCalibration.computeTarget(films);
  assert.ok(Math.abs(t.Action - 0.75) < 1e-9);
  assert.ok(Math.abs(t.Drama - 0.25) < 1e-9);
  assert.strictEqual(t.Comedy, undefined);
  assert.deepStrictEqual(Object.keys(t), ['Action', 'Drama']); // sorted by share desc
  assert.deepStrictEqual(serveCalibration.computeTarget([]), {});
  assert.deepStrictEqual(serveCalibration.computeTarget([{ genres: ['X'], weight: 0 }]), {});
});

ok('calibrated K4: applyExclusions renormalises; all excluded → {}', () => {
  const t = { Action: 0.5, Drama: 0.3, Comedy: 0.2 };
  const r = serveCalibration.applyExclusions(t, ['Comedy']);
  assert.ok(Math.abs(r.Action - 0.625) < 1e-9);
  assert.ok(Math.abs(r.Drama - 0.375) < 1e-9);
  assert.strictEqual(r.Comedy, undefined);
  assert.deepStrictEqual(serveCalibration.applyExclusions(t, ['Action', 'Drama', 'Comedy']), {});
});

ok('calibrated K5: klDivergence 0 when q=p, >0 otherwise (hand-computed)', () => {
  const p = { A: 0.5, B: 0.3, C: 0.2 };
  assert.ok(Math.abs(serveCalibration.klDivergence(p, new Map(Object.entries(p)))) < 1e-9);
  const q = new Map([['A', 0.2], ['B', 0.2], ['C', 0.6]]);
  const a = 0.01;
  let expect = 0;
  for (const [g, pv] of Object.entries(p)) expect += pv * Math.log(pv / ((1 - a) * q.get(g) + a * pv));
  assert.ok(Math.abs(serveCalibration.klDivergence(p, q) - expect) < 1e-9);
  assert.ok(serveCalibration.klDivergence(p, q) > 0);
});

ok('calibrated K6: calibration beats round-robin (mix near target, window-only)', () => {
  const rows = [];
  const mk = (genre, score, id) => ({ tmdb_id: id, genres: genre, affinity: score });
  const A = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41];
  const B = [90.9, 90.8, 90.7, 90.6, 90.5, 90.4, 90.3, 90.2, 90.1, 90.0, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31];
  const C = [89.9, 89.8, 89.7, 89.6, 89.5, 89.4, 89.3, 89.2, 89.1, 89.0, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21];
  A.forEach((s, i) => rows.push(mk('Action', s, 'a' + i)));
  B.forEach((s, i) => rows.push(mk('Drama', s, 'b' + i)));
  C.forEach((s, i) => rows.push(mk('Comedy', s, 'c' + i)));
  const sorted = rows.slice().sort((x, y) => y.affinity - x.affinity);
  const target = { Action: 0.5, Drama: 0.3, Comedy: 0.2 };
  const order = serveCalibration.calibratedOrder(sorted, target, { listSize: 10 });
  const top10 = order.slice(0, 10);
  // Calibration beats a score-only serve: its genre mix is much closer to the
  // target (lower KL) than the top-10-by-score mix (which is all Action here).
  const calKL = serveCalibration.klDivergence(target, serveCalibration.genreMix(top10));
  const scoreKL = serveCalibration.klDivergence(target, serveCalibration.genreMix(sorted.slice(0, 10)));
  assert.ok(calKL < scoreKL, `calibrated KL ${calKL.toFixed(4)} must beat score-only KL ${scoreKL.toFixed(4)}`);
  assert.ok(calKL < 0.5, `calibrated KL ${calKL.toFixed(4)} is close to the target`);
  // Every chosen row is inside the quality window (top W = 30).
  const windowIds = new Set(sorted.slice(0, 30).map((r) => r.tmdb_id));
  for (const r of top10) assert.ok(windowIds.has(r.tmdb_id), 'chosen row outside window: ' + r.tmdb_id);
  // A score-only serve of the same pool is all Action (the problem calibration fixes).
  assert.ok(sorted.slice(0, 10).every((r) => r.genres === 'Action'), 'score-only top-10 is all Action');
});

ok('calibrated K7: quality window — a liked genre with no strong candidate is under-filled', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ tmdb_id: 'a' + i, genres: 'Action', affinity: 200 - i });
  for (let i = 0; i < 19; i++) rows.push({ tmdb_id: 'b' + i, genres: 'Drama', affinity: 190 - i });
  rows.push({ tmdb_id: 'c0', genres: 'Comedy', affinity: 1 }); // lowest, outside W
  const sorted = rows.slice().sort((x, y) => y.affinity - x.affinity);
  const target = { Action: 0.4, Drama: 0.4, Comedy: 0.2 }; // target includes Comedy
  const order = serveCalibration.calibratedOrder(sorted, target, { listSize: 10 });
  const calibratedPart = order.slice(0, 30); // the window part (W = min(40, 30) = 30)
  assert.ok(!calibratedPart.some((r) => r.genres === 'Comedy'), 'Comedy row leaked into the calibrated part');
  assert.ok(order.some((r) => r.genres === 'Comedy'), 'Comedy row still present in the full ordering');
});

ok('calibrated K8: one full ordering + determinism', () => {
  const rows = [];
  for (let i = 0; i < 15; i++) rows.push({ tmdb_id: 'id' + i, genres: i % 2 ? 'Drama' : 'Action', affinity: 100 - i });
  const target = { Action: 0.6, Drama: 0.4 };
  const o1 = serveCalibration.calibratedOrder(rows.slice(), target, { listSize: 10 });
  const o2 = serveCalibration.calibratedOrder(rows.slice(), target, { listSize: 10 });
  const ids = o1.map((r) => r.tmdb_id);
  assert.strictEqual(ids.length, rows.length);
  assert.strictEqual(new Set(ids).size, rows.length); // no dups
  assert.deepStrictEqual(ids.sort(), rows.map((r) => r.tmdb_id).sort()); // full ordering
  assert.deepStrictEqual(o1.map((r) => r.tmdb_id), o2.map((r) => r.tmdb_id)); // deterministic
});

ok('calibrated K9: wildcard slot', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ tmdb_id: 'a' + i, genres: 'Action', affinity: 300 - i });
  rows.push({ tmdb_id: 'd0', genres: 'Drama', affinity: 5 }); // lowest, within 2W, outside window
  const sorted = rows.slice().sort((x, y) => y.affinity - x.affinity);
  const listSize = 10;
  // Qualifying target: Drama share 0.04 < 0.05 → the Drama row qualifies.
  const orderQual = serveCalibration.calibratedOrder(sorted, { Action: 0.96, Drama: 0.04 }, { listSize, wildcardSlots: 1 });
  assert.strictEqual(orderQual[5].tmdb_id, 'd0', 'qualifying wildcard placed at index 5');
  // wildcardSlots:0 → no wildcard; the Drama row stays in its rest position.
  const orderOff = serveCalibration.calibratedOrder(sorted, { Action: 0.96, Drama: 0.04 }, { listSize, wildcardSlots: 0 });
  assert.notStrictEqual(orderOff[5].tmdb_id, 'd0');
  // No qualifier → order unchanged (Drama share 0.1 ≥ 0.05 → doesn't qualify).
  const orderNoQual = serveCalibration.calibratedOrder(sorted, { Action: 0.9, Drama: 0.1 }, { listSize, wildcardSlots: 1 });
  assert.notStrictEqual(orderNoQual[5].tmdb_id, 'd0');
});

// ---- Part A: incremental greedy equivalence + speed (A1–A3) ----
// A frozen copy of the ORIGINAL calibratedOrder (the per-candidate
// genreMix([...S, r]) greedy). It reuses the module's unchanged pure helpers
// (rowGenres / genreMix / klDivergence), so only the greedy loop differs from
// the new incremental implementation. A1 asserts the two produce identical
// orderings.
function referenceOrder(rows, target, opts = {}) {
  const lambda = opts.lambda ?? 0.5;
  const windowFactor = opts.windowFactor ?? 3;
  const klAlpha = opts.klAlpha ?? 0.01;
  const wildcardSlots = opts.wildcardSlots ?? 0;
  const wildcardMaxShare = opts.wildcardMaxShare ?? 0.05;
  const wildcardPosition = opts.wildcardPosition ?? 6;
  const listSize = opts.listSize ?? 20;
  const all = rows || [];
  const W = Math.min(all.length, windowFactor * listSize);
  const window = all.slice(0, W);
  const rest = all.slice(W);
  const raw = window.map((r) => r.affinity || 0);
  const minW = raw.length ? Math.min(...raw) : 0;
  const maxW = raw.length ? Math.max(...raw) : 0;
  const span = (maxW - minW) || 1;
  const normByRow = new Map(window.map((r, i) => [r, (raw[i] - minW) / span]));
  const S = [];
  let pool = window.slice();
  let sumNorm = 0;
  while (pool.length) {
    let best = null;
    let bestU = -Infinity;
    for (const r of pool) {
      const U = (1 - lambda) * (sumNorm + normByRow.get(r))
        - lambda * serveCalibration.klDivergence(target, serveCalibration.genreMix([...S, r]), klAlpha);
      if (U > bestU) { bestU = U; best = r; continue; }
      if (U === bestU && best !== null) {
        const sa = r.affinity || 0;
        const sb = best.affinity || 0;
        if (sa > sb || (sa === sb && String(r.tmdb_id) < String(best.tmdb_id))) best = r;
      }
    }
    S.push(best);
    sumNorm += normByRow.get(best);
    pool = pool.filter((r) => r !== best);
  }
  let order = [...S, ...rest];
  if (wildcardSlots > 0 && listSize > wildcardPosition) {
    const top2W = all.slice(0, 2 * W);
    const targetMap = target instanceof Map ? target : new Map(Object.entries(target || {}));
    for (let slot = 0; slot < wildcardSlots; slot++) {
      const firstSet = new Set(order.slice(0, listSize));
      let pick = null;
      for (const r of top2W) {
        if (firstSet.has(r)) continue;
        const gs = serveCalibration.rowGenres(r);
        if (!gs.length) continue;
        if (!gs.every((g) => (targetMap.get(g) || 0) < wildcardMaxShare)) continue;
        if (pick === null || (r.affinity || 0) > (pick.affinity || 0)
          || ((r.affinity || 0) === (pick.affinity || 0) && String(r.tmdb_id) < String(pick.tmdb_id))) pick = r;
      }
      if (!pick) break;
      order.splice(order.indexOf(pick), 1);
      order.splice(wildcardPosition - 1 + 7 * slot, 0, pick);
    }
  }
  return order;
}

// Deterministic PRNG (mulberry32) so the fixtures are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A_GENRES = ['Action', 'Comedy', 'Drama', 'SciFi', 'Horror', 'Romance', 'Crime', 'Fantasy', 'Thriller', 'Documentary', 'Animation', 'History'];

ok('calibrated A1: incremental greedy is identical to the original (200 seeded fixtures)', () => {
  const rnd = mulberry32(20261002);
  for (let t = 0; t < 200; t++) {
    const nRows = 20 + Math.floor(rnd() * 181); // 20–200
    const rows = [];
    for (let i = 0; i < nRows; i++) {
      const gCount = Math.floor(rnd() * 4); // 0–3 genres (0 = no genre signal)
      const gs = [];
      for (let g = 0; g < gCount; g++) {
        const gname = A_GENRES[Math.floor(rnd() * 12)];
        if (!gs.includes(gname)) gs.push(gname);
      }
      const affinity = rnd() < 0.3 ? Math.floor(rnd() * 50) : Math.floor(rnd() * 10000) / 100; // ties common
      rows.push({ tmdb_id: 'r' + t + '_' + i, genres: gs.join(','), affinity });
    }
    const sorted = rows.slice().sort((a, b) => b.affinity - a.affinity);
    const nTg = 1 + Math.floor(rnd() * 4); // 1–4 target genres
    const tgs = [];
    for (let g = 0; g < nTg; g++) {
      const gname = A_GENRES[Math.floor(rnd() * 12)];
      if (!tgs.includes(gname)) tgs.push(gname);
    }
    const target = {};
    let tw = 0;
    for (const g of tgs) { const w = 1 + Math.floor(rnd() * 10); target[g] = w; tw += w; }
    for (const g of tgs) target[g] /= tw;
    const listSize = [5, 20, 50][Math.floor(rnd() * 3)];
    const wildcardSlots = rnd() < 0.5 ? 0 : 1;
    const opts = { listSize, wildcardSlots };
    const o1 = serveCalibration.calibratedOrder(sorted.slice(), target, opts);
    const o2 = referenceOrder(sorted.slice(), target, opts);
    assert.deepStrictEqual(o1.map((r) => r.tmdb_id), o2.map((r) => r.tmdb_id), 'fixture ' + t);
  }
});

ok('calibrated A2: incremental greedy is fast (425 rows, listSize 50)', () => {
  const rnd = mulberry32(999);
  const rows = [];
  for (let i = 0; i < 425; i++) {
    const gCount = 1 + Math.floor(rnd() * 3); // 1–3 genres
    const gs = [];
    for (let g = 0; g < gCount; g++) {
      const gname = A_GENRES[Math.floor(rnd() * 12)];
      if (!gs.includes(gname)) gs.push(gname);
    }
    rows.push({ tmdb_id: 's' + i, genres: gs.join(','), affinity: Math.floor(rnd() * 10000) / 100 });
  }
  const sorted = rows.slice().sort((a, b) => b.affinity - a.affinity);
  const target = { Action: 0.3, Comedy: 0.3, Drama: 0.2, SciFi: 0.2 };
  const times = [];
  for (let run = 0; run < 5; run++) {
    const t0 = process.hrtime.bigint();
    serveCalibration.calibratedOrder(sorted, target, { listSize: 50 });
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6); // ms
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log('  A2 measured: ' + times.map((x) => x.toFixed(1)).join(', ') + ' ms; avg ' + avg.toFixed(2) + ' ms');
  assert.ok(avg < 40, 'avg ' + avg.toFixed(2) + ' ms must be < 40 ms');
});

// ---- AGE-1: rating tables (pure) ----
{
  const ratings = require('../src/ageVerification/ratings');
  const tiers = require('../src/ageVerification/tiers');
  const tier = tiers.TIERS[14];
  const chain = require('../src/ageVerification/chain');

  ok('AGE-1 R1: normalizeRating / classify', () => {
    // 'MA 15+' normalises to 'MA15+' → block (series and film)
    assert.strictEqual(ratings.normalizeRating('MA 15+'), 'MA15+');
    assert.strictEqual(ratings.classify('MA 15+', 'series', tier), 'block');
    assert.strictEqual(ratings.classify('MA 15+', 'movie', tier), 'block');
    // TV-Y7-FV → allow (series)
    assert.strictEqual(ratings.classify('TV-Y7-FV', 'series', tier), 'allow');
    // M → allow for both
    assert.strictEqual(ratings.classify('M', 'series', tier), 'allow');
    assert.strictEqual(ratings.classify('M', 'movie', tier), 'allow');
    // a PG-13 show → allow (cross-type: PG-13 is a film rating)
    assert.strictEqual(ratings.classify('PG-13', 'series', tier), 'allow');
    // a TV-MA film → block (cross-type: TV-MA is a show rating)
    assert.strictEqual(ratings.classify('TV-MA', 'movie', tier), 'block');
    // E, NR, Not Rated, '' → null (no rating)
    assert.strictEqual(ratings.classify('E', 'series', tier), null);
    assert.strictEqual(ratings.classify('NR', 'movie', tier), null);
    assert.strictEqual(ratings.classify('Not Rated', 'series', tier), null);
    assert.strictEqual(ratings.classify('', 'movie', tier), null);
  });

  ok('AGE-1 R2: classifyForeign', () => {
    assert.strictEqual(ratings.classifyForeign('GB', '12A', tier), 'allow');
    assert.strictEqual(ratings.classifyForeign('GB', '15', tier), 'block');
    assert.strictEqual(ratings.classifyForeign('IE', '15A', tier), 'block');
    assert.strictEqual(ratings.classifyForeign('NZ', 'M', tier), 'block');
    assert.strictEqual(ratings.classifyForeign('NZ', 'R13', tier), 'allow');
    assert.strictEqual(ratings.classifyForeign('CA', '14A', tier), 'allow');
    assert.strictEqual(ratings.classifyForeign('CA', '18A', tier), 'block');
    // 3-letter TVDB codes work
    assert.strictEqual(ratings.classifyForeign('GBR', '12A', tier), 'allow');
    // DE 12 → null (not a listed country)
    assert.strictEqual(ratings.classifyForeign('DE', '12', tier), null);
  });

  ok('AGE-1 R3: classifyLoose', () => {
    assert.strictEqual(ratings.classifyLoose('15', tier), 'block');
    assert.strictEqual(ratings.classifyLoose('12', tier), 'allow');
    assert.strictEqual(ratings.classifyLoose('M18', tier), 'block');
    assert.strictEqual(ratings.classifyLoose('NC16', tier), 'block');
    assert.strictEqual(ratings.classifyLoose('TV-14', tier), 'allow');
    assert.strictEqual(ratings.classifyLoose('XYZ', tier), null);
  });

  // ---- AGE-1: decision chain (pure, seams) ----
  okAsync('AGE-1 C1: chain order — first step that answers wins', async () => {
    const log = { warn: () => {} };
    const empty = () => new Map();
    function run(title, stubs) {
      const sources = {
        tmdbRatings: stubs.tmdbRatings || empty,
        csmAges: stubs.csmAges || empty,
        tvdbRatings: stubs.tvdbRatings || empty,
        simklCerts: stubs.simklCerts || empty,
        mdblistCerts: stubs.mdblistCerts || empty,
        llmGate: stubs.llmGate || empty,
      };
      return chain.decide([title], 'series', tier, sources, log);
    }
    // adult flag → hard floor (rating 'adult')
    let r = await run({ key: 'k1', imdb_id: 'tt1', adult: true }, {});
    assert.deepStrictEqual(r.get('k1'), { verdict: 'block', source: 'hard-floor', rating: 'adult' });
    // AU R18+ beats CSM 14 (hard floor is step 0)
    r = await run({ key: 'k2', imdb_id: 'tt2' }, {
      tmdbRatings: () => new Map([['k2', { AU: 'R18+' }]]),
      csmAges: () => new Map([['tt2', 14]]),
    });
    assert.deepStrictEqual(r.get('k2'), { verdict: 'block', source: 'hard-floor', rating: 'R18+' });
    // CSM 14 beats AU MA15+ (CSM is step 1, before AU)
    r = await run({ key: 'k3', imdb_id: 'tt3' }, {
      tmdbRatings: () => new Map([['k3', { AU: 'MA15+' }]]),
      csmAges: () => new Map([['tt3', 14]]),
    });
    assert.deepStrictEqual(r.get('k3'), { verdict: 'allow', source: 'csm', rating: '14' });
    // CSM 15 beats AU PG (CSM block wins over AU allow)
    r = await run({ key: 'k4', imdb_id: 'tt4' }, {
      tmdbRatings: () => new Map([['k4', { AU: 'PG' }]]),
      csmAges: () => new Map([['tt4', 15]]),
    });
    assert.deepStrictEqual(r.get('k4'), { verdict: 'block', source: 'csm', rating: '15' });
    // no CSM, AU M → allow/au
    r = await run({ key: 'k5', imdb_id: 'tt5' }, { tmdbRatings: () => new Map([['k5', { AU: 'M' }]]) });
    assert.deepStrictEqual(r.get('k5'), { verdict: 'allow', source: 'au', rating: 'M' });
    // no CSM, AU MA15+ → block/au
    r = await run({ key: 'k6', imdb_id: 'tt6' }, { tmdbRatings: () => new Map([['k6', { AU: 'MA15+' }]]) });
    assert.deepStrictEqual(r.get('k6'), { verdict: 'block', source: 'au', rating: 'MA15+' });
    // no CSM/AU, US TV-14 → allow/us
    r = await run({ key: 'k7', imdb_id: 'tt7' }, { tmdbRatings: () => new Map([['k7', { US: 'TV-14' }]]) });
    assert.deepStrictEqual(r.get('k7'), { verdict: 'allow', source: 'us', rating: 'TV-14' });
    // no TMDB AU/US, TVDB aus PG → allow/tvdb-au
    r = await run({ key: 'k8', imdb_id: 'tt8' }, { tvdbRatings: () => new Map([['tt8', { aus: 'PG' }]]) });
    assert.deepStrictEqual(r.get('k8'), { verdict: 'allow', source: 'tvdb-au', rating: 'PG' });
    // everything before empty, Simkl TV-PG → allow/simkl
    r = await run({ key: 'k9', imdb_id: 'tt9' }, { simklCerts: () => new Map([['tt9', 'TV-PG']]) });
    assert.deepStrictEqual(r.get('k9'), { verdict: 'allow', source: 'simkl', rating: 'TV-PG' });
    // everything before empty, MDBList '15' → block/mdblist
    r = await run({ key: 'k10', imdb_id: 'tt10' }, { mdblistCerts: () => new Map([['tt10', '15']]) });
    assert.deepStrictEqual(r.get('k10'), { verdict: 'block', source: 'mdblist', rating: '15' });
    // everything before empty, TMDB GB 12 → allow/tmdb-gb
    r = await run({ key: 'k11', imdb_id: 'tt11' }, { tmdbRatings: () => new Map([['k11', { GB: '12' }]]) });
    assert.deepStrictEqual(r.get('k11'), { verdict: 'allow', source: 'tmdb-gb', rating: '12' });
    // everything empty → LLM: true→allow, false→block, omitted→unknown
    r = await run({ key: 'k12', imdb_id: 'tt12' }, { llmGate: () => new Map([['k12', true]]) });
    assert.deepStrictEqual(r.get('k12'), { verdict: 'allow', source: 'llm', rating: 'ok' });
    r = await run({ key: 'k13', imdb_id: 'tt13' }, { llmGate: () => new Map([['k13', false]]) });
    assert.deepStrictEqual(r.get('k13'), { verdict: 'block', source: 'llm', rating: 'no' });
    r = await run({ key: 'k14', imdb_id: 'tt14' }, { llmGate: () => new Map() });
    assert.deepStrictEqual(r.get('k14'), { verdict: 'unknown', source: 'llm', rating: null });
  });

  okAsync('AGE-1 C2: source economy (once per step, only undecided; TVDB once per title; LLM last)', async () => {
    const log = { warn: () => {} };
    const titles = [
      { key: 'k1', imdb_id: 'tt1' }, // decided at CSM (14)
      { key: 'k2', imdb_id: 'tt2' }, // decided at AU (M)
      { key: 'k3', imdb_id: 'tt3' }, // undecided through to LLM
    ];
    const calls = { tmdb: [], csm: [], tvdb: [], simkl: [], mdb: [], llm: [] };
    const sources = {
      tmdbRatings: (type, ts) => { calls.tmdb.push(ts.map((t) => t.key)); return new Map([['k2', { AU: 'M' }]]); },
      csmAges: (type, ids) => { calls.csm.push(ids.slice()); return new Map([['tt1', 14]]); },
      tvdbRatings: (type, ids) => { calls.tvdb.push(ids.slice()); return new Map(); },
      simklCerts: (type, ids) => { calls.simkl.push(ids.slice()); return new Map(); },
      mdblistCerts: (type, ids) => { calls.mdb.push(ids.slice()); return new Map(); },
      llmGate: (type, tier_, ts) => { calls.llm.push(ts.map((t) => t.key)); return new Map([['k3', true]]); },
    };
    const r = await chain.decide(titles, 'series', tier, sources, log);
    assert.deepStrictEqual(r.get('k1'), { verdict: 'allow', source: 'csm', rating: '14' });
    assert.deepStrictEqual(r.get('k2'), { verdict: 'allow', source: 'au', rating: 'M' });
    assert.deepStrictEqual(r.get('k3'), { verdict: 'allow', source: 'llm', rating: 'ok' });
    // TMDB fetched once for the whole set (step 0).
    assert.strictEqual(calls.tmdb.length, 1);
    assert.deepStrictEqual(calls.tmdb[0], ['k1', 'k2', 'k3']);
    // CSM called once with the undecided after step 0 (all three).
    assert.strictEqual(calls.csm.length, 1);
    assert.deepStrictEqual(calls.csm[0], ['tt1', 'tt2', 'tt3']);
    // TVDB fetched once for tt3 (k2 has TMDB AU so it is never fetched); steps
    // 2, 3 and 4c share the cache → exactly one call.
    assert.strictEqual(calls.tvdb.length, 1);
    assert.deepStrictEqual(calls.tvdb[0], ['tt3']);
    // Simkl and MDBList called once each, only with the still-undecided tt3.
    assert.strictEqual(calls.simkl.length, 1);
    assert.deepStrictEqual(calls.simkl[0], ['tt3']);
    assert.strictEqual(calls.mdb.length, 1);
    assert.deepStrictEqual(calls.mdb[0], ['tt3']);
    // LLM called once, only with the title that reached it (k3).
    assert.strictEqual(calls.llm.length, 1);
    assert.deepStrictEqual(calls.llm[0], ['k3']);
  });

  okAsync('AGE-1 C3: source failures (continue + logged; LLM fails closed)', async () => {
    const warnings = [];
    const log = { warn: (m) => warnings.push(m) };
    const titles = [{ key: 'k1', imdb_id: 'tt1' }];
    // A failing CSM and TVDB give no answer from those steps; the chain continues to LLM.
    const sources = {
      tmdbRatings: () => new Map(),
      csmAges: () => { throw new Error('MDBList CSM down'); },
      tvdbRatings: () => { throw new Error('TVDB down'); },
      simklCerts: () => new Map(),
      mdblistCerts: () => new Map(),
      llmGate: () => new Map([['k1', true]]),
    };
    const r = await chain.decide(titles, 'series', tier, sources, log);
    assert.deepStrictEqual(r.get('k1'), { verdict: 'allow', source: 'llm', rating: 'ok' });
    assert.ok(warnings.some((w) => w.includes('csm')), 'CSM failure logged');
    assert.ok(warnings.some((w) => w.includes('tvdb')), 'TVDB failure logged');
    // The LLM step fails closed: its error propagates (decide rejects).
    const sources2 = {
      tmdbRatings: () => new Map(),
      csmAges: () => new Map(),
      tvdbRatings: () => new Map(),
      simklCerts: () => new Map(),
      mdblistCerts: () => new Map(),
      llmGate: () => { throw new Error('Groq down'); },
    };
    let rejected = false;
    try {
      await chain.decide(titles, 'series', tier, sources2, log);
    } catch (e) {
      rejected = true;
      assert.ok(e.message.includes('Groq down'));
    }
    assert.ok(rejected, 'decide must reject when the LLM step throws');
  });

  // ---- AGE-1: TVDB client (seams) ----
  const tvdb = require('../src/services/tvdb');
  const settings = require('../src/settings');

  okAsync('AGE-1 V1: mediaCerts maps country codes to ratings', async () => {
    const origFetch = global.fetch;
    global.fetch = (url) => {
      const u = String(url);
      if (u.includes('/search')) {
        const id = new URL(u).searchParams.get('externalId');
        if (id === 'tt123') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 12345, type: 3 }] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      }
      if (u.includes('/series/12345')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { ratings: [
          { country: { iso_3166_1: 'US' }, rating: 'TV-14' },
          { country: { iso_3166_1: 'AU' }, rating: 'M' },
          { country: { iso_3166_1: 'GB' }, rating: '12' },
        ] } }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };
    settings.updateSettings({ keys: { tvdb_api_key: 'test-key' } });
    try {
      const out = await tvdb.mediaCerts(['tt123', 'tt456'], 'series');
      assert.deepStrictEqual(out.get('tt123'), { usa: 'TV-14', aus: 'M', gbr: '12' });
      assert.deepStrictEqual(out.get('tt456'), {}); // no match
    } finally {
      global.fetch = origFetch;
      settings.updateSettings({ keys: { tvdb_api_key: '' } });
    }
  });

  okAsync('AGE-1 V2: mediaCerts — no key → empty; network error → empty object, logged', async () => {
    const origFetch = global.fetch;
    // No key → empty Map, logged.
    settings.updateSettings({ keys: { tvdb_api_key: '' } });
    delete process.env.TVDB_API_KEY;
    let out = await tvdb.mediaCerts(['tt123'], 'series');
    assert.ok(out instanceof Map && out.size === 0);
    // Network error → empty object for the title, logged, no throw.
    global.fetch = () => Promise.reject(new Error('network down'));
    settings.updateSettings({ keys: { tvdb_api_key: 'test-key' } });
    try {
      out = await tvdb.mediaCerts(['tt123'], 'series');
      assert.deepStrictEqual(out.get('tt123'), {});
    } finally {
      global.fetch = origFetch;
      settings.updateSettings({ keys: { tvdb_api_key: '' } });
    }
  });

  okAsync('AGE-1 V3: tvdbKey — Server Config first, then process env', async () => {
    // Server Config key takes precedence.
    settings.updateSettings({ keys: { tvdb_api_key: 'config-key' } });
    process.env.TVDB_API_KEY = 'env-key';
    assert.strictEqual(tvdb.tvdbKey(), 'config-key');
    // Env fallback when no Server Config key.
    settings.updateSettings({ keys: { tvdb_api_key: '' } });
    assert.strictEqual(tvdb.tvdbKey(), 'env-key');
    // Neither → empty.
    delete process.env.TVDB_API_KEY;
    assert.strictEqual(tvdb.tvdbKey(), '');
  });
}

// ---- HTTP surface ----
console.log('http:');
require('../src/server');
const BASE = `http://localhost:${process.env.PORT}`;

async function httpTests() {
  // Await any async unit tests (AGE-1 decision chain) before the HTTP surface.
  await Promise.all(asyncPending);
  // The migrateFromProfiles unit test above seeds the GLOBAL settings with
  // JAMES-* lookup keys. Now that the addon reads GLOBAL keys, clear them so the
  // addon-serve tests start from a known "no keys" baseline (tests that need a
  // key set it explicitly).
  require('../src/settings').updateSettings({ keys: { tmdb_api_key: '', mdblist_api_key: '', rpdb_api_key: '' } });

  // refreshStaleRatings (v6.38): the fix for titles that slip past the rating
  // floor. Orphan pool rows the candidate build never re-enriches (stored while
  // unrated on MDBList) keep a NULL rating and leak via the TMDB fallback; this
  // heals them — chasing NULL ratings, refreshing known ones, and leaving rows
  // just checked alone. Uses an injected fetcher, so no MDBList network.
  {
    const rs = require('../src/recommendationStore');
    const q = { log() {}, warn() {} };
    const pid = 'rating-refresh';
    const day = 24 * 3600e3;
    const now = 1_000_000 * day; // fixed clock
    const mk = (id, over) => ({ type: 'movie', tmdb_id: id, imdb_id: 'tt' + id, title: id, year: 2025, primary_genre: 'Drama', genres: 'Drama', vote_average: 7, vote_count: 5000, affinity: 1, rec_count: 1, popularity: 1, poster: null, ...over });
    // Three rows land unenriched (imdb_rating_at NULL) as a no-key build would;
    // a fourth was just checked and must be left untouched.
    rs.upsertCandidates(pid, [mk('afterburn'), mk('stowaway'), mk('series1', { type: 'series' })], { ratingCheckedAt: null });
    rs.upsertCandidates(pid, [mk('fresh', { imdb_rating: 8.1 })], { ratingCheckedAt: now });
    const answers = {
      movie: new Map([['ttafterburn', 4.6], ['ttstowaway', 5.7], ['ttfresh', 8.1]]),
      series: new Map([['ttseries1', 8.4]]),
    };
    const seen = { movie: null, series: null };
    const r1 = await rs.refreshStaleRatings(pid, 'fake-key', q, {
      now, fetchRatings: async (type, ids) => { seen[type] = ids.slice(); return answers[type]; },
    });
    assert.strictEqual(r1.updated, 3);                     // afterburn + stowaway + series1
    assert.ok(!seen.movie.includes('ttfresh'));            // freshly-checked row not re-queried
    const byId = Object.fromEntries(rs.getRecommended(pid, { limit: 100 }).map((x) => [x.imdb_id, x]));
    assert.strictEqual(byId.ttafterburn.imdb_rating, 4.6); // now carries the real below-floor number
    assert.strictEqual(byId.ttseries1.imdb_rating, 8.4);
    // With the real ratings in place, a ≥6 floor now drops the two low movies.
    const served = rs.selectServe(rs.getRecommended(pid, { limit: 100 }), { min_rating: 6 }, { nowYear: 2026 }).map((x) => x.imdb_id).sort();
    assert.deepStrictEqual(served, ['ttfresh', 'ttseries1']);
    // Re-running immediately checks nothing (all stamped within the window)…
    const r2 = await rs.refreshStaleRatings(pid, 'fake-key', q, { now: now + 1, fetchRatings: async () => { throw new Error('should not fetch'); } });
    assert.strictEqual(r2.checked, 0);
    // …and with no key it's a no-op even when rows are due.
    assert.deepStrictEqual(await rs.refreshStaleRatings(pid, '', q), { checked: 0, updated: 0 });
    console.log('  ✓ refreshStaleRatings heals NULL/stale ratings, skips fresh rows, no-ops without a key');
  }

  // Engine abstraction (SC-01): a FAKE engine returning hand-built
  // NormalizedCandidates flows through the shared pipeline and lands as pool rows
  // with the right column mapping (rankScore→affinity, reason→because_title,
  // recCount→rec_count). First proof the abstraction works; doubles as the SC-06
  // conformance fixture. preResolved:true keeps it no-network (pipeline skips the
  // TMDB tt-id resolve); the no-keys baseline above keeps it off the enrich path.
  {
    const pipeline = require('../src/engines/pipeline');
    const rs = require('../src/recommendationStore');
    const q = { log() {}, warn() {} };
    const pid = 'engine-fake';
    rs.deleteForProfile(pid);
    const cand = (id, rank, reason, recCount) => ({
      type: 'movie', tmdb_id: id, rankScore: rank, reason, recCount,
      imdb_id: 'tt' + id, title: 'Fake ' + id, year: 2024,
      primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000,
      popularity: 10, poster: 'https://example/' + id + '.jpg',
    });
    const fakeEngine = {
      id: 'fake', name: 'Fake', description: 't', supportedTypes: ['movie', 'series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => [cand('f1', 3.5, 'because A', 2), cand('f2', 2.0, 'because B', 1), cand('f3', 1.0, null, 3)],
    };
    const ctx = { tmdbKey: 'unused', mdblistKey: '', settings: {}, filters: {}, log: q };
    const res = await pipeline.runEngineBuild({ id: pid, name: 'Fake', filters: {} }, 'movie', fakeEngine, ctx, () => {});
    assert.strictEqual(res.stored, 3);
    const rows = Object.fromEntries(rs.getRecommended(pid, { type: 'movie', limit: 100 }).map((r) => [r.tmdb_id, r]));
    assert.strictEqual(Object.keys(rows).length, 3);
    assert.strictEqual(rows.f1.affinity, 3.5);              // rankScore → affinity (I6)
    assert.strictEqual(rows.f1.because_title, 'because A'); // reason → because_title
    assert.strictEqual(rows.f1.rec_count, 2);               // recCount → rec_count
    assert.strictEqual(rows.f1.imdb_id, 'ttf1');
    assert.strictEqual(rows.f3.because_title, null);        // null reason tolerated
    // affinity ordering preserved (I6): serve reads strongest-first.
    assert.deepStrictEqual(rs.getRecommended(pid, { type: 'movie', limit: 100 }).map((r) => r.tmdb_id), ['f1', 'f2', 'f3']);
    rs.deleteForProfile(pid);
    console.log('  ✓ engines: fake engine → shared pipeline → pool rows (rankScore/reason/recCount mapped)');
  }

  // Engine abstraction (SC-03): buildRecommendations DISPATCHES each type to the
  // engine the profile selected, requirement-SKIPS an unready type WITHOUT wiping
  // its rows, annotates the result with the engine id per type, and clearType
  // clears one slice + marks the profile build-needed while dont_recommend survives.
  {
    const rs = require('../src/recommendationStore');
    const engines = require('../src/engines');
    const settings = require('../src/settings');
    const q = { log() {}, warn() {} };

    // preResolved fakes → no network. Each stamps ctx.stats.seeds (so the build
    // isn't treated as seed-less) and tags its rows so we can watch dispatch route
    // each type independently. `ready:false` exercises the requirement-skip path.
    const mkEngine = (id, tag, { ready = true } = {}) => ({
      id, name: id, description: 't', supportedTypes: ['movie', 'series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => (ready ? { ok: true, missing: [] } : { ok: false, missing: ['a widget'] }),
      generate: async (profile, type, ctx) => {
        if (ctx.stats) ctx.stats.seeds = 1;
        return [{
          type, tmdb_id: `${tag}-${type}`, rankScore: 5, imdb_id: `tt-${tag}-${type}`,
          title: `${tag} ${type}`, year: 2024, primary_genre: 'Drama', genres: 'Drama',
          vote_average: 8, vote_count: 5000, popularity: 1, poster: null,
        }];
      },
    });
    const disposers = [
      engines._register(mkEngine('sc03-a', 'A')),
      engines._register(mkEngine('sc03-b', 'B')),
      engines._register(mkEngine('sc03-need', 'N', { ready: false })),
    ];
    // buildRecommendations early-returns without a global TMDB key; set one (the
    // preResolved fakes ignore it) and restore the prior value afterwards.
    const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
    settings.updateSettings({ keys: { tmdb_api_key: 'sc03-tmdb' } });
    // SC-07: dispatch runs through resolveFor, which now gates on global
    // enablement — a registered engine is OFF until Server Config enables it, so
    // turn the dispatch fakes on (Genesis is otherwise the safe-floor fallback).
    settings.updateSettings({ engines: { 'sc03-a': true, 'sc03-b': true, 'sc03-need': true } });
    const prof = config.addProfile('SC03');
    const load = () => config.getProfile(prof.id);
    try {
      // 1. Per-type dispatch: movie built by sc03-a, series by sc03-b.
      config.updateProfile(prof.id, { filters: { engine_movie: 'sc03-a', engine_series: 'sc03-b' } });
      const r1 = await rs.buildRecommendations(load(), q);
      assert.deepStrictEqual(r1.engines, { movie: 'sc03-a', series: 'sc03-b' }); // engine id per type
      assert.strictEqual(rs.getRecommended(prof.id, { type: 'movie', limit: 10 })[0].tmdb_id, 'A-movie'); // sc03-a produced movies
      assert.strictEqual(rs.getRecommended(prof.id, { type: 'series', limit: 10 })[0].tmdb_id, 'B-series'); // sc03-b produced series

      // 2. Requirement-skip must NOT wipe the slice. Point series at the not-ready
      //    engine (bypass updateProfile's rebuild path — set the field directly so
      //    the existing B-series row is still present) and rebuild.
      config.updateProfile(prof.id, { filters: { engine_series: 'sc03-need' } });
      // the change cleared the series slice (via the caller hook is not run here) —
      // clearType is not called by updateProfile itself, so re-seed the slice to
      // prove a REQUIREMENT skip (not an engine change) leaves rows intact.
      rs.upsertCandidates(prof.id, [{ type: 'series', tmdb_id: 'keep1', imdb_id: 'ttkeep1', title: 'Keep', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 9, rec_count: 1, popularity: 1, poster: null }], { ratingCheckedAt: null });
      const r2 = await rs.buildRecommendations(load(), q);
      assert.strictEqual(r2.engines.series, 'sc03-need');
      assert.strictEqual(r2.movie.engine, 'sc03-a');         // movie still built
      assert.strictEqual(r2.series.skipped, true);           // series requirement-skipped
      assert.deepStrictEqual(r2.series.missing, ['a widget']);
      assert.ok(rs.getRecommended(prof.id, { type: 'series', limit: 10 }).some((x) => x.tmdb_id === 'keep1')); // rows survived the skip

      // 3. clearType clears ONLY that slice, keeps dont_recommend, marks build-needed.
      rs.addDontRecommend(prof.id, 'movie', 'A-movie'); // a rejection (also drops the pool row)
      rs.addDontRecommend(prof.id, 'series', 'nope99');
      rs.setBuiltAt(prof.id); // pretend fresh
      const removed = rs.clearType(prof.id, 'series');
      assert.ok(removed >= 1);                                            // series rows deleted
      assert.strictEqual(rs.getRecommended(prof.id, { type: 'series', limit: 10 }).length, 0); // series slice empty
      assert.strictEqual(rs.getBuiltAt(prof.id), 0);                     // build state reset → needsBuild fires
      assert.ok(rs.dontRecommendKeys(prof.id).has('series:nope99'));      // dont_recommend untouched
      assert.ok(rs.dontRecommendKeys(prof.id).has('movie:A-movie'));

      // 4. config.updateProfile REPORTS the changed engine field(s) so the portal /
      //    companion hooks know which slice to clear + rebuild.
      const c1 = config.updateProfile(prof.id, { filters: { engine_movie: 'sc03-b' } });
      assert.deepStrictEqual(c1.engineChanged, ['movie']);              // only movie changed
      const c2 = config.updateProfile(prof.id, { filters: { engine_movie: 'sc03-b' } });
      assert.deepStrictEqual(c2.engineChanged, []);                     // no-op change reports nothing

      // 5. Age-limit REVOCATION (I7) surfaces through the SAME diff — no special
      //    casing: select an unrestricted engine on an adult profile, then raise
      //    age_limit; updateProfile rewrites that type to genesis, and the change
      //    shows up in engineChanged so the caller clears + rebuilds it.
      const disposeOpen = engines._register({
        id: 'sc03-open', name: 'Open', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: true },
        requirements: () => ({ ok: true, missing: [] }), generate: async () => [],
      });
      try {
        config.updateProfile(prof.id, { filters: { engine_movie: 'sc03-open' } }); // legal on an adult profile
        assert.strictEqual(load().filters.engine_movie, 'sc03-open');
        const c3 = config.updateProfile(prof.id, { filters: { age_limit: 12 } });   // raise the limit
        assert.strictEqual(load().filters.engine_movie, 'genesis');                 // unrestricted engine revoked
        assert.deepStrictEqual(c3.engineChanged, ['movie']);                        // revocation reported → clear+rebuild
      } finally { disposeOpen(); }
      console.log('  ✓ engines: SC-03 per-type dispatch, requirement-skip keeps rows, clearType + engineChanged (incl. age revocation)');
    } finally {
      config.removeProfile(prof.id);
      settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
      settings.updateSettings({ engines: { 'sc03-a': false, 'sc03-b': false, 'sc03-need': false } });
      for (const d of disposers) d();
    }
  }

  // Engine abstraction (SC-06): the canonical FAKE fixture (test/fixtures/
  // fake-engine.js) is the conformance vehicle — an engine that shares NONE of
  // Genesis's internals (no Simkl seeding, no TMDB affinity math). Three checks
  // exercise CONFORMANCE.md end-to-end. All offline: the fixture is preResolved
  // (pipeline skips the resolve network) and the age-gate's LLM pass is served
  // from the seeded verdict cache.

  // 1. Per-type isolation: `fake` builds Movies, Genesis owns Series. Genesis RUNS
  //    for series (a Simkl token clears its requirements) and returns [] offline
  //    (no watched series to seed) — proving the fake did not leak across the type
  //    boundary and Genesis, not the fake, produced the (empty) series slice.
  {
    const rs = require('../src/recommendationStore');
    const engines = require('../src/engines');
    const settings = require('../src/settings');
    const { fake } = require('./fixtures/fake-engine');
    const q = { log() {}, warn() {} };
    const dispose = engines._register(fake);
    const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
    settings.updateSettings({ keys: { tmdb_api_key: 'sc06-tmdb' }, engines: { fake: true } });
    const prof = config.addProfile('SC06-ISO');
    try {
      config.updateProfile(prof.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'fake', engine_series: 'genesis' } });
      const res = await rs.buildRecommendations(config.getProfile(prof.id), q);
      assert.deepStrictEqual(res.engines, { movie: 'fake', series: 'genesis' });   // dispatch routed each type
      // Movie slice = the fixture's three candidates, strongest-first (rankScore→affinity, I6).
      assert.deepStrictEqual(
        rs.getRecommended(prof.id, { type: 'movie', limit: 100 }).map((r) => r.tmdb_id),
        ['fake-movie-1', 'fake-movie-2', 'fake-movie-3']);
      assert.ok(!res.series.skipped && res.series.engine === 'genesis');            // Genesis RAN for series…
      assert.strictEqual(rs.getRecommended(prof.id, { type: 'series', limit: 100 }).length, 0); // …and produced nothing (no leak)
      console.log('  ✓ engines: SC-06 fake fixture → per-type isolation (fake Movies + Genesis Series), no Genesis internals');
    } finally {
      config.removeProfile(prof.id);
      rs.deleteForProfile(prof.id);
      settings.updateSettings({ keys: { tmdb_api_key: prevTmdb }, engines: { fake: false } });
      dispose();
    }
  }

  // 2. Safety is engine-independent (I1): a FAKE-sourced kids pool containing an
  //    over-band title has it removed by the SHARED age gate — the age gate, not
  //    the engine, is the authority. The over-band drop comes through the LLM ACB
  //    pass, served entirely from the seeded verdict cache (no LLM call).
  {
    const rs = require('../src/recommendationStore');
    const engines = require('../src/engines');
    const settings = require('../src/settings');
    const store = require('../src/store');
    const animeMap = require('../src/services/animeMap');
    const pipeline = require('../src/engines/pipeline');
    const { fake } = require('./fixtures/fake-engine');
    const q = { log() {}, warn() {} };
    const dispose = engines._register(fake);
    settings.updateSettings({ engines: { fake: true } });
    // Fresh EMPTY anime index so applyAnimeGate (step 1) stays offline and treats
    // every fake title as non-anime (they pass step 1 untouched).
    animeMap._setIndex({ at: Date.now(), etag: 'sc06', byImdb: {}, byTmdb: {} });
    const prof = config.addProfile('SC06-AGE');
    config.updateProfile(prof.id, { filters: { age_limit: 8 } }); // kids profile → judged at 9
    const ctx = { tmdbKey: 'unused', mdblistKey: '', settings: settings.getSettings(), filters: config.getProfile(prof.id).filters, log: q };
    await pipeline.runEngineBuild(config.getProfile(prof.id), 'movie', fake, ctx, () => {});
    assert.strictEqual(rs.getRecommended(prof.id, { type: 'movie', limit: 100 }).length, 3);
    const prevVerdicts = store.loadAgeVerdicts();
    // fake-movie-1 is judged UNSUITABLE at the judgement age (9); the others pass.
    store.saveAgeVerdicts({ 'movie:9:fake-movie-1': false, 'movie:9:fake-movie-2': true, 'movie:9:fake-movie-3': true });
    try {
      const r = await rs.ageGatePool(config.getProfile(prof.id), q);
      assert.strictEqual(r.vetoed, 1);   // the shared age gate removed the over-band title
      assert.strictEqual(r.dropped, 0);  // none were NSFW/anime-band
      assert.deepStrictEqual(
        rs.getRecommended(prof.id, { type: 'movie', limit: 100 }).map((x) => x.tmdb_id),
        ['fake-movie-2', 'fake-movie-3']); // over-band gone; safe titles remain
      console.log('  ✓ engines: SC-06 shared age gate makes a fake-sourced kids pool safe (I1)');
    } finally {
      store.saveAgeVerdicts(prevVerdicts);
      animeMap._setIndex({ at: Date.now(), etag: 'test', byImdb: {}, byTmdb: {} }); // leave empty-fresh for later tests
      config.removeProfile(prof.id);
      rs.deleteForProfile(prof.id);
      settings.updateSettings({ engines: { fake: false } });
      dispose();
    }
  }

  // 3. Unrestricted gating (I7) via `fake-open` on the registry surface: offered to
  //    adults, gated away from any age-limited profile at every enforcement point
  //    (§5.5). (The companion surface's omission of an unrestricted engine reuses
  //    this same fixture in the mobile suite.)
  {
    const engines = require('../src/engines');
    const settings = require('../src/settings');
    const { fake, fakeOpen } = require('./fixtures/fake-engine');
    const disposeF = engines._register(fake);
    const disposeO = engines._register(fakeOpen);
    settings.updateSettings({ engines: { fake: true, 'fake-open': true } });
    const adultP = config.addProfile('SC06-adult');
    const kidP = config.addProfile('SC06-kid');
    try {
      const adult = { filters: {} };
      const kid = { filters: { age_limit: 10, engine_movie: 'fake-open' } };
      // availableFor: open offered to adults, hidden from kids; the GATED fake is
      // offered to both (unrestricted:false is safe via the shared age gate).
      assert.ok(engines.availableFor(adult, 'movie').some((e) => e.id === 'fake-open'));
      assert.ok(!engines.availableFor(kid, 'movie').some((e) => e.id === 'fake-open'));
      assert.ok(engines.availableFor(kid, 'movie').some((e) => e.id === 'fake'));
      // resolveFor: never the open engine for a kid even if hand-stored (Genesis
      // is the safe floor); an adult resolves to it normally.
      assert.strictEqual(engines.resolveFor(kid, 'movie').id, 'genesis');
      assert.strictEqual(engines.resolveFor({ filters: { engine_movie: 'fake-open' } }, 'movie').id, 'fake-open');
      // updateProfile: open persists on an adult; coerces to Genesis on an
      // age-limited profile; and RAISING the limit later revokes it (§5.5 pt3).
      config.updateProfile(adultP.id, { filters: { engine_movie: 'fake-open' } });
      assert.strictEqual(config.getProfile(adultP.id).filters.engine_movie, 'fake-open');
      config.updateProfile(kidP.id, { filters: { age_limit: 12, engine_series: 'fake-open' } });
      assert.strictEqual(config.getProfile(kidP.id).filters.engine_series, 'genesis'); // coerced
      config.updateProfile(adultP.id, { filters: { age_limit: 7 } });
      assert.strictEqual(config.getProfile(adultP.id).filters.engine_movie, 'genesis'); // revoked
      console.log('  ✓ engines: SC-06 fake-open (unrestricted) gated off age-limited profiles (I7: availableFor/resolveFor/updateProfile)');
    } finally {
      config.removeProfile(adultP.id);
      config.removeProfile(kidP.id);
      settings.updateSettings({ engines: { fake: false, 'fake-open': false } });
      disposeO(); disposeF();
    }
  }

  // Job queue: runs ONE AT A TIME (FIFO), reports progress, dedups same (profile,kind).
  {
    const jobs = require('../src/jobs');
    jobs._reset();
    const order = []; let live = 0; let maxLive = 0;
    const mk = (jid, kind) => jobs.enqueue(jid, kind, async (progress) => {
      live++; maxLive = Math.max(maxLive, live); progress(50, 'half');
      await new Promise(r => setTimeout(r, 15)); order.push(`${jid}:${kind}`); live--; return { jid };
    });
    const a = mk('p1', 'recs'); const b = mk('p2', 'extras');
    assert.strictEqual(mk('p1', 'recs'), a); // dedup: same in-flight promise, not a 2nd job
    await Promise.all([a, b]);
    assert.strictEqual(maxLive, 1); // never ran concurrently
    assert.deepStrictEqual(order, ['p1:recs', 'p2:extras']); // FIFO
    assert.strictEqual(jobs.snapshot('p2').state, 'done');
    assert.strictEqual(jobs.snapshot('p2').result.jid, 'p2');
    jobs._reset();
    console.log('  ✓ jobs: global queue serializes, reports progress, dedups');
  }

  // Circuit breaker: a service that opts in (jikan) trips after N failures and
  // then fails fast without touching the network; a service without a breaker
  // (tmdb) never opens. This is what stops us pounding a down Jikan.
  {
    const gov = require('../src/services/governor');
    gov._reset();
    for (let i = 0; i < 5; i++) gov.noteOutcome('jikan', false); // threshold = 5
    assert.strictEqual(gov.isOpen('jikan'), true);
    let called = false;
    await assert.rejects(
      () => gov.schedule('jikan', () => { called = true; return { status: 200 }; }),
      (e) => e.circuitOpen === true,
    );
    assert.strictEqual(called, false); // fn never ran while open
    // A success (half-open probe) closes it again.
    gov.noteOutcome('jikan', true);
    assert.strictEqual(gov.isOpen('jikan'), false);
    // A breaker-less service is immune no matter how many failures.
    for (let i = 0; i < 20; i++) gov.noteOutcome('tmdb', false);
    assert.strictEqual(gov.isOpen('tmdb'), false);
    // A run of failures through schedule (thrown) trips the breaker too.
    gov._reset();
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => gov.schedule('anilist', () => { throw new Error('fetch failed'); }));
    }
    assert.strictEqual(gov.isOpen('anilist'), true);
    gov._reset();
    console.log('  ✓ governor: circuit breaker trips, fails fast, and recovers');
  }

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

  // CP-03: the IMDb rating cache is a shared fact-about-a-title cache — one fetch
  // per title per fortnight across ALL profiles, nulls cached, TTL honoured. Stub
  // the batch fetcher (injectable seam) and count calls.
  store.saveImdbRatingCache({});
  let ratingCalls = 0; let lastFetchedIds = null;
  const fakeBatch = async (_key, _type, ids) => {
    ratingCalls++; lastFetchedIds = ids;
    const m = new Map();
    for (const id of ids) m.set(id, id === 'tt_rated' ? { ratings: [{ source: 'imdb', value: 7.7 }] } : {}); // tt_* others carry no imdb rating -> null
    return m;
  };
  // Profile A: both ids are cache misses -> ONE batch for the pair.
  const rA = await mdblist.cachedImdbRatings('k', 'movie', ['tt_rated', 'tt_unrated'], console, { fetchBatch: fakeBatch });
  assert.strictEqual(rA.get('tt_rated'), 7.7);
  assert.strictEqual(rA.get('tt_unrated'), null); // resolved unrated -> cached as null
  assert.strictEqual(ratingCalls, 1);
  // Profile B: same two titles -> served from the SHARED cache, no second fetch.
  const rB = await mdblist.cachedImdbRatings('k', 'movie', ['tt_rated', 'tt_unrated'], console, { fetchBatch: fakeBatch });
  assert.deepStrictEqual([rB.get('tt_rated'), rB.get('tt_unrated')], [7.7, null]);
  assert.strictEqual(ratingCalls, 1, 'warm cache is shared across profiles — no re-fetch');
  // A cached null is NOT re-fetched: adding a fresh id fetches only that one.
  await mdblist.cachedImdbRatings('k', 'movie', ['tt_rated', 'tt_unrated', 'tt_new'], console, { fetchBatch: fakeBatch });
  assert.strictEqual(ratingCalls, 2);
  assert.deepStrictEqual(lastFetchedIds, ['tt_new'], 'only the miss is fetched; cached rated + null ids are skipped');
  // TTL: age every entry past 14 days -> a re-fetch on next lookup.
  const aged = store.loadImdbRatingCache();
  for (const key of Object.keys(aged)) aged[key].at -= 15 * 24 * 3600e3;
  store.saveImdbRatingCache(aged);
  await mdblist.cachedImdbRatings('k', 'movie', ['tt_rated'], console, { fetchBatch: fakeBatch });
  assert.strictEqual(ratingCalls, 3, 'an entry past the 14-day TTL is re-fetched');
  store.saveImdbRatingCache({});
  console.log('  ✓ IMDb rating cache: shared one-fetch, null-caching, 14-day TTL (CP-03)');

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
  // Anime gate, end to end, with a seeded map + rating cache (no network).
  // The two rules point in OPPOSITE directions and that is the whole design.
  {
    const rebuildMod = require('../src/rebuild');
    const animeMap = require('../src/services/animeMap');
    animeMap._setIndex({
      at: Date.now(), etag: 't',
      byImdb: { tt900: { mal: 900 }, tt901: { mal: 901 }, tt902: { mal: 902 }, tt903: { mal: 903 } },
      byTmdb: {},
    });
    const now = Date.now();
    store.saveAnimeRatings({
      'mal:900': { at: now, verdict: { code: 'Rx', minAge: 99, adult: true } },
      'mal:901': { at: now, verdict: { code: 'R', minAge: 17, adult: false } },
      'mal:902': { at: now, verdict: { code: 'PG-13', minAge: 13, adult: false } },
      // 903 deliberately absent -> unrated
    });
    const pool = () => ([
      { id: 'tt900', name: 'Hentai' }, { id: 'tt901', name: 'R17' },
      { id: 'tt902', name: 'PG13' }, { id: 'tt903', name: 'Unrated' },
      { id: 'tt999', name: 'NotAnime' },
    ]);
    const quiet2 = { log() {}, warn() {} };

    // ADULT profile: pornography still blocked (the blacklist is permanent and
    // not tied to an age limit); everything else passes.
    let out = await rebuildMod.applyAnimeGate(pool(), { name: 'Ad', filters: { age_limit: 0 } }, quiet2);
    assert.deepStrictEqual(out.map(m => m.id), ['tt901', 'tt902', 'tt903', 'tt999']);

    // KID at 13 (judged 14): Rx blocked, R(17) above band, PG-13 kept and
    // ANNOTATED for the LLM, unrated KEPT (falls through to the LLM, never
    // deleted — the exact conflation that emptied catalogs under CSM),
    // non-anime untouched.
    out = await rebuildMod.applyAnimeGate(pool(), { name: 'Kid', filters: { age_limit: 13 } }, quiet2);
    assert.deepStrictEqual(out.map(m => m.id), ['tt902', 'tt903', 'tt999']);
    assert.strictEqual(out.find(m => m.id === 'tt902')._certification, 'PG-13');

    // Request-path blacklist for meta: cache-only, so no outbound call
    assert.strictEqual(await rebuildMod.isBlacklistedTitle('tt900', null, quiet2), true);
    assert.strictEqual(await rebuildMod.isBlacklistedTitle('tt902', null, quiet2), false);
    assert.strictEqual(await rebuildMod.isBlacklistedTitle('tt903', null, quiet2), false); // uncached -> not blocked
    assert.strictEqual(await rebuildMod.isBlacklistedTitle('tt999', null, quiet2), false);

    store.saveAnimeRatings({});
    animeMap._setIndex({ at: Date.now(), etag: 'test', byImdb: {}, byTmdb: {} });
    console.log('  ✓ anime gate: NSFW blocked for all ages, unrated falls through to the LLM');
  }

  // Extra-catalog age gate: adult profiles untouched (no LLM call), kids
  // profiles with no global LLM FAIL CLOSED (caller keeps the previous list).
  // No network in either path.
  const rebuildMod = require('../src/rebuild');
  // Clear the global LLM so the kids gate below fails closed.
  require('../src/settings').updateSettings({ llm: { custom_uri: '', custom_name: '', custom_api_key: '', groq_api_key: '', groq_api_key_backup: '' } });
  assert.strictEqual(require('../src/settings').hasLlm(), false);
  const kids = require('../src/catalogs').getExtra('mdb-kids-movies');    // age_band 12
  const action = require('../src/catalogs').getExtra('mdb-action-movies'); // no band
  const metas = [{ id: 'tt1', name: 'A' }, { id: 'tt2', name: 'B' }];
  const quiet = { log() {}, warn() {} };
  // effectiveAgeLimit: a banded catalog applies its band always; a plain one follows the profile
  assert.strictEqual(rebuildMod.effectiveAgeLimit({ filters: { age_limit: 0 } }, action), 0);  // plain + adult = ungated
  assert.strictEqual(rebuildMod.effectiveAgeLimit({ filters: { age_limit: 0 } }, kids), 12);    // banded + adult = band
  assert.strictEqual(rebuildMod.effectiveAgeLimit({ filters: { age_limit: 8 } }, kids), 8);     // min(12, 8)
  assert.strictEqual(rebuildMod.effectiveAgeLimit({ filters: { age_limit: 15 } }, kids), 12);   // min(12, 15)
  // A plain catalog on an adult profile passes through untouched (no LLM needed)
  assert.deepStrictEqual(
    await rebuildMod.applyExtraAgeGate({ name: 'Adult', filters: { age_limit: 0 }, keys: {} }, action, metas, quiet),
    metas);
  // A BANDED kids catalog gates even an adult profile -> needs the LLM -> fail-closed
  await assert.rejects(
    () => rebuildMod.applyExtraAgeGate({ name: 'Adult', filters: { age_limit: 0 }, keys: {} }, kids, metas, quiet),
    /No LLM configured/);
  // A plain catalog on a kid profile also gates -> fail-closed
  await assert.rejects(
    () => rebuildMod.applyExtraAgeGate({ name: 'Kid', filters: { age_limit: 8 }, keys: {} }, action, metas, quiet),
    /No LLM configured/);
  console.log('  ✓ extra-catalog age gate: band applied always, plain gated only for kids, fail-closed');

  await new Promise(r => setTimeout(r, 400)); // let server bind

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.strictEqual(health.ok, true);
  console.log('  ✓ /health');

  const pkgVersion = require('../package.json').version;
  const ver = await (await fetch(`${BASE}/api/version`)).json();
  assert.strictEqual(ver.version, pkgVersion);
  console.log('  ✓ /api/version matches package.json');

  // Rate-governor stats endpoint responds with a stats object
  const gov = await (await fetch(`${BASE}/api/governor`)).json();
  assert.ok(gov.stats && typeof gov.stats === 'object');
  console.log('  ✓ /api/governor exposes rate-governor stats');

  // Server Config (global settings): PUT then GET roundtrip, complete flag,
  // sealed-on-disk, and unknown test service rejected.
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llm: { groq_api_key: 'ROUNDTRIP-GROQ' }, keys: { tmdb_api_key: 'ROUNDTRIP-TMDB' } }),
  });
  const sget = await (await fetch(`${BASE}/api/settings`)).json();
  assert.strictEqual(sget.settings.keys.tmdb_api_key, 'ROUNDTRIP-TMDB');
  assert.strictEqual(sget.settings.llm.groq_api_key, 'ROUNDTRIP-GROQ');
  assert.strictEqual(sget.complete, true); // TMDB + groq
  const rawSettings = require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'settings.json'), 'utf8');
  assert.ok(!rawSettings.includes('ROUNDTRIP-GROQ')); // sealed on disk
  const badSvc = await fetch(`${BASE}/api/settings/test/nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(badSvc.status, 400);
  // Custom LLM test: early-return paths need no network — missing URI + bad step
  const llmSvc = require('../src/services/llm');
  assert.strictEqual((await llmSvc.testCustomLlm({}, { warn() {} })).checks[0].name, 'config');
  const badStep = await llmSvc.testCustomLlm({ uri: 'http://x/v1', step: 'nope' }, { warn() {} });
  assert.strictEqual(badStep.ok, false);
  assert.strictEqual(badStep.checks[0].name, 'step');
  console.log('  ✓ /api/settings PUT/GET roundtrip, sealed, complete flag; LLM test step-routing');

  const genres = await (await fetch(`${BASE}/api/genres`)).json();
  assert.ok(genres.genres.includes('Horror') && genres.genres.includes('Kids'));
  console.log('  ✓ /api/genres');

  // /api/engines — the static registry for the portal's per-type dropdowns (SC-02).
  // It advertises Genesis + Glass (both types) + Marquee (movie-only), Glass and
  // Marquee registered but globally disabled.
  const eng = await (await fetch(`${BASE}/api/engines`)).json();
  assert.strictEqual(eng.default, 'genesis');
  assert.deepStrictEqual(eng.engines.map((e) => e.id), ['genesis', 'glass', 'marquee']);
  assert.deepStrictEqual(eng.engines[0].supported_types, ['movie', 'series']);
  assert.ok(eng.engines[0].description && eng.engines[0].capabilities.unrestricted === false);
  const glassAd = eng.engines.find((e) => e.id === 'glass');
  assert.ok(glassAd && glassAd.enabled === false && glassAd.capabilities.unrestricted === false);
  console.log('  ✓ /api/engines advertises the registry (Genesis + Glass both types, Marquee movie-only)');

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
  // CP-01 §4: manifest names carry NO type word — the client auto-appends
  // "— Movie(s)". Both AI rows are now just "Recommended for you".
  assert.strictEqual(manifest.catalogs[0].name, 'Recommended for you');
  assert.strictEqual(manifest.catalogs[1].name, 'Recommended for you');
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

  // publicProfile carries the per-type engine block (SC-02): selection (default
  // Genesis), the age-filtered availability list, and the effective engine's
  // requirement check. engine_movie/engine_series also arrive inside `filters`.
  assert.strictEqual(listed.engines.movie, 'genesis');
  assert.strictEqual(listed.engines.series, 'genesis');
  assert.strictEqual(listed.filters.engine_movie, 'genesis');
  assert.deepStrictEqual(listed.engines.available.movie, ['genesis']); // Genesis offered to every profile
  assert.strictEqual(typeof listed.engines.requirements.movie.ok, 'boolean'); // needs TMDB+Simkl → false here (no keys)
  console.log('  ✓ profile API carries the per-type engine selection + availability + requirements');

  // Unknown token -> 404
  res = await fetch(`${BASE}/addon/deadbeef/manifest.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ unknown token rejected');

  // Simkl auth routes (no-network paths). The profile API exposes simkl fields;
  // connect without a Client ID -> 400; live status with no token -> not
  // connected (no network); disconnect -> ok.
  assert.ok('simkl_client_id' in listed.keys && 'simkl_connected' in listed);
  assert.strictEqual(listed.simkl_connected, false);
  // connect with NO Client ID -> 400 (checked before any key is set)
  res = await fetch(`${BASE}/api/profiles/${profile.id}/simkl/connect`, { method: 'POST' });
  assert.strictEqual(res.status, 400);
  const sstatus = await (await fetch(`${BASE}/api/profiles/${profile.id}/simkl/status`)).json();
  assert.strictEqual(sstatus.connected, false);
  assert.strictEqual(sstatus.reason, 'not connected'); // token-less check is network-free
  const sdis = await fetch(`${BASE}/api/profiles/${profile.id}/simkl/disconnect`, { method: 'POST' });
  assert.strictEqual(sdis.status, 200);
  // Regression (the "Save erased my keys" bug): the PUT key whitelist must
  // include the Simkl keys, or Save silently drops them. Persist + read back.
  // Done LAST so the connect-needs-Client-ID check above still sees no key.
  await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: { simkl_client_id: 'CID-WL-1', simkl_client_secret: 'SEC-WL-2' } }),
  });
  const after = (await (await fetch(`${BASE}/api/profiles`)).json()).profiles.find(pp => pp.id === profile.id);
  assert.strictEqual(after.keys.simkl_client_id, 'CID-WL-1');
  assert.strictEqual(after.keys.simkl_client_secret, 'SEC-WL-2');
  // Watched sync with no connected account -> skipped, network-free; status
  // reports a watched_count from the SQLite store.
  const sync = await (await fetch(`${BASE}/api/profiles/${profile.id}/simkl/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.strictEqual(sync.skipped, true);
  assert.strictEqual(sync.reason, 'Simkl not connected');
  const st2 = await (await fetch(`${BASE}/api/profiles/${profile.id}/simkl/status`)).json();
  assert.strictEqual(st2.watched_count, 0);
  console.log('  ✓ Simkl keys persist (PUT whitelist) + watched sync/count wired to SQLite');

  // Recommendation builder + suppress (no-network paths). The build is enqueued
  // on the job queue and answered 202; poll /job until it finishes. No watched
  // seeds -> the job's result is skipped.
  const started = await fetch(`${BASE}/api/profiles/${profile.id}/recommend/build`, { method: 'POST' });
  assert.strictEqual(started.status, 202);
  let job = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 50));
    job = (await (await fetch(`${BASE}/api/profiles/${profile.id}/job`)).json()).job;
    if (job && (job.state === 'done' || job.state === 'error')) break;
  }
  assert.strictEqual(job.state, 'done');
  assert.strictEqual(job.result.skipped, true);
  // SC-03: Genesis' requirements gate now fires first — this profile has a TMDB key
  // (global) but no Simkl connection, so both types requirement-skip with a clear
  // "missing Simkl connection" reason (was the generic seed-less skip pre-SC-03).
  assert.match(job.result.reason, /Simkl/);
  assert.deepStrictEqual(job.result.engines, { movie: 'genesis', series: 'genesis' });
  const recView = await (await fetch(`${BASE}/api/profiles/${profile.id}/recommend`)).json();
  assert.strictEqual(recView.total, 0);
  assert.deepStrictEqual(recView.engines, { movie: 'genesis', series: 'genesis' }); // /recommend surfaces per-type engine
  // The View panel shows what the catalogs SERVE: the profile's filters + list
  // size (was: the raw pool's top 40, ignoring both).
  {
    const rsv = require('../src/recommendationStore');
    const before = config.getProfile(profile.id).filters;
    config.updateProfile(profile.id, { filters: { ...before, list_size: 5, min_rating: 7 } });
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push({ type: 'movie', tmdb_id: 'vr' + i, imdb_id: 'ttvr' + i, title: 'Good ' + i, year: 2024, primary_genre: i % 2 ? 'Drama' : 'Comedy', genres: i % 2 ? 'Drama' : 'Comedy', vote_average: 8, vote_count: 5000, affinity: 10 - i, rec_count: 1, popularity: 1 });
    for (let i = 0; i < 3; i++) rows.push({ type: 'movie', tmdb_id: 'vb' + i, imdb_id: 'ttvb' + i, title: 'Low ' + i, year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 5, vote_count: 5000, affinity: 100 - i, rec_count: 1, popularity: 1 });
    rsv.upsertCandidates(profile.id, rows);
    const v = await (await fetch(`${BASE}/api/profiles/${profile.id}/recommend`)).json();
    assert.strictEqual(v.total, 11, 'pool size still reported');
    assert.strictEqual(v.listSize, 5);
    assert.strictEqual(v.movies.length, 5, 'list size honoured');
    assert.ok(v.movies.every((r) => r.vote_average >= 7), 'rating floor honoured (the high-affinity 5.0 titles are hidden)');
    config.updateProfile(profile.id, { filters: before });
    rsv.deleteForProfile(profile.id);
  }
  // Suppress endpoint validates its input and records a rejection
  const badSuppress = await fetch(`${BASE}/api/profiles/${profile.id}/recommend/suppress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(badSuppress.status, 400);
  const okSuppress = await (await fetch(`${BASE}/api/profiles/${profile.id}/recommend/suppress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '999' }) })).json();
  assert.strictEqual(okSuppress.ok, true);
  const reset = await (await fetch(`${BASE}/api/profiles/${profile.id}/recommend/reset`, { method: 'POST' })).json();
  assert.strictEqual(reset.ok, true);
  assert.strictEqual(reset.total, 0);
  console.log('  ✓ recommendation build/view/suppress/reset endpoints');

  // MW-02: portal mark-as-watched route (the catalog-preview eye). Validates its
  // input like the companion twin, then guards Simkl-not-connected with a 400 (this
  // profile has a TMDB key but no Simkl). The happy/502 paths ride markWatched's own
  // tests + the companion watchedHandler; here we pin the route wiring + guards.
  const badWatched = await fetch(`${BASE}/api/profiles/${profile.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(badWatched.status, 400); // no type
  const noIdWatched = await fetch(`${BASE}/api/profiles/${profile.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie' }) });
  assert.strictEqual(noIdWatched.status, 400); // type but no id
  const noSimklWatched = await fetch(`${BASE}/api/profiles/${profile.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', imdb_id: 'tt0133093', title: 'The Matrix' }) });
  assert.strictEqual(noSimklWatched.status, 400);
  assert.match((await noSimklWatched.json()).error, /Simkl/); // clean "connect Simkl", never a silent pass
  console.log('  ✓ portal /watched: validates + guards Simkl-not-connected (MW-02)');

  // Empty pool -> warming-up card, short client cache
  const recStore = require('../src/recommendationStore');
  const wStore = require('../src/watchedStore');
  let cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas.length, 1);
  assert.ok(cat.metas[0].name.includes('warming up') || cat.metas[0].name.includes('List warming up'));
  assert.strictEqual(cat.cacheMaxAge, 300);
  console.log('  ✓ empty pool serves warming-up card');

  // Seed the recommendation pool, then the catalog serves it instantly (no rebuild)
  recStore.upsertCandidates(profile.id, [
    { type: 'movie', tmdb_id: '999001', imdb_id: 'tt0111161', title: 'Test Movie', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 9.0, affinity: 2.0, rec_count: 1, popularity: 10, poster: 'https://image.tmdb.org/t/p/w500/x.jpg' },
  ]);
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas[0].id, 'tt0111161');
  assert.strictEqual(cat.metas[0].releaseInfo, '2024');
  assert.strictEqual(cat.cacheMaxAge, 3600); // short hint so pruned lists appear fast
  assert.strictEqual(cat.staleRevalidate, 43200);
  console.log('  ✓ seeded pool served with SWR headers');

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

  // ---- In-player "Don't recommend" ----
  // The served meta carries a tappable link that opens our public GET /dnr route
  // (Stremio/Nuvio render it as a chip; opening it launches the device browser).
  assert.ok(Array.isArray(meta.meta.links), 'meta should carry links');
  const dnrLink = meta.meta.links.find((l) => l.category === 'AI Recommender');
  assert.ok(dnrLink, 'meta should include a Don’t recommend link');
  assert.strictEqual(dnrLink.url, `${BASE}/addon/${profile.token}/dnr/series/tt0944947`);

  // Opening the link is a plain browser GET — no auth, no interaction. It records
  // the rejection and returns a human confirmation page. Use a throwaway pooled
  // title so the shared tt0111161 fixture the later tests rely on stays put.
  recStore.upsertCandidates(profile.id, [
    { type: 'movie', tmdb_id: '999777', imdb_id: 'tt0133093', title: 'Suppress Me', year: 1999, primary_genre: 'Action', genres: 'Action', vote_average: 8, affinity: 1, rec_count: 1, popularity: 1, poster: null },
  ]);
  const dnrRes = await fetch(`${BASE}/addon/${profile.token}/dnr/movie/tt0133093`);
  assert.strictEqual(dnrRes.status, 200);
  assert.match(dnrRes.headers.get('content-type') || '', /text\/html/);
  const dnrHtml = await dnrRes.text();
  assert.match(dnrHtml, /Suppress Me/);            // resolved title, HTML-escaped, in the message
  assert.match(dnrHtml, /recommended/);
  // Recorded as a permanent user rejection and dropped from the pool (no rebuild),
  // while the untouched fixture survives for the tests below.
  assert.ok(recStore.dontRecommendKeys(profile.id).has('movie:999777'));
  assert.ok(!recStore.getRecommended(profile.id, { type: 'movie' }).some((r) => r.imdb_id === 'tt0133093'));
  assert.ok(recStore.getRecommended(profile.id, { type: 'movie' }).some((r) => r.imdb_id === 'tt0111161'));
  // An unknown profile token is refused at /dnr too (shared router guard)
  const dnrBadTok = await fetch(`${BASE}/addon/deadbeef/dnr/movie/tt0133093`);
  assert.strictEqual(dnrBadTok.status, 404);
  console.log('  ✓ in-player Don’t recommend: meta link + GET suppresses (shared path)');

  // Non-tt ids and unknown types are ours to reject, not to guess at
  res = await fetch(`${BASE}/addon/${profile.token}/meta/series/kitsu:123.json`);
  assert.strictEqual(res.status, 404);
  res = await fetch(`${BASE}/addon/${profile.token}/meta/channel/tt0944947.json`);
  assert.strictEqual(res.status, 404);
  // No TMDB key configured -> 404 rather than a hang or a 500
  res = await fetch(`${BASE}/addon/${profile.token}/meta/movie/tt0111161.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ meta rejects non-tt ids, unknown types, missing key');

  // RPDB is a GLOBAL key (Server Config) — setting it rewrites poster URLs at
  // serve time (no rebuild).
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: { rpdb_api_key: 't0-testkey' } }),
  });
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas[0].poster, 'https://api.ratingposterdb.com/t0-testkey/imdb/poster-default/tt0111161.jpg?fallback=true');
  console.log('  ✓ RPDB poster substitution at serve time (global key)');

  // Serve-time watched pruning: a title in the watched store is removed at serve
  // time even though it's still in the pool. Cross-type too — a title logged as a
  // SHOW never shows in the movie catalog (IMDb ids are global; types can disagree).
  wStore.upsertMany(profile.id, [{ type: 'series', title: 'Test Movie', year: 2024, tmdb_id: '999002', imdb_id: 'tt0111161', simkl_id: 424242, watched_at: '2026-08-18T00:00:00Z' }]);
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas.length, 0);
  console.log('  ✓ cross-type serve-time watched pruning');
  wStore.deleteForProfile(profile.id);

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

  // User email (Mobile Companion) round-trips + trims
  const withEmail = (await (await fetch(`${BASE}/api/profiles/${profile.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '  James@Example.com  ' }),
  })).json()).profile;
  assert.strictEqual(withEmail.email, 'James@Example.com');
  console.log('  ✓ user email stored on the profile');

  // Rebuild without Simkl or any enabled catalog -> clean 400
  res = await fetch(`${BASE}/api/profiles/${profile.id}/rebuild`, { method: 'POST' });
  assert.strictEqual(res.status, 400);
  console.log('  ✓ rebuild without Simkl / enabled catalogs rejected cleanly');

  // ---- Extra catalogs (second profile keeps earlier assertions intact) ----
  const defs = await (await fetch(`${BASE}/api/catalogs`)).json();
  assert.strictEqual(defs.catalogs.length, 14);
  assert.ok(defs.catalogs.some(c => c.id === 'mdb-popular-series' && c.type === 'series'));
  assert.ok(defs.catalogs.some(c => c.id === 'trakt-anime-teen-series' && c.source === 'mdblist'));
  assert.ok(defs.catalogs.some(c => c.id === 'trakt-watchlist-movies' && c.source === 'simkl_plantowatch' && c.default_on === true));
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

  // Watch Later without Simkl: dropped from the manifest, and answers empty
  // rather than a card. The row it appeared on no longer exists — the configure
  // portal is where that state is surfaced now.
  let wcat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/trakt-watchlist-movies.json`)).json();
  assert.deepStrictEqual(wcat.metas, []);
  console.log('  ✓ empty Watch Later serves nothing, not a placeholder card');

  // WL-KW: Watch Later KEEPS watched titles (dedupe_watched:false), like
  // Christmas — a hand-added plan-to-watch title stays on the row even once it's
  // in the watched store (previously it was pruned at serve time).
  const wStore2 = require('../src/watchedStore');
  store.swapExtra(p2.id, 'trakt-watchlist-movies', [
    { id: 'tt0111161', type: 'movie', name: 'Seen Pick', poster: null, description: '', releaseInfo: '2020' },
    { id: 'tt0068646', type: 'movie', name: 'Unseen Pick', poster: null, description: '', releaseInfo: '1972' },
  ]);
  wStore2.upsertMany(p2.id, [{ type: 'movie', title: 'Seen Pick', year: 2020, tmdb_id: '9111', imdb_id: 'tt0111161', simkl_id: 9111, watched_at: '2026-08-18T00:00:00Z' }]);
  wcat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/trakt-watchlist-movies.json`)).json();
  assert.deepStrictEqual(wcat.metas.map(m => m.id), ['tt0111161', 'tt0068646']); // watched title retained
  console.log('  ✓ Watch Later keeps watched titles at serve time (WL-KW)');
  wStore2.deleteForProfile(p2.id);

  // WL-KW build path: buildWatchlistCatalog KEEPS a plan-to-watch title that is
  // already watched. Serve-time honoured the flag before this card; the BUILD
  // pruned in two places regardless — this covers that gap. Stub the Simkl list
  // (imdb-only items -> minimal fallback, no TMDB call) and seed the watched
  // store, then build directly.
  const simklSvc = require('../src/services/simkl');
  const wlDef = require('../src/catalogs').getExtra('trakt-watchlist-movies');
  const origPTW = simklSvc.getPlanToWatch;
  simklSvc.getPlanToWatch = async () => ([
    { imdb_id: 'tt0111161', title: 'Seen Later', year: 2020 },   // in the watched store
    { imdb_id: 'tt0068646', title: 'Fresh Later', year: 1972 },  // not watched
  ]);
  const wStoreB = require('../src/watchedStore');
  wStoreB.upsertMany(p2.id, [{ type: 'movie', title: 'Seen Later', year: 2020, tmdb_id: '9911', imdb_id: 'tt0111161', simkl_id: 9911, watched_at: '2026-08-18T00:00:00Z' }]);
  const silentLog = { log() {}, warn() {}, error() {} };
  const built = await rebuild.buildWatchlistCatalog(
    { id: p2.id, name: 'WL', simkl_auth: { access_token: 't' }, keys: {} }, wlDef, silentLog,
  );
  assert.deepStrictEqual(built.map(m => m.id), ['tt0111161', 'tt0068646']); // watched title retained at BUILD
  simklSvc.getPlanToWatch = origPTW;
  wStoreB.deleteForProfile(p2.id);
  console.log('  ✓ Watch Later keeps watched titles at BUILD (WL-KW)');

  // CP-03: buildWatchlistCatalog enriches each title's IMDb rating via the shared
  // cache. Stub Simkl (one title) + TMDB meta (so we own the TMDB fallback), seed
  // the rating cache, and build. The badge should carry the true IMDb number with
  // a key, and keep the TMDB-derived value (never blank) without one — no network
  // either way (warm cache / skipped).
  {
    const tmdbSvc = require('../src/services/tmdb');
    const origMeta = tmdbSvc.metaByTmdbId;
    simklSvc.getPlanToWatch = async () => ([{ imdb_id: 'tt_cp03wl', tmdb_id: '4242', title: 'WL Title', year: 2019 }]);
    tmdbSvc.metaByTmdbId = async () => ({ id: 'tt_cp03wl', type: 'movie', name: 'WL Title', poster: null, description: '', releaseInfo: '2019', imdbRating: '6.9' });
    try {
      // (a) MDBList key + a warm cache with the true IMDb 8.1 -> overwrite the TMDB value.
      store.saveImdbRatingCache({ tt_cp03wl: { rating: 8.1, at: Date.now() } });
      const withKey = await rebuild.buildWatchlistCatalog(
        { id: 'cp03-wl-a', name: 'WLa', simkl_auth: { access_token: 't' }, keys: { mdblist_api_key: 'wl-mdb' } }, wlDef, silentLog,
      );
      assert.strictEqual(withKey[0].imdbRating, '8.1'); // true IMDb, resolved from the cache (no fetch)
      // (b) No MDBList key -> enrichment skipped, the TMDB-derived rating is kept.
      const noKey = await rebuild.buildWatchlistCatalog(
        { id: 'cp03-wl-b', name: 'WLb', simkl_auth: { access_token: 't' }, keys: {} }, wlDef, silentLog,
      );
      assert.strictEqual(noKey[0].imdbRating, '6.9'); // TMDB fallback, never blanked
    } finally {
      simklSvc.getPlanToWatch = origPTW;
      tmdbSvc.metaByTmdbId = origMeta;
      store.saveImdbRatingCache({});
    }
    console.log('  ✓ Watch Later build enriches IMDb rating via the shared cache; TMDB fallback kept without a key (CP-03)');
  }

  // WL-AV: metaByTmdbId surfaces the raw release_dates rows ONLY when asked, and
  // its default callers are unchanged. Stub global.fetch so the details call is
  // hermetic (no network); the governor just paces it.
  {
    const origFetch = global.fetch;
    const payload = {
      title: 'Availability Probe', external_ids: { imdb_id: 'tt_avprobe' }, genres: [],
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-01-01' }] }] },
    };
    global.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
    try {
      const withAppend = await tmdb.metaByTmdbId('k', 'movie', 42, silentLog, { append: 'release_dates' });
      assert.ok(Array.isArray(withAppend._release_dates_results), 'appended -> rows surfaced');
      assert.strictEqual(withAppend._release_dates_results[0].iso_3166_1, 'US');
      assert.strictEqual(tmdb.movieAvailability(withAppend._release_dates_results), 'AVAILABLE');
      const noAppend = await tmdb.metaByTmdbId('k', 'movie', 42, silentLog);
      assert.strictEqual(noAppend._release_dates_results, undefined, 'default caller: field absent');
    } finally {
      global.fetch = origFetch;
    }
    console.log('  ✓ metaByTmdbId surfaces _release_dates_results only when release_dates is appended (WL-AV)');
  }

  // WL-AV: buildWatchlistCatalog suppresses not-yet-streamable titles, keeps
  // available + fail-open (unresolved/UNKNOWN) ones, self-reverses when the date
  // flips, and memoizes only the terminal AVAILABLE fact (skipping the append +
  // verdict next build). We drive availability off the meta the stub returns:
  // `_release_dates_results` for movies (movieAvailability reads it) and only ask
  // for it when the released memo doesn't already know the title.
  {
    const tmdbSvc = require('../src/services/tmdb');
    const origMeta = tmdbSvc.metaByTmdbId;
    const NOW = Date.now();
    const past = new Date(NOW - 5 * 864e5).toISOString().slice(0, 10);
    const future = new Date(NOW + 90 * 864e5).toISOString().slice(0, 10);
    // The list: an available movie (past digital), a not-yet movie (future
    // digital), and a movie TMDB can't resolve (no tmdb_id -> minimal fallback).
    simklSvc.getPlanToWatch = async () => ([
      { imdb_id: 'tt_av_ok', tmdb_id: '5001', title: 'Out Now', year: 2026 },
      { imdb_id: 'tt_av_soon', tmdb_id: '5002', title: 'Not Yet', year: 2027 },
      { imdb_id: 'tt_av_unres', title: 'Unresolvable', year: 2025 }, // no tmdb_id
    ]);
    const appendCalls = {}; // tmdb_id -> the append arg it was last called with
    const digital = (date) => [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: date }] }];
    const metaFor = (id, dateRows) => ({
      id: id === '5001' ? 'tt_av_ok' : 'tt_av_soon', type: 'movie',
      name: id === '5001' ? 'Out Now' : 'Not Yet', poster: null, description: '',
      releaseInfo: id === '5001' ? '2026' : '2027',
      _release_dates_results: dateRows,
    });
    store.saveReleasedCache({}); // clean slate
    try {
      tmdbSvc.metaByTmdbId = async (_k, _t, id, _log, opts = {}) => {
        appendCalls[id] = opts.append || null;
        if (id === '5001') return metaFor(id, digital(past));   // AVAILABLE
        if (id === '5002') return metaFor(id, digital(future)); // NOT_YET
        return null;
      };
      const built1 = await rebuild.buildWatchlistCatalog(
        { id: 'wlav-a', name: 'AV', simkl_auth: { access_token: 't' }, keys: {} }, wlDef, silentLog,
      );
      // Available kept, not-yet suppressed, unresolved kept (fail-open).
      assert.deepStrictEqual(built1.map((m) => m.id), ['tt_av_ok', 'tt_av_unres'],
        'WL-AV: not-yet suppressed; available + unresolved kept');
      // First build asked for release_dates on both resolvable movies.
      assert.strictEqual(appendCalls['5001'], 'release_dates');
      assert.strictEqual(appendCalls['5002'], 'release_dates');
      // Only the AVAILABLE title is memoized; NOT_YET/UNKNOWN never written.
      const memo = store.loadReleasedCache();
      assert.strictEqual(memo['movie:tt_av_ok'], true, 'AVAILABLE memoized');
      assert.ok(!('movie:tt_av_soon' in memo), 'NOT_YET never memoized');
      assert.ok(!('movie:tt_av_unres' in memo), 'UNKNOWN never memoized');

      // Second build: the known-released title skips the append (and the verdict),
      // the still-NOT_YET title is re-checked WITH the append and stays suppressed.
      appendCalls['5001'] = 'SENTINEL'; appendCalls['5002'] = 'SENTINEL';
      const built2 = await rebuild.buildWatchlistCatalog(
        { id: 'wlav-a', name: 'AV', simkl_auth: { access_token: 't' }, keys: {} }, wlDef, silentLog,
      );
      assert.deepStrictEqual(built2.map((m) => m.id), ['tt_av_ok', 'tt_av_unres']);
      assert.strictEqual(appendCalls['5001'], null, 'known-released -> no release_dates append');
      assert.strictEqual(appendCalls['5002'], 'release_dates', 'still not-yet -> re-checked with append');

      // Self-reversal: the not-yet movie goes digital (date now in the past) ->
      // it reappears on the next build with no other change, and is memoized.
      tmdbSvc.metaByTmdbId = async (_k, _t, id, _log, opts = {}) => {
        appendCalls[id] = opts.append || null;
        if (id === '5001') return metaFor(id, digital(past));
        if (id === '5002') return metaFor(id, digital(past)); // NOW available
        return null;
      };
      const built3 = await rebuild.buildWatchlistCatalog(
        { id: 'wlav-a', name: 'AV', simkl_auth: { access_token: 't' }, keys: {} }, wlDef, silentLog,
      );
      assert.deepStrictEqual(built3.map((m) => m.id), ['tt_av_ok', 'tt_av_soon', 'tt_av_unres'],
        'WL-AV: title reappears once available (self-reversing)');
      assert.strictEqual(store.loadReleasedCache()['movie:tt_av_soon'], true, 'newly-available now memoized');
    } finally {
      simklSvc.getPlanToWatch = origPTW;
      tmdbSvc.metaByTmdbId = origMeta;
      store.saveReleasedCache({});
    }
    console.log('  ✓ Watch Later suppresses not-yet titles, keeps available/fail-open, self-reverses + memoizes released (WL-AV)');
  }

  // WL-AV (series): a show that has aired is kept; one that hasn't is suppressed.
  {
    const tmdbSvc = require('../src/services/tmdb');
    const origMeta = tmdbSvc.metaByTmdbId;
    const wlSeriesDef = require('../src/catalogs').getExtra('trakt-watchlist-series');
    const NOW = Date.now();
    const pastAir = new Date(NOW - 30 * 864e5).toISOString().slice(0, 10);
    const futureAir = new Date(NOW + 30 * 864e5).toISOString().slice(0, 10);
    simklSvc.getPlanToWatch = async () => ([
      { imdb_id: 'tt_s_aired', tmdb_id: '6001', title: 'Aired', year: 2024 },
      { imdb_id: 'tt_s_upcoming', tmdb_id: '6002', title: 'Upcoming', year: 2027 },
    ]);
    store.saveReleasedCache({});
    try {
      tmdbSvc.metaByTmdbId = async (_k, _t, id, _log, opts = {}) => {
        // Series never asks for the release_dates append (movies only).
        assert.strictEqual(opts.append || null, null, 'series build never appends release_dates');
        return {
          id: id === '6001' ? 'tt_s_aired' : 'tt_s_upcoming', type: 'series',
          name: id === '6001' ? 'Aired' : 'Upcoming', poster: null, description: '',
          releaseInfo: id === '6001' ? '2024' : '2027',
          _release_date: id === '6001' ? pastAir : futureAir,
        };
      };
      const built = await rebuild.buildWatchlistCatalog(
        { id: 'wlav-s', name: 'AVs', simkl_auth: { access_token: 't' }, keys: {} }, wlSeriesDef, silentLog,
      );
      assert.deepStrictEqual(built.map((m) => m.id), ['tt_s_aired'], 'WL-AV series: aired kept, upcoming suppressed');
      assert.strictEqual(store.loadReleasedCache()['series:tt_s_aired'], true);
    } finally {
      simklSvc.getPlanToWatch = origPTW;
      tmdbSvc.metaByTmdbId = origMeta;
      store.saveReleasedCache({});
    }
    console.log('  ✓ Watch Later series availability: aired kept, upcoming suppressed (WL-AV)');
  }

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

  // v6: curated extras DO de-dupe against the Simkl-backed watched store, EXCEPT
  // Christmas (re-watchables). Seed one watched + one unwatched into Action.
  const wStore3 = require('../src/watchedStore');
  store.swapExtra(p2.id, 'mdb-action-movies', [
    { id: 'tt0111161', type: 'movie', name: 'Seen Action', poster: null, description: '', releaseInfo: '2020' },
    { id: 'tt0068646', type: 'movie', name: 'Unseen Action', poster: null, description: '', releaseInfo: '1972' },
  ]);
  wStore3.upsertMany(p2.id, [{ type: 'movie', title: 'Seen Action', year: 2020, tmdb_id: '9333', imdb_id: 'tt0111161', simkl_id: 9333, watched_at: '2026-08-18T00:00:00Z' }]);
  ecat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/mdb-action-movies.json`)).json();
  assert.deepStrictEqual(ecat.metas.map(m => m.id), ['tt0068646']); // watched pruned
  console.log('  ✓ curated extra de-dupes watched titles');
  // Christmas is exempt (dedupe_watched:false): the watched title still shows
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogs: { 'mdb-christmas-movies': true, 'mdb-action-movies': true, 'mdb-popular-series': true } }),
  });
  store.swapExtra(p2.id, 'mdb-christmas-movies', [
    { id: 'tt0111161', type: 'movie', name: 'Seen Xmas', poster: null, description: '', releaseInfo: '2020' },
  ]);
  const xcat = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/mdb-christmas-movies.json`)).json();
  assert.deepStrictEqual(xcat.metas.map(m => m.id), ['tt0111161']); // NOT pruned — re-watchable
  console.log('  ✓ Christmas exempt from watched de-dupe');
  wStore3.deleteForProfile(p2.id);

  // CP-01: catalog preview API. The preview serves the SAME list the addon feeds
  // the client (shared servedCatalog), so the configurator can compare them.
  const catalogServe = require('../src/catalogServe');
  // Keep mdb-action-movies enabled (the later rebuild test asserts on it); add war.
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogs: { 'mdb-war-movies': true, 'mdb-action-movies': true, 'mdb-popular-series': true } }),
  });
  store.swapExtra(p2.id, 'mdb-war-movies', [
    { id: 'tt0110413', type: 'movie', name: 'Léon', poster: 'https://img/leon.jpg', imdbRating: '8.5', releaseInfo: '1994' },
    { id: 'tt0102926', type: 'movie', name: 'JFK', poster: 'https://img/jfk.jpg', imdbRating: '8.0', releaseInfo: '1991' },
  ]);
  const routeWar = await (await fetch(`${BASE}/addon/${p2.token}/catalog/movie/mdb-war-movies.json`)).json();
  const prevWar = await (await fetch(`${BASE}/api/profiles/${p2.id}/catalogs/mdb-war-movies/preview`)).json();
  assert.strictEqual(prevWar.state, 'ok');
  assert.strictEqual(prevWar.count, 2);
  assert.deepStrictEqual(prevWar.metas.map(m => m.id), routeWar.metas.map(m => m.id)); // preview == serve
  assert.strictEqual(prevWar.metas[0].imdbRating, '8.5'); // rating carried through for the modal badge
  // ...and the shared function is exactly what the route serializes, by construction.
  const sharedWar = catalogServe.servedCatalog(config.getProfile(p2.id), 'mdb-war-movies');
  assert.deepStrictEqual(sharedWar.metas.map(m => m.id), routeWar.metas.map(m => m.id));
  console.log('  ✓ catalog preview equals the addon serve (CP-01)');

  // Unknown catalog id -> 404
  let pv = await fetch(`${BASE}/api/profiles/${p2.id}/catalogs/nope-nope/preview`);
  assert.strictEqual(pv.status, 404);
  // Over-band catalog on an age-limited profile -> 404 (age safety, mirrors serve)
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { age_limit: 8 } }),
  });
  pv = await fetch(`${BASE}/api/profiles/${p2.id}/catalogs/trakt-anime-teen-series/preview`);
  assert.strictEqual(pv.status, 404);
  await fetch(`${BASE}/api/profiles/${p2.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { age_limit: 0 } }),
  });
  // Empty-state reasons the modal renders: AI with no pool + no Simkl -> needs_simkl
  // (and the type-free name), a curated list with no key -> needs_mdblist_key.
  const prevAi = await (await fetch(`${BASE}/api/profiles/${p2.id}/catalogs/ai-recs-movies/preview`)).json();
  assert.strictEqual(prevAi.count, 0);
  assert.strictEqual(prevAi.state, 'needs_simkl');
  assert.strictEqual(prevAi.name, 'Recommended for you');
  const prevKey = await (await fetch(`${BASE}/api/profiles/${p2.id}/catalogs/mdb-horror-movies/preview`)).json();
  assert.strictEqual(prevKey.state, 'needs_mdblist_key');
  console.log('  ✓ preview age-gate 404 + empty-state reasons (CP-01)');

  // Wrong type for a known extra id -> 404
  res = await fetch(`${BASE}/addon/${p2.token}/catalog/series/mdb-action-movies.json`);
  assert.strictEqual(res.status, 404);
  console.log('  ✓ extra catalog type mismatch rejected');

  // ---- MW-00: mark watched prunes AI + curated NOW, keeps Watch Later ----
  // Inline profile (synthetic id) so this doesn't couple to p2's later assertions.
  {
    const markWatched = require('../src/markWatched');
    const wStore = require('../src/watchedStore');
    const simklSvc = require('../src/services/simkl');
    const rsvc = require('../src/recommendationStore');
    const catServe = require('../src/catalogServe');
    const mwId = 'mw00-serve-' + Date.now();
    const prof = { id: mwId, name: 'MW', filters: {}, keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    rsvc.upsertCandidates(mwId, [
      { type: 'movie', tmdb_id: '603', imdb_id: 'tt0133093', title: 'The Matrix', year: 1999, primary_genre: 'Action', genres: 'Action', vote_average: 8.7, affinity: 3, rec_count: 1, popularity: 9, poster: null },
    ]);
    store.swapExtra(mwId, 'mdb-action-movies', [
      { id: 'tt0133093', type: 'movie', name: 'The Matrix' },
      { id: 'tt0111161', type: 'movie', name: 'Other' },
    ]);
    store.swapExtra(mwId, 'trakt-watchlist-movies', [{ id: 'tt0133093', type: 'movie', name: 'The Matrix' }]);
    // Present everywhere before the mark.
    assert.ok(catServe.servedCatalog(prof, 'ai-recs-movies').metas.some((m) => m.id === 'tt0133093'));
    assert.ok(catServe.servedCatalog(prof, 'mdb-action-movies').metas.some((m) => m.id === 'tt0133093'));
    // Mark watched — stub the Simkl write, capture the body.
    const origHist = simklSvc.addToHistory;
    let sentBody = null;
    simklSvc.addToHistory = async (_p, body) => { sentBody = body; return {}; };
    let out;
    try {
      out = await markWatched.markWatched(prof, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'The Matrix' }, { log() {} });
    } finally { simklSvc.addToHistory = origHist; }
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(sentBody, { movies: [{ ids: { imdb: 'tt0133093', tmdb: '603' } }], shows: [] });
    assert.ok(!('watched_at' in sentBody.movies[0]), 'MW: no explicit watched date');
    assert.ok(wStore.watchedIdSets(mwId).imdb.has('tt0133093'), 'pending shim unions into the watched set now');
    // Gone from AI + the curated extra immediately (before any sync)...
    assert.ok(!catServe.servedCatalog(prof, 'ai-recs-movies').metas.some((m) => m.id === 'tt0133093'));
    assert.deepStrictEqual(catServe.servedCatalog(prof, 'mdb-action-movies').metas.map((m) => m.id), ['tt0111161']);
    // ...but KEPT in Watch Later (dedupe_watched:false).
    assert.deepStrictEqual(catServe.servedCatalog(prof, 'trakt-watchlist-movies').metas.map((m) => m.id), ['tt0133093']);
    wStore.deleteForProfile(mwId); rsvc.deleteForProfile(mwId); store.deleteCache(mwId);
    console.log('  ✓ mark watched (no date) prunes AI + curated now, keeps Watch Later (MW-00)');
  }

  // ---- MW-03: "not interested" filters curated (Christmas) but exempts Watch Later ----
  {
    const rsvc = require('../src/recommendationStore');
    const catServe = require('../src/catalogServe');
    const s3Id = 'mw03-suppress-' + Date.now();
    const prof = { id: s3Id, name: 'S3', filters: {}, keys: {}, simkl_auth: { access_token: 't' } };
    // Same title in Christmas (mdblist, dedupe_watched:false) AND Watch Later (plantowatch).
    store.swapExtra(s3Id, 'mdb-christmas-movies', [
      { id: 'tt_sup', type: 'movie', name: 'Suppressed Xmas' },
      { id: 'tt_keep', type: 'movie', name: 'Kept Xmas' },
    ]);
    store.swapExtra(s3Id, 'trakt-watchlist-movies', [{ id: 'tt_sup', type: 'movie', name: 'Suppressed but planned' }]);
    // Suppress by imdb (with a resolvable tmdb, as the real path requires).
    rsvc.addDontRecommend(s3Id, 'movie', '9001', 'user', Date.now(), 'tt_sup');
    assert.ok(rsvc.dontRecommendImdbSet(s3Id).has('tt_sup'));
    // Christmas (source:mdblist) is filtered even though it's dedupe_watched:false;
    // the exemption is keyed on SOURCE, not dedupe_watched.
    assert.deepStrictEqual(catServe.servedCatalog(prof, 'mdb-christmas-movies').metas.map((m) => m.id), ['tt_keep']);
    // Watch Later (source:simkl_plantowatch) is EXEMPT — the planned title stays.
    assert.deepStrictEqual(catServe.servedCatalog(prof, 'trakt-watchlist-movies').metas.map((m) => m.id), ['tt_sup']);
    rsvc.deleteForProfile(s3Id); store.deleteCache(s3Id);
    console.log('  ✓ not-interested filters Christmas but exempts Watch Later, source-keyed (MW-03)');
  }

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
  // v6: rebuildProfile builds EXTRA catalogs only — AI recs come from the pool.
  assert.strictEqual(lr.movie, undefined); // no AI half here anymore
  assert.ok(/MDBList/i.test(lr['mdb-action-movies'].error)); // extras need a key
  console.log('  ✓ async rebuild: 202 + polled status carries extras results');

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

  // SC-07: global engine enablement over HTTP — GET /api/engines enabled/locked,
  // PUT /api/settings toggle (Genesis-lock coercion + unknown-id drop), and the
  // disable→revert fan-out (a disabled engine's profiles fall back to Genesis, its
  // slice is cleared, dont_recommend preserved, the other type untouched).
  {
    const engines = require('../src/engines');
    const rs = require('../src/recommendationStore');
    // Genesis: enabled + locked in the API payload.
    const eng0 = await (await fetch(`${BASE}/api/engines`)).json();
    const gen = eng0.engines.find((e) => e.id === 'genesis');
    assert.deepStrictEqual([gen.enabled, gen.locked], [true, true]);

    // A second (preResolved) engine ships DISABLED — registered ≠ available.
    const dispose = engines._register({
      id: 'sc07-fake', name: 'SC07 Fake', description: 'stub', supportedTypes: ['movie', 'series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async (p, type) => [{ type, tmdb_id: `sc07-${type}`, rankScore: 5, imdb_id: `ttsc07${type}`, title: 'x', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null }],
    });
    try {
      const eng1 = await (await fetch(`${BASE}/api/engines`)).json();
      assert.strictEqual(eng1.engines.find((e) => e.id === 'sc07-fake').enabled, false);

      const prof = (await (await fetch(`${BASE}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'SC07' }) })).json()).profile;
      const listP = async () => (await (await fetch(`${BASE}/api/profiles`)).json()).profiles.find((x) => x.id === prof.id);
      assert.ok(!(await listP()).engines.available.movie.includes('sc07-fake')); // disabled → absent from dropdowns

      // Enable it. Genesis:false is coerced back on; an unknown id is dropped.
      const put = await (await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engines: { 'sc07-fake': true, genesis: false, 'ghost-id': true } }) })).json();
      assert.strictEqual(put.settings.engines.genesis, true); // Genesis-lock coercion
      assert.ok(!('ghost-id' in put.settings.engines));       // unknown id dropped
      assert.strictEqual(engines.isEnabled('sc07-fake'), true);
      // PATCH semantics: a PUT that does NOT name sc07-fake must leave it enabled —
      // a partial toggle never silently disables engines it omitted.
      await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engines: { genesis: true } }) });
      assert.strictEqual(engines.isEnabled('sc07-fake'), true);
      const enabledP = await listP();
      assert.ok(enabledP.engines.available.movie.includes('sc07-fake')); // now selectable

      // Select it on Series; seed a pool row per type + a Series rejection.
      await fetch(`${BASE}/api/profiles/${prof.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: { ...enabledP.filters, engine_series: 'sc07-fake' } }) });
      assert.strictEqual((await listP()).engines.series, 'sc07-fake');
      rs.upsertCandidates(prof.id, [
        { type: 'movie', tmdb_id: 'm-keep', imdb_id: 'ttmkeep', title: 'M', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 9, rec_count: 1, popularity: 1, poster: null },
        { type: 'series', tmdb_id: 's-gone', imdb_id: 'ttsgone', title: 'S', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 9, rec_count: 1, popularity: 1, poster: null },
      ]);
      rs.addDontRecommend(prof.id, 'series', 'rejected-1', 'user');

      // Disable it → the Series slice reverts to Genesis + clears; Movies untouched;
      // the rejection survives; the engine leaves the dropdowns.
      await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engines: { 'sc07-fake': false } }) });
      const afterP = await listP();
      assert.strictEqual(afterP.engines.series, 'genesis');                 // persisted revert
      assert.strictEqual(rs.getRecommended(prof.id, { type: 'series', limit: 10 }).length, 0); // stale slice cleared
      assert.ok(rs.getRecommended(prof.id, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 'm-keep')); // Movies untouched
      assert.ok(rs.dontRecommendKeys(prof.id).has('series:rejected-1')); // rejection preserved (engine-independent)
      assert.ok(!afterP.engines.available.series.includes('sc07-fake'));  // gone from dropdowns

      await fetch(`${BASE}/api/profiles/${prof.id}`, { method: 'DELETE' });
    } finally { dispose(); require('../src/settings').updateSettings({ engines: { 'sc07-fake': false } }); }
    console.log('  ✓ /api/settings SC-07: enable/disable toggle, Genesis-lock + unknown-drop, disable→revert fan-out');
  }

  // ---- Trainer T1: portal routes over HTTP (F11.5) ----
  // Hit every row of the shared httpStatus mapper: 200 ok; 400 bad-type /
  // not-supported / bad-rating / bad-value / bad-view / no-simkl; 404
  // not-in-history + unknown profile; 502 thrown Simkl write. The Simkl
  // write is stubbed (smoke makes no network calls); setIgnored is local
  // only (M2) and needs no stub.
  {
    const simkl = require('../src/services/simkl');
    const watchedStore = require('../src/watchedStore');
    const prof = config.addProfile('TrainerHTTP');
    config.updateProfile(prof.id, {
      keys: { simkl_client_id: 'cid-1', simkl_client_secret: 'sec-1' },
      simkl_auth: { access_token: 'tok-1', username: 'james', connected_at: 1 },
    });
    watchedStore.upsertMany(prof.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' }]);

    // GET listing -> 200 with the seeded row.
    let res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer`);
    assert.strictEqual(res.status, 200);
    assert.ok((await res.json()).items.some((i) => i.tmdb_id === '1'));

    // Rate -> 200 (Simkl write stubbed); F4 no-op: same value again ->
    // unchanged, zero Simkl calls.
    const origSet = simkl.setRatings;
    simkl.setRatings = async () => ({});
    try {
      res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', rating: 5 }) });
      assert.strictEqual(res.status, 200);
      let rated = await res.json();
      assert.strictEqual(rated.item.rating, 5);
      assert.strictEqual(rated.unchanged, false);
      let calls = 0;
      simkl.setRatings = async () => { calls += 1; return {}; };
      res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', rating: 5 }) });
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.json()).unchanged, true);
      assert.strictEqual(calls, 0);
    } finally {
      simkl.setRatings = origSet;
    }
    // 400: bad-type, not-supported, bad-rating (no Simkl involved).
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'bogus', tmdb_id: '1', rating: 5 }) });
    assert.strictEqual(res.status, 400);
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'series', tmdb_id: '1', rating: 5 }) });
    assert.strictEqual(res.status, 400);
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', rating: 11 }) });
    assert.strictEqual(res.status, 400);
    // 404: not-in-history (unknown title).
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '999', rating: 5 }) });
    assert.strictEqual(res.status, 404);
    // Ignore -> 200 (local only, M2); bad-value -> 400; not-in-history -> 404.
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/ignore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', ignored: true }) });
    assert.strictEqual(res.status, 200);
    let ignored = await res.json();
    assert.strictEqual(ignored.item.ignored, true);
    assert.strictEqual(ignored.unchanged, false);
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/ignore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', ignored: 'yes' }) });
    assert.strictEqual(res.status, 400);
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/ignore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '999', ignored: true }) });
    assert.strictEqual(res.status, 404);
    // Finished: a watched (not unfinished) row -> 404 not-in-history.
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/finished`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1' }) });
    assert.strictEqual(res.status, 404);
    // 400: bad-view on the listing.
    res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer?view=bogus`);
    assert.strictEqual(res.status, 400);
    // 400: no-simkl (a profile without Simkl credentials).
    const noSimkl = config.addProfile('TrainerNoSimkl');
    res = await fetch(`${BASE}/api/profiles/${noSimkl.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', rating: 5 }) });
    assert.strictEqual(res.status, 400);
    // 404: unknown profile.
    res = await fetch(`${BASE}/api/profiles/does-not-exist/trainer`);
    assert.strictEqual(res.status, 404);
    // 502: a thrown Simkl write (stubbed to throw).
    simkl.setRatings = async () => { throw new Error('Simkl POST /sync/ratings failed (500)'); };
    try {
      res = await fetch(`${BASE}/api/profiles/${prof.id}/trainer/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1', rating: 6 }) });
      assert.strictEqual(res.status, 502);
    } finally {
      simkl.setRatings = origSet;
    }
    watchedStore.deleteForProfile(prof.id);
    config.removeProfile(prof.id);
    config.removeProfile(noSimkl.id);
    console.log('  ✓ trainer portal routes over HTTP: 200/400/404/502 (F11.5)');
  }

  // T3: the portal serves the Trainer UI helper and the tab wiring.
  {
    let res = await fetch(`${BASE}/configure/trainer-ui.js`);
    assert.strictEqual(res.status, 200);
    let body = await res.text();
    assert.ok(body.includes('TrainerUI'));
    res = await fetch(`${BASE}/configure/`);
    assert.strictEqual(res.status, 200);
    body = await res.text();
    assert.ok(body.includes('data-tab="trainer"'));
    assert.ok(body.includes('trainer-ui.js'));
    assert.ok(body.includes('--love'));
    assert.ok(body.includes('data-filter="min_year"') && body.includes("[2020,'2020 onwards']") && body.includes("[1980,'1980 onwards'],[0,'No limit']") && !body.includes('data-filter="max_age_years"'), 'portal Released filter offers decades (2020..1980, No limit)');
    assert.ok(body.includes("onclick=\"switchTab(this,'trainer')\">Ratings</button>") && !body.includes('>Trainer</button>'), 'the tab is labelled Ratings (UI rename)');
    assert.ok(body.includes('color: var(--star-empty)') && body.includes('--star-empty: #6b7184'), 'empty stars use the --star-empty token (contrast tidy-up)');
    console.log('  ✓ trainer portal UI: trainer-ui.js served + tab wiring in index.html');
  }

  // T3.1 U6: the served index.html has no _undoT/6000 auto-refresh left (R1).
  {
    const body = await (await fetch(`${BASE}/configure/`)).text();
    assert.ok(!body.includes('_undoT'), 'no _undoT auto-refresh');
    assert.ok(!body.includes('6000'), 'no 6000ms auto-refresh');
    console.log('  ✓ T3.1 U6: no _undoT/6000 auto-refresh left in the served index.html');
  }

  console.log(`\nAll checks passed (${passed} unit + 59 async/http).`);
  process.exit(0);
}

httpTests().catch(err => {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
});
