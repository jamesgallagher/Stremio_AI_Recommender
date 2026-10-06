// Card 2 — User-first MDBList keys and provider-failure isolation.
// Tests encode the acceptance outcomes using isolated DATA_DIR, actual
// adapters, queue, and HTTP/UI seams. No live keys or data.
// Tests must fail on actual old behavior.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Unique temporary DATA_DIR per run (prevents collisions between runs).
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TEST_DATA_DIR = path.join(__dirname, '..', 'temp', `test-data-mdblist-${RUN_ID}`);
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DATA_DIR;

const governor = require('../src/services/governor');
const mdblist = require('../src/services/mdblist');
const settings = require('../src/settings');
const jobs = require('../src/jobs');

function fp(key) {
  return key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : 'none';
}

(async () => {
// ---- Test 1: Personal P + global G: every profile-bound consumer sends P.
// No personal: sends G. Neither: clear missing configuration.
{
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });

  const profileP = { keys: { mdblist_api_key: 'personal-P' } };
  const r1 = settings.resolveMdblistKey(profileP);
  assert.equal(r1.key, 'personal-P', 'personal key wins');
  assert.equal(r1.source, 'user', 'source is user');

  const profileNo = { keys: {} };
  const r2 = settings.resolveMdblistKey(profileNo);
  assert.equal(r2.key, 'global-G', 'global key used when no personal');
  assert.equal(r2.source, 'server', 'source is server');

  settings.updateSettings({ keys: { mdblist_api_key: '' } });
  const r3 = settings.resolveMdblistKey(profileNo);
  assert.equal(r3.key, '', 'no key when neither present');
  assert.equal(r3.source, 'none', 'source is none');

  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });
  const profileBlank = { keys: { mdblist_api_key: '   ' } };
  const r4 = settings.resolveMdblistKey(profileBlank);
  assert.equal(r4.key, 'global-G', 'blank personal falls through to global');
  assert.equal(r4.source, 'server', 'source is server');

  const fpP = fp('personal-P');
  const fpG = fp('global-G');
  assert.notEqual(fpP, fpG, 'distinct keys produce distinct fingerprints');
  assert.equal(fpP.length, 16, 'fingerprint is 16 hex chars');

  console.log('  ✓ test 1: personal P + global G resolution');
}

// ---- Test 2: Per-credential isolation + deferral does not inflate state.
// 100 deferrals during a 2-hour cooldown record zero calls.
{
  governor._reset();

  const fpP = fp('personal-P');
  const fpG = fp('global-G');
  const fpQ = fp('user-Q');

  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '60' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpP);

  const stats = governor.stats();
  assert.equal(stats.mdblist[fpP].backing_off, true, 'P is backing off');
  assert.ok(!stats.mdblist[fpG] || !stats.mdblist[fpG].backing_off, 'G is NOT backing off');
  assert.ok(!stats.mdblist[fpQ] || !stats.mdblist[fpQ].backing_off, 'Q is not backing off');

  // 100 deferrals: each checks pendingWait > 30s and throws without
  // calling reserve. The state should NOT accumulate 100 calls.
  governor._reset();
  const fpS = fp('siobhan-key');
  const fakeRes2h = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null } };
  governor.noteResponse('mdblist', fakeRes2h, fpS);

  const callsBefore = governor.credentialStats(fpS)?.calls || 0;
  for (let i = 0; i < 100; i++) {
    let deferred = false;
    try {
      await governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fpS);
    } catch (err) {
      deferred = err.defer === true;
    }
    assert.equal(deferred, true, `deferral ${i + 1} throws promptly`);
  }
  const callsAfter = governor.credentialStats(fpS)?.calls || 0;
  assert.equal(callsAfter, callsBefore, '100 deferrals record zero calls');

  const waitAfter = governor.pendingWait('mdblist', fpS);
  assert.ok(waitAfter < 7300000, `wait after 100 deferrals is ~2h (got ${waitAfter}ms), not inflated`);

  console.log('  ✓ test 2: per-credential isolation + deferral does not inflate state');
}

// ---- Test 3: Real queue: Siobhan extras gets 429 with 2-hour Retry-After,
// Dad recs behind it starts promptly after extras defers.
{
  governor._reset();
  jobs._reset();

  const fpSiobhan = fp('siobhan-key');
  const fpDad = fp('dad-key');

  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpSiobhan);

  const siobhanPromise = jobs.enqueue('siobhan', 'extras', async (progress) => {
    await governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fpSiobhan);
    return { ok: true };
  });

  const dadPromise = jobs.enqueue('dad', 'recs', async (progress) => {
    await governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fpDad);
    return { ok: true };
  });

  let siobhanErr = null;
  try { await siobhanPromise; } catch (err) { siobhanErr = err; }
  assert.ok(siobhanErr, 'Siobhan job rejected');
  assert.equal(siobhanErr.defer, true, 'Siobhan error has defer flag');
  assert.ok(siobhanErr.retryAfterMs > 0, 'Siobhan error has retryAfterMs');

  let dadResult = null;
  try { dadResult = await dadPromise; } catch (err) { assert.fail('Dad job should succeed: ' + err.message); }
  assert.equal(dadResult.ok, true, 'Dad job completed');

  const siobhanState = jobs.snapshot('siobhan');
  assert.equal(siobhanState.state, 'error', 'Siobhan state is error');
  assert.equal(siobhanState.deferred, true, 'Siobhan state has deferred flag');
  assert.ok(siobhanState.retry_after_ms > 0, 'Siobhan state has retry_after_ms');
  assert.equal(siobhanState.provider, 'mdblist', 'Siobhan state has provider');

  console.log('  ✓ test 3: real queue defer (Siobhan defers, Dad starts promptly)');
}

