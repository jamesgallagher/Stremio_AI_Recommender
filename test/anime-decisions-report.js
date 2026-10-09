// AN-1b card 3: the anime decision report — read API, portal panel, and CLI.
// Run: node --experimental-sqlite test/anime-decisions-report.js
// Browser checks: node --experimental-sqlite test/anime-decisions-report.js --browser
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an1b3-' + Date.now();
process.env.PORT = '7318'; // distinct from the other suites (7311-7317 are taken)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const config = require('../src/config');
const decisionLog = require('../src/anime/decisionLog');
const settings = require('../src/settings');

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

// Seed a profile with two builds: the newer with 3 selected / 2 rejected_age /
// 1 rejected_llm / 2 filtered; the older with a different selected set (one
// title shared, one only in each) so the diff has + and - rows.
function seedTwoBuilds(name) {
  const p = config.addProfile(name);
  config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime', age_limit: 14 } });
  const lane = 'anime';
  const buildOld = decisionLog.newBuildId();
  const buildNew = decisionLog.newBuildId();
  // Older build: selected Alpha (shared), X-ray, Yankee (only here).
  decisionLog.record(p.id, lane, buildOld, [
    { item_key: 'A', stage: 'engine', outcome: 'selected', title: 'Alpha', year: 2020, poster: '/a.jpg', mal_rating: 7.5, source: 'simkl', reason: 'Trending anime' },
    { item_key: 'X', stage: 'engine', outcome: 'selected', title: 'X-ray', year: 2021, poster: '/x.jpg', mal_rating: 8.0, source: 'simkl', reason: 'Trending anime' },
    { item_key: 'Y', stage: 'engine', outcome: 'selected', title: 'Yankee', year: 2022, poster: '/y.jpg', mal_rating: 7.0, source: 'simkl', reason: 'Trending anime' },
  ]);
  // Newer build: selected Alpha (shared), Bravo, Charlie (only here); rejected_age
  // Delta, Echo; rejected_llm Foxtrot; filtered Golf, Hotel.
  decisionLog.record(p.id, lane, buildNew, [
    { item_key: 'A', stage: 'engine', outcome: 'selected', title: 'Alpha', year: 2020, poster: '/a.jpg', mal_rating: 7.5, source: 'simkl', reason: 'Trending anime' },
    { item_key: 'B', stage: 'engine', outcome: 'selected', title: 'Bravo', year: 2021, poster: '/b.jpg', mal_rating: 8.0, source: 'simkl', reason: 'Trending anime' },
    { item_key: 'C', stage: 'engine', outcome: 'selected', title: 'Charlie', year: 2022, poster: '/c.jpg', mal_rating: 7.0, source: 'simkl', reason: 'Trending anime' },
    { item_key: 'D', stage: 'age', outcome: 'rejected_age', title: 'Delta', year: 2020, poster: '/d.jpg', mal_rating: 9.0, source: 'simkl', rating: 'mal:R', reason: 'MAL rating R is above the tier' },
    { item_key: 'E', stage: 'age', outcome: 'rejected_age', title: 'Echo', year: 2021, poster: '/e.jpg', mal_rating: 8.5, source: 'simkl', rating: 'csm:16', reason: 'Common Sense age 16 is above the tier' },
    { item_key: 'F', stage: 'llm', outcome: 'rejected_llm', title: 'Foxtrot', year: 2022, poster: '/f.jpg', mal_rating: 7.5, source: 'simkl', rating: 'llm', reason: 'LLM judged not suitable' },
    { item_key: 'G', stage: 'pool-cap', outcome: 'filtered', title: 'Golf', year: 2020, poster: '/g.jpg', mal_rating: 6.5, source: 'simkl', reason: 'Below the pool cut-off' },
    { item_key: 'H', stage: 'no-tt', outcome: 'filtered', title: 'Hotel', year: 2021, poster: '/h.jpg', mal_rating: 6.0, source: 'simkl', reason: 'No TMDB show + IMDb id in the anime map' },
  ]);
  return { p, buildOld, buildNew };
}

