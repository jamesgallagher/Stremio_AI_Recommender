// AN-1a: the anime lane — lanes, the Marquee Anime engine, settings, the store
// plumbing, the AniDB client, the MAL API source and the one-time migration.
// Run: node --experimental-sqlite test/anime-lane.js
// Browser checks: node --experimental-sqlite test/anime-lane.js --browser
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-an1a-' + Date.now();
process.env.PORT = '7316'; // distinct from engines-marquee-only (7315)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const lanes = require('../src/lanes');
const engines = require('../src/engines');
const config = require('../src/config');
const settings = require('../src/settings');
const store = require('../src/store');

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

(async () => {
  console.log('anime-lane:');

  // ---- A1: lanes — the anime lane's item/lookup/DNR types ----
  await ok('A1: lanes — itemType/lookupType/dnrTypes for the anime lane', async () => {
    assert.strictEqual(lanes.itemType('anime'), 'series');
    assert.strictEqual(lanes.lookupType('anime'), 'series');
    assert.deepStrictEqual(lanes.dnrTypes('anime'), ['anime', 'series']);
    // movie/series lanes are unchanged.
    assert.strictEqual(lanes.itemType('movie'), 'movie');
    assert.strictEqual(lanes.lookupType('movie'), 'movie');
    assert.deepStrictEqual(lanes.dnrTypes('movie'), ['movie']);
    assert.strictEqual(lanes.itemType('series'), 'series');
    assert.strictEqual(lanes.lookupType('series'), 'series');
    assert.deepStrictEqual(lanes.dnrTypes('series'), ['series']);
  });

  // ---- A2: registry — resolveFor + isValidFor for the anime lane ----
  await ok('A2: registry — resolveFor anime null/off/bogus; Marquee Anime for marquee-anime; isValidFor', async () => {
    // resolveFor(p, 'anime') is null for undefined / 'off' / 'bogus'
    assert.strictEqual(engines.resolveFor({ filters: {} }, 'anime'), null);
    assert.strictEqual(engines.resolveFor({ filters: { engine_anime: 'off' } }, 'anime'), null);
    assert.strictEqual(engines.resolveFor({ filters: { engine_anime: 'bogus' } }, 'anime'), null);
    // and the Marquee Anime engine for 'marquee-anime'
    const on = engines.resolveFor({ filters: { engine_anime: 'marquee-anime' } }, 'anime');
    assert.strictEqual(on && on.id, 'marquee-anime');
    // isValidFor: OFF only for optional lanes
    assert.strictEqual(engines.isValidFor('movie', 'off'), false);
    assert.strictEqual(engines.isValidFor('series', 'off'), false);
    assert.strictEqual(engines.isValidFor('anime', 'off'), true);
    // Movie/series resolution is unchanged for all of these.
    assert.strictEqual(engines.resolveFor({ filters: {} }, 'movie').id, 'marquee');
    assert.strictEqual(engines.resolveFor({ filters: {} }, 'series').id, 'marquee-tv');
    assert.strictEqual(engines.resolveFor({ filters: { engine_movie: 'off' } }, 'movie').id, 'marquee');
    assert.strictEqual(engines.resolveFor({ filters: { engine_series: 'off' } }, 'series').id, 'marquee-tv');
  });

  // ---- A3: config — engine_anime default, migration, updateProfile validation ----
  await ok('A3: config — engine_anime default/migration/updateProfile', async () => {
    // A new profile has engine_anime: 'off'.
    const p = config.addProfile('AN1A-A3');
    try {
      assert.strictEqual(config.getProfile(p.id).filters.engine_anime, 'off', 'new profile defaults to off');
      // updateProfile({filters:{engine_anime:'marquee-anime'}}) → engineChanged deep-equals ['anime'].
      const r1 = config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
      assert.deepStrictEqual(r1.engineChanged, ['anime'], 'marquee-anime → engineChanged [anime]');
      assert.strictEqual(config.getProfile(p.id).filters.engine_anime, 'marquee-anime');
      // Setting it back → ['anime'].
      const r2 = config.updateProfile(p.id, { filters: { engine_anime: 'off' } });
      assert.deepStrictEqual(r2.engineChanged, ['anime'], 'off → engineChanged [anime]');
      assert.strictEqual(config.getProfile(p.id).filters.engine_anime, 'off');
      // 'nope' → stored 'off' (no engineChanged: the value was already 'off').
      config.updateProfile(p.id, { filters: { engine_anime: 'nope' } });
      assert.strictEqual(config.getProfile(p.id).filters.engine_anime, 'off', 'nope stored as off');
    } finally {
      config.removeProfile(p.id);
    }
    // A stored engine_anime: 'glass' migrates to 'off'.
    const p2 = config.addProfile('AN1A-A3-migrate');
    try {
      store.saveProfiles({ profiles: [{
        id: p2.id, name: 'AN1A-A3-migrate',
        token: require('crypto').randomBytes(16).toString('hex'),
        email: '', is_admin: false, created_at: Date.now(),
        keys: {}, filters: { engine_anime: 'glass' },
      }] });
      assert.strictEqual(config.getProfile(p2.id).filters.engine_anime, 'off', 'glass migrates to off');
    } finally {
      config.removeProfile(p2.id);
    }
  });

  // ---- A4: settings — resolveMalKey / resolveAnidbClient + sealing on disk ----
  await ok('A4: settings — resolveMalKey/resolveAnidbClient user>server>none + sealing', async () => {
    // Set a server (global) pair.
    settings.updateSettings({ keys: { mal_client_id: 'server-mal', anidb_client: 'server-anidb', anidb_clientver: 2 } });
    const server = settings.getSettings();
    assert.strictEqual(server.keys.mal_client_id, 'server-mal');

    // A profile with no personal keys → server.
    const p = config.addProfile('AN1A-A4');
    try {
      assert.deepStrictEqual(settings.resolveMalKey(p), { key: 'server-mal', source: 'server' }, 'no personal → server mal');
      assert.deepStrictEqual(settings.resolveAnidbClient(p), { client: 'server-anidb', clientver: 2, source: 'server' }, 'no personal → server anidb');

      // A profile with personal keys → user (personal first).
      config.updateProfile(p.id, { keys: { mal_client_id: 'user-mal', anidb_client: 'user-anidb', anidb_clientver: 1 } });
      const prof = config.getProfile(p.id);
      assert.deepStrictEqual(settings.resolveMalKey(prof), { key: 'user-mal', source: 'user' }, 'personal → user mal');
      assert.deepStrictEqual(settings.resolveAnidbClient(prof), { client: 'user-anidb', clientver: 1, source: 'user' }, 'personal → user anidb');

      // A half pair (name, no version) counts as none at that level.
      config.updateProfile(p.id, { keys: { anidb_client: 'name-only', anidb_clientver: 0 } });
      const half = config.getProfile(p.id);
      assert.deepStrictEqual(settings.resolveAnidbClient(half), { client: 'server-anidb', clientver: 2, source: 'server' }, 'half personal pair → falls through to server');

      // No server pair either → none.
      settings.updateSettings({ keys: { anidb_client: '', anidb_clientver: 0 } });
      const none = config.getProfile(p.id);
      assert.deepStrictEqual(settings.resolveAnidbClient(none), { client: '', clientver: 0, source: 'none' }, 'no pair → none');
      assert.deepStrictEqual(settings.resolveMalKey({ keys: {} }), { key: 'server-mal', source: 'server' }, 'mal still server');

      // Sealing on disk: mal_client_id and anidb_client are sealed (enc::), anidb_clientver is a plain number.
      config.updateProfile(p.id, { keys: { mal_client_id: 'user-mal', anidb_client: 'user-anidb', anidb_clientver: 3 } });
      const raw = store.loadProfiles().profiles.find((x) => x.id === p.id);
      assert.ok(raw.keys.mal_client_id.startsWith('enc::'), 'mal_client_id sealed on disk');
      assert.ok(raw.keys.anidb_client.startsWith('enc::'), 'anidb_client sealed on disk');
      assert.strictEqual(typeof raw.keys.anidb_clientver, 'number', 'anidb_clientver is a plain number');
      assert.strictEqual(raw.keys.anidb_clientver, 3, 'anidb_clientver value preserved');
    } finally {
      config.removeProfile(p.id);
      settings.updateSettings({ keys: { mal_client_id: '', anidb_client: '', anidb_clientver: 0 } });
    }
  });

  // ---- A5: build plumbing — fake anime engine stores 3 rows, movie/series unchanged ----
  await ok('A5: build plumbing — fake anime engine stores 3 anime rows; movie/series unchanged; pruneOtherEngines(series) leaves anime', async () => {
    const rec = require('../src/recommendationStore');

    // Register fake movie/series engines (no Simkl needed) + a fake anime engine.
    const fakeMovie = {
      id: 'fake-movie', name: 'Fake Movie', supportedTypes: ['movie'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate() { return []; },
      ALGORITHM_VERSION: 'fake-movie-v1',
    };
    const fakeSeries = {
      id: 'fake-series', name: 'Fake Series', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate() { return []; },
      ALGORITHM_VERSION: 'fake-series-v1',
    };
    const fakeAnime = {
      id: 'fake-anime', name: 'Fake Anime', supportedTypes: ['anime'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate(profile, type, ctx) {
        ctx.stats = { seeds: 3, raw: 3, strong: 3, kept: 3 };
        return [
          { type: 'anime', tmdb_id: '9001', imdb_id: 'tt9001', title: 'Anime One', year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 3, because_title: 'Watched Show', poster: '/p1.jpg', popularity: 0 },
          { type: 'anime', tmdb_id: '9002', imdb_id: 'tt9002', title: 'Anime Two', year: 2021, primary_genre: 'Fantasy', genres: 'Fantasy,Anime', vote_average: 8.0, affinity: 0.8, rec_count: 2, because_title: 'Watched Show', poster: '/p2.jpg', popularity: 0 },
          { type: 'anime', tmdb_id: '9003', imdb_id: 'tt9003', title: 'Anime Three', year: 2022, primary_genre: 'Comedy', genres: 'Comedy,Anime', vote_average: 7.0, affinity: 0.7, rec_count: 1, because_title: 'Watched Show', poster: '/p3.jpg', popularity: 0 },
        ];
      },
      ALGORITHM_VERSION: 'fake-anime-v1',
    };
    const unregMovie = engines._register(fakeMovie);
    const unregSeries = engines._register(fakeSeries);
    const unregAnime = engines._register(fakeAnime);

    settings.updateSettings({ keys: { tmdb_api_key: 'test-tmdb-key' } });

    const p = config.addProfile('AN1A-A5');
    try {
      // Profile with the fake engines.
      config.updateProfile(p.id, { filters: { engine_movie: 'fake-movie', engine_series: 'fake-series', engine_anime: 'fake-anime' } });
      const prof = config.getProfile(p.id);

      // Build with the anime engine on.
      const r1 = await rec.buildRecommendations(prof, console);
      assert.strictEqual(r1.anime && r1.anime.stored, 3, 'anime stored 3 rows');
      assert.strictEqual(r1.engines.anime, 'fake-anime', 'engines.anime is fake-anime');

      // Verify 3 rows with type='anime' in the pool.
      const animeRows = rec.getRecommended(p.id, { type: 'anime' });
      assert.strictEqual(animeRows.length, 3, '3 anime rows in pool');
      assert.ok(animeRows.every((r) => r.type === 'anime'), 'all rows type=anime');

      // Movie/series row counts are identical with and without the anime engine.
      const movieCount = rec.getRecommended(p.id, { type: 'movie' }).length;
      const seriesCount = rec.getRecommended(p.id, { type: 'series' }).length;

      // Turn off the anime engine and rebuild — movie/series counts unchanged.
      config.updateProfile(p.id, { filters: { engine_anime: 'off' } });
      const prof2 = config.getProfile(p.id);
      const r2 = await rec.buildRecommendations(prof2, console);
      assert.strictEqual(r2.engines && r2.engines.anime, undefined, 'no engines.anime when off');
      assert.strictEqual(r2.anime, undefined, 'no anime key when off');
      assert.strictEqual(rec.getRecommended(p.id, { type: 'movie' }).length, movieCount, 'movie count unchanged');
      assert.strictEqual(rec.getRecommended(p.id, { type: 'series' }).length, seriesCount, 'series count unchanged');

      // Re-enable and verify pruneOtherEngines('series') leaves anime rows untouched.
      config.updateProfile(p.id, { filters: { engine_anime: 'fake-anime' } });
      const prof3 = config.getProfile(p.id);
      await rec.buildRecommendations(prof3, console);
      const animeBefore = rec.getRecommended(p.id, { type: 'anime' }).length;
      rec.pruneOtherEngines(p.id, 'series', 'fake-series');
      const animeAfter = rec.getRecommended(p.id, { type: 'anime' }).length;
      assert.strictEqual(animeAfter, animeBefore, 'pruneOtherEngines(series) leaves anime rows');
    } finally {
      config.removeProfile(p.id);
      unregMovie();
      unregSeries();
      unregAnime();
      settings.updateSettings({ keys: { tmdb_api_key: '' } });
    }
  });

  // ---- A6: serve — type mapping, excluded-genre, dont_recommend ----
  await ok('A6: serve — serveRecommendations type=series; excluded Anime genre; dont_recommend series hides anime', async () => {
    const rec = require('../src/recommendationStore');

    const p = config.addProfile('AN1A-A6');
    try {
      // Seed 3 anime rows + 1 series row (Anime-tagged) directly into the pool.
      rec.upsertCandidates(p.id, [
        { type: 'anime', tmdb_id: '9101', imdb_id: 'tt9101', title: 'Anime A', year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 3, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
        { type: 'anime', tmdb_id: '9102', imdb_id: 'tt9102', title: 'Anime B', year: 2021, primary_genre: 'Fantasy', genres: 'Fantasy,Anime', vote_average: 8.0, affinity: 0.8, rec_count: 2, because_title: 'W', poster: '/p2.jpg', imdb_rating: 8.0, popularity: 0 },
        { type: 'anime', tmdb_id: '9103', imdb_id: 'tt9103', title: 'Anime C', year: 2022, primary_genre: 'Comedy', genres: 'Comedy,Anime', vote_average: 7.0, affinity: 0.7, rec_count: 1, because_title: 'W', poster: '/p3.jpg', imdb_rating: 7.0, popularity: 0 },
        { type: 'series', tmdb_id: '9201', imdb_id: 'tt9201', title: 'Show D', year: 2020, primary_genre: 'Drama', genres: 'Drama,Anime', vote_average: 7.0, affinity: 0.6, rec_count: 1, because_title: 'W', poster: '/p4.jpg', imdb_rating: 7.0, popularity: 0 },
      ], { ratingCheckedAt: Date.now() });

      const prof = config.getProfile(p.id);

      // serveRecommendations(p, 'anime') items have type: 'series'.
      const animeServed = rec.serveRecommendations(prof, 'anime', { record: false });
      assert.strictEqual(animeServed.length, 3, '3 anime rows served');
      assert.ok(animeServed.every((r) => r.type === 'series'), 'all served items type=series');

      // A profile excluding the "Anime" genre still gets anime-lane rows,
      // while its series slice still drops Anime-tagged rows.
      config.updateProfile(p.id, { filters: { excluded_genres: ['Anime'] } });
      const prof2 = config.getProfile(p.id);
      const animeServed2 = rec.serveRecommendations(prof2, 'anime', { record: false });
      assert.strictEqual(animeServed2.length, 3, 'anime lane still serves 3 with excluded_genres Anime');
      const seriesServed = rec.serveRecommendations(prof2, 'series', { record: false });
      assert.strictEqual(seriesServed.length, 0, 'series slice drops Anime-tagged row');

      // A dont_recommend row of type 'series' with an anime row's tmdb_id hides that anime row.
      rec.addDontRecommend(p.id, 'series', '9101', 'user');
      const prof3 = config.getProfile(p.id);
      const animeServed3 = rec.serveRecommendations(prof3, 'anime', { record: false });
      assert.strictEqual(animeServed3.length, 2, 'dont_recommend series:9101 hides anime row');
      assert.ok(!animeServed3.some((r) => r.id === 'tt9101'), 'tt9101 hidden');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- A7: staged path — anime acceptance failure keeps old rows, promotes movie/series ----
  await ok('A7: staged path — anime acceptance failure keeps old anime rows, promotes movie/series, logs warning', async () => {
    const rec = require('../src/recommendationStore');

    // Register a fake anime engine that returns NO candidates (new eligible = 0).
    const fakeAnime = {
      id: 'fake-anime-a7',
      name: 'Fake Anime A7',
      supportedTypes: ['anime'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements() { return { ok: true, missing: [] }; },
      async generate() { return []; },
      ALGORITHM_VERSION: 'fake-anime-a7-v1',
    };
    const unregister = engines._register(fakeAnime);

    const p = config.addProfile('AN1A-A7');
    try {
      // Seed 3 old anime rows in the pool.
      rec.upsertCandidates(p.id, [
        { type: 'anime', tmdb_id: '9301', imdb_id: 'tt9301', title: 'Old Anime 1', year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 3, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
        { type: 'anime', tmdb_id: '9302', imdb_id: 'tt9302', title: 'Old Anime 2', year: 2021, primary_genre: 'Fantasy', genres: 'Fantasy,Anime', vote_average: 8.0, affinity: 0.8, rec_count: 2, because_title: 'W', poster: '/p2.jpg', imdb_rating: 8.0, popularity: 0 },
        { type: 'anime', tmdb_id: '9303', imdb_id: 'tt9303', title: 'Old Anime 3', year: 2022, primary_genre: 'Comedy', genres: 'Comedy,Anime', vote_average: 7.0, affinity: 0.7, rec_count: 1, because_title: 'W', poster: '/p3.jpg', imdb_rating: 7.0, popularity: 0 },
      ], { ratingCheckedAt: Date.now() });

      settings.updateSettings({ keys: { tmdb_api_key: 'test-tmdb-key' } });

      config.updateProfile(p.id, { filters: { engine_anime: 'fake-anime-a7' } });
      const prof = config.getProfile(p.id);

      // Capture log output.
      const logLines = [];
      const log = { log: (msg) => logLines.push(msg), warn: (msg) => logLines.push(msg), error: (msg) => logLines.push(msg) };

      // Run the staged build.
      const r = await rec.stagedBuildPool(prof, log, () => {}, { kind: 'daily' });

      // The anime acceptance gate should have failed (old eligible 3, new 0).
      assert.ok(logLines.some((l) => l.includes('anime acceptance gate failed')), 'anime acceptance gate failed logged');

      // Old anime rows are kept (not wiped).
      const animeRows = rec.getRecommended(p.id, { type: 'anime' });
      assert.strictEqual(animeRows.length, 3, '3 old anime rows kept');

      // Movie/series were still promoted (stored 0 since no candidates, but no skip).
      assert.ok(r.movie && r.series, 'movie and series in result');
    } finally {
      config.removeProfile(p.id);
      unregister();
      settings.updateSettings({ keys: { tmdb_api_key: '' } });
    }
  });

  // ---- A8: HTTP manifest + catalog route ----
  console.log('anime-lane http:');
  require('../src/server');
  const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
  const { token } = provisionAdmin();
  const restore = attachCookie(BASE, cookieHeader(token));

  await ok('A8: HTTP manifest + catalog route — anime off/on, 404 when off, placeholder type=series', async () => {
    const p = config.addProfile('AN1A-A8');
    try {
      // Get the profile token for the addon route.
      const prof = config.getProfile(p.id);
      const profileToken = prof.token;

      // Anime engine OFF (default): no ai-recs-anime in manifest, types lacks anime.
      const manifestOff = await (await fetch(`${BASE}/addon/${profileToken}/manifest.json`)).json();
      assert.ok(!manifestOff.catalogs.some((c) => c.id === 'ai-recs-anime'), 'no ai-recs-anime when off');
      assert.ok(!manifestOff.types.includes('anime'), 'types lacks anime when off');

      // Catalog route → 404 when off.
      const resOff = await fetch(`${BASE}/addon/${profileToken}/catalog/anime/ai-recs-anime.json`);
      assert.strictEqual(resOff.status, 404, '404 when off');

      // Anime engine ON: catalog present, types includes anime.
      config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
      const manifestOn = await (await fetch(`${BASE}/addon/${profileToken}/manifest.json`)).json();
      const animeCatalog = manifestOn.catalogs.find((c) => c.id === 'ai-recs-anime');
      assert.ok(animeCatalog, 'ai-recs-anime present when on');
      assert.strictEqual(animeCatalog.type, 'anime', 'catalog type is anime');
      assert.strictEqual(animeCatalog.name, 'Recommended for you', 'catalog name');
      assert.ok(manifestOn.types.includes('anime'), 'types includes anime when on');
      // Present after ai-recs-series.
      const seriesIdx = manifestOn.catalogs.findIndex((c) => c.id === 'ai-recs-series');
      const animeIdx = manifestOn.catalogs.findIndex((c) => c.id === 'ai-recs-anime');
      assert.ok(animeIdx > seriesIdx, 'ai-recs-anime after ai-recs-series');

      // When on but empty, the placeholder card has type: 'series'.
      const resOn = await fetch(`${BASE}/addon/${profileToken}/catalog/anime/ai-recs-anime.json`);
      assert.strictEqual(resOn.status, 200, '200 when on');
      const body = await resOn.json();
      assert.strictEqual(body.metas.length, 1, 'one placeholder card');
      assert.strictEqual(body.metas[0].type, 'series', 'placeholder type is series');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- A9: HTTP portal — engine_anime in PUT, requirements, keys, anime_status ----
  await ok('A9: HTTP portal — engine_anime, requirements.anime, keys, keys_set, anime_status', async () => {
    const p = config.addProfile('AN1A-A9');
    try {
      // Helper: get the profile DTO from the list.
      const getProfile = async (id) => {
        const res = await fetch(`${BASE}/api/profiles`, { headers: { 'Content-Type': 'application/json' } });
        const body = await res.json();
        return body.profiles.find((x) => x.id === id);
      };

      // Default: anime engine off, requirements.anime.ok is true (no engine).
      let prof = await getProfile(p.id);
      assert.strictEqual(prof.engines.anime, 'off', 'engines.anime is off by default');
      assert.deepStrictEqual(prof.engines.requirements.anime, { ok: true, missing: [] }, 'requirements.anime ok when off');

      // Set engine_anime to marquee-anime.
      let res = await fetch(`${BASE}/api/profiles/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: { engine_anime: 'marquee-anime' } }),
      });
      prof = (await res.json()).profile;
      assert.strictEqual(prof.engines.anime, 'marquee-anime', 'engines.anime is marquee-anime');
      // requirements.anime.missing includes 'AniDB client' (no client saved).
      assert.ok(prof.engines.requirements.anime.missing.includes('AniDB client'), 'missing includes AniDB client');

      // keys shape: mal_client_id, anidb_client, anidb_clientver present.
      assert.strictEqual(prof.keys.mal_client_id, '', 'keys.mal_client_id empty');
      assert.strictEqual(prof.keys.anidb_client, '', 'keys.anidb_client empty');
      assert.strictEqual(prof.keys.anidb_clientver, 0, 'keys.anidb_clientver 0');

      // keys_set shape.
      assert.strictEqual(prof.keys_set.mal_client_id, false, 'keys_set.mal_client_id false');
      assert.strictEqual(prof.keys_set.anidb_client, false, 'keys_set.anidb_client false');

      // anime_status shape.
      assert.ok(prof.anime_status, 'anime_status present');
      assert.strictEqual(prof.anime_status.mal.source, 'none', 'anime_status.mal.source none');
      assert.ok(prof.anime_status.anidb, 'anime_status.anidb present');
      assert.strictEqual(prof.anime_status.migration, null, 'migration null (no marker yet)');

      // Nulls clear the MAL ID and the AniDB pair.
      res = await fetch(`${BASE}/api/profiles/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { mal_client_id: 'test-mal', anidb_client: 'test-anidb', anidb_clientver: 3 } }),
      });
      prof = (await res.json()).profile;
      assert.strictEqual(prof.keys.mal_client_id, 'test-mal', 'mal_client_id set');
      assert.strictEqual(prof.keys.anidb_client, 'test-anidb', 'anidb_client set');
      assert.strictEqual(prof.keys.anidb_clientver, 3, 'anidb_clientver set');

      res = await fetch(`${BASE}/api/profiles/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { mal_client_id: null, anidb_client: null, anidb_clientver: null } }),
      });
      prof = (await res.json()).profile;
      assert.strictEqual(prof.keys.mal_client_id, '', 'mal_client_id cleared');
      assert.strictEqual(prof.keys.anidb_client, '', 'anidb_client cleared');
      assert.strictEqual(prof.keys.anidb_clientver, 0, 'anidb_clientver cleared to 0');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- A9b: HTTP test routes — MAL rating map, AniDB plain text ----
  await ok('A9b: HTTP test routes — MAL rating map, AniDB plain text', async () => {
    const p = config.addProfile('AN1A-A9b');
    try {
      // Stub global fetch for MAL API.
      const realFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (String(url).includes('api.myanimelist.net')) {
          return { ok: true, status: 200, json: async () => ({ id: 1, title: 'Cowboy Bebop', rating: 'r' }) };
        }
        return realFetch(url, opts);
      };

      // POST /api/profiles/:id/test/mal-user → detail has the mapped rating.
      let res = await fetch(`${BASE}/api/profiles/${p.id}/test/mal-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test-key' }),
      });
      let body = await res.json();
      assert.ok(body.ok, 'mal test ok');
      assert.strictEqual(body.detail, 'MyAnimeList key valid (Cowboy Bebop rated R)', 'MAL rating mapped');

      // Stub fetch for AniDB (bad client).
      global.fetch = async (url, opts) => {
        if (String(url).includes('api.anidb.net')) {
          return { status: 200, text: async () => '<error code="302">client version missing or invalid</error>' };
        }
        return realFetch(url, opts);
      };

      // POST /api/profiles/:id/test/anidb-user → error has no ✗.
      res = await fetch(`${BASE}/api/profiles/${p.id}/test/anidb-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: 'a9b-bad', clientver: 1 }),
      });
      body = await res.json();
      assert.ok(!body.ok, 'anidb test not ok');
      assert.ok(!body.error.includes('✗'), 'no ✗ in error: ' + body.error);
      assert.strictEqual(body.error, "AniDB doesn't recognise this client", 'plain text error');

      global.fetch = realFetch;
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- A9c: anime_status.anidb.today counts the saved client's requests ----
  await ok('A9c: anime_status.anidb.today counts the saved client\'s requests', async () => {
    const anidb = require('../src/services/anidb');
    const p = config.addProfile('AN1A-A9c');
    try {
      config.updateProfile(p.id, { keys: { anidb_client: 'a9c-client', anidb_clientver: 1 } });
      anidb._resetForTests();
      let t = Date.now();
      anidb._setNow(() => t);
      const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'anidb-aid23.xml'), 'utf8');
      anidb._setFetch(async () => { t += 5000; return { status: 200, text: async () => xml }; });
      const prof = config.getProfile(p.id);
      await anidb.getAnime(9101, prof, console);
      await anidb.getAnime(9102, prof, console);
      const res = await fetch(`${BASE}/api/profiles`, { headers: { Cookie: cookieHeader(token) } });
      const body = await res.json();
      const dto = body.profiles.find((x) => x.id === p.id);
      assert.strictEqual(dto.anime_status.anidb.today, 2, 'two requests counted today');
      assert.strictEqual(dto.anime_status.anidb.source, 'user');
    } finally {
      anidb._resetClock();
      config.removeProfile(p.id);
    }
  });

  // ---- A9d: Server Config AniDB Test route — /settings/test/anidb ----
  await ok('A9d: Server Config AniDB Test route — /settings/test/anidb', async () => {
    const anidb = require('../src/services/anidb');
    try {
      anidb._resetForTests();
      let t = Date.now();
      anidb._setNow(() => t);
      const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'anidb-aid23.xml'), 'utf8');
      anidb._setFetch(async () => { t += 5000; return { status: 200, text: async () => xml }; });
      const res = await fetch(`${BASE}/api/settings/test/anidb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(token) },
        body: JSON.stringify({ client: 'a9d-client', clientver: 1 }),
      });
      assert.strictEqual(res.status, 200, 'HTTP 200');
      const body = await res.json();
      assert.strictEqual(body.ok, true, 'ok true');
      assert.strictEqual(body.detail, 'Client accepted', 'detail Client accepted');
    } finally {
      anidb._resetClock();
    }
  });

  // ---- A10: HTTP companion — engine_anime in GET/POST /mobile/api/settings ----
  await ok('A10: HTTP companion — engine_anime in GET/POST /mobile/api/settings', async () => {
    const p = config.addProfile('AN1A-A10');
    try {
      // GET: engines.anime.id is 'off' by default.
      let res = await fetch(`${BASE}/mobile/api/settings`);
      let body = await res.json();
      assert.strictEqual(body.engines.anime.id, 'off', 'engines.anime.id is off');
      assert.deepStrictEqual(body.engines.requirements.anime, { ok: true, missing: [] }, 'requirements.anime ok when off');
      assert.strictEqual('engine_anime' in body.filters, false, 'engine_anime never in filters');

      // POST: set engine_anime to marquee-anime.
      res = await fetch(`${BASE}/mobile/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine_anime: 'marquee-anime' }),
      });
      assert.strictEqual(res.status, 200, 'POST 200');
      body = await res.json();
      assert.strictEqual(body.engines.anime.id, 'marquee-anime', 'engines.anime.id is marquee-anime');

      // POST: set engine_anime to 'evil' → stored 'off'.
      res = await fetch(`${BASE}/mobile/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine_anime: 'evil' }),
      });
      assert.strictEqual(res.status, 200, 'POST 200');
      body = await res.json();
      assert.strictEqual(body.engines.anime.id, 'off', 'engines.anime.id is off (evil rejected)');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- A11: AniDB parser — fixture + error body ----
  await ok('A11: AniDB parser — fixture values + error body', async () => {
    const anidb = require('../src/services/anidb');
    const fs = require('fs');
    const path = require('path');

    // Parse the Cowboy Bebop fixture.
    const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'anidb-aid23.xml'), 'utf8');
    const parsed = anidb.parseAnime(xml);
    assert.strictEqual(parsed.restricted, false, 'restricted false');
    assert.strictEqual(parsed.type, 'TV Series', 'type TV Series');
    assert.strictEqual(parsed.episodes, 26, 'episodes 26');
    assert.strictEqual(parsed.title, 'Cowboy Bebop', 'title');
    assert.strictEqual(parsed.rating, 8.75, 'rating 8.75');
    assert.strictEqual(parsed.content.sex, 100, 'content.sex 100');
    assert.strictEqual(parsed.content.violence, 200, 'content.violence 200');
    assert.deepStrictEqual(parsed.related[0], { aid: 219, type: 'Side Story' }, 'related[0]');
    assert.ok(parsed.similar.length > 0, 'similar non-empty');
    assert.ok(parsed.mal.includes(1), 'mal includes 1');

    // Parse the error-302 fixture.
    const errXml = fs.readFileSync(path.join(__dirname, 'fixtures', 'anidb-error-302.xml'), 'utf8');
    const errParsed = anidb.parseAnime(errXml);
    assert.ok(errParsed.error, 'error body parsed');
    assert.ok(/client/i.test(errParsed.error), 'error text mentions client');
  });

  // ---- A12: AniDB flood control — spacing, cache, repeat, cap, ban, reload ----
  await ok('A12: AniDB flood control — spacing/cache/repeat/cap/ban/reload', async () => {
    const anidb = require('../src/services/anidb');
    const db = require('../src/db');
    anidb.init();
    anidb._resetForTests();

    let t = 1000000;
    anidb._setNow(() => t);
    const fetchCalls = [];
    const validXml = '<anime id="1" restricted="false"><type>TV Series</type><episodecount>10</episodecount><title xml:lang="x-jat" type="main">Test</title><permanent>8.0</permanent></anime>';
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: t });
      return { status: 200, text: async () => validXml };
    });

    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    // Advance the clock by 4050ms (spacing + 50 ms margin) before each request.
    const advance = () => { t += 4050; };

    // 1. Spacing: two getAnime calls for different aids start ≥ 4000 ms apart.
    const r1 = await anidb.getAnime(1, profile, console);
    assert.ok(r1.data, 'first request succeeded');
    advance();
    const r2 = await anidb.getAnime(2, profile, console);
    assert.ok(r2.data, 'second request succeeded');
    assert.ok(fetchCalls[1].at - fetchCalls[0].at >= 4000, 'requests ≥ 4000ms apart');

    // 2. Cache: a cached aid makes no request.
    const r3 = await anidb.getAnime(1, profile, console);
    assert.ok(r3.cached, 'cached');
    assert.strictEqual(fetchCalls.length, 2, 'no new request for cached aid');

    // 3. Repeat guard: the same aid after an error within 24h → repeat.
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: t });
      return { status: 200, text: async () => '<error>some error</error>' };
    });
    advance();
    const r4 = await anidb.getAnime(3, profile, console);
    assert.ok(r4.error, 'error recorded');
    const r5 = await anidb.getAnime(3, profile, console);
    assert.strictEqual(r5.skipped, 'repeat', 'repeat guard');
    assert.strictEqual(fetchCalls.length, 3, 'no new request for repeat');

    // 4. Daily cap: the 151st request in a Sydney day → cap.
    const day = new Date(t + 10 * 3600e3).toISOString().slice(0, 10);
    db.get().prepare('UPDATE anidb_clients SET day = ?, day_calls = 150 WHERE client = ?').run(day, 'test-client');
    advance();
    const r6 = await anidb.getAnime(4, profile, console);
    assert.strictEqual(r6.skipped, 'cap', 'daily cap');
    assert.strictEqual(fetchCalls.length, 3, 'no new request for cap');

    // 5. Ban circuit: after a banned body, banned_until ≈ now+48h; next call → banned.
    db.get().prepare('UPDATE anidb_clients SET day_calls = 0 WHERE client = ?').run('test-client');
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: t });
      return { status: 200, text: async () => '<error>You have been banned</error>' };
    });
    advance();
    const r7 = await anidb.getAnime(5, profile, console);
    assert.strictEqual(r7.skipped, 'banned', 'banned on banned body');
    const banRow = db.get().prepare('SELECT banned_until FROM anidb_clients WHERE client = ?').get('test-client');
    assert.ok(banRow.banned_until - t >= 48 * 3600e3 - 1000, 'banned_until ≈ now + 48h');
    // Next call for a different aid → banned (no request).
    const r8 = await anidb.getAnime(6, profile, console);
    assert.strictEqual(r8.skipped, 'banned', 'banned (no request)');
    assert.strictEqual(fetchCalls.length, 4, 'no new request for banned');

    // 6. State survives a module reload (re-require with a cleared cache).
    const atBefore = db.get().prepare('SELECT at FROM anidb_attempts WHERE aid = 1').get().at;
    delete require.cache[require.resolve('../src/services/anidb')];
    const anidb2 = require('../src/services/anidb');
    anidb2._setNow(() => t); // the fresh module has a default Date.now() clock
    anidb2.init();
    const r9 = await anidb2.getAnime(1, profile, console);
    assert.ok(r9.cached, 'cached after reload');
    const atAfter = db.get().prepare('SELECT at FROM anidb_attempts WHERE aid = 1').get().at;
    assert.strictEqual(atBefore, atAfter, 'attempt state survives reload');
  });

  // ---- A12b: serialised concurrent getAnime — every gap ≥ 4000 ms ----
  await ok('A12b: serialised concurrent getAnime — every gap ≥ 4000 ms', async () => {
    const anidb = require('../src/services/anidb');
    anidb.init();
    anidb._resetForTests();
    anidb._resetClock();

    const fetchCalls = [];
    const validXml = '<anime id="1" restricted="false"><type>TV Series</type><episodecount>10</episodecount><title xml:lang="x-jat" type="main">Test</title><permanent>8.0</permanent></anime>';
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: Date.now() });
      await new Promise(r => setTimeout(r, 300)); // simulate 300ms network
      return { status: 200, text: async () => validXml };
    });

    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    const results = await Promise.all([
      anidb.getAnime(101, profile, console),
      anidb.getAnime(102, profile, console),
      anidb.getAnime(103, profile, console),
    ]);
    assert.strictEqual(results.length, 3);
    for (const r of results) assert.ok(r.data, 'each request succeeded');
    assert.strictEqual(fetchCalls.length, 3, 'exactly 3 fetches');
    // Every gap between fetch starts ≥ 4000 ms.
    for (let i = 1; i < fetchCalls.length; i++) {
      const gap = fetchCalls[i].at - fetchCalls[i - 1].at;
      assert.ok(gap >= 4000, `gap ${i} = ${gap}ms ≥ 4000ms`);
    }
  });

  // ---- A12f: A12b looped 5× — every gap ≥ 4000 ms in every run ----
  await ok('A12f: A12b looped 5× — every gap ≥ 4000 ms in every run', async () => {
    const anidb = require('../src/services/anidb');
    const validXml = '<anime id="1" restricted="false"><type>TV Series</type><episodecount>10</episodecount><title xml:lang="x-jat" type="main">Test</title><permanent>8.0</permanent></anime>';
    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    let smallest = Infinity;
    for (let run = 0; run < 5; run++) {
      anidb.init();
      anidb._resetForTests();
      anidb._resetClock();
      const fetchCalls = [];
      anidb._setFetch(async (url) => {
        fetchCalls.push({ url, at: Date.now() });
        await new Promise(r => setTimeout(r, 300)); // simulate 300ms network
        return { status: 200, text: async () => validXml };
      });
      const results = await Promise.all([
        anidb.getAnime(101 + run * 3, profile, console),
        anidb.getAnime(102 + run * 3, profile, console),
        anidb.getAnime(103 + run * 3, profile, console),
      ]);
      assert.strictEqual(results.length, 3);
      for (const r of results) assert.ok(r.data, 'each request succeeded');
      assert.strictEqual(fetchCalls.length, 3, 'exactly 3 fetches');
      for (let i = 1; i < fetchCalls.length; i++) {
        const gap = fetchCalls[i].at - fetchCalls[i - 1].at;
        smallest = Math.min(smallest, gap);
        assert.ok(gap >= 4000, `run ${run} gap ${i} = ${gap}ms ≥ 4000ms`);
      }
    }
    console.log(`A12f: smallest gap across 5 runs = ${smallest}ms`);
  });

  // ---- A12g: stamp is the instant of the send; a throwing fetch is a transient, not a crash ----
  await ok('A12g: persisted/in-memory stamp equals the clock at fetch; sync-throwing fetch → transient', async () => {
    const anidb = require('../src/services/anidb');
    const validXml = '<anime id="1" restricted="false"><type>TV Series</type><episodecount>10</episodecount><title xml:lang="x-jat" type="main">Test</title><permanent>8.0</permanent></anime>';
    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    anidb.init();
    anidb._resetForTests();
    let t = 1_000_000;
    anidb._setNow(() => ++t); // every clock read ticks 1 ms, so a stamp taken before the send differs from the send time
    let fetchedAt = null;
    anidb._setFetch(async () => { fetchedAt = t; return { status: 200, text: async () => validXml }; });
    const r = await anidb.getAnime(201, profile, console);
    assert.ok(r.data, 'request succeeded');
    const persisted = require('../src/db').get().prepare('SELECT MAX(last_request_at) AS m FROM anidb_clients').get().m;
    assert.strictEqual(persisted, fetchedAt, `stamp ${persisted} must equal clock at send ${fetchedAt}`);
    t += 5000;
    anidb._setFetch(() => { throw new Error('sync boom'); });
    const r2 = await anidb.getAnime(202, profile, console);
    assert.ok(!r2.data, 'throwing fetch yields no data, no crash');
    anidb._resetClock();
  });

  // ---- A12c: HTTP 503 three times → error, exactly 3 fetches, day count rose by 3, spacing ----
  await ok('A12c: HTTP 503 three times → error, exactly 3 fetches, day count rose by 3, spacing', async () => {
    const anidb = require('../src/services/anidb');
    const db = require('../src/db');
    anidb.init();
    anidb._resetForTests();
    anidb._resetClock();

    const fetchCalls = [];
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: Date.now() });
      return { status: 503, text: async () => '' };
    });

    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    const r = await anidb.getAnime(201, profile, console);
    assert.strictEqual(r.error, 'http 503');
    assert.strictEqual(fetchCalls.length, 3, 'exactly 3 fetches');
    // Day count rose by 3.
    const row = db.get().prepare('SELECT day_calls FROM anidb_clients WHERE client = ?').get('test-client');
    assert.strictEqual(row.day_calls, 3, 'day_calls rose by 3');
    // Each fetch started ≥ 4000 ms after the previous one.
    for (let i = 1; i < fetchCalls.length; i++) {
      const gap = fetchCalls[i].at - fetchCalls[i - 1].at;
      assert.ok(gap >= 4000, `gap ${i} = ${gap}ms ≥ 4000ms`);
    }
  });

  // ---- A12d: banned body → banned_until ≈ now+48h; next getAnime → skipped (no fetch) ----
  await ok('A12d: banned body → banned_until ≈ now+48h; next getAnime → skipped (no fetch)', async () => {
    const anidb = require('../src/services/anidb');
    const db = require('../src/db');
    anidb.init();
    anidb._resetForTests();
    anidb._resetClock();

    const fetchCalls = [];
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: Date.now() });
      return { status: 200, text: async () => '<error code="555">client banned</error>' };
    });

    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    const r1 = await anidb.getAnime(301, profile, console);
    assert.strictEqual(r1.skipped, 'banned');
    // banned_until ≈ now + 48h.
    const status = anidb.clientStatus(profile);
    assert.ok(status.banned_until - Date.now() >= 48 * 3600e3 - 5000, 'banned_until ≈ now + 48h');
    // Next getAnime (new aid) → skipped: 'banned' with no fetch.
    const r2 = await anidb.getAnime(302, profile, console);
    assert.strictEqual(r2.skipped, 'banned');
    assert.strictEqual(fetchCalls.length, 1, 'no second fetch');
  });

  // ---- A12e: day_calls=149, first attempt 503 → one fetch, then skipped: 'cap' ----
  await ok('A12e: day_calls=149, first attempt 503 → one fetch, then skipped: cap', async () => {
    const anidb = require('../src/services/anidb');
    const db = require('../src/db');
    anidb.init();
    anidb._resetForTests();
    anidb._resetClock();

    const fetchCalls = [];
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: Date.now() });
      return { status: 503, text: async () => '' };
    });

    const profile = { keys: { anidb_client: 'test-client', anidb_clientver: 1 } };
    // Set day_calls = 149 for today (ensure the row exists first).
    const { sydneyDay } = require('../src/aiSchedule');
    const day = sydneyDay(Date.now());
    db.get().prepare('INSERT OR IGNORE INTO anidb_clients (client) VALUES (?)').run('test-client');
    db.get().prepare('UPDATE anidb_clients SET day = ?, day_calls = 149 WHERE client = ?').run(day, 'test-client');

    const r = await anidb.getAnime(401, profile, console);
    assert.strictEqual(r.skipped, 'cap');
    assert.strictEqual(fetchCalls.length, 1, 'exactly one fetch');
  });

  // ---- A13: AniDB testClient — success caches, second test no request, bad client ----
  await ok('A13: AniDB testClient — success caches, second test no request, bad client', async () => {
    const anidb = require('../src/services/anidb');
    anidb.init();
    anidb._resetForTests();

    let t = 2000000;
    anidb._setNow(() => t);
    const fetchCalls = [];
    const validXml = '<anime id="1" restricted="false"><type>TV Series</type><episodecount>10</episodecount><title xml:lang="x-jat" type="main">Test</title><permanent>8.0</permanent></anime>';
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: t });
      return { status: 200, text: async () => validXml };
    });
    const advance = () => { t += 4050; };

    // 1. Success: caches aid 1.
    const r1 = await anidb.testClient({ client: 'test-client', clientver: 1 });
    assert.ok(r1.ok, 'testClient success');
    assert.strictEqual(r1.detail, 'Client accepted', 'success text');
    assert.strictEqual(fetchCalls.length, 1, 'one request');

    // 2. Second test within 24h: no request, returns "checked HH:MM".
    const r2 = await anidb.testClient({ client: 'test-client', clientver: 1 });
    assert.ok(r2.ok, 'second test success');
    assert.ok(r2.detail.includes('checked'), 'checked text');
    assert.strictEqual(fetchCalls.length, 1, 'no new request for second test');

    // 3. Bad client: returns AniDB doesn't recognise this client.
    anidb._setFetch(async (url) => {
      fetchCalls.push({ url, at: t });
      return { status: 200, text: async () => '<error code="302">client version missing or invalid</error>' };
    });
    advance(); // spacing for the new client
    const r3 = await anidb.testClient({ client: 'bad-client', clientver: 1 });
    assert.ok(!r3.ok, 'bad client not ok');
    assert.strictEqual(r3.error, "AniDB doesn't recognise this client", 'bad client text');
  });

  // ---- A13b: testClient results contain no ✓ or ✗ ----
  await ok('A13b: testClient results contain no ✓ or ✗', async () => {
    const anidb = require('../src/services/anidb');
    anidb.init();
    anidb._resetForTests();
    anidb._resetClock();

    const validXml = '<anime id="1" restricted="false"><type>TV Series</type><episodecount>10</episodecount><title xml:lang="x-jat" type="main">Test</title><permanent>8.0</permanent></anime>';
    anidb._setFetch(async (url) => ({ status: 200, text: async () => validXml }));

    // Good stub → detail === 'Client accepted'
    const r1 = await anidb.testClient({ client: 'a13b-client', clientver: 1 });
    assert.ok(r1.ok, 'success');
    assert.strictEqual(r1.detail, 'Client accepted', 'no ✓ prefix');

    // Second call → matches /^Client accepted \(checked \d\d:\d\d\)$/
    const r2 = await anidb.testClient({ client: 'a13b-client', clientver: 1 });
    assert.ok(r2.ok, 'second success');
    assert.ok(/^Client accepted \(checked \d\d:\d\d\)$/.test(r2.detail), 'checked format: ' + r2.detail);

    // Bad client (different name) → error === "AniDB doesn't recognise this client"
    anidb._setFetch(async (url) => ({ status: 200, text: async () => '<error code="302">client version missing or invalid</error>' }));
    const r3 = await anidb.testClient({ client: 'a13b-bad', clientver: 1 });
    assert.ok(!r3.ok, 'bad client not ok');
    assert.strictEqual(r3.error, "AniDB doesn't recognise this client", 'no ✗ prefix');
  });

  // ---- A14: MAL API — ratings calls api.myanimelist.net first, nsfw black → adult, Jikan fast-fail ----
  await ok('A14: MAL API — ratings calls api.myanimelist.net first, nsfw black → adult, Jikan fast-fail', async () => {
    const mal = require('../src/services/mal');
    const store = require('../src/store');

    // Stub the global fetch.
    const realFetch = global.fetch;
    let malApiCalls = 0;
    let jikanCalls = 0;
    let anilistCalls = 0;
    global.fetch = async (url, opts) => {
      if (url.includes('api.myanimelist.net')) {
        malApiCalls++;
        return { status: 200, ok: true, json: async () => ({ rating: 'r', nsfw: 'black', genres: [{ name: 'Action' }] }) };
      }
      if (url.includes('api.jikan.moe')) {
        jikanCalls++;
        const err = new Error('fetch failed');
        err.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
        throw err;
      }
      if (url.includes('graphql.anilist.co')) {
        anilistCalls++;
        return { status: 200, ok: true, json: async () => ({ data: { Media: { isAdult: false, genres: [] } } }) };
      }
      return realFetch(url, opts);
    };

    try {
      // 1. With a client id: ratings([1]) calls api.myanimelist.net first.
      const result = await mal.ratings([1], console, { malClientId: 'test-client' });
      assert.ok(malApiCalls > 0, 'MAL API called');
      const verdict = result.get(1);
      assert.ok(verdict, 'verdict exists');
      assert.strictEqual(verdict.code, 'R', 'code R');
      assert.ok(verdict.adult, 'adult (nsfw black)');
      const cache = store.loadAnimeRatings();
      assert.strictEqual(cache['mal:1'].source, 'malapi', 'source malapi');

      // 2. Without a key: Jikan, then on a connect timeout AniList, with one Jikan attempt.
      const result2 = await mal.ratings([2], console);
      assert.ok(jikanCalls > 0, 'Jikan called');
      assert.strictEqual(jikanCalls, 1, 'one Jikan attempt (no retry on connect timeout)');
      assert.ok(anilistCalls > 0, 'AniList called');
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---- A16: animeMap index — cached index without v:3 triggers full rebuild, rebuilt index carries anidb ----
  await ok('A16: animeMap index — cached index without v:3 triggers full rebuild, rebuilt index carries anidb', async () => {
    const animeMap = require('../src/services/animeMap');
    const store = require('../src/store');

    // Stub the global fetch for the animeMap download.
    const realFetch = global.fetch;
    let downloadCalls = 0;
    let headCalls = 0;
    global.fetch = async (url, opts) => {
      if (url.includes('raw.githubusercontent.com')) {
        if (opts?.method === 'HEAD') {
          headCalls++;
          return { ok: true, status: 200, headers: { get: () => 'etag-1' } };
        }
        downloadCalls++;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'etag-1' },
          json: async () => [
            { mal_id: 1, imdb_id: 'tt1', themoviedb_id: 100, anidb_id: 23, type: 'TV' },
            { mal_id: 2, imdb_id: 'tt2', themoviedb_id: 200, anidb_id: 24, type: 'TV' },
          ],
        };
      }
      return realFetch(url, opts);
    };

    try {
      // Seed a cached index without v:3.
      store.saveAnimeIndex({ at: Date.now(), etag: 'etag-1', byImdb: { tt1: { mal: 1 } }, byTmdb: { 100: { mal: 1 } } });
      // Reset the module's in-memory index so it reads from the store.
      animeMap._setIndex(null);

      const idx = await animeMap.ensureLoaded(console);
      // The stale index triggered a full download (no ETag short-circuit).
      assert.ok(downloadCalls > 0, 'full download happened');
      assert.strictEqual(headCalls, 0, 'no ETag HEAD (stale ignores ETag)');
      // The rebuilt index carries v:3 and anidb.
      assert.strictEqual(idx.v, 3, 'v:3');
      const rec = animeMap.lookup('tt1', 100);
      assert.ok(rec, 'lookup works');
      assert.strictEqual(rec.anidb, 23, 'anidb field present');
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---- A15: migration — one-time lane migration, idempotent, report ----
  await ok('A15: migration — one-time lane migration, idempotent, report', async () => {
    const migration = require('../src/anime/migration');
    const watchedStore = require('../src/watchedStore');
    const db = require('../src/db');
    const animeMap = require('../src/services/animeMap');

    // Set up a fake anime map index (ttA1 is anime, ttB is not).
    animeMap._setIndex({
      at: Date.now(), etag: 'a15',
      byImdb: { ttA1: { mal: 1, anidb: 23 } },
      byTmdb: { A1: { mal: 1, anidb: 23 } },
    });

    // Create a profile.
    const p = config.addProfile('AN1A-A15');
    try {
      // Seed series_progress rows: one kind='anime', one kind='show' that the detector flags.
      const conn = db.get();
      const now = Date.now();
      conn.prepare("INSERT INTO series_progress (profile_id, simkl_id, kind, tmdb_id, imdb_id, title, watched_eps, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.id, 101, 'anime', 'A1', 'ttA1', 'Cowboy Bebop', 5, 'completed', now);
      conn.prepare("INSERT INTO series_progress (profile_id, simkl_id, kind, tmdb_id, imdb_id, title, watched_eps, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.id, 102, 'show', 'A1', 'ttA1', 'Cowboy Bebop', 2, 'watching', now);
      // A non-anime show row (should not be counted).
      conn.prepare("INSERT INTO series_progress (profile_id, simkl_id, kind, tmdb_id, imdb_id, title, watched_eps, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.id, 103, 'show', 'B1', 'ttB', 'Some Show', 10, 'completed', now);

      // Seed taste rows (type='series') whose tmdb_id is in the anime history.
      conn.prepare("INSERT INTO taste_ratings (profile_id, type, tmdb_id, rating) VALUES (?, ?, ?, ?)").run(p.id, 'series', 'A1', 5);
      conn.prepare("INSERT INTO taste_ignore (profile_id, type, tmdb_id, at) VALUES (?, ?, ?, ?)").run(p.id, 'series', 'A1', Date.now());
      conn.prepare("INSERT INTO dont_recommend (profile_id, type, tmdb_id, reason, at) VALUES (?, ?, ?, ?, ?)").run(p.id, 'series', 'A1', 'user', Date.now());

      // Seed a recommended row with type='series' that the Fribb map flags as anime.
      conn.prepare("INSERT INTO recommended (profile_id, type, tmdb_id, imdb_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(p.id, 'series', 'A1', 'ttA1', 'Cowboy Bebop', Date.now());

      // Run the migration.
      await migration.runAll(console);

      // Verify the report.
      const report = migration.getReport(p.id);
      assert.ok(report, 'report exists');
      assert.strictEqual(report.anime_simkl, 1, 'one Simkl anime');
      assert.strictEqual(report.anime_detected_in_shows, 1, 'one detected under shows');
      assert.strictEqual(report.engaged, 1, 'one engaged (completed)');
      assert.strictEqual(report.ratings, 1, 'one rating');
      assert.strictEqual(report.ignores, 1, 'one ignore');
      assert.strictEqual(report.dont_recommend, 1, 'one dont_recommend');
      assert.strictEqual(report.series_pool_removed, 1, 'one series pool row removed');

      // The recommended row was deleted.
      const recRow = conn.prepare("SELECT * FROM recommended WHERE profile_id = ? AND type = 'series' AND tmdb_id = 'A1'").get(p.id);
      assert.strictEqual(recRow, undefined, 'anime series row removed from pool');

      // Idempotent: run again, no change.
      await migration.runAll(console);
      const report2 = migration.getReport(p.id);
      assert.deepStrictEqual(report2, report, 'second run produces the same report');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- A15b: fresh DATA_DIR where taste tables were never created → runAll resolves, markers with zero counts ----
  await ok('A15b: missing taste tables → runAll resolves, zero counts', async () => {
    const migration = require('../src/anime/migration');
    const db = require('../src/db');

    // Create a profile but do NOT create the taste tables.
    const p = config.addProfile('AN1A-A15b');
    try {
      // Ensure the taste tables do not exist (keep `recommended` — the portal needs it).
      db.get().exec('DROP TABLE IF EXISTS taste_ratings; DROP TABLE IF EXISTS taste_ignore; DROP TABLE IF EXISTS dont_recommend;');

      // Run the migration — it should resolve without error.
      await migration.runAll(console);

      // The marker is written with zero counts.
      const report = migration.getReport(p.id);
      assert.ok(report, 'report exists');
      assert.strictEqual(report.ratings, 0, 'ratings 0');
      assert.strictEqual(report.ignores, 0, 'ignores 0');
      assert.strictEqual(report.dont_recommend, 0, 'dont_recommend 0');
      assert.strictEqual(report.series_pool_removed, 0, 'series_pool_removed 0');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- Browser checks B1–B8 (only with --browser) ----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const screenshotDir = path.join(process.env.DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
    const pageErrors = [];
    const adminCookie = { name: 'air_sid', value: token, url: BASE };

    // Seed a TMDB key + LLM so the portal leaves setup mode.
    settings.updateSettings({ keys: { tmdb_api_key: 'x'.repeat(32) }, llm: { groq_api_key: 'gsk_test' } });

    // B1: Filters tab at 1280 px — three columns.
    await ok('B1: Filters tab at 1280px — three engine columns', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${BASE}/configure/`);
      // Wait for the Filters tab to be active.
      await page.waitForSelector('[data-tab="filters"]');
      // Click the Filters tab button to ensure it's active.
      await page.locator('.tab-btn[data-tab="filters"]').click();
      // Three columns: Movies, Shows, Anime.
      const cols = await page.locator('.cols-3 > div').count();
      assert.strictEqual(cols, 3, 'three columns');
      const labels = await page.locator('.cols-3 > div label').allInnerTexts();
      assert.deepStrictEqual(labels, ['Movies', 'Shows', 'Anime'], 'labels');
      // Movie and series selects have 1 option each, not disabled.
      const movieSel = page.locator('[data-filter="engine_movie"]');
      const seriesSel = page.locator('[data-filter="engine_series"]');
      assert.strictEqual(await movieSel.locator('option').count(), 1, 'movie 1 option');
      assert.strictEqual(await seriesSel.locator('option').count(), 1, 'series 1 option');
      assert.strictEqual(await movieSel.getAttribute('disabled'), null, 'movie not disabled');
      assert.strictEqual(await seriesSel.getAttribute('disabled'), null, 'series not disabled');
      // Anime select shows Disabled.
      const animeSel = page.locator('[data-filter="engine_anime"]');
      assert.strictEqual(await animeSel.inputValue(), 'off', 'anime shows off');
      const hint = await page.locator('[data-anime-hint]').innerText();
      assert.ok(hint.includes('Disabled: no anime row'), 'anime hint text');
      // Screenshot the Engines .sec-box element.
      await page.locator('.tab-panel[data-tab="filters"] .sec-box').first().screenshot({ path: path.join(screenshotDir, 'engines-1280.png') });
      await context.close();
    });

    // B2: Change Anime to Marquee Anime — hint swaps, save sends correct body.
    await ok('B2: Change Anime to Marquee Anime — hint + save', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${BASE}/configure/`);
      await page.waitForSelector('[data-tab="filters"]');
      const p = config.addProfile('AN1A-B2');
      try {
        // Select the profile in the URL.
        await page.goto(`${BASE}/configure/#filters?profile=${p.id}`);
        await page.waitForSelector('[data-filter="engine_anime"]');
        // Change to marquee-anime.
        await page.selectOption('[data-filter="engine_anime"]', 'marquee-anime');
        // Hint swaps.
        const hint = await page.locator('[data-anime-hint]').innerText();
        assert.ok(hint.includes('Recommended for you - Anime'), 'hint swaps');
        // Warn line appears (no client saved).
        const animeWarn = await page.locator('.warn-line[data-anime-warn]').count();
        assert.strictEqual(animeWarn, 1, 'anime warn line present');
        const warn = await page.locator('.warn-line[data-anime-warn]').innerText();
        assert.ok(warn.includes('AniDB client'), 'warn line');
        // Save and check the PUT body.
        const putBody = [];
        await page.route('**/api/profiles/**', (route) => {
          if (route.request().method() === 'PUT') putBody.push(route.request().postData());
          route.continue();
        });
        await page.locator('.tab-panel[data-tab="filters"] .save-bar button').click();
        await page.waitForTimeout(500);
        assert.ok(putBody.length > 0, 'PUT sent');
        const body = JSON.parse(putBody[0]);
        assert.strictEqual(body.filters?.engine_anime, 'marquee-anime', 'engine_anime in PUT');
        assert.strictEqual(body.filters?.engine_movie, undefined, 'no engine_movie');
        assert.strictEqual(body.filters?.engine_series, undefined, 'no engine_series');
        // Toast.
        const toast = await page.locator('.toast, [class*=toast]').first().innerText().catch(() => '');
        assert.ok(toast.includes('Anime engine enabled'), 'toast text');
      } finally {
        config.removeProfile(p.id);
        await context.close();
      }
    });

    // B3: 400 px — three engine fields stack in one column.
    await ok('B3: 400px — three engine fields stack', async () => {
      const context = await browser.newContext({ viewport: { width: 400, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${BASE}/configure/`);
      await page.waitForSelector('[data-tab="filters"]');
      const cols = await page.locator('.cols-3 > div').count();
      assert.strictEqual(cols, 3, 'three columns');
      await page.screenshot({ path: path.join(screenshotDir, 'engines-400.png') });
      await context.close();
    });

    // B4: Catalogs tab — 2 rows with anime off, 3 rows with it on.
    await ok('B4: Catalogs tab — 2/3 rows with anime off/on', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      const p = config.addProfile('AN1A-B4');
      try {
        await page.goto(`${BASE}/configure/`);
        await page.waitForSelector('#userSelect');
        // Select the B4 profile in the dropdown.
        await page.selectOption('#userSelect', p.id);
        await page.waitForSelector('[data-tab="catalogs"]');
        // With anime off: 2 "Recommended for you" rows (movie + series).
        const recRows = await page.locator('.tab-panel[data-tab="catalogs"] .cat-item .name:has-text("Recommended for you")').count();
        assert.strictEqual(recRows, 2, 'two Recommended for you rows when off');
        // Enable anime.
        await page.locator('.tab-btn[data-tab="filters"]').click();
        await page.waitForSelector('[data-filter="engine_anime"]');
        await page.selectOption('[data-filter="engine_anime"]', 'marquee-anime');
        // The Filters tab's Save button (not the Server Config Save).
        await page.locator('.tab-panel[data-tab="filters"] .save-bar button').click();
        await page.waitForTimeout(500);
        // Reload to get the updated profile data (the page doesn't re-render after save).
        await page.reload();
        await page.waitForSelector('#userSelect');
        await page.selectOption('#userSelect', p.id);
        // Switch to the catalogs tab.
        await page.locator('.tab-btn[data-tab="catalogs"]').click();
        await page.waitForSelector('[data-tab="catalogs"]');
        const recRowsOn = await page.locator('.tab-panel[data-tab="catalogs"] .cat-item .name:has-text("Recommended for you")').count();
        assert.strictEqual(recRowsOn, 3, 'three Recommended for you rows when on');
      } finally {
        config.removeProfile(p.id);
        await context.close();
      }
    });

    // B5: Advanced → API Keys — section + blocks, test buttons, number input style.
    await ok('B5: Advanced → API Keys — section + blocks', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      const p = config.addProfile('AN1A-B5');
      const anidb = require('../src/services/anidb');
      try {
        await page.goto(`${BASE}/configure/#advanced?profile=${p.id}`);
        await page.waitForSelector('[data-tab="advanced"]');
        await page.locator('.tab-btn[data-tab="advanced"]').click();
        // Section title.
        const title = await page.locator('.sec-title', { hasText: 'API Keys' }).innerText();
        assert.ok(title.includes('API Keys'), 'API Keys title');
        // Three blocks in order: MDBList, MyAnimeList, AniDB.
        const labels = await page.locator('[data-tab="advanced"] label').allInnerTexts();
        const mdbIdx = labels.findIndex((l) => l.includes('MDBList'));
        const malIdx = labels.findIndex((l) => l.includes('MyAnimeList'));
        const anidbIdx = labels.findIndex((l) => l.includes('AniDB'));
        assert.ok(mdbIdx >= 0, 'MDBList label');
        assert.ok(malIdx >= 0, 'MyAnimeList label');
        assert.ok(anidbIdx >= 0, 'AniDB label');
        assert.ok(mdbIdx < malIdx && malIdx < anidbIdx, 'order MDBList < MAL < AniDB');
        // 1. Assert .key-sep count = 2 inside the API Keys box.
        const apiKeysBox = page.locator('.sec-box', { has: page.locator('text=MDBList personal API key') });
        const keySepCount = await apiKeysBox.locator('.key-sep').count();
        assert.strictEqual(keySepCount, 2, 'two key separators');

        // 2. Stub AniDB in-process with the aid23 fixture, fill name + version, click Test.
        const aid23Xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'anidb-aid23.xml'), 'utf8');
        anidb._setFetch(async (url) => ({ status: 200, text: async () => aid23Xml }));
        await apiKeysBox.locator('[data-key="anidb_client"]').fill('test-client');
        await apiKeysBox.locator('[data-key="anidb_clientver"]').fill('1');
        await apiKeysBox.locator('button:has-text("Test")').nth(2).click();
        await page.waitForTimeout(500);
        const anidbRes = await apiKeysBox.locator('[data-tres="anidb-user"]').innerText();
        assert.ok(anidbRes.includes('✓ Client accepted'), 'AniDB test success: ' + anidbRes);

        // 3. Stub a bad client, change the name, click Test.
        anidb._setFetch(async (url) => ({ status: 200, text: async () => '<error code="302">client version missing or invalid</error>' }));
        await apiKeysBox.locator('[data-key="anidb_client"]').fill('bad-client');
        await apiKeysBox.locator('button:has-text("Test")').nth(2).click();
        await page.waitForTimeout(5000); // spacing guard: ≥ 4000ms between requests
        const anidbRes2 = await apiKeysBox.locator('[data-tres="anidb-user"]').innerText();
        assert.ok(anidbRes2.includes('✗ AniDB doesn\'t recognise this client'), 'AniDB bad client: ' + anidbRes2);

        // 4. Stub global.fetch for MAL, fill the MAL key, click its Test.
        const realFetch = global.fetch;
        global.fetch = async (url, opts) => {
          if (String(url).includes('api.myanimelist.net')) {
            return { ok: true, status: 200, json: async () => ({ id: 1, title: 'Cowboy Bebop', rating: 'r' }) };
          }
          return realFetch(url, opts);
        };
        await apiKeysBox.locator('[data-key="mal_client_id"]').fill('test-mal-key');
        await apiKeysBox.locator('button:has-text("Test")').nth(1).click();
        await page.waitForTimeout(500);
        const malRes = await apiKeysBox.locator('[data-tres="mal-user"]').innerText();
        assert.ok(malRes.includes('✓ MyAnimeList key valid (Cowboy Bebop rated R)'), 'MAL test: ' + malRes);
        global.fetch = realFetch;

        // 5. Assert the version input's computed background-color is not white.
        const bg = await apiKeysBox.locator('[data-key="anidb_clientver"]').evaluate((el) => getComputedStyle(el).backgroundColor);
        assert.notStrictEqual(bg, 'rgb(255, 255, 255)', 'number input not white: ' + bg);

        // 6. Click AniDB Clear and assert both inputs are empty.
        await apiKeysBox.locator('button:has-text("Clear")').nth(2).click();
        await page.waitForTimeout(500);
        assert.strictEqual(await apiKeysBox.locator('[data-key="anidb_client"]').inputValue(), '', 'client cleared');
        assert.strictEqual(await apiKeysBox.locator('[data-key="anidb_clientver"]').inputValue(), '', 'clientver cleared');

        // 7. Screenshot the API Keys .sec-box.
        await apiKeysBox.screenshot({ path: path.join(screenshotDir, 'api-keys.png') });
      } finally {
        config.removeProfile(p.id);
        await context.close();
      }
    });

    // B6: Server Config — MAL + AniDB fields present.
    await ok('B6: Server Config — MAL + AniDB fields', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${BASE}/configure/`);
      // Server Config is a separate card (not a tab) — force it visible.
      await page.click('#serverCfgBtn');
      await page.waitForSelector('#serverConfig');
      const serverConfig = page.locator('#serverConfig');
      const malField = await serverConfig.locator('text=MyAnimeList').count();
      const anidbField = await serverConfig.locator('text=AniDB').count();
      assert.ok(malField > 0, 'MAL field present');
      assert.ok(anidbField > 0, 'AniDB field present');
      await context.close();
    });

    // B7: /mobile → ⚙ → Filters at 390×844 — three engine selects.
    await ok('B7: Mobile Filters — three engine selects', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      const p = config.addProfile('AN1A-B7');
      try {
        // Login to the mobile companion.
        const token = require('../mobile/server/auth').createSession(p.id).token;
        await context.addCookies([{ name: 'air_sid', value: token, url: `${BASE}/mobile/` }]);
        await page.goto(`${BASE}/mobile/#/settings`);
        await page.waitForSelector('#set-engine-anime');
        // Three engine selects.
        const movieSel = await page.locator('#set-engine-movie').count();
        const seriesSel = await page.locator('#set-engine-series').count();
        const animeSel = await page.locator('#set-engine-anime').count();
        assert.strictEqual(movieSel, 1, 'movie select');
        assert.strictEqual(seriesSel, 1, 'series select');
        assert.strictEqual(animeSel, 1, 'anime select');
        // Anime sub-text.
        const sub = await page.locator('#set-engine-anime-sub').innerText();
        assert.ok(sub.includes('Disabled'), 'anime sub text');
        await page.screenshot({ path: path.join(screenshotDir, 'mobile-engines.png') });
      } finally {
        config.removeProfile(p.id);
        await context.close();
      }
    });

    // B8: No page errors on any page.
    await ok('B8: No page errors', async () => {
      assert.deepStrictEqual(pageErrors, [], 'no page errors');
    });

    await browser.close();
  }

  console.log(`\nAll anime-lane checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