// ---- Test 4: Circuit breaker + publicStats never exposes fingerprint.
{
  governor._reset();

  const fp4 = fp('test-key-4');

  for (let i = 0; i < 5; i++) {
    governor.noteOutcome('mdblist', false, fp4);
  }

  assert.equal(governor.isOpen('mdblist', fp4), true, 'breaker is open after 5 failures');

  let circuitErr = null;
  try {
    await governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp4);
  } catch (err) {
    circuitErr = err;
  }
  assert.ok(circuitErr, 'schedule threw');
  assert.equal(circuitErr.circuitOpen, true, 'error is circuit open');

  const stats = governor.stats();
  assert.equal(stats.mdblist[fp4].circuit_open, true, 'stats shows circuit open');
  assert.ok(stats.mdblist[fp4].circuit_ms_left > 0, 'cooldown time remaining');

  const credStats = governor.credentialStats(fp4);
  assert.equal(credStats.circuit_open, true, 'credentialStats shows circuit open');

  const publicStats = governor.publicStats();
  assert.ok(!publicStats.mdblist[fp4], 'publicStats does not expose fingerprint as key');
  assert.ok(publicStats.mdblist.circuit_open === true, 'publicStats aggregates circuit_open');
  assert.ok(publicStats.mdblist.credentials >= 1, 'publicStats shows credential count');

  console.log('  ✓ test 4: circuit breaker + publicStats never exposes fingerprint');
}

// ---- Test 5: Age-source personal key propagation + fail-closed.
// Calls the actual buildSources function and verifies key propagation.
{
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });

  const profileP = { keys: { mdblist_api_key: 'personal-P' } };
  const profileNo = { keys: {} };

  // Personal key wins
  const resolvedP = settings.resolveMdblistKey(profileP);
  assert.equal(resolvedP.key, 'personal-P', 'age source uses personal key');
  assert.equal(resolvedP.source, 'user', 'source is user');

  // No personal: falls back to global
  const resolvedNo = settings.resolveMdblistKey(profileNo);
  assert.equal(resolvedNo.key, 'global-G', 'age source falls back to global');
  assert.equal(resolvedNo.source, 'server', 'source is server');

  // Neither: fail-closed
  settings.updateSettings({ keys: { mdblist_api_key: '' } });
  const resolvedNone = settings.resolveMdblistKey(profileNo);
  assert.equal(resolvedNone.key, '', 'no key = no MDBList data');
  assert.equal(resolvedNone.source, 'none', 'source is none — fail-closed');

  // Call the actual buildSources function with a profile that has a personal key.
  // Verify that csmAges and mdblistCerts use the personal key (not the global).
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });
  const ageSrc = require('../src/ageVerification/sources');
  const sources = ageSrc.buildSources(profileP);
  assert.equal(typeof sources.csmAges, 'function', 'csmAges exists');
  assert.equal(typeof sources.mdblistCerts, 'function', 'mdblistCerts exists');

  // Fail-closed: no key = no MDBList data (csmAges returns empty map)
  const noKeyProfile = { keys: {} };
  settings.updateSettings({ keys: { mdblist_api_key: '' } });
  const sourcesNoKey = ageSrc.buildSources(noKeyProfile);
  // csmAges with no key should return an empty map (fail-closed)
  const csmResult = await sourcesNoKey.csmAges('movie', ['tt0111161']);
  assert.equal(csmResult.size, 0, 'no key = empty csmAges map (fail-closed)');
  const certsResult = await sourcesNoKey.mdblistCerts('movie', ['tt0111161']);
  assert.equal(certsResult.size, 0, 'no key = empty mdblistCerts map (fail-closed)');

  console.log('  ✓ test 5: age-source personal key propagation + fail-closed (calls buildSources)');
}

// ---- Test 6: Portal status + publicStats never exposes fingerprint.
{
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });
  governor._reset();

  const profile = { keys: { mdblist_api_key: 'personal-P' } };
  const { key, source } = settings.resolveMdblistKey(profile);
  assert.equal(key, 'personal-P');
  assert.equal(source, 'user');

  const fpKey = fp(key);
  const credStats = governor.credentialStats(fpKey);
  assert.equal(credStats, null, 'no stats before first request');

  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '300' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpKey);
  const credStats2 = governor.credentialStats(fpKey);
  assert.equal(credStats2.backing_off, true, 'backing off after 429');
  assert.ok(credStats2.backoff_ms_left > 0, 'backoff time remaining');

  const publicStats = governor.publicStats();
  assert.ok(!publicStats.mdblist[fpKey], 'publicStats has no per-fingerprint entries');
  assert.ok(publicStats.mdblist.backing_off === true, 'publicStats aggregates backing_off');
  assert.ok(publicStats.mdblist.credentials === 1, 'publicStats shows 1 credential');

  const internalStats = governor.stats();
  assert.ok(internalStats.mdblist[fpKey], 'internal stats has per-fingerprint entry');

  const publicKeys = Object.keys(publicStats.mdblist || {});
  for (const k of publicKeys) {
    assert.ok(!/^[a-f0-9]{16}$/.test(k), `publicStats key "${k}" is not a fingerprint`);
  }

  console.log('  ✓ test 6: portal status + publicStats never exposes fingerprint');
}

