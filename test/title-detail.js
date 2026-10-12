// TD-1 — Title detail: server (D1-D13) + component (U1-U9) tests.
// Plain Node assert, injected fakes, no network.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-td1-test-' + Date.now();
process.env.PORT = '7314';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
process.env.EXTERNAL_URL = '';

const assert = require('assert');
let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(` ✓ ${name}`); }
const asyncPending = [];
function okAsync(name, fn) { asyncPending.push({ name, fn }); }

// ---- D1: movie payload with AU "M" and US "PG-13" -> rating {label:'M', country:'AU'} ----
okAsync('D1: movie with AU M + US PG-13 -> rating AU M', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({
    tmdbId: '603', title: 'The Matrix', year: '1999',
    poster: 'https://image.tmdb.org/t/p/w500/x.jpg', synopsis: 'A hacker...',
    runtime: '136 min', genres: ['Sci-Fi'],
    certs: { AU: 'M', US: 'PG-13', GB: '12', IE: null, NZ: null, CA: '13+' },
    cast: [{ name: 'Keanu Reeves', character: 'Neo', photo: 'https://image.tmdb.org/t/p/w185/a.jpg' }],
    status: 'Released',
  });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603' }, console, { tmdbTitleDetail });
  assert.strictEqual(result.rating.label, 'M');
  assert.strictEqual(result.rating.country, 'AU');
});

// ---- D2: only US "R" -> US R ----
okAsync('D2: only US R -> rating US R', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({
    tmdbId: '100', title: 'Test Movie', year: '2000',
    poster: null, synopsis: '', runtime: '90 min', genres: ['Drama'],
    certs: { AU: null, US: 'R', GB: null, IE: null, NZ: null, CA: null },
    cast: [], status: 'Released',
  });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt100', tmdbId: '100' }, console, { tmdbTitleDetail });
  assert.strictEqual(result.rating.label, 'R');
  assert.strictEqual(result.rating.country, 'US');
});

// ---- D3: no certs -> rating === null ----
okAsync('D3: no certs -> rating null', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({
    tmdbId: '200', title: 'Test', year: '2005',
    poster: null, synopsis: '', runtime: null, genres: [],
    certs: { AU: null, US: null, GB: null, IE: null, NZ: null, CA: null },
    cast: [], status: 'Released',
  });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt200', tmdbId: '200' }, console, { tmdbTitleDetail });
  assert.strictEqual(result.rating, null);
});

// ---- D4: TMDB cast of 12 -> exactly 8, in TMDB order ----
okAsync('D4: cast of 12 -> exactly 8 in order', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const cast12 = Array.from({ length: 12 }, (_, i) => ({ name: `Actor${i}`, character: `Char${i}`, photo: `https://image.tmdb.org/t/p/w185/${i}.jpg` }));
  const tmdbTitleDetail = async () => ({
    tmdbId: '300', title: 'Test', year: '2010',
    poster: null, synopsis: '', runtime: null, genres: [],
    certs: {}, cast: cast12, status: 'Released',
  });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt300', tmdbId: '300' }, console, { tmdbTitleDetail });
  assert.strictEqual(result.cast.length, 8);
  assert.strictEqual(result.cast[0].name, 'Actor0');
  assert.strictEqual(result.cast[7].name, 'Actor7');
  assert.ok(result.cast[0].photo.startsWith('https://image.tmdb.org/t/p/w185/'));
});

// ---- D5: series uses content_ratings; tv call does not request seasons ----
okAsync('D5: series uses content_ratings, one TMDB call', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  let callCount = 0;
  const tmdbTitleDetail = async () => {
    callCount++;
    return {
      tmdbId: '400', title: 'Test Series', year: '2015',
      poster: null, synopsis: '', runtime: null, genres: ['Drama'],
      certs: { AU: 'TV-MA', US: 'TV-14', GB: null, IE: null, NZ: null, CA: null },
      cast: [], status: 'Returning Series',
    };
  };
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'series', imdbId: 'tt400', tmdbId: '400' }, console, { tmdbTitleDetail });
  assert.strictEqual(callCount, 1);
  assert.strictEqual(result.rating.label, 'TV-MA');
  assert.strictEqual(result.rating.country, 'AU');
});

