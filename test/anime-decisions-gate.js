// AN-1b card 2b: decision log — age-gate rows.
// Run: node --experimental-sqlite test/anime-decisions-gate.js
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an1b2b-' + Date.now();
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
  console.log('anime-decisions-gate:');

  const makeProfile = (id, ageLimit = 12) => ({
    id, name: 'Test ' + id, filters: { age_limit: ageLimit },
  });

  const seedRow = (profileId, buildId, tmdbId, title) => {
    decisionLog.record(profileId, 'anime', buildId, [{ item_key: String(tmdbId), stage: 'engine', outcome: 'selected', title }]);
  };

  const getRow = (profileId, buildId, tmdbId) => {
    const { rows } = decisionLog.list(profileId, 'anime', { build: buildId });
    return rows.find((r) => r.item_key === String(tmdbId));
  };

  // Stub rebuild.applyAnimeGate: dropMap is Map<tmdb_id, info> — titles in the
  // map are dropped (onDrop called), the rest are returned.
  const stubApplyAnimeGate = (dropMap) => {
    const original = rebuild.applyAnimeGate;
    rebuild.applyAnimeGate = async (metas, profile, log, onDrop) => {
      const out = [];
      for (const m of metas) {
        const info = dropMap.get(String(m._tmdb_id));
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

  // ---- G1: MAL drop ----
  await ok('G1: MAL drop — stage mal, rating mal:R, non-empty reason', async () => {
    const profileId = 'G1';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 1001, 'Anime A');
    seedRow(profileId, buildId, 1002, 'Anime B');

    const dropMap = new Map([
      ['1001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]);
    const unstub1 = stubApplyAnimeGate(dropMap);
    const unstub2 = stubVerify(new Map());
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [
          { tmdb_id: '1001', imdb_id: 'tt1001', title: 'Anime A' },
          { tmdb_id: '1002', imdb_id: 'tt1002', title: 'Anime B' },
        ],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

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

  // ---- G2: NSFW drop ----
  await ok('G2: NSFW drop — stage nsfw, rejected_age', async () => {
    const profileId = 'G2';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 2001, 'Anime C');

    const dropMap = new Map([
      ['2001', { outcome: 'rejected_age', stage: 'nsfw', rating: 'mal:flagged', reason: 'Adult-rated (permanently blocked)' }],
    ]);
    const unstub1 = stubApplyAnimeGate(dropMap);
    const unstub2 = stubVerify(new Map());
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '2001', imdb_id: 'tt2001', title: 'Anime C' }],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

      const row = getRow(profileId, buildId, 2001);
      assert.strictEqual(row.outcome, 'rejected_age');
      assert.strictEqual(row.stage, 'nsfw');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G3: chain block (csm/12) ----
  await ok('G3: chain block csm/12 — rejected_age, stage csm, rating csm:12', async () => {
    const profileId = 'G3';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 3001, 'Anime D');

    const unstub1 = stubApplyAnimeGate(new Map());
    // lanes.lookupType('anime') = 'series', so the key is series:<tmdb_id>.
    const verdictMap = new Map([
      ['series:3001', { verdict: 'block', source: 'csm', rating: '12' }],
    ]);
    const unstub2 = stubVerify(verdictMap);
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '3001', imdb_id: 'tt3001', title: 'Anime D' }],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

      const row = getRow(profileId, buildId, 3001);
      assert.strictEqual(row.outcome, 'rejected_age');
      assert.strictEqual(row.stage, 'csm');
      assert.strictEqual(row.rating, 'csm:12');
      assert.ok(row.reason && row.reason.length > 0);
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G4: LLM block ----
  await ok('G4: LLM block — rejected_llm, stage llm-last-resort, rating llm', async () => {
    const profileId = 'G4';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 4001, 'Anime E');

    const unstub1 = stubApplyAnimeGate(new Map());
    const verdictMap = new Map([
      ['series:4001', { verdict: 'block', source: 'llm', rating: 'no' }],
    ]);
    const unstub2 = stubVerify(verdictMap);
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '4001', imdb_id: 'tt4001', title: 'Anime E' }],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

      const row = getRow(profileId, buildId, 4001);
      assert.strictEqual(row.outcome, 'rejected_llm');
      assert.strictEqual(row.stage, 'llm-last-resort');
      assert.strictEqual(row.rating, 'llm');
      assert.ok(row.reason && row.reason.length > 0);
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G5: chain allow (au/PG) ----
  await ok('G5: chain allow au/PG — outcome stays selected, stage au, rating au:PG', async () => {
    const profileId = 'G5';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 5001, 'Anime F');

    const unstub1 = stubApplyAnimeGate(new Map());
    const verdictMap = new Map([
      ['series:5001', { verdict: 'allow', source: 'au', rating: 'PG' }],
    ]);
    const unstub2 = stubVerify(verdictMap);
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '5001', imdb_id: 'tt5001', title: 'Anime F' }],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

      const row = getRow(profileId, buildId, 5001);
      assert.strictEqual(row.outcome, 'selected', 'outcome stays selected');
      assert.strictEqual(row.stage, 'au');
      assert.strictEqual(row.rating, 'au:PG');
      assert.strictEqual(row.reason, 'Allowed');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G6: unknown verdict → row unchanged ----
  await ok('G6: unknown verdict — row unchanged', async () => {
    const profileId = 'G6';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 6001, 'Anime G');

    const unstub1 = stubApplyAnimeGate(new Map());
    // No verdict for anime:6001 (unknown).
    const unstub2 = stubVerify(new Map());
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '6001', imdb_id: 'tt6001', title: 'Anime G' }],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

      const row = getRow(profileId, buildId, 6001);
      assert.strictEqual(row.outcome, 'selected', 'outcome unchanged');
      assert.strictEqual(row.stage, 'engine', 'stage unchanged');
      assert.strictEqual(row.rating, null, 'rating unchanged');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G7: return value identical with and without animeBuildId ----
  await ok('G7: return value identical with and without animeBuildId', async () => {
    const profileId = 'G7';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 7001, 'Anime H');
    seedRow(profileId, buildId, 7002, 'Anime I');

    const unstub1 = stubApplyAnimeGate(new Map([
      ['7001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]));
    const unstub2 = stubVerify(new Map([
      ['series:7002', { verdict: 'block', source: 'csm', rating: '12' }],
    ]));
    try {
      const makeStaged = () => ({
        movie: [],
        series: [],
        anime: [
          { tmdb_id: '7001', imdb_id: 'tt7001', title: 'Anime H' },
          { tmdb_id: '7002', imdb_id: 'tt7002', title: 'Anime I' },
        ],
      });

      const r1 = await rec.stagedAgeGate(profile, makeStaged(), log, () => {}, { animeBuildId: buildId });
      const r2 = await rec.stagedAgeGate(profile, makeStaged(), log, () => {});

      assert.deepStrictEqual(r1, r2, 'return values identical');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G8: no build id = no logging ----
  await ok('G8: no build id = no logging — lane_decisions unchanged', async () => {
    const profileId = 'G8';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 8001, 'Anime J');

    const unstub1 = stubApplyAnimeGate(new Map([
      ['8001', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 band' }],
    ]));
    const unstub2 = stubVerify(new Map());
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '8001', imdb_id: 'tt8001', title: 'Anime J' }],
      };
      // No opts → no animeBuildId → no logging.
      await rec.stagedAgeGate(profile, stagedByType, log, () => {});

      const row = getRow(profileId, buildId, 8001);
      assert.strictEqual(row.outcome, 'selected', 'row unchanged');
      assert.strictEqual(row.stage, 'engine', 'stage unchanged');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- G9: never fails a build — update throws ----
  await ok('G9: never fails a build — update throws, warn logged', async () => {
    const profileId = 'G9';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 9001, 'Anime K');

    // No step 1 drops; step 2 will trigger the update.
    const unstub1 = stubApplyAnimeGate(new Map());
    const unstub2 = stubVerify(new Map([
      ['series:9001', { verdict: 'block', source: 'csm', rating: '12' }],
    ]));

    // Make decisionLog.update throw.
    const originalUpdate = decisionLog.update;
    decisionLog.update = () => { throw new Error('DB down'); };

    const warns = [];
    const testLog = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [{ tmdb_id: '9001', imdb_id: 'tt9001', title: 'Anime K' }],
      };
      const r = await rec.stagedAgeGate(profile, stagedByType, testLog, () => {}, { animeBuildId: buildId });
      // The function still returns a result.
      assert.ok(r.anime !== undefined, 'result has anime');
      assert.ok(warns.some((m) => m.includes('decision log (gate) failed')), 'warn logged');
    } finally {
      decisionLog.update = originalUpdate;
      unstub1();
      unstub2();
    }
  });

  // ---- G10: movie/series untouched ----
  await ok('G10: movie/series untouched — no row written, applyAnimeGate called with 3 args', async () => {
    const profileId = 'G10';
    const buildId = decisionLog.newBuildId();
    const profile = makeProfile(profileId, 12);
    seedRow(profileId, buildId, 10001, 'Anime L');

    // Track whether onDrop was passed for the movie type.
    let movieOnDropPassed = null;
    const original = rebuild.applyAnimeGate;
    rebuild.applyAnimeGate = async (metas, profile, log, onDrop) => {
      const type = metas[0] && metas[0]._rtype;
      if (type === 'movie') movieOnDropPassed = (onDrop !== undefined && onDrop !== null);
      // Drop the movie title (but onDrop is null for movie, so no drop callback).
      const out = metas.filter((m) => m._rtype !== 'movie');
      return out;
    };
    const unstub2 = stubVerify(new Map());
    try {
      const stagedByType = {
        movie: [{ tmdb_id: '10002', imdb_id: 'tt10002', title: 'Movie M' }],
        series: [],
        anime: [{ tmdb_id: '10001', imdb_id: 'tt10001', title: 'Anime L' }],
      };
      await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });

      // applyAnimeGate was called without onDrop for the movie.
      assert.strictEqual(movieOnDropPassed, false, 'movie gate called without onDrop');

      // No row written for the movie title.
      const { rows } = decisionLog.list(profileId, 'anime', { build: buildId });
      assert.ok(!rows.some((r) => r.item_key === '10002'), 'no movie row written');
    } finally {
      rebuild.applyAnimeGate = original;
      unstub2();
    }
  });

  // ---- G11: update unit ----
  await ok('G11: update unit — missing row, bad outcome, valid patch', async () => {
    const profileId = 'G11';
    const buildId = decisionLog.newBuildId();
    seedRow(profileId, buildId, 11001, 'Anime N');

    // Missing row → false and no row created.
    const r1 = decisionLog.update(profileId, 'anime', buildId, '99999', { outcome: 'rejected_age', stage: 'mal' });
    assert.strictEqual(r1, false, 'missing row returns false');
    const { rows: rowsAfter } = decisionLog.list(profileId, 'anime', { build: buildId });
    assert.ok(!rowsAfter.some((r) => r.item_key === '99999'), 'no row created');

    // Bad outcome throws.
    let threw = false;
    try {
      decisionLog.update(profileId, 'anime', buildId, '11001', { outcome: 'invalid' });
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('outcome'));
    }
    assert.ok(threw, 'bad outcome throws');

    // Valid patch changes only the patched columns.
    const r2 = decisionLog.update(profileId, 'anime', buildId, '11001', { stage: 'mal', rating: 'mal:R' });
    assert.strictEqual(r2, true, 'valid patch returns true');
    const row = getRow(profileId, buildId, 11001);
    assert.strictEqual(row.stage, 'mal');
    assert.strictEqual(row.rating, 'mal:R');
    assert.strictEqual(row.outcome, 'selected', 'outcome unchanged');
  });

  console.log(`\nAll anime decision-log gate checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