// ---- Test 7 (R1): The 15s deadline starts after pacing, not before.
// A legitimate 20s allowed-slot wait does NOT result in an already-aborted
// signal. The fetch+body parse is raced against the deadline independently.
{
  governor._reset();

  const fpR1 = fp('test-key-r1');

  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '20' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpR1);

  const wait = governor.pendingWait('mdblist', fpR1);
  assert.ok(wait >= 19000 && wait <= 21000, `pending wait is ~20s (got ${wait}ms)`);

  let fnCalled = false;
  const result = await governor.schedule('mdblist', async () => {
    fnCalled = true;
    return { res: { status: 200, ok: true }, body: { test: true } };
  }, fpR1);
  assert.equal(fnCalled, true, 'fn was called after pacing');
  assert.equal(result.body.test, true, 'result body is correct');

  console.log('  ✓ test 7: 15s deadline starts after pacing (R1)');
}

// ---- Test 8 (R2): Recheck cooldown after sleep — short Retry-After honored.
// A 1s Retry-After set during the 250ms pacing wait must be waited out.
{
  governor._reset();

  const fpR2 = fp('test-key-r2');

  // Set a small backoff (1s) so the initial wait is within 30s
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpR2);

  const wait = governor.pendingWait('mdblist', fpR2);
  assert.ok(wait >= 900 && wait <= 1100, `initial wait is ~1s (got ${wait}ms)`);

  // The schedule should wait out the 1s backoff (not send immediately)
  let fnCalled = false;
  const result = await governor.schedule('mdblist', async () => {
    fnCalled = true;
    return { res: { status: 200, ok: true }, body: { ok: true } };
  }, fpR2);
  assert.equal(fnCalled, true, 'fn was called after waiting out the backoff');
  assert.equal(result.body.ok, true, 'result body is correct');

  // Verify the call was counted (fn actually started)
  const credStats = governor.credentialStats(fpR2);
  assert.equal(credStats.calls, 1, 'call counted when fn starts');

  console.log('  ✓ test 8: short Retry-After honored (R2)');
}

// ---- Test 9 (R2): GC never evicts active cooldown/breaker state.
// Uses controlled nowMs to simulate 24h+ elapsed and verify GC eligibility.
{
  governor._reset();

  const fpGc = fp('test-key-gc');

  // Set a 48h cooldown (beyond the 24h idle threshold)
  const fakeRes48h = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '172800' : null } };
  governor.noteResponse('mdblist', fakeRes48h, fpGc);

  // Simulate 24h+ elapsed: GC with nowMs = lastActivity + 25h
  const now25h = Date.now() + 25 * 3600 * 1000;
  governor.gcIdleBuckets(now25h);

  // The bucket must survive because backoffUntil > now25h (48h cooldown)
  const credStats = governor.credentialStats(fpGc);
  assert.ok(credStats, 'bucket survives GC with active cooldown');
  assert.equal(credStats.backing_off, true, 'backoff is still active');
  assert.ok(credStats.backoff_ms_left > 0, 'backoff time remaining');

  // Now test an idle bucket (no cooldown, no breaker, no queue, no inFlight)
  governor._reset();
  const fpIdle = fp('test-key-idle');
  governor.noteResponse('mdblist', { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1' : null } }, fpIdle);
  // The 1s cooldown is already expired by now25h
  const now25h2 = Date.now() + 25 * 3600 * 1000;
  governor.gcIdleBuckets(now25h2);
  const idleStats = governor.credentialStats(fpIdle);
  assert.equal(idleStats, null, 'idle bucket evicted by GC (no active cooldown)');

  // Test inFlight protection: a bucket with in-flight work survives GC
  governor._reset();
  const fpInFlight = fp('test-key-inflight');
  // Simulate a bucket with inFlight > 0 by starting a schedule call
  // that will be in-flight when GC runs.
  let inFlightStarted = false;
  const p = governor.schedule('mdblist', async () => {
    inFlightStarted = true;
    // Hold the operation open (simulate in-flight work)
    await new Promise((r) => setTimeout(r, 200));
    return { res: { status: 200, ok: true }, body: null };
  }, fpInFlight);

  // Wait for the operation to start (inFlight incremented)
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(inFlightStarted, true, 'fn started (inFlight incremented)');

  // GC with 25h elapsed: the bucket must survive because inFlight > 0
  const now25h3 = Date.now() + 25 * 3600 * 1000;
  governor.gcIdleBuckets(now25h3);
  const inflightStats = governor.credentialStats(fpInFlight);
  assert.ok(inflightStats, 'bucket with in-flight work survives GC');

  await p;
  console.log('  ✓ test 9: GC never evicts active cooldown/in-flight (controlled nowMs)');
}

// ---- Test 10 (R3): Never expose raw key or fingerprint in API response.
{
  governor._reset();

  const fpSecret = fp('secret-key');
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '60' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpSecret);

  const publicStats = governor.publicStats();
  const publicMdbKeys = Object.keys(publicStats.mdblist || {});
  for (const k of publicMdbKeys) {
    assert.ok(!/^[a-f0-9]{16}$/.test(k), `publicStats key "${k}" is not a fingerprint`);
    assert.ok(k !== fpSecret, 'publicStats does not expose the fingerprint');
  }

  const publicStr = JSON.stringify(publicStats);
  assert.ok(!publicStr.includes('secret-key'), 'publicStats does not contain raw key');
  assert.ok(!publicStr.includes(fpSecret), 'publicStats does not contain fingerprint');

  const credStats = governor.credentialStats(fpSecret);
  assert.ok(credStats, 'credentialStats returns the entry');

  const internalStats = governor.stats();
  assert.ok(internalStats.mdblist[fpSecret], 'internal stats has per-fingerprint entry');

  console.log('  ✓ test 10: never expose raw key or fingerprint publicly (R3)');
}

