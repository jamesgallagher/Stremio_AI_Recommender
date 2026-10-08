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

  console.log(`\nAll anime-lane checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