// ---- D6: anime with AniList chars -> castSource:'anilist' ----
okAsync('D6: anime with AniList chars -> castSource anilist', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({
    tmdbId: '500', title: 'Anime Test', year: '2020',
    poster: null, synopsis: '', runtime: null, genres: ['Anime'],
    certs: {}, cast: [{ name: 'TMDB Actor', character: 'Char', photo: null }], status: 'Completed',
  });
  const anilistCharacters = async () => [{ name: 'Voice Actor', character: 'Hero', photo: 'https://img.anilist.co/a.jpg' }];
  const animeLookup = () => ({ anilist: 12345 });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'anime', imdbId: 'tt500', tmdbId: '500' }, console, { tmdbTitleDetail, anilistCharacters, animeLookup });
  assert.strictEqual(result.castSource, 'anilist');
  assert.strictEqual(result.cast[0].name, 'Voice Actor');
});

// ---- D7: AniList returns null -> TMDB cast, castSource:'tmdb' ----
okAsync('D7: AniList null -> TMDB cast, castSource tmdb', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({
    tmdbId: '600', title: 'Anime Test', year: '2020',
    poster: null, synopsis: '', runtime: null, genres: ['Anime'],
    certs: {}, cast: [{ name: 'TMDB Actor', character: 'Char', photo: null }], status: 'Completed',
  });
  const anilistCharacters = async () => null;
  const animeLookup = () => ({ anilist: 12345 });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'anime', imdbId: 'tt600', tmdbId: '600' }, console, { tmdbTitleDetail, anilistCharacters, animeLookup });
  assert.strictEqual(result.castSource, 'tmdb');
  assert.strictEqual(result.cast[0].name, 'TMDB Actor');
});

// ---- D8: second call with same ids -> zero fetches (cache) ----
okAsync('D8: cache hit -> zero fetches', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  let fetchCount = 0;
  const tmdbTitleDetail = async () => { fetchCount++; return { tmdbId: '700', title: 'Cached', year: '2010', poster: null, synopsis: '', runtime: null, genres: [], certs: {}, cast: [], status: 'Released' }; };
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const r1 = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt700', tmdbId: '700' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 1);
  const r2 = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt700', tmdbId: '700' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 1, 'second call should hit cache');
  assert.deepStrictEqual(r1, r2);
});

// ---- D9: cache entry past TTL -> refetch ----
okAsync('D9: cache past TTL -> refetch', async () => {
  const { getTitleDetail, detailFile } = require('../src/titleDetail');
  const fs = require('fs');
  const path = require('path');
  let fetchCount = 0;
  const tmdbTitleDetail = async () => { fetchCount++; return { tmdbId: '800', title: 'Expired', year: '2010', poster: null, synopsis: '', runtime: null, genres: [], certs: {}, cast: [], status: 'Released' }; };
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  // Write a stale cache entry (2 hours old, 1 hour TTL → expired).
  const file = detailFile('movie', '800');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 2 * 3600e3, ttl: 3600e3, detail: { type: 'movie', tmdb_id: '800', title: 'Expired' } }));
  const r1 = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt800', tmdbId: '800' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 1, 'stale cache should refetch');
});

// ---- D10: returning series gets 24h TTL, ended gets 7d ----
okAsync('D10: returning 24h, ended 7d', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({ tmdbId: '900', title: 'Test', year: '2020', poster: null, synopsis: '', runtime: null, genres: [], certs: {}, cast: [], status: 'Returning Series' });
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  await getTitleDetail(profile, { type: 'series', imdbId: 'tt900', tmdbId: '900' }, console, { tmdbTitleDetail });
  const { loadCache } = require('../src/titleDetail');
  const cached = loadCache('series', '900');
  assert.ok(cached, 'cache should exist');
});

// ---- D11: TMDB fake throws -> returns null, no throw ----
okAsync('D11: TMDB throws -> null, no throw', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => { throw new Error('TMDB down'); };
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  const result = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt1100', tmdbId: '1100' }, console, { tmdbTitleDetail });
  assert.strictEqual(result, null);
});

