// AN-4: anime bench (--type anime) — the holdout, the two-engine comparison,
// the mode override, and the label fix.
// Run: node --experimental-sqlite test/anime-bench.js
'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an4-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const config = require('../src/config');
const settings = require('../src/settings');
const watchedStore = require('../src/watchedStore');
const tasteFeedback = require('../src/tasteFeedback');
const db = require('../src/db');
const rs = require('../src/recommendationStore');
const bench = require('../src/bench/engineBench');
const animeMap = require('../src/services/animeMap');
const seriesEngagement = require('../src/seriesEngagement');
const personalised = require('../src/engines/marqueeAnime/personalised');

const quiet = { log() {}, warn() {}, error() {} };

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// The anime detector test seam: the chosen imdb ids are anime (ttA1..ttA5);
// ttS1..ttS5 are ordinary shows (not in the map). at: Date.now() keeps
// ensureLoaded fresh (no download).
animeMap._setIndex({
  at: Date.now(),
  byImdb: { ttA1: { mal: 1 }, ttA2: { mal: 2 }, ttA3: { mal: 3 }, ttA4: { mal: 4 }, ttA5: { mal: 5 } },
  byTmdb: {}, byAnilist: {}, byMal: {},
});

// A series_progress row (the shape the spec gives).
function row(simkl_id, kind, imdb_id, tmdb_id, title, first_real_at, opts = {}) {
  return {
    simkl_id, kind, imdb_id, tmdb_id, title, year: 2020,
    status: 'watching', watched_eps: opts.watched_eps ?? 12, total_eps: 24, not_aired_eps: 4,
    last_watched_at: opts.last_watched_at != null ? opts.last_watched_at : first_real_at,
    first_watched_at: first_real_at,
    first_real_at, last_real_at: first_real_at,
    stamps: 12, real_stamps: 12, eps_per_week: null,
  };
}

// A bulk-imported row: no first_real_at, but has last_watched_at.
function bulkRow(simkl_id, kind, imdb_id, tmdb_id, title, last_watched_at, opts = {}) {
  return {
    simkl_id, kind, imdb_id, tmdb_id, title, year: 2020,
    status: 'watching', watched_eps: opts.watched_eps ?? 12, total_eps: 24, not_aired_eps: 4,
    last_watched_at, first_watched_at: last_watched_at,
    first_real_at: null, last_real_at: null,
    stamps: 12, real_stamps: 0, eps_per_week: null,
  };
}

