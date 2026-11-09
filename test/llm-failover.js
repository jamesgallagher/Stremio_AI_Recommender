// LLM failover: custom (local) → groq-primary → groq-backup.
// fetch is stubbed per-URL/key; no network. Run: node --experimental-sqlite test/llm-failover.js
const assert = require('assert');
const llm = require('../src/services/llm');
const governor = require('../src/services/governor');

const quiet = { log() {}, warn() {} };
const CUSTOM = { type: 'custom', name: 'local', uri: 'http://local:1/v1' };
const G1 = { type: 'groq', apiKey: 'k1', label: 'groq-primary' };
const G2 = { type: 'groq', apiKey: 'k2', label: 'groq-backup' };
const CHAIN = [CUSTOM, G1, G2];
const MSG = [{ role: 'user', content: 'hi' }];

const ok = (text) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => text });
const http = (status, headers = {}, body = '') => ({ ok: false, status, headers: new Headers(headers), text: async () => body });

let calls; // [label...] in call order
function stub(handlers) {
  calls = [];
  global.fetch = async (url, init) => {
    const who = url.startsWith('http://local') ? 'custom'
      : (init.headers.Authorization === 'Bearer k1' ? 'groq-primary' : 'groq-backup');
    calls.push(who);
    return handlers[who](url, init);
  };
}
function reset() { llm._resetHealth(); governor._reset(); }

(async () => {
  const realFetch = global.fetch;
  try {
    // 1. Healthy local LLM answers; Groq untouched.
    reset();
    stub({ custom: () => ok('LOCAL'), 'groq-primary': () => ok('G1'), 'groq-backup': () => ok('G2') });
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'LOCAL');
    assert.deepStrictEqual(calls, ['custom']);
    console.log('  ✓ healthy local LLM is used first');

    // 2. Local down (connection refused) → Groq 1; next call SKIPS local entirely.
    reset();
    stub({ custom: () => { throw new TypeError('fetch failed'); }, 'groq-primary': () => ok('G1'), 'groq-backup': () => ok('G2') });
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G1');
    assert.deepStrictEqual(calls, ['custom', 'groq-primary']);
    assert.strictEqual(llm.healthSnapshot().custom.available, false);
    calls.length = 0;
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G1');
    assert.deepStrictEqual(calls, ['groq-primary'], 'a parked local LLM is not re-tried on every call');
    console.log('  ✓ local down → Groq 1, and the dead local box is skipped on later calls');

    // 3. Local 5xx counts as down too.
    reset();
    stub({ custom: () => http(503), 'groq-primary': () => ok('G1'), 'groq-backup': () => ok('G2') });
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G1');
    assert.strictEqual(llm.healthSnapshot().custom.reason, 'HTTP 503');
    console.log('  ✓ local 503 → Groq 1');

    // 4. Local down + Groq 1 out of credits (402) → Groq 2; 402 skips Groq 1's 2nd model.
    reset();
    stub({ custom: () => { throw new TypeError('fetch failed'); }, 'groq-primary': () => http(402, {}, 'out of credits'), 'groq-backup': () => ok('G2') });
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G2');
    assert.deepStrictEqual(calls, ['custom', 'groq-primary', 'groq-backup'], 'no wasted 2nd-model call on an exhausted key');
    calls.length = 0;
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G2');
    assert.deepStrictEqual(calls, ['groq-backup'], 'exhausted Groq 1 + dead local are both skipped next time');
    console.log('  ✓ local down + Groq 1 out of credits → Groq 2');

    // 5. Groq 1 hits a long 429 (quota) → Groq 2 answers immediately (own governor lane, no sleep).
    reset();
    stub({ custom: () => { throw new TypeError('fetch failed'); }, 'groq-primary': () => http(429, { 'retry-after': '3600' }), 'groq-backup': () => ok('G2') });
    const t0 = Date.now();
    assert.strictEqual(await llm.chat([G1, G2], MSG, {}, quiet), 'G2');
    assert.ok(Date.now() - t0 < 4000, 'backup must not wait out the primary\'s Retry-After');
    calls.length = 0;
    assert.strictEqual(await llm.chat([G1, G2], MSG, {}, quiet), 'G2');
    assert.deepStrictEqual(calls, ['groq-backup'], 'quota-limited primary is parked, not slept on');
    console.log('  ✓ Groq 1 quota-limited (429, long Retry-After) → Groq 2 without stalling');

    // 6. Local recovers after its cooldown (half-open probe) and is used again.
    reset();
    let up = false;
    stub({ custom: () => { if (!up) throw new TypeError('fetch failed'); return ok('LOCAL'); }, 'groq-primary': () => ok('G1'), 'groq-backup': () => ok('G2') });
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G1');
    up = true;
    // Force the cooldown to lapse by faking time via a short-lived provider state.
    const realNow = Date.now; Date.now = () => realNow() + 10 * 60000;
    try { assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'LOCAL'); } finally { Date.now = realNow; }
    assert.ok(!llm.healthSnapshot().custom, 'recovered provider is cleared');
    console.log('  ✓ local LLM is probed again after cooldown and recovers');

    // 7. Bad content (validate throws) falls through but does NOT park the provider.
    reset();
    stub({ custom: () => ok('garbage'), 'groq-primary': () => ok('[1]'), 'groq-backup': () => ok('G2') });
    const v = (t) => { if (t === 'garbage') throw new Error('bad json'); return t; };
    assert.strictEqual(await llm.chat(CHAIN, MSG, { validate: v }, quiet), '[1]');
    assert.ok(!llm.healthSnapshot().custom, 'a bad answer is not an outage');
    console.log('  ✓ unparseable answer falls through without marking the provider down');

    // 8. Everything cooling down → still tried (never "no answer" from a stale cooldown).
    reset();
    let n = 0;
    stub({ custom: () => { throw new TypeError('fetch failed'); }, 'groq-primary': () => { n++; throw new TypeError('fetch failed'); }, 'groq-backup': () => { n++; if (n < 3) throw new TypeError('fetch failed'); return ok('G2'); } });
    await assert.rejects(() => llm.chat(CHAIN, MSG, {}, quiet));
    assert.strictEqual(await llm.chat(CHAIN, MSG, {}, quiet), 'G2');
    console.log('  ✓ all providers parked → all still attempted (fail-closed callers get a real answer when one returns)');

    // 9. Backup key has its own governor lane.
    reset();
    stub({ custom: () => ok('x'), 'groq-primary': () => ok('a'), 'groq-backup': () => ok('b') });
    await llm.chat([G1], MSG, {}, quiet); await llm.chat([G2], MSG, {}, quiet);
    const st = governor.publicStats();
    assert.ok(st.groq && st.groq_backup, 'primary and backup are paced independently');
    console.log('  ✓ Groq primary/backup use separate governor lanes');

    // 10. Total failure still throws.
    reset();
    stub({ custom: () => { throw new TypeError('fetch failed'); }, 'groq-primary': () => http(401), 'groq-backup': () => http(402) });
    await assert.rejects(() => llm.chat(CHAIN, MSG, {}, quiet));
    console.log('  ✓ whole chain failing still throws (callers fail-closed)');

    console.log('llm-failover: all passed');
  } finally { global.fetch = realFetch; }
})().catch((e) => { console.error(e); process.exit(1); });
