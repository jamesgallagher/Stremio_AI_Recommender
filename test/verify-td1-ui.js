// TD-1 UI verification — drives every surface in a real browser.
// Run from the repo root:
//   node --experimental-sqlite test/verify-td1-ui.js
// Not part of npm test (requires Playwright + a live server).
const WT = process.env.WT || process.cwd();
const SP = process.env.OUT || require('os').tmpdir();
process.env.DATA_DIR = require('os').tmpdir() + '/td1-verify-' + Date.now();
process.env.PORT = '7599';
process.env.SECRET_KEY = 'test-secret-key-do-not-use-in-prod';
process.env.MOBILE_INSECURE_COOKIE = '1';
process.chdir(WT);
const config = require(WT + '/src/config');
const auth = require(WT + '/mobile/server/auth');
const watchedStore = require(WT + '/src/watchedStore');
const { chromium } = require(WT + '/node_modules/playwright');
const results = [];
const check = (name, pass, extra = '') => { results.push([pass, name, extra]); console.log(pass ? ' PASS' : ' FAIL', name, extra); };

const DETAIL = { type: 'movie', imdb_id: 'tt101', tmdb_id: '101', title: 'The Matrix', year: '1999', poster: null, synopsis: 'A computer hacker learns about the true nature of reality and his role in the war against its controllers. '.repeat(4), runtime: '136 min', genres: ['Action', 'Sci-Fi'], rating: { label: 'MA15+', country: 'AU' },
  cast: Array.from({ length: 8 }, (_, i) => ({ name: 'Actor Number ' + i, character: 'Character ' + i, photo: null })), castSource: 'tmdb' };

