// AN-2: personalised Marquee Anime — history → recommendations, with "because you watched X".
// Run: node --experimental-sqlite test/anime-personalised.js
// Browser checks: node --experimental-sqlite test/anime-personalised.js --browser
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an2-' + Date.now();
process.env.PORT = '7320';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const config = require('../src/config');
const decisionLog = require('../src/anime/decisionLog');
const settings = require('../src/settings');
const personalised = require('../src/engines/marqueeAnime/personalised');
const trending = require('../src/engines/marqueeAnime/trending');
const marqueeAnime = require('../src/engines/marqueeAnime');

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// Fake helpers.
function ladderEntry(tmdb, imdb, value, seedEligible, title) {
  return { row: { tmdb_id: tmdb, imdb_id: imdb, title, kind: 'anime' }, value, seedEligible };
}

function makeDeps({ ladder, animeMap, anilist, trending, listSize, tier, tvMeta, decisions, watchedIds, dontKeys, ignored, isAnimeRow }) {
  return {
    ladder: () => ladder,
    isAnimeRow: isAnimeRow || ((row) => row.kind === 'anime'),
    ignored: () => ignored || new Set(),
    watchedIds: () => watchedIds || { imdb: new Set(), tmdb: new Set() },
    dontKeys: () => dontKeys || new Set(),
    animeMap,
    anilist,
    trending,
    trendingDeps: undefined,
    tvMeta: tvMeta || (async () => new Map()),
    listSize: () => listSize || 5,
    tier: () => tier || null,
    decisions: decisions || null,
  };
}

function fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap }) {
  return {
    ensureLoaded: async () => {},
    lookup: (imdb, tmdb) => (lookupMap && lookupMap.get(`${imdb}:${tmdb}`)) || null,
    byAnilist: (id) => (byAnilistMap && byAnilistMap.get(id)) || null,
    byMal: (id) => (byMalMap && byMalMap.get(id)) || null,
  };
}

function fakeAnilist({ tagsFor, recommendationsFor, tagSearch }) {
  let tagsForCalls = 0;
  let recsForCalls = 0;
  let tagSearchCalls = 0;
  return {
    tagsFor: async (ids) => { tagsForCalls++; return tagsFor(ids); },
    recommendationsFor: async (ids) => { recsForCalls++; return recommendationsFor(ids); },
    tagSearch: async (opts) => { tagSearchCalls++; return tagSearch(opts); },
    tagsForCalls: () => tagsForCalls,
    recsForCalls: () => recsForCalls,
    tagSearchCalls: () => tagSearchCalls,
  };
}

function fakeTrending(candidates, rowsOut) {
  return {
    build: async (profile, ctx, deps) => {
      if (Array.isArray(ctx.decisionRowsOut)) {
        ctx.decisionRowsOut.push(...rowsOut);
      }
      return candidates;
    },
  };
}

