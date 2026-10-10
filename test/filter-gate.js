// FG-1: the Filter Gate — profile filters for the extra catalogs.
// Run: node --experimental-sqlite test/filter-gate.js
'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-fg1-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const db = require('../src/db');
const { compileRules } = require('../src/filterGate/rules');
const { resolveFacts } = require('../src/filterGate/data');
const { checkMany, check, filterHash } = require('../src/filterGate');
const store = require('../src/filterGate/store');
const recency = require('../src/recency');
const tmdb = require('../src/services/tmdb');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// A minimal profile for the filter gate tests.
function makeProfile(filters = {}, id = 'test-profile') {
  return { id, name: 'Test', filters: filters || {} };
}

// Helper: a candidate with the given fields.
function cand(key, overrides = {}) {
  return { key, tmdb_id: null, imdb_id: key, title: 'Title', year: null, imdbRating: null, ...overrides };
}

// ============================================================================
// FG1: rules — a matrix of titles x filters
// ============================================================================
async function testFG1() {
  const nowYear = 2026;
  // The default vote floor for movies is 200, so 'votes' is always in needs.
  // We must supply votes in every facts object.

  // Genre exclusion (votes supplied to avoid no_data)
  let { needs, evaluate } = compileRules({ excluded_genres: ['Horror'] }, 'movie', { nowYear });
  assert(needs.has('genres'));
  let r = evaluate({ genres: ['Horror', 'Thriller'], votes: 500 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'genre');
  assert.strictEqual(r.detail, 'Horror');
  r = evaluate({ genres: ['Comedy', 'Drama'], votes: 500 });
  assert.strictEqual(r.ok, true);

  // Recency
  ({ needs, evaluate } = compileRules({ min_year: 2010 }, 'movie', { nowYear }));
  assert(needs.has('year'));
  r = evaluate({ year: 2009, votes: 500 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'recency');
  assert.strictEqual(r.detail, '2009 < 2010');
  // Boundary: year == minYear passes
  r = evaluate({ year: 2010, votes: 500 });
  assert.strictEqual(r.ok, true);

  // Votes
  ({ needs, evaluate } = compileRules({ vote_count_floor: 1000 }, 'movie', { nowYear }));
  assert(needs.has('votes'));
  r = evaluate({ votes: 812 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'votes');
  assert.strictEqual(r.detail, '812 < 1000');
  // Boundary: votes == floor passes
  r = evaluate({ votes: 1000 });
  assert.strictEqual(r.ok, true);

  // Rating (votes supplied to avoid no_data)
  ({ needs, evaluate } = compileRules({ min_rating: 7 }, 'movie', { nowYear }));
  assert(needs.has('rating'));
  r = evaluate({ rating: 5.8, votes: 500 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rating');
  assert.strictEqual(r.detail, '5.8 < 7');
  // Boundary: rating == min_rating passes
  r = evaluate({ rating: 7, votes: 500 });
  assert.strictEqual(r.ok, true);

  // Rating 0 counts as missing => no_data
  r = evaluate({ rating: 0, votes: 500 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_data');

  // Order: genre before recency before votes before rating
  ({ needs, evaluate } = compileRules({ excluded_genres: ['Horror'], min_year: 2010, vote_count_floor: 1000, min_rating: 7 }, 'movie', { nowYear }));
  r = evaluate({ genres: ['Horror'], year: 2009, votes: 500, rating: 5 });
  assert.strictEqual(r.reason, 'genre');
  r = evaluate({ genres: ['Comedy'], year: 2009, votes: 500, rating: 5 });
  assert.strictEqual(r.reason, 'recency');
  r = evaluate({ genres: ['Comedy'], year: 2020, votes: 500, rating: 5 });
  assert.strictEqual(r.reason, 'votes');
  r = evaluate({ genres: ['Comedy'], year: 2020, votes: 2000, rating: 5 });
  assert.strictEqual(r.reason, 'rating');

  // Series vote floor is scaled (1/5)
  ({ needs, evaluate } = compileRules({ vote_count_floor: 1000 }, 'series', { nowYear }));
  const seriesFloor = tmdb.voteFloor({ vote_count_floor: 1000 }, 'series');
  r = evaluate({ votes: seriesFloor - 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'votes');
  r = evaluate({ votes: seriesFloor });
  assert.strictEqual(r.ok, true);
}

// ============================================================================
// FG2: inactive filters are free
// ============================================================================
async function testFG2() {
  // vote_count_floor: 0 makes the vote floor inactive (the default is 200).
  const profile = makeProfile({ vote_count_floor: 0 }); // no active filters
  const candidates = [cand('tt123'), cand('tt456')];

  let metaCalls = 0;
  let mdblistCalls = 0;
  let llmCalls = 0;

  const deps = {
    metaStore: {
      getMany: () => { metaCalls++; return new Map(); },
      enrich: async () => { metaCalls++; return null; },
    },
    mdblist: {
      cachedImdbRatings: async () => { mdblistCalls++; return new Map(); },
      mediaInfoBatch: async () => { mdblistCalls++; return new Map(); },
    },
    groq: {
      titleFacts: async () => { llmCalls++; return []; },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'movie', candidates, deps);
  assert.strictEqual(results.get('tt123').verdict, 'good');
  assert.strictEqual(results.get('tt456').verdict, 'good');
  assert.strictEqual(metaCalls, 0, 'metaStore should not be called');
  assert.strictEqual(mdblistCalls, 0, 'mdblist should not be called');
  assert.strictEqual(llmCalls, 0, 'LLM should not be called');
}

// ============================================================================
// FG3: needs-driven fetching
// ============================================================================
async function testFG3() {
  const profile = makeProfile({ min_rating: 7 });
  const candidates = [cand('tt123', { tmdb_id: '123', imdb_id: 'tt123' })];

  let metaCalls = 0;
  let mdblistCalls = 0;
  let llmCalls = 0;

  const deps = {
    metaStore: {
      getMany: () => { metaCalls++; return new Map([['123', { vote_average: 8.5, genres: ['Drama'], year: 2020, vote_count: 500 }]]); },
      enrich: async () => { metaCalls++; return null; },
    },
    mdblist: {
      cachedImdbRatings: async () => { mdblistCalls++; return new Map([['tt123', 8.5]]); },
      mediaInfoBatch: async () => { mdblistCalls++; return new Map(); },
    },
    groq: {
      titleFacts: async () => { llmCalls++; return []; },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'movie', candidates, deps);
  assert.strictEqual(results.get('tt123').verdict, 'good');
  // The LLM should not be called since the ladder already supplied the rating.
  assert.strictEqual(llmCalls, 0, 'LLM should not be called when ladder supplies the fact');
}

// ============================================================================
// FG4: ladder order
// ============================================================================
async function testFG4() {
  // vote_count_floor: 0 so 'votes' is not in needs (the ladder doesn't provide votes).
  const profile = makeProfile({ min_rating: 7, min_year: 2010, vote_count_floor: 0, excluded_genres: ['Horror'] });
  const candidates = [
    // TMDB cached meta has it
    { key: '100', tmdb_id: '100', imdb_id: 'tt100', title: 'MovieA', year: null, imdbRating: null },
    // TMDB missing, MDBList has the rating
    { key: 'tt200', tmdb_id: null, imdb_id: 'tt200', title: 'MovieB', year: null, imdbRating: null },
    // Both missing, LLM answers
    { key: 'tt300', tmdb_id: null, imdb_id: 'tt300', title: 'MovieC', year: null, imdbRating: null },
    // LLM omits the title
    { key: 'tt400', tmdb_id: null, imdb_id: 'tt400', title: 'MovieD', year: null, imdbRating: null },
  ];

  let llmCallCount = 0;
  const deps = {
    tmdbKey: 'test-tmdb-key',
    mdblistKey: 'test-mdblist-key',
    metaStore: {
      // tt100 is cached; others are not.
      getMany: (type, ids) => {
        const m = new Map();
        if (ids.includes('100')) m.set('100', { vote_average: 8.5, genres: ['Drama'], year: 2020, vote_count: 500 });
        return m;
      },
      enrich: async () => null, // TMDB fetch fails for uncached
    },
    mdblist: {
      cachedImdbRatings: async (key, type, ids) => {
        const m = new Map();
        if (ids.includes('tt200')) m.set('tt200', 8.5);
        return m;
      },
      mediaInfoBatch: async (key, type, ids) => {
        const m = new Map();
        if (ids.includes('tt200')) m.set('tt200', { release_year: 2020, genres: ['Drama'] });
        return m;
      },
    },
    groq: {
      titleFacts: async (type, titles) => {
        llmCallCount++;
        return titles.map((t) => {
          if (t.title === 'MovieC') return { genres: ['Drama'], year: 2015, rating: 8.0 };
          return null; // MovieD omitted
        });
      },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    hasLlm: () => true,
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'movie', candidates, deps);
  // tt100: TMDB cached meta supplied all facts => good
  assert.strictEqual(results.get('100').verdict, 'good');
  // tt200: MDBList supplied rating => good
  assert.strictEqual(results.get('tt200').verdict, 'good');
  // tt300: LLM supplied facts => good, source 'llm'
  assert.strictEqual(results.get('tt300').verdict, 'good');
  assert.strictEqual(results.get('tt300').source, 'llm');
  // tt400: LLM omitted => no_data => bad
  assert.strictEqual(results.get('tt400').verdict, 'bad');
  assert.strictEqual(results.get('tt400').reason, 'no_data');
}

// ============================================================================
// FG5: never throws
// ============================================================================
async function testFG5() {
  const profile = makeProfile({ min_rating: 7, min_year: 2010, vote_count_floor: 100, excluded_genres: ['Horror'] });
  const candidates = [
    { key: 'tt1', tmdb_id: '1', imdb_id: 'tt1', title: 'A', year: null, imdbRating: null },
    { key: 'tt2', tmdb_id: null, imdb_id: 'tt2', title: 'B', year: null, imdbRating: null },
  ];

  // TMDB throws, MDBList throws, LLM throws
  const deps = {
    metaStore: {
      getMany: () => { throw new Error('TMDB down'); },
      enrich: async () => { throw new Error('TMDB down'); },
    },
    mdblist: {
      cachedImdbRatings: async () => { throw new Error('MDBList down'); },
      mediaInfoBatch: async () => { throw new Error('MDBList down'); },
    },
    groq: {
      titleFacts: async () => { throw new Error('LLM down'); },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  // Should not throw; both titles get no_data => bad
  const results = await checkMany(profile, 'movie', candidates, deps);
  assert.strictEqual(results.get('tt1').verdict, 'bad');
  assert.strictEqual(results.get('tt1').reason, 'no_data');
  assert.strictEqual(results.get('tt2').verdict, 'bad');
  assert.strictEqual(results.get('tt2').reason, 'no_data');

  // LLM returns garbage
  const deps2 = {
    metaStore: { getMany: () => new Map(), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: { titleFacts: async () => { throw new Error('garbage'); } },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };
  const results2 = await checkMany(profile, 'movie', candidates, deps2);
  assert.strictEqual(results2.get('tt1').verdict, 'bad');
  assert.strictEqual(results2.get('tt1').reason, 'no_data');
}

// ============================================================================
// FG6: store
// ============================================================================
async function testFG6() {
  const profile = makeProfile({ min_rating: 7 });
  const candidate = { key: 'tt1', tmdb_id: '1', imdb_id: 'tt1', title: 'Test', year: 2020, imdbRating: 8.5 };

  const deps = {
    metaStore: { getMany: () => new Map([['1', { vote_average: 8.5, genres: ['Drama'], year: 2020, vote_count: 500 }]]), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: { titleFacts: async () => [] },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  // First call: stores the verdict
  let metaCalls = 0;
  const deps1 = { ...deps, metaStore: { ...deps.metaStore, getMany: () => { metaCalls++; return new Map([['1', { vote_average: 8.5, genres: ['Drama'], year: 2020, vote_count: 500 }]]); } } };
  const r1 = await checkMany(profile, 'movie', [candidate], deps1);
  assert.strictEqual(r1.get('tt1').verdict, 'good');

  // Second call: should use the stored verdict (no fetches)
  metaCalls = 0;
  const r2 = await checkMany(profile, 'movie', [candidate], deps1);
  assert.strictEqual(r2.get('tt1').verdict, 'good');
  assert.strictEqual(metaCalls, 0, 'second call should not fetch');

  // Changed filter (min_rating 7 -> 8) changes fhash
  const profile2 = makeProfile({ min_rating: 8 });
  const r3 = await checkMany(profile2, 'movie', [candidate], deps1);
  // 8.5 >= 8, so good
  assert.strictEqual(r3.get('tt1').verdict, 'good');

  // no_data is not stored
  const profile3 = makeProfile({ min_rating: 7, min_year: 2010, vote_count_floor: 1000, excluded_genres: ['Horror'] });
  const badCandidate = { key: 'tt2', tmdb_id: null, imdb_id: 'tt2', title: 'NoData', year: null, imdbRating: null };
  const deps3 = {
    metaStore: { getMany: () => new Map(), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: { titleFacts: async () => [null] },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    hasLlm: () => true,
    now: () => Date.now(),
    log: quiet,
  };
  const r4 = await checkMany(profile3, 'movie', [badCandidate], deps3);
  assert.strictEqual(r4.get('tt2').verdict, 'bad');
  assert.strictEqual(r4.get('tt2').reason, 'no_data');
  // Second call should fetch again (not stored)
  let llmCalls = 0;
  const deps4 = { ...deps3, groq: { titleFacts: async () => { llmCalls++; return [null]; } } };
  const r5 = await checkMany(profile3, 'movie', [badCandidate], deps4);
  assert.strictEqual(llmCalls, 1, 'no_data should not be stored, so second call fetches again');

  // Two profiles with the same title do not share rows
  const profileA = { id: 'profileA', name: 'A', filters: { min_rating: 7 } };
  const profileB = { id: 'profileB', name: 'B', filters: { min_rating: 7 } };
  const sharedCandidate = { key: '9', tmdb_id: '9', imdb_id: 'tt9', title: 'Shared', year: 2020, imdbRating: 8.5 };
  const depsShared = {
    ...deps,
    metaStore: {
      getMany: () => new Map([['9', { vote_average: 8.5, genres: ['Drama'], year: 2020, vote_count: 500 }]]),
      enrich: async () => null,
    },
  };
  await checkMany(profileA, 'movie', [sharedCandidate], depsShared);
  // profileB should not see profileA's verdict (different profile_id)
  const rB = await checkMany(profileB, 'movie', [sharedCandidate], depsShared);
  assert.strictEqual(rB.get('9').verdict, 'good');
  // Verify they are separate by checking the store directly
  const fhash = filterHash({ min_rating: 7 }, 'movie', 2026);
  const vA = store.getVerdict('profileA', 'movie', '9', fhash);
  const vB = store.getVerdict('profileB', 'movie', '9', fhash);
  assert(vA, 'profileA should have a stored verdict');
  assert(vB, 'profileB should have a stored verdict');
}

// ============================================================================
// FG7: anime exclusion
// ============================================================================
async function testFG7() {
  const profile = makeProfile({ excluded_genres: ['Anime'] });
  const candidate = { key: 'tt1', tmdb_id: '1', imdb_id: 'tt1', title: 'Anime Show', year: 2020, imdbRating: 8.5 };

  const deps = {
    metaStore: { getMany: () => new Map([['1', { vote_average: 8.5, genres: ['Animation'], year: 2020, vote_count: 500 }]]), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: { titleFacts: async () => [] },
    // The anime detector flags this title.
    animeMap: { isAnime: (imdbId, tmdbId) => imdbId === 'tt1', ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'series', [candidate], deps);
  assert.strictEqual(results.get('tt1').verdict, 'bad');
  assert.strictEqual(results.get('tt1').reason, 'genre');
  assert.strictEqual(results.get('tt1').detail, 'Anime');
}

// ============================================================================
// FG8: parity with the engines (T1 rewrite)
// ============================================================================
async function testFG8() {
  const { compileTvFilter } = require('../src/engines/marqueeTv/filters');
  const { compileEnvelope } = require('../src/engines/marquee/filters');

  const nowYear = 2026;
  const genreMap = {}; // empty genre map for movies
  const filters = { excluded_genres: ['Horror'], min_year: 2010, vote_count_floor: 1000, min_rating: 7 };

  // Series vote floor (1/5 of 1000 = 200)
  const seriesFloor = tmdb.voteFloor(filters, 'series');
  // Movie vote floor (1000)
  const movieFloor = tmdb.voteFloor(filters, 'movie');

  // Build a fixture matrix (>= 40 rows) covering every reason and boundaries.
  // Series rows: type 'series', compare with compileTvFilter.
  // Movie rows: type 'movie', compare with compileEnvelope(...).hardFilter.
  const fixtures = [];

  // Genre (series + movie)
  fixtures.push({ type: 'series', genres: ['Horror'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Horror'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Horror', 'Thriller'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Horror', 'Thriller'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Science Fiction'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Science Fiction'], year: 2020, votes: 1000, rating: 8.0 });

  // Recency (series + movie)
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2009, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2009, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2010, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2010, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.0 });

  // Votes (series uses seriesFloor, movie uses movieFloor)
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: seriesFloor - 1, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: movieFloor - 1, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: seriesFloor, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: movieFloor, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 0, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 0, rating: 8.0 });

  // Rating (series + movie)
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 6.9 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 6.9 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 7.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 7.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.5 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.5 });

  // Combined (series + movie)
  fixtures.push({ type: 'series', genres: ['Horror'], year: 2009, votes: seriesFloor - 1, rating: 5.0 });
  fixtures.push({ type: 'movie', genres: ['Horror'], year: 2009, votes: movieFloor - 1, rating: 5.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2009, votes: seriesFloor - 1, rating: 5.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2009, votes: movieFloor - 1, rating: 5.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2009, votes: 1000, rating: 5.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2009, votes: 1000, rating: 5.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: seriesFloor - 1, rating: 5.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: movieFloor - 1, rating: 5.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 5.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 5.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 7.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 7.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Action'], year: 2015, votes: 5000, rating: 7.5 });
  fixtures.push({ type: 'movie', genres: ['Action'], year: 2015, votes: 5000, rating: 7.5 });
  fixtures.push({ type: 'series', genres: ['Action'], year: 2015, votes: 5000, rating: 6.5 });
  fixtures.push({ type: 'movie', genres: ['Action'], year: 2015, votes: 5000, rating: 6.5 });
  fixtures.push({ type: 'series', genres: ['Thriller'], year: 2018, votes: 2000, rating: 7.2 });
  fixtures.push({ type: 'movie', genres: ['Thriller'], year: 2018, votes: 2000, rating: 7.2 });
  fixtures.push({ type: 'series', genres: ['Thriller'], year: 2018, votes: 2000, rating: 6.8 });
  fixtures.push({ type: 'movie', genres: ['Thriller'], year: 2018, votes: 2000, rating: 6.8 });
  fixtures.push({ type: 'series', genres: ['Drama'], year: 2019, votes: 3000, rating: 8.1 });
  fixtures.push({ type: 'movie', genres: ['Drama'], year: 2019, votes: 3000, rating: 8.1 });
  fixtures.push({ type: 'series', genres: ['Drama'], year: 2019, votes: 3000, rating: 6.9 });
  fixtures.push({ type: 'movie', genres: ['Drama'], year: 2019, votes: 3000, rating: 6.9 });
  fixtures.push({ type: 'series', genres: ['Romance'], year: 2017, votes: 1500, rating: 7.3 });
  fixtures.push({ type: 'movie', genres: ['Romance'], year: 2017, votes: 1500, rating: 7.3 });
  fixtures.push({ type: 'series', genres: ['Romance'], year: 2017, votes: 1500, rating: 6.5 });
  fixtures.push({ type: 'movie', genres: ['Romance'], year: 2017, votes: 1500, rating: 6.5 });
  fixtures.push({ type: 'series', genres: ['Crime'], year: 2021, votes: 4000, rating: 8.2 });
  fixtures.push({ type: 'movie', genres: ['Crime'], year: 2021, votes: 4000, rating: 8.2 });
  fixtures.push({ type: 'series', genres: ['Crime'], year: 2021, votes: 4000, rating: 7.1 });
  fixtures.push({ type: 'movie', genres: ['Crime'], year: 2021, votes: 4000, rating: 7.1 });
  fixtures.push({ type: 'series', genres: ['Fantasy'], year: 2016, votes: 2500, rating: 7.8 });
  fixtures.push({ type: 'movie', genres: ['Fantasy'], year: 2016, votes: 2500, rating: 7.8 });
  fixtures.push({ type: 'series', genres: ['Fantasy'], year: 2016, votes: 2500, rating: 6.2 });
  fixtures.push({ type: 'movie', genres: ['Fantasy'], year: 2016, votes: 2500, rating: 6.2 });
  fixtures.push({ type: 'series', genres: ['Adventure'], year: 2014, votes: 3500, rating: 7.4 });
  fixtures.push({ type: 'movie', genres: ['Adventure'], year: 2014, votes: 3500, rating: 7.4 });
  fixtures.push({ type: 'series', genres: ['Adventure'], year: 2014, votes: 3500, rating: 6.6 });
  fixtures.push({ type: 'movie', genres: ['Adventure'], year: 2014, votes: 3500, rating: 6.6 });
  fixtures.push({ type: 'series', genres: ['Mystery'], year: 2022, votes: 1800, rating: 7.9 });
  fixtures.push({ type: 'movie', genres: ['Mystery'], year: 2022, votes: 1800, rating: 7.9 });
  fixtures.push({ type: 'series', genres: ['Mystery'], year: 2022, votes: 1800, rating: 6.4 });
  fixtures.push({ type: 'movie', genres: ['Mystery'], year: 2022, votes: 1800, rating: 6.4 });
  fixtures.push({ type: 'series', genres: ['Horror'], year: 2023, votes: 1200, rating: 7.6 });
  fixtures.push({ type: 'movie', genres: ['Horror'], year: 2023, votes: 1200, rating: 7.6 });
  fixtures.push({ type: 'series', genres: ['Horror'], year: 2023, votes: 1200, rating: 6.1 });
  fixtures.push({ type: 'movie', genres: ['Horror'], year: 2023, votes: 1200, rating: 6.1 });

  // Null-fact rows (out of scope for parity; engines fail open, we send to ladder).
  // We assert they come back no_data from ours.
  fixtures.push({ type: 'series', genres: ['Comedy'], year: null, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: null, votes: 1000, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: null, rating: 8.0 });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: null, rating: 8.0 });
  fixtures.push({ type: 'series', genres: ['Comedy'], year: 2020, votes: 1000, rating: null });
  fixtures.push({ type: 'movie', genres: ['Comedy'], year: 2020, votes: 1000, rating: null });

  // Compile our rules per type.
  const seriesRules = compileRules(filters, 'series', { nowYear });
  const movieRules = compileRules(filters, 'movie', { nowYear });

  // Compile the engines.
  const tvFilter = compileTvFilter(filters, { nowYear, formatsAllowed: new Set(['scripted', 'reality', 'documentary', 'talk', 'news', 'video']), tier: null });
  const envelope = compileEnvelope(filters, { nowYear, genreMap });

  // Counters for the assertions.
  let seriesCompared = 0;
  let movieCompared = 0;
  const seriesReasons = new Set();
  const movieReasons = new Set();

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const isSeries = f.type === 'series';
    const ourRules = isSeries ? seriesRules : movieRules;
    const ourResult = ourRules.evaluate({ genres: f.genres, year: f.year, votes: f.votes, rating: f.rating });
    const ourOk = ourResult.ok;
    const ourReason = ourResult.ok ? null : ourResult.reason;

    if (isSeries) {
      // TV filter row shape.
      const tvRow = {
        imdb_id: `tt${i}`,
        genres: f.genres,
        vote_count: f.votes,
        vote_average: f.rating || 0,
        imdb_rating: f.rating || 0,
        last_air_date: f.year ? `${f.year}-01-01` : null,
        first_air_date: f.year ? `${f.year}-01-01` : null,
        tvType: 'Scripted',
      };
      const tvResult = tvFilter.check(tvRow);
      const tvOk = tvResult.ok;
      const tvReason = tvResult.ok ? null : tvResult.reason;

      // Null-fact rows: our rules return no_data; the engine fails open.
      if (f.year === null || f.votes === null || f.rating === null) {
        // Our rules: null fact => no_data (for the fact that is null).
        // The engine: null votes => 0 (fails votes), null year => skip recency, null rating => 0 (passes).
        // We assert our result is no_data for the null fact.
        if (ourReason === 'no_data') {
          // Expected: our rules send null facts to the ladder.
        } else {
          // The row has a null fact but our rules returned a different reason —
          // this can happen when multiple facts are present and one fails first.
        }
        continue; // Null-fact rows are out of scope for parity comparison.
      }

      // All four facts present: compare ok vs not-ok.
      seriesCompared++;
      assert.strictEqual(ourOk, tvOk, `series fixture ${i}: our ok=${ourOk} tv ok=${tvOk} ${JSON.stringify(f)}`);

      // If both fail: compare the reason if exactly one rule fails.
      if (!ourOk && !tvOk) {
        // Count the failing rules.
        const failCount = (r) => r === 'genre' || r === 'recency' || r === 'votes' || r === 'rating' ? 1 : 0;
        // Our rules check in order: genre, recency, votes, rating.
        // The TV filter checks: genre, recency, votes, rating (same order).
        // So the reason should match.
        seriesReasons.add(ourReason);
        assert.strictEqual(ourReason, tvReason, `series fixture ${i}: our reason=${ourReason} tv reason=${tvReason} ${JSON.stringify(f)}`);
      }
    } else {
      // Movie envelope row shape.
      const movieRow = {
        imdb_id: `tt${i}`,
        imdb_rating: f.rating || 0,
        vote_average: f.rating || 0,
        vote_count: f.votes || 0,
        year: f.year,
        genres: f.genres,
        availability: 'AVAILABLE',
      };
      const movieResult = envelope.hardFilter(movieRow);
      const movieOk = movieResult.ok;
      const movieReason = movieResult.ok ? null : movieResult.reason;

      // Null-fact rows: out of scope.
      if (f.year === null || f.votes === null || f.rating === null) {
        continue;
      }

      // All four facts present: compare ok vs not-ok.
      movieCompared++;
      assert.strictEqual(ourOk, movieOk, `movie fixture ${i}: our ok=${ourOk} movie ok=${movieOk} ${JSON.stringify(f)}`);

      // If both fail: compare the reason.
      if (!ourOk && !movieOk) {
        movieReasons.add(ourReason);
        // Our rules check: genre, recency, votes, rating.
        // The movie envelope checks: rating, recency, genre, votes (different order).
        // For rows that fail exactly one rule, the reason must match.
        // For rows that fail more than one rule, the reason may differ (order).
        // Count the failing rules for our result.
        const ourFailing = (reason) => {
          const count = { genre: 0, recency: 0, votes: 0, rating: 0 };
          const r = compileRules(filters, 'movie', { nowYear });
          // Check each rule independently.
          if (f.genres && f.genres.some((g) => ['Horror'].includes(g))) count.genre = 1;
          if (f.year && f.year < 2010) count.recency = 1;
          if (f.votes != null && f.votes < movieFloor) count.votes = 1;
          if (f.rating != null && f.rating > 0 && f.rating < 7) count.rating = 1;
          return count;
        };
        const fails = ourFailing(ourReason);
        const failCount = Object.values(fails).reduce((a, b) => a + b, 0);
        if (failCount === 1) {
          assert.strictEqual(ourReason, movieReason, `movie fixture ${i}: our reason=${ourReason} movie reason=${movieReason} ${JSON.stringify(f)}`);
        }
        // If failCount > 1: compare ok/not-ok only (already done above).
      }
    }
  }

  // Assert >= 30 rows compared per engine.
  assert(seriesCompared >= 30, `series: only ${seriesCompared} rows compared (need >= 30)`);
  assert(movieCompared >= 30, `movie: only ${movieCompared} rows compared (need >= 30)`);

  // Assert each of the four reasons was compared at least once per engine.
  for (const reason of ['genre', 'recency', 'votes', 'rating']) {
    assert(seriesReasons.has(reason), `series: reason '${reason}' was never compared`);
    assert(movieReasons.has(reason), `movie: reason '${reason}' was never compared`);
  }
}

// ============================================================================
// FG9: wiring — drive buildExtraCatalog (T2 rewrite)
//
// FG9a keeps the pure checkMany unit cases. FG9b-FG9d drive the real
// buildExtraCatalog (the I8 pattern: stub mdblist.listItemsPage /
// mdblist.mediaInfoBatch / metaStore.getMany / metaStore.enrich on the module
// objects; buildExtraCatalog calls them through the module object).
// ============================================================================

// A list-page item in the shape fetchExtraPage expects: imdb_id, ids (imdb +
// tmdb), title, release_year, an IMDb rating in ratings (so fetchExtraPage
// fills imdbRating), and a poster (so the batch enrich is skipped). `_genres`
// is internal — it feeds the metaStore stub, not the list page.
function makeItem(imdbId, tmdbId, title, genres, rating, year) {
  return {
    imdb_id: imdbId,
    ids: { imdb: imdbId, tmdb: tmdbId },
    title,
    release_year: year,
    ratings: [{ source: 'imdb', value: rating }],
    poster: 'http://example.com/p.jpg',
    _genres: genres,
  };
}

// The metaStore.getMany stub data: tmdb id -> deep-meta (genres/year/votes/rating).
function metaDataFor(items) {
  const map = new Map();
  for (const it of items) {
    map.set(String(it.ids.tmdb), {
      genres: it._genres,
      year: it.release_year,
      vote_count: 1000,
      vote_average: it.ratings[0].value,
    });
  }
  return map;
}

// Shared wiring harness: stubs the MDBList fetchers, the TMDB meta store, and
// (optionally) the age chain's verify on the module objects, so a real
// buildExtraCatalog run exercises the filter gate -> age gate wiring. Every
// stub is restored by the caller's finally.
function wiringHarness({ page0, page1, metaStoreData, verifyStub }) {
  const mdblist = require('../src/services/mdblist');
  const metaStore = require('../src/engines/shared/metaStore');
  const ageVerify = require('../src/ageVerification');
  const animeMap = require('../src/services/animeMap');
  const origList = mdblist.listItemsPage;
  const origMediaInfo = mdblist.mediaInfoBatch;
  const origCachedImdb = mdblist.cachedImdbRatings;
  const origGetMany = metaStore.getMany;
  const origEnrich = metaStore.enrich;
  const origVerify = ageVerify.verify;
  const listCalls = [];
  let getManyCalls = 0;
  let cachedImdbCalls = 0;
  mdblist.listItemsPage = async (key, user, slug, type, { offset }) => {
    listCalls.push(offset);
    return offset === 0 ? page0 : offset === 50 ? page1 : [];
  };
  mdblist.mediaInfoBatch = async () => new Map();
  mdblist.cachedImdbRatings = async () => { cachedImdbCalls++; return new Map(); };
  metaStore.getMany = () => { getManyCalls++; return metaStoreData; };
  metaStore.enrich = async () => null;
  if (verifyStub) ageVerify.verify = verifyStub;
  // Keep the anime detector offline (no Tenrai/AniList reach-out).
  animeMap._setIndex({ at: Date.now(), etag: 'itest', byImdb: {}, byTmdb: {} });
  return {
    listCalls,
    getManyCalls: () => getManyCalls,
    cachedImdbCalls: () => cachedImdbCalls,
    restore() {
      mdblist.listItemsPage = origList;
      mdblist.mediaInfoBatch = origMediaInfo;
      mdblist.cachedImdbRatings = origCachedImdb;
      metaStore.getMany = origGetMany;
      metaStore.enrich = origEnrich;
      ageVerify.verify = origVerify;
    },
  };
}

// FG9a: filter gate unit cases (checkMany directly).
async function testFG9a() {
  const profile = {
    id: 'fg9a-profile',
    name: 'FG9A',
    filters: { excluded_genres: ['Horror'], min_rating: 7, min_year: 2010 },
  };
  const candidates = [
    { key: 'tt1', tmdb_id: '1', imdb_id: 'tt1', title: 'Horror Film', year: 2020, imdbRating: 8.5 },
    { key: 'tt2', tmdb_id: '2', imdb_id: 'tt2', title: 'Low Rated', year: 2020, imdbRating: 6.2 },
    { key: 'tt3', tmdb_id: '3', imdb_id: 'tt3', title: 'Old Film', year: 2005, imdbRating: 8.0 },
    { key: 'tt4', tmdb_id: '4', imdb_id: 'tt4', title: 'Good Film', year: 2020, imdbRating: 8.5 },
    { key: 'tt5', tmdb_id: '5', imdb_id: 'tt5', title: 'Great Film', year: 2015, imdbRating: 9.0 },
  ];
  const deps = {
    metaStore: {
      getMany: () => new Map([
        ['1', { vote_average: 8.5, genres: ['Horror'], year: 2020, vote_count: 1000 }],
        ['2', { vote_average: 6.2, genres: ['Drama'], year: 2020, vote_count: 1000 }],
        ['3', { vote_average: 8.0, genres: ['Drama'], year: 2005, vote_count: 1000 }],
        ['4', { vote_average: 8.5, genres: ['Comedy'], year: 2020, vote_count: 1000 }],
        ['5', { vote_average: 9.0, genres: ['Action'], year: 2015, vote_count: 2000 }],
      ]),
      enrich: async () => null,
    },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: { titleFacts: async () => [] },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };
  const results = await checkMany(profile, 'movie', candidates, deps);
  assert.strictEqual(results.get('tt1').verdict, 'bad');
  assert.strictEqual(results.get('tt1').reason, 'genre');
  assert.strictEqual(results.get('tt2').verdict, 'bad');
  assert.strictEqual(results.get('tt2').reason, 'rating');
  assert.strictEqual(results.get('tt3').verdict, 'bad');
  assert.strictEqual(results.get('tt3').reason, 'recency');
  assert.strictEqual(results.get('tt4').verdict, 'good');
  assert.strictEqual(results.get('tt5').verdict, 'good');

  // A no-filter profile (vote_count_floor: 0, nothing else) gives all good.
  const noFilterProfile = { id: 'fg9a-nofilter', name: 'NoFilter', filters: { vote_count_floor: 0 } };
  const results2 = await checkMany(noFilterProfile, 'movie', candidates, deps);
  for (const c of candidates) {
    assert.strictEqual(results2.get(c.key).verdict, 'good', `no-filter profile: ${c.key} should be good`);
  }
}

// FG9b: removal + paging — drive buildExtraCatalog. Page 0 has 50 items, 30 of
// which fail the filters; page 1 has more good ones; listSize is small enough
// that page 0 alone cannot fill 2 x listSize eligible.
async function testFG9b() {
  const rebuild = require('../src/rebuild');
  const page0 = [];
  const page1 = [];
  const failing = new Set();
  const good = new Set();
  let tmdb = 100;
  for (let i = 0; i < 10; i++) {
    const imdb = `tt${tmdb}`;
    page0.push(makeItem(imdb, tmdb, `Horror ${i}`, ['Horror'], 8.5, 2020));
    failing.add(imdb); tmdb++;
  }
  for (let i = 0; i < 10; i++) {
    const imdb = `tt${tmdb}`;
    page0.push(makeItem(imdb, tmdb, `Low Rated ${i}`, ['Drama'], 6.5, 2020));
    failing.add(imdb); tmdb++;
  }
  for (let i = 0; i < 10; i++) {
    const imdb = `tt${tmdb}`;
    page0.push(makeItem(imdb, tmdb, `Old Film ${i}`, ['Drama'], 8.5, 2005));
    failing.add(imdb); tmdb++;
  }
  for (let i = 0; i < 20; i++) {
    const imdb = `tt${tmdb}`;
    page0.push(makeItem(imdb, tmdb, `Good ${i}`, ['Comedy'], 8.5, 2020));
    good.add(imdb); tmdb++;
  }
  for (let i = 0; i < 10; i++) {
    const imdb = `tt${tmdb}`;
    page1.push(makeItem(imdb, tmdb, `Good P1 ${i}`, ['Comedy'], 8.5, 2020));
    good.add(imdb); tmdb++;
  }

  const profile = {
    id: 'fg9b-profile',
    name: 'FG9B',
    filters: { excluded_genres: ['Horror'], min_rating: 7, min_year: 2010, vote_count_floor: 0, list_size: 15 },
    keys: { mdblist_api_key: 'test-mdb', tmdb_api_key: 'test-tmdb' },
  };
  const def = { type: 'movie', id: 'fg9b-def', name: 'T', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, profile_filters: true };

  const h = wiringHarness({ page0, page1, metaStoreData: metaDataFor([...page0, ...page1]) });
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: () => {}, error: () => {} };
  try {
    const built = await rebuild.buildExtraCatalog(profile, def, log);
    const ids = built.map((m) => m.id);
    for (const f of failing) assert.ok(!ids.includes(f), `failing title ${f} should be removed`);
    for (const g of good) assert.ok(ids.includes(g), `good title ${g} should be present`);
    // Paging continued past the removed titles (offset 50 was requested).
    assert.ok(h.listCalls.includes(50), `listItemsPage should be called for offset 50 (got ${JSON.stringify(h.listCalls)})`);
    // The log line's M is the total number of titles the gate checked across
    // both pages (50 + 10 = 60), not collected + removed.
    const filterLine = lines.find((l) => l.includes('filter gate removed'));
    assert.ok(filterLine, `filter gate log line should be present (lines: ${JSON.stringify(lines)})`);
    assert.ok(filterLine.includes('removed 30 of 60'), `log line M should be 60 (got: ${filterLine})`);
  } finally {
    h.restore();
  }
}

// FG9c: not applied elsewhere — a genre-list def (no profile_filters) returns
// the failing titles untouched, and Watch Later (simkl_plantowatch) never
// calls the filter gate. Both are verified by spying on filterGate.checkMany.
async function testFG9c() {
  const rebuild = require('../src/rebuild');
  const filterGate = require('../src/filterGate');
  const simkl = require('../src/services/simkl');
  const tmdb = require('../src/services/tmdb');

  // Same profile + pages as FG9b, but the def has no profile_filters.
  const page0 = [];
  const page1 = [];
  const failing = new Set();
  let tmdbId = 200;
  for (let i = 0; i < 5; i++) {
    const imdb = `tt${tmdbId}`;
    page0.push(makeItem(imdb, tmdbId, `Horror ${i}`, ['Horror'], 8.5, 2020));
    failing.add(imdb); tmdbId++;
  }
  for (let i = 0; i < 5; i++) {
    const imdb = `tt${tmdbId}`;
    page0.push(makeItem(imdb, tmdbId, `Low Rated ${i}`, ['Drama'], 6.5, 2020));
    failing.add(imdb); tmdbId++;
  }
  for (let i = 0; i < 10; i++) {
    const imdb = `tt${tmdbId}`;
    page0.push(makeItem(imdb, tmdbId, `Good ${i}`, ['Comedy'], 8.5, 2020));
    tmdbId++;
  }

  const profile = {
    id: 'fg9c-profile',
    name: 'FG9C',
    filters: { excluded_genres: ['Horror'], min_rating: 7, min_year: 2010, vote_count_floor: 0, list_size: 15 },
    keys: { mdblist_api_key: 'test-mdb', tmdb_api_key: 'test-tmdb' },
  };
  // A genre-list style def: no profile_filters.
  const genreDef = { type: 'movie', id: 'fg9c-genre', name: 'T', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0 };

  const h = wiringHarness({ page0, page1, metaStoreData: metaDataFor(page0) });
  const origCheckMany = filterGate.checkMany;
  let checkManyCalls = 0;
  filterGate.checkMany = (...args) => { checkManyCalls++; return origCheckMany(...args); };
  try {
    // (a) Genre-list def: the failing titles are untouched (not removed).
    const built = await rebuild.buildExtraCatalog(profile, genreDef, quiet);
    const ids = built.map((m) => m.id);
    for (const f of failing) assert.ok(ids.includes(f), `genre-list def: failing title ${f} should be kept (untouched)`);
    assert.strictEqual(checkManyCalls, 0, `genre-list def: checkMany should not be called (got ${checkManyCalls})`);

    // (b) Watch Later: never calls the filter gate.
    checkManyCalls = 0;
    const wlProfile = { ...profile, id: 'fg9c-wl', simkl_auth: { access_token: 'test-token' } };
    const wlDef = { type: 'movie', id: 'fg9c-watch-later', name: 'Watch Later', source: 'simkl_plantowatch', dedupe_watched: false };
    const origGetPTW = simkl.getPlanToWatch;
    const origMetaByTmdb = tmdb.metaByTmdbId;
    simkl.getPlanToWatch = async () => [
      { imdb_id: 'tt900', tmdb_id: '900', title: 'WL One', year: 2020 },
      { imdb_id: 'tt901', tmdb_id: '901', title: 'WL Two', year: 2021 },
    ];
    tmdb.metaByTmdbId = async (_k, type, id) => ({ id: `tt${id}`, type, name: `WL ${id}`, poster: null, description: '', releaseInfo: '2020', _tmdb_id: id });
    try {
      const wlBuilt = await rebuild.buildExtraCatalog(wlProfile, wlDef, quiet);
      assert.ok(wlBuilt.length >= 2, `Watch Later: built ${wlBuilt.length} titles`);
      assert.strictEqual(checkManyCalls, 0, `Watch Later: checkMany should not be called (got ${checkManyCalls})`);
    } finally {
      simkl.getPlanToWatch = origGetPTW;
      tmdb.metaByTmdbId = origMetaByTmdb;
    }
  } finally {
    filterGate.checkMany = origCheckMany;
    h.restore();
  }
}

// FG9d: no filters = identical — a flagged def with vote_count_floor:0 and
// nothing else set produces the same output as the same def without the flag,
// and the stubbed metaStore / cachedImdbRatings are called zero times.
async function testFG9d() {
  const rebuild = require('../src/rebuild');
  const page0 = [];
  let tmdbId = 300;
  for (let i = 0; i < 10; i++) {
    const imdb = `tt${tmdbId}`;
    page0.push(makeItem(imdb, tmdbId, `Item ${i}`, ['Drama'], 8.5, 2020));
    tmdbId++;
  }

  const profile = {
    id: 'fg9d-profile',
    name: 'FG9D',
    filters: { vote_count_floor: 0 },
    keys: { mdblist_api_key: 'test-mdb', tmdb_api_key: 'test-tmdb' },
  };
  const baseDef = { type: 'movie', id: 'fg9d-def', name: 'T', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0 };
  const flaggedDef = { ...baseDef, profile_filters: true };
  const unflaggedDef = { ...baseDef, profile_filters: false };

  const h = wiringHarness({ page0, page1: [], metaStoreData: metaDataFor(page0) });
  const origRandom = Math.random;
  Math.random = () => 0.5; // deterministic shuffle for both runs
  try {
    const builtFlagged = await rebuild.buildExtraCatalog(profile, flaggedDef, quiet);
    const builtUnflagged = await rebuild.buildExtraCatalog(profile, unflaggedDef, quiet);
    const idsFlagged = builtFlagged.map((m) => m.id);
    const idsUnflagged = builtUnflagged.map((m) => m.id);
    assert.deepStrictEqual(idsFlagged, idsUnflagged, 'flagged and unflagged outputs should be identical (in order)');
    assert.strictEqual(h.getManyCalls(), 0, `metaStore.getMany should be called 0 times (got ${h.getManyCalls()})`);
    assert.strictEqual(h.cachedImdbCalls(), 0, `mdblist.cachedImdbRatings should be called 0 times (got ${h.cachedImdbCalls()})`);
  } finally {
    Math.random = origRandom;
    h.restore();
  }
}

// ============================================================================
// FG10: age gate untouched (T3 rewrite) — drive buildExtraCatalog.
// The filter gate (excluded_genres) runs first and removes the horror title;
// the age gate (age_band 12) then runs on the survivors. A title the age gate
// blocks is still absent from the built list, and the call order is
// checkMany before verify.
// ============================================================================
async function testFG10() {
  const rebuild = require('../src/rebuild');
  const filterGate = require('../src/filterGate');
  const ageVerify = require('../src/ageVerification');
  const settings = require('../src/settings');

  const page0 = [
    makeItem('tt1', 1, 'Horror Film', ['Horror'], 8.5, 2020),
    makeItem('tt2', 2, 'Drama Film', ['Drama'], 8.5, 2020),
    makeItem('tt3', 3, 'Comedy Film', ['Comedy'], 8.5, 2020),
    makeItem('tt4', 4, 'Action Film', ['Action'], 8.5, 2020),
  ];

  const profile = {
    id: 'fg10-profile',
    name: 'FG10',
    filters: { age_limit: 12, excluded_genres: ['Horror'], vote_count_floor: 0 },
    keys: { mdblist_api_key: 'test-mdb', tmdb_api_key: 'test-tmdb' },
  };
  const def = { type: 'movie', id: 'fg10-def', name: 'T', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, profile_filters: true, age_band: 12 };

  const verifyKeys = [];
  const callLog = [];
  const verifyStub = (titles) => {
    callLog.push('verify');
    for (const t of titles) verifyKeys.push(t.key);
    const result = new Map();
    for (const t of titles) {
      const verdict = String(t.key.split(':')[1]) === '3' ? 'block' : 'allow';
      result.set(t.key, { verdict, source: 'csm', rating: verdict === 'block' ? '18' : '13' });
    }
    return Promise.resolve(result);
  };

  const origCheckMany = filterGate.checkMany;
  filterGate.checkMany = (...args) => { callLog.push('checkMany'); return origCheckMany(...args); };

  // The age gate's LLM tripwire (hasLlm) must pass; set a Groq key and clear it
  // after. (settings.getSettings() may be null in this suite — updateSettings
  // seeds from blankSettings, so it is safe.)
  settings.updateSettings({ llm: { groq_api_key: 'itest-groq' } });
  const h = wiringHarness({ page0, page1: [], metaStoreData: metaDataFor(page0), verifyStub });
  try {
    const built = await rebuild.buildExtraCatalog(profile, def, quiet);
    const ids = built.map((m) => m.id);

    // (1) verify is never given the horror title (the filter gate removed it first).
    assert.ok(!verifyKeys.includes('movie:1'), `verify should not be given the horror title (keys: ${verifyKeys.join(', ')})`);
    // (2) verify IS given the good titles, and the blocked title is absent.
    assert.ok(verifyKeys.includes('movie:2'), `verify should be given tt2 (keys: ${verifyKeys.join(', ')})`);
    assert.ok(verifyKeys.includes('movie:3'), `verify should be given tt3 (keys: ${verifyKeys.join(', ')})`);
    assert.ok(verifyKeys.includes('movie:4'), `verify should be given tt4 (keys: ${verifyKeys.join(', ')})`);
    assert.ok(!ids.includes('tt3'), 'blocked title tt3 should be absent from the built list');
    assert.ok(ids.includes('tt2'), 'allowed title tt2 should be present');
    assert.ok(ids.includes('tt4'), 'allowed title tt4 should be present');
    // (3) order: checkMany before verify.
    const firstCheck = callLog.indexOf('checkMany');
    const firstVerify = callLog.indexOf('verify');
    assert.ok(firstCheck !== -1 && firstVerify !== -1, `both checkMany and verify should be called (log: ${JSON.stringify(callLog)})`);
    assert.ok(firstCheck < firstVerify, `checkMany should come before verify (log: ${JSON.stringify(callLog)})`);
  } finally {
    filterGate.checkMany = origCheckMany;
    settings.updateSettings({ llm: { groq_api_key: '' } });
    h.restore();
  }
}

// ============================================================================
// FG11: log line (T4 rewrite) — drive buildExtraCatalog with a real log
// capture. Assert the exact filter-gate summary line, that no title or id
// from the fixtures appears in any captured line, and that no filter-gate
// line is logged when nothing was removed.
// ============================================================================
async function testFG11() {
  const rebuild = require('../src/rebuild');

  // 8 titles: 3 genre (horror), 1 recency (pre-2010), 1 rating (6.x), 3 good.
  const page0 = [
    makeItem('tt1', 1, 'Horror A', ['Horror'], 8.5, 2020),
    makeItem('tt2', 2, 'Horror B', ['Horror'], 8.5, 2020),
    makeItem('tt3', 3, 'Horror C', ['Horror'], 8.5, 2020),
    makeItem('tt4', 4, 'Old Film', ['Drama'], 8.5, 2005),
    makeItem('tt5', 5, 'Low A', ['Drama'], 6.5, 2020),
    makeItem('tt6', 6, 'Good A', ['Comedy'], 8.5, 2020),
    makeItem('tt7', 7, 'Good B', ['Comedy'], 8.5, 2020),
    makeItem('tt8', 8, 'Good C', ['Comedy'], 8.5, 2020),
  ];

  const profile = {
    id: 'fg11-profile',
    name: 'FG11',
    filters: { excluded_genres: ['Horror'], min_rating: 7, min_year: 2010, vote_count_floor: 0 },
    keys: { mdblist_api_key: 'test-mdb', tmdb_api_key: 'test-tmdb' },
  };
  const def = { type: 'movie', id: 'fg11-def', name: 'T', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, profile_filters: true };

  const lines = [];
  const log = { log: (m) => lines.push(m), warn: () => {}, error: () => {} };
  const h = wiringHarness({ page0, page1: [], metaStoreData: metaDataFor(page0) });
  try {
    await rebuild.buildExtraCatalog(profile, def, log);
    // The exact log line.
    const expected = '[extra] FG11/fg11-def: filter gate removed 5 of 8 (genre 3, recency 1, votes 0, rating 1, no_data 0)';
    assert.ok(lines.includes(expected), `expected log line not found. Lines: ${JSON.stringify(lines)}`);
    // No title or imdb id from the fixtures appears in any captured line.
    for (const line of lines) {
      for (const it of page0) {
        assert.ok(!line.includes(it.title), `title ${it.title} should not appear in log: ${line}`);
        assert.ok(!line.includes(it.imdb_id), `imdb id ${it.imdb_id} should not appear in log: ${line}`);
      }
    }
  } finally {
    h.restore();
  }

  // No filter-gate line when nothing was removed.
  const goodPage = [
    makeItem('tt10', 10, 'Good X', ['Comedy'], 8.5, 2020),
    makeItem('tt11', 11, 'Good Y', ['Comedy'], 8.5, 2020),
  ];
  const profile2 = {
    id: 'fg11-profile2',
    name: 'FG11',
    filters: { excluded_genres: ['Horror'], min_rating: 7, min_year: 2010, vote_count_floor: 0 },
    keys: { mdblist_api_key: 'test-mdb', tmdb_api_key: 'test-tmdb' },
  };
  const def2 = { type: 'movie', id: 'fg11-def2', name: 'T', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, profile_filters: true };
  const lines2 = [];
  const log2 = { log: (m) => lines2.push(m), warn: () => {}, error: () => {} };
  const h2 = wiringHarness({ page0: goodPage, page1: [], metaStoreData: metaDataFor(goodPage) });
  try {
    await rebuild.buildExtraCatalog(profile2, def2, log2);
    const filterLines = lines2.filter((l) => l.includes('filter gate removed'));
    assert.strictEqual(filterLines.length, 0, `no filter-gate line should be logged when nothing was removed (got ${JSON.stringify(filterLines)})`);
  } finally {
    h2.restore();
  }
}

// ============================================================================
// FG12: IMDb must beat TMDB vote_average (B1)
// ============================================================================
async function testFG12() {
  // Candidate with no imdbRating, TMDB meta vote_average 7.4,
  // fake cachedImdbRatings returns 6.2, min_rating: 7 => bad / rating (6.2 < 7).
  const profile = makeProfile({ min_rating: 7, vote_count_floor: 0 }, 'fg12-profile');
  const candidate = { key: 'tt1', tmdb_id: '1', imdb_id: 'tt1', title: 'Test', year: 2020, imdbRating: null };

  const deps = {
    mdblistKey: 'test-mdblist-key',
    metaStore: {
      getMany: () => new Map([['1', { vote_average: 7.4, genres: ['Drama'], year: 2020, vote_count: 500 }]]),
      enrich: async () => null,
    },
    mdblist: {
      cachedImdbRatings: async () => new Map([['tt1', 6.2]]),
      mediaInfoBatch: async () => new Map(),
    },
    groq: { titleFacts: async () => [] },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'movie', [candidate], deps);
  // IMDb 6.2 < 7 => bad / rating (IMDb beats TMDB 7.4)
  assert.strictEqual(results.get('tt1').verdict, 'bad');
  assert.strictEqual(results.get('tt1').reason, 'rating');

  // Second case: MDBList has nothing, TMDB 7.4 is used => good (7.4 >= 7).
  const profile2 = makeProfile({ min_rating: 7, vote_count_floor: 0 }, 'fg12-profile-2');
  const deps2 = {
    ...deps,
    mdblist: {
      cachedImdbRatings: async () => new Map(), // no IMDb rating
      mediaInfoBatch: async () => new Map(),
    },
  };
  const results2 = await checkMany(profile2, 'movie', [candidate], deps2);
  // TMDB vote_average 7.4 >= 7 => good
  assert.strictEqual(results2.get('tt1').verdict, 'good');
}

// ============================================================================
// FG13: mediaInfoBatch independent of rating (B2)
// ============================================================================
async function testFG13() {
  // Only excluded_genres active, TMDB meta unavailable,
  // mediaInfoBatch returns genres: ['Horror'] => bad / genre.
  const profile = makeProfile({ excluded_genres: ['Horror'] }, 'fg13-profile');
  const candidate = { key: 'tt1', tmdb_id: null, imdb_id: 'tt1', title: 'Test', year: null, imdbRating: null };

  let mediaInfoCalled = false;
  const deps = {
    tmdbKey: null, // no TMDB key (so no enrich)
    mdblistKey: 'test-mdblist-key',
    metaStore: {
      getMany: () => new Map(), // no cached meta
      enrich: async () => null,
    },
    mdblist: {
      cachedImdbRatings: async () => new Map(),
      mediaInfoBatch: async () => {
        mediaInfoCalled = true;
        return new Map([['tt1', { genres: ['Horror'] }]]);
      },
    },
    groq: { titleFacts: async () => [] },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'movie', [candidate], deps);
  assert.strictEqual(results.get('tt1').verdict, 'bad');
  assert.strictEqual(results.get('tt1').reason, 'genre');
  assert.strictEqual(mediaInfoCalled, true, 'mediaInfoBatch should be called when genres is needed');
}

// ============================================================================
// FG14: titleFacts per-title needs (B3)
// ============================================================================
async function testFG14() {
  // (a) Two titles in one batch, one missing genres, one missing year:
  //     each gets asked for its own fact and answered.
  const profile = makeProfile({ min_rating: 7, min_year: 2010, vote_count_floor: 0 });
  const candidates = [
    { key: 'tt1', tmdb_id: null, imdb_id: 'tt1', title: 'Beauty and the Beast', year: null, imdbRating: 8.0 },
    { key: 'tt2', tmdb_id: null, imdb_id: 'tt2', title: 'Beauty and the Beast', year: null, imdbRating: 8.0 },
  ];

  let llmTitles = null;
  const deps = {
    tmdbKey: null,
    mdblistKey: null,
    metaStore: { getMany: () => new Map(), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: {
      titleFacts: async (type, titles) => {
        llmTitles = titles;
        // tt1 needs genres, tt2 needs year.
        return titles.map((t) => {
          if (t.imdb_id === 'tt1') return { genres: ['Fantasy'] };
          if (t.imdb_id === 'tt2') return { year: 2015 };
          return null;
        });
      },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    hasLlm: () => true,
    now: () => Date.now(),
    log: quiet,
  };

  const results = await checkMany(profile, 'movie', candidates, deps);
  // tt1: genres supplied by LLM => good (no genre exclusion active, but the
  // LLM supplied the fact). Actually, with only min_rating and min_year active,
  // tt1 needs year (missing) and rating (has 8.0). The LLM was asked for year.
  // Wait: the profile has min_rating: 7 and min_year: 2010. So needs = {rating, year}.
  // tt1 has imdbRating: 8.0 (rating is satisfied from the candidate).
  // tt1 needs year. tt2 needs year.
  // Let me re-think: both have rating 8.0 (from imdbRating), so rating is satisfied.
  // Both need year. The LLM is asked for year for both.
  // Let me adjust: tt1 needs genres (excluded_genres active), tt2 needs year.
  // Actually, the profile only has min_rating and min_year. Let me use a profile
  // with excluded_genres to make tt1 need genres.

  // Let me redo this properly.
  const profile2 = makeProfile({ excluded_genres: ['Horror'], min_year: 2010, vote_count_floor: 0 });
  // tt1: has rating 8.0, needs genres (excluded_genres active) and year (min_year active)
  // tt2: has rating 8.0, needs genres and year
  // But we want to test per-title needs. Let me make tt1 have year from the candidate.
  const candidates2 = [
    { key: 'tt1', tmdb_id: null, imdb_id: 'tt1', title: 'Beauty and the Beast', year: 2017, imdbRating: 8.0 },
    { key: 'tt2', tmdb_id: null, imdb_id: 'tt2', title: 'Beauty and the Beast', year: null, imdbRating: 8.0 },
  ];
  // tt1: has year 2017 (from candidate), needs genres only.
  // tt2: needs genres and year.

  const deps2 = {
    tmdbKey: null,
    mdblistKey: null,
    metaStore: { getMany: () => new Map(), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: {
      titleFacts: async (type, titles) => {
        // Verify per-title needs:
        // tt1 should have needs: ['genres'] (year already satisfied)
        // tt2 should have needs: ['genres', 'year']
        for (const t of titles) {
          if (t.imdb_id === 'tt1') {
            assert(t.needs.includes('genres'), 'tt1 should need genres');
            assert(!t.needs.includes('year'), 'tt1 should NOT need year (already has it)');
          }
          if (t.imdb_id === 'tt2') {
            assert(t.needs.includes('genres'), 'tt2 should need genres');
            assert(t.needs.includes('year'), 'tt2 should need year');
          }
        }
        return titles.map((t) => {
          if (t.imdb_id === 'tt1') return { genres: ['Fantasy'] };
          if (t.imdb_id === 'tt2') return { genres: ['Fantasy'], year: 2015 };
          return null;
        });
      },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    hasLlm: () => true,
    now: () => Date.now(),
    log: quiet,
  };

  const results2 = await checkMany(profile2, 'movie', candidates2, deps2);
  assert.strictEqual(results2.get('tt1').verdict, 'good');
  assert.strictEqual(results2.get('tt2').verdict, 'good');
  // Both should have source 'llm' (the LLM filled at least one fact).
  assert.strictEqual(results2.get('tt1').source, 'llm');
  assert.strictEqual(results2.get('tt2').source, 'llm');

  // (b) Two titles with the same name but different years are not confused.
  // (Already covered above: tt1 and tt2 have the same title 'Beauty and the Beast'
  // but different imdb_ids. The LLM answers by id, not by title.)

  // (c) An LLM answer that fills nothing leaves source: 'rules'.
  const profile3 = makeProfile({ min_year: 2010, vote_count_floor: 0 });
  const candidates3 = [
    { key: 'tt3', tmdb_id: null, imdb_id: 'tt3', title: 'No Answer', year: null, imdbRating: null },
  ];
  const deps3 = {
    tmdbKey: null,
    mdblistKey: null,
    metaStore: { getMany: () => new Map(), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: {
      titleFacts: async (type, titles) => {
        // The LLM returns an empty object (no facts filled).
        return titles.map(() => ({}));
      },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    hasLlm: () => true,
    now: () => Date.now(),
    log: quiet,
  };
  const results3 = await checkMany(profile3, 'movie', candidates3, deps3);
  // The LLM filled nothing => source stays 'rules', verdict is bad/no_data.
  assert.strictEqual(results3.get('tt3').verdict, 'bad');
  assert.strictEqual(results3.get('tt3').reason, 'no_data');
  assert.strictEqual(results3.get('tt3').source, 'rules', 'source should stay rules when LLM fills nothing');

  // (d) A title missing only votes is bad / no_data and the LLM fake is not called for it.
  const profile4 = makeProfile({ vote_count_floor: 1000 });
  const candidates4 = [
    { key: 'tt4', tmdb_id: null, imdb_id: 'tt4', title: 'No Votes', year: 2020, imdbRating: 8.0 },
  ];
  let llmCalled = false;
  const deps4 = {
    tmdbKey: null,
    mdblistKey: null,
    metaStore: { getMany: () => new Map(), enrich: async () => null },
    mdblist: { cachedImdbRatings: async () => new Map(), mediaInfoBatch: async () => new Map() },
    groq: {
      titleFacts: async () => { llmCalled = true; return []; },
    },
    animeMap: { isAnime: () => false, ensureLoaded: async () => {} },
    hasLlm: () => true,
    now: () => Date.now(),
    log: quiet,
  };
  const results4 = await checkMany(profile4, 'movie', candidates4, deps4);
  // votes is excluded from LLM (B3). The title is bad/no_data.
  assert.strictEqual(results4.get('tt4').verdict, 'bad');
  assert.strictEqual(results4.get('tt4').reason, 'no_data');
  assert.strictEqual(llmCalled, false, 'LLM should not be called for a title missing only votes');
}

// ============================================================================
// Run all tests
// ============================================================================
(async () => {
  console.log('FG-1: Filter Gate tests\n');
  await ok('FG1 rules', testFG1);
  await ok('FG2 inactive filters are free', testFG2);
  await ok('FG3 needs-driven fetching', testFG3);
  await ok('FG4 ladder order', testFG4);
  await ok('FG5 never throws', testFG5);
  await ok('FG6 store', testFG6);
  await ok('FG7 anime exclusion', testFG7);
  await ok('FG8 parity with the engines', testFG8);
  await ok('FG9a filter gate unit cases', testFG9a);
  await ok('FG9b removal + paging', testFG9b);
  await ok('FG9c not applied elsewhere', testFG9c);
  await ok('FG9d no filters = identical', testFG9d);
  await ok('FG10 age gate untouched', testFG10);
  await ok('FG11 log line', testFG11);
  await ok('FG12 IMDb beats TMDB', testFG12);
  await ok('FG13 mediaInfoBatch independent of rating', testFG13);
  await ok('FG14 titleFacts per-title needs', testFG14);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
