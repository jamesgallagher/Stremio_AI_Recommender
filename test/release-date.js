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

// ---- R10: markWatched with stubbed simkl + resolver returning a date ----
okAsync('R10: markWatched passes watched_at to Simkl body; result has watchedAt', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-10', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test', year: 2010 }, console);
    assert.strictEqual(result.ok, true);
    assert.ok(result.watchedAt, 'result has watchedAt');
    assert.ok(gotBody.movies[0].watched_at, 'Simkl body has watched_at');
  } finally {
    simkl.addToHistory = origHist;
  }
});

// ---- R11: markWatched when resolver throws: Simkl still called WITHOUT watched_at ----
okAsync('R11: markWatched resolver throws -> Simkl body has NO watched_at, result ok:true', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  try {
    const { markWatched } = require('../src/markWatched');
    // Force the resolver to throw by giving a profile with no TMDB key and no year
    // Actually, to force a throw from the resolver path, we monkey-patch releaseDate
    const releaseDate = require('../src/releaseDate');
    const origResolve = releaseDate.resolveReleaseDate;
    releaseDate.resolveReleaseDate = async () => { throw new Error('resolver boom'); };
    try {
      const profile = { id: 'wd1-11', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' } };
      const result = await markWatched(profile, { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
      assert.strictEqual(result.ok, true);
      assert.ok(!gotBody.movies[0].watched_at, 'no watched_at in body');
    } finally {
      releaseDate.resolveReleaseDate = origResolve;
    }
  } finally {
    simkl.addToHistory = origHist;
  }
});

// ---- R12: markWatched type anime is accepted and body goes under shows ----
okAsync('R12: markWatched type anime is accepted, body goes under shows', async () => {
  const simkl = require('../src/services/simkl');
  const origHist = simkl.addToHistory;
  let gotBody = null;
  simkl.addToHistory = async (_profile, body) => { gotBody = body; return {}; };
  try {
    const { markWatched } = require('../src/markWatched');
    const profile = { id: 'wd1-12', name: 'Test', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' } };
    const result = await markWatched(profile, { type: 'anime', imdbId: 'tt0133093', tmdbId: '603', title: 'Test' }, console);
    assert.strictEqual(result.ok, true);
    assert.ok(gotBody.shows.length === 1, 'body goes under shows');
    assert.deepStrictEqual(gotBody.movies, []);
  } finally {
    simkl.addToHistory = origHist;
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