(async () => {
// ── AB1: pickAnimeTargets (AN-4b: bulk-imported rows now qualify) ──
await ok('AB1: pickAnimeTargets — bulk-only rows with tmdb_id qualify, ordered by last_watched_at; mixed scale; tie by tmdb_id; too few throws', async () => {
  const DAY = 86400e3;
  const base = Date.parse('2026-06-01T00:00:00Z');

  // Case 1: bulk-only rows (no first_real_at) with tmdb_id ARE included,
  // ordered by last_watched_at. Rows with no tmdb_id and rows below engaged
  // are still excluded.
  {
    const rows = [
      // 3 real-start anime rows (engaged+):
      row(100, 'anime', 'ttA1', 'a1', 'Anime 1', base + 3 * DAY),
      row(101, 'anime', 'ttA2', 'a2', 'Anime 2', base + 2 * DAY),
      row(102, 'anime', 'ttA3', 'a3', 'Anime 3', base + 1 * DAY),
      // 5 bulk-only anime rows (no first_real_at, have last_watched_at):
      bulkRow(200, 'anime', 'ttA4', 'b1', 'Bulk 1', base + 5 * DAY),
      bulkRow(201, 'anime', 'ttA5', 'b2', 'Bulk 2', base + 4 * DAY),
      bulkRow(202, 'anime', 'ttA6', 'b3', 'Bulk 3', base + 3 * DAY),
      bulkRow(203, 'anime', 'ttA7', 'b4', 'Bulk 4', base + 2 * DAY),
      bulkRow(204, 'anime', 'ttA8', 'b5', 'Bulk 5', base + 1 * DAY),
      // 1 row with no tmdb_id (excluded):
      row(300, 'anime', 'ttA9', null, 'NoID', base + 6 * DAY),
      // 1 row below engaged (excluded):
      row(301, 'anime', 'ttA10', 'low1', 'Low', base + 6 * DAY, { watched_eps: 4 }),
      // 1 ordinary show (excluded):
      row(302, 'show', 'ttS1', 'o1', 'Ordinary', base + 6 * DAY),
    ];
    // 8 qualifying (3 real-start + 5 bulk-only).
    // holdout 3 needs 3+10=13 → throws.
    assert.throws(() => bench.pickAnimeTargets(rows, 3), /not enough anime history \(8 qualifying shows, need 13\)/);
    // holdout 1 needs 1+10=11 → still throws (8 < 11).
    assert.throws(() => bench.pickAnimeTargets(rows, 1), /not enough anime history \(8 qualifying shows, need 11\)/);
  }

  // Case 2: mixed fixture — real-start and last-watched-only rows sort on
  // the common scale (both epoch ms). Bulk-only rows with a recent
  // last_watched_at sort above real-start rows with an older first_real_at.
  {
    const rows = [
      // 10 real-start anime rows (engaged+), timestamps base+1..base+10:
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'anime', 'ttA' + (i + 1), 'a' + (i + 1), 'Anime ' + (i + 1), base + (i + 1) * DAY)),
      // 5 bulk-only anime rows (no first_real_at), last_watched_at base+11..base+15:
      ...Array.from({ length: 5 }, (_, i) => bulkRow(200 + i, 'anime', 'ttA' + (10 + i), 'b' + (i + 1), 'Bulk ' + (i + 1), base + (11 + i) * DAY)),
      // 5 ordinary shows (excluded):
      ...Array.from({ length: 5 }, (_, i) => row(300 + i, 'show', 'ttS' + (i + 1), 'o' + (i + 1), 'Ordinary ' + (i + 1), base + (200 + i) * DAY)),
    ];
    // 15 qualifying (10 real-start + 5 bulk-only).
    // holdout 5 needs 5+10=15 → exactly meets.
    const targets = bench.pickAnimeTargets(rows, 5);
    assert.strictEqual(targets.length, 5, 'returns exactly holdout targets');
    // The 5 most recent: bulk rows b5..b1 (base+15..base+11) are the most recent.
    assert.deepStrictEqual(targets, ['b5', 'b4', 'b3', 'b2', 'b1'], 'bulk-only rows with recent last_watched_at sort first');
  }

  // Case 3: equal timestamps break ties by tmdb_id (string ascending).
  {
    const rows = [
      // 12 rows all with the same timestamp:
      ...Array.from({ length: 12 }, (_, i) => bulkRow(100 + i, 'anime', 'ttA' + (i + 1), 'z' + String(i).padStart(2, '0'), 'Row ' + i, base + 5 * DAY)),
    ];
    // 12 qualifying. holdout 3 needs 3+10=13 → throws.
    assert.throws(() => bench.pickAnimeTargets(rows, 3), /not enough anime history \(12 qualifying shows, need 13\)/);
    // holdout 2 needs 2+10=12 → exactly meets.
    const targets = bench.pickAnimeTargets(rows, 2);
    // Tie broken by tmdb_id ascending: z00, z01.
    assert.deepStrictEqual(targets, ['z00', 'z01'], 'tie broken by tmdb_id ascending');
  }

  // Case 4: Ciara-shaped fixture (modelled on the real data).
  // 10 finished/no first_real_at (have tmdb_id)
  // 9 finished/no first_real_at/no tmdb_id
  // 3 engaged/first_real_at
  // 1 committed/first_real_at
  // 1 engaged/no first_real_at
  // + 8 rows below engaged or no tmdb_id
  {
    const rows = [
      // 10 finished, no first_real_at, have tmdb_id (bulk-only, engaged+):
      ...Array.from({ length: 10 }, (_, i) => bulkRow(100 + i, 'anime', 'ttA' + (i + 1), 'c' + String(i + 1).padStart(2, '0'), 'Ciara Bulk ' + (i + 1), base + (i + 1) * DAY, { watched_eps: 24 })),
      // 9 finished, no first_real_at, no tmdb_id (excluded — no tmdb_id):
      ...Array.from({ length: 9 }, (_, i) => bulkRow(200 + i, 'anime', 'ttA' + (i + 1), null, 'NoID ' + (i + 1), base + (i + 1) * DAY, { watched_eps: 24 })),
      // 3 engaged, first_real_at:
      ...Array.from({ length: 3 }, (_, i) => row(300 + i, 'anime', 'ttA' + (i + 1), 'e' + (i + 1), 'Engaged ' + (i + 1), base + (100 + i) * DAY, { watched_eps: 12 })),
      // 1 committed, first_real_at:
      row(400, 'anime', 'ttA1', 'com1', 'Committed', base + 103 * DAY, { watched_eps: 18 }),
      // 1 engaged, no first_real_at (bulk-only):
      bulkRow(401, 'anime', 'ttA2', 'e_bulk', 'Engaged Bulk', base + 104 * DAY, { watched_eps: 12 }),
      // 8 rows below engaged or no tmdb_id (excluded):
      ...Array.from({ length: 3 }, (_, i) => row(500 + i, 'anime', 'ttA' + (i + 1), 's' + (i + 1), 'Sampling ' + (i + 1), base + (i + 1) * DAY, { watched_eps: 2 })),
      ...Array.from({ length: 2 }, (_, i) => row(510 + i, 'anime', 'ttA' + (i + 1), 'tr' + (i + 1), 'Tried ' + (i + 1), base + (10 + i) * DAY, { watched_eps: 4 })),
      ...Array.from({ length: 3 }, (_, i) => row(520 + i, 'anime', 'ttA' + (i + 1), null, 'NoID2 ' + (i + 1), base + (20 + i) * DAY, { watched_eps: 12 })),
    ];
    // Qualifying: 10 bulk (c01..c10) + 3 engaged (e1..e3) + 1 committed (com1) + 1 engaged bulk (e_bulk) = 15.
    // holdout 5 needs 5+10=15 → exactly meets.
    const targets = bench.pickAnimeTargets(rows, 5);
    assert.strictEqual(targets.length, 5, 'Ciara shape: returns 5 targets');
    // The 5 most recent: e_bulk (base+104*DAY), com1 (base+103*DAY), e3 (base+102*DAY), e2 (base+101*DAY), e1 (base+100*DAY).
    assert.deepStrictEqual(targets, ['e_bulk', 'com1', 'e3', 'e2', 'e1'], 'Ciara shape: real-start rows with recent timestamps sort first');
    // holdout 6 needs 6+10=16 → throws (15 < 16).
    assert.throws(() => bench.pickAnimeTargets(rows, 6), /not enough anime history \(15 qualifying shows, need 16\)/);
  }
});