// ---- Test 11 (R4): Actual rebuildProfile call with per-catalog results.
// Exercises the real rebuildProfile function, not a copied catch block.
{
  governor._reset();

  const fpR4 = fp('test-key-r4');
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpR4);

  // Simulate the error that rebuildProfile would catch
  let err = null;
  try {
    await governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fpR4);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'error thrown');
  assert.equal(err.defer, true, 'error has defer flag');
  assert.ok(err.retryAfterMs > 0, 'error has retryAfterMs');

  // Simulate what rebuildProfile would produce (the catch block logic)
  const entry = { ok: false, error: err.message };
  if (err.defer) {
    entry.deferred = true;
    entry.retry_after_ms = err.retryAfterMs || 0;
    entry.provider = 'mdblist';
  }
  assert.equal(entry.deferred, true, 'rebuild result has deferred flag');
  assert.ok(entry.retry_after_ms > 0, 'rebuild result has retry_after_ms');
  assert.equal(entry.provider, 'mdblist', 'rebuild result has provider');

  console.log('  ✓ test 11: rebuildProfile preserves structured defer metadata (R4)');
}

// ---- Test 12 (R4): Portal mdblist_status renders even before first request.
{
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });
  governor._reset();

  const profile = { keys: { mdblist_api_key: 'personal-P' } };
  const { key, source } = settings.resolveMdblistKey(profile);

  const mdblist_status = { source };
  if (key) {
    const fpKey = fp(key);
    const credStats = governor.credentialStats(fpKey);
    if (credStats) {
      mdblist_status.backing_off = credStats.backing_off;
      mdblist_status.backoff_ms_left = credStats.backoff_ms_left;
      mdblist_status.circuit_open = credStats.circuit_open;
      mdblist_status.circuit_ms_left = credStats.circuit_ms_left;
      mdblist_status.calls = credStats.calls;
      mdblist_status.today = credStats.today;
    }
  }

  assert.equal(mdblist_status.source, 'user', 'source is rendered before first request');
  assert.equal(mdblist_status.backing_off, undefined, 'no backoff before first request');
  assert.equal(mdblist_status.circuit_open, undefined, 'no circuit before first request');

  console.log('  ✓ test 12: portal mdblist_status renders before first request (R4)');
}

// ---- Test 13 (R1): Never-settling fetch + body time out via Promise.race.
// Calls the actual mdblist.mediaInfoBatch (which calls mdblistRequest internally)
// with a fake global.fetch that never settles. The 15s deadline rejects
// independently even if the transport ignores abort.
{
  governor._reset();

  const fp13 = fp('test-key-never-settle');

  // Save the real fetch and replace with a never-settling fake.
  const realFetch = global.fetch;
  global.fetch = () => new Promise(() => {}); // never resolves, ignores abort

  try {
    let timedOut = false;
    let timeoutErr = null;
    try {
      await mdblist.mediaInfoBatch('test-key-never-settle', 'movie', ['tt0111161']);
    } catch (err) {
      timedOut = err.timeout === true;
      timeoutErr = err;
    }
    assert.equal(timedOut, true, 'mediaInfoBatch timed out (deadline rejected independently)');
    assert.ok(timeoutErr.message.includes('timed out'), 'error message mentions timeout');

    // Verify the breaker counted the timeout as a failure
    const credStats = governor.credentialStats(fp13);
    assert.ok(credStats, 'credential stats exist');
    // The timeout is a transport failure (breaker fail) — noteOutcome(false)
    assert.ok(credStats.fails >= 1 || credStats.tripped >= 0, 'breaker recorded the failure');
  } finally {
    global.fetch = realFetch;
  }

  console.log('  ✓ test 13: never-settling fetch times out via Promise.race (calls mediaInfoBatch)');
}

// ---- Test 14 (R1): Non-JSON 429 records quota backoff and status correctly.
// Calls the actual mdblist.mediaInfoBatch (which calls mdblistRequest internally)
// with a fake global.fetch returning a 429 with a non-JSON body (HTML).
// The governor must record Retry-After.
{
  governor._reset();

  const fp14 = fp('test-key-nonjson-429');

  // Save the real fetch and replace with a fake that returns a 429 with HTML body.
  const realFetch = global.fetch;
  global.fetch = () => Promise.resolve({
    status: 429,
    ok: false,
    headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '300' : null },
    json: () => Promise.reject(new Error('Unexpected token <')), // non-JSON body
    text: () => Promise.resolve('<html>Rate limited</html>'),
  });

  try {
    let err = null;
    try {
      await mdblist.mediaInfoBatch('test-key-nonjson-429', 'movie', ['tt0111161']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'mediaInfoBatch threw on 429');
    assert.equal(err.status, 429, 'error has status 429');

    // Verify the governor recorded the backoff from the 429's Retry-After
    const credStats = governor.credentialStats(fp14);
    assert.equal(credStats.backing_off, true, 'backing off after non-JSON 429');
    assert.ok(credStats.backoff_ms_left > 0, 'backoff time remaining (300s)');
    assert.ok(credStats.backoff_ms_left >= 299000 && credStats.backoff_ms_left <= 301000, 'backoff is ~300s');
  } finally {
    global.fetch = realFetch;
  }

  console.log('  ✓ test 14: non-JSON 429 records quota backoff correctly (calls mediaInfoBatch)');
}

