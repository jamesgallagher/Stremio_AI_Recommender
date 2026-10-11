// Ratings → Anime: English titles + thumbnails (bug report 2026-10-11). Hermetic (no network).
//  • The anime list showed the Simkl row title (often Japanese/romaji) instead of the English one.
//  • Most anime rows had no thumbnail: the shows/anime list only READ the Marquee TV metadata cache
//    (anime titles are never in it) and, unlike films, never fetched the missing ones.
// Run: node --experimental-sqlite test/anime-ratings-titles.js
'use strict';
const assert = require('assert');
const os = require('os');
process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an3t-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const watchedStore = require('../src/watchedStore');
const trainer = require('../src/trainer');
const animeMap = require('../src/services/animeMap');

let passed = 0; let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

animeMap._setIndex({ at: Date.now(), byImdb: { ttA1: { mal: 1 }, ttA2: { mal: 2 }, ttA3: { mal: 3 } }, byTmdb: {}, byAnilist: {}, byMal: {} });

const row = (simkl_id, kind, imdb_id, tmdb_id, title, last) => ({ simkl_id, kind, imdb_id, tmdb_id, title, year: 2013, status: 'ongoing', watched_eps: 12, total_eps: 24, not_aired_eps: 0, last_watched_at: last, first_watched_at: 1000, first_real_at: null, last_real_at: null, stamps: null, real_stamps: null, eps_per_week: null });
const profile = (id) => ({ id, name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' }, filters: { engine_anime: 'marquee-anime' } });

// TMDB (en-US) knows the English names + posters.
const TMDB = {
  '100': { title: 'Attack on Titan', poster: 'https://img/aot.jpg', year: 2013, primary_genre: 'Animation', genres: ['Animation'] },
  '101': { title: 'Demon Slayer', poster: 'https://img/ds.jpg', year: 2019, primary_genre: 'Animation', genres: ['Animation'] },
  '102': { title: 'Spy x Family', poster: null, year: 2022, primary_genre: 'Animation', genres: ['Animation'] }, // TMDB has no poster for it
};
function deps({ cache = {}, calls }) {
  return {
    settings: { keyFor: () => 'tmdb-key' },
    metaGet: (type, id) => cache[String(id)] || null,
    enrich: async (_key, type, id) => { calls.push([type, String(id)]); return TMDB[String(id)] || null; },
    log: quiet,
  };
}

(async () => {
  console.log('anime-ratings-titles:');

  await ok('ANIME: a Japanese Simkl title is replaced by the English (TMDB en-US) title, and the missing thumbnail is fetched', async () => {
    const pid = 'p-an3t-1'; const calls = [];
    watchedStore.upsertSeriesProgress(pid, [
      row(1, 'anime', 'ttA1', '100', 'Shingeki no Kyojin', 3000),
      row(2, 'anime', 'ttA2', '101', 'Kimetsu no Yaiba', 2000),
    ]);
    const res = await trainer.listHistory(profile(pid), { type: 'anime' }, deps({ calls }));
    assert.strictEqual(res.ok, true);
    const by = Object.fromEntries(res.items.map((i) => [i.tmdb_id, i]));
    assert.strictEqual(by['100'].title, 'Attack on Titan');
    assert.strictEqual(by['100'].genre, 'Anime', 'genre is Anime, not TMDB\'s "Animation"');
    assert.strictEqual(by['101'].genre, 'Anime');
    assert.strictEqual(by['100'].poster, 'https://img/aot.jpg', 'thumbnail fetched');
    assert.strictEqual(by['101'].title, 'Demon Slayer');
    assert.strictEqual(by['101'].poster, 'https://img/ds.jpg');
    assert.deepStrictEqual(calls.map((c) => c[0]).sort(), ['series', 'series'], 'anime ids are looked up as TV shows');
    watchedStore.deleteForProfile(pid);
  });

  await ok('ANIME: an already-cached English title wins with NO network call (and the cache feeds search)', async () => {
    const pid = 'p-an3t-2'; const calls = [];
    watchedStore.upsertSeriesProgress(pid, [row(1, 'anime', 'ttA1', '100', 'Shingeki no Kyojin', 3000)]);
    const cache = { '100': TMDB['100'] };
    const res = await trainer.listHistory(profile(pid), { type: 'anime', q: 'attack on' }, deps({ cache, calls }));
    assert.deepStrictEqual(res.items.map((i) => i.title), ['Attack on Titan'], 'searching the ENGLISH name finds it');
    assert.strictEqual(calls.length, 0, 'cached → free');
    watchedStore.deleteForProfile(pid);
  });

  await ok('ANIME: when TMDB has no better title/poster the Simkl title is kept and nothing breaks', async () => {
    const pid = 'p-an3t-3'; const calls = [];
    watchedStore.upsertSeriesProgress(pid, [
      row(1, 'anime', 'ttA3', '102', 'Spy x Family', 3000),
      row(2, 'anime', 'ttA2', '999', 'Unknown Anime', 2000), // enrich → null
    ]);
    const res = await trainer.listHistory(profile(pid), { type: 'anime' }, deps({ calls }));
    const by = Object.fromEntries(res.items.map((i) => [i.tmdb_id, i]));
    assert.strictEqual(by['102'].poster, null);
    assert.strictEqual(by['999'].title, 'Unknown Anime');
    assert.strictEqual(by['999'].genre, 'Anime', 'even an un-looked-up row says Anime (no dash)');
    assert.strictEqual(by['999'].poster, null);
    watchedStore.deleteForProfile(pid);
  });

  await ok('ANIME: at most 25 thumbnails are fetched per list request, in batches', async () => {
    const pid = 'p-an3t-4'; const calls = [];
    const rows = []; for (let i = 0; i < 40; i++) rows.push(row(i + 1, 'anime', 'ttA1', String(2000 + i), 'Anime ' + i, 10000 - i));
    watchedStore.upsertSeriesProgress(pid, rows);
    await trainer.listHistory(profile(pid), { type: 'anime', pageSize: 40 }, deps({ calls }));
    assert.strictEqual(calls.length, 25);
    watchedStore.deleteForProfile(pid);
  });

  await ok('SHOWS: ordinary shows keep their Simkl title but now also get missing thumbnails', async () => {
    const pid = 'p-an3t-5'; const calls = [];
    watchedStore.upsertSeriesProgress(pid, [row(1, 'show', 'ttS9', '100', 'Some Show', 3000)]);
    const res = await trainer.listHistory(profile(pid), { type: 'series' }, deps({ calls }));
    assert.strictEqual(res.items[0].title, 'Some Show', "a non-anime show's title is not rewritten");
    assert.strictEqual(res.items[0].genre, 'Animation', "a non-anime show keeps its TMDB genre");
    assert.strictEqual(res.items[0].poster, 'https://img/aot.jpg');
    watchedStore.deleteForProfile(pid);
  });

  // ---- review fixes (PR #68 review) ----

  await ok('ACTIONS: rate / un-rate / ignore / un-ignore on an anime row keep the English title + "Anime" genre (no flip-back)', async () => {
    const pid = 'p-an3t-6';
    watchedStore.upsertSeriesProgress(pid, [
      row(1, 'anime', 'ttA1', '100', 'Shingeki no Kyojin', 3000), // cached English meta
      row(2, 'anime', 'ttA2', '555', 'Kimetsu no Yaiba', 2000),   // not cached
    ]);
    const d = {
      simkl: { setRatings: async () => ({}), removeRatings: async () => ({}) },
      metaGet: (type, id) => (String(id) === '100' ? TMDB['100'] : null),
      now: () => 9000, log: quiet,
    };
    const check = (res, title, what) => {
      assert.strictEqual(res.ok, true, what);
      assert.strictEqual(res.item.title, title, what + ' title');
      assert.strictEqual(res.item.genre, 'Anime', what + ' genre');
    };
    check(await trainer.rate(profile(pid), { type: 'anime', tmdb_id: '100' }, 8, d), 'Attack on Titan', 'rate');
    check(await trainer.rate(profile(pid), { type: 'anime', tmdb_id: '100' }, 8, d), 'Attack on Titan', 'rate (no-op)');
    check(await trainer.rate(profile(pid), { type: 'anime', tmdb_id: '100' }, null, d), 'Attack on Titan', 'clear rating');
    check(await trainer.setIgnored(profile(pid), { type: 'anime', tmdb_id: '100' }, true, d), 'Attack on Titan', 'ignore');
    check(await trainer.setIgnored(profile(pid), { type: 'anime', tmdb_id: '100' }, false, d), 'Attack on Titan', 'un-ignore');
    // an uncached row keeps its Simkl title (nothing to replace it with) but is still "Anime"
    check(await trainer.rate(profile(pid), { type: 'anime', tmdb_id: '555' }, 7, d), 'Kimetsu no Yaiba', 'rate uncached');
    watchedStore.deleteForProfile(pid);
  });

  await ok('FAILURES: titles whose lookup failed are skipped for an hour, so they cannot starve the rest of the page', async () => {
    trainer._resetLookupFailures();
    const pid = 'p-an3t-7'; const calls = [];
    const rows = []; for (let i = 0; i < 40; i++) rows.push(row(i + 1, 'anime', 'ttA1', String(2000 + i), 'Anime ' + i, 10000 - i));
    watchedStore.upsertSeriesProgress(pid, rows);
    let nowMs = 1_000_000;
    const d = () => ({
      settings: { keyFor: () => 'k' }, metaGet: () => null, log: quiet, now: () => nowMs,
      // the first 25 ids are permanent failures (404); the rest resolve
      enrich: async (_k, _t, id) => { calls.push(String(id)); return Number(id) < 2025 ? null : { title: 'EN ' + id, poster: 'https://img/' + id, year: 2020, genres: [] }; },
    });
    const first = await trainer.listHistory(profile(pid), { type: 'anime', pageSize: 40 }, d());
    assert.strictEqual(calls.length, 25, 'first request: the 25 failing rows use the slots');
    assert.ok(first.items.slice(25).every((i) => i.poster == null), 'rows after them were not reached yet');
    calls.length = 0;
    const second = await trainer.listHistory(profile(pid), { type: 'anime', pageSize: 40 }, d());
    assert.strictEqual(calls.length, 15, 'second request: failed rows skipped, the remaining 15 fetched');
    assert.ok(!calls.some((id) => Number(id) < 2025));
    assert.ok(second.items.slice(25).every((i) => i.poster && i.title.startsWith('EN ')), 'the rest of the page now has thumbnails + English titles');
    // after the retry window the failed rows are tried again
    calls.length = 0; nowMs += 61 * 60e3;
    await trainer.listHistory(profile(pid), { type: 'anime', pageSize: 40 }, d());
    assert.ok(calls.includes('2000'), 'failed titles are retried after an hour');
    watchedStore.deleteForProfile(pid);
  });

  await ok('BUDGET: a slow TMDB cannot stall the list — it returns within the budget with the Simkl data', async () => {
    trainer._resetLookupFailures();
    const pid = 'p-an3t-8';
    const rows = []; for (let i = 0; i < 12; i++) rows.push(row(i + 1, 'anime', 'ttA1', String(3000 + i), 'Slow ' + i, 10000 - i));
    watchedStore.upsertSeriesProgress(pid, rows);
    const t0 = Date.now();
    const res = await trainer.listHistory(profile(pid), { type: 'anime', pageSize: 25 }, {
      settings: { keyFor: () => 'k' }, metaGet: () => null, log: quiet, fillBudgetMs: 80,
      enrich: () => new Promise(() => {}), // never settles
    });
    assert.ok(Date.now() - t0 < 1500, 'returned promptly, not after the hung lookups');
    assert.strictEqual(res.items.length, 12);
    assert.ok(res.items.every((i) => i.title.startsWith('Slow ') && i.genre === 'Anime'));
    watchedStore.deleteForProfile(pid);
  });

  await ok('BULK READ: the cache is read with ONE query for the whole list, not one per row', async () => {
    const pid = 'p-an3t-9';
    const rows = []; for (let i = 0; i < 30; i++) rows.push(row(i + 1, 'anime', 'ttA1', String(4000 + i), 'Row ' + i, 10000 - i));
    watchedStore.upsertSeriesProgress(pid, rows);
    let many = 0; let single = 0;
    await trainer.listHistory(profile(pid), { type: 'anime', pageSize: 30 }, {
      settings: { keyFor: () => null }, log: quiet,
      metaGetMany: (type, ids) => { many++; assert.strictEqual(ids.length, 30); return new Map(); },
      metaGet: () => { single++; return null; },
    });
    assert.strictEqual(many, 1);
    assert.strictEqual(single, 0);
    watchedStore.deleteForProfile(pid);
  });

  console.log(`\nAll anime ratings titles checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})();
