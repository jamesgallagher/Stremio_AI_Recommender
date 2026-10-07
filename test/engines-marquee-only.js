// ENG-R: Marquee-only engine registry — verifies the 2-engine world after
// retiring Genesis and Glass. Run: node --experimental-sqlite test/engines-marquee-only.js
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TMP = path.join(__dirname, '..', 'temp', 'test-data-engr-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.DATA_DIR = TMP;
process.env.SECRET_KEY = 'test-secret-key';

const engines = require('../src/engines');
const config = require('../src/config');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); process.exit(1); }
}

console.log('engines-marquee-only:');

// N1: Only two engines in the registry
ok('N1: registry has exactly marquee + marquee-tv', () => {
  const list = engines.list();
  assert.strictEqual(list.length, 2);
  const ids = list.map((e) => e.id).sort();
  assert.deepStrictEqual(ids, ['marquee', 'marquee-tv']);
});

// N2: DEFAULT_IDS is correct
ok('N2: DEFAULT_IDS = { movie: marquee, series: marquee-tv }', () => {
  assert.deepStrictEqual(engines.DEFAULT_IDS, { movie: 'marquee', series: 'marquee-tv' });
});

// N3: defaultFor returns the correct engine
ok('N3: defaultFor(movie) = marquee, defaultFor(series) = marquee-tv', () => {
  assert.strictEqual(engines.defaultFor('movie').id, 'marquee');
  assert.strictEqual(engines.defaultFor('series').id, 'marquee-tv');
});

// N4: resolveFor falls back to defaultFor for invalid engine ids
ok('N4: resolveFor falls back to defaultFor for invalid/unknown engine ids', () => {
  const p = { filters: { engine_movie: 'genesis', engine_series: 'glass' } };
  assert.strictEqual(engines.resolveFor(p, 'movie').id, 'marquee');
  assert.strictEqual(engines.resolveFor(p, 'series').id, 'marquee-tv');
  // Unknown engine id
  const p2 = { filters: { engine_movie: 'nonexistent' } };
  assert.strictEqual(engines.resolveFor(p2, 'movie').id, 'marquee');
  // Correct engine id
  const p3 = { filters: { engine_movie: 'marquee', engine_series: 'marquee-tv' } };
  assert.strictEqual(engines.resolveFor(p3, 'movie').id, 'marquee');
  assert.strictEqual(engines.resolveFor(p3, 'series').id, 'marquee-tv');
});

// N5: availableFor returns both engines for an adult profile
ok('N5: availableFor returns both Marquee engines for an adult profile', () => {
  const p = { filters: { age_limit: 0 } };
  const movie = engines.availableFor(p, 'movie');
  const series = engines.availableFor(p, 'series');
  assert.deepStrictEqual(movie.map((e) => e.id), ['marquee']);
  assert.deepStrictEqual(series.map((e) => e.id), ['marquee-tv']);
});

// N6: availableFor excludes unrestricted engines for age-limited profiles
ok('N6: availableFor excludes unrestricted engines for age-limited profiles', () => {
  // Register a fake unrestricted engine
  const dispose = engines._register({
    id: 'fake-open', name: 'Fake Open', supportedTypes: ['movie', 'series'],
    capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: true },
    requirements: () => ({ ok: true, missing: [] }),
    generate: async () => [],
  });
  try {
    const adult = { filters: { age_limit: 0 } };
    const kid = { filters: { age_limit: 12 } };
    assert.ok(engines.availableFor(adult, 'movie').some((e) => e.id === 'fake-open'));
    assert.ok(!engines.availableFor(kid, 'movie').some((e) => e.id === 'fake-open'));
    // Marquee engines are unrestricted:false, so they remain for kids
    assert.ok(engines.availableFor(kid, 'movie').some((e) => e.id === 'marquee'));
  } finally { dispose(); }
});

// N7: No SC-07 enablement — engines always available
ok('N7: no isEnabled/listEnabled — engines always available', () => {
  assert.strictEqual(typeof engines.isEnabled, 'undefined');
  assert.strictEqual(typeof engines.listEnabled, 'undefined');
  assert.strictEqual(typeof engines.listEnabledFor, 'undefined');
  assert.strictEqual(typeof engines.DEFAULT_ID, 'undefined');
});

// N8: Invalid stored engine ids migrate to the type's default on load
ok('N8: config.applyMigrations migrates invalid engine ids to defaults', () => {
  const p = config.addProfile('ENG-R-N8');
  try {
    // Simulate an old profile with genesis/glass engine ids
    config.updateProfile(p.id, { filters: { engine_movie: 'genesis', engine_series: 'glass' } });
    const prof = config.getProfile(p.id);
    // The stored values should be migrated to marquee/marquee-tv
    assert.strictEqual(prof.filters.engine_movie, 'marquee');
    assert.strictEqual(prof.filters.engine_series, 'marquee-tv');
  } finally {
    config.removeProfile(p.id);
  }
});

console.log('All engines-marquee-only checks passed (' + passed + ').');
fs.rmSync(TMP, { recursive: true, force: true });