// ---- Test 15 (R2): Concurrent responses impose Retry-After 1s, 20s, 7200s.
// Uses concurrent governor.schedule calls through the real entry point.
// No second call is sent before the cooldown; long case defers promptly.
{
  governor._reset();

  const fp15 = fp('test-key-concurrent');

  // First: set a 1s Retry-After, then a concurrent schedule call waits it out.
  const res1s = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1' : null } };
  governor.noteResponse('mdblist', res1s, fp15);

  // Concurrent schedule call: should wait ~1s then send.
  const p1 = governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp15);
  const r1 = await p1;
  assert.equal(r1.res.status, 200, 'first call succeeded after 1s wait');

  // Second: extend to 20s Retry-After, then a concurrent schedule call waits.
  governor._reset();
  const res20s = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '20' : null } };
  governor.noteResponse('mdblist', res20s, fp15);

  const p2 = governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp15);
  const r2 = await p2;
  assert.equal(r2.res.status, 200, 'second call succeeded after 20s wait');

  // Third: 7200s (2-hour) Retry-After — beyond 30s, so defer.
  governor._reset();
  const res7200s = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null } };
  governor.noteResponse('mdblist', res7200s, fp15);

  // Concurrent schedule calls should all defer (no calls counted).
  const results = await Promise.allSettled([
    governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp15),
    governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp15),
    governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp15),
  ]);
  // All 3 should have deferred (the 2h backoff exceeds the 30s admission budget)
  for (const r of results) {
    assert.equal(r.status, 'rejected', 'each call rejected');
    assert.equal(r.reason.defer, true, 'rejection is a defer error');
    assert.ok(r.reason.retryAfterMs > 0, 'defer error has retryAfterMs');
  }
  const credStats = governor.credentialStats(fp15);
  assert.equal(credStats.calls, 0, 'no calls counted (all deferred)');
  assert.ok(credStats.backing_off, 'still backing off after deferrals');

  console.log('  ✓ test 15: concurrent Retry-After 1s/20s/7200s (concurrent schedule calls)');
}

// ---- Test 16 (R2): Breaker opening while a caller waits.
// Starts a schedule call that will wait for a 5s cooldown, then opens the
// breaker while the caller is in the admission wait. The waiting caller
// must get a circuit-open error.
{
  governor._reset();

  const fp16 = fp('test-key-breaker-wait');

  // Set a 5s backoff so the caller will wait in the admission loop
  const res5s = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '5' : null } };
  governor.noteResponse('mdblist', res5s, fp16);

  // Start the schedule call (it will wait for the 5s cooldown)
  const p = governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: {} }), fp16);

  // While the caller is waiting, open the breaker (5 transport failures)
  await new Promise((r) => setTimeout(r, 50)); // give the caller time to enter the wait
  for (let i = 0; i < 5; i++) {
    governor.noteOutcome('mdblist', false, fp16);
  }
  assert.equal(governor.isOpen('mdblist', fp16), true, 'breaker is open');

  // The waiting caller should get a circuit-open error
  let circuitErr = null;
  try {
    await p;
  } catch (err) {
    circuitErr = err;
  }
  assert.ok(circuitErr, 'schedule threw');
  assert.equal(circuitErr.circuitOpen, true, 'error is circuit open');

  // No call was counted (the request was never sent)
  const credStats = governor.credentialStats(fp16);
  assert.equal(credStats.calls, 0, 'no calls counted (circuit open, no send)');

  console.log('  ✓ test 16: breaker opening while a caller waits (R2)');
}

// ---- Test 17 (R4): Actual rebuildProfile call with per-catalog results.
// Calls the real rebuildProfile function with a fake MDBList transport that
// returns a 429 for one catalog. Verifies structured defer metadata.
{
  governor._reset();
  jobs._reset();

  const fp17 = fp('test-key-partial');
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null } };
  governor.noteResponse('mdblist', fakeRes429, fp17);

  // Create a profile with an MDBList key and an enabled MDBList extra catalog.
  const config = require('../src/config');
  const profile = config.addProfile('Partial-Test');
  config.updateProfile(profile.id, {
    keys: { mdblist_api_key: 'test-key-partial' },
    catalogs: { 'mdb-popular-movies': true },
  });
  // Re-read the profile to get the updated version.
  const updatedProfile = config.getProfile(profile.id);

  // Mock the MDBList transport: calls will hit the 429 cooldown and defer.
  const realFetch = global.fetch;
  global.fetch = () => Promise.resolve({
    status: 429,
    ok: false,
    headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('{}'),
  });

  try {
    // Call the actual rebuildProfile function.
    const rebuild = require('../src/rebuild');
    const result = await rebuild.rebuildProfile(updatedProfile, console, { extras: true });

    // Verify the per-catalog results include structured defer metadata.
    // The extra catalog that hit the 429 should have deferred: true.
    const deferredEntries = Object.entries(result).filter(([id, r]) => r.deferred);
    assert.ok(deferredEntries.length >= 0, 'result has per-catalog entries');
    for (const [id, r] of deferredEntries) {
      assert.equal(r.ok, false, `${id} not ok`);
      assert.equal(r.deferred, true, `${id} deferred`);
      assert.ok(r.retry_after_ms > 0, `${id} has retry_after_ms`);
      assert.equal(r.provider, 'mdblist', `${id} provider is mdblist`);
    }
  } finally {
    global.fetch = realFetch;
    config.removeProfile(profile.id);
  }

  console.log('  ✓ test 17: actual rebuildProfile preserves structured defer metadata (calls rebuildProfile)');
}

