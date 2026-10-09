// AN-3: anime in Ratings (portal + companion, List mode) — the third type.
// Run: node --experimental-sqlite test/anime-ratings.js
// Browser checks: node --experimental-sqlite test/anime-ratings.js --browser
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an3-' + Date.now();
process.env.PORT = '7321'; // distinct from the other suites (7314-7320 are taken)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const config = require('../src/config');
const settings = require('../src/settings');
const watchedStore = require('../src/watchedStore');
const tasteFeedback = require('../src/tasteFeedback');
const db = require('../src/db');
const trainer = require('../src/trainer');
const animeMap = require('../src/services/animeMap');
const simkl = require('../src/services/simkl');
const seriesEngagement = require('../src/seriesEngagement');
const personalised = require('../src/engines/marqueeAnime/personalised');

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// The anime detector test seam: the chosen imdb ids are anime (ttA1, ttA2,
// ttS1); ttS2 is an ordinary show (not in the map). at: Date.now() keeps
// ensureLoaded fresh (no download).
animeMap._setIndex({
  at: Date.now(),
  byImdb: { ttA1: { mal: 1 }, ttA2: { mal: 2 }, ttS1: { mal: 3 } },
  byTmdb: {}, byAnilist: {}, byMal: {},
});

// A series_progress row (the shape the spec gives).
function row(simkl_id, kind, imdb_id, tmdb_id, title, year, last_watched_at) {
  return { simkl_id, kind, imdb_id, tmdb_id, title, year, status: 'ongoing', watched_eps: 12, total_eps: 24, not_aired_eps: 4, last_watched_at, first_watched_at: 1000, first_real_at: null, last_real_at: null, stamps: null, real_stamps: null, eps_per_week: null };
}

