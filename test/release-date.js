// WD-1 — Release-date stamping when marking a title as viewed.
// Plain Node assert, injected fakes, no network.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-wd1-test-' + Date.now();
process.env.PORT = '7313';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
process.env.EXTERNAL_URL = '';

const assert = require('assert');
let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(` ✓ ${name}`); }
const asyncPending = [];
function okAsync(name, fn) { asyncPending.push({ name, fn }); }

const tmdb = require('../src/services/tmdb');

// ---- R1: buildWatchedHistoryBody movie with watchedAt ----
ok('R1: buildWatchedHistoryBody movie with watchedAt sets movies[0].watched_at', () => {
  const mw = require('../src/markWatched');
  const body = mw.buildWatchedHistoryBody({ type: 'movie', imdbId: 'tt0133093', tmdbId: '603', watchedAt: '2010-07-16T00:00:00Z' });
  assert.strictEqual(body.movies[0].watched_at, '2010-07-16T00:00:00Z');
  assert.deepStrictEqual(body.shows, []);
});

// ---- R2: buildWatchedHistoryBody series with watchedAt ----
ok('R2: buildWatchedHistoryBody series with watchedAt sets shows[0].watched_at, no seasons', () => {
  const mw = require('../src/markWatched');
  const body = mw.buildWatchedHistoryBody({ type: 'series', imdbId: 'tt0944947', watchedAt: '2005-03-01T00:00:00Z' });
  assert.strictEqual(body.shows[0].watched_at, '2005-03-01T00:00:00Z');
  assert.strictEqual(body.shows[0].seasons, undefined);
  assert.deepStrictEqual(body.movies, []);
});

// ---- R3: no watchedAt -> body deep-equals the old shape ----
ok('R3: buildWatchedHistoryBody without watchedAt is byte-identical to old shape', () => {
  const mw = require('../src/markWatched');
  const mov = mw.buildWatchedHistoryBody({ type: 'movie', imdbId: 'tt0133093', tmdbId: '603' });
  assert.deepStrictEqual(mov, { movies: [{ ids: { imdb: 'tt0133093', tmdb: '603' } }], shows: [] });
  assert.ok(!('watched_at' in mov.movies[0]), 'no watched_at when absent');
  const ser = mw.buildWatchedHistoryBody({ type: 'series', imdbId: 'tt0944947' });
  assert.deepStrictEqual(ser, { movies: [], shows: [{ ids: { imdb: 'tt0944947' } }] });
  assert.ok(!('seasons' in ser.shows[0]), 'no seasons');
});

// ---- R4: resolver movie returns date -> ISO for that day ----
ok('R4: resolveReleaseDate movie fake returns {date:"2010-07-16"} -> ISO for that day', async () => {
  const { resolveReleaseDate } = require('../src/releaseDate');
  const fetchDate = async () => ({ date: '2010-07-16', year: 2010 });
  const result = await resolveReleaseDate(
    { keys: { tmdb_api_key: 'test-key' } },
    { type: 'movie', imdbId: 'tt0133093', tmdbId: '603' },
    console,
    { fetchDate },
  );
  assert.strictEqual(result, '2010-07-16T00:00:00.000Z');
  assert.strictEqual(Date.parse(result), Date.UTC(2010, 6, 16));
});

// ---- R5: resolver type anime calls fetcher with type series ----
ok('R5: resolveReleaseDate type anime calls fetcher with type series', async () => {
  const { resolveReleaseDate } = require('../src/releaseDate');
  let fetchedType = null;
  const fetchDate = async (_apiKey, _type) => { fetchedType = _type; return { date: '2010-07-16', year: 2010 }; };
  const result = await resolveReleaseDate(
    { keys: { tmdb_api_key: 'test-key' } },
    { type: 'anime', imdbId: 'tt0133093' },
    console,
    { fetchDate },
  );
  assert.strictEqual(fetchedType, 'series');
  assert.strictEqual(result, '2010-07-16T00:00:00.000Z');
});

// ---- R6: fetcher returns null, caller passed year 1999 -> 1999-01-01 ----
ok('R6: resolveReleaseDate fetcher null + year 1999 -> 1999-01-01', async () => {
  const { resolveReleaseDate } = require('../src/releaseDate');
  const fetchDate = async () => ({ date: null, year: null });
  const result = await resolveReleaseDate(
    { keys: { tmdb_api_key: 'test-key' } },
    { type: 'movie', imdbId: 'tt0133093', year: 1999 },
    console,
    { fetchDate },
  );
  assert.strictEqual(result, '1999-01-01T00:00:00.000Z');
});

// ---- R7: no date, no year -> null ----
ok('R7: resolveReleaseDate no date, no year -> null', async () => {
  const { resolveReleaseDate } = require('../src/releaseDate');
  const fetchDate = async () => ({ date: null, year: null });
  const result = await resolveReleaseDate(
    { keys: { tmdb_api_key: 'test-key' } },
    { type: 'movie', imdbId: 'tt0133093' },
    console,
    { fetchDate },
  );
  assert.strictEqual(result, null);
});