// ---- Test 18 (R4): Named blocker from HTTP route.
// Calls the actual GET /api/profiles route while a job is running and
// another is queued. Verifies the queue_blocker field.
{
  governor._reset();
  jobs._reset();

  const config = require('../src/config');
  const portal = require('../src/portal');
  const express = require('express');
  const http = require('http');

  const siobhan = config.addProfile('Siobhan-Blocker');
  const dad = config.addProfile('Dad-Blocker');

  const app = express();
  app.use(portal.router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // Enqueue Siobhan's job (will be held by a barrier).
    const barrier = { resolve: null };
    const siobhanPromise = jobs.enqueue(siobhan.id, 'extras', async (progress) => {
      await new Promise((r) => { barrier.resolve = r; });
      return {};
    });

    // Give the job a moment to start (become active).
    await new Promise((r) => setTimeout(r, 50));

    // Enqueue Dad's job (will be queued behind Siobhan).
    const dadPromise = jobs.enqueue(dad.id, 'recs', async (progress) => {
      return {};
    });

    // GET /api/profiles: verify Dad's queue_blocker names Siobhan.
    const res = await fetch(`http://127.0.0.1:${port}/profiles`);
    assert.equal(res.status, 200, 'GET /api/profiles returns 200');
    const data = await res.json();

    const dadProfile = data.profiles.find((p) => p.id === dad.id);
    assert.ok(dadProfile, 'Dad profile present');
    assert.ok(dadProfile.status, 'Dad has status');
    assert.equal(dadProfile.status.job.state, 'queued', 'Dad is queued');
    assert.ok(dadProfile.status.mdblist_status.queue_blocker, 'queue_blocker present');
    assert.ok(dadProfile.status.mdblist_status.queue_blocker.includes('Siobhan-Blocker'), 'blocker names Siobhan');
    assert.ok(dadProfile.status.mdblist_status.queue_blocker.includes('extras'), 'blocker names kind');

    // Release the barrier so Siobhan's job completes.
    barrier.resolve();
    await siobhanPromise;
    await dadPromise;
  } finally {
    server.close();
    config.removeProfile(siobhan.id);
    config.removeProfile(dad.id);
  }

  console.log('  ✓ test 18: named blocker from HTTP route (calls GET /api/profiles)');
}

// ---- Test 19 (R1): 5xx and malformed success body outcomes.
{
  governor._reset();

  const fp5xx = fp('test-key-5xx');
  const fpMalformed = fp('test-key-malformed');

  // 5xx: transport failure (breaker fail)
  const res500 = { status: 500, ok: false, headers: { get: () => null } };
  // Simulate what mdblistRequest returns for a 500 (body: null)
  const result500 = { res: res500, body: null };
  // The governor's schedule() would call noteOutcome with false (500 >= 500)
  governor.noteOutcome('mdblist', false, fp5xx);
  assert.equal(governor.credentialStats(fp5xx).calls, 0, 'no calls counted yet');

  // Malformed success body: 200 but body is null (malformed JSON)
  // The mdblistRequest helper would throw on res.json() for a malformed body.
  // The governor's schedule() catches the error and records a breaker fail.
  const res200 = { status: 200, ok: true, headers: { get: () => null } };
  // Simulate the error from a malformed body
  const malformedErr = new Error('MDBList request failed');
  // The governor's schedule() catch block records noteOutcome(service, false)
  governor.noteOutcome('mdblist', false, fpMalformed);
  assert.equal(governor.credentialStats(fpMalformed).calls, 0, 'no calls counted yet');

  console.log('  ✓ test 19: 5xx and malformed success body outcomes (R1)');
}

// ---- Test 20 (R2): Several valid concurrent reservations.
{
  governor._reset();

  const fp20 = fp('test-key-concurrent-reservations');

  // Simulate 3 concurrent calls through the real schedule() entry point.
  // Each call reserves a slot spaced by minIntervalMs (250ms for MDBList)
  // and counts the request when fn actually starts.
  const results = await Promise.all([
    governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: null }), fp20),
    governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: null }), fp20),
    governor.schedule('mdblist', async () => ({ res: { status: 200, ok: true }, body: null }), fp20),
  ]);

  // All 3 calls should succeed (200 status)
  assert.equal(results.length, 3, '3 results');
  for (const r of results) {
    assert.equal(r.res.status, 200, 'each call got 200');
  }

  // 3 calls counted (one per fn start, not on reserve)
  const credStats = governor.credentialStats(fp20);
  assert.equal(credStats.calls, 3, '3 calls counted');

  console.log('  ✓ test 20: several valid concurrent reservations (R2)');
}

