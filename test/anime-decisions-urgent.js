// AN-1b card 2b-2: decision log — urgent-path gate rows.
// Run: node --experimental-sqlite test/anime-decisions-urgent.js
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an1b2b2-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const decisionLog = require('../src/anime/decisionLog');
const rebuild = require('../src/rebuild');
const ageVerify = require('../src/ageVerification');
const rec = require('../src/recommendationStore');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

(async () => {
  console.log('anime-decisions-urgent:');

  const makeProfile = (id, ageLimit = 12) => ({
    id, name: 'Test ' + id, filters: { age_limit: ageLimit },
  });

  // Seed the pool with an anime row (recommendationStore's own storing function).
  const seedPoolAnime = (profileId, tmdbId, title) => {
    rec.upsertCandidates(profileId, [
      { type: 'anime', tmdb_id: String(tmdbId), imdb_id: 'tt' + tmdbId, title, year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
    ], { ratingCheckedAt: Date.now() });
  };

  // Seed the pool with a movie row.
  const seedPoolMovie = (profileId, tmdbId, title) => {
    rec.upsertCandidates(profileId, [
      { type: 'movie', tmdb_id: String(tmdbId), imdb_id: 'tt' + tmdbId, title, year: 2020, primary_genre: 'Action', genres: 'Action', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
    ], { ratingCheckedAt: Date.now() });
  };

  // Pre-seed the lane_decisions selected row.
  const seedDecisionRow = (profileId, buildId, tmdbId, title) => {
    decisionLog.record(profileId, 'anime', buildId, [{ item_key: String(tmdbId), stage: 'engine', outcome: 'selected', title }]);
  };

  const getRow = (profileId, buildId, tmdbId) => {
    const { rows } = decisionLog.list(profileId, 'anime', { build: buildId });
    return rows.find((r) => r.item_key === String(tmdbId));
  };

  // Stub rebuild.applyAnimeGate: dropKeys is Map<`${type}:${tmdb_id}`, info> —
  // titles in the map are dropped (onDrop called), the rest are returned.
  const stubApplyAnimeGate = (dropKeys) => {
    const original = rebuild.applyAnimeGate;
    rebuild.applyAnimeGate = async (metas, profile, log, onDrop) => {
      const out = [];
      for (const m of metas) {
        const info = dropKeys.get(m._rtype + ':' + String(m._tmdb_id));
        if (info) {
          if (onDrop) onDrop(m, info);
        } else {
          out.push(m);
        }
      }
      return out;
    };
    return () => { rebuild.applyAnimeGate = original; };
  };

  // Stub ageVerification.verify: verdictMap is Map<key, verdict> where key is
  // `${type}:${tmdb_id}`.
  const stubVerify = (verdictMap) => {
    const original = ageVerify.verify;
    ageVerify.verify = async (titles, type, tier, sources, log) => {
      const result = new Map();
      for (const t of titles) {
        const v = verdictMap.get(t.key);
        if (v) result.set(t.key, v);
      }
      return result;
    };
    return () => { ageVerify.verify = original; };
  };

  const log = { log: () => {}, warn: () => {}, error: () => {} };

  // ---- U1: MAL drop (urgent) ----
  await ok('U1: MAL drop — stage mal, rating mal:R, non-empty reason', async () => {
    const profileId = 'U1';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedPoolAnime(profileId, 1001, 'Anime A');
    seedPoolAnime(profileId, 1002, 'Anime B');
    seedDecisionRow(profileId, buildId, 1001, 'Anime A');
    seedDecisionRow(profileId, buildId, 1002, 'Anime B');

    const dropKeys = new Map([
      ['anime:1001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]);
    const unstub1 = stubApplyAnimeGate(dropKeys);
    const unstub2 = stubVerify(new Map());
    try {
      await rec.ageGatePool(profile, log, () => {}, { animeBuildId: buildId });

      const row1 = getRow(profileId, buildId, 1001);
      assert.strictEqual(row1.outcome, 'rejected_age');
      assert.strictEqual(row1.stage, 'mal');
      assert.strictEqual(row1.rating, 'mal:R');
      assert.ok(row1.reason && row1.reason.length > 0, 'non-empty reason');

      const row2 = getRow(profileId, buildId, 1002);
      assert.strictEqual(row2.outcome, 'selected', 'other row untouched');
      assert.strictEqual(row2.stage, 'engine');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- U2: chain block / allow / LLM block / unknown ----
  await ok('U2: chain block / allow / LLM block / unknown', async () => {
    const profileId = 'U2';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedPoolAnime(profileId, 3001, 'Anime D');
    seedPoolAnime(profileId, 3002, 'Anime E');
    seedPoolAnime(profileId, 3003, 'Anime F');
    seedPoolAnime(profileId, 3004, 'Anime G');
    seedDecisionRow(profileId, buildId, 3001, 'Anime D');
    seedDecisionRow(profileId, buildId, 3002, 'Anime E');
    seedDecisionRow(profileId, buildId, 3003, 'Anime F');
    seedDecisionRow(profileId, buildId, 3004, 'Anime G');

    const unstub1 = stubApplyAnimeGate(new Map());
    // lanes.verdictType('anime') = 'anime', so the key is anime:<tmdb_id>.
    const verdictMap = new Map([
      ['anime:3001', { verdict: 'block', source: 'csm', rating: '12' }],
      ['anime:3002', { verdict: 'allow', source: 'au', rating: 'PG' }],
      ['anime:3003', { verdict: 'block', source: 'llm', rating: 'no' }],
      // 3004: no verdict (unknown)
    ]);
    const unstub2 = stubVerify(verdictMap);
    try {
      await rec.ageGatePool(profile, log, () => {}, { animeBuildId: buildId });

      const row1 = getRow(profileId, buildId, 3001);
      assert.strictEqual(row1.outcome, 'rejected_age');
      assert.strictEqual(row1.stage, 'csm');
      assert.strictEqual(row1.rating, 'csm:12');
      assert.ok(row1.reason && row1.reason.length > 0);

      const row2 = getRow(profileId, buildId, 3002);
      assert.strictEqual(row2.outcome, 'selected', 'outcome stays selected');
      assert.strictEqual(row2.stage, 'au');
      assert.strictEqual(row2.rating, 'au:PG');
      assert.strictEqual(row2.reason, 'Allowed');

      const row3 = getRow(profileId, buildId, 3003);
      assert.strictEqual(row3.outcome, 'rejected_llm');
      assert.strictEqual(row3.stage, 'llm-last-resort');
      assert.strictEqual(row3.rating, 'llm');
      assert.ok(row3.reason && row3.reason.length > 0);

      const row4 = getRow(profileId, buildId, 3004);
      assert.strictEqual(row4.outcome, 'selected', 'outcome unchanged');
      assert.strictEqual(row4.stage, 'engine', 'stage unchanged');
      assert.strictEqual(row4.rating, null, 'rating unchanged');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- U3: other lanes ignored ----
  await ok('U3: other lanes ignored — movie row dropped writes nothing; same-id movie never touches the anime row', async () => {
    const profileId = 'U3';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    // Seed a movie row and an anime row with the same tmdb_id.
    seedPoolMovie(profileId, 5001, 'Movie X');
    seedPoolAnime(profileId, 5001, 'Anime X');
    seedDecisionRow(profileId, buildId, 5001, 'Anime X');

    // Drop the movie row (but not the anime row).
    const dropKeys = new Map([
      ['movie:5001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]);
    const unstub1 = stubApplyAnimeGate(dropKeys);
    const unstub2 = stubVerify(new Map());
    try {
      await rec.ageGatePool(profile, log, () => {}, { animeBuildId: buildId });

      // The movie row was dropped, but no movie decision row was written
      // (lane_decisions has no movie lane). The anime row is unchanged
      // (the movie drop never touched it).
      const { rows } = decisionLog.list(profileId, 'anime', { build: buildId });
      const animeRow = rows.find((r) => r.item_key === '5001');
      assert.strictEqual(animeRow.outcome, 'selected', 'anime row unchanged');
      assert.strictEqual(animeRow.stage, 'engine', 'anime row stage unchanged');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- U4: no build id = no logging ----
  await ok('U4: no build id = no logging — lane_decisions unchanged, applyAnimeGate called with 3 args', async () => {
    const profileId = 'U4';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedPoolAnime(profileId, 6001, 'Anime H');
    seedDecisionRow(profileId, buildId, 6001, 'Anime H');

    // Track the argument count of applyAnimeGate.
    let applyAnimeGateArgCount = null;
    const original = rebuild.applyAnimeGate;
    rebuild.applyAnimeGate = (...args) => {
      applyAnimeGateArgCount = args.length;
      return Promise.resolve(args[0]); // no drops
    };
    const unstub2 = stubVerify(new Map());
    try {
      // No opts → no animeBuildId → no logging.
      await rec.ageGatePool(profile, log, () => {});

      const row = getRow(profileId, buildId, 6001);
      assert.strictEqual(row.outcome, 'selected', 'row unchanged');
      assert.strictEqual(row.stage, 'engine', 'stage unchanged');
      assert.strictEqual(applyAnimeGateArgCount, 3, 'applyAnimeGate called with 3 args');
    } finally {
      rebuild.applyAnimeGate = original;
      unstub2();
    }
  });

  // ---- U5: return value identical ----
  await ok('U5: return value identical with and without animeBuildId', async () => {
    const profileId = 'U5';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);

    const seed = () => {
      rec.upsertCandidates(profileId, [
        { type: 'anime', tmdb_id: '7001', imdb_id: 'tt7001', title: 'Anime I', year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
        { type: 'anime', tmdb_id: '7002', imdb_id: 'tt7002', title: 'Anime J', year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
      ], { ratingCheckedAt: Date.now() });
      seedDecisionRow(profileId, buildId, 7001, 'Anime I');
      seedDecisionRow(profileId, buildId, 7002, 'Anime J');
    };

    const dropKeys = new Map([
      ['anime:7001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]);
    const unstub1 = stubApplyAnimeGate(dropKeys);
    const unstub2 = stubVerify(new Map([
      ['anime:7002', { verdict: 'block', source: 'csm', rating: '12' }],
    ]));
    try {
      seed();
      const r1 = await rec.ageGatePool(profile, log, () => {}, { animeBuildId: buildId });
      // Reset the pool (the first call dropped 7001 and 7002).
      rec.deleteForProfile(profileId);
      seed();
      const r2 = await rec.ageGatePool(profile, log, () => {});
      assert.deepStrictEqual(r1, r2, 'return values identical');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- U6: never fails a build ----
  await ok('U6: never fails a build — update throws, warn logged', async () => {
    const profileId = 'U6';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedPoolAnime(profileId, 9001, 'Anime K');
    seedDecisionRow(profileId, buildId, 9001, 'Anime K');

    const unstub1 = stubApplyAnimeGate(new Map([
      ['anime:9001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]));
    const unstub2 = stubVerify(new Map());

    // Make decisionLog.update throw.
    const originalUpdate = decisionLog.update;
    decisionLog.update = () => { throw new Error('DB down'); };

    const warns = [];
    const testLog = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };
    try {
      const r = await rec.ageGatePool(profile, testLog, () => {}, { animeBuildId: buildId });
      // The function still returns a result.
      assert.ok(r.dropped >= 0, 'result has dropped');
      assert.ok(r.vetoed >= 0, 'result has vetoed');
      assert.ok(r.remain >= 0, 'result has remain');
      assert.ok(warns.some((m) => m.includes('decision log (gate) failed')), 'warn logged');
    } finally {
      decisionLog.update = originalUpdate;
      unstub1();
      unstub2();
    }
  });

  // ---- U7: id plumbing ----
  await ok('U7: id plumbing — animeBuildId reaches ageGatePool', async () => {
    const engines = require('../src/engines');
    const config = require('../src/config');
    const settings = require('../src/settings');

    // Fake anime engine that sets ctx.animeBuildId and records decision rows
    // (mimicking the real trending engine's ctx.animeBuildId + sink.record).
    let engineBuildId = null;
    const fakeAnime = {
      id: 'fake-anime', name: 'Fake Anime', supportedTypes: ['anime'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate(profile, type, ctx) {
        engineBuildId = decisionLog.newBuildId();
        ctx.animeBuildId = engineBuildId;
        decisionLog.record(profile.id, 'anime', engineBuildId, [{ item_key: '9001', stage: 'engine', outcome: 'selected', title: 'Anime One' }]);
        ctx.stats = { seeds: 1, raw: 1, strong: 1, kept: 1 };
        return [
          { type: 'anime', tmdb_id: '9001', imdb_id: 'tt9001', title: 'Anime One', year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', popularity: 0 },
        ];
      },
      ALGORITHM_VERSION: 'fake-anime-v1',
    };
    // Fake movie engine that stores 1 row (so buildPool's stored > 0 and
    // ageGatePool is called).
    const fakeMovie = {
      id: 'fake-movie', name: 'Fake Movie', supportedTypes: ['movie'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate(profile, type, ctx) {
        ctx.stats = { seeds: 1, raw: 1, strong: 1, kept: 1 };
        return [
          { type: 'movie', tmdb_id: '8001', imdb_id: 'tt8001', title: 'Movie One', year: 2020, primary_genre: 'Action', genres: 'Action', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', popularity: 0 },
        ];
      },
      ALGORITHM_VERSION: 'fake-movie-v1',
    };
    const fakeSeries = {
      id: 'fake-series', name: 'Fake Series', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate() { return []; },
      ALGORITHM_VERSION: 'fake-series-v1',
    };
    const unregMovie = engines._register(fakeMovie);
    const unregSeries = engines._register(fakeSeries);
    const unregAnime = engines._register(fakeAnime);

    settings.updateSettings({ keys: { tmdb_api_key: 'test-tmdb-key' } });

    const p = config.addProfile('AN1B2B2-U7');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'fake-movie', engine_series: 'fake-series', engine_anime: 'fake-anime', age_limit: 12 } });
      const prof = config.getProfile(p.id);

      // Stub the gate to drop the anime row (so onDrop fires).
      const original = rebuild.applyAnimeGate;
      rebuild.applyAnimeGate = async (metas, profile, log, onDrop) => {
        const out = [];
        for (const m of metas) {
          if (m._rtype === 'anime') {
            if (onDrop) onDrop(m, { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' });
          } else {
            out.push(m);
          }
        }
        return out;
      };
      const unstubVerify = stubVerify(new Map());

      // Stub decisionLog.update to capture the buildId.
      const originalUpdate = decisionLog.update;
      let capturedBuildId = null;
      decisionLog.update = (profileId, lane, buildId, itemKey, patch) => {
        capturedBuildId = buildId;
        return true;
      };

      try {
        const r = await rec.buildPool(prof, log);
        // The animeBuildId that reached ageGatePool (via onDrop) equals the
        // build id the anime engine recorded in lane_decisions.
        assert.strictEqual(capturedBuildId, engineBuildId, 'animeBuildId matches the engine build id');
        // Also verify it's the id in lane_decisions.
        const builds = decisionLog.builds(p.id, 'anime');
        assert.ok(builds.some((b) => b.build_id === engineBuildId), 'lane_decisions has the build id');
      } finally {
        decisionLog.update = originalUpdate;
        rebuild.applyAnimeGate = original;
        unstubVerify();
      }
    } finally {
      config.removeProfile(p.id);
      unregMovie();
      unregSeries();
      unregAnime();
      settings.updateSettings({ keys: { tmdb_api_key: '' } });
    }
  });

  console.log(`\nAll anime decision-log urgent-path checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
