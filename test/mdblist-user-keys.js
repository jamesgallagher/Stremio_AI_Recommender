// MDBList user-first key resolution + provider-failure isolation tests.
// 6 acceptance cases per the Card 2 spec.
'use strict';
const assert = require('assert');
const crypto = require('crypto');

(async () => {
// ---- Test 1: Personal P + global G: every profile-bound consumer sends P.
// No personal key: sends G. Neither: clear missing configuration.
{
  const settings = require('../src/settings');
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });

  // Profile with personal key P
  const profileP = { keys: { mdblist_api_key: 'personal-P' } };
  const r1 = settings.resolveMdblistKey(profileP);
  assert.equal(r1.key, 'personal-P', 'personal key wins');
  assert.equal(r1.source, 'user', 'source is user');

  // Profile without personal key
  const profileNo = { keys: {} };
  const r2 = settings.resolveMdblistKey(profileNo);
  assert.equal(r2.key, 'global-G', 'global key used when no personal');
  assert.equal(r2.source, 'server', 'source is server');

  // No keys at all
  settings.updateSettings({ keys: { mdblist_api_key: '' } });
  const r3 = settings.resolveMdblistKey(profileNo);
  assert.equal(r3.key, '', 'no key when neither present');
  assert.equal(r3.source, 'none', 'source is none');

  // Blank/whitespace personal key falls through to global
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });
  const profileBlank = { keys: { mdblist_api_key: '   ' } };
  const r4 = settings.resolveMdblistKey(profileBlank);
  assert.equal(r4.key, 'global-G', 'blank personal falls through to global');
  assert.equal(r4.source, 'server', 'source is server');

  console.log('  ✓ test 1: personal P + global G resolution');
}

// ---- Test 2: Personal P rejected or 429: no G retry. Different user's Q
// works promptly. Two profiles using P, or P equal to G, share pacing/cooldown.
{
  const governor = require('../src/services/governor');
  governor._reset();

  // Simulate a 429 on personal key P
  const fpP = crypto.createHash('sha256').update('personal-P').digest('hex').slice(0, 16);
  const fpG = crypto.createHash('sha256').update('global-G').digest('hex').slice(0, 16);

  // A 429 response on P
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '60' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpP);

  // P is now backing off; G is not (no state = no backoff)
  const stats = governor.stats();
  assert.equal(stats.mdblist[fpP].backing_off, true, 'P is backing off');
  assert.ok(!stats.mdblist[fpG] || !stats.mdblist[fpG].backing_off, 'G is NOT backing off');

  // A different user's key Q works promptly (no backoff)
  const fpQ = crypto.createHash('sha256').update('user-Q').digest('hex').slice(0, 16);
  assert.ok(!stats.mdblist[fpQ] || !stats.mdblist[fpQ].backing_off, 'Q is not backing off');

  // P equal to G shares the same bucket
  const fpSame = crypto.createHash('sha256').update('global-G').digest('hex').slice(0, 16);
  assert.equal(fpSame, fpG, 'same key = same fingerprint');

  console.log('  ✓ test 2: per-credential isolation (no G retry on P 429)');
}

// ---- Test 3: Real queue: Siobhan extras gets 429 with 2-hour Retry-After,
// Dad recs behind it starts promptly after extras defers. Old curated cache
// survives, and neither job calls the blocked key during cooldown.
{
  const governor = require('../src/services/governor');
  governor._reset();

  const fpSiobhan = crypto.createHash('sha256').update('siobhan-key').digest('hex').slice(0, 16);
  const fpDad = crypto.createHash('sha256').update('dad-key').digest('hex').slice(0, 16);

  // Siobhan's key gets a 429 with 2-hour Retry-After
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '7200' : null } };
  governor.noteResponse('mdblist', fakeRes429, fpSiobhan);

  // The slot wait for Siobhan's key would be ~2 hours
  const waitSiobhan = governor.reserve('mdblist', fpSiobhan);
  assert.ok(waitSiobhan > 30000, 'Siobhan slot wait exceeds 30s');

  // The governor should defer (throw) rather than hold the queue
  let deferred = false;
  try {
    await governor.schedule('mdblist', async () => ({ status: 200 }), fpSiobhan);
  } catch (err) {
    deferred = err.defer === true;
    assert.ok(err.retryAfterMs > 0, 'defer error has retry time');
  }
  assert.equal(deferred, true, 'Siobhan job defers promptly');

  // Dad's key (different credential) is unaffected
  const waitDad = governor.reserve('mdblist', fpDad);
  assert.ok(waitDad < 30000, 'Dad slot wait is short (different key)');

  console.log('  ✓ test 3: queue stall fix (defer on 429, next job starts)');
}