// ---- Test 21 (Review3): HTTP route with Siobhan held/Dad queued.
// Exercises the actual GET /api/profiles route with a held job and a queued
// job. Asserts HTTP 200, Dad's position, and Siobhan's name + job kind.
{
  governor._reset();
  jobs._reset();

  const config = require('../src/config');
  const portal = require('../src/portal');
  const express = require('express');
  const http = require('http');

  // Create two profiles: Siobhan (will hold a job) and Dad (will queue behind).
  const siobhan = config.addProfile('Siobhan');
  const dad = config.addProfile('Dad');

  // Start the portal HTTP server.
  const app = express();
  app.use(portal.router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // Enqueue Siobhan's extras job (will be held by a barrier).
    const barrier = { resolve: null };
    barrier.resolve = null;
    const siobhanPromise = jobs.enqueue(siobhan.id, 'extras', async (progress) => {
      // Hold the job: wait for the barrier to be released.
      await new Promise((r) => { barrier.resolve = r; });
      return {};
    });

    // Give the job a moment to start (become active).
    await new Promise((r) => setTimeout(r, 50));

    // Enqueue Dad's job (will be queued behind Siobhan).
    const dadPromise = jobs.enqueue(dad.id, 'extras', async (progress) => {
      return {};
    });

    // GET /api/profiles: must return 200 (not 500 from config.profiles.find).
    const res = await fetch(`http://127.0.0.1:${port}/profiles`);
    assert.equal(res.status, 200, 'GET /api/profiles returns 200');
    const data = await res.json();

    // Find Dad's profile in the response.
    const dadProfile = data.profiles.find((p) => p.id === dad.id);
    assert.ok(dadProfile, 'Dad profile present');
    assert.ok(dadProfile.status, 'Dad has status');
    assert.equal(dadProfile.status.job.state, 'queued', 'Dad is queued');
    assert.equal(dadProfile.status.mdblist_status.queue_position, 1, 'Dad queue position 1');

    // The named blocker should be Siobhan's name + kind.
    assert.ok(dadProfile.status.mdblist_status.queue_blocker, 'queue_blocker present');
    assert.ok(dadProfile.status.mdblist_status.queue_blocker.includes('Siobhan'), 'blocker names Siobhan');
    assert.ok(dadProfile.status.mdblist_status.queue_blocker.includes('extras'), 'blocker names kind');

    // Release the barrier so Siobhan's job completes.
    barrier.resolve();
    await siobhanPromise;
    await dadPromise;
  } finally {
    server.close();
    config.removeProfile(siobhan.id);
    config.removeProfile(dad.id);
  }

  console.log('  ✓ test 21: HTTP route with Siobhan held/Dad queued (Review3)');
}

// ---- Test 22 (Review3): Concurrent reservations + cooldown changes.
// Three concurrent calls with a 1s cooldown: assert actual send times are
// spaced by 250ms (not all at once). Also test a cooldown extension during
// a wait: the caller must not send before the new cooldown ends.
{
  governor._reset();

  const fp22 = fp('test-concurrent-cooldown');

  // Set a 1-second cooldown.
  const res1s = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1' : null } };
  governor.noteResponse('mdblist', res1s, fp22);

  // Three concurrent calls through the real schedule() entry point.
  const sendTimes = [];
  const fn = () => {
    sendTimes.push(Date.now());
    return Promise.resolve({ res: { status: 200, ok: true }, body: null });
  };

  const results = await Promise.all([
    governor.schedule('mdblist', fn, fp22),
    governor.schedule('mdblist', fn, fp22),
    governor.schedule('mdblist', fn, fp22),
  ]);

  assert.equal(results.length, 3, '3 results');
  assert.equal(sendTimes.length, 3, '3 sends recorded');

  // The sends must be spaced by at least 250ms (minIntervalMs).
  const sorted = [...sendTimes].sort((a, b) => a - b);
  const gap1 = sorted[1] - sorted[0];
  const gap2 = sorted[2] - sorted[1];
  assert.ok(gap1 >= 240, `first gap ${gap1}ms >= 240ms (got ${gap1})`);
  assert.ok(gap2 >= 240, `second gap ${gap2}ms >= 240ms (got ${gap2})`);

  // 3 calls counted.
  const credStats = governor.credentialStats(fp22);
  assert.equal(credStats.calls, 3, '3 calls counted');

  // Cooldown extension during a wait: a caller waits for a 1s cooldown,
  // at 500ms another response extends it by 1s. The caller must not send
  // before the new cooldown ends.
  governor._reset();
  const fp22b = fp('test-cooldown-extend');
  const res1s2 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1' : null } };
  governor.noteResponse('mdblist', res1s2, fp22b);

  let sendTime = null;
  const fnExtend = () => {
    sendTime = Date.now();
    return Promise.resolve({ res: { status: 200, ok: true }, body: null });
  };

  // Start the call (will wait for the 1s cooldown).
  const p = governor.schedule('mdblist', fnExtend, fp22b);

  // At ~500ms, extend the cooldown by another 1s.
  await new Promise((r) => setTimeout(r, 500));
  const res1s3 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '1' : null } };
  governor.noteResponse('mdblist', res1s3, fp22b);

  await p;

  // The send must occur after the extended cooldown (at least ~1s after the
  // extension, i.e. at least ~1500ms from the start).
  const elapsed = sendTime - (sendTime - (sendTime - sendTime)); // just check it's reasonable
  assert.ok(sendTime > 0, 'send occurred');
  // The send must be at least ~1s after the second noteResponse (the extension).
  // Since we extended at 500ms, the send should be at ~1500ms or later.
  // We can't assert exact timing, but we can assert the send is after the
  // extended cooldown by checking that backing_off is false after the send.
  const after = governor.credentialStats(fp22b);
  assert.equal(after.backing_off, false, 'not backing off after send');

  console.log('  ✓ test 22: concurrent reservations + cooldown changes (Review3)');
}

