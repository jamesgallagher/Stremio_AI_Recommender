// AGE-3c: AniDB warm-up tests.
// Run: node --experimental-sqlite test/anidb-warmup.js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-age3c-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const { warmUp, WARM_PER_TICK, WARM_DAILY_MAX, DEFAULT_DEPS } = require('../src/anime/anidbWarmup');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.error(`  \u2717 ${name}: ${e.message}`); }
}

// Fake-deps helper for W1-W7.
function mkDeps({ pool, map, cachedAids = [], today = 0, banned = null, results = {} }) {
  const calls = [];
  const cached = new Set(cachedAids);
  return {
    calls,
    deps: {
      animeMap: { ensureLoaded: async () => {}, lookup: (imdb) => map[imdb] || null },
      getPool: () => pool,
      settings: { resolveAnidbClient: () => ({ client: 'c', clientver: 1, source: 'server' }) },
      anidb: {
        cachedAnime: (aid) => (cached.has(aid) ? { aid } : null),
        clientStatus: () => ({ today: today + calls.filter((c) => c.net).length, banned_until: banned }),
        getAnime: async (aid) => {
          const r = results[aid] || { data: { aid } };
          calls.push({ aid, net: !!r.data && !r.cached });
          if (r.data && !r.cached) cached.add(aid);
          return r;
        },
      },
    },
  };
}

const profile = (id) => ({ id, name: 'Test ' + id, filters: { engine_anime: 'on' } });

