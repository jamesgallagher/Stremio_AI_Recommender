// Live age-gate latency benchmark: fire the SAME batched "game of" movie
// age-gate request at each provider and compare wall-clock time. Uses the real
// buildAgePrompt so the payload is identical to production. Groq calls carry
// response_format+reasoning_effort (as the app sends); custom uses the minimal
// body the app sends to a local OpenAI-compatible server.
//
// Secrets come from env — never hardcode/print them:
//   GROQ_API_KEY, CUSTOM_URI, CUSTOM_KEY, CUSTOM_MODEL
//   RUNS (default 3)

const groq = require('../src/services/groq');

const RUNS = Number(process.env.RUNS) || 3;
const AGE = Number(process.env.AGE) || 11;
const SYSTEM = 'You are a strict parental-guidance reviewer for Australian audiences. Reply with raw JSON only.';

const CANDIDATES = [
  { id: 'tt10090796', title: 'Game of Thrones: The Last Watch', year: '2019', genres: ['Documentary'], overview: 'For a year, acclaimed British filmmaker Jeanie Finlay was embedded on the set of the hit HBO series “Game of Thrones,” chronicling the creation of the show’s most ambitious season.' },
  { id: 'tt7136312', title: 'Game of Thrones: The Story So Far', year: '2017', genres: ['Documentary'], overview: 'The story of Game Of thrones before the TV series.' },
  { id: 'tt4732932', title: 'Game of Thrones: Spanish Kingdom Special', year: '2015', genres: ['Documentary'], overview: 'This in-house production is conceived as a chronicle of the Game of Thrones shoot in Seville and Osuna, featuring interviews with key figures.' },
  { id: 'tt34382478', title: "Game of Thrones: Aegon's Conquest", genres: ['Action', 'Fantasy', 'Drama'], overview: 'Follows the original conqueror Aegon I Targaryen, roughly 300 years before the events of the Game of Thrones series.' },
  { id: 'tt4437700', title: 'Game of Thrones: A Day in the Life', year: '2015', genres: ['Documentary', 'TV Movie'], overview: 'Glimpse the epic scale of Game of Thrones in this featurette touring various Season 5 sets in Croatia, Spain and Ireland.' },
  { id: 'tt7937220', title: 'Game of Thrones - Conquest & Rebellion: An Animated History of the Seven Kingdoms', year: '2017', genres: ['Animation', 'Fantasy', 'War'], overview: 'A powerful ruler from House Targaryen begins a campaign to unite a fractured continent ruled by seven competing families, with the aid of dragons.' },
];

const prompt = groq.buildAgePrompt('movie', AGE, CANDIDATES);
const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groqBody(model) {
  const b = { model, messages, temperature: 0, response_format: { type: 'json_object' } };
  if (/^openai\/gpt-oss/.test(model)) b.reasoning_effort = 'low';
  return b;
}
function customBody(model) {
  return { model, messages, temperature: 0 }; // minimal, as callProvider does for custom
}

async function fireOnce(url, key, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    const ms = Date.now() - t0;
    const content = data.choices?.[0]?.message?.content || '';
    let verdicts = null;
    try { verdicts = groq.parseVerdicts(content, new Set(CANDIDATES.map((c) => c.id))); } catch { /* leave null */ }
    return { ms, status: res.status, ok: res.ok, verdicts: verdicts ? verdicts.size : 0, usage: data.usage || null, err: res.ok ? null : JSON.stringify(data).slice(0, 160) };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, ok: false, verdicts: 0, err: e.name === 'AbortError' ? 'timeout(120s)' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function benchTarget(label, url, key, body, gapMs) {
  const runs = [];
  process.stdout.write(`\n${label}\n`);
  for (let i = 0; i < RUNS; i++) {
    const r = await fireOnce(url, key, body);
    runs.push(r);
    process.stdout.write(`  run ${i + 1}: ${r.ok ? `${r.ms}ms  (${r.verdicts}/${CANDIDATES.length} verdicts${r.usage ? `, ${r.usage.completion_tokens ?? '?'} out toks` : ''})` : `FAILED ${r.status} ${r.err}`}\n`);
    if (i < RUNS - 1 && gapMs) await sleep(gapMs);
  }
  const oks = runs.filter((r) => r.ok).map((r) => r.ms);
  const stat = oks.length ? { min: Math.min(...oks), max: Math.max(...oks), avg: Math.round(oks.reduce((a, b) => a + b, 0) / oks.length) } : null;
  return { label, stat, oks: oks.length };
}

async function main() {
  const results = [];
  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

  if (process.env.GROQ_API_KEY) {
    results.push(await benchTarget('Groq · openai/gpt-oss-120b (current primary)', GROQ_URL, process.env.GROQ_API_KEY, groqBody('openai/gpt-oss-120b'), 2500));
    results.push(await benchTarget('Groq · openai/gpt-oss-20b (small-model lever)', GROQ_URL, process.env.GROQ_API_KEY, groqBody('openai/gpt-oss-20b'), 2500));
  }
  if (process.env.CUSTOM_URI && process.env.CUSTOM_MODEL) {
    const url = `${process.env.CUSTOM_URI.replace(/\/+$/, '')}/chat/completions`;
    results.push(await benchTarget(`Custom · ${process.env.CUSTOM_MODEL.split('/').pop()} (local ${process.env.CUSTOM_URI})`, url, process.env.CUSTOM_KEY, customBody(process.env.CUSTOM_MODEL), 0));
  }

  console.log('\n================  summary (successful runs)  ================');
  for (const r of results) {
    if (r.stat) console.log(`  ${r.label}\n      min ${r.stat.min}ms   avg ${r.stat.avg}ms   max ${r.stat.max}ms`);
    else console.log(`  ${r.label}\n      no successful runs`);
  }
  console.log('\nNote: these are RAW model round-trips. Production adds ~2.1s Groq governor');
  console.log('spacing per call, and a search fires TWO (movie+series), so cold wall time');
  console.log('≈ 2 × (spacing + model). The verdict cache removes all of this on repeats.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
