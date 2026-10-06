// Real AIR HTTP routes; only provider HTTP is faked. No live credentials/data.
// Optional --browser requires Playwright on NODE_PATH (no production dependency).
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.AIR_SIMKL_TEST_CHILD) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'air-simkl-lifecycle-'));
  try {
    const result = require('child_process').spawnSync(process.execPath,
      ['--experimental-sqlite', __filename, ...process.argv.slice(2)], {
        stdio: 'inherit', env: { ...process.env, AIR_SIMKL_TEST_CHILD: '1', DATA_DIR: data,
          PORT: '0', ADMIN_USER: 'review', ADMIN_PASSWORD: 'review', SECRET_KEY: 'fake-test-key',
          EXTERNAL_URL: 'https://example.test' },
      });
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
} else {
  run().catch(err => { console.error(err); process.exitCode = 1; });
}

async function run() {
  const config = require('../src/config');
  const simkl = require('../src/services/simkl');
  const flows = require('../src/services/simklConnectionFlow');
  const nativeFetch = global.fetch;
  const timeout = global.setTimeout, interval = global.setInterval;
  const timers = [];
  // Suppress only the production boot/hourly scheduler in this fake-data server.
  global.setTimeout = (fn, ms, ...args) => {
    const t = timeout(fn, ms, ...args); if (ms === 15000) { clearTimeout(t); } return t;
  };
  global.setInterval = (fn, ms, ...args) => {
    const t = interval(fn, ms, ...args); timers.push(t); if (ms === 3600000) clearInterval(t); return t;
  };
  const http = require('http'), listen = http.Server.prototype.listen;
  let server, browser, provider = normalProvider;
  const requests = [];
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  function normalProvider(url, opts = {}) {
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(opts.body);
      const code = form.get('code') || 'refreshed';
      return response({ access_token: 'token-' + code, refresh_token: 'refresh-' + code,
        expires_in: 3600, scope: 'media:read media:write' });
    }
    if (url.pathname === '/users/settings') return response({ user: { id: opts.headers.Authorization.includes('wrong') ? 999 : 123, name: 'Fake User' } });
    if (url.pathname === '/oauth2/revoke' || url.pathname === '/sync/activities') return response({});
    if (url.pathname === '/oauth/pin') return response({ user_code: 'FAKE-PIN', expires_in: 900, interval: 5 });
    if (url.pathname.startsWith('/oauth/pin/')) return response({ result: 'OK', access_token: 'pin-token' });
    throw new Error('Unexpected provider path ' + url.pathname);
  }
  global.fetch = (url, opts) => {
    const u = new URL(String(url));
    if (u.hostname === 'api.simkl.com') { requests.push({ path: u.pathname, opts }); return Promise.resolve(provider(u, opts)); }
    if (u.hostname === '127.0.0.1') return nativeFetch(url, opts);
    throw new Error('External network forbidden in lifecycle test: ' + u.hostname);
  };
  http.Server.prototype.listen = function (...args) { server = this; return listen.apply(this, args); };
  require('../src/server');
  global.setTimeout = timeout;
  http.Server.prototype.listen = listen;
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = { Authorization: 'Basic ' + Buffer.from('review:review').toString('base64'), 'Content-Type': 'application/json' };
  const route = (url, opts = {}) => nativeFetch(base + url, { ...opts, headers: auth, signal: AbortSignal.timeout(25000) });
  const api = async (id, suffix, method = 'GET', body) => {
    const r = await route('/api/profiles/' + id + suffix, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...await r.json() };
  };
  const add = (name, old = true, version = 2) => {
    const p = config.addProfile(name);
    config.updateProfile(p.id, { simkl_auth_version: version,
      keys: { simkl_client_id: 'fake-v1', simkl_v2_client_id: 'fake-v2', simkl_v2_client_secret: 'fake-secret' },
      simkl_auth: old ? { access_token: 'old-v1', version: 1, client_id: 'fake-v1', account_id: 123 } : null });
    return p.id;
  };
  const start = id => api(id, '/simkl/connect', 'POST');
  const status = (id, flow) => api(id, '/simkl/status?flow_id=' + flow.flow_id);
  const callback = (flow, code = 'good') => route('/simkl/oauth2/callback?code=' + code
    + '&state=' + new URL(flow.authorize_url).searchParams.get('state') + '&iss=https://simkl.com', { redirect: 'manual' });
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  const within = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = timeout(() => reject(new Error('Barrier timed out')), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  let checks = 0;
  const pass = name => { checks++; console.log('  ✓ lifecycle: ' + name); };
  try {
    for (const issuer of ['', 'https://wrong.example']) {
      const id = add('Issuer'), flow = await start(id);
      const count = requests.length;
      const state = new URL(flow.authorize_url).searchParams.get('state');
      await route('/simkl/oauth2/callback?code=fake&state=' + state + (issuer ? '&iss=' + encodeURIComponent(issuer) : ''), { redirect: 'manual' });
      assert.equal(requests.length, count, 'invalid issuer must never reach provider');
      assert.equal((await status(id, flow)).connection_attempt.state, 'failed');
      assert.equal(config.getProfile(id).simkl_auth.access_token, 'old-v1');
      pass('missing/wrong issuer terminates only matching attempt: ' + (issuer || 'missing'));
    }
    for (const point of ['/oauth2/token', '/users/settings']) {
      for (const mutation of ['new-connect', 'disconnect', 'credentials']) {
        const id = add('Race-' + mutation), first = await start(id);
        const entered = deferred(), release = deferred(); let held = false;
        provider = async (u, opts) => {
          if (u.pathname === point && !held) { held = true; entered.resolve(); await release.promise; }
          return normalProvider(u, opts);
        };
        const pending = callback(first); pending.catch(() => {});
        let next;
        try {
          await within(entered.promise);
          if (mutation === 'new-connect') next = await start(id);
          else if (mutation === 'disconnect') await api(id, '/simkl/disconnect', 'POST');
          else await api(id, '', 'PUT', { keys: { simkl_v2_client_secret: 'changed-secret' } });
        } finally { release.resolve(); }
        await pending;
        assert.equal((await status(id, first)).connection_attempt.state, 'failed');
        assert.equal(config.getProfile(id).simkl_auth?.access_token || null, mutation === 'disconnect' ? null : 'old-v1');
        if (next) assert.equal((await status(id, next)).connection_attempt.state, 'pending');
        provider = normalProvider;
        pass(point + ' interrupted by ' + mutation);
      }
    }

    for (const identity of ['good', 'wrong', 'malformed', 'network']) {
      for (const old of [true, false]) {
        const id = add('Identity-' + identity, old), flow = await start(id);
        provider = (u, opts) => {
          if (u.pathname === '/users/settings' && identity === 'malformed') return response({});
          if (u.pathname === '/users/settings' && identity === 'network') throw new Error('Fake network failure');
          return normalProvider(u, opts);
        };
        await callback(flow, identity);
        const rejected = old && identity !== 'good';
        const result = (await status(id, flow)).connection_attempt;
        assert.equal(result.state, rejected ? 'failed' : 'completed');
        assert.equal(config.getProfile(id).simkl_auth.access_token, rejected ? 'old-v1' : 'token-' + identity);
        if (!rejected) assert.equal(result.result, ['malformed', 'network'].includes(identity) ? 'token_stored' : 'connected');
        provider = normalProvider;
        pass('identity ' + identity + ', existing grant=' + old);
      }
    }

    // Same-account numeric V1 ID reconnects through the actual PIN poll.
    const pinId = add('PIN reconnect', true, 1), pinFlow = await start(pinId);
    const pinDeadline = Date.now() + 8000;
    while ((await status(pinId, pinFlow)).connection_attempt.state === 'pending' && Date.now() < pinDeadline) await new Promise(r => timeout(r, 100));
    assert.equal((await status(pinId, pinFlow)).connection_attempt.result, 'connected');
    assert.equal(config.getProfile(pinId).simkl_auth.client_id, 'fake-v1');
    pass('PIN numeric/string identity normalization and bound client');

    // A revoke response for the old grant cannot clear a replacement.
    const revokeId = add('Revoke'), revokeFlow = await start(revokeId); await callback(revokeFlow);
    const revokeEntered = deferred(), revokeRelease = deferred();
    provider = async (u, opts) => { if (u.pathname === '/oauth2/revoke') { revokeEntered.resolve(); await revokeRelease.promise; } return normalProvider(u, opts); };
    const disconnect = api(revokeId, '/simkl/disconnect', 'POST');
    await within(revokeEntered.promise);
    assert.equal(config.getProfile(revokeId).simkl_auth, null);
    const replacement = await start(revokeId); await callback(replacement, 'replacement');
    revokeRelease.resolve(); await disconnect;
    assert.equal(config.getProfile(revokeId).simkl_auth.access_token, 'token-replacement');
    provider = normalProvider;
    pass('delayed revoke preserves newer grant');

    // Check refreshes once and caches against the refreshed grant.
    const checkId = add('Check refresh', false), checkFlow = await start(checkId); await callback(checkFlow);
    const beforeCheck = config.getProfile(checkId);
    config.updateProfile(checkId, { simkl_auth: { ...beforeCheck.simkl_auth, expires_at: Date.now() - 1000 } });
    const count = requests.filter(r => r.path === '/oauth2/token').length;
    assert.equal((await api(checkId, '/simkl/check', 'POST')).state, 'connected');
    assert.equal(requests.filter(r => r.path === '/oauth2/token').length, count + 1);
    assert.equal((await api(checkId, '/simkl/status')).state, 'connected');
    await api(checkId, '', 'PUT', { keys: { simkl_v2_client_id: 'changed-client' } });
    assert.notEqual((await api(checkId, '/simkl/status')).state, 'connected');
    pass('Check refresh/cache and credential edit invalidation');

    const retryId = add('Refresh once', false), retryFlow = await start(retryId); await callback(retryFlow);
    config.updateProfile(retryId, { simkl_auth: { ...config.getProfile(retryId).simkl_auth, expires_at: Date.now() - 1000 } });
    const beforeRetry = requests.filter(r => r.path === '/oauth2/token').length;
    provider = (u, opts) => u.pathname === '/sync/activities' ? response({}, 401) : normalProvider(u, opts);
    await assert.rejects(simkl.simklFetch(config.getProfile(retryId), '/sync/activities'), /token rejected/);
    assert.equal(requests.filter(r => r.path === '/oauth2/token').length, beforeRetry + 1);
    provider = normalProvider;
    pass('proactive refresh followed by 401 never refreshes twice');

    // The deadline wins even when the transport/body ignores abort entirely.
    provider = (u) => u.searchParams.get('client_id') === 'body'
      ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
    const begun = Date.now();
    const timeouts = await Promise.all([flows.verifyIdentity('fetch', 'fake'), flows.verifyIdentity('body', 'fake')]);
    assert.ok(timeouts.every(r => !r.ok && r.reason === 'timeout'));
    assert.ok(Date.now() - begun < 12000);
    provider = normalProvider;
    pass('independent fetch and body deadlines');

    if (process.argv.includes('--browser')) {
      const { chromium } = require('playwright');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ httpCredentials: { username: 'review', password: 'review' } });
      let consent = 'good';
      await context.route('https://simkl.com/oauth2/authorize*', r => {
        const state = new URL(r.request().url()).searchParams.get('state');
        const query = consent === 'cancel' ? 'error=access_denied' : 'code=' + consent + '&iss=https://simkl.com';
        return r.fulfill({ status: 302, headers: { location: base + '/simkl/oauth2/callback?' + query + '&state=' + state } });
      });
      const page = await context.newPage(), errors = [];
      context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
      page.on('pageerror', e => errors.push(e.message));
      const uiId = add('BrowserTarget');
      // Navigate using #simkl?profile=<id> which selects the profile AND
      // activates the Advanced tab (readSimklCallbackError reads the hash).
      await page.goto(base + '/configure/#simkl?profile=' + uiId);
      const card = page.locator('[data-id="' + uiId + '"]');
      // The profile has a stored V1 token (active) but preferred V2.
      // The editor is visible; the flow shows "Token stored".
      await card.locator('[data-simkl-editor]').waitFor({ state: 'visible' });
      await card.locator('.simkl-flow').filter({ hasText: 'Token stored' }).waitFor();
      // Explicitly select V1 (the active version) before checking.
      // An explicit V2 Check is readiness, not V1 verification.
      await card.locator('[data-auth-version]').selectOption('1');
      // Click "Check connection" in the flow area (scoped to .simkl-flow
      // to avoid ambiguity with any editor check button).
      await card.locator('.simkl-flow').getByRole('button', { name: 'Check connection', exact: true }).click();
      // After verification, the connected summary shows "✓ Connected".
      await card.locator('.simkl-flow').filter({ hasText: '✓ Connected' }).waitFor();
      // The badge shows "Simkl connected".
      await card.locator('.hdr-badge').filter({ hasText: 'Simkl connected' }).waitFor();
      // The editor is hidden after verification (connected state).
      await card.locator('[data-simkl-editor]').waitFor({ state: 'hidden' });
      // Click "Change connection" to reveal the editor.
      await card.locator('.simkl-flow').getByRole('button', { name: 'Change connection', exact: true }).click();
      await card.locator('[data-simkl-editor]').waitFor({ state: 'visible' });
      // Select V2 in the version selector.
      await card.locator('[data-auth-version]').selectOption('2');
      // Click "Connect" to start the V2 OAuth flow.
      await card.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.waitForTimeout(6500);
      const link = card.getByRole('link', { name: 'Authorize with Simkl', exact: true });
      assert.equal(await link.count(), 1);
      assert.equal(config.getProfile(uiId).simkl_auth.version, 1);
      pass('browser pending migration survives two polls');
      consent = 'wrong';
      const [failureTab] = await Promise.all([context.waitForEvent('page'), link.click()]);
      await failureTab.waitForURL('**/configure/**');
      await card.locator('.simkl-attempt-error').filter({ hasText: 'account mismatch' }).waitFor();
      await page.evaluate(id => checkSimklStatus(id), uiId);
      assert.match(await card.locator('.simkl-attempt-error').innerText(), /account mismatch/);
      assert.equal(config.getProfile(uiId).simkl_auth.version, 1);
      await failureTab.close();
      pass('browser real callback failure retained after status render');
      consent = 'good';
      // Reveal the editor again and click Connect for V2.
      await card.locator('.simkl-flow').getByRole('button', { name: 'Change connection', exact: true }).click();
      await card.locator('[data-simkl-editor]').waitFor({ state: 'visible' });
      await card.getByRole('button', { name: 'Connect', exact: true }).click();
      let failedReload = false;
      await card.getByRole('link', { name: 'Authorize with Simkl', exact: true }).waitFor();
      await page.route('**/api/profiles', r => {
        if (!failedReload) { failedReload = true; return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Transient test failure"}' }); }
        return r.continue();
      });
      const [successTab] = await Promise.all([context.waitForEvent('page'), card.getByRole('link', { name: 'Authorize with Simkl', exact: true }).click()]);
      await successTab.waitForURL('**/configure/**');
      await page.waitForFunction(id => PROFILES.find(p => p.id === id)?.simkl_active_version === 2, uiId);
      assert.equal(config.getProfile(uiId).simkl_auth.version, 2);
      assert.equal(failedReload, true, 'completion retries a failed profile reload');
      // After successful V2 connection, the connected summary shows "✓ Connected".
      await card.locator('.simkl-flow').filter({ hasText: '✓ Connected' }).waitFor();
      assert.equal(await card.locator('.simkl-flow').getByRole('button', { name: 'Change connection', exact: true }).count(), 1);
      await successTab.waitForSelector('[data-id="' + uiId + '"]');
      assert.equal(await successTab.locator('#userSelect').inputValue(), uiId);
      assert.deepEqual(errors, []);
      pass('browser actual success refreshes original tab and selects correct callback profile');

      // ---- Browser regression: active state preserved separately from target readiness ----
      // A verified V1 account: Change connection, select V2, Check.
      // The badge must remain "Simkl connected" with Sync/Disconnect/Change,
      // and the V2 target note is appended once.
      {
        const regId = add('RegTarget');
        // Force a full page load (hash-only change doesn't re-trigger load()).
        await page.goto(base + '/configure/');
        await page.goto(base + '/configure/#simkl?profile=' + regId);
        const regCard = page.locator('[data-id="' + regId + '"]');
        // Wait for the editor to render (checkSimklStatus is async via readSimklCallbackError).
        await regCard.locator('[data-simkl-editor]').waitFor({ state: 'visible' });
        // Select V1 (active version) before waiting for the Check button.
        await regCard.locator('[data-auth-version]').selectOption('1');
        // Wait for the Check button to appear (renderSimklFlow is async after checkSimklStatus).
        await regCard.locator('.simkl-flow').getByRole('button', { name: 'Check connection', exact: true }).waitFor();
        await regCard.locator('.simkl-flow').getByRole('button', { name: 'Check connection', exact: true }).click();
        await regCard.locator('.simkl-flow').filter({ hasText: '✓ Connected' }).waitFor();
        // Record the active details: username and watched count.
        const flowText = await regCard.locator('.simkl-flow').innerText();
        assert.ok(flowText.includes('Fake User'), 'active username present');
        assert.ok(flowText.includes('watched title'), 'watched count present');
        // Sync and Disconnect buttons are present.
        assert.equal(await regCard.locator('.simkl-flow').getByRole('button', { name: 'Sync watched now', exact: true }).count(), 1);
        assert.equal(await regCard.locator('.simkl-flow').getByRole('button', { name: 'Disconnect from Simkl', exact: true }).count(), 1);
        // Change connection to reveal the editor.
        await regCard.locator('.simkl-flow').getByRole('button', { name: 'Change connection', exact: true }).click();
        await regCard.locator('[data-simkl-editor]').waitFor({ state: 'visible' });
        // Select V2 and check (target readiness).
        await regCard.locator('[data-auth-version]').selectOption('2');
        await regCard.locator('.simkl-flow').getByRole('button', { name: 'Check connection', exact: true }).click();
        // The badge must still show "Simkl connected" (active V1 state preserved).
        await regCard.locator('.hdr-badge').filter({ hasText: 'Simkl connected' }).waitFor();
        // The active details remain: username, watched count, Sync/Disconnect.
        const flowText2 = await regCard.locator('.simkl-flow').innerText();
        assert.ok(flowText2.includes('Fake User'), 'active username preserved after target check');
        assert.ok(flowText2.includes('watched title'), 'watched count preserved after target check');
        assert.equal(await regCard.locator('.simkl-flow').getByRole('button', { name: 'Sync watched now', exact: true }).count(), 1, 'Sync preserved');
        assert.equal(await regCard.locator('.simkl-flow').getByRole('button', { name: 'Disconnect from Simkl', exact: true }).count(), 1, 'Disconnect preserved');
        // The V2 target note is appended once.
        assert.ok(flowText2.includes('Target AUTH V2'), 'target note present');
        const targetNoteCount = (flowText2.match(/Target AUTH V2/g) || []).length;
        assert.equal(targetNoteCount, 1, 'target note appended exactly once');
        // A passive render retains the truthful active state + one supplementary note.
        await page.evaluate(id => checkSimklStatus(id), regId);
        const flowText3 = await regCard.locator('.simkl-flow').innerText();
        assert.ok(flowText3.includes('Fake User'), 'passive render retains active username');
        assert.ok(flowText3.includes('Target AUTH V2'), 'passive render retains target note');
        const passiveNoteCount = (flowText3.match(/Target AUTH V2/g) || []).length;
        assert.equal(passiveNoteCount, 1, 'passive render has exactly one target note');
        config.removeProfile(regId);
        pass('browser active state preserved separately from target readiness');
      }
    }
    console.log('All Simkl lifecycle checks passed (' + checks + ').');
  } finally {
    if (browser) await browser.close();
    for (const timer of timers) clearInterval(timer);
    global.setInterval = interval; global.setTimeout = timeout; global.fetch = nativeFetch;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