(async () => {
  console.log('anidb-warmup:');

  // W1: candidates — 6 pool rows: 2 cached, 1 no AniDB id, 3 uncached.
  await ok('W1 candidates', async () => {
    const pool = [
      { tmdb_id: 1, imdb_id: 'tt1' },
      { tmdb_id: 2, imdb_id: 'tt2' },
      { tmdb_id: 3, imdb_id: 'tt3' },
      { tmdb_id: 4, imdb_id: 'tt4' },
      { tmdb_id: 5, imdb_id: 'tt5' },
      { tmdb_id: 6, imdb_id: 'tt6' },
    ];
    const map = { tt1: { anidb: 100 }, tt2: { anidb: 200 }, tt3: null, tt4: { anidb: 400 }, tt5: { anidb: 500 }, tt6: { anidb: 600 } };
    const { calls, deps } = mkDeps({ pool, map, cachedAids: [100, 200] });
    const r = await warmUp(profile('w1'), { deps });
    assert.deepStrictEqual(r, { fetched: 3, cached: 2, pending: 0, stopped: null });
    assert.deepStrictEqual(calls.map((c) => c.aid), [400, 500, 600]);
  });

  // W2: per-tick cap and continuation — 25 uncached.
  await ok('W2 per-tick cap and continuation', async () => {
    const pool = Array.from({ length: 25 }, (_, i) => ({ tmdb_id: i + 1, imdb_id: 'tt' + (i + 1) }));
    const map = {};
    for (let i = 0; i < 25; i++) map['tt' + (i + 1)] = { anidb: 1000 + i };
    const { calls, deps } = mkDeps({ pool, map });
    const r1 = await warmUp(profile('w2a'), { deps });
    assert.strictEqual(r1.fetched, 10);
    assert.strictEqual(r1.pending, 15);
    assert.deepStrictEqual(calls.map((c) => c.aid), Array.from({ length: 10 }, (_, i) => 1000 + i));
    const r2 = await warmUp(profile('w2b'), { deps });
    assert.strictEqual(r2.fetched, 10);
    assert.strictEqual(r2.pending, 5);
    assert.deepStrictEqual(calls.slice(10).map((c) => c.aid), Array.from({ length: 10 }, (_, i) => 1010 + i));
    const r3 = await warmUp(profile('w2c'), { deps });
    assert.strictEqual(r3.fetched, 5);
    assert.strictEqual(r3.pending, 0);
    assert.deepStrictEqual(calls.slice(20).map((c) => c.aid), Array.from({ length: 5 }, (_, i) => 1020 + i));
  });

  // W3: daily headroom.
  await ok('W3 daily headroom', async () => {
    const pool = [{ tmdb_id: 1, imdb_id: 'tt1' }, { tmdb_id: 2, imdb_id: 'tt2' }];
    const map = { tt1: { anidb: 1 }, tt2: { anidb: 2 } };
    // today: 100 → headroom 0
    let { calls, deps } = mkDeps({ pool, map, today: 100 });
    let r = await warmUp(profile('w3a'), { deps });
    assert.strictEqual(r.stopped, 'daily-limit');
    assert.strictEqual(calls.length, 0);
    // today: 95 → headroom 5, but only 2 candidates
    ({ calls, deps } = mkDeps({ pool, map, today: 95 }));
    r = await warmUp(profile('w3b'), { deps });
    assert.strictEqual(r.fetched, 2);
    assert.strictEqual(calls.length, 2);
  });

  // W4: stop conditions.
  await ok('W4 stop conditions', async () => {
    const pool = [{ tmdb_id: 1, imdb_id: 'tt1' }, { tmdb_id: 2, imdb_id: 'tt2' }, { tmdb_id: 3, imdb_id: 'tt3' }];
    const map = { tt1: { anidb: 1 }, tt2: { anidb: 2 }, tt3: { anidb: 3 } };
    // banned
    let { calls, deps } = mkDeps({ pool, map, banned: Date.now() + 3600e3 });
    let r = await warmUp(profile('w4a'), { deps });
    assert.strictEqual(r.stopped, 'banned');
    assert.strictEqual(calls.length, 0);
    // cap on 2nd id
    ({ calls, deps } = mkDeps({ pool, map, results: { 2: { skipped: 'cap' } } }));
    r = await warmUp(profile('w4b'), { deps });
    assert.strictEqual(r.stopped, 'cap');
    assert.strictEqual(calls.length, 2);
    // banned on 2nd id
    ({ calls, deps } = mkDeps({ pool, map, results: { 2: { skipped: 'banned' } } }));
    r = await warmUp(profile('w4c'), { deps });
    assert.strictEqual(r.stopped, 'banned');
    assert.strictEqual(calls.length, 2);
    // no-client on 2nd id
    ({ calls, deps } = mkDeps({ pool, map, results: { 2: { skipped: 'no-client' } } }));
    r = await warmUp(profile('w4d'), { deps });
    assert.strictEqual(r.stopped, 'no-client');
    assert.strictEqual(calls.length, 2);
  });

  // W5: errors and repeats.
  await ok('W5 errors and repeats', async () => {
    const pool = [
      { tmdb_id: 1, imdb_id: 'tt1' },
      { tmdb_id: 2, imdb_id: 'tt2' },
      { tmdb_id: 3, imdb_id: 'tt3' },
      { tmdb_id: 4, imdb_id: 'tt4' },
      { tmdb_id: 5, imdb_id: 'tt5' },
    ];
    const map = { tt1: { anidb: 1 }, tt2: { anidb: 2 }, tt3: { anidb: 3 }, tt4: { anidb: 4 }, tt5: { anidb: 5 } };
    const { calls, deps } = mkDeps({ pool, map, results: { 2: { error: 'timeout' }, 3: { skipped: 'repeat' } } });
    const r = await warmUp(profile('w5'), { deps });
    // ids 1, 4, 5 fetched; ids 2 and 3 stay pending
    assert.strictEqual(r.fetched, 3);
    assert.strictEqual(r.pending, 2);
    assert.strictEqual(r.stopped, null);
    assert.deepStrictEqual(calls.map((c) => c.aid), [1, 2, 3, 4, 5]);
  });

  // W11: a rejected client name stops the run at once (no hammering AniDB every tick).
  await ok('W11 client error stops the run', async () => {
    const pool = [1, 2, 3, 4].map((n) => ({ tmdb_id: n, imdb_id: 'tt' + n }));
    const map = { tt1: { anidb: 1 }, tt2: { anidb: 2 }, tt3: { anidb: 3 }, tt4: { anidb: 4 } };
    const { calls, deps } = mkDeps({ pool, map, results: { 1: { error: 'client' } } });
    const r = await warmUp(profile('w11'), { deps });
    assert.strictEqual(r.stopped, 'client');
    assert.deepStrictEqual(calls.map((c) => c.aid), [1], 'only one call was made');
    assert.strictEqual(r.fetched, 0);
  });

  // W12: three consecutive failures stop the run; a success in between resets the count.
  await ok('W12 three consecutive errors stop the run', async () => {
    const pool = [1, 2, 3, 4, 5, 6].map((n) => ({ tmdb_id: n, imdb_id: 'tt' + n }));
    const map = { tt1: { anidb: 1 }, tt2: { anidb: 2 }, tt3: { anidb: 3 }, tt4: { anidb: 4 }, tt5: { anidb: 5 }, tt6: { anidb: 6 } };
    let m = mkDeps({ pool, map, results: { 1: { error: 'timeout' }, 2: { error: 'timeout' }, 3: { error: 'timeout' } } });
    let r = await warmUp(profile('w12a'), { deps: m.deps });
    assert.strictEqual(r.stopped, 'errors');
    assert.deepStrictEqual(m.calls.map((c) => c.aid), [1, 2, 3], 'stopped after the third failure');
    // error, success, error, error: the success resets the run, so it does NOT stop.
    m = mkDeps({ pool, map, results: { 1: { error: 'timeout' }, 3: { error: 'timeout' }, 4: { error: 'timeout' } } });
    r = await warmUp(profile('w12b'), { deps: m.deps });
    assert.strictEqual(r.stopped, null);
    assert.deepStrictEqual(m.calls.map((c) => c.aid), [1, 2, 3, 4, 5, 6]);
  });

  // W6: off / no client.
  await ok('W6 off / no client', async () => {
    const pool = [{ tmdb_id: 1, imdb_id: 'tt1' }];
    const map = { tt1: { anidb: 1 } };
    // engine off
    let { calls, deps } = mkDeps({ pool, map });
    let r = await warmUp({ id: 'w6a', name: 'Test w6a', filters: { engine_anime: 'off' } }, { deps });
    assert.strictEqual(r.stopped, 'engine-off');
    assert.strictEqual(calls.length, 0);
    // no client
    const noClientDeps = {
      animeMap: { ensureLoaded: async () => {}, lookup: () => ({ anidb: 1 }) },
      getPool: () => pool,
      settings: { resolveAnidbClient: () => ({ client: '', clientver: 0, source: 'none' }) },
      anidb: { cachedAnime: () => null, clientStatus: () => ({ today: 0, banned_until: null }), getAnime: async () => ({ data: { aid: 1 } }) },
    };
    r = await warmUp(profile('w6b'), { deps: noClientDeps });
    assert.strictEqual(r.stopped, 'no-client');
  });

  // W7: never throws.
  await ok('W7 never throws', async () => {
    const logLines = [];
    const log = { log: (l) => logLines.push(l), warn: (l) => logLines.push(l), error: (l) => logLines.push(l) };
    const deps = {
      animeMap: { ensureLoaded: async () => {}, lookup: () => ({ anidb: 1 }) },
      getPool: () => { throw new Error('db exploded'); },
      settings: { resolveAnidbClient: () => ({ client: 'c', clientver: 1, source: 'server' }) },
      anidb: { cachedAnime: () => null, clientStatus: () => ({ today: 0, banned_until: null }), getAnime: async () => ({ data: { aid: 1 } }) },
    };
    const r = await warmUp(profile('w7'), { log, deps });
    assert.strictEqual(r.stopped, 'error');
    assert.strictEqual(r.fetched, 0);
    assert.ok(logLines.some((l) => l.includes('warm-up') && l.includes('failed')));
  });

  // W8: real AniDB service, fake clock, no real waiting.
  await ok('W8 real AniDB service', async () => {
    const anidb = require('../src/services/anidb');
    anidb.init();
    anidb._resetForTests();

    let t = 1_000_000;
    anidb._setNow(() => (t += 1000));

    const fetches = [];
    const xml = (aid) => `<anime id="${aid}" restricted="false"><type>TV Series</type><episodecount>12</episodecount><title xml:lang="x-jat" type="main">T</title><permanent>8.0</permanent><tags><tag id="2749" parentid="2604" weight="400"><name>nudity</name></tag></tags></anime>`;
    anidb._setFetch(async (url) => {
      const aidMatch = url.match(/aid=(\d+)/);
      const aid = Number(aidMatch[1]);
      fetches.push({ url, at: t });
      return { status: 200, text: async () => xml(aid) };
    });

    const profileW8 = { id: 'w8', name: 'W8', filters: { engine_anime: 'on' }, keys: { anidb_client: 'warm', anidb_clientver: 1 } };
    const pool = [
      { tmdb_id: 1, imdb_id: 'tt1' },
      { tmdb_id: 2, imdb_id: 'tt2' },
      { tmdb_id: 3, imdb_id: 'tt3' },
    ];
    const map = { tt1: { anidb: 101 }, tt2: { anidb: 202 }, tt3: { anidb: 303 } };
    const deps = {
      anidb,
      animeMap: { ensureLoaded: async () => {}, lookup: (imdb) => map[imdb] || null },
      getPool: () => pool,
      settings: require('../src/settings'),
    };

    const r1 = await warmUp(profileW8, { deps });
    assert.strictEqual(r1.fetched, 3);
    assert.strictEqual(r1.cached, 0);
    assert.strictEqual(r1.pending, 0);
    assert.strictEqual(r1.stopped, null);
    assert.strictEqual(fetches.length, 3);

    // Gaps between consecutive fetches are each >= 4000 in the fake clock.
    for (let i = 1; i < fetches.length; i++) {
      assert.ok(fetches[i].at - fetches[i - 1].at >= 4000, `gap ${i}: ${fetches[i].at - fetches[i - 1].at}`);
    }

    // Verify cachedAnime gives content.nudity === 400.
    for (const aid of [101, 202, 303]) {
      const cached = anidb.cachedAnime(aid);
      assert.ok(cached, `cachedAnime(${aid}) is null`);
      assert.strictEqual(cached.content.nudity, 400);
    }

    // clientStatus today === 3.
    const st = anidb.clientStatus(profileW8);
    assert.strictEqual(st.today, 3);

    // Second warmUp makes zero fetches (all cached).
    const fetchesBefore = fetches.length;
    const r2 = await warmUp(profileW8, { deps });
    assert.strictEqual(r2.fetched, 0);
    assert.strictEqual(r2.cached, 3);
    assert.strictEqual(r2.pending, 0);
    assert.strictEqual(fetches.length, fetchesBefore);

    anidb._resetClock();
  });

  // W9: wiring guard — server.js contains the warm-up call in the right position.
  await ok('W9 wiring guard', async () => {
    const serverPath = path.join(__dirname, '..', 'src', 'server.js');
    const src = fs.readFileSync(serverPath, 'utf8');
    const warmupIdx = src.indexOf("require('./anime/anidbWarmup').warmUp(profile)");
    assert.ok(warmupIdx >= 0, 'warmUp call not found in server.js');
    const considerIdx = src.indexOf('aiSchedule.consider(');
    assert.ok(considerIdx >= 0, 'aiSchedule.consider( not found');
    const decayIdx = src.indexOf('applyDecay(');
    assert.ok(decayIdx >= 0, 'applyDecay( not found');
    assert.ok(warmupIdx > considerIdx, 'warmUp should be after aiSchedule.consider(');
    assert.ok(warmupIdx < decayIdx, 'warmUp should be before applyDecay(');
  });

  // W10: evidence integration — warmed title has anidb content, unwarmed does not.
  await ok('W10 evidence integration', async () => {
    const anidb = require('../src/services/anidb');
    anidb.init();
    anidb._resetForTests();

    let t = 2_000_000;
    anidb._setNow(() => (t += 1000));
    const xml = (aid) => `<anime id="${aid}" restricted="false"><type>TV Series</type><episodecount>12</episodecount><title xml:lang="x-jat" type="main">T</title><permanent>8.0</permanent><tags><tag id="2749" parentid="2604" weight="400"><name>nudity</name></tag></tags></anime>`;
    anidb._setFetch(async (url) => {
      const aidMatch = url.match(/aid=(\d+)/);
      const aid = Number(aidMatch[1]);
      return { status: 200, text: async () => xml(aid) };
    });

    const profileW10 = { id: 'w10', name: 'W10', filters: { engine_anime: 'on' }, keys: { anidb_client: 'warm', anidb_clientver: 1 } };
    const pool = [{ tmdb_id: 1, imdb_id: 'tt1' }];
    const map = { tt1: { anidb: 500 } };
    const deps = {
      anidb,
      animeMap: { ensureLoaded: async () => {}, lookup: (imdb) => map[imdb] || null },
      getPool: () => pool,
      settings: require('../src/settings'),
    };
    await warmUp(profileW10, { deps });

    // Now gather evidence for a warmed title and an unwarmed title.
    const evidence = require('../src/anime/evidence');
    const titles = [
      { key: 'k1', tmdb_id: 1, imdb_id: 'tt1', title: 'Warmed', genres: [] },
      { key: 'k2', tmdb_id: 2, imdb_id: 'tt2', title: 'Unwarmed', genres: [] },
    ];
    const evDeps = {
      animeMap: { ensureLoaded: async () => {}, lookup: (imdb, tmdb) => {
        if (imdb === 'tt1') return { anidb: 500, mal: null, kitsu: null, anilist: null };
        if (imdb === 'tt2') return { anidb: 999, mal: null, kitsu: null, anilist: null };
        return null;
      } },
      mal: { cachedVerdict: () => null },
      kitsu: { cached: () => new Map() },
      anidb,
      anilist: { tagsFor: async () => new Map() },
    };
    const ev = await evidence.gather(titles, console, evDeps);
    const ev1 = ev.get('k1');
    assert.ok(ev1.anidb, 'warmed title should have anidb evidence');
    assert.strictEqual(ev1.anidb.content.nudity, 400);
    const ev2 = ev.get('k2');
    assert.strictEqual(ev2.anidb, null, 'unwarmed title should have null anidb');

    anidb._resetClock();
  });

  console.log(`\nAll anidb warm-up checks passed (${passed}).`);
  if (failed > 0) {
    console.error(`${failed} check(s) failed.`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