(async () => {
  console.log('anime-personalised:');

  // ---- P1: score pure function ----
  await ok('P1: score — weighted sum', async () => {
    const s = personalised.score({ collabNorm: 0.5, tasteCos: 0.4, quality: 0.8, trend: 0 });
    const expected = 0.45 * 0.5 + 0.35 * 0.4 + 0.15 * 0.8;
    assert.ok(Math.abs(s - expected) < 1e-9, `score ${s} vs expected ${expected}`);
    // quality null → 0.6
    const s2 = personalised.score({ collabNorm: 0, tasteCos: 0, quality: 0.6, trend: 0 });
    assert.ok(Math.abs(s2 - 0.15 * 0.6) < 1e-9, 'quality 0.6');
  });

  // ---- P2: mode 0 — zero engaged → trending unchanged ----
  await ok('P2: mode 0 — zero engaged → trending.build called once, result unchanged', async () => {
    const trendingResult = [{ type: 'anime', tmdb_id: '100', imdb_id: 'tt100', title: 'T1' }];
    let trendingCalled = 0;
    const fakeT = {
      build: async (profile, ctx, deps) => {
        trendingCalled++;
        return trendingResult;
      },
    };
    const ladder = new Map();
    const deps = makeDeps({
      ladder,
      animeMap: fakeAnimeMap({}),
      anilist: fakeAnilist({ tagsFor: () => new Map(), recommendationsFor: () => new Map(), tagSearch: () => [] }),
      trending: fakeT,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P2', id: 'P2' }, ctx, deps);
    assert.strictEqual(trendingCalled, 1, 'trending.build called once');
    assert.strictEqual(result, trendingResult, 'result unchanged (same array reference)');
    assert.strictEqual(ctx.animeMode, 'trending');
    assert.strictEqual(ctx.animeEngaged, 0);
  });

  // ---- P3: mode mixed — 2 engaged → interleaved P,P,T,T,T ----
  await ok('P3: mode mixed — 2 engaged → P,P,T,T,T pattern', async () => {
    // 2 engaged seeds, 3 personalised candidates, 5 trending candidates
    const ladder = new Map([
      ['s1', ladderEntry('10', 'tt10', 3, true, 'Seed1')],
      ['s2', ladderEntry('11', 'tt11', 1, true, 'Seed2')],
      ['s3', ladderEntry('12', 'tt12', 0.5, false, 'NotEngaged')],
    ]);
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
      ['tt11:11', { anilist: 200, mal: 2 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
      [400, { tv: '400', imdb: 'tt400', type: 'TV' }],
      [500, { tv: '500', imdb: 'tt500', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map([[100, { isAdult: false, genres: ['Action'], tags: [{ name: 'Adventure', rank: 80 }] }]]),
      recommendationsFor: () => new Map([
        [100, [{ id: 300, idMal: 10, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
        [200, [{ id: 400, idMal: 20, format: 'TV', genres: ['Comedy'], averageScore: 70, popularity: 50, year: 2021, title: 'Rec2', rating: 50, isAdult: false }]],
      ]),
      tagSearch: () => [{ id: 500, idMal: 30, format: 'TV', genres: ['Comedy'], averageScore: 75, popularity: 60, year: 2022, title: 'Tag1' }],
    });
    const trendingCands = [
      { type: 'anime', tmdb_id: '600', imdb_id: 'tt600', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '601', imdb_id: 'tt601', title: 'Trend2', rankScore: 0.8, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '602', imdb_id: 'tt602', title: 'Trend3', rankScore: 0.7, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '603', imdb_id: 'tt603', title: 'Trend4', rankScore: 0.6, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '604', imdb_id: 'tt604', title: 'Trend5', rankScore: 0.5, reason: 'Trending anime' },
    ];
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending(trendingCands, []),
      listSize: 5,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P3', id: 'P3' }, ctx, deps);
    assert.strictEqual(ctx.animeMode, 'mixed');
    assert.strictEqual(ctx.animeEngaged, 2);
    // P,P,T,T,T pattern: first 5 should be P,P,T,T,T
    const ids = result.slice(0, 5).map((c) => c.tmdb_id);
    // Personalised: 300, 400, 500 (from recs + tag search)
    // Trending: 600, 601, 602, 603, 604
    // With 2 engaged: P,P,T,T,T,P,P,T,T,T...
    assert.strictEqual(ids[0], '300', 'first is personalised');
    assert.strictEqual(ids[1], '400', 'second is personalised');
    assert.strictEqual(ids[2], '600', 'third is trending');
    assert.strictEqual(ids[3], '601', 'fourth is trending');
    assert.strictEqual(ids[4], '602', 'fifth is trending');
  });

  // ---- P4: mode personalised — 5 engaged → all personalised first ----
  await ok('P4: mode personalised — 5 engaged → all personalised first, trending fills', async () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(ladderEntry(String(10 + i), `tt${10 + i}`, 5 - i, true, `Seed${i}`));
    }
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map();
    const byAnilistMap = new Map();
    for (let i = 0; i < 5; i++) {
      lookupMap.set(`tt${10 + i}:${10 + i}`, { anilist: 100 + i * 10, mal: 1 + i });
    }
    // 3 personalised candidates
    byAnilistMap.set(200, { tv: '200', imdb: 'tt200', type: 'TV' });
    byAnilistMap.set(300, { tv: '300', imdb: 'tt300', type: 'TV' });
    byAnilistMap.set(400, { tv: '400', imdb: 'tt400', type: 'TV' });
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        [100, [{ id: 200, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
        [110, [{ id: 300, idMal: 2, format: 'TV', genres: ['Comedy'], averageScore: 70, popularity: 50, year: 2021, title: 'Rec2', rating: 50, isAdult: false }]],
        [120, [{ id: 400, idMal: 3, format: 'TV', genres: ['Drama'], averageScore: 60, popularity: 30, year: 2022, title: 'Rec3', rating: 30, isAdult: false }]],
      ]),
      tagSearch: () => [],
    });
    const trendingCands = [
      { type: 'anime', tmdb_id: '500', imdb_id: 'tt500', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '501', imdb_id: 'tt501', title: 'Trend2', rankScore: 0.8, reason: 'Trending anime' },
    ];
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending(trendingCands, []),
      listSize: 5,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P4', id: 'P4' }, ctx, deps);
    assert.strictEqual(ctx.animeMode, 'personalised');
    assert.strictEqual(ctx.animeEngaged, 5);
    // All personalised first (3), then trending fills to T=20
    // But we only have 3 personalised + 2 trending = 5 total
    assert.ok(result.length >= 3, 'at least 3 personalised');
    const firstThree = result.slice(0, 3).map((c) => c.tmdb_id);
    assert.ok(firstThree.includes('200'), 'first three include 200');
    assert.ok(firstThree.includes('300'), 'first three include 300');
    assert.ok(firstThree.includes('400'), 'first three include 400');
  });

  // ---- P5: ordering/rank — rankScore strictly decreasing ----
  await ok('P5: rankScore strictly decreasing and in (0,1)', async () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(ladderEntry(String(10 + i), `tt${10 + i}`, 5 - i, true, `Seed${i}`));
    }
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map();
    const byAnilistMap = new Map();
    for (let i = 0; i < 5; i++) {
      lookupMap.set(`tt${10 + i}:${10 + i}`, { anilist: 100 + i * 10, mal: 1 + i });
    }
    byAnilistMap.set(200, { tv: '200', imdb: 'tt200', type: 'TV' });
    byAnilistMap.set(300, { tv: '300', imdb: 'tt300', type: 'TV' });
    byAnilistMap.set(400, { tv: '400', imdb: 'tt400', type: 'TV' });
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        [100, [{ id: 200, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
        [110, [{ id: 300, idMal: 2, format: 'TV', genres: ['Comedy'], averageScore: 70, popularity: 50, year: 2021, title: 'Rec2', rating: 50, isAdult: false }]],
        [120, [{ id: 400, idMal: 3, format: 'TV', genres: ['Drama'], averageScore: 60, popularity: 30, year: 2022, title: 'Rec3', rating: 30, isAdult: false }]],
      ]),
      tagSearch: () => [],
    });
    const trendingCands = [
      { type: 'anime', tmdb_id: '500', imdb_id: 'tt500', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
    ];
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending(trendingCands, []),
      listSize: 5,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P5', id: 'P5' }, ctx, deps);
    for (let i = 0; i < result.length; i++) {
      assert.ok(result[i].rankScore > 0, `rankScore[${i}] > 0`);
      assert.ok(result[i].rankScore <= 1, `rankScore[${i}] <= 1`);
      if (i > 0) {
        assert.ok(result[i - 1].rankScore > result[i].rankScore, `rankScore[${i-1}] > rankScore[${i}]`);
      }
    }
  });

  // ---- P6: reasons — personalised items have "because you watched X" ----
  await ok('P6: reasons — personalised items have because you watched', async () => {
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Cowboy Bebop'),
      ladderEntry('11', 'tt11', 1, true, 'Mushoku'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
      ['tt11:11', { anilist: 200, mal: 2 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        [100, [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
      ]),
      tagSearch: () => [],
    });
    const trendingCands = [
      { type: 'anime', tmdb_id: '500', imdb_id: 'tt500', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
    ];
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending(trendingCands, []),
      listSize: 5,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P6', id: 'P6' }, ctx, deps);
    const rec1 = result.find((c) => c.tmdb_id === '300');
    assert.ok(rec1, 'Rec1 present');
    assert.strictEqual(rec1.reason, 'because you watched Cowboy Bebop', 'reason is because you watched Cowboy Bebop');
    const trend1 = result.find((c) => c.tmdb_id === '500');
    if (trend1) {
      assert.strictEqual(trend1.reason, 'Trending anime', 'trending keeps its reason');
    }
  });

  // ---- P7: collaborative weight ----
  await ok('P7: collaborative weight — two seeds, same candidate', async () => {
    // Seed1 (value 3) recommends candidate A with votes 100/50 (max=100)
    // Seed2 (value 1) recommends candidate A with votes 200/200 (max=200)
    // collab[A] = 3*(100/100) + 1*(200/200) = 3 + 1 = 4
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      ladderEntry('11', 'tt11', 1, true, 'Seed2'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
      ['tt11:11', { anilist: 200, mal: 2 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
      [400, { tv: '400', imdb: 'tt400', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        // Seed1 (anilist 100): rec A (id 300) with rating 100, rec B (id 400) with rating 50
        [100, [
          { id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'RecA', rating: 100, isAdult: false },
          { id: 400, idMal: 2, format: 'TV', genres: ['Comedy'], averageScore: 70, popularity: 50, year: 2021, title: 'RecB', rating: 50, isAdult: false },
        ]],
        // Seed2 (anilist 200): rec A (id 300) with rating 200
        [200, [
          { id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'RecA', rating: 200, isAdult: false },
        ]],
      ]),
      tagSearch: () => [],
    });
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending([], []),
      listSize: 5,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P7', id: 'P7' }, ctx, deps);
    // Candidate 300 (RecA) should rank first (collab = 4)
    // Candidate 400 (RecB) should rank second (collab = 3*(50/100) = 1.5)
    assert.ok(result.length >= 2, 'at least 2 candidates');
    assert.strictEqual(result[0].tmdb_id, '300', 'RecA ranks first');
    assert.strictEqual(result[1].tmdb_id, '400', 'RecB ranks second');
  });

  // ---- P8: roll-up drops ----
  await ok('P8: roll-up drops — all drop conditions', async () => {
    // Set up a candidate that hits each drop condition
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      // History: tmdb 200 is in history
      ladderEntry('200', 'tt200', 0.5, false, 'InHistory'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
    ]);
    const byAnilistMap = new Map([
      // no-tt: no show for id 300
      // format: id 400 is MOVIE
      [400, { tv: '400', imdb: 'tt400', type: 'MOVIE' }],
      // franchise: id 500 maps to tv 200 (in history)
      [500, { tv: '200', imdb: 'tt200', type: 'TV' }],
      // watched: id 600 maps to tv 600 (in watchedIds)
      [600, { tv: '600', imdb: 'tt600', type: 'TV' }],
      // dontKeys series: id 700 maps to tv 700
      [700, { tv: '700', imdb: 'tt700', type: 'TV' }],
      // dontKeys anime: id 800 maps to tv 800
      [800, { tv: '800', imdb: 'tt800', type: 'TV' }],
      // ignored: id 900 maps to tv 900
      [900, { tv: '900', imdb: 'tt900', type: 'TV' }],
      // no imdb: id 1000 has no imdb
      [1000, { tv: '1000', imdb: null, type: 'TV' }],
      // valid: id 1100
      [1100, { tv: '1100', imdb: 'tt1100', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        [100, [
          { id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'NoTT', rating: 100, isAdult: false },
          { id: 400, idMal: 2, format: 'MOVIE', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Movie', rating: 100, isAdult: false },
          { id: 500, idMal: 3, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Franchise', rating: 100, isAdult: false },
          { id: 600, idMal: 4, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Watched', rating: 100, isAdult: false },
          { id: 700, idMal: 5, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'DontSeries', rating: 100, isAdult: false },
          { id: 800, idMal: 6, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'DontAnime', rating: 100, isAdult: false },
          { id: 900, idMal: 7, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Ignored', rating: 100, isAdult: false },
          { id: 1000, idMal: 8, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'NoImdb', rating: 100, isAdult: false },
          { id: 1100, idMal: 9, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Valid', rating: 100, isAdult: false },
        ]],
      ]),
      tagSearch: () => [],
    });
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending([], []),
      listSize: 5,
      watchedIds: { imdb: new Set(), tmdb: new Set(['600']) },
      dontKeys: new Set(['series:700', 'anime:800']),
      ignored: new Set(['900']),
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P8', id: 'P8' }, ctx, deps);
    // Only 1100 should survive
    assert.strictEqual(result.length, 1, 'only valid candidate survives');
    assert.strictEqual(result[0].tmdb_id, '1100', 'valid candidate');
  });

  // ---- P9: de-dupe ----
  await ok('P9: de-dupe — same title from two seeds and tag search', async () => {
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      ladderEntry('11', 'tt11', 1, true, 'Seed2'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
      ['tt11:11', { anilist: 200, mal: 2 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        // Seed1 recommends 300
        [100, [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Shared', rating: 100, isAdult: false }]],
        // Seed2 also recommends 300
        [200, [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Shared', rating: 50, isAdult: false }]],
      ]),
      tagSearch: () => [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Shared' }],
    });
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending([], []),
      listSize: 5,
    });
    const ctx = { log: console };
    const result = await personalised.build({ name: 'P9', id: 'P9' }, ctx, deps);
    // 300 should appear exactly once
    const count = result.filter((c) => c.tmdb_id === '300').length;
    assert.strictEqual(count, 1, '300 appears once');
  });

  // ---- P10: source failures ----
  await ok('P10: source failures — recs throw, tagsFor throws, all fail', async () => {
    // (a) recommendationsFor throws → still returns from tag search + trending
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      ladderEntry('11', 'tt11', 1, true, 'Seed2'),
      ladderEntry('12', 'tt12', 1, true, 'Seed3'),
      ladderEntry('13', 'tt13', 1, true, 'Seed4'),
      ladderEntry('14', 'tt14', 1, true, 'Seed5'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const warns = [];
    const log = { log: (m) => {}, warn: (m) => warns.push(m) };
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => { const e = new Error('recs failed'); e.status = 429; throw e; },
      tagSearch: () => [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Tag1' }],
    });
    const trendingCands = [
      { type: 'anime', tmdb_id: '500', imdb_id: 'tt500', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
    ];
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending(trendingCands, []),
      listSize: 5,
    });
    const ctx = { log };
    const result = await personalised.build({ name: 'P10a', id: 'P10a' }, ctx, deps);
    assert.ok(result.length >= 1, 'candidates from tag search + trending');
    assert.ok(warns.some((w) => w.includes('recs unavailable')), 'recs unavailable warn');

    // (b) tagsFor throws → still returns, taste term 0
    const warns2 = [];
    const log2 = { log: (m) => {}, warn: (m) => warns2.push(m) };
    const anilist2 = fakeAnilist({
      tagsFor: () => { const e = new Error('tagsFor failed'); e.status = 429; throw e; },
      recommendationsFor: () => new Map([
        [100, [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
      ]),
      tagSearch: () => [],
    });
    const deps2 = makeDeps({
      ladder,
      animeMap,
      anilist: anilist2,
      trending: fakeTrending([], []),
      listSize: 5,
    });
    const ctx2 = { log: log2 };
    const result2 = await personalised.build({ name: 'P10b', id: 'P10b' }, ctx2, deps2);
    assert.ok(result2.length >= 1, 'candidates still returned');
    assert.ok(warns2.some((w) => w.includes('tagsFor unavailable')), 'tagsFor unavailable warn');

    // (c) all personalised sources fail → returns trending list, mode = trending
    const warns3 = [];
    const log3 = { log: (m) => {}, warn: (m) => warns3.push(m) };
    const anilist3 = fakeAnilist({
      tagsFor: () => { const e = new Error('tagsFor failed'); e.status = 429; throw e; },
      recommendationsFor: () => { const e = new Error('recs failed'); e.status = 429; throw e; },
      tagSearch: () => { const e = new Error('tagSearch failed'); e.status = 429; throw e; },
    });
    const trendingCands3 = [
      { type: 'anime', tmdb_id: '500', imdb_id: 'tt500', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '501', imdb_id: 'tt501', title: 'Trend2', rankScore: 0.8, reason: 'Trending anime' },
    ];
    const deps3 = makeDeps({
      ladder,
      animeMap,
      anilist: anilist3,
      trending: fakeTrending(trendingCands3, []),
      listSize: 5,
    });
    const ctx3 = { log: log3 };
    const result3 = await personalised.build({ name: 'P10c', id: 'P10c' }, ctx3, deps3);
    assert.strictEqual(ctx3.animeMode, 'trending', 'mode is trending');
    assert.strictEqual(ctx3.animeEngaged, 5, 'engaged count preserved');
    assert.strictEqual(result3.length, 2, 'trending list returned');
  });

  // ---- P11: scoring set cap ----
  await ok('P11: scoring set cap — 300 candidates → tagsFor called with at most 200 ids', async () => {
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      ladderEntry('11', 'tt11', 1, true, 'Seed2'),
      ladderEntry('12', 'tt12', 1, true, 'Seed3'),
      ladderEntry('13', 'tt13', 1, true, 'Seed4'),
      ladderEntry('14', 'tt14', 1, true, 'Seed5'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
    ]);
    const byAnilistMap = new Map();
    for (let i = 0; i < 300; i++) {
      byAnilistMap.set(1000 + i, { tv: String(1000 + i), imdb: `tt${1000 + i}`, type: 'TV' });
    }
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    let lastTagsForIds = null;
    const anilist = fakeAnilist({
      tagsFor: (ids) => { lastTagsForIds = ids; return new Map(); },
      recommendationsFor: () => {
        const recs = [];
        for (let i = 0; i < 300; i++) {
          recs.push({ id: 1000 + i, idMal: i + 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: `Rec${i}`, rating: 100, isAdult: false });
        }
        return new Map([[100, recs]]);
      },
      tagSearch: () => [],
    });
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending([], []),
      listSize: 5,
    });
    const ctx = { log: console };
    await personalised.build({ name: 'P11', id: 'P11' }, ctx, deps);
    // tagsFor is called twice: once for seeds, once for candidates
    // The candidate call should have at most 200 ids
    assert.ok(lastTagsForIds !== null, 'tagsFor called');
    assert.ok(lastTagsForIds.length <= 200, `tagsFor called with ${lastTagsForIds.length} ids (<= 200)`);
  });

  // ---- P12: safe tag search ----
  await ok('P12: safe tag search — tier csmMaxAge <= 12 → safe: true', async () => {
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      ladderEntry('11', 'tt11', 1, true, 'Seed2'),
      ladderEntry('12', 'tt12', 1, true, 'Seed3'),
      ladderEntry('13', 'tt13', 1, true, 'Seed4'),
      ladderEntry('14', 'tt14', 1, true, 'Seed5'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    let tagSearchOpts = null;
    const anilist = fakeAnilist({
      tagsFor: () => new Map([[100, { isAdult: false, genres: ['Action'], tags: [{ name: 'Adventure', rank: 80 }] }]]),
      recommendationsFor: () => new Map([
        [100, [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
      ]),
      tagSearch: (opts) => { tagSearchOpts = opts; return []; },
    });
    // Kid profile (csmMaxAge 12)
    const depsKid = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending([], []),
      listSize: 5,
      tier: { csmMaxAge: 12, label: 'TV-12' },
    });
    const ctxKid = { log: console };
    await personalised.build({ name: 'P12a', id: 'P12a' }, ctxKid, depsKid);
    assert.ok(tagSearchOpts, 'tagSearch called');
    assert.strictEqual(tagSearchOpts.safe, true, 'safe is true for kid profile');

    // Adult profile (no tier)
    tagSearchOpts = null;
    const depsAdult = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending([], []),
      listSize: 5,
      tier: null,
    });
    const ctxAdult = { log: console };
    await personalised.build({ name: 'P12b', id: 'P12b' }, ctxAdult, depsAdult);
    assert.ok(tagSearchOpts, 'tagSearch called');
    assert.strictEqual(tagSearchOpts.safe, false, 'safe is false for adult profile');
  });

  // ---- P13: one build — decision log ----
  await ok('P13: one build — decision log with meta', async () => {
    const p = config.addProfile('AN2-P13');
    config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
    const entries = [
      ladderEntry('10', 'tt10', 3, true, 'Seed1'),
      ladderEntry('11', 'tt11', 1, true, 'Seed2'),
    ];
    const ladder = new Map(entries.map((e) => [e.row.tmdb_id, e]));
    const lookupMap = new Map([
      ['tt10:10', { anilist: 100, mal: 1 }],
      ['tt11:11', { anilist: 200, mal: 2 }],
    ]);
    const byAnilistMap = new Map([
      [300, { tv: '300', imdb: 'tt300', type: 'TV' }],
      [400, { tv: '400', imdb: 'tt400', type: 'TV' }],
    ]);
    const animeMap = fakeAnimeMap({ lookupMap, byAnilistMap, byMalMap: new Map() });
    const anilist = fakeAnilist({
      tagsFor: () => new Map(),
      recommendationsFor: () => new Map([
        [100, [{ id: 300, idMal: 1, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, year: 2020, title: 'Rec1', rating: 100, isAdult: false }]],
        [200, [{ id: 400, idMal: 2, format: 'TV', genres: ['Comedy'], averageScore: 70, popularity: 50, year: 2021, title: 'Rec2', rating: 50, isAdult: false }]],
      ]),
      tagSearch: () => [],
    });
    const trendingCands = [
      { type: 'anime', tmdb_id: '500', imdb_id: 'tt500', title: 'Trend1', rankScore: 0.9, reason: 'Trending anime' },
      { type: 'anime', tmdb_id: '501', imdb_id: 'tt501', title: 'Trend2', rankScore: 0.8, reason: 'Trending anime' },
    ];
    const deps = makeDeps({
      ladder,
      animeMap,
      anilist,
      trending: fakeTrending(trendingCands, []),
      listSize: 5,
      decisions: decisionLog,
    });
    const ctx = { log: console };
    await personalised.build({ name: 'P13', id: p.id }, ctx, deps);
    const builds = decisionLog.builds(p.id, 'anime');
    assert.strictEqual(builds.length, 1, 'exactly one build');
    const meta = decisionLog.getMeta(p.id, 'anime', builds[0].build_id);
    assert.deepStrictEqual(meta, { mode: 'mixed', engaged: 2 }, 'meta is mixed/2');
    // Check selected rows
    const { rows } = decisionLog.list(p.id, 'anime', { build: builds[0].build_id });
    const selected = rows.filter((r) => r.outcome === 'selected');
    assert.ok(selected.length >= 2, 'selected rows exist');
    const rec1 = selected.find((r) => r.item_key === '300');
    assert.ok(rec1, 'Rec1 selected');
    assert.strictEqual(rec1.because, 'Seed1', 'because is Seed1');
    config.removeProfile(p.id);
  });

  // ---- P14: trending build meta ----
  await ok('P14: trending build meta — engaged-0 path records meta', async () => {
    const p = config.addProfile('AN2-P14');
    config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
    // Use the real trending.build with fake deps (like T5 in anime-trending.js)
    const simklItems = Array.from({ length: 10 }, (_, i) => ({
      mal: i + 1, tmdb_id: String(1000 + i), imdb_id: `tt${1000 + i}`, title: `Show ${i}`, year: 2020, ratings: { mal: { rating: 7, votes: 10 } }, rank: i,
    }));
    const realTrending = require('../src/engines/marqueeAnime/trending');
    const trendingDeps = {
      simklList: () => simklItems,
      anilistList: () => [],
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => ({ tv: String(1000 + (id - 1)), imdb: `tt${1000 + (id - 1)}`, type: 'TV' }),
        byAnilist: () => null,
      },
      listSize: () => 5,
      tier: () => null,
      tvMeta: async () => new Map(),
      decisions: decisionLog,
    };
    const ctx = { log: console };
    await realTrending.build({ name: 'P14', id: p.id }, ctx, trendingDeps);
    const builds = decisionLog.builds(p.id, 'anime');
    assert.strictEqual(builds.length, 1, 'one build');
    const meta = decisionLog.getMeta(p.id, 'anime', builds[0].build_id);
    assert.deepStrictEqual(meta, { mode: 'trending', engaged: 0 }, 'meta is trending/0');
    config.removeProfile(p.id);
  });

  // ---- P15: no regression — trending.build without decisionRowsOut ----
  await ok('P15: no regression — trending.build without decisionRowsOut writes its own rows', async () => {
    const p = config.addProfile('AN2-P15');
    config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
    const simklItems = Array.from({ length: 10 }, (_, i) => ({
      mal: i + 1, tmdb_id: String(1000 + i), imdb_id: `tt${1000 + i}`, title: `Show ${i}`, year: 2020, ratings: { mal: { rating: 7, votes: 10 } }, rank: i,
    }));
    const realTrending = require('../src/engines/marqueeAnime/trending');
    const trendingDeps = {
      simklList: () => simklItems,
      anilistList: () => [],
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => ({ tv: String(1000 + (id - 1)), imdb: `tt${1000 + (id - 1)}`, type: 'TV' }),
        byAnilist: () => null,
      },
      listSize: () => 5,
      tier: () => null,
      tvMeta: async () => new Map(),
      decisions: decisionLog,
    };
    const ctx = { log: console };
    await realTrending.build({ name: 'P15', id: p.id }, ctx, trendingDeps);
    // Without decisionRowsOut, trending writes its own rows
    const builds = decisionLog.builds(p.id, 'anime');
    assert.strictEqual(builds.length, 1, 'one build');
    const { rows } = decisionLog.list(p.id, 'anime', { build: builds[0].build_id });
    assert.ok(rows.length > 0, 'rows written');
    assert.ok(rows.some((r) => r.outcome === 'selected'), 'selected rows');
    config.removeProfile(p.id);
  });

  // ---- P16: meta pruning ----
  await ok('P16: meta pruning — 5 builds → 3 newest with meta remain', async () => {
    const p = config.addProfile('AN2-P16');
    config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
    // Record 5 builds with meta
    for (let i = 0; i < 5; i++) {
      const bid = decisionLog.newBuildId();
      decisionLog.record(p.id, 'anime', bid, [
        { item_key: `item${i}`, stage: 'engine', outcome: 'selected', title: `Item ${i}` },
      ]);
      decisionLog.recordMeta(p.id, 'anime', bid, { mode: 'trending', engaged: 0 });
    }
    const buildsBefore = decisionLog.builds(p.id, 'anime');
    assert.strictEqual(buildsBefore.length, 5, '5 builds before prune');
    decisionLog.prune(p.id, 'anime');
    const buildsAfter = decisionLog.builds(p.id, 'anime');
    assert.strictEqual(buildsAfter.length, 3, '3 builds after prune');
    // Meta rows for the pruned builds should be gone
    for (const b of buildsAfter) {
      const meta = decisionLog.getMeta(p.id, 'anime', b.build_id);
      assert.ok(meta, `meta exists for build ${b.build_id}`);
    }
    // Bad mode → recordMeta throws
    try {
      decisionLog.recordMeta(p.id, 'anime', decisionLog.newBuildId(), { mode: 'invalid', engaged: 0 });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('mode must be one of'), 'error message');
    }
    config.removeProfile(p.id);
  });

  // ---- P17: API — report route returns mode and engaged ----
  await ok('P17: API — report route returns mode and engaged', async () => {
    require('../src/server');
    const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
    const { token } = provisionAdmin();
    const restore = attachCookie(BASE, cookieHeader(token));
    await new Promise((r) => setTimeout(r, 200));

    async function get(path) {
      const res = await fetch(BASE + path);
      return { status: res.status, body: await res.json() };
    }

    // Profile with a build that has meta
    const p1 = config.addProfile('AN2-P17a');
    config.updateProfile(p1.id, { filters: { engine_anime: 'marquee-anime' } });
    const bid1 = decisionLog.newBuildId();
    decisionLog.record(p1.id, 'anime', bid1, [
      { item_key: 'A', stage: 'engine', outcome: 'selected', title: 'Alpha' },
    ]);
    decisionLog.recordMeta(p1.id, 'anime', bid1, { mode: 'mixed', engaged: 2 });

    // Profile with a build without meta
    const p2 = config.addProfile('AN2-P17b');
    config.updateProfile(p2.id, { filters: { engine_anime: 'marquee-anime' } });
    const bid2 = decisionLog.newBuildId();
    decisionLog.record(p2.id, 'anime', bid2, [
      { item_key: 'B', stage: 'engine', outcome: 'selected', title: 'Beta' },
    ]);

    const r1 = await get(`/api/profiles/${p1.id}/anime/decisions`);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.mode, 'mixed', 'mode is mixed');
    assert.strictEqual(r1.body.engaged, 2, 'engaged is 2');

    const r2 = await get(`/api/profiles/${p2.id}/anime/decisions`);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body.mode, 'trending', 'mode is trending (no meta)');
    assert.strictEqual(r2.body.engaged, 0, 'engaged is 0 (no meta)');

    config.removeProfile(p1.id);
    config.removeProfile(p2.id);
    restore();
  });

  // ---- P18: engine wiring ----
  await ok('P18: marqueeAnime.generate calls personalised.build', async () => {
    const fakeResult = [{ type: 'anime', tmdb_id: '100', imdb_id: 'tt100', title: 'Test' }];
    const realBuild = personalised.build;
    personalised.build = async (profile, ctx) => fakeResult;
    try {
      const result = await marqueeAnime.generate({ name: 'P18', id: 'P18' }, 'anime', { log: console });
      assert.strictEqual(result, fakeResult, 'returns personalised.build result');
    } finally {
      personalised.build = realBuild;
    }
    assert.strictEqual(marqueeAnime.ALGORITHM_VERSION, 'marquee-anime-a2', 'algorithm version');
  });

  // ---- Browser PB1-PB2 (only with --browser) ----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const screenshotDir = require('path').join(process.env.DATA_DIR, 'screenshots');
    if (!require('fs').existsSync(screenshotDir)) require('fs').mkdirSync(screenshotDir);
    const pageErrors = [];
    const adminCookie = { name: 'air_sid', value: token, url: BASE };

    settings.updateSettings({ keys: { tmdb_api_key: 'x'.repeat(32) }, llm: { groq_api_key: 'gsk_test' } });

    async function openAdvanced(page, profileId) {
      await page.goto(`${BASE}/configure/`);
      await page.waitForSelector('#userSelect');
      await page.selectOption('#userSelect', profileId);
      await page.waitForSelector('.card[data-id]');
      await page.locator('.tab-btn[data-tab="advanced"]').click();
    }

    // PB1: seed three builds with different meta
    await ok('PB1: header shows Trending / Mixed (2 of 5 engaged) / Personalised (13 engaged)', async () => {
      // Profile 1: trending/0
      const p1 = config.addProfile('AN2-PB1-trending');
      config.updateProfile(p1.id, { filters: { engine_anime: 'marquee-anime' } });
      const bid1 = decisionLog.newBuildId();
      decisionLog.record(p1.id, 'anime', bid1, [{ item_key: 'A', stage: 'engine', outcome: 'selected', title: 'Alpha' }]);
      decisionLog.recordMeta(p1.id, 'anime', bid1, { mode: 'trending', engaged: 0 });

      // Profile 2: mixed/2
      const p2 = config.addProfile('AN2-PB1-mixed');
      config.updateProfile(p2.id, { filters: { engine_anime: 'marquee-anime' } });
      const bid2 = decisionLog.newBuildId();
      decisionLog.record(p2.id, 'anime', bid2, [{ item_key: 'B', stage: 'engine', outcome: 'selected', title: 'Beta' }]);
      decisionLog.recordMeta(p2.id, 'anime', bid2, { mode: 'mixed', engaged: 2 });

      // Profile 3: personalised/13
      const p3 = config.addProfile('AN2-PB1-personalised');
      config.updateProfile(p3.id, { filters: { engine_anime: 'marquee-anime' } });
      const bid3 = decisionLog.newBuildId();
      decisionLog.record(p3.id, 'anime', bid3, [{ item_key: 'C', stage: 'engine', outcome: 'selected', title: 'Charlie' }]);
      decisionLog.recordMeta(p3.id, 'anime', bid3, { mode: 'personalised', engaged: 13 });

      // Check each profile's header
      for (const [p, expected] of [[p1, 'Trending'], [p2, 'Mixed (2 of 5 engaged)'], [p3, 'Personalised (13 engaged)']]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
        await context.addCookies([adminCookie]);
        const page = await context.newPage();
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await openAdvanced(page, p.id);
        await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
        const head = await page.locator('.ab-panel .ab-head').innerText();
        assert.ok(head.includes(expected), `header contains ${expected}: ${head}`);
        if (expected === 'Personalised (13 engaged)') {
          await page.locator('.sec-box:has(.ab-panel)').first().screenshot({ path: require('path').join(screenshotDir, 'anime-personalised-pb1.png') });
        }
        await context.close();
      }
      config.removeProfile(p1.id);
      config.removeProfile(p2.id);
      config.removeProfile(p3.id);
    });

    // PB2: because text visible on a personalised row
    await ok('PB2: because text visible on a personalised row', async () => {
      const p = config.addProfile('AN2-PB2');
      config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
      const bid = decisionLog.newBuildId();
      decisionLog.record(p.id, 'anime', bid, [
        { item_key: 'C', stage: 'engine', outcome: 'selected', title: 'Cowboy Bebop', because: 'Cowboy Bebop', reason: 'because you watched Cowboy Bebop' },
      ]);
      decisionLog.recordMeta(p.id, 'anime', bid, { mode: 'personalised', engaged: 5 });

      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, p.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      const rowText = await page.locator('.ab-panel .tr-table .tr-row').first().innerText();
      assert.ok(rowText.includes('because: Cowboy Bebop'), `row shows because: ${rowText}`);
      await context.close();
      config.removeProfile(p.id);
    });

    await ok('PB3: no page errors', async () => {
      assert.deepStrictEqual(pageErrors, [], 'no page errors');
    });

    await browser.close();
  }

  console.log(`\nAll personalised anime checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