// ---- R8: date one year after injected now -> returns injected now ISO ----
ok('R8: resolveReleaseDate future date clamps to injected now', async () => {
  const { resolveReleaseDate } = require('../src/releaseDate');
  const nowMs = Date.UTC(2026, 0, 1); // 2026-01-01
  const nowIso = new Date(nowMs).toISOString();
  const fetchDate = async () => ({ date: '2027-01-01', year: 2027 });
  const result = await resolveReleaseDate(
    { keys: { tmdb_api_key: 'test-key' } },
    { type: 'movie', imdbId: 'tt0133093' },
    console,
    { fetchDate, now: () => nowMs },
  );
  assert.strictEqual(result, nowIso);
});

// ---- R9: fetcher throws -> null (no throw) ----
ok('R9: resolveReleaseDate fetcher throws -> null, no throw', async () => {
  const { resolveReleaseDate } = require('../src/releaseDate');
  const fetchDate = async () => { throw new Error('TMDB down'); };
  const result = await resolveReleaseDate(
    { keys: { tmdb_api_key: 'test-key' } },
    { type: 'movie', imdbId: 'tt0133093' },
    console,
    { fetchDate },
  );
  assert.strictEqual(result, null);
});

// ---- R10: markWatched with monkey-patched tmdb.releaseDateFor ----
okAsync('R10: markWatched passes TMDB-resolved watched_at to Simkl body; result has watchedAt', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  const origReleaseDateFor = tmdb.releaseDateFor;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  tmdb.releaseDateFor = async () => ({ date: '2010-07-16', year: 2010 });
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-10', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.watchedAt, '2010-07-16T00:00:00.000Z');
    assert.strictEqual(gotBody.movies[0].watched_at, '2010-07-16T00:00:00.000Z');
  } finally {
    simkl.addToHistory = origHist;
    tmdb.releaseDateFor = origReleaseDateFor;
  }
});

// ---- R11: markWatched when resolver throws: Simkl still called WITHOUT watched_at ----
okAsync('R11: markWatched resolver throws -> Simkl body has NO watched_at, result ok:true', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  const origReleaseDateFor = tmdb.releaseDateFor;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  tmdb.releaseDateFor = async () => { throw new Error('TMDB down'); };
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-11', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
    assert.strictEqual(result.ok, true);
    assert.ok(!gotBody.movies[0].watched_at, 'no watched_at in body');
  } finally {
    simkl.addToHistory = origHist;
    tmdb.releaseDateFor = origReleaseDateFor;
  }
});

// ---- R12: markWatched type anime is accepted, body goes under shows, with watched_at ----
okAsync('R12: markWatched type anime is accepted, body goes under shows with watched_at', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  const origReleaseDateFor = tmdb.releaseDateFor;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  tmdb.releaseDateFor = async () => ({ date: '2008-01-20', year: 2008 });
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-12', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'anime', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
    assert.strictEqual(result.ok, true);
    assert.ok(gotBody.shows.length === 1, 'body goes under shows');
    assert.deepStrictEqual(gotBody.movies, []);
    assert.strictEqual(gotBody.shows[0].watched_at, '2008-01-20T00:00:00.000Z');
  } finally {
    simkl.addToHistory = origHist;
    tmdb.releaseDateFor = origReleaseDateFor;
  }
});

// ---- R14: stub returns null date, no year -> no watched_at, result ok:true ----
okAsync('R14: markWatched with null date and no year -> no watched_at, ok:true', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  const origReleaseDateFor = tmdb.releaseDateFor;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  tmdb.releaseDateFor = async () => ({ date: null, year: null });
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-14', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.watchedAt, null);
    assert.ok(!gotBody.movies[0].watched_at, 'no watched_at in body');
  } finally {
    simkl.addToHistory = origHist;
    tmdb.releaseDateFor = origReleaseDateFor;
  }
});

// ---- R15: stub returns future date -> clamped to now ----
okAsync('R15: markWatched with future date -> watched_at clamped to now', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  const origReleaseDateFor = tmdb.releaseDateFor;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  tmdb.releaseDateFor = async () => ({ date: '2999-01-01', year: 2999 });
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-15', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    const before = Date.now();
    const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
    const after = Date.now();
    assert.strictEqual(result.ok, true);
    assert.ok(result.watchedAt, 'watchedAt is set');
    const parsed = Date.parse(result.watchedAt);
    // Clamped to now: within 5 seconds of real now.
    assert.ok(parsed >= before - 5000 && parsed <= after + 5000, `watched_at ${result.watchedAt} should be within 5s of now`);
    assert.ok(!result.watchedAt.startsWith('2999'), 'not 2999');
  } finally {
    simkl.addToHistory = origHist;
    tmdb.releaseDateFor = origReleaseDateFor;
  }
});

// ---- R16: useReleaseDate:false -> resolver never called, no watched_at ----
okAsync('R16: markWatched with useReleaseDate:false -> no watched_at, resolver never called', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  const origReleaseDateFor = tmdb.releaseDateFor;
  let fetchCalled = false;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  tmdb.releaseDateFor = async () => { fetchCalled = true; return { date: '2010-07-16', year: 2010 }; };
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-16', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test', useReleaseDate: false }, console);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.watchedAt, null);
    assert.ok(!gotBody.movies[0].watched_at, 'no watched_at in body');
    assert.ok(!fetchCalled, 'tmdb.releaseDateFor was never called');
  } finally {
    simkl.addToHistory = origHist;
    tmdb.releaseDateFor = origReleaseDateFor;
  }
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
