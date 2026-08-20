// Age-gate search benchmark (v6.28). Reproduces the search hang and measures
// the two fixes: the persistent verdict cache and the per-provider timeout.
//
// It does NOT call a real LLM — instead it STUBS global.fetch with a canned
// OpenAI-shaped verdict response after a configurable delay, and counts calls.
// Everything else is the real code path: the real governor (Groq paced at
// 2.1s/call), the real chain, the real cache. So the CALL COUNTS and QUEUE
// timings are exact; the per-call latency is whatever `delay` we inject
// (GROQ_DELAY_MS / LOCAL_DELAY_MS) to stand in for a real provider.
//
// Usage:  node scripts/bench-agegate.js
//   GROQ_DELAY_MS=1500 LOCAL_DELAY_MS=6000 node scripts/bench-agegate.js
//
// The point it proves: BEFORE, a 6-keystroke search burst fires one LLM call
// per keystroke per catalog (movie+series), all serialized behind the 2.1s Groq
// governor. AFTER, the first keystroke fills the cache and every later keystroke
// is a pure cache hit — zero LLM calls, near-zero wall time.

const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate all disk state in a temp DATA_DIR so nothing real is touched. MUST be
// set before requiring store/settings (they read DATA_DIR at module load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agegate-bench-'));
process.env.DATA_DIR = TMP;

const store = require('../src/store');
const settings = require('../src/settings');
const groq = require('../src/services/groq');
const governor = require('../src/services/governor');

const GROQ_DELAY_MS = Number(process.env.GROQ_DELAY_MS) || 1500; // stand-in for gpt-oss-120b latency
const LOCAL_DELAY_MS = Number(process.env.LOCAL_DELAY_MS) || 6000; // stand-in for a local model

// The exact candidate set from the reported logs (a "game of" search).
const MOVIE = [
  { id: 'tt10090796', title: 'Game of Thrones: The Last Watch' },
  { id: 'tt7136312', title: 'Game of Thrones: The Story So Far' },
  { id: 'tt4732932', title: 'Game of Thrones: Spanish Kingdom Special' },
  { id: 'tt34382478', title: "Game of Thrones: Aegon's Conquest" },
  { id: 'tt4437700', title: 'Game of Thrones: A Day in the Life' },
  { id: 'tt7937220', title: 'Game of Thrones - Conquest & Rebellion' },
];
const SERIES = [
  { id: 'tt0944947', title: 'Game of Thrones' },
  { id: 'tt21973642', title: 'The Official Game of Thrones Podcast' },
  { id: 'tt34870889', title: 'Game of Throws: Inside Darts' },
  { id: 'tt11198330', title: 'House of the Dragon' },
  { id: 'tt27497448', title: 'A Knight of the Seven Kingdoms' },
];

const quiet = { log() {}, warn() {} };
const AGE = 12;

// ---- fetch stub: counts calls, delays, returns a valid verdict payload ----
let fetchCalls = 0;
let injectDelay = GROQ_DELAY_MS;
let hangForever = false;
const realFetch = global.fetch;

global.fetch = async (url, opts = {}) => {
  fetchCalls++;
  // Verdict every candidate id in the request body as ok:false (worst case for
  // the old path: all vetoed, so nothing to keep, but every one still judged).
  const body = JSON.parse(opts.body || '{}');
  const userMsg = (body.messages || []).map((m) => m.content).join('\n');
  const ids = [...userMsg.matchAll(/"id":"(tt\d+)"/g)].map((m) => m[1]);
  const verdicts = ids.map((id) => ({ id, ok: false }));
  const payload = { choices: [{ message: { content: JSON.stringify(verdicts) } }] };

  await new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (hangForever) {
      // Never resolve on its own — only the AbortController can end this.
      if (signal) signal.addEventListener('abort', () => reject(abortErr()), { once: true });
      return;
    }
    const timer = setTimeout(resolve, injectDelay);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortErr()); }, { once: true });
    }
  });
  return { ok: true, status: 200, headers: new Map(), json: async () => payload, text: async () => '' };
};