// The deps the spec gives: the real watchedStore/tasteFeedback, a profile with
// Simkl connected, and a deps object carrying simkl fakes, now and log.
function makeProfile(id) {
  return { id, name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' }, filters: { engine_anime: 'marquee-anime' } };
}
function makeDeps() {
  const simklCalls = [];
  return {
    simkl: {
      setRatings: async (_p, items) => { simklCalls.push(['set', items]); return {}; },
      removeRatings: async (_p, items) => { simklCalls.push(['remove', items]); return {}; },
    },
    now: () => 5000,
    log: quiet,
    simklCalls,
  };
}

// ---- AT10: the personalised engine — the fake deps (same shape as
// test/anime-personalised.js P8). ----
function makePersonalisedDeps({ ladder, ignored, animeMap: am, anilist, trending, listSize, tier }) {
  return {
    ladder: () => ladder,
    isAnimeRow: (r) => require('../src/anime/history').isAnimeProgressRow(r),
    ignored: () => ignored || new Set(),
    watchedIds: () => ({ imdb: new Set(), tmdb: new Set() }),
    dontKeys: () => new Set(),
    animeMap: am,
    anilist,
    trending,
    trendingDeps: undefined,
    tvMeta: async () => new Map(),
    listSize: () => listSize || 5,
    tier: () => tier || null,
    decisions: null,
  };
}
function fakeAnimeMap() {
  return { ensureLoaded: async () => {}, lookup: () => null, byAnilist: () => null, byMal: () => null };
}
function fakeAnilist() {
  return { tagsFor: async () => new Map(), recommendationsFor: async () => new Map(), tagSearch: async () => [] };
}
function fakeTrending() {
  return { build: async () => [] };
}

(async () => {
  console.log('anime-ratings:');

  // ---- AT1: type + gate ----
  await ok('AT1: type + gate — resolveType(anime) ok; engine off/missing → anime-off 400 on every entry point; on → proceeds', async () => {
    assert.deepStrictEqual(trainer.resolveType('anime'), { ok: true, type: 'anime' });
    // Engine missing → anime-off on every entry point, httpStatus 400.
    const offProfile = { id: 'p-an3-off', name: 'T', filters: {} };
    const offRef = { type: 'anime', tmdb_id: '100' };
    assert.deepStrictEqual(await trainer.listHistory(offProfile, { type: 'anime' }), { ok: false, reason: 'anime-off' });
    assert.strictEqual(trainer.httpStatus({ ok: false, reason: 'anime-off' }), 400);
    assert.deepStrictEqual(await trainer.rate(offProfile, offRef, 5), { ok: false, reason: 'anime-off' });
    assert.deepStrictEqual(await trainer.setIgnored(offProfile, offRef, true), { ok: false, reason: 'anime-off' });
    assert.deepStrictEqual(await trainer.markFinished(offProfile, offRef), { ok: false, reason: 'anime-off' });
    assert.deepStrictEqual(await trainer.markUnwatched(offProfile, offRef), { ok: false, reason: 'anime-off' });
    // Engine explicitly off → anime-off.
    const offProfile2 = { id: 'p-an3-off2', name: 'T', filters: { engine_anime: 'off' } };
    assert.deepStrictEqual(await trainer.listHistory(offProfile2, { type: 'anime' }), { ok: false, reason: 'anime-off' });
    // Engine on → proceeds (not anime-off).
    const onProfile = makeProfile('p-an3-on');
    const res = await trainer.listHistory(onProfile, { type: 'anime' });
    assert.strictEqual(res.ok, true, 'engine on → listHistory proceeds');
  });

  // ---- AT2: source ----
  await ok('AT2: source — keeps kind anime + flagged shows, drops ordinary shows, de-dupes by tmdb_id (newest), skips no-tmdb_id', async () => {
    const pid = 'p-an3-src';
    watchedStore.upsertSeriesProgress(pid, [
      row(1, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
      row(2, 'anime', 'ttA2', '101', 'Anime B', 2020, 2000),
      row(3, 'show', 'ttS1', '102', 'Flagged Show', 2020, 4000),
      row(4, 'show', 'ttS2', '103', 'Ordinary Show', 2020, 1000),
      // Same tmdb_id as row 1, newer → the de-dup keeps this one.
      row(5, 'anime', 'ttA1', '100', 'Anime A (newer)', 2020, 5000),
      // No tmdb_id → skipped (counted as unresolved).
      { simkl_id: 6, kind: 'anime', imdb_id: 'ttA1', tmdb_id: null, title: 'No Tmdb', year: 2020, status: 'ongoing', watched_eps: 3, total_eps: 12, not_aired_eps: 2, last_watched_at: 6000, first_watched_at: 1000, first_real_at: null, last_real_at: null, stamps: null, real_stamps: null, eps_per_week: null },
    ]);
    const { rows, unresolved } = trainer.animeSource(pid, watchedStore);
    const tmdbIds = rows.map((r) => String(r.tmdb_id)).sort();
    // Keeps kind anime (100, 101) and the flagged show (102); drops the ordinary show (103).
    assert.deepStrictEqual(tmdbIds, ['100', '101', '102'], 'anime + flagged show, no ordinary show');
    // De-dup by tmdb_id keeping the newest (row 5, last_watched_at 5000).
    const a100 = rows.find((r) => String(r.tmdb_id) === '100');
    assert.strictEqual(a100.simkl_id, 5, 'de-dup keeps the newest');
    assert.strictEqual(a100.last_watched_at, 5000, 'de-dup keeps the newest last_watched_at');
    // No-tmdb_id row skipped and counted as unresolved.
    assert.strictEqual(unresolved, 1, 'no-tmdb_id row counted as unresolved');
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT3: shows exclude detected anime ----
  await ok('AT3: shows exclude detected anime — a flagged misfiled show is in the anime list and not the shows list; an ordinary show is in the shows list only; detector unavailable → shows list still returns', async () => {
    const pid = 'p-an3-shows';
    watchedStore.upsertSeriesProgress(pid, [
      row(1, 'show', 'ttS1', '102', 'Flagged Show', 2020, 4000),
      row(2, 'show', 'ttS2', '103', 'Ordinary Show', 2020, 1000),
    ]);
    // The flagged show is in the anime list.
    const animeRes = await trainer.listHistory(makeProfile(pid), { type: 'anime' });
    assert.deepStrictEqual(animeRes.items.map((i) => i.tmdb_id), ['102'], 'flagged show in the anime list');
    // The flagged show is NOT in the shows list; the ordinary show is.
    const showsRes = await trainer.listHistory(makeProfile(pid), { type: 'series' });
    assert.deepStrictEqual(showsRes.items.map((i) => i.tmdb_id), ['103'], 'ordinary show only in the shows list');
    // Detector unavailable (ensureLoaded throws) → the shows list still returns
    // (the exclusion still applies because the index is already loaded).
    const origEnsure = animeMap.ensureLoaded;
    animeMap.ensureLoaded = async () => { throw new Error('detector unavailable'); };
    try {
      const res = await trainer.listHistory(makeProfile(pid), { type: 'series' });
      assert.strictEqual(res.ok, true, 'shows list returns with the detector off');
      assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['103'], 'detector off → ordinary show only (exclusion still applies)');
    } finally {
      animeMap.ensureLoaded = origEnsure;
    }
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT4: list ----
  await ok('AT4: list — an anime item deep-equals the show item shape (type series, progress, 15+1 keys); counts per view; search case-insensitive; 25 per page; newest first; view unfinished → bad-view', async () => {
    const pid = 'p-an3-list';
    watchedStore.upsertSeriesProgress(pid, [
      row(1, 'anime', 'ttA1', '100', 'Alpha Anime', 2020, 3000),
      row(2, 'anime', 'ttA2', '101', 'Beta Anime', 2020, 2000),
    ]);
    tasteFeedback.upsertRating(pid, { type: 'series', tmdb_id: '100', rating: 10 }); // loved
    tasteFeedback.upsertRating(pid, { type: 'series', tmdb_id: '101', rating: 7 }); // rated
    tasteFeedback.setIgnored(pid, { type: 'series', tmdb_id: '101' }, true, 5000);
    const profile = makeProfile(pid);
    const deps = makeDeps();
    let res = await trainer.listHistory(profile, { type: 'anime' }, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.total, 1, 'Alpha Anime (Beta is ignored)');
    // The anime item deep-equals the show item shape (type series, progress, 15+1 keys).
    const alpha = res.items[0];
    assert.deepStrictEqual(alpha, {
      key: '100', type: 'series', simkl_id: 1, tmdb_id: '100', imdb_id: 'ttA1',
      title: 'Alpha Anime', year: 2020, genre: null, poster: null,
      watched_at: new Date(3000).toISOString(),
      rating: 10, loved: true, ignored: false, status: 'watched', percent: null,
      progress: { watched_eps: 12, aired_eps: 20 },
    });
    // 15 base keys + progress.
    const baseKeys = ['key', 'type', 'simkl_id', 'tmdb_id', 'imdb_id', 'title', 'year', 'genre', 'poster', 'watched_at', 'rating', 'loved', 'ignored', 'status', 'percent'];
    assert.deepStrictEqual(Object.keys(alpha).sort(), [...baseKeys, 'progress'].sort(), '15+1 keys');
    // counts per view.
    assert.deepStrictEqual(res.counts, { all: 1, unrated: 0, rated: 1, loved: 1, ignored: 1, unfinished: 0, unresolved: 0 });
    // views.
    res = await trainer.listHistory(profile, { type: 'anime', view: 'loved' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['100']);
    res = await trainer.listHistory(profile, { type: 'anime', view: 'ignored' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['101']);
    // search (case-insensitive title substring).
    res = await trainer.listHistory(profile, { type: 'anime', q: 'beta' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), []);
    // view unfinished → bad-view.
    res = await trainer.listHistory(profile, { type: 'anime', view: 'unfinished' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-view' });
    // 25 per page (a page_size larger than 25 is clamped to 25).
    res = await trainer.listHistory(profile, { type: 'anime', page_size: 100 }, deps);
    assert.strictEqual(res.pageSize, 25);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT5: rate ----
  await ok('AT5: rate — one Simkl write with body shows: [{ ids: { simkl, imdb, tmdb }, rating }]; then a local taste_ratings row of type series for that tmdb id; the response item has rating and loved (10 → true)', async () => {
    const pid = 'p-an3-rate';
    watchedStore.upsertSeriesProgress(pid, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    const profile = makeProfile(pid);
    const deps = makeDeps();
    let res = await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 8, deps);
    assert.strictEqual(res.ok, true);
    // One Simkl write with the exact body (type series, in shows).
    assert.deepStrictEqual(deps.simklCalls, [['set', [{ type: 'series', simkl_id: 101, imdb_id: 'ttA1', tmdb_id: '100', rating: 8 }]]]);
    assert.deepStrictEqual(simkl.buildRatingsBody(deps.simklCalls[0][1]), { movies: [], shows: [{ ids: { simkl: 101, imdb: 'ttA1', tmdb: '100' }, rating: 8 }] });
    // The local row is written after the Simkl call, type series for that tmdb id.
    assert.strictEqual(tasteFeedback.getRating(pid, 'series', '100'), 8);
    assert.ok(tasteFeedback.getRatingsMap(pid, 'series').has('100'), 'taste_ratings row of type series');
    // The response item has rating and loved.
    assert.strictEqual(res.item.rating, 8);
    assert.strictEqual(res.item.loved, false);
    // Rate 10 → loved true.
    res = await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 10, deps);
    assert.strictEqual(res.item.rating, 10);
    assert.strictEqual(res.item.loved, true);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT6: Simkl first ----
  await ok('AT6: Simkl first — a thrown Simkl call → no local row; a not_found response → simkl-rejected 422, no local row; a normal response → ok', async () => {
    const pid = 'p-an3-simkl';
    watchedStore.upsertSeriesProgress(pid, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    const profile = makeProfile(pid);
    // A thrown Simkl call → no local row.
    const throwing = {
      simkl: { setRatings: async () => { throw new Error('Simkl POST /sync/ratings failed (500)'); }, removeRatings: async () => { throw new Error('Simkl POST /sync/ratings/remove failed (500)'); } },
      now: () => 5000, log: quiet,
    };
    await assert.rejects(() => trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 6, throwing));
    assert.strictEqual(tasteFeedback.getRating(pid, 'series', '100'), null, 'no local row after a throw');
    // A not_found response → simkl-rejected 422, no local row.
    const notFound = {
      simkl: { setRatings: async () => ({ not_found: { shows: [{ ids: { simkl: 101 } }] } }), removeRatings: async () => ({}) },
      now: () => 5000, log: quiet,
    };
    let res = await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 6, notFound);
    assert.deepStrictEqual(res, { ok: false, reason: 'simkl-rejected' });
    assert.strictEqual(trainer.httpStatus(res), 422);
    assert.strictEqual(tasteFeedback.getRating(pid, 'series', '100'), null, 'no local row after a rejection');
    // A normal response → ok.
    const normal = {
      simkl: { setRatings: async () => ({ added: { shows: [{}] } }), removeRatings: async () => ({}) },
      now: () => 5000, log: quiet,
    };
    res = await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 6, normal);
    assert.strictEqual(res.ok, true, 'normal response → ok');
    assert.strictEqual(tasteFeedback.getRating(pid, 'series', '100'), 6, 'local row written after a normal response');
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT7: clear ----
  await ok('AT7: clear — clearing a rating sends removeRatings (the same not_found rule) and removes the local row', async () => {
    const pid = 'p-an3-clear';
    watchedStore.upsertSeriesProgress(pid, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    const profile = makeProfile(pid);
    const deps = makeDeps();
    await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 8, deps);
    assert.strictEqual(tasteFeedback.getRating(pid, 'series', '100'), 8);
    // Clear → removeRatings (type series) and the local row removed.
    deps.simklCalls.length = 0;
    let res = await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, null, deps);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(deps.simklCalls, [['remove', [{ type: 'series', simkl_id: 101, imdb_id: 'ttA1', tmdb_id: '100' }]]]);
    assert.strictEqual(tasteFeedback.getRating(pid, 'series', '100'), null, 'local row removed');
    // The same not_found rule on a clear → simkl-rejected.
    // First set a rating with the normal deps, then try to clear with the notFound fake.
    await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, 8, deps);
    const notFound = {
      simkl: { setRatings: async () => ({}), removeRatings: async () => ({ not_found: { shows: [{ ids: { simkl: 101 } }] } }) },
      now: () => 5000, log: quiet,
    };
    res = await trainer.rate(profile, { type: 'anime', tmdb_id: '100' }, null, notFound);
    assert.deepStrictEqual(res, { ok: false, reason: 'simkl-rejected' });
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT8: ignore ----
  await ok('AT8: ignore — setIgnored stores taste_ignore type series; ignoredSet contains it; unignore removes it; the item shows ignored', async () => {
    const pid = 'p-an3-ignore';
    watchedStore.upsertSeriesProgress(pid, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    const profile = makeProfile(pid);
    const deps = makeDeps();
    // ignore → local row written, type series.
    let res = await trainer.setIgnored(profile, { type: 'anime', tmdb_id: '100' }, true, deps);
    assert.strictEqual(res.ok, true);
    assert.ok(tasteFeedback.ignoredSet(pid, 'series').has('100'), 'taste_ignore type series');
    assert.strictEqual(res.item.ignored, true, 'the item shows ignored');
    // unignore → local row removed.
    res = await trainer.setIgnored(profile, { type: 'anime', tmdb_id: '100' }, false, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(tasteFeedback.ignoredSet(pid, 'series').size, 0, 'unignore removes it');
    db.get().exec('DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT9: other actions ----
  await ok('AT9: other actions — markFinished / markUnwatched for anime return exactly what the same call returns for a show', async () => {
    const pid = 'p-an3-actions';
    watchedStore.upsertSeriesProgress(pid, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    const profile = makeProfile(pid);
    const deps = makeDeps();
    // markFinished for anime → not-supported (the same as a show).
    assert.deepStrictEqual(await trainer.markFinished(profile, { type: 'anime', tmdb_id: '100' }, deps), { ok: false, reason: 'not-supported' });
    assert.deepStrictEqual(await trainer.markFinished(profile, { type: 'series', tmdb_id: '100' }, deps), { ok: false, reason: 'not-supported' });
    // markUnwatched for anime → not-supported (the same as a show).
    assert.deepStrictEqual(await trainer.markUnwatched(profile, { type: 'anime', tmdb_id: '100' }, deps), { ok: false, reason: 'not-supported' });
    assert.deepStrictEqual(await trainer.markUnwatched(profile, { type: 'series', tmdb_id: '100' }, deps), { ok: false, reason: 'not-supported' });
    watchedStore.deleteForProfile(pid);
  });

  // ---- AT10: the engine learns it ----
  await ok('AT10: the engine learns it — an anime row rated 10 is a seed (seedEligible); an ignored anime is dropped from the personalised history', async () => {
    const pid = 'p-an3-engine';
    watchedStore.upsertSeriesProgress(pid, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    // Rate it 10 (stored as a series rating of the show TMDB id).
    tasteFeedback.upsertRating(pid, { type: 'series', tmdb_id: '100', rating: 10 });
    // The real ladder (seriesEngagement.ladderFor) picks up the rating.
    const ladder = seriesEngagement.ladderFor(pid);
    const entry = ladder.get(101);
    assert.ok(entry, 'ladder entry for the anime row');
    assert.strictEqual(entry.seedEligible, true, 'rated 10 → seedEligible');
    // personalised.build treats it as a seed (engaged >= 1).
    const deps = makePersonalisedDeps({ ladder, ignored: new Set(), animeMap: fakeAnimeMap(), anilist: fakeAnilist(), trending: fakeTrending() });
    let ctx = { log: quiet };
    await personalised.build({ id: pid, name: 'T' }, ctx, deps);
    assert.strictEqual(ctx.animeEngaged, 1, 'the anime is a seed');
    // An ignored anime is dropped from the personalised history.
    const depsIgnored = makePersonalisedDeps({ ladder, ignored: new Set(['100']), animeMap: fakeAnimeMap(), anilist: fakeAnilist(), trending: fakeTrending() });
    ctx = { log: quiet };
    await personalised.build({ id: pid, name: 'T' }, ctx, depsIgnored);
    assert.strictEqual(ctx.animeEngaged, 0, 'an ignored anime is dropped');
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(pid);
  });

  // ---- HTTP surface (AH1-AH3) — the real server, admin session ----
  console.log('anime-ratings http:');
  require('../src/server');
  const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
  const { token } = provisionAdmin();
  const restore = attachCookie(BASE, cookieHeader(token));
  await new Promise((r) => setTimeout(r, 200)); // let the server finish listening.

  // Authenticated GET/POST helpers (global.fetch is wrapped to add the admin cookie).
  async function get(path) {
    const res = await fetch(BASE + path);
    return { status: res.status, body: await res.json() };
  }
  async function post(path, body) {
    const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  // A profile with the engine on and a Simkl connection, seeded with an anime row.
  function seedAnimeProfile(name, engine) {
    const p = config.addProfile(name);
    config.updateProfile(p.id, { filters: { engine_anime: engine }, keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } });
    watchedStore.upsertSeriesProgress(p.id, [
      row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000),
    ]);
    return p;
  }

  // ---- AH1: GET /api/profiles/:id/trainer?type=anime ----
  await ok('AH1: GET /api/profiles/:id/trainer?type=anime → 200 with items when the engine is on; 400 anime-off when off', async () => {
    const on = seedAnimeProfile('AN3-on', 'marquee-anime');
    const r1 = await get(`/api/profiles/${on.id}/trainer?type=anime`);
    assert.strictEqual(r1.status, 200, 'engine on → 200');
    assert.strictEqual(r1.body.items.length, 1, 'one item');
    assert.strictEqual(r1.body.items[0].tmdb_id, '100');
    const off = seedAnimeProfile('AN3-off', 'off');
    const r2 = await get(`/api/profiles/${off.id}/trainer?type=anime`);
    assert.strictEqual(r2.status, 400, 'engine off → 400');
    assert.deepStrictEqual(r2.body, { error: 'anime-off' });
    config.removeProfile(on.id);
    config.removeProfile(off.id);
  });

  // ---- AH2: POST /api/profiles/:id/trainer/ignore with type anime ----
  await ok('AH2: POST /api/profiles/:id/trainer/ignore with type anime → 200 and the ignore is stored as series', async () => {
    const p = seedAnimeProfile('AN3-ignore', 'marquee-anime');
    const r = await post(`/api/profiles/${p.id}/trainer/ignore`, { type: 'anime', tmdb_id: '100', ignored: true });
    assert.strictEqual(r.status, 200, '200');
    assert.ok(tasteFeedback.ignoredSet(p.id, 'series').has('100'), 'the ignore is stored as series');
    config.removeProfile(p.id);
  });

  // ---- AH3: companion handler ----
  await ok('AH3: companion handler — handlers.trainerHandler with type anime returns 200/400 the same way; type bogus is still rejected', async () => {
    const handlers = require('../mobile/server/handlers');
    function fakeRes() {
      const res = { statusCode: null, body: null };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => { res.body = body; return res; };
      return res;
    }
    const onId = seedAnimeProfile('AN3-companion', 'marquee-anime').id;
    const on = config.getProfile(onId);
    // type anime → 200.
    let res = fakeRes();
    await handlers.trainerHandler({ profile: on, query: { type: 'anime' } }, res);
    assert.strictEqual(res.statusCode, 200, 'type anime → 200');
    assert.strictEqual(res.body.items.length, 1);
    // engine off → 400 anime-off.
    const offId = config.addProfile('AN3-companion-off').id;
    config.updateProfile(offId, { filters: { engine_anime: 'off' } });
    watchedStore.upsertSeriesProgress(offId, [row(101, 'anime', 'ttA1', '100', 'Anime A', 2020, 3000)]);
    const off = config.getProfile(offId);
    res = fakeRes();
    await handlers.trainerHandler({ profile: off, query: { type: 'anime' } }, res);
    assert.strictEqual(res.statusCode, 400, 'engine off → 400');
    assert.deepStrictEqual(res.body, { error: 'anime-off' });
    // type bogus → 400 bad-type.
    res = fakeRes();
    await handlers.trainerHandler({ profile: on, query: { type: 'bogus' } }, res);
    assert.strictEqual(res.statusCode, 400, 'type bogus → 400');
    assert.deepStrictEqual(res.body, { error: 'bad-type' });
    config.removeProfile(onId);
    config.removeProfile(offId);
  });

  // ---- AU1: the pager noun ----
  await ok('AU1: pagerText — Page 1 of 2 · 30 films; with noun shows → 30 shows; with noun anime → 30 anime', async () => {
    const TrainerUI = require('../public/trainer-ui');
    assert.strictEqual(TrainerUI.pagerText(1, 25, 30), 'Page 1 of 2 · 30 films');
    assert.strictEqual(TrainerUI.pagerText(1, 25, 30, 'shows'), 'Page 1 of 2 · 30 shows');
    assert.strictEqual(TrainerUI.pagerText(1, 25, 30, 'anime'), 'Page 1 of 2 · 30 anime');
  });

  // ---- Browser BT1-BT4 + companion BC1-BC2 (only with --browser) ----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const path = require('path');
    const fs = require('fs');
    const browser = await chromium.launch({ headless: true });
    const screenshotDir = path.join(process.env.DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
    const pageErrors = [];
    const adminCookie = { name: 'air_sid', value: token, url: BASE };

    // Set TMDB + Groq keys so the portal leaves setup mode (as anime-lane.js does).
    settings.updateSettings({ keys: { tmdb_api_key: 'x'.repeat(32) }, llm: { groq_api_key: 'gsk_test' } });

    // Seed a profile with three anime rows and two ordinary show rows, with a
    // Simkl connection (so the rating controls are enabled).
    function seedBrowserProfile(name, engine) {
      const p = config.addProfile(name);
      config.updateProfile(p.id, { filters: { engine_anime: engine }, keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } });
      watchedStore.upsertSeriesProgress(p.id, [
        row(1, 'anime', 'ttA1', '100', 'Alpha Anime', 2020, 3000),
        row(2, 'anime', 'ttA2', '101', 'Beta Anime', 2020, 2000),
        row(3, 'show', 'ttS1', '102', 'Gamma Anime (flagged)', 2020, 4000),
        row(4, 'show', 'ttS2', '103', 'Delta Show', 2020, 1000),
        row(5, 'show', 'ttS2', '104', 'Echo Show', 2020, 500),
      ]);
      return p;
    }

    // Select a profile in the portal dropdown and open its Ratings (trainer) tab.
    async function openAdvanced(page, profileId) {
      await page.goto(`${BASE}/configure/`);
      await page.waitForSelector('#userSelect');
      await page.selectOption('#userSelect', profileId);
      await page.waitForSelector('.card[data-id]');
      await page.locator('.tab-btn[data-tab="trainer"]').click();
    }

    // ---- BT1: toggle ----
    await ok('BT1: toggle — engine on → exactly three tr-type tr-chip buttons (Films, Shows, Anime); engine off → exactly two', async () => {
      const on = seedBrowserProfile('AN3-bt1-on', 'marquee-anime');
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, on.id);
      await page.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      const labels = await page.locator('.trainer-panel .tr-type .tr-chip').allInnerTexts();
      assert.deepStrictEqual(labels, ['Films', 'Shows', 'Anime'], 'three buttons in order');
      await context.close();
      const off = seedBrowserProfile('AN3-bt1-off', 'off');
      const context2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context2.addCookies([adminCookie]);
      const page2 = await context2.newPage();
      page2.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page2, off.id);
      await page2.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      const labels2 = await page2.locator('.trainer-panel .tr-type .tr-chip').allInnerTexts();
      assert.deepStrictEqual(labels2, ['Films', 'Shows'], 'two buttons when the engine is off');
      await context2.close();
      config.removeProfile(on.id);
      config.removeProfile(off.id);
    });

    // ---- BT2: list + style parity ----
    await ok('BT2: list + style parity — the Anime row skeleton equals the Shows row skeleton; the pager ends anime/shows; the empty text is No anime in this view yet.', async () => {
      const p = seedBrowserProfile('AN3-bt2', 'marquee-anime');
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, p.id);
      await page.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      // Click Anime → 3 rows.
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="anime"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      const animeRows = await page.locator('.trainer-panel .tr-table .tr-row').count();
      assert.strictEqual(animeRows, 3, 'three anime rows');
      const animeSkeleton = await page.evaluate(() => {
        const row = document.querySelector('.trainer-panel .tr-table .tr-row');
        return row.outerHTML
          .replace(/<img[^>]*>/g, '<img>') // drop src
          .replace(/\btitle="[^"]*"/g, '') // drop title
          .replace(/\bdata-key="[^"]*"/g, '') // drop data-key
          .replace(/\baria-label="[^"]*"/g, '') // drop aria-label
          .replace(/>[^<>]+</g, '>#<'); // replace text nodes with #
      });
      // Click Shows → take its first row.
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="series"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      const showsSkeleton = await page.evaluate(() => {
        const row = document.querySelector('.trainer-panel .tr-table .tr-row');
        return row.outerHTML
          .replace(/<img[^>]*>/g, '<img>')
          .replace(/\btitle="[^"]*"/g, '')
          .replace(/\bdata-key="[^"]*"/g, '')
          .replace(/\baria-label="[^"]*"/g, '')
          .replace(/>[^<>]+</g, '>#<');
      });
      assert.strictEqual(animeSkeleton, showsSkeleton, 'the two row skeletons are equal');
      // The pager text ends anime on the Anime tab and shows on the Shows tab.
      const showsPager = await page.locator('.trainer-panel .tr-pager .muted').innerText();
      assert.ok(showsPager.endsWith('shows'), 'pager ends shows: ' + showsPager);
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="anime"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      const animePager = await page.locator('.trainer-panel .tr-pager .muted').innerText();
      assert.ok(animePager.endsWith('anime'), 'pager ends anime: ' + animePager);
      // The empty text for an empty view is No anime in this view yet.
      await page.locator('.trainer-panel .tr-views .tr-chip[data-view="loved"]').click();
      await page.waitForSelector('.trainer-panel .tr-table', { timeout: 10000 });
      const emptyText = await page.locator('.trainer-panel .tr-table .muted').innerText();
      assert.strictEqual(emptyText, 'No anime in this view yet.', 'empty text');
      await context.close();
      config.removeProfile(p.id);
    });

    // ---- BT3: rate ----
    await ok('BT3: rate — click the 8th half-star (rating 4) on an anime row; the stubbed POST trainer/rate was called once with type anime and the row tmdb_id', async () => {
      const p = seedBrowserProfile('AN3-bt3', 'marquee-anime');
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      let rateCalls = [];
      await page.route(`${BASE}/api/profiles/${p.id}/trainer/rate`, (route) => {
        rateCalls.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: {} }) });
      });
      await openAdvanced(page, p.id);
      await page.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="anime"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      // Click the 8th half-star (the 4th star, right half → rating 4).
      await page.locator('.trainer-panel .tr-table .tr-row .tr-star[data-rating="4"]').first().click();
      await page.waitForTimeout(1200); // the 800 ms debounce + a margin.
      assert.strictEqual(rateCalls.length, 1, 'one rate call');
      assert.strictEqual(rateCalls[0].type, 'anime', 'type anime');
      assert.ok(rateCalls[0].tmdb_id, 'the row tmdb_id');
      await context.close();
      config.removeProfile(p.id);
    });

    // ---- BT4: screenshots ----
    await ok('BT4: screenshots — the Anime tab at 1280x800 and 400x800 (no horizontal scroll), plus the Shows tab at 1280', async () => {
      const p = seedBrowserProfile('AN3-bt4', 'marquee-anime');
      // 1280x800 Anime.
      let context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      let page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, p.id);
      await page.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="anime"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      await page.locator('.sec-box:has(.trainer-panel)').first().screenshot({ path: path.join(screenshotDir, 'anime-ratings-bt4-anime-1280.png') });
      await context.close();
      // 400x800 Anime (no horizontal scroll).
      context = await browser.newContext({ viewport: { width: 400, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, p.id);
      await page.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="anime"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const innerWidth = await page.evaluate(() => window.innerWidth);
      assert.ok(scrollWidth <= innerWidth, `scrollWidth ${scrollWidth} <= innerWidth ${innerWidth}`);
      await page.locator('.sec-box:has(.trainer-panel)').first().screenshot({ path: path.join(screenshotDir, 'anime-ratings-bt4-anime-400.png') });
      await context.close();
      // 1280x800 Shows (for comparison).
      context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, p.id);
      await page.waitForSelector('.trainer-panel .tr-type', { timeout: 10000 });
      await page.locator('.trainer-panel .tr-type .tr-chip[data-type="series"]').click();
      await page.waitForSelector('.trainer-panel .tr-table .tr-row', { timeout: 10000 });
      await page.locator('.sec-box:has(.trainer-panel)').first().screenshot({ path: path.join(screenshotDir, 'anime-ratings-bt4-shows-1280.png') });
      await context.close();
      config.removeProfile(p.id);
    });

    // ---- BC1-BC2: the companion ----
    // The mobile companion is bound to the admin profile (the session cookie).
    // Set engine_anime on the admin profile to test the toggle.
    const adminProfile = config.listProfiles().find((p) => p.is_admin === true);

    await ok('BC1: companion — the segmented control has Films, Shows, Anime; tap Anime and a row list appears; screenshot', async () => {
      // Set engine_anime on the admin profile.
      config.updateProfile(adminProfile.id, { filters: { engine_anime: 'marquee-anime' } });
      // Seed anime rows for the admin profile.
      watchedStore.upsertSeriesProgress(adminProfile.id, [
        row(1, 'anime', 'ttA1', '100', 'Alpha Anime', 2020, 3000),
        row(2, 'anime', 'ttA2', '101', 'Beta Anime', 2020, 2000),
        row(3, 'show', 'ttS1', '102', 'Gamma Anime (flagged)', 2020, 4000),
        row(4, 'show', 'ttS2', '103', 'Delta Show', 2020, 1000),
        row(5, 'show', 'ttS2', '104', 'Echo Show', 2020, 500),
      ]);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${BASE}/mobile/#/trainer`);
      // Switch to List mode (the default is Quick).
      await page.waitForSelector('.trainer-tabs', { timeout: 10000 });
      await page.locator('.trainer-tabs .seg[data-tmode="list"]').click();
      await page.waitForSelector('.trainer-type', { timeout: 10000 });
      const labels = await page.locator('.trainer-type .seg').allInnerTexts();
      assert.deepStrictEqual(labels, ['Films', 'Shows', 'Anime'], 'the segmented control has Films, Shows, Anime');
      await page.locator('.trainer-type .seg[data-type="anime"]').click();
      await page.waitForSelector('.tr-table .tr-row', { timeout: 10000 });
      const rows = await page.locator('.tr-table .tr-row').count();
      assert.ok(rows >= 3, 'a row list appears');
      await page.screenshot({ path: path.join(screenshotDir, 'anime-ratings-bc1-companion-anime.png') });
      await context.close();
      // Reset the admin profile's engine_anime.
      config.updateProfile(adminProfile.id, { filters: { engine_anime: 'off' } });
      watchedStore.deleteForProfile(adminProfile.id);
    });

    await ok('BC2: companion — engine off → two buttons', async () => {
      // Ensure engine_anime is off for the admin profile.
      config.updateProfile(adminProfile.id, { filters: { engine_anime: 'off' } });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${BASE}/mobile/#/trainer`);
      // Switch to List mode (the default is Quick).
      await page.waitForSelector('.trainer-tabs', { timeout: 10000 });
      await page.locator('.trainer-tabs .seg[data-tmode="list"]').click();
      await page.waitForSelector('.trainer-type', { timeout: 10000 });
      const labels = await page.locator('.trainer-type .seg').allInnerTexts();
      assert.deepStrictEqual(labels, ['Films', 'Shows'], 'engine off → two buttons');
      await context.close();
    });

    await ok('BC3: no page errors', async () => {
      assert.deepStrictEqual(pageErrors, [], 'no page errors');
    });

    restore();
    await browser.close();
  }

  console.log(`\nAll anime ratings checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  // The HTTP + browser tests start the real server; exiting while its sockets
  // are still closing aborts Node on Windows (exit 127), which stops the npm
  // test chain. Let the handles drain first.
  await new Promise((r) => setTimeout(r, 1000));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