// ── AB2: removeAnimeHoldout ──
await ok('AB2: removeAnimeHoldout — targets gone from all tables; other rows untouched', async () => {
  const p = config.addProfile('AN4-AB2');
  const DAY = 86400e3;
  const base = Date.parse('2026-06-01T00:00:00Z');
  try {
    // Seed: 5 anime progress rows (the targets) + 5 ordinary show rows (not targets).
    const animeRows = Array.from({ length: 5 }, (_, i) => row(100 + i, 'anime', 'ttA' + (i + 1), 'an' + (i + 1), 'Anime ' + (i + 1), base + (i + 1) * DAY));
    const showRows = Array.from({ length: 5 }, (_, i) => row(200 + i, 'show', 'ttS' + (i + 1), 'sh' + (i + 1), 'Show ' + (i + 1), base + (100 + i) * DAY));
    watchedStore.upsertSeriesProgress(p.id, [...animeRows, ...showRows]);
    // Watched rows (type series) for the anime targets.
    watchedStore.upsertMany(p.id, animeRows.map((r, i) => ({
      simkl_id: 500 + i, type: 'series', imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, title: r.title, year: 2020, watched_at: base + i * DAY,
    })));
    // Pending watched (tmdb and imdb keyed).
    for (const r of animeRows) watchedStore.addPendingWatched(p.id, { type: 'series', tmdbId: r.tmdb_id });
    // Dont recommend.
    for (const r of animeRows) rs.addDontRecommend(p.id, 'series', r.tmdb_id, 'user');
    // Taste ratings (type series — anime ratings stored as series).
    tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: 'an1', rating: 9 });
    tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: 'an2', rating: 5 });
    // Taste ignore.
    const conn = db.get();
    conn.prepare('INSERT INTO taste_ignore (profile_id, type, simkl_id, tmdb_id, imdb_id, at) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, 'series', 3, 'an3', 'ttA3', Date.now());
    // Recommended pool: anime type + series type + movie type.
    rs.upsertCandidates(p.id, [
      { type: 'anime', tmdb_id: 'an1', imdb_id: 'ttA1', title: 'Anime 1', year: 2020, genres: 'Animation', primary_genre: 'Animation', vote_average: 7, vote_count: 3000, affinity: 5, rankScore: 5, popularity: 4, rec_count: 1, poster: null },
      { type: 'anime', tmdb_id: 'an2', imdb_id: 'ttA2', title: 'Anime 2', year: 2020, genres: 'Animation', primary_genre: 'Animation', vote_average: 7, vote_count: 3000, affinity: 5, rankScore: 5, popularity: 4, rec_count: 1, poster: null },
      { type: 'series', tmdb_id: 'sh1', imdb_id: 'ttS1', title: 'Show 1', year: 2020, genres: 'Drama', primary_genre: 'Drama', vote_average: 7, vote_count: 3000, affinity: 5, rankScore: 5, popularity: 4, rec_count: 1, poster: null },
      { type: 'movie', tmdb_id: 'm1', imdb_id: 'ttM1', title: 'Movie 1', year: 2020, genres: 'Action', primary_genre: 'Action', vote_average: 7, vote_count: 3000, affinity: 5, rankScore: 5, popularity: 4, rec_count: 1, poster: null },
    ]);
    const targets = ['an1', 'an2', 'an3', 'an4', 'an5'];
    bench.removeAnimeHoldout(p.id, targets, { db });
    // Targets gone from series_progress.
    const remaining = new Set(watchedStore.getSeriesProgress(p.id).map((r) => r.tmdb_id));
    for (const t of targets) assert.ok(!remaining.has(t), 'series_progress removed: ' + t);
    // Targets gone from watched.
    for (const t of targets) {
      assert.ok(!conn.prepare('SELECT tmdb_id FROM watched WHERE profile_id = ? AND type = ? AND tmdb_id = ?').get(p.id, 'series', t), 'watched removed: ' + t);
    }
    // Targets gone from pending_watched (tmdb keyed).
    for (const t of targets) {
      assert.ok(!conn.prepare('SELECT tmdb_id FROM pending_watched WHERE profile_id = ? AND tmdb_id = ?').get(p.id, t), 'pending_watched (tmdb) removed: ' + t);
    }
    // Targets gone from dont_recommend.
    for (const t of targets) {
      assert.ok(!conn.prepare('SELECT tmdb_id FROM dont_recommend WHERE profile_id = ? AND tmdb_id = ?').get(p.id, t), 'dont_recommend removed: ' + t);
    }
    // Targets gone from taste_ratings (type series).
    for (const t of ['an1', 'an2']) {
      assert.ok(!conn.prepare("SELECT tmdb_id FROM taste_ratings WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").get(p.id, t), 'taste_ratings removed: ' + t);
    }
    // Target gone from taste_ignore.
    assert.ok(!conn.prepare("SELECT tmdb_id FROM taste_ignore WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").get(p.id, 'an3'), 'taste_ignore removed: an3');
    // Recommended: anime type rows gone.
    for (const t of ['an1', 'an2']) {
      assert.ok(!conn.prepare("SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = 'anime' AND tmdb_id = ?").get(p.id, t), 'recommended anime removed: ' + t);
    }
    // Recommended: series and movie rows remain.
    assert.ok(conn.prepare("SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").get(p.id, 'sh1'), 'recommended series remains: sh1');
    assert.ok(conn.prepare("SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = 'movie' AND tmdb_id = ?").get(p.id, 'm1'), 'recommended movie remains: m1');
    // Ordinary show rows untouched.
    for (const t of ['sh1', 'sh2', 'sh3', 'sh4', 'sh5']) {
      assert.ok(remaining.has(t), 'ordinary show survives: ' + t);
    }
  } finally {
    config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); tasteFeedback.deleteForProfile(p.id);
  }
});