function abortErr() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

const ms = (n) => `${n.toFixed(0)}ms`;
async function timed(fn) {
  const t0 = Date.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  return { ms: Date.now() - t0, err };
}

// One "keystroke" = the two catalog requests Stremio fires (movie + series).
async function keystroke() {
  await groq.ageGate('movie', AGE, MOVIE, quiet);
  await groq.ageGate('series', AGE, SERIES, quiet);
}

async function run() {
  settings.updateSettings({
    keys: { tmdb_api_key: 'x' },
    llm: { groq_api_key: 'benchkey', groq_api_key_backup: '', custom_uri: '', custom_name: '', custom_api_key: '' },
  });

  const KEYSTROKES = 6;
  console.log(`\nScenario: a ${KEYSTROKES}-keystroke "game of" search on a kids profile (age ${AGE}).`);
  console.log(`Each keystroke = movie(${MOVIE.length}) + series(${SERIES.length}) age gates.`);
  console.log(`Injected latency: Groq=${ms(GROQ_DELAY_MS)}/call, governor spacing=${governor.LIMITS.groq.minIntervalMs}ms.\n`);

  // ---- BEFORE: no cache (wipe verdicts before every gate call) ----
  governor._reset();
  fetchCalls = 0; injectDelay = GROQ_DELAY_MS; hangForever = false;
  const before = await timed(async () => {
    for (let i = 0; i < KEYSTROKES; i++) {
      store.saveAgeVerdicts({}); // simulate the old world: nothing is remembered
      await keystroke();
    }
    store.saveAgeVerdicts({});
  });
  const beforeCalls = fetchCalls;

  // ---- AFTER: persistent cache on (the shipped behaviour) ----
  governor._reset();
  fetchCalls = 0; injectDelay = GROQ_DELAY_MS; hangForever = false;
  store.saveAgeVerdicts({}); // cold start
  const after = await timed(async () => {
    for (let i = 0; i < KEYSTROKES; i++) await keystroke();
  });
  const afterCalls = fetchCalls;

  console.log('  BEFORE (no verdict cache):');
  console.log(`    LLM calls: ${beforeCalls}   wall time: ${ms(before.ms)}`);
  console.log('  AFTER  (persistent cache):');
  console.log(`    LLM calls: ${afterCalls}   wall time: ${ms(after.ms)}`);
  console.log(`    → calls cut ${beforeCalls}→${afterCalls}, wall time ${(before.ms / Math.max(after.ms, 1)).toFixed(1)}x faster\n`);

  // ---- Timeout: a hung provider must abort, not block forever ----
  governor._reset();
  fetchCalls = 0; hangForever = true;
  store.saveAgeVerdicts({});
  process.env.GROQ_TIMEOUT_MS = '8000'; // matches the shipped default
  const hung = await timed(() => groq.ageGate('movie', AGE, MOVIE, quiet));
  console.log('  Hung provider (fetch never responds):');
  console.log(`    fail-closed after ${ms(hung.ms)} (2 models x 8s timeout), error: "${hung.err ? hung.err.message : 'none'}"`);
  console.log('    → search returns (empty, fail-closed) instead of hanging until Stremio quits.\n');

  // ---- Local-model factor: same burst, slower per-call latency ----
  governor._reset();
  fetchCalls = 0; injectDelay = LOCAL_DELAY_MS; hangForever = false;
  store.saveAgeVerdicts({});
  const localAfter = await timed(async () => {
    for (let i = 0; i < KEYSTROKES; i++) await keystroke();
  });
  console.log(`  Local model factor (per-call latency ${ms(LOCAL_DELAY_MS)}):`);
  console.log(`    AFTER wall time: ${ms(localAfter.ms)} for ${fetchCalls} calls (all on keystroke 1; rest cached)\n`);

  global.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
}

run().catch((e) => { console.error(e); process.exit(1); });
