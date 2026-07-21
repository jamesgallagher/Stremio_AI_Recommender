// LLM age GOALKEEPER via Groq (OpenAI-compatible Chat Completions).
// v4: the LLM no longer generates or ranks recommendations — Trakt's own
// engine does that. The one remaining LLM job is a defence-in-depth age check
// for kids profiles (age_limit > 0): given the already-CSM-gated list, veto
// anything unsuitable for the age under Australian (ACB) standards.
// REMOVE-ONLY by construction: it can veto titles, never rescue ones CSM
// dropped, and a missing verdict keeps the title (CSM stays the primary gate).
const API = 'https://api.groq.com/openai/v1/chat/completions';

// Model order (override with GROQ_MODELS). llama-3.3-70b-versatile is primary:
// reliable structured output on list-sized payloads at free-tier limits;
// gpt-oss-120b burns its budget on hidden reasoning there, so fallback only.
const DEFAULT_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];
const FALLBACK_MODELS = (process.env.GROQ_MODELS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!FALLBACK_MODELS.length) FALLBACK_MODELS.push(...DEFAULT_MODELS);

function buildAgePrompt(type, ageLimit, titles) {
  const kind = type === 'series' ? 'TV series' : 'movies';
  const lines = titles.map((t) => JSON.stringify({
    id: t.id,
    title: t.title,
    year: t.year || undefined,
    genres: t.genres && t.genres.length ? t.genres : undefined,
    certification: t.certification || undefined,
    overview: t.overview ? String(t.overview).slice(0, 160) : undefined,
  })).join('\n');

  return `You are reviewing ${kind} for a child aged ${ageLimit} in Australia.
For EACH candidate below, decide whether it is suitable for a ${ageLimit}-year-old to watch, judged against Australian classification standards (ACB) and common-sense parental judgement. Err on the side of exclusion: if in doubt, mark it not OK.

Candidates (one JSON object per line):
${lines}

Return a JSON array with one object PER candidate, each with exactly:
- "id": the candidate id, copied verbatim (never invent one)
- "ok": true if suitable for a ${ageLimit}-year-old, false if not
Output ONLY the JSON array, no prose.
Example: [{"id":"tt1234567","ok":true},{"id":"tt7654321","ok":false}]`;
}

// Parse verdicts into Map<id, boolean>. Tolerates fenced JSON, prose-wrapped
// arrays, and json-mode object wrappers. Ids not in validIds are dropped
// (hallucination guard); duplicates keep the first verdict.
function parseVerdicts(text, validIds) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const a = cleaned.indexOf('[');
    const b = cleaned.lastIndexOf(']');
    if (a === -1 || b <= a) throw err;
    parsed = JSON.parse(cleaned.slice(a, b + 1));
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' ? Object.values(parsed).find(Array.isArray) : null);
  if (!Array.isArray(arr)) throw new Error('LLM did not return a JSON array');
  const out = new Map();
  for (const x of arr) {
    if (!x || typeof x.id !== 'string') continue;
    if (validIds && !validIds.has(x.id)) continue;
    if (out.has(x.id)) continue;
    out.set(x.id, x.ok === true);
  }
  return out;
}

async function callModel(apiKey, model, prompt) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a strict parental-guidance reviewer for Australian audiences. Reply with raw JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2, // judgement task — steady verdicts
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`Groq ${model} failed (${res.status})${body ? `: ${body}` : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`Groq ${model} returned empty response`);
  return text;
}

// Run the age gate over `titles` ([{id,title,year,genres,certification,
// overview}]). Returns the Set of VETOED ids. Requires verdicts for >= 60% of
// the list (else retry/fallback); throws when every model fails — kids-mode
// callers treat that like a broken CSM lookup: keep the previous list rather
// than serve an unverified one.
async function ageGate(apiKey, type, ageLimit, titles, log = console) {
  if (!titles.length) return new Set();
  const validIds = new Set(titles.map((t) => t.id));
  const prompt = buildAgePrompt(type, ageLimit, titles);
  log.log(`[groq] full age-gate prompt for ${type}:\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`);
  const minVerdicts = Math.ceil(titles.length * 0.6);
  const primary = FALLBACK_MODELS[0];
  let lastError = null;
  for (let i = 0; i < FALLBACK_MODELS.length; i++) {
    const model = FALLBACK_MODELS[i];
    try {
      const verdicts = parseVerdicts(await callModel(apiKey, model, prompt), validIds);
      if (verdicts.size < minVerdicts) throw new Error(`only ${verdicts.size}/${titles.length} verdicts`);
      const vetoed = new Set([...verdicts.entries()].filter(([, ok]) => !ok).map(([id]) => id));
      if (i === 0) {
        log.log(`[groq] ${type}: age gate by PRIMARY model ${model} — ${vetoed.size} of ${titles.length} vetoed`);
      } else {
        log.warn(`[groq] ${type}: ⚠ age gate by BACKUP model "${model}" — primary "${primary}" was unavailable (see above). ${vetoed.size} of ${titles.length} vetoed.`);
      }
      if (vetoed.size) {
        const names = titles.filter((t) => vetoed.has(t.id)).map((t) => t.title).join(', ');
        log.log(`[groq] ${type}: age-gate vetoed: ${names}`);
      }
      return vetoed;
    } catch (err) {
      lastError = err;
      const rate = err.status === 429 || /rate.?limit|quota|free.?tier|too many requests/i.test(err.message);
      const next = FALLBACK_MODELS[i + 1];
      const tail = next ? `falling back to backup model "${next}"` : 'no backup models left — this rebuild will fail';
      if (rate) log.warn(`[groq] ⚠ FREE-TIER RATE LIMIT hit on "${model}" (HTTP 429) — ${tail}`);
      else log.warn(`[groq] "${model}" age gate failed (${err.message}) — ${tail}`);
      continue;
    }
  }
  throw lastError || new Error('All Groq models failed');
}

module.exports = { ageGate, buildAgePrompt, parseVerdicts, FALLBACK_MODELS };