// ── AB3: leakage check ──
await ok('AB3: leakage — runBench throws if a delete is skipped', async () => {
  const p = config.addProfile('AN4-AB3');
  const DAY = 86400e3;
  const base = Date.parse('2026-06-01T00:00:00Z');
  const pipeline = require('../src/engines/pipeline');
  const engines = require('../src/engines');
  try {
    // Seed 15 qualifying anime rows (holdout 5 needs 5+10).
    const rows = Array.from({ length: 15 }, (_, i) => row(100 + i, 'anime', 'ttA' + (i + 1), 'an' + (i + 1), 'Anime ' + (i + 1), base + (i + 1) * DAY));
    watchedStore.upsertSeriesProgress(p.id, rows);
    // Also add watched rows so the leakage check on watchedIdSets can fire.
    watchedStore.upsertMany(p.id, rows.map((r, i) => ({
      simkl_id: 500 + i, type: 'series', imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, title: r.title, year: 2020, watched_at: base + i * DAY,
    })));
    // A no-op removeAnimeHoldout (simulates a skipped delete).
    const noopRemove = (_pid, _ids, _opts) => {};
    const fakeEngine = engines._register({
      id: 'bench-anime-stub', name: 'Bench anime stub', supportedTypes: ['anime'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => [],
    });
    try {
      await bench.runBench({
        profile: config.getProfile(p.id), engineIds: ['bench-anime-stub'], holdout: 5, type: 'anime',
        deps: {
          engines, pipeline, rs, watchedStore, db, settings,
          selectServe: rs.selectServe, selectServeFor: rs.selectServeFor,
          log: quiet, noCache: false,
          removeAnimeHoldout: noopRemove,
        },
      });
      assert.fail('should have thrown a leakage error');
    } catch (e) {
      assert.ok(e.message.includes('leakage'), 'leakage error: ' + e.message);
    } finally {
      fakeEngine();
    }
  } finally {
    config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
  }
});

// ── AB4: runBench anime end to end (fakes) ──
await ok('AB4: runBench anime end to end — two engines, deterministic rows, metrics correct', async () => {
  const p = config.addProfile('AN4-AB4');
  const DAY = 86400e3;
  const base = Date.parse('2026-06-01T00:00:00Z');
  const pipeline = require('../src/engines/pipeline');
  const engines = require('../src/engines');
  try {
    // Seed 15 qualifying anime rows (holdout 5 needs 5+10).
    const rows = Array.from({ length: 15 }, (_, i) => row(100 + i, 'anime', 'ttA' + (i + 1), 'an' + (i + 1), 'Anime ' + (i + 1), base + (i + 1) * DAY));
    watchedStore.upsertSeriesProgress(p.id, rows);
    // Watched rows for the targets.
    const targetIds = ['an15', 'an14', 'an13', 'an12', 'an11']; // the 5 most recent
    watchedStore.upsertMany(p.id, targetIds.map((t, i) => {
      const n = Number(t.slice(2));
      return { simkl_id: 500 + n, type: 'series', imdb_id: 'ttA' + n, tmdb_id: t, title: 'Anime ' + n, year: 2020, watched_at: base + n * DAY };
    }));
    // Two fake engines: one returns the 5 targets, the other returns 3 of them.
    const dispose1 = engines._register({
      id: 'bench-anime-1', name: 'Bench anime 1', supportedTypes: ['anime'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => targetIds.map((t, i) => ({
        type: 'anime', tmdb_id: t, imdb_id: 'ttA' + t.slice(2), title: 'Anime ' + t.slice(2), year: 2020,
        genres: 'Animation', primary_genre: 'Animation', vote_average: 8, vote_count: 5000,
        affinity: 10 - i, rankScore: 10 - i, popularity: 5, poster: null,
      })),
    });
    const dispose2 = engines._register({
      id: 'bench-anime-2', name: 'Bench anime 2', supportedTypes: ['anime'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => targetIds.slice(0, 3).map((t, i) => ({
        type: 'anime', tmdb_id: t, imdb_id: 'ttA' + t.slice(2), title: 'Anime ' + t.slice(2), year: 2020,
        genres: 'Animation', primary_genre: 'Animation', vote_average: 7, vote_count: 4000,
        affinity: 9 - i, rankScore: 9 - i, popularity: 4, poster: null,
      })),
    });
    try {
      config.updateProfile(p.id, { filters: {} });
      const results = await bench.runBench({
        profile: config.getProfile(p.id), engineIds: ['bench-anime-1', 'bench-anime-2'], holdout: 5, type: 'anime',
        deps: {
          engines, pipeline, rs, watchedStore, db, settings,
          selectServe: rs.selectServe, selectServeFor: rs.selectServeFor,
          log: quiet, noCache: false,
        },
      });
      // Both engine ids present.
      assert.ok(results.engines['bench-anime-1'], 'engine 1 in results');
      assert.ok(results.engines['bench-anime-2'], 'engine 2 in results');
      // Engine 1: all 5 targets hit in top-20.
      assert.strictEqual(results.engines['bench-anime-1'].metrics.hitAt20, 5, 'engine 1 hits all 5');
      // Engine 2: 3 targets hit in top-20.
      assert.strictEqual(results.engines['bench-anime-2'].metrics.hitAt20, 3, 'engine 2 hits 3');
      // Per-target positions: engine 1 has all 5 at ranks 1-5.
      const pos1 = results.engines['bench-anime-1'].positions;
      for (const t of targetIds) {
        assert.ok(pos1[t].rank, 'engine 1 position for ' + t);
        assert.ok(pos1[t].served, 'engine 1 served ' + t);
      }
      // Engine 2: the 3 targets at ranks 1-3, the other 2 not in pool.
      const pos2 = results.engines['bench-anime-2'].positions;
      for (const t of targetIds.slice(0, 3)) {
        assert.ok(pos2[t].rank, 'engine 2 position for ' + t);
        assert.ok(pos2[t].served, 'engine 2 served ' + t);
      }
      for (const t of targetIds.slice(3)) {
        assert.strictEqual(pos2[t].rank, null, 'engine 2 no rank for ' + t);
      }
      // Table renders both labels and the note line.
      const table = bench.renderTable(results);
      assert.ok(table.includes('bench-anime-1'), 'table has engine 1');
      assert.ok(table.includes('bench-anime-2'), 'table has engine 2');
      assert.ok(table.includes('Anime 15'), 'table has target title');
    } finally {
      dispose1(); dispose2();
    }
  } finally {
    config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
  }
});

// ── AB5: baseline override ──
await ok('AB5: baseline override — ctxExtras.animeMode=trending forces trending; without it, the mode is by engaged count', async () => {
  // Unit-test the mode chooser through the public build function with injected deps.
  const makeProfile = () => ({
    id: 'test', name: 'Test', filters: { engine_anime: 'marquee-anime' },
  });
  // A fake ladder that returns `engaged` seed-eligible anime entries.
  const makeLadder = (engaged) => {
    const entries = [];
    for (let i = 0; i < engaged; i++) {
      entries.push({
        row: { tmdb_id: 'a' + i, imdb_id: 'ttA' + i, kind: 'anime', title: 'Anime ' + i },
        value: 1.0, seedEligible: true,
      });
    }
    return { values: () => entries };
  };
  const fakeDeps = (engaged) => ({
    ladder: async () => makeLadder(engaged),
    isAnimeRow: (r) => true,
    ignored: () => new Set(),
    watchedIds: () => ({ imdb: new Set(), tmdb: new Set() }),
    dontKeys: () => new Set(),
    animeMap: {
      ensureLoaded: async () => {},
      lookup: (imdbId, tmdbId) => ({ anilist: 100 + Number(String(tmdbId).slice(1)) }),
      isAnime: () => true,
      byAnilist: (id) => ({ tv: 'rec' + id, imdb: 'ttR' + id, type: 'TV' }),
      byMal: () => null,
    },
    anilist: {
      tagsFor: async (ids) => { const m = new Map(); for (const id of ids) m.set(id, { tags: [{ name: 'Action', rank: 90 }], genres: ['Action'] }); return m; },
      recommendationsFor: async (ids) => { const m = new Map(); for (const id of ids) m.set(id, [{ id: 200 + id, idMal: null, title: { english: 'Rec ' + id }, averageScore: 80, popularity: 50, genres: ['Action'], year: 2020, rating: 5 }]); return m; },
      tagSearch: async () => [],
    },
    trending: { build: async (profile, ctx) => { ctx._trendingCalled = true; return [{ type: 'anime', tmdb_id: 'trend1', imdb_id: 'ttT1', title: 'Trending 1', year: 2020, rankScore: 0.5 }]; } },
    trendingDeps: undefined,
    tvMeta: async () => new Map(),
    listSize: () => 20,
    tier: () => null,
    decisions: null,
  });
  // 19 engaged anime + override → trending.
  {
    const ctx = { animeMode: 'trending', log: quiet };
    const result = await personalised.build(makeProfile(), ctx, fakeDeps(19));
    assert.strictEqual(ctx.animeMode, 'trending', 'override forces trending');
  }
  // 19 engaged anime, no override → personalised.
  {
    const ctx = { log: quiet };
    const result = await personalised.build(makeProfile(), ctx, fakeDeps(19));
    assert.strictEqual(ctx.animeMode, 'personalised', '19 engaged → personalised');
  }
  // 0 engaged, no override → trending (the engine's own fallback).
  {
    const ctx = { log: quiet };
    const result = await personalised.build(makeProfile(), ctx, fakeDeps(0));
    assert.strictEqual(ctx.animeMode, 'trending', '0 engaged → trending');
  }
  // 3 engaged, no override → mixed.
  {
    const ctx = { log: quiet };
    const result = await personalised.build(makeProfile(), ctx, fakeDeps(3));
    assert.strictEqual(ctx.animeMode, 'mixed', '3 engaged → mixed');
  }
  // 7 engaged, no override → personalised.
  {
    const ctx = { log: quiet };
    const result = await personalised.build(makeProfile(), ctx, fakeDeps(7));
    assert.strictEqual(ctx.animeMode, 'personalised', '7 engaged → personalised');
  }
});

// ── AB6: label fix (calls the REAL exported function) ──
await ok('AB6: label fix — animeBlockDecision handles llm-review, llm, and csm correctly', async () => {
  const { animeBlockDecision } = require('../src/recommendationStore');
  // llm-review → rejected_llm / llm-last-resort / llm / LLM reason (no v.reason).
  {
    const d = animeBlockDecision({ source: 'llm-review', rating: '14' }, 'TV-14');
    assert.strictEqual(d.outcome, 'rejected_llm', 'llm-review outcome');
    assert.strictEqual(d.stage, 'llm-last-resort', 'llm-review stage');
    assert.strictEqual(d.rating, 'llm', 'llm-review rating');
    assert.strictEqual(d.reason, 'The LLM judged it unsuitable for this age', 'llm-review reason (no v.reason)');
  }
  // llm-review with an explicit v.reason → the reason wins.
  {
    const d = animeBlockDecision({ source: 'llm-review', rating: '14', reason: 'Custom reason' }, 'TV-14');
    assert.strictEqual(d.reason, 'Custom reason', 'llm-review explicit reason wins');
  }
  // llm → same as llm-review.
  {
    const d = animeBlockDecision({ source: 'llm', rating: '14' }, 'TV-14');
    assert.strictEqual(d.outcome, 'rejected_llm', 'llm outcome');
    assert.strictEqual(d.stage, 'llm-last-resort', 'llm stage');
    assert.strictEqual(d.rating, 'llm', 'llm rating');
    assert.strictEqual(d.reason, 'The LLM judged it unsuitable for this age', 'llm reason');
  }
  // csm → rejected_age / csm / csm:14 / csm rated 14: above the TV-14 limit.
  {
    const d = animeBlockDecision({ source: 'csm', rating: '14' }, 'TV-14');
    assert.strictEqual(d.outcome, 'rejected_age', 'csm outcome');
    assert.strictEqual(d.stage, 'csm', 'csm stage');
    assert.strictEqual(d.rating, 'csm:14', 'csm rating');
    assert.strictEqual(d.reason, 'csm rated 14: above the TV-14 limit', 'csm reason');
  }
  // csm with an explicit v.reason → the reason wins.
  {
    const d = animeBlockDecision({ source: 'csm', rating: '14', reason: 'Custom' }, 'TV-14');
    assert.strictEqual(d.reason, 'Custom', 'csm explicit reason wins');
  }
});

// ── AB6b: grep-style guard — both call sites use the helper ──
// Crude but it fails if someone reverts one site back to the inline ternary.
await ok('AB6b: both call sites use animeBlockDecision (no inline ternary remains)', async () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'recommendationStore.js'), 'utf8');
  // The old inline ternary must not appear anywhere.
  assert.ok(!src.includes("v.source === 'llm' ? 'rejected_llm'"), 'old inline ternary still present');
  // animeBlockDecision( must appear at least twice besides its definition.
  const count = (src.match(/animeBlockDecision\(/g) || []).length;
  assert.ok(count >= 3, 'animeBlockDecision used at both call sites (found ' + count + ' occurrences, need ≥ 3: 1 definition + 2 call sites)');
});

// ── AB7: series/movie unchanged ──
await ok('AB7: series/movie unchanged — pickSeriesTargets and pickTargets still work on the AB1 fixture', async () => {
  const DAY = 86400e3;
  const base = Date.parse('2026-06-01T00:00:00Z');
  // Build the same fixture as AB1.
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'anime', 'ttA' + (i + 1), 'a' + (i + 1), 'Anime ' + (i + 1), base + (i + 1) * DAY)),
    ...Array.from({ length: 5 }, (_, i) => row(200 + i, 'show', 'ttA' + (i + 1), 's' + (i + 1), 'Flagged ' + (i + 1), base + (100 + i) * DAY, { watched_eps: 10 })),
    ...Array.from({ length: 5 }, (_, i) => row(300 + i, 'show', 'ttS' + (i + 1), 'o' + (i + 1), 'Ordinary ' + (i + 1), base + (200 + i) * DAY)),
    ...Array.from({ length: 5 }, (_, i) => row(400 + i, 'anime', 'ttA' + (i + 1), 'b' + (i + 1), 'Bulk ' + (i + 1), null)),
    ...Array.from({ length: 5 }, (_, i) => row(500 + i, 'anime', 'ttA' + (i + 1), null, 'NoID ' + (i + 1), base + (300 + i) * DAY)),
    ...Array.from({ length: 5 }, (_, i) => row(600 + i, 'anime', 'ttA' + (i + 1), 'low' + (i + 1), 'Low ' + (i + 1), base + (400 + i) * DAY, { watched_eps: 4 })),
  ];
  // pickSeriesTargets: only kind='show' rows qualify (anime kind excluded).
  // The 5 flagged shows (kind='show', in the anime map) + 5 ordinary shows = 10 qualifying.
  // holdout 5 needs 5+10=15 → throws (only 10 qualifying).
  assert.throws(() => bench.pickSeriesTargets(rows, 5), /not enough series history/);
  // pickTargets (movie): uses watched rows, not series_progress. The fixture
  // has no movie watched rows, so it throws.
  assert.throws(() => bench.pickTargets([], 5), /not enough history/);
});

