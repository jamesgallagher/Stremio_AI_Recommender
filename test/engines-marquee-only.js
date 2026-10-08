// ENG-R: Marquee-only engine registry — verifies the 2-engine world after
// retiring Genesis and Glass. Run: node --experimental-sqlite test/engines-marquee-only.js
// Browser checks: node --experimental-sqlite test/engines-marquee-only.js --browser
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-engr-' + Date.now();
process.env.PORT = '7315'; // distinct from smoke (7311), mobile (7312), integration (7313), shared-login (7314)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const engines = require('../src/engines');
const config = require('../src/config');
const store = require('../src/store');
const settings = require('../src/settings');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const BASE = `http://localhost:${process.env.PORT}`;

(async () => {
  console.log('engines-marquee-only:');

  // ---- N1: registry has exactly marquee + marquee-tv ----
  await ok('N1: registry — list, listForType, get', async () => {
    const ids = engines.list().map((e) => e.id);
    assert.deepStrictEqual(ids.sort(), ['marquee', 'marquee-anime', 'marquee-tv']);
    assert.deepStrictEqual(engines.listForType('movie').map((e) => e.id), ['marquee']);
    assert.deepStrictEqual(engines.listForType('series').map((e) => e.id), ['marquee-tv']);
    assert.deepStrictEqual(engines.listForType('anime').map((e) => e.id), ['marquee-anime']);
    assert.strictEqual(engines.get('genesis'), null);
    assert.strictEqual(engines.get('glass'), null);
  });

  // ---- N2: resolveFor fallbacks ----
  await ok('N2: resolveFor — genesis/glass/nope/undefined/cross-type all fall back', async () => {
    const cases = [
      { filters: { engine_movie: 'genesis' }, type: 'movie', expect: 'marquee' },
      { filters: { engine_series: 'glass' }, type: 'series', expect: 'marquee-tv' },
      { filters: { engine_movie: 'nope' }, type: 'movie', expect: 'marquee' },
      { filters: {} , type: 'movie', expect: 'marquee' }, // undefined
      { filters: { engine_movie: 'marquee-tv' }, type: 'movie', expect: 'marquee' }, // cross-type
      { filters: { engine_series: 'marquee' }, type: 'series', expect: 'marquee-tv' }, // cross-type
    ];
    for (const c of cases) {
      const e = engines.resolveFor(c, c.type);
      assert.strictEqual(e.id, c.expect, `resolveFor(${JSON.stringify(c.filters)}, ${c.type}) → ${e.id}, expected ${c.expect}`);
    }
    // Age-limited profile (age 10)
    const kid = { filters: { age_limit: 10, engine_movie: 'marquee', engine_series: 'marquee-tv' } };
    assert.strictEqual(engines.resolveFor(kid, 'movie').id, 'marquee');
    assert.strictEqual(engines.resolveFor(kid, 'series').id, 'marquee-tv');
  });

  // ---- N3: Migration — profiles.json with genesis/glass loads as marquee/marquee-tv ----
  await ok('N3: migration — genesis/glass in profiles.json migrates to defaults', async () => {
    const p = config.addProfile('ENG-R-N3');
    try {
      // Write a profile with legacy engine ids directly to the store
      const raw = {
        id: p.id, name: 'ENG-R-N3',
        token: crypto.randomBytes(16).toString('hex'),
        email: '', is_admin: false, created_at: Date.now(),
        keys: {}, filters: { engine_movie: 'genesis', engine_series: 'glass' },
      };
      store.saveProfiles({ profiles: [raw] });
      // Re-read via config
      const prof = config.getProfile(p.id);
      assert.strictEqual(prof.filters.engine_movie, 'marquee', 'engine_movie migrated');
      assert.strictEqual(prof.filters.engine_series, 'marquee-tv', 'engine_series migrated');
    } finally {
      config.removeProfile(p.id);
    }
    // New profile defaults
    const p2 = config.addProfile('ENG-R-N3-new');
    try {
      const prof = config.getProfile(p2.id);
      assert.strictEqual(prof.filters.engine_movie, 'marquee');
      assert.strictEqual(prof.filters.engine_series, 'marquee-tv');
    } finally {
      config.removeProfile(p2.id);
    }
  });

  // ---- N4: Settings legacy-key strip on read AND on disk after save ----
  await ok('N4: settings — legacy engines/glass/embed_* stripped on read and on disk after save', async () => {
    // Write a settings.json with legacy keys
    const legacySettings = {
      llm: { custom_name: '', custom_uri: '', custom_api_key: '', groq_api_key: '', groq_api_key_backup: '', embed_model: 'm' },
      keys: { tmdb_api_key: '', mdblist_api_key: '', rpdb_api_key: 't0-free-rpdb', tvdb_api_key: '' },
      marquee: { serve: { lambda: 0.85 } },
      engines: { genesis: true, glass: true, marquee: false },
      glass: { x: 1 },
      created_at: Date.now(),
    };
    store.saveSettings(legacySettings);
    // Read: no engines/glass key, no embed_* fields
    const s = settings.getSettings();
    assert.strictEqual(s.engines, undefined, 'no engines key on read');
    assert.strictEqual(s.glass, undefined, 'no glass key on read');
    assert.strictEqual(s.llm.embed_model, undefined, 'no embed_model on read');
    assert.strictEqual(s.llm.embed_uri, undefined, 'no embed_uri on read');
    assert.strictEqual(s.llm.embed_api_key, undefined, 'no embed_api_key on read');
    // marquee round-trips unchanged
    assert.deepStrictEqual(s.marquee, { serve: { lambda: 0.85 } });
    // After updateSettings({}), the file on disk has none of them
    settings.updateSettings({});
    const raw = store.loadSettings();
    assert.strictEqual(raw.engines, undefined, 'no engines on disk after save');
    assert.strictEqual(raw.glass, undefined, 'no glass on disk after save');
    assert.strictEqual(raw.llm.embed_model, undefined, 'no embed_model on disk after save');
    // marquee still intact on disk
    assert.deepStrictEqual(raw.marquee, { serve: { lambda: 0.85 } });
  });

  // ---- HTTP surface (N5-N7) ----
  console.log('engines-marquee-only http:');
  require('../src/server');
  const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
  const { token } = provisionAdmin();
  const restore = attachCookie(BASE, cookieHeader(token));

  // Ensure settings exist (N4 wrote them; make sure they're loaded)
  if (!settings.getSettings()) {
    // Create a minimal settings file
    store.saveSettings({ llm: { custom_name: '', custom_uri: '', custom_api_key: '', groq_api_key: '', groq_api_key_backup: '' }, keys: { tmdb_api_key: '', mdblist_api_key: '', rpdb_api_key: 't0-free-rpdb', tvdb_api_key: '' }, marquee: {}, created_at: Date.now() });
  }

  // ---- N5: HTTP PUT /api/settings ignores engines/glass + GET /api/engines exact key set ----
  await ok('N5: HTTP — PUT /api/settings ignores engines/glass; GET /api/engines exact keys', async () => {
    // PUT with legacy engines/glass fields
    const res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(token) },
      body: JSON.stringify({ engines: { marquee: false }, glass: { a: 1 } }),
    });
    assert.strictEqual(res.status, 200, 'PUT /api/settings → 200');
    // Verify neither is stored
    const s = settings.getSettings();
    assert.strictEqual(s.engines, undefined, 'engines not stored');
    assert.strictEqual(s.glass, undefined, 'glass not stored');
    // GET /api/engines returns exactly three items with keys id,name,description,supported_types
    const res2 = await fetch(`${BASE}/api/engines`, { headers: { Cookie: cookieHeader(token) } });
    assert.strictEqual(res2.status, 200);
    const body = await res2.json();
    assert.strictEqual(body.engines.length, 3, 'three engines');
    for (const e of body.engines) {
      const keys = Object.keys(e).sort();
      assert.deepStrictEqual(keys, ['description', 'id', 'name', 'supported_types'], `engine ${e.id} has exact keys`);
    }
    const ids = body.engines.map((e) => e.id).sort();
    assert.deepStrictEqual(ids, ['marquee', 'marquee-anime', 'marquee-tv']);
  });

  // ---- N6: HTTP GET /api/profiles — engines shape with no available ----
  await ok('N6: HTTP — GET /api/profiles engines shape (movie, series, requirements, no available)', async () => {
    const p = config.addProfile('ENG-R-N6');
    try {
      const res = await fetch(`${BASE}/api/profiles`, { headers: { Cookie: cookieHeader(token) } });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      const prof = body.profiles.find((x) => x.id === p.id);
      assert.ok(prof, 'profile found');
      assert.strictEqual(prof.engines.movie, 'marquee');
      assert.strictEqual(prof.engines.series, 'marquee-tv');
      assert.ok(prof.engines.requirements, 'requirements object present');
      assert.strictEqual(prof.engines.available, undefined, 'no available key');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- N7: HTTP companion — GET /mobile/api/settings + POST ignoring engine_movie ----
  await ok('N7: HTTP companion — GET engines names + POST ignoring engine_movie', async () => {
    // GET /mobile/api/settings
    const res = await fetch(`${BASE}/mobile/api/settings`, { headers: { Cookie: cookieHeader(token) } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.engines.movie.name, 'Marquee Cinema');
    assert.strictEqual(body.engines.series.name, 'Marquee TV');
    // POST with engine_movie: 'genesis' — should be ignored
    const p = config.addProfile('ENG-R-N7');
    try {
      const res2 = await fetch(`${BASE}/mobile/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(token) },
        body: JSON.stringify({ engine_movie: 'genesis', min_rating: 6 }),
      });
      assert.strictEqual(res2.status, 200, 'POST → 200');
      const prof = config.getProfile(p.id);
      assert.strictEqual(prof.filters.engine_movie, 'marquee', 'engine still marquee after POST with genesis');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- N8: deleted modules throw MODULE_NOT_FOUND + glass folder gone ----
  await ok('N8: deleted modules — MODULE_NOT_FOUND + glass folder gone', async () => {
    const deleted = [
      '../src/engines/genesis',
      '../src/engines/glass',
      '../src/engines/glass/rerank',
      '../src/engines/glass/semantic',
      '../src/engines/glass/embedStore',
      '../src/engines/_template',
      '../src/services/embeddings',
    ];
    for (const mod of deleted) {
      assert.throws(() => require(mod), (e) => e.code === 'MODULE_NOT_FOUND', `${mod} throws MODULE_NOT_FOUND`);
    }
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'engines', 'glass')), 'src/engines/glass does not exist');
  });

  // ---- N9: DEFAULT_IDS is correct (was N2) ----
  await ok('N9: DEFAULT_IDS = { movie: marquee, series: marquee-tv, anime: off }', async () => {
    assert.deepStrictEqual(engines.DEFAULT_IDS, { movie: 'marquee', series: 'marquee-tv', anime: 'off' });
  });

  // ---- N10: defaultFor returns the correct engine (was N3) ----
  await ok('N10: defaultFor(movie) = marquee, defaultFor(series) = marquee-tv', async () => {
    assert.strictEqual(engines.defaultFor('movie').id, 'marquee');
    assert.strictEqual(engines.defaultFor('series').id, 'marquee-tv');
  });

  // ---- N11: resolveFor falls back for invalid ids (was N4) ----
  await ok('N11: resolveFor falls back to defaultFor for invalid/unknown engine ids', async () => {
    const p = { filters: { engine_movie: 'genesis', engine_series: 'glass' } };
    assert.strictEqual(engines.resolveFor(p, 'movie').id, 'marquee');
    assert.strictEqual(engines.resolveFor(p, 'series').id, 'marquee-tv');
    const p2 = { filters: { engine_movie: 'nonexistent' } };
    assert.strictEqual(engines.resolveFor(p2, 'movie').id, 'marquee');
    const p3 = { filters: { engine_movie: 'marquee', engine_series: 'marquee-tv' } };
    assert.strictEqual(engines.resolveFor(p3, 'movie').id, 'marquee');
    assert.strictEqual(engines.resolveFor(p3, 'series').id, 'marquee-tv');
  });

  // ---- N12: availableFor returns both engines for an adult profile (was N5) ----
  await ok('N12: availableFor returns both Marquee engines for an adult profile', async () => {
    const p = { filters: { age_limit: 0 } };
    assert.deepStrictEqual(engines.availableFor(p, 'movie').map((e) => e.id), ['marquee']);
    assert.deepStrictEqual(engines.availableFor(p, 'series').map((e) => e.id), ['marquee-tv']);
  });

  // ---- N13: availableFor excludes unrestricted engines for age-limited profiles (was N6) ----
  await ok('N13: availableFor excludes unrestricted engines for age-limited profiles', async () => {
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
      assert.ok(engines.availableFor(kid, 'movie').some((e) => e.id === 'marquee'));
    } finally { dispose(); }
  });

  // ---- N14: No SC-07 enablement (was N7) ----
  await ok('N14: no isEnabled/listEnabled — engines always available', async () => {
    assert.strictEqual(typeof engines.isEnabled, 'undefined');
    assert.strictEqual(typeof engines.listEnabled, 'undefined');
    assert.strictEqual(typeof engines.listEnabledFor, 'undefined');
    assert.strictEqual(typeof engines.DEFAULT_ID, 'undefined');
  });

  // ---- N15: config.applyMigrations migrates invalid engine ids (was N8) ----
  await ok('N15: config.applyMigrations migrates invalid engine ids to defaults', async () => {
    const p = config.addProfile('ENG-R-N15');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'genesis', engine_series: 'glass' } });
      const prof = config.getProfile(p.id);
      assert.strictEqual(prof.filters.engine_movie, 'marquee');
      assert.strictEqual(prof.filters.engine_series, 'marquee-tv');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- Browser checks E1-E6 ----
  if (process.argv.includes('--browser')) {
    console.log('engines-marquee-only browser:');
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const screenshotDir = process.env.DATA_DIR;
    let browserFailed = 0;

    const ctx = await browser.newContext({ colorScheme: 'dark' });
    // Set the admin session cookie on the context so all pages are authenticated
    await ctx.addCookies([{ name: 'air_sid', value: token, url: BASE }]);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => { console.error(`  [page error] ${err.message}`); browserFailed++; });

    // E1: Configure → Filters tab
    const page1 = await ctx.newPage();
    page1.on('pageerror', (err) => { console.error(`  [page error] ${err.message}`); browserFailed++; });
    await page1.goto(`${BASE}/configure/`, { waitUntil: 'load' });
    // Click Filters tab
    await page1.click('[data-tab="filters"]');
    await page1.waitForTimeout(500);
    const filtersBody = await page1.evaluate(() => document.body.innerText);
    const e1a = filtersBody.includes('Marquee Cinema (movies) · Marquee TV (shows)');
    const e1b = filtersBody.includes('Movies are built by');
    const e1c = filtersBody.includes('Marquee Cinema and shows by Marquee TV');
    const hasEngineSelect = await page1.evaluate(() => !!document.querySelector('select[data-filter^="engine_"]'));
    const e1d = !hasEngineSelect;
    console.log(`  E1a: Filters intro "Movies are built by Marquee Cinema and shows by Marquee TV." → ${e1b && e1c ? 'PASS' : 'FAIL'}`);
    console.log(`  E1b: Engines box text "Marquee Cinema (movies) · Marquee TV (shows)" → ${e1a ? 'PASS' : 'FAIL'}`);
    console.log(`  E1c: No select[data-filter^="engine_"] → ${e1d ? 'PASS' : 'FAIL'}`);
    if (!(e1a && e1b && e1c && e1d)) browserFailed++;
    await page1.screenshot({ path: path.join(screenshotDir, 'filters.png') });
    await page1.close();

    // E2: Profile without Simkl — warn-lines
    // Create a profile without Simkl connection
    const p2 = config.addProfile('ENG-R-E2');
    const page2 = await ctx.newPage();
    page2.on('pageerror', (err) => { console.error(`  [page error] ${err.message}`); browserFailed++; });
    await page2.goto(`${BASE}/configure/`, { waitUntil: 'load' });
    await page2.click('[data-tab="filters"]');
    await page2.waitForTimeout(500);
    const warnLines = await page2.evaluate(() => document.querySelectorAll('.warn-line').length);
    const warnTexts = await page2.evaluate(() => [...document.querySelectorAll('.warn-line')].map((el) => el.textContent));
    const e2a = warnLines >= 2;
    const e2b = warnTexts.some((t) => t.includes('Simkl connection'));
    console.log(`  E2a: warn-lines present (≥2) → ${e2a ? 'PASS' : 'FAIL'} (found ${warnLines})`);
    console.log(`  E2b: "Simkl connection" in warn-line → ${e2b ? 'PASS' : 'FAIL'}`);
    if (!(e2a && e2b)) browserFailed++;
    config.removeProfile(p2.id);

    // E3: Server Config — no "Engines" summary, no [data-engine]
    const page3 = await ctx.newPage();
    page3.on('pageerror', (err) => { console.error(`  [page error] ${err.message}`); browserFailed++; });
    await page3.goto(`${BASE}/configure/`, { waitUntil: 'load' });
    await page3.click('#serverCfgBtn');
    await page3.waitForTimeout(500);
    const hasEnginesSummary = await page3.evaluate(() => {
      const summaries = [...document.querySelectorAll('summary')];
      return summaries.some((s) => s.textContent.includes('Engines'));
    });
    const hasDataEngine = await page3.evaluate(() => !!document.querySelector('[data-engine]'));
    const e3a = !hasEnginesSummary;
    const e3b = !hasDataEngine;
    console.log(`  E3a: No "Engines" summary → ${e3a ? 'PASS' : 'FAIL'}`);
    console.log(`  E3b: No [data-engine] input → ${e3b ? 'PASS' : 'FAIL'}`);
    if (!(e3a && e3b)) browserFailed++;
    await page3.screenshot({ path: path.join(screenshotDir, 'server-config.png') });
    await page3.close();

    // E4: Save Filters — PUT body has no engine_movie/engine_series
    const page4 = await ctx.newPage();
    page4.on('pageerror', (err) => { console.error(`  [page error] ${err.message}`); browserFailed++; });
    await page4.goto(`${BASE}/configure/`, { waitUntil: 'load' });
    await page4.click('[data-tab="filters"]');
    await page4.waitForTimeout(500);
    // Intercept the PUT
    let putBody = null;
    page4.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/profiles/')) {
        putBody = req.postData();
      }
    });
    // Click Save (the Filters tab Save button)
    await page4.click('button:has-text("Save")');
    await page4.waitForTimeout(1000);
    const e4a = putBody === null || !putBody.includes('engine_movie');
    const e4b = putBody === null || !putBody.includes('engine_series');
    console.log(`  E4a: PUT body has no engine_movie → ${e4a ? 'PASS' : 'FAIL'}`);
    console.log(`  E4b: PUT body has no engine_series → ${e4b ? 'PASS' : 'FAIL'}`);
    if (!(e4a && e4b)) browserFailed++;
    await page4.close();

    // E5: /mobile → Settings → #set-engines
    const page5 = await ctx.newPage();
    page5.on('pageerror', (err) => { console.error(`  [page error] ${err.message}`); browserFailed++; });
    await page5.setViewportSize({ width: 375, height: 812 });
    await page5.goto(`${BASE}/mobile/`, { waitUntil: 'load' });
    // Navigate to settings via the ⚙ button
    await page5.click('#open-settings');
    await page5.waitForTimeout(500);
    const setEnginesText = await page5.evaluate(() => {
      const el = document.querySelector('#set-engines');
      return el ? el.textContent : '';
    });
    const e5a = setEnginesText.startsWith('Marquee Cinema (movies) · Marquee TV (shows)');
    const hasEngineSelectMobile = await page5.evaluate(() => !!document.querySelector('select[data-filter^="engine_"]'));
    const e5b = !hasEngineSelectMobile;
    console.log(`  E5a: #set-engines text starts "Marquee Cinema (movies) · Marquee TV (shows)" → ${e5a ? 'PASS' : 'FAIL'} (got: "${setEnginesText}")`);
    console.log(`  E5b: No engine select on /mobile → ${e5b ? 'PASS' : 'FAIL'}`);
    if (!(e5a && e5b)) browserFailed++;
    await page5.screenshot({ path: path.join(screenshotDir, 'mobile-settings.png') });
    await page5.close();

    // E6: No page errors (checked via pageerror handler)
    console.log(`  E6: No page errors → ${browserFailed === 0 ? 'PASS' : 'FAIL'} (${browserFailed} errors)`);

    await browser.close();
  }

  restore();
  console.log(`\nAll engines-marquee-only checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