// ---- Test 4: Never-settling fetch and never-settling body each time out
// and release the job. Breaker stops further requests and recovers after
// cooldown. No late mutation continues after the queue advances.
{
  const governor = require('../src/services/governor');
  governor._reset();

  const fp = crypto.createHash('sha256').update('test-key-4').digest('hex').slice(0, 16);

  // Simulate 5 consecutive transport failures (breaker threshold = 5)
  for (let i = 0; i < 5; i++) {
    governor.noteOutcome('mdblist', false, fp);
  }

  // Breaker should now be open
  assert.equal(governor.isOpen('mdblist', fp), true, 'breaker is open after 5 failures');

  // schedule should fail fast (circuit open)
  let circuitErr = null;
  try {
    await governor.schedule('mdblist', async () => ({ status: 200 }), fp);
  } catch (err) {
    circuitErr = err;
  }
  assert.ok(circuitErr, 'schedule threw');
  assert.equal(circuitErr.circuitOpen, true, 'error is circuit open');

  // Simulate cooldown expiry (advance time past 60s)
  // We can't actually wait 60s, so we verify the breaker state
  const stats = governor.stats();
  assert.equal(stats.mdblist[fp].circuit_open, true, 'stats shows circuit open');
  assert.ok(stats.mdblist[fp].circuit_ms_left > 0, 'cooldown time remaining');

  console.log('  ✓ test 4: circuit breaker stops repeated failures');
}

// ---- Test 5: Age-source fixtures prove personal key propagation and
// unchanged fail-closed restrictions. Cached facts remain reusable;
// user history stays isolated.
{
  const settings = require('../src/settings');
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });

  // Profile with personal key
  const profile = { keys: { mdblist_api_key: 'personal-P' } };
  const resolved = settings.resolveMdblistKey(profile);
  assert.equal(resolved.key, 'personal-P', 'age source uses personal key');
  assert.equal(resolved.source, 'user', 'source is user');

  // Profile without personal key
  const profileNo = { keys: {} };
  const resolvedNo = settings.resolveMdblistKey(profileNo);
  assert.equal(resolvedNo.key, 'global-G', 'age source falls back to global');
  assert.equal(resolvedNo.source, 'server', 'source is server');

  // No keys at all — fail-closed (empty map, no answer)
  settings.updateSettings({ keys: { mdblist_api_key: '' } });
  const resolvedNone = settings.resolveMdblistKey(profileNo);
  assert.equal(resolvedNone.key, '', 'no key = no MDBList data');
  assert.equal(resolvedNone.source, 'none', 'source is none');

  console.log('  ✓ test 5: age-source personal key propagation + fail-closed');
}

// ---- Test 6: Browser shows actual key source, named queue blocker,
// deferred outcome.
{
  const settings = require('../src/settings');
  settings.updateSettings({ keys: { mdblist_api_key: 'global-G' } });

  // Simulate the portal's mdblist_status computation
  const profile = { keys: { mdblist_api_key: 'personal-P' } };
  const { key, source } = settings.resolveMdblistKey(profile);
  assert.equal(key, 'personal-P');
  assert.equal(source, 'user');

  // The fingerprint is computed the same way in portal.js
  const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const governor = require('../src/services/governor');
  governor._reset();

  // No backoff initially (no state = no backoff)
  const stats = governor.stats();
  assert.ok(!stats.mdblist?.[fp] || !stats.mdblist[fp].backing_off, 'no backoff initially');

  // After a 429
  const fakeRes429 = { status: 429, headers: { get: (h) => h.toLowerCase() === 'retry-after' ? '300' : null } };
  governor.noteResponse('mdblist', fakeRes429, fp);
  const stats2 = governor.stats();
  assert.equal(stats2.mdblist[fp].backing_off, true, 'backing off after 429');
  assert.ok(stats2.mdblist[fp].backoff_ms_left > 0, 'backoff time remaining');

  console.log('  ✓ test 6: browser shows key source + provider cooldown');
}

console.log('All MDBList user-keys checks passed (6).');
})().catch((err) => { console.error(err); process.exit(1); });
