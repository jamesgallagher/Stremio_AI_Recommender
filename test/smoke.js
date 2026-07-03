// Smoke test: no network calls — exercises store, filters, prompt/parse logic,
// genre mapping, and the HTTP surface with a seeded cache.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-test-' + Date.now();
process.env.PORT = '7311';

const assert = require('assert');
const store = require('../src/store');
const config = require('../src/config');
const rebuild = require('../src/rebuild');
const gemini = require('../src/services/gemini');
const tmdb = require('../src/services/tmdb');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('unit:');

ok('store: atomic swap preserves other catalog type', () => {
  store.swapCatalog('p1', 'movie', [{ id: 'tt1' }], 'gemini');
  store.swapCatalog('p1', 'series', [{ id: 'tt2' }], 'discover');
  const c = store.loadCache('p1');
  assert.strictEqual(c.movie.metas[0].id, 'tt1');
  assert.strictEqual(c.series.metas[0].id, 'tt2');
  assert.strictEqual(c.series.source, 'discover');
  store.deleteCache('p1');
});

ok('config: profile CRUD + filter clamping', () => {
  const p = config.addProfile('Test');
  assert.ok(p.token.length === 32);
  assert.strictEqual(p.filters.min_rating, 7.0);
  assert.strictEqual(p.filters.max_age_years, 5);
  assert.strictEqual(p.keys.rpdb_api_key, 't0-free-rpdb'); // free RPDB key pre-set
  assert.strictEqual(p.filters.age_limit, 0); // age gate off by default
  assert.strictEqual(p.filters.list_size, 20); // fill-to-quota default
  config.updateProfile(p.id, { filters: { min_rating: -3, excluded_genres: ['Horror'] } });
  const p2 = config.getProfile(p.id);
  assert.strictEqual(p2.filters.min_rating, 0); // clamped
  assert.deepStrictEqual(p2.filters.excluded_genres, ['Horror']);
  assert.ok(config.getProfileByToken(p.token));
  config.removeProfile(p.id);
  assert.strictEqual(config.getProfile(p.id), null);
});

ok('filters: watched dedupe on canonical IDs', () => {
  const metas = [
    { id: 'tt001', name: 'Seen (imdb)', _tmdb_id: 1, _genre_ids: [], _vote_average: 8, _release_date: '2024-01-01' },
    { id: 'tt002', name: 'Seen (tmdb)', _tmdb_id: 2, _genre_ids: [], _vote_average: 8, _release_date: '2024-01-01' },
    { id: 'tt003', name: 'Fresh', _tmdb_id: 3, _genre_ids: [], _vote_average: 8, _release_date: '2024-01-01' },
    { id: 'tt003', name: 'Fresh dup', _tmdb_id: 3, _genre_ids: [], _vote_average: 8, _release_date: '2024-01-01' },
  ];
  const watched = { imdbIds: new Set(['tt001']), tmdbIds: new Set([2]) };
  const out = rebuild.applyHardFilters(metas, 'movie',
    { min_rating: 0, max_age_years: 0, excluded_genres: [] }, watched, { log() {}, warn() {} });
  assert.deepStrictEqual(out.map(m => m.name), ['Fresh']);
});

ok('filters: rating, recency, genre exclusion enforced', () => {
  const y = new Date().getFullYear();
  const metas = [
    { id: 'tt1', name: 'LowRated', _tmdb_id: 1, _genre_ids: [18], _vote_average: 6.4, _release_date: `${y}-01-01` },
    { id: 'tt2', name: 'TooOld', _tmdb_id: 2, _genre_ids: [18], _vote_average: 8, _release_date: '1999-01-01' },
    { id: 'tt3', name: 'Scary', _tmdb_id: 3, _genre_ids: [27, 18], _vote_average: 8, _release_date: `${y}-01-01` },
    { id: 'tt4', name: 'Keeper', _tmdb_id: 4, _genre_ids: [18], _vote_average: 8, _release_date: `${y}-01-01` },
    { id: 'tt5', name: 'Unrated OK', _tmdb_id: 5, _genre_ids: [18], _vote_average: 0, _release_date: `${y}-01-01` },
  ];
  const out = rebuild.applyHardFilters(metas, 'movie',
    { min_rating: 7, max_age_years: 5, excluded_genres: ['Horror'] },
    { imdbIds: new Set(), tmdbIds: new Set() }, { log() {}, warn() {} });
  assert.deepStrictEqual(out.map(m => m.name), ['Keeper', 'Unrated OK']);
});

ok('filters: cleanMetas strips internal fields', () => {
  const out = rebuild.cleanMetas([{ id: 'tt1', name: 'X', _tmdb_id: 9, _genre_ids: [1], _vote_average: 8, _vote_count: 10, _release_date: '2024-01-01' }]);
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['id', 'name']);
});

