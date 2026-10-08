// AN-1a: the anime lane — lanes, the Marquee Anime engine, settings, the store
// plumbing, the AniDB client, the MAL API source and the one-time migration.
// Run: node --experimental-sqlite test/anime-lane.js
// Browser checks: node --experimental-sqlite test/anime-lane.js --browser
'use strict';
const assert = require('assert');

process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-an1a-' + Date.now();
process.env.PORT = '7316'; // distinct from engines-marquee-only (7315)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const lanes = require('../src/lanes');
const engines = require('../src/engines');
const config = require('../src/config');
const settings = require('../src/settings');
const store = require('../src/store');

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

  console.log(`\nAll anime-lane checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