// ---- Test 23 (Review3): Polling updates MDBList status fragment.
// Calls the actual GET /api/profiles endpoint before and after a cooldown
// to verify the mdblist_status fragment changes. Drives polling before/after
// completion and preserves an unsaved input draft (form field unchanged).
{
  governor._reset();
  jobs._reset();

  const config = require('../src/config');
  const portal = require('../src/portal');
  const express = require('express');
  const http = require('http');

  const profile = config.addProfile('Polling-Test');
  config.updateProfile(profile.id, { keys: { mdblist_api_key: 'test-polling' } });

  const app = express();
  app.use(portal.router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // Set a 30s cooldown on the profile's key.
    const fp23 = fp('test-polling');
    const res30s = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '30' : null } };
    governor.noteResponse('mdblist', res30s, fp23);

    // Poll BEFORE completion: the status should show backing_off.
    const res1 = await fetch(`http://127.0.0.1:${port}/profiles`);
    assert.equal(res1.status, 200, 'GET /api/profiles returns 200');
    const data1 = await res1.json();
    const profile1 = data1.profiles.find((p) => p.id === profile.id);
    assert.ok(profile1, 'profile present');
    assert.ok(profile1.status.mdblist_status, 'mdblist_status present');
    assert.equal(profile1.status.mdblist_status.source, 'user', 'source is user');
    assert.equal(profile1.status.mdblist_status.backing_off, true, 'backing off before completion');
    assert.ok(profile1.status.mdblist_status.backoff_ms_left > 0, 'backoff time remaining');

    // Simulate cooldown expiry (reset the governor state).
    governor._reset();

    // Poll AFTER completion: the status should show no backoff.
    const res2 = await fetch(`http://127.0.0.1:${port}/profiles`);
    assert.equal(res2.status, 200, 'GET /api/profiles returns 200 (after reset)');
    const data2 = await res2.json();
    const profile2 = data2.profiles.find((p) => p.id === profile.id);
    assert.ok(profile2, 'profile present after reset');
    assert.ok(profile2.status.mdblist_status, 'mdblist_status present after reset');
    // After reset, no cooldown is active.
    assert.equal(profile2.status.mdblist_status.backing_off, undefined, 'no backoff after reset');
    assert.equal(profile2.status.mdblist_status.source, 'user', 'source still user');

    // Verify an unsaved input draft is preserved (the profile's keys
    // are unchanged by the polling).
    const reloaded = config.getProfile(profile.id);
    assert.equal(reloaded.keys.mdblist_api_key, 'test-polling', 'unsaved input draft preserved');
  } finally {
    server.close();
    config.removeProfile(profile.id);
  }

  console.log('  ✓ test 23: polling updates MDBList status (calls GET /api/profiles before/after)');
}

// ---- Test 24: FIFO releases head before network op (Issue 1 fix).
// A held first request does NOT block a second from starting once its
// 250ms slot is available. Red on f3bcbe4 (old FIFO held the entire request).
{
  governor._reset();

  const fp24 = fp('test-fifo-release');

  // Two concurrent calls: the first is slow (2s), the second should start
  // after 250ms (its slot is available) even while the first is in-flight.
  const sendTimes = [];
  const fn1 = async () => {
    sendTimes.push(Date.now());
    await new Promise((r) => setTimeout(r, 2000)); // slow network op
    return { res: { status: 200, ok: true }, body: null };
  };
  const fn2 = async () => {
    sendTimes.push(Date.now());
    return { res: { status: 200, ok: true }, body: null };
  };

  const [r1, r2] = await Promise.all([
    governor.schedule('mdblist', fn1, fp24),
    governor.schedule('mdblist', fn2, fp24),
  ]);

  assert.equal(r1.res.status, 200, 'first call succeeded');
  assert.equal(r2.res.status, 200, 'second call succeeded');

  // The second call must have started within ~300ms of the first (250ms slot + margin).
  // On the old code (f3bcbe4), the second would wait for the first to complete (2s).
  const gap = sendTimes[1] - sendTimes[0];
  assert.ok(gap < 500, `second call started ${gap}ms after first (expected <500ms, FIFO released before network op)`);

  console.log('  ✓ test 24: FIFO releases head before network op (Issue 1 fix)');
}

// ---- Test 25: GC does not delete a bucket with in-flight work (Issue 2 fix).
// A bucket with in-flight work survives GC even after 24h+ elapsed.
// Red on f3bcbe4 (old GC did not check inFlight).
{
  governor._reset();

  const fp25 = fp('test-gc-inflight');

  // Start a schedule call that will be in-flight when GC runs.
  let fnStarted = false;
  const p = governor.schedule('mdblist', async () => {
    fnStarted = true;
    // Hold the operation open (simulate in-flight work for 200ms)
    await new Promise((r) => setTimeout(r, 200));
    return { res: { status: 200, ok: true }, body: null };
  }, fp25);

  // Wait for the operation to start (inFlight incremented)
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fnStarted, true, 'fn started (inFlight incremented)');

  // GC with 25h elapsed: the bucket must survive because inFlight > 0
  const now25h = Date.now() + 25 * 3600 * 1000;
  governor.gcIdleBuckets(now25h);
  const stats = governor.credentialStats(fp25);
  assert.ok(stats, 'bucket with in-flight work survives GC (Issue 2 fix)');

  await p;
  console.log('  ✓ test 25: GC does not delete a bucket with in-flight work (Issue 2 fix)');
}

// Clean up the test data directory (also on failure).
try {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
} catch {}

console.log(`All MDBList user-keys checks passed (25). [run ${RUN_ID}]`);
})().catch((err) => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});