(async () => {
  console.log('anime-decisions-report:');

  const { p: mainP, buildOld, buildNew } = seedTwoBuilds('AN1B3-main');
  // A profile with the engine off (R1).
  const offP = config.addProfile('AN1B3-off');
  config.updateProfile(offP.id, { filters: { engine_anime: 'off' } });
  // A profile with the engine on but no builds (R2, B5).
  const noBuildP = config.addProfile('AN1B3-nobuild');
  config.updateProfile(noBuildP.id, { filters: { engine_anime: 'marquee-anime', age_limit: 14 } });
  // A profile with a single build (R6 no_previous).
  const singleP = config.addProfile('AN1B3-single');
  config.updateProfile(singleP.id, { filters: { engine_anime: 'marquee-anime', age_limit: 14 } });
  const singleBuild = decisionLog.newBuildId();
  decisionLog.record(singleP.id, 'anime', singleBuild, [
    { item_key: 'S', stage: 'engine', outcome: 'selected', title: 'Solo', year: 2020, source: 'simkl', reason: 'Trending anime' },
  ]);

  // Start the server + admin session (same pattern as anime-lane.js).
  require('../src/server');
  const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
  const { token } = provisionAdmin();
  const rawFetch = global.fetch; // captured before attachCookie wraps it (for R9).
  const restore = attachCookie(BASE, cookieHeader(token));
  await new Promise((r) => setTimeout(r, 200)); // let the server finish listening.

  // Authenticated GET helper (global.fetch is wrapped to add the admin cookie).
  async function get(path) {
    const res = await fetch(BASE + path);
    return { status: res.status, body: await res.json() };
  }

  // R8: capture the row count before the API tests.
  const db = require('../src/db');
  const countRows = (pid) => db.get().prepare('SELECT COUNT(*) AS n FROM lane_decisions WHERE profile_id = ?').get(pid).n;
  const countBefore = countRows(mainP.id);

  // ---- R1: engine off → 404; unknown profile → 404 ----
  await ok('R1: engine off → 404 Anime engine is off; unknown profile → 404', async () => {
    const r1 = await get(`/api/profiles/${offP.id}/anime/decisions`);
    assert.strictEqual(r1.status, 404, 'engine off → 404');
    assert.strictEqual(r1.body.error, 'Anime engine is off', 'engine off error');
    const r2 = await get('/api/profiles/does-not-exist/anime/decisions');
    assert.strictEqual(r2.status, 404, 'unknown profile → 404');
    assert.strictEqual(r2.body.error, 'Profile not found', 'unknown profile error');
  });

  // ---- R2: no builds → 200 with zero counts, rows: [], build_id: null ----
  await ok('R2: no builds → 200 zero counts, rows [], build_id null', async () => {
    const r = await get(`/api/profiles/${noBuildP.id}/anime/decisions`);
    assert.strictEqual(r.status, 200, '200');
    assert.strictEqual(r.body.build_id, null, 'build_id null');
    assert.deepStrictEqual(r.body.counts, { selected: 0, rejected_age: 0, rejected_llm: 0, filtered: 0 }, 'zero counts');
    assert.deepStrictEqual(r.body.rows, [], 'rows []');
    assert.strictEqual(r.body.total, 0, 'total 0');
  });

  // ---- R3: default (newest) — right rows, order, counts, tier, mode, page_size ----
  await ok('R3: default (newest) — rows, order, counts, tier, mode, page_size', async () => {
    const r = await get(`/api/profiles/${mainP.id}/anime/decisions`);
    assert.strictEqual(r.status, 200, '200');
    assert.strictEqual(r.body.build_id, buildNew, 'newest build');
    assert.deepStrictEqual(r.body.counts, { selected: 3, rejected_age: 2, rejected_llm: 1, filtered: 2 }, 'counts exact');
    assert.strictEqual(r.body.tier, 'TV-14 (14+, AU M)', 'tier label');
    assert.strictEqual(r.body.mode, 'trending', 'mode');
    assert.strictEqual(r.body.page_size, 25, 'page_size');
    assert.strictEqual(r.body.total, 8, 'total 8');
    // Order: outcome groups (selected → rejected_age → rejected_llm → filtered), title asc within.
    assert.deepStrictEqual(r.body.rows.map((x) => x.title),
      ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'], 'order');
    const alpha = r.body.rows.find((x) => x.title === 'Alpha');
    assert.strictEqual(alpha.outcome, 'selected', 'Alpha outcome');
    assert.strictEqual(alpha.mal_rating, 7.5, 'Alpha mal_rating');
    assert.strictEqual(alpha.reason, 'Trending anime', 'Alpha reason');
  });

  // ---- R4: outcome=rejected_age and q= filter correctly; both together ----
  await ok('R4: outcome + q filters', async () => {
    const r1 = await get(`/api/profiles/${mainP.id}/anime/decisions?outcome=rejected_age`);
    assert.strictEqual(r1.status, 200, '200');
    assert.deepStrictEqual(r1.body.rows.map((x) => x.title), ['Delta', 'Echo'], 'rejected_age rows');
    const r2 = await get(`/api/profiles/${mainP.id}/anime/decisions?q=echo`);
    assert.deepStrictEqual(r2.body.rows.map((x) => x.title), ['Echo'], 'q case-insensitive');
    const r3 = await get(`/api/profiles/${mainP.id}/anime/decisions?outcome=rejected_age&q=echo`);
    assert.deepStrictEqual(r3.body.rows.map((x) => x.title), ['Echo'], 'both together');
  });

  // ---- R5: paging — seed 60 filtered rows in one build ----
  await ok('R5: paging — 60 filtered rows', async () => {
    const p = config.addProfile('AN1B3-paging');
    try {
      config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime' } });
      const bid = decisionLog.newBuildId();
      const rows = [];
      for (let i = 1; i <= 60; i++) {
        rows.push({ item_key: `f${i}`, stage: 'pool-cap', outcome: 'filtered', title: `Filtered ${String(i).padStart(2, '0')}`, source: 'simkl', reason: 'Below the pool cut-off' });
      }
      decisionLog.record(p.id, 'anime', bid, rows);
      const r1 = await get(`/api/profiles/${p.id}/anime/decisions?page=2`);
      assert.strictEqual(r1.body.rows.length, 25, 'page 2 has 25');
      const r2 = await get(`/api/profiles/${p.id}/anime/decisions?page=3`);
      assert.strictEqual(r2.body.rows.length, 10, 'page 3 has 10');
      const r3 = await get(`/api/profiles/${p.id}/anime/decisions?page=99`);
      assert.strictEqual(r3.body.page, 3, 'page 99 clamps to 3');
      assert.strictEqual(r3.body.rows.length, 10, 'clamped page has 10');
      assert.strictEqual(r3.body.pages, 3, 'pages 3');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ---- R6: diff=1 — added +, removed -, shared in neither, q narrows, no_previous ----
  await ok('R6: diff=1 — added +, removed -, shared in neither, q narrows, no_previous', async () => {
    const r = await get(`/api/profiles/${mainP.id}/anime/decisions?diff=1`);
    assert.strictEqual(r.status, 200, '200');
    const added = r.body.rows.filter((x) => x.delta === '+');
    const removed = r.body.rows.filter((x) => x.delta === '-');
    assert.deepStrictEqual(added.map((x) => x.title), ['Bravo', 'Charlie'], 'added +');
    assert.deepStrictEqual(removed.map((x) => x.title), ['X-ray', 'Yankee'], 'removed -');
    assert.ok(!r.body.rows.some((x) => x.title === 'Alpha'), 'shared Alpha in neither');
    const rq = await get(`/api/profiles/${mainP.id}/anime/decisions?diff=1&q=bravo`);
    assert.deepStrictEqual(rq.body.rows.map((x) => x.title), ['Bravo'], 'q narrows');
    const rs = await get(`/api/profiles/${singleP.id}/anime/decisions?diff=1`);
    assert.strictEqual(rs.body.no_previous, true, 'no_previous');
    assert.deepStrictEqual(rs.body.rows, [], 'no rows');
  });

  // ---- R7: build= an older id works; a bogus id → 404 Unknown build ----
  await ok('R7: build= older id works; bogus → 404 Unknown build', async () => {
    const r = await get(`/api/profiles/${mainP.id}/anime/decisions?build=${buildOld}`);
    assert.strictEqual(r.status, 200, '200');
    assert.strictEqual(r.body.build_id, buildOld, 'older build');
    assert.deepStrictEqual(r.body.rows.map((x) => x.title), ['Alpha', 'X-ray', 'Yankee'], 'older build rows');
    const rb = await get(`/api/profiles/${mainP.id}/anime/decisions?build=999999999999999`);
    assert.strictEqual(rb.status, 404, 'bogus build → 404');
    assert.strictEqual(rb.body.error, 'Unknown build', 'Unknown build error');
  });

  // ---- R8: read-only — row counts identical before and after R1-R7 ----
  await ok('R8: read-only — row counts identical', async () => {
    const countAfter = countRows(mainP.id);
    assert.strictEqual(countAfter, countBefore, 'row count unchanged');
  });

  // ---- R9: unauthenticated → the existing admin-guard rejection ----
  await ok('R9: unauthenticated → 401 admin-guard rejection', async () => {
    const res = await rawFetch(`${BASE}/api/profiles/${mainP.id}/anime/decisions`);
    assert.strictEqual(res.status, 401, '401');
    const body = await res.json();
    assert.strictEqual(body.auth, 'signin', 'auth signin');
    assert.ok(body.error, 'error present');
  });

  // ---- CLI C1-C5 ----
  console.log('anime-decisions-report cli:');

  function runCli(args) {
    return spawnSync('node', ['--experimental-sqlite', 'scripts/anime-decisions.js', ...args], {
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: process.env.DATA_DIR },
    });
  }

  // ---- C1: header line counts and a selected row line, by profile name (case-insensitive) ----
  await ok('C1: header counts + a selected row line, by name (case-insensitive)', async () => {
    const r = runCli(['an1b3-main']);
    assert.strictEqual(r.status, 0, 'exit 0');
    const lines = r.stdout.split('\n');
    const header = lines[0];
    assert.ok(header.includes('AN1B3-main'), 'header has profile name: ' + header);
    assert.ok(header.includes('selected 3'), 'header selected 3: ' + header);
    assert.ok(header.includes('rejected_age 2'), 'header rejected_age 2: ' + header);
    assert.ok(header.includes('rejected_llm 1'), 'header rejected_llm 1: ' + header);
    assert.ok(header.includes('filtered 2'), 'header filtered 2: ' + header);
    const selectedLine = lines.find((l) => l.startsWith('selected Alpha'));
    assert.ok(selectedLine, 'a selected row line: ' + lines.join(' | '));
  });

  // ---- C2: --outcome rejected_age --json parses and has exactly the seeded 2 rows ----
  await ok('C2: --outcome rejected_age --json → exactly 2 rows', async () => {
    const r = runCli(['AN1B3-main', '--outcome', 'rejected_age', '--json']);
    assert.strictEqual(r.status, 0, 'exit 0');
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.rows.length, 2, '2 rows');
    assert.deepStrictEqual(data.rows.map((x) => x.title).sort(), ['Delta', 'Echo'], 'Delta + Echo');
  });

  // ---- C3: --diff lines start with +/− and match R6 ----
  await ok('C3: --diff lines start with +/- and match R6', async () => {
    const r = runCli(['AN1B3-main', '--diff']);
    assert.strictEqual(r.status, 0, 'exit 0');
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));
    assert.ok(lines.length > 0, 'diff lines present');
    const plus = lines.filter((l) => l.startsWith('+'));
    const minus = lines.filter((l) => l.startsWith('-'));
    assert.deepStrictEqual(plus.map((l) => l.split(' ')[1]), ['Bravo', 'Charlie'], 'added');
    assert.deepStrictEqual(minus.map((l) => l.split(' ')[1]), ['X-ray', 'Yankee'], 'removed');
  });

  // ---- C4: unknown profile → exit 1, stderr contains Profile not found ----
  await ok('C4: unknown profile → exit 1, Profile not found', async () => {
    const r = runCli(['no-such-profile']);
    assert.strictEqual(r.status, 1, 'exit 1');
    assert.ok(r.stderr.includes('Profile not found'), 'stderr: ' + r.stderr);
  });

  // ---- C5: fresh DATA_DIR with no lane_decisions table → exit 0, no table created ----
  await ok('C5: fresh DATA_DIR, no lane_decisions → exit 0, no table created', async () => {
    const freshDir = os.tmpdir() + '/ai-rec-an1b3-fresh-' + Date.now();
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, 'profiles.json'), JSON.stringify({
      profiles: [{
        id: 'fresh1', name: 'Fresh Profile', token: 'freshtoken', email: '',
        is_admin: true, created_at: Date.now(), keys: {}, filters: { engine_anime: 'marquee-anime' },
      }],
    }));
    const r = spawnSync('node', ['--experimental-sqlite', 'scripts/anime-decisions.js', 'Fresh Profile'], {
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: freshDir },
    });
    assert.strictEqual(r.status, 0, 'exit 0');
    assert.ok(r.stdout.includes('No anime builds recorded'), 'stdout: ' + r.stdout);
    // The table must not have been created.
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(path.join(freshDir, 'store.db'));
    const table = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lane_decisions'").get();
    conn.close();
    assert.strictEqual(table, undefined, 'lane_decisions not created');
  });

  // ---- Browser B1-B6 (only with --browser) ----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const screenshotDir = path.join(process.env.DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
    const pageErrors = [];
    const adminCookie = { name: 'air_sid', value: token, url: BASE };

    // Set TMDB + Groq keys so the portal leaves setup mode (as anime-lane.js does).
    settings.updateSettings({ keys: { tmdb_api_key: 'x'.repeat(32) }, llm: { groq_api_key: 'gsk_test' } });

    // Select a profile in the portal's dropdown and open its Advanced tab.
    async function openAdvanced(page, profileId) {
      await page.goto(`${BASE}/configure/`);
      await page.waitForSelector('#userSelect');
      await page.selectOption('#userSelect', profileId);
      await page.waitForSelector('.card[data-id]');
      await page.locator('.tab-btn[data-tab="advanced"]').click();
    }

    // ---- B1: engine on, with seeded builds — panel visible, header, Selected chip 3, three rows ----
    await ok('B1: panel visible, header tier + Trending, Selected chip 3, three rows', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, mainP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      const head = await page.locator('.ab-panel .ab-head').innerText();
      assert.ok(head.includes('TV-14 (14+, AU M)'), 'header tier: ' + head);
      assert.ok(head.includes('Trending'), 'header Trending: ' + head);
      const selectedChip = await page.locator('.ab-panel .tr-chip[data-outcome="selected"]').innerText();
      assert.ok(selectedChip.includes('3'), 'Selected chip 3: ' + selectedChip);
      const rowCount = await page.locator('.ab-panel .tr-table .tr-row').count();
      assert.strictEqual(rowCount, 3, 'three rows');
      await page.locator('.sec-box:has(.ab-panel)').first().screenshot({ path: path.join(screenshotDir, 'anime-report-b1.png') });
      await context.close();
    });

    // ---- B2: click Rejected · age rating → two err rows; search narrows ----
    await ok('B2: Rejected · age rating → 2 err rows; search narrows', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, mainP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      await page.locator('.ab-panel .tr-chip[data-outcome="rejected_age"]').click();
      await page.waitForSelector('.ab-panel .tr-table .tr-row', { timeout: 10000 });
      const errBadges = await page.locator('.ab-panel .tr-table .badge.err').count();
      assert.strictEqual(errBadges, 2, 'two err badges');
      await page.locator('.ab-panel .tr-search').fill('Echo');
      await page.waitForTimeout(600); // debounce (300ms) + fetch
      const rows = await page.locator('.ab-panel .tr-table .tr-row').count();
      assert.strictEqual(rows, 1, 'rows narrowed to 1');
      await context.close();
    });

    // ---- B3: click Compare → +/- rows, chips hidden, label changes; click again returns ----
    await ok('B3: Compare → +/- rows, chips hidden, label changes; click again returns', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, mainP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      await page.locator('.ab-panel [data-act="ab-diff"]').click();
      await page.waitForSelector('.ab-panel .tr-table .tr-row', { timeout: 10000 });
      const rowCount = await page.locator('.ab-panel .tr-table .tr-row').count();
      assert.strictEqual(rowCount, 4, '4 diff rows');
      const chips = await page.locator('.ab-panel .ab-outcomes').count();
      assert.strictEqual(chips, 0, 'chips hidden');
      const diffBtn = await page.locator('.ab-panel [data-act="ab-diff"]').innerText();
      assert.ok(diffBtn.includes('Back to the latest build'), 'label: ' + diffBtn);
      await page.locator('.ab-panel [data-act="ab-diff"]').click();
      await page.waitForSelector('.ab-panel .ab-outcomes', { timeout: 10000 });
      const chipsBack = await page.locator('.ab-panel .ab-outcomes').count();
      assert.strictEqual(chipsBack, 1, 'chips back');
      await context.close();
    });

    // ---- B4: profile with engine off → no Anime build report title in the DOM ----
    await ok('B4: engine off → no Anime build report title', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, offP.id);
      await page.waitForTimeout(500);
      const titles = await page.locator('.sec-title').allInnerTexts();
      assert.ok(!titles.some((t) => t.includes('Anime build report')), 'no Anime build report title');
      await context.close();
    });

    // ---- B5: engine on but no builds → empty message shows, table hidden ----
    await ok('B5: engine on, no builds → empty message, table hidden', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, noBuildP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      const head = await page.locator('.ab-panel .ab-head').innerText();
      assert.ok(head.includes('No anime build recorded yet'), 'empty message: ' + head);
      const tableCount = await page.locator('.ab-panel .tr-table').count();
      assert.strictEqual(tableCount, 0, 'table hidden');
      await context.close();
    });

    // ---- B6: 400 px viewport — no horizontal page scroll; screenshot the panel ----
    await ok('B6: 400px viewport — no horizontal scroll', async () => {
      const context = await browser.newContext({ viewport: { width: 400, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await openAdvanced(page, mainP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const innerWidth = await page.evaluate(() => window.innerWidth);
      assert.ok(scrollWidth <= innerWidth, `scrollWidth ${scrollWidth} <= innerWidth ${innerWidth}`);
      await page.locator('.sec-box:has(.ab-panel)').first().screenshot({ path: path.join(screenshotDir, 'anime-report-b6.png') });
      await context.close();
    });

    // ---- B8: the panel's Rebuild recommendations shows its progress IN the panel, and keeps the result ----
    await ok('B8: Rebuild recommendations — progress and result are shown in the panel', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      let polls = 0;
      const steps = [
        { state: 'running', pct: 10, label: 'Reading history' },
        { state: 'running', pct: 40, label: 'Age-gating the pool' },
        { state: 'running', pct: 75, label: 'Reviewing borderline titles' },
        { state: 'done', pct: 100, result: { stored: 25, seeds: 12 } },
      ];
      await page.route('**/api/profiles/*/recommend/build', (r) => r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ started: true }) }));
      await page.route('**/api/profiles/*/job', (r) => {
        polls++;
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job: steps[Math.min(polls - 1, 3)] }) });
      });
      await openAdvanced(page, mainP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      await page.locator('.ab-panel [data-act="ab-rebuild"]').click();
      const seen = new Set();
      for (let i = 0; i < 16; i++) {
        seen.add(await page.locator('.ab-panel [data-tres="ab"]').innerText().catch(() => ''));
        await page.waitForTimeout(400);
      }
      const all = [...seen].join(' | ');
      assert.ok(all.includes('Reading history — 10%'), 'shows 10%: ' + all);
      assert.ok(all.includes('Age-gating the pool — 40%'), 'shows 40%: ' + all);
      assert.ok(all.includes('Reviewing borderline titles — 75%'), 'shows 75%: ' + all);
      const final = await page.locator('.ab-panel [data-tres="ab"]').innerText();
      assert.ok(final.includes('25 recommendations from 12 watched seed(s)'), 'result stays after the report reloads: ' + final);
      assert.ok(await page.locator('.ab-panel [data-act="ab-rebuild"]').isEnabled(), 'button usable again');
      await page.locator('.sec-box:has(.ab-panel)').first().screenshot({ path: path.join(screenshotDir, 'anime-report-b8.png') });
      await context.close();
    });

    // ---- B9: button labels say what they do; "Refresh extra catalogs" shows its progress and result ----
    await ok('B9: labels — Refresh extra catalogs / Rebuild recommendations; Refresh shows progress', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      let polls = 0;
      const steps = [
        { state: 'queued' },
        { state: 'running', pct: 40 },
        { state: 'running', pct: 80 },
        { state: 'done', pct: 100, result: { 'trakt-anime-teen-series': { ok: true, count: 30 } } },
      ];
      await page.route('**/api/profiles/*/rebuild', (r) => r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ started: true }) }));
      await page.route('**/api/profiles/*/job', (r) => {
        polls++;
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job: steps[Math.min(polls - 1, 3)] }) });
      });
      await openAdvanced(page, mainP.id);
      await page.waitForSelector('.ab-panel .ab-head', { timeout: 10000 });
      const refreshBtn = page.locator('.btn-rebuild').first();
      assert.strictEqual((await refreshBtn.innerText()).trim(), 'Refresh extra catalogs');
      const rebuildBtns = await page.locator('button[onclick^="buildRecs"]').allInnerTexts();
      assert.deepStrictEqual(rebuildBtns.map((x) => x.trim()), ['Rebuild recommendations']);
      assert.strictEqual((await page.locator('.ab-panel [data-act="ab-rebuild"]').innerText()).trim(), 'Rebuild recommendations');
      const body = await page.locator('body').innerText();
      assert.ok(!body.includes('Rebuild now'), 'no "Rebuild now" label left on the Advanced tab');
      // The test profile has no Simkl connection, so the button starts disabled; enable it to drive the flow.
      await refreshBtn.evaluate((el) => { el.disabled = false; });
      await refreshBtn.click();
      const seen = new Set();
      for (let i = 0; i < 16; i++) { seen.add((await refreshBtn.innerText()).trim()); await page.waitForTimeout(400); }
      const all = [...seen].join(' | ');
      assert.ok(all.includes('Queued…'), 'queued: ' + all);
      assert.ok(all.includes('Refreshing 40%'), '40%: ' + all);
      assert.ok(all.includes('Refreshing 80%'), '80%: ' + all);
      assert.ok(all.includes('✓ Refreshed'), 'done stays visible on the button: ' + all);
      const resultLine = await page.locator('[data-tres="extras"]').first().innerText();
      assert.ok(resultLine.includes('trakt-anime-teen-series: 30 titles ✓'), 'result line stays beside the button: ' + resultLine);
      await page.locator('.sec-box:has(.btn-rebuild)').first().screenshot({ path: path.join(screenshotDir, 'anime-report-b9.png') });
      await context.close();
    });

    // ---- No page errors on any page ----
    await ok('B7: no page errors', async () => {
      assert.deepStrictEqual(pageErrors, [], 'no page errors');
    });

    await browser.close();
  }

  console.log(`\nAll anime decision report checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