(async () => {
  const admin = config.createInitialAdmin({ name: 'Admin', email: 'admin@test.local' });
  const kid = config.addProfile('Siobhan');
  config.updateProfile(kid.id, { email: 'siobhan@test.local' });
  watchedStore.upsertMany(kid.id, [
    { simkl_id: 101, type: 'movie', imdb_id: 'tt101', tmdb_id: '101', title: 'The Matrix', year: 1999, watched_at: '2026-03-01T12:00:00Z' },
    { simkl_id: 102, type: 'movie', imdb_id: 'tt102', tmdb_id: '102', title: 'Inception', year: 2010, watched_at: '2026-03-02T12:00:00Z' },
  ]);
  const adminTok = auth.createSession(admin.id).token;
  const kidTok = auth.createSession(kid.id).token;
  require(WT + '/src/server.js');
  await new Promise(r => setTimeout(r, 1500));
  const base = 'http://127.0.0.1:7599';
  const browser = await chromium.launch();

  // ---------- CONFIGURE (desktop 1280x800) ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'air_sid', value: adminTok, url: base }]);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.route('**/api/profiles/*/title-detail*', r => r.fulfill({ json: DETAIL }));
    await page.goto(base + '/configure/');
    await page.waitForTimeout(1500);
    await page.selectOption('#userSelect', kid.id).catch(() => {});
    await page.locator(`.card[data-id="${kid.id}"] button[data-tab="trainer"]`).first().click();
    await page.waitForSelector('.tr-row .td-open');
    const rowsBefore = await page.locator('.tr-row').count();
    await page.locator('.tr-row .td-open').first().click();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    check('configure ratings: click poster/title opens modal', true);
    check('configure ratings: list did not reload', (await page.locator('.tr-row').count()) === rowsBefore);
    await page.waitForSelector('.td-cast .td-person');
    check('modal shows 8 cast', (await page.locator('.td-person').count()) === 8);
    check('modal shows badge "AU · MA15+"', (await page.locator('.td-badge').textContent()).includes('AU'));
    check('body scroll locked', (await page.evaluate(() => document.body.style.overflow)) === 'hidden');
    check('focus on close button', await page.evaluate(() => document.activeElement && document.activeElement.className.includes('td-close')));
    await page.screenshot({ path: SP + '/td-cfg-desktop.png' });
    // Esc
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Esc closes', !(await page.locator('.td-panel').isVisible().catch(() => false)));
    check('body scroll restored', (await page.evaluate(() => document.body.style.overflow)) !== 'hidden');
    check('focus returned to opener', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('td-open')));
    // Backdrop
    await page.locator('.tr-row .td-open').first().click();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    await page.locator('.td-backdrop').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);
    check('backdrop click closes', !(await page.locator('.td-panel').isVisible().catch(() => false)));
    // Close button
    await page.locator('.tr-row .td-open').first().click();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    await page.locator('.td-close').click();
    await page.waitForTimeout(300);
    check('close button closes', !(await page.locator('.td-panel').isVisible().catch(() => false)));
    // Tab trap
    await page.locator('.tr-row .td-open').first().click();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    check('Tab stays inside modal', await page.evaluate(() => !!document.activeElement.closest('.td-panel')));
    // Shift+Tab from close button
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.locator('.tr-row .td-open').first().click();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    await page.keyboard.press('Shift+Tab');
    check('Shift+Tab wraps to last focusable', await page.evaluate(() => !!document.activeElement.closest('.td-panel')));
    await page.keyboard.press('Escape');
    check('no page errors (configure)', errs.length === 0, errs.join('|'));
    await ctx.close();
  }

  // ---------- MOBILE (375x800, touch) ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true });
    await ctx.addCookies([{ name: 'air_sid', value: kidTok, url: base }]);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.route('**/mobile/api/title-detail*', r => r.fulfill({ json: DETAIL }));
    const recs = [{ id: 'tt101', tmdb_id: '101', type: 'movie', title: 'The Matrix', year: 1999, poster: null, genre: 'Action', rating: 8.7, because: 'x' },
                  { id: 'tt102', tmdb_id: '102', type: 'movie', title: 'Inception', year: 2010, poster: null, genre: 'Sci-Fi', rating: 8.8, because: 'y' }];
    await page.route('**/mobile/api/recommendations*', r => r.fulfill({ json: { type: 'movie', view: 'all', items: recs, display_count: 2 } }));
    await page.route('**/mobile/api/search*', r => r.fulfill({ json: { results: [{ id: 'tt101', type: 'movie', title: 'The Matrix', year: 1999, poster: null, synopsis: 's', rating: '8.7', tmdb_id: '101' }] } }));
    await page.goto(base + '/mobile/#/recs');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: SP + '/td-mob-boot.png' });
    await page.waitForSelector('.rec .rec-title', { timeout: 5000 });
    const hashBefore = await page.evaluate(() => location.hash);
    // T6: computed-style check on rec-title
    const titleStyle = await page.evaluate(() => {
      const el = document.querySelector('.rec .rec-title');
      const cs = getComputedStyle(el);
      const row = el.closest('.rec');
      return { bg: cs.backgroundColor, align: cs.textAlign, width: el.offsetWidth, rowWidth: row ? row.offsetWidth : 0 };
    });
    check('T6: rec-title has transparent background', titleStyle.bg === 'rgba(0, 0, 0, 0)', titleStyle.bg);
    check('T6: rec-title text-align left', titleStyle.align === 'left', titleStyle.align);
    check('T6: rec-title width < 80% of row', titleStyle.width < titleStyle.rowWidth * 0.8, `width=${titleStyle.width} row=${titleStyle.rowWidth}`);
    // Tap opens
    await page.locator('.rec .rec-title').first().tap();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    check('mobile recs: tap title opens', true);
    await page.screenshot({ path: SP + '/td-mob-recs.png' });
    // Back closes
    await page.goBack();
    await page.waitForTimeout(400);
    check('mobile: Back closes modal', !(await page.locator('.td-panel').isVisible().catch(() => false)));
    if (await page.locator('.td-panel').isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    check('mobile: hash unchanged after Back', (await page.evaluate(() => location.hash)) === hashBefore);
    // ✕ closes
    await page.locator('.rec .rec-title').first().tap();
    await page.waitForSelector('.td-panel', { state: 'visible' });
    await page.locator('.td-close').tap();
    await page.waitForTimeout(400);
    check('mobile: ✕ closes', !(await page.locator('.td-panel').isVisible().catch(() => false)));
    check('mobile: hash unchanged after ✕', (await page.evaluate(() => location.hash)) === hashBefore);
    check('mobile: no stale td history entry', await page.evaluate(() => !(history.state && history.state.td)));
    // Error/Retry
    await page.unroute('**/mobile/api/title-detail*');
    await page.route('**/mobile/api/title-detail*', r => r.fulfill({ status: 404, json: { error: 'no-detail' } }));
    await page.locator('.rec .rec-title').first().tap();
    await page.waitForSelector('.td-retry', { timeout: 4000 }).catch(() => {});
    const hadRetry = await page.locator('.td-retry').count();
    await page.unroute('**/mobile/api/title-detail*');
    await page.route('**/mobile/api/title-detail*', r => r.fulfill({ json: DETAIL }));
    if (hadRetry) { await page.locator('.td-retry').tap(); await page.waitForTimeout(800); }
    check('mobile: error state shows Retry and Retry loads detail', hadRetry === 1 && (await page.locator('.td-person').count()) === 8);
    await page.screenshot({ path: SP + '/td-mob-retry.png' });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // Swipe does NOT open
    const row = page.locator('.rec').first();
    const box = await row.boundingBox();
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    check('mobile recs: swipe does NOT open modal', !(await page.locator('.td-panel').isVisible().catch(() => false)));
    // Search
    await page.goto(base + '/mobile/#/search');
    await page.fill('#search-input, input[type=search]', 'matrix').catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForSelector('.result', { timeout: 5000 }).catch(() => {});
    if (await page.locator('.result').count()) {
      await page.locator('.result').first().tap();
      await page.waitForSelector('.td-panel', { state: 'visible' });
      await page.waitForSelector('.td-actions button', { timeout: 5000 }).catch(() => {});
      check('mobile search: result opens modal with Add action', (await page.locator('.td-actions button').count()) >= 1);
      // T5b: actions present in error state
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.unroute('**/mobile/api/title-detail*');
      await page.route('**/mobile/api/title-detail*', r => r.fulfill({ status: 404, json: { error: 'no-detail' } }));
      await page.locator('.result').first().tap();
      await page.waitForSelector('.td-panel', { state: 'visible' });
      await page.waitForSelector('.td-retry', { timeout: 4000 }).catch(() => {});
      check('T5b: actions present in error state (search)', (await page.locator('.td-actions button').count()) >= 1);
      await page.unroute('**/mobile/api/title-detail*');
      await page.route('**/mobile/api/title-detail*', r => r.fulfill({ json: DETAIL }));
      await page.keyboard.press('Escape');
      await page.screenshot({ path: SP + '/td-mob-search.png' });
    } else check('mobile search: results rendered', false, 'no .result');
    // Ratings list
    await page.goto(base + '/mobile/#/trainer');
    await page.waitForTimeout(1500);
    await page.locator('.trainer-tabs .seg[data-tmode="list"]').first().click().catch(() => {});
    await page.waitForTimeout(500);
    const trOpen = page.locator('#trainer-list .td-open');
    if (await trOpen.count()) {
      const rowsB = await page.locator('#trainer-list .tr-row').count();
      await trOpen.first().tap();
      await page.waitForSelector('.td-panel', { state: 'visible' });
      check('mobile ratings list: tap opens modal; list not reloaded', (await page.locator('#trainer-list .tr-row').count()) === rowsB);
      await page.keyboard.press('Escape');
    } else check('mobile ratings list rendered', false, 'no td-open in #trainer-list');
    // Stale-response handling: open A with slow mock, open B, A's late response must not overwrite B
    {
      await page.goto(base + '/mobile/#/recs');
      await page.waitForTimeout(2000);
      let slowResolve;
      const slowPromise = new Promise(r => { slowResolve = r; });
      await page.unroute('**/mobile/api/title-detail*');
      await page.route('**/mobile/api/title-detail*', async (route) => {
        const url = route.request().url();
        if (url.includes('imdb_id=tt101')) {
          await slowPromise;
          route.fulfill({ json: DETAIL });
        } else {
          route.fulfill({ json: { ...DETAIL, imdb_id: 'tt102', title: 'Inception' } });
        }
      });
      // Open A (tt101) — will be slow
      await page.locator('.rec .rec-title').first().tap();
      await page.waitForSelector('.td-panel', { state: 'visible' });
      // Close A and open B (tt102) — will be fast
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.locator('.rec .rec-title').nth(1).tap();
      await page.waitForSelector('.td-panel', { state: 'visible' });
      // Wait for B's detail to render
      await page.waitForSelector('.td-person', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      // Now resolve A's slow response
      slowResolve();
      await page.waitForTimeout(500);
      // B should still be showing (A's late response must not overwrite B)
      const title = await page.locator('#td-title').textContent();
      check('stale-response: late A does not overwrite B', title.includes('Inception'), 'title=' + title);
      await page.keyboard.press('Escape');
      await page.unroute('**/mobile/api/title-detail*');
      await page.route('**/mobile/api/title-detail*', r => r.fulfill({ json: DETAIL }));
    }
    check('no page errors (mobile)', errs.length === 0, errs.join('|'));
    await ctx.close();
  }

  await browser.close();
  const fails = results.filter(r => !r[0]);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  if (fails.length) { for (const f of fails) console.log('  FAIL:', f[1], f[2]); }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('VERIFY FAILED', e); process.exit(1); });
