// AN-1b card 2a: decision log — storage + trending hooks.
// Run: node --experimental-sqlite test/anime-decisions.js
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an1b2a-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const decisionLog = require('../src/anime/decisionLog');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

(async () => {
  console.log('anime-decisions:');

  // ---- D1: record/list/counts ----
  await ok('D1: record/list/counts', async () => {
    const profileId = 'D1';
    const buildId = decisionLog.newBuildId();
    const rows = [
      { item_key: '1000', stage: 'engine', outcome: 'selected', title: 'Show A', source: 'simkl' },
      { item_key: '2000', stage: 'age', outcome: 'rejected_age', title: 'Show B', source: 'simkl' },
      { item_key: '3000', stage: 'llm', outcome: 'rejected_llm', title: 'Show C', source: 'simkl' },
      { item_key: '4000', stage: 'pool-cap', outcome: 'filtered', title: 'Show D', source: 'simkl' },
      { item_key: '5000', stage: 'no-tt', outcome: 'filtered', title: 'Cowboy Bebop', source: 'simkl' },
    ];
    decisionLog.record(profileId, 'anime', buildId, rows);

    const counts = decisionLog.counts(profileId, 'anime', buildId);
    assert.deepStrictEqual(counts, { selected: 1, rejected_age: 1, rejected_llm: 1, filtered: 2 });

    const { rows: listRows, total } = decisionLog.list(profileId, 'anime', {});
    assert.strictEqual(total, 5);
    assert.strictEqual(listRows[0].outcome, 'selected');
    assert.strictEqual(listRows[1].outcome, 'rejected_age');
    assert.strictEqual(listRows[2].outcome, 'rejected_llm');
    assert.strictEqual(listRows[3].outcome, 'filtered');
    assert.strictEqual(listRows[4].outcome, 'filtered');
    // Within filtered, title ascending: "Cowboy Bebop" < "Show D"
    assert.strictEqual(listRows[3].title, 'Cowboy Bebop');
    assert.strictEqual(listRows[4].title, 'Show D');

    const filtered = decisionLog.list(profileId, 'anime', { outcome: 'filtered' });
    assert.strictEqual(filtered.total, 2);

    const bebop = decisionLog.list(profileId, 'anime', { q: 'BEBOP' });
    assert.strictEqual(bebop.total, 1);
    assert.strictEqual(bebop.rows[0].title, 'Cowboy Bebop');

    const paged = decisionLog.list(profileId, 'anime', { limit: 1, offset: 1 });
    assert.strictEqual(paged.total, 5);
    assert.strictEqual(paged.rows.length, 1);
    assert.strictEqual(paged.rows[0].outcome, 'rejected_age');
  });

  // ---- D2: replace ----
  await ok('D2: replace — same key twice, second wins', async () => {
    const profileId = 'D2';
    const buildId = decisionLog.newBuildId();
    decisionLog.record(profileId, 'anime', buildId, [
      { item_key: '1000', stage: 'no-tt', outcome: 'filtered', title: 'First' },
      { item_key: '1000', stage: 'engine', outcome: 'selected', title: 'Second' },
    ]);
    const { rows, total } = decisionLog.list(profileId, 'anime', {});
    assert.strictEqual(total, 1);
    assert.strictEqual(rows[0].outcome, 'selected');
    assert.strictEqual(rows[0].title, 'Second');
  });

  // ---- D3: validation ----
  await ok('D3: validation — missing stage / bad outcome throws, writes nothing', async () => {
    const profileId = 'D3';
    const buildId = decisionLog.newBuildId();

    // Missing stage throws.
    let threw = false;
    try {
      decisionLog.record(profileId, 'anime', buildId, [{ item_key: '1', outcome: 'selected', title: 'X' }]);
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('stage'));
    }
    assert.ok(threw, 'missing stage throws');

    // Bad outcome throws.
    threw = false;
    try {
      decisionLog.record(profileId, 'anime', buildId, [{ item_key: '1', stage: 'engine', outcome: 'nope', title: 'X' }]);
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('outcome'));
    }
    assert.ok(threw, 'bad outcome throws');

    // 2 good rows + 1 bad in one call → transaction rolls back, list.total is 0.
    const buildId2 = decisionLog.newBuildId();
    threw = false;
    try {
      decisionLog.record(profileId, 'anime', buildId2, [
        { item_key: '1', stage: 'engine', outcome: 'selected', title: 'Good 1' },
        { item_key: '2', stage: 'no-tt', outcome: 'filtered', title: 'Good 2' },
        { item_key: '3', stage: 'engine', outcome: 'nope', title: 'Bad' },
      ]);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'bad row in batch throws');
    const { total } = decisionLog.list(profileId, 'anime', { build: buildId2 });
    assert.strictEqual(total, 0, 'rollback: nothing written');
  });

  // ---- D4: prune keeps 3 ----
  await ok('D4: prune keeps 3 — two oldest gone, other profile untouched', async () => {
    const profileId = 'D4';
    const otherProfileId = 'D4-other';
    // Record 5 builds for D4, 1 row each.
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = decisionLog.newBuildId();
      ids.push(id);
      decisionLog.record(profileId, 'anime', id, [{ item_key: `key-${i}`, stage: 'engine', outcome: 'selected', title: `Build ${i}` }]);
    }
    // Record 1 build for the other profile.
    const otherId = decisionLog.newBuildId();
    decisionLog.record(otherProfileId, 'anime', otherId, [{ item_key: 'other', stage: 'engine', outcome: 'selected', title: 'Other' }]);

    decisionLog.prune(profileId, 'anime');

    const builds = decisionLog.builds(profileId, 'anime');
    assert.strictEqual(builds.length, 3, '3 builds remain');
    // Newest first: ids[4], ids[3], ids[2]
    assert.strictEqual(builds[0].build_id, ids[4]);
    assert.strictEqual(builds[1].build_id, ids[3]);
    assert.strictEqual(builds[2].build_id, ids[2]);
    // The two oldest builds' rows are gone.
    const { total } = decisionLog.list(profileId, 'anime', { build: ids[0] });
    assert.strictEqual(total, 0, 'oldest build gone');
    const { total: t1 } = decisionLog.list(profileId, 'anime', { build: ids[1] });
    assert.strictEqual(t1, 0, 'second oldest gone');

    // Other profile's build is untouched.
    const otherBuilds = decisionLog.builds(otherProfileId, 'anime');
    assert.strictEqual(otherBuilds.length, 1);
    assert.strictEqual(otherBuilds[0].build_id, otherId);
  });

  // ---- D5: engine hooks ----
  await ok('D5: engine hooks — stages, source, TMDB naming, return value', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const profileId = 'D5';
    const simklItems = [
      { mal: 1, title: 'Show A', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 2, title: 'Show B', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 3, title: 'Show C', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 4, title: 'Show D', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 5, title: 'Show E', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 6, title: 'Movie F', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 7, title: 'Unmapped G', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
    ];
    const anilistItems = [
      { id: 100, idMal: 1, title: { english: 'Show A', romaji: 'Show A' }, averageScore: 80, genres: ['Action'] },
      { id: 200, idMal: 2, title: { english: 'Show B', romaji: 'Show B' }, averageScore: 80, genres: ['Action'] },
    ];
    const makeDeps = (withDecisions) => {
      const base = {
        simklList: () => simklItems,
        anilistList: (list, page) => {
          if (list === 'trending' && page === 1) return anilistItems;
          if (list === 'trending' && page === 2) return [];
          return [];
        },
        animeMap: {
          ensureLoaded: async () => {},
          byMal: (id) => {
            if (id === 1) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
            if (id === 2) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
            if (id === 3) return { tv: '3000', imdb: 'tt3000', type: 'TV' };
            if (id === 4) return { tv: '4000', imdb: 'tt4000', type: 'TV' };
            if (id === 5) return { tv: '5000', imdb: 'tt5000', type: 'TV' };
            if (id === 6) return { tv: '6000', imdb: 'tt6000', type: 'MOVIE' };
            return null;
          },
          byAnilist: (id) => {
            if (id === 100) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
            if (id === 200) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
            return null;
          },
        },
        listSize: () => 1, // target = 4
        tier: () => null,
        tvMeta: async () => new Map([
          ['1000', { title: 'TMDB Title A', year: 2021, poster: 'https://example.com/a.jpg' }],
          ['2000', { title: 'TMDB Title B', year: 2021, poster: 'https://example.com/b.jpg' }],
          ['3000', { title: 'TMDB Title C', year: 2021, poster: 'https://example.com/c.jpg' }],
          ['4000', { title: 'TMDB Title D', year: 2021, poster: 'https://example.com/d.jpg' }],
        ]),
      };
      if (withDecisions) base.decisions = decisionLog;
      return base;
    };

    const ctx = { log: console };
    const kept = await trending.build({ name: 'D5', id: profileId }, ctx, makeDeps(true));

    // The return value equals what it returns with no decisions dep.
    const keptNoSink = await trending.build({ name: 'D5', id: profileId }, { log: console }, makeDeps(false));
    assert.deepStrictEqual(kept, keptNoSink, 'return value identical with and without decisions');

    // Assert on decisionLog.list: one row of each stage.
    const { rows, total } = decisionLog.list(profileId, 'anime', {});
    assert.strictEqual(total, 7, '7 rows total');

    const noTt = rows.filter((r) => r.stage === 'no-tt');
    assert.strictEqual(noTt.length, 1, 'one no-tt row');
    assert.strictEqual(noTt[0].item_key, 'mal:7');
    assert.strictEqual(noTt[0].title, 'Unmapped G');
    assert.strictEqual(noTt[0].source, 'simkl');
    assert.strictEqual(noTt[0].reason, 'No TMDB show + IMDb id in the anime map');

    const format = rows.filter((r) => r.stage === 'format');
    assert.strictEqual(format.length, 1, 'one format row');
    assert.strictEqual(format[0].item_key, '6000');
    assert.strictEqual(format[0].title, 'Movie F');
    assert.strictEqual(format[0].source, 'simkl');
    assert.strictEqual(format[0].reason, 'Format MOVIE is not TV or ONA');

    const poolCap = rows.filter((r) => r.stage === 'pool-cap');
    assert.strictEqual(poolCap.length, 1, 'one pool-cap row');
    assert.strictEqual(poolCap[0].item_key, '5000');
    assert.strictEqual(poolCap[0].source, 'simkl');
    assert.ok(poolCap[0].reason.includes('Below the pool cut-off'));

    const engine = rows.filter((r) => r.stage === 'engine');
    assert.strictEqual(engine.length, 4, 'four engine rows');
    // selected rows carry the TMDB-named title and imdb_id
    const engA = engine.find((r) => r.item_key === '1000');
    assert.strictEqual(engA.title, 'TMDB Title A');
    assert.strictEqual(engA.imdb_id, 'tt1000');
    const engB = engine.find((r) => r.item_key === '2000');
    assert.strictEqual(engB.title, 'TMDB Title B');
    assert.strictEqual(engB.imdb_id, 'tt2000');
    // source is simkl+anilist for a show both lists contain
    assert.strictEqual(engA.source, 'simkl+anilist');
    assert.strictEqual(engB.source, 'simkl+anilist');
    // source is simkl for a show only in simkl
    const engC = engine.find((r) => r.item_key === '3000');
    assert.strictEqual(engC.source, 'simkl');
  });

  // ---- D6: logging never fails a build ----
  await ok('D6: logging never fails a build — record throws, build still returns', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const profileId = 'D6';
    const simklItems = [
      { mal: 1, title: 'Show A', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
      { mal: 2, title: 'Show B', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
    ];
    const badDecisionLog = {
      newBuildId: () => String(Date.now()),
      record: () => { throw new Error('DB down'); },
      prune: () => {},
    };
    const deps = {
      simklList: () => simklItems,
      anilistList: () => [],
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => {
          if (id === 1) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
          if (id === 2) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
          return null;
        },
        byAnilist: () => null,
      },
      listSize: () => 10,
      tier: () => null,
      tvMeta: async () => new Map(),
      decisions: badDecisionLog,
    };
    const warns = [];
    const log = { log: () => {}, warn: (m) => warns.push(m) };
    const cands = await trending.build({ name: 'D6', id: profileId }, { log }, deps);
    assert.strictEqual(cands.length, 2, 'candidates still returned');
    assert.ok(warns.some((m) => m.includes('decision log failed')), 'warn logged');
  });

  // ---- D7: no sink = no-op ----
  await ok('D7: no sink = no-op — build works, lane_decisions empty', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const profileId = 'D7';
    const simklItems = [
      { mal: 1, title: 'Show A', year: 2020, ratings: { mal: { rating: 7, votes: 10 } } },
    ];
    const deps = {
      simklList: () => simklItems,
      anilistList: () => [],
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => (id === 1 ? { tv: '1000', imdb: 'tt1000', type: 'TV' } : null),
        byAnilist: () => null,
      },
      listSize: () => 10,
      tier: () => null,
      tvMeta: async () => new Map(),
      // No decisions key.
    };
    const cands = await trending.build({ name: 'D7', id: profileId }, { log: console }, deps);
    assert.strictEqual(cands.length, 1, 'build works without decisions');
    const { total } = decisionLog.list(profileId, 'anime', {});
    assert.strictEqual(total, 0, 'lane_decisions empty for this profile');
  });

  console.log(`\nAll anime decision-log checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