ok('gemini: prompt includes per-profile constraints', () => {
  const p = gemini.buildPrompt('movie', [{ title: 'Heat', year: 1995 }],
    { min_rating: 7.5, max_age_years: 10, excluded_genres: ['Horror', 'War'] }, ['Alien']);
  assert.ok(p.includes('7.5 or higher'));
  assert.ok(p.includes('last 10 years'));
  assert.ok(p.includes('NEVER recommend anything in these genres: Horror, War'));
  assert.ok(p.includes('Alien'));
  const p2 = gemini.buildPrompt('series', [{ title: 'Bluey', year: 2018 }],
    { min_rating: 0, max_age_years: 0, excluded_genres: [] }, []);
  assert.ok(!p2.includes('or higher'));
  assert.ok(!p2.includes('last '));
});

ok('gemini: age-limited prompt demands Common Sense compliance', () => {
  const p = gemini.buildPrompt('movie', [{ title: 'Bluey', year: 2018 }],
    { min_rating: 0, max_age_years: 0, excluded_genres: [], age_limit: 8 }, [], 30);
  assert.ok(p.includes('Common Sense Media age rating of 8+'));
  assert.ok(p.includes('Recommend 30 movies'));
});

ok('mdblist: Common Sense age parsing (strict, CSM only)', () => {
  const { parseCommonSenseAge } = require('../src/services/mdblist');
  assert.strictEqual(parseCommonSenseAge({ commonsense: 8 }), 8);
  assert.strictEqual(parseCommonSenseAge({ commonsense: '10+' }), 10);
  assert.strictEqual(parseCommonSenseAge({ ratings: [{ source: 'commonsense', value: 13 }] }), 13);
  assert.strictEqual(parseCommonSenseAge({ commonsense: null, ratings: [{ source: 'imdb', value: 9 }] }), null);
  assert.strictEqual(parseCommonSenseAge({}), null);
});

ok('gemini: parses fenced + raw JSON output', () => {
  const fenced = '```json\n[{"title":"Dune","year":2021}]\n```';
  assert.deepStrictEqual(gemini.parseJsonArray(fenced), [{ title: 'Dune', year: 2021 }]);
  assert.deepStrictEqual(gemini.parseJsonArray('[{"title":"Heat","year":"1995"}]'), [{ title: 'Heat', year: 1995 }]);
  assert.throws(() => gemini.parseJsonArray('{"not":"array"}'));
});

ok('baseurl: trailing slashes and missing schemes normalized', () => {
  const { normalizeExternal } = require('../src/baseurl');
  assert.strictEqual(normalizeExternal('https://test.url/'), 'https://test.url');
  assert.strictEqual(normalizeExternal('https://test.url///'), 'https://test.url');
  assert.strictEqual(normalizeExternal('http://test.url'), 'http://test.url');
  assert.strictEqual(normalizeExternal(' recs.example.com/ '), 'https://recs.example.com');
  assert.strictEqual(normalizeExternal('HTTPS://Test.URL/'), 'HTTPS://Test.URL');
  assert.strictEqual(normalizeExternal(''), '');
  assert.strictEqual(normalizeExternal(undefined), '');
});

ok('tmdb: genre aliases map across movie/tv vocabularies', () => {
  const movieIds = tmdb.excludedGenreIds(['Horror', 'Science Fiction'], 'movie');
  assert.ok(movieIds.has(27) && movieIds.has(878));
  const tvIds = tmdb.excludedGenreIds(['Science Fiction', 'Action'], 'series');
  assert.ok(tvIds.has(10765) && tvIds.has(10759)); // Sci-Fi & Fantasy, Action & Adventure
  assert.strictEqual(tmdb.excludedGenreIds(['Horror'], 'series').size, 0); // no TV horror genre
});

// ---- HTTP surface ----
console.log('http:');
require('../src/server');
const BASE = `http://localhost:${process.env.PORT}`;

async function httpTests() {
  await new Promise(r => setTimeout(r, 400)); // let server bind

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.strictEqual(health.ok, true);
  console.log('  ✓ /health');

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

  // Manifest via install token
  const manifest = await (await fetch(`${BASE}/addon/${profile.token}/manifest.json`)).json();
  assert.strictEqual(manifest.catalogs.length, 2);
  assert.strictEqual(manifest.catalogs[0].name, 'Movies recommended for you');
  assert.strictEqual(manifest.catalogs[1].name, 'Series recommended for you');
  assert.ok(manifest.name.includes('SmokeTest'));
  console.log('  ✓ /addon/:token/manifest.json');

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
  ], 'gemini');
  cat = await (await fetch(`${BASE}/addon/${profile.token}/catalog/movie/ai-recs-movies.json`)).json();
  assert.strictEqual(cat.metas[0].id, 'tt0111161');
  assert.strictEqual(cat.cacheMaxAge, 3600); // short hint so pruned lists appear fast
  assert.strictEqual(cat.staleRevalidate, 43200);
  console.log('  ✓ seeded cache served with SWR headers');

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

  // Portal page served
  const html = await (await fetch(`${BASE}/configure/`)).text();
  assert.ok(html.includes('AI Recommender'));
  console.log('  ✓ /configure/ portal served');

  console.log(`\nAll checks passed (${passed} unit + 14 http).`);
  process.exit(0);
}

httpTests().catch(err => {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
});