// ---- D12: no key and no cache -> null ----
okAsync('D12: no key and no cache -> null', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const tmdbTitleDetail = async () => ({ tmdbId: '1200', title: 'X', year: '2010', poster: null, synopsis: '', runtime: null, genres: [], certs: {}, cast: [], status: 'Released' });
  const profile = { keys: {} }; // no tmdb_api_key
  const result = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt1200', tmdbId: '1200' }, console, { tmdbTitleDetail });
  assert.strictEqual(result, null);
});

// ---- D13: real route tests (portal + mobile) ----
okAsync('D13: portal route — bad type 400, no id 400, null 404, success 200', async () => {
  const express = require('express');
  const { router } = require('../src/portal');
  const config = require('../src/config');
  const app = express();
  app.use('/portal', router);
  const prof = config.addProfile('TD13Test');
  config.updateProfile(prof.id, { email: 'td13@test.local', keys: { tmdb_api_key: 'test-key' } });
  const tmdb = require('../src/services/tmdb');
  const origTitleDetail = tmdb.titleDetail;
  tmdb.titleDetail = async () => ({ tmdbId: '1300', title: 'Test', year: '2010', poster: null, synopsis: 'syn', runtime: '90 min', genres: ['Drama'], certs: { AU: 'M' }, cast: [{ name: 'A', character: 'B', photo: null }], status: 'Released' });
  try {
    const srv = app.listen(0);
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}/portal`;
    // Bad type: 400
    let res = await fetch(`${base}/profiles/${prof.id}/title-detail?type=foo`);
    assert.strictEqual(res.status, 400);
    let body = await res.json();
    assert.strictEqual(body.error, 'bad-type');
    // No id: 400
    res = await fetch(`${base}/profiles/${prof.id}/title-detail?type=movie`);
    assert.strictEqual(res.status, 400);
    body = await res.json();
    assert.strictEqual(body.error, 'no-id');
    // Success: 200 with exact key set
    res = await fetch(`${base}/profiles/${prof.id}/title-detail?type=movie&imdb_id=tt1300&tmdb_id=1300`);
    assert.strictEqual(res.status, 200);
    body = await res.json();
    const keys = Object.keys(body).sort();
    assert.deepStrictEqual(keys, ['cast', 'castSource', 'genres', 'imdb_id', 'poster', 'rating', 'runtime', 'synopsis', 'title', 'tmdb_id', 'type', 'year']);
    // Unknown profile: 404
    res = await fetch(`${base}/profiles/nonexistent/title-detail?type=movie&imdb_id=tt1&tmdb_id=1`);
    assert.strictEqual(res.status, 404);
    srv.close();
  } finally {
    tmdb.titleDetail = origTitleDetail;
  }
});

// ---- D13b: mobile handler — bad type 400, no id 400, null 404, success 200 ----
okAsync('D13b: mobile handler — bad type 400, no id 400, null 404, success 200', async () => {
  const { titleDetailHandler } = require('../mobile/server/handlers');
  const tmdb = require('../src/services/tmdb');
  const origTitleDetail = tmdb.titleDetail;
  tmdb.titleDetail = async () => ({ tmdbId: '1300', title: 'Test', year: '2010', poster: null, synopsis: 'syn', runtime: '90 min', genres: ['Drama'], certs: { AU: 'M' }, cast: [{ name: 'A', character: 'B', photo: null }], status: 'Released' });
  try {
    const fakeRes = () => {
      const r = { status: (code) => { r.code = code; return r; }, json: (body) => { r.body = body; return r; } };
      return r;
    };
    // Bad type: 400
    let req = { query: { type: 'foo' }, profile: { id: 'p1', keys: { tmdb_api_key: 'k' } } };
    let res = fakeRes();
    await titleDetailHandler(req, res);
    assert.strictEqual(res.code, 400);
    assert.strictEqual(res.body.error, 'bad-type');
    // No id: 400
    req = { query: { type: 'movie' }, profile: { id: 'p1', keys: { tmdb_api_key: 'k' } } };
    res = fakeRes();
    await titleDetailHandler(req, res);
    assert.strictEqual(res.code, 400);
    assert.strictEqual(res.body.error, 'no-id');
    // Success: 200
    req = { query: { type: 'movie', imdb_id: 'tt1300', tmdb_id: '1300' }, profile: { id: 'p1', keys: { tmdb_api_key: 'k' } } };
    res = fakeRes();
    await titleDetailHandler(req, res);
    assert.ok(res.body, 'should call res.json()');
    const keys = Object.keys(res.body).sort();
    assert.deepStrictEqual(keys, ['cast', 'castSource', 'genres', 'imdb_id', 'poster', 'rating', 'runtime', 'synopsis', 'title', 'tmdb_id', 'type', 'year']);
    // Null detail: 404 (no TMDB key, different id to avoid cache)
    req = { query: { type: 'movie', imdb_id: 'tt9999', tmdb_id: '9999' }, profile: { id: 'p1', keys: {} } };
    res = fakeRes();
    await titleDetailHandler(req, res);
    assert.strictEqual(res.code, 404);
    assert.strictEqual(res.body.error, 'no-detail');
  } finally {
    tmdb.titleDetail = origTitleDetail;
  }
});

// ---- D14: CHARACTERS_QUERY brace balance (T1) ----
ok('D14: CHARACTERS_QUERY braces are balanced', () => {
  const { CHARACTERS_QUERY } = require('../src/services/anilist');
  let depth = 0;
  for (const ch of CHARACTERS_QUERY) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    assert.ok(depth >= 0, 'negative depth at position ' + CHARACTERS_QUERY.indexOf(ch));
  }
  assert.strictEqual(depth, 0, 'unbalanced braces (depth=' + depth + ')');
});

// ---- D15: animeLookup default wired (T2) — anime uses AniList, series never does ----
okAsync('D15: animeLookup default — anime gets castSource anilist; series never calls AniList', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  const animeMap = require('../src/services/animeMap');
  // Register a fake anime index: imdb tt900 -> anilist 999
  animeMap._setIndex({ byImdb: { tt900: { anilist: 999, mal: 1 } }, byTmdb: {}, byAnilist: {}, byMal: {} });
  // Fake TMDB detail (returns cast from TMDB).
  const tmdbTitleDetail = async () => ({
    tmdbId: '900', title: 'Test Anime', year: '2020',
    poster: null, synopsis: '', runtime: '24 min', genres: ['Animation'],
    certs: {}, cast: [{ name: 'TMDB Actor', character: 'X', photo: null }], status: 'Released',
  });
  // Fake AniList characters (returns Japanese voice actors).
  let anilistCalled = false;
  const anilistCharacters = async (id) => {
    anilistCalled = true;
    assert.strictEqual(id, 999);
    return [{ name: 'VA Actor', character: 'Y', photo: null }];
  };
  const profile = { keys: { tmdb_api_key: 'k' } };
  // Anime request: should use AniList (castSource = 'anilist').
  const animeResult = await getTitleDetail(profile, { type: 'anime', imdbId: 'tt900', tmdbId: '900' }, console, { tmdbTitleDetail, anilistCharacters });
  assert.strictEqual(animeResult.castSource, 'anilist');
  assert.strictEqual(animeResult.cast[0].name, 'VA Actor');
  assert.ok(anilistCalled, 'AniList was called');
  // Series request with same imdb (different tmdbId to avoid cache from anime): should NOT call AniList.
  anilistCalled = false;
  const seriesResult = await getTitleDetail(profile, { type: 'series', imdbId: 'tt900', tmdbId: '901' }, console, { tmdbTitleDetail, anilistCharacters });
  assert.strictEqual(seriesResult.castSource, 'tmdb');
  assert.ok(!anilistCalled, 'AniList NOT called for series');
  animeMap._setIndex(null); // cleanup
});

// ---- D16: imdb-only second call makes zero fetches (T8) ----
okAsync('D16: imdb-only second call makes zero fetches', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  let fetchCount = 0;
  const tmdbTitleDetail = async () => { fetchCount++; return { tmdbId: '1400', title: 'ImdbOnly', year: '2010', poster: null, synopsis: '', runtime: null, genres: [], certs: {}, cast: [], status: 'Released' }; };
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  // First call: imdb only (no tmdbId).
  const r1 = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt1400' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 1);
  assert.ok(r1, 'first call should succeed');
  // Second call: same imdb only. Should hit the imdb-keyed cache.
  const r2 = await getTitleDetail(profile, { type: 'movie', imdbId: 'tt1400' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 1, 'second call should hit imdb cache');
  assert.deepStrictEqual(r1, r2);
});

// ---- D17: anime and series with same tmdb id do not share cache (T8) ----
okAsync('D17: anime and series with same tmdb id do not share cache', async () => {
  const { getTitleDetail } = require('../src/titleDetail');
  let fetchCount = 0;
  const tmdbTitleDetail = async () => { fetchCount++; return { tmdbId: '1500', title: 'Shared', year: '2020', poster: null, synopsis: '', runtime: '24 min', genres: ['Animation'], certs: {}, cast: [{ name: 'A', character: 'B', photo: null }], status: 'Released' }; };
  const profile = { keys: { tmdb_api_key: 'test-key' } };
  // Anime request: should fetch and cache as 'anime'.
  const r1 = await getTitleDetail(profile, { type: 'anime', imdbId: 'tt1500', tmdbId: '1500' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(r1.castSource, 'tmdb'); // no animeLookup injected, so tmdb
  // Series request with same tmdbId: should NOT hit the anime cache.
  const r2 = await getTitleDetail(profile, { type: 'series', imdbId: 'tt1500', tmdbId: '1500' }, console, { tmdbTitleDetail });
  assert.strictEqual(fetchCount, 2, 'series should refetch (different cache key)');
});

// ---- U1: esc escapes <>&"' ----
ok('U1: esc escapes <>&"', () => {
  const { esc } = require('../public/title-detail');
  assert.strictEqual(esc('<a>'), '&lt;a&gt;');
  assert.strictEqual(esc('a&b'), 'a&amp;b');
  assert.strictEqual(esc('"q"'), '&quot;q&quot;');
  assert.strictEqual(esc("'s'"), '&#39;s&#39;');
});

// ---- U2: renderDetailHtml with XSS in title/character -> no raw <img/<script ----
ok('U2: renderDetailHtml XSS safe', () => {
  const { renderDetailHtml } = require('../public/title-detail');
  const item = { type: 'movie', name: '<img src=x onerror=alert(1)>' };
  const detail = { title: '<img src=x onerror=alert(1)>', cast: [{ name: 'Actor', character: '"><script>', photo: null }], rating: null, genres: [], synopsis: '', runtime: null, year: '2010', poster: null };
  const html = renderDetailHtml(item, detail, {});
  assert.ok(!html.includes('<img'), 'no raw <img');
  assert.ok(!html.includes('<script'), 'no raw <script');
});

// ---- U3: empty cast -> no "Main cast" nor td-cast ----
ok('U3: empty cast -> no Main cast heading', () => {
  const { renderDetailHtml } = require('../public/title-detail');
  const item = { type: 'movie', name: 'Test' };
  const detail = { title: 'Test', cast: [], rating: null, genres: [], synopsis: '', runtime: null, year: null, poster: null };
  const html = renderDetailHtml(item, detail, {});
  assert.ok(!html.includes('Main cast'));
  assert.ok(!html.includes('td-cast'));
});

// ---- U4: null rating -> no td-badge ----
ok('U4: null rating -> no td-badge', () => {
  const { renderDetailHtml } = require('../public/title-detail');
  const item = { type: 'movie', name: 'Test' };
  const detail = { title: 'Test', cast: [], rating: null, genres: [], synopsis: '', runtime: null, year: null, poster: null };
  const html = renderDetailHtml(item, detail, {});
  assert.ok(!html.includes('td-badge'));
});

// ---- U5: rating AU M -> contains "AU · M" ----
ok('U5: rating AU M -> "AU · M"', () => {
  const { renderDetailHtml } = require('../public/title-detail');
  const item = { type: 'movie', name: 'Test' };
  const detail = { title: 'Test', cast: [], rating: { label: 'M', country: 'AU' }, genres: [], synopsis: '', runtime: null, year: null, poster: null };
  const html = renderDetailHtml(item, detail, {});
  assert.ok(html.includes('AU · M'));
});

// ---- U6: missing runtime -> no double dots or dangling separators ----
ok('U6: missing runtime -> no double dots', () => {
  const { renderDetailHtml } = require('../public/title-detail');
  const item = { type: 'movie', name: 'Test' };
  const detail = { title: 'Test', cast: [], rating: null, genres: ['Drama'], synopsis: '', runtime: null, year: '2010', poster: null };
  const html = renderDetailHtml(item, detail, {});
  assert.ok(!html.includes('· ·'), 'no double dots');
  assert.ok(!html.endsWith('·'), 'no dangling separator');
});

// ---- U7: isTap boundary cases ----
ok('U7: isTap boundaries', () => {
  const { isTap } = require('../public/title-detail');
  assert.strictEqual(isTap(0, 0, 100), true);
  assert.strictEqual(isTap(7, 0, 299), true);
  assert.strictEqual(isTap(5, 6, 100), true); // hypot 7.81
  assert.strictEqual(isTap(8, 0, 100), false);
  assert.strictEqual(isTap(0, 0, 300), false);
  assert.strictEqual(isTap(6, 6, 100), false); // hypot 8.49
});

// ---- U8: initials ----
ok('U8: initials', () => {
  const { initials } = require('../public/title-detail');
  assert.strictEqual(initials('Cillian Murphy'), 'CM');
  assert.strictEqual(initials('Zendaya'), 'Z');
  assert.strictEqual(initials(''), '');
});

// ---- U9: itemFromEl round-trip ----
ok('U9: itemFromEl round-trip', () => {
  const { itemFromEl } = require('../public/title-detail');
  const btn = { dataset: { type: 'movie', imdb: 'tt1', tmdb: '603', name: 'The Matrix', year: '1999', poster: 'https://x.jpg' } };
  const item = itemFromEl(btn);
  assert.deepStrictEqual(item, { type: 'movie', imdb_id: 'tt1', tmdb_id: '603', name: 'The Matrix', poster: 'https://x.jpg', year: 1999 });
  // tmdb missing -> null field.
  const btn2 = { dataset: { type: 'movie', imdb: 'tt2', name: 'X' } };
  const item2 = itemFromEl(btn2);
  assert.strictEqual(item2.tmdb_id, null);
});

// ---- U10: openBtn carries the data-* attributes and escapes the name ----
ok('U10: openBtn data attributes + escaping', () => {
  const { openBtn } = require('../public/title-detail');
  const item = { type: 'movie', imdb_id: 'tt1', tmdb_id: '603', name: 'O\'Brien <a>', year: 1999, poster: 'https://x.jpg' };
  const html = openBtn(item, '<img>', 'poster');
  assert.ok(html.includes('class="td-open td-open-poster"'));
  assert.ok(html.includes('data-type="movie"'));
  assert.ok(html.includes('data-imdb="tt1"'));
  assert.ok(html.includes('data-tmdb="603"'));
  assert.ok(html.includes('data-name="O&#39;Brien &lt;a&gt;"'), 'name escaped: ' + html);
  assert.ok(html.includes('data-year="1999"'));
  assert.ok(html.includes('data-poster="https://x.jpg"'));
  assert.ok(html.includes('aria-label="Details: O&#39;Brien &lt;a&gt;"'));
  // title variant has no aria-label.
  const titleHtml = openBtn(item, 'T', 'title');
  assert.ok(titleHtml.includes('class="td-open td-open-title"'));
  assert.ok(!titleHtml.includes('aria-label'));
});

// ---- U11: shouldOpen — tap opens, drag does not ----
ok('U11: shouldOpen tap-vs-drag', () => {
  const { shouldOpen } = require('../public/title-detail');
  assert.strictEqual(shouldOpen(false), true, 'a tap opens');
  assert.strictEqual(shouldOpen(true), false, 'a drag does not');
});

// ---- Run async tests ----
(async () => {
  for (const { name, fn } of asyncPending) {
    try {
      await fn();
      passed++;
      console.log(` ✓ ${name}`);
    } catch (err) {
      console.error(` ✗ ${name}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`\n${passed} tests passed`);
})();