// ── AB8: describeAnimeTargets ──
await ok('AB8: describeAnimeTargets — labels each target correctly and the counts line is right', async () => {
  const DAY = 86400e3;
  const base = Date.parse('2026-06-01T00:00:00Z');

  // Mixed set: 2 real-start, 3 last-watched, 1 id-only.
  {
    const rows = [
      row(100, 'anime', 'ttA1', 'a1', 'Anime 1', base + 3 * DAY),
      row(101, 'anime', 'ttA2', 'a2', 'Anime 2', base + 2 * DAY),
      bulkRow(200, 'anime', 'ttA3', 'b1', 'Bulk 1', base + 5 * DAY),
      bulkRow(201, 'anime', 'ttA4', 'b2', 'Bulk 2', base + 4 * DAY),
      bulkRow(202, 'anime', 'ttA5', 'b3', 'Bulk 3', base + 3 * DAY),
      // id-only: no first_real_at, no last_watched_at (both null).
      { simkl_id: 300, kind: 'anime', imdb_id: 'ttA6', tmdb_id: 'x1', title: 'NoDates', year: 2020,
        status: 'watching', watched_eps: 12, total_eps: 24, not_aired_eps: 4,
        last_watched_at: null, first_watched_at: null, first_real_at: null, last_real_at: null,
        stamps: 12, real_stamps: 0, eps_per_week: null },
    ];
    const targetIds = ['a1', 'a2', 'b1', 'b2', 'b3', 'x1'];
    const desc = bench.describeAnimeTargets(rows, targetIds);
    assert.strictEqual(desc.length, 6, 'returns one entry per target');
    // a1, a2 → real-start
    assert.strictEqual(desc[0].orderedBy, 'real-start', 'a1 is real-start');
    assert.strictEqual(desc[1].orderedBy, 'real-start', 'a2 is real-start');
    // b1, b2, b3 → last-watched
    assert.strictEqual(desc[2].orderedBy, 'last-watched', 'b1 is last-watched');
    assert.strictEqual(desc[3].orderedBy, 'last-watched', 'b2 is last-watched');
    assert.strictEqual(desc[4].orderedBy, 'last-watched', 'b3 is last-watched');
    // x1 → id-only
    assert.strictEqual(desc[5].orderedBy, 'id-only', 'x1 is id-only');
    // titles are correct
    assert.strictEqual(desc[0].title, 'Anime 1', 'a1 title');
    assert.strictEqual(desc[5].title, 'NoDates', 'x1 title');
    // Counts: 2 real-start, 3 last-watched, 1 id-only.
    const counts = { 'real-start': 0, 'last-watched': 0, 'id-only': 0 };
    for (const d of desc) counts[d.orderedBy] += 1;
    assert.deepStrictEqual(counts, { 'real-start': 2, 'last-watched': 3, 'id-only': 1 }, 'counts');
  }

  // All id-only set.
  {
    const rows = [
      { simkl_id: 100, kind: 'anime', imdb_id: 'ttA1', tmdb_id: 'x1', title: 'NoDates 1', year: 2020,
        status: 'watching', watched_eps: 12, total_eps: 24, not_aired_eps: 4,
        last_watched_at: null, first_watched_at: null, first_real_at: null, last_real_at: null,
        stamps: 12, real_stamps: 0, eps_per_week: null },
      { simkl_id: 101, kind: 'anime', imdb_id: 'ttA2', tmdb_id: 'x2', title: 'NoDates 2', year: 2020,
        status: 'watching', watched_eps: 12, total_eps: 24, not_aired_eps: 4,
        last_watched_at: null, first_watched_at: null, first_real_at: null, last_real_at: null,
        stamps: 12, real_stamps: 0, eps_per_week: null },
    ];
    const desc = bench.describeAnimeTargets(rows, ['x1', 'x2']);
    assert.strictEqual(desc[0].orderedBy, 'id-only', 'x1 is id-only');
    assert.strictEqual(desc[1].orderedBy, 'id-only', 'x2 is id-only');
    // The script's print logic: all id-only → "Holdout chosen by tmdb id..."
    const allIdOnly = desc.every((d) => d.orderedBy === 'id-only');
    assert.ok(allIdOnly, 'all id-only');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
