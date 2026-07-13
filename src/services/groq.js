// LLM taste-RANKING via Groq (OpenAI-compatible Chat Completions).
// Phase 1 inversion: the LLM never generates titles from memory. Code builds a
// pre-approved candidate pool; the model only ranks those candidates (by ID)
// against the viewer's taste. Ranking-over-supplied-data is robust even on the
// weaker fallback model, and it cannot hallucinate a title it wasn't handed.
const API = 'https://api.groq.com/openai/v1/chat/completions';

// Model order for the RANKING task (quality = the model that reliably produces
// good rankings). llama-3.3-70b-versatile is primary: it ranks a 120-candidate
// pool cleanly and fast. openai/gpt-oss-120b — great for open-ended generation —
// empirically returns EMPTY content / 400 json_validate / 413 on this payload
// at free-tier limits (it burns the token budget on hidden reasoning), so it is
// only a fallback here. The chain fires on 429/error/invalid output. Override
// with GROQ_MODELS.
const DEFAULT_MODELS = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];
const FALLBACK_MODELS = (process.env.GROQ_MODELS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!FALLBACK_MODELS.length) FALLBACK_MODELS.push(...DEFAULT_MODELS);

// Build the ranking prompt. Candidates are compact (id/title/year/genres/rating,
// no overviews — token budget); the taste seed carries genres + overviews since
// that's where recent/unknown titles actually gain meaning.
function buildRankPrompt(type, taste, candidates, count) {
  const kind = type === 'series' ? 'TV series' : 'movies';
  const hist = taste.recent.map((h) => {
    const g = h.genres?.length ? ` [${h.genres.join(', ')}]` : '';
    const o = h.overview ? ` — ${h.overview}` : '';
    return `- ${h.title} (${h.year ?? '?'})${g}${o}`;
  }).join('\n');
  const pref = taste.topGenres?.length
    ? `\n\nTheir most-watched genres overall: ${taste.topGenres.join(', ')}. Weight toward these so a recent binge doesn't dominate.`
    : '';
  const cand = candidates.map((c) => JSON.stringify({
    id: c.id, title: c.title, year: c.year, genres: c.genres, rating: c.rating,
  })).join('\n');

  return `This viewer recently watched these ${kind} (most recent first):
${hist}${pref}

Below are ${candidates.length} pre-approved candidate ${kind}. Every one ALREADY satisfies all of the viewer's hard constraints (rating, recency, genre, age) — do NOT reject or filter any for those reasons. Your only job is to rank them by how well they match this viewer's taste.

Candidates (one JSON object per line):
${cand}

Return the ${count} best taste matches as a JSON array of objects, each with exactly:
- "id": the candidate id, copied verbatim (never invent one)
- "score": integer 0-100 taste match
Use the full score range; do not cluster on multiples of 5. Output ONLY the JSON array, no prose.
Example: [{"id":"tt1234567","score":91},{"id":"tt7654321","score":78}]`;
}

// Parse a ranking response into validated [{id, score}]. Tolerates fenced JSON,
// prose-wrapped arrays, and json-mode object wrappers ({"results":[...]}).
// Drops any id not in validIds (hallucination guard) and de-dupes.
function parseRanking(text, validIds) {
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
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x || typeof x.id !== 'string') continue;
    if (validIds && !validIds.has(x.id)) continue; // never trust an id we didn't supply
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const score = Number(x.score);
    out.push({ id: x.id, score: Number.isFinite(score) ? score : 0 });
  }
  return out;
}

async function callRankModel(apiKey, model, prompt) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a film and TV recommendation ranker. Rank ONLY the candidates supplied; reply with raw JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4, // ranking is a judgement task — lower temp = steadier ordering
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

// Rank a candidate pool → validated [{id, score}] (top `count`), requiring at
// least `minCount` valid ids. Walks the model fallback chain on rate-limit /
// error / invalid output, logging free-tier fallback clearly for diagnosis.
async function rankCandidates(apiKey, type, taste, candidates, log = console, count = 40, minCount = 20) {
  const validIds = new Set(candidates.map((c) => c.id));
  const prompt = buildRankPrompt(type, taste, candidates, count);
  log.log(`[groq] ranking ${candidates.length} ${type} candidates -> top ${count} (min ${minCount})`);
  const primary = FALLBACK_MODELS[0];
  let lastError = null;
  for (let i = 0; i < FALLBACK_MODELS.length; i++) {
    const model = FALLBACK_MODELS[i];
    try {
      const text = await callRankModel(apiKey, model, prompt);
      const ranked = parseRanking(text, validIds);
      if (ranked.length < minCount) throw new Error(`only ${ranked.length} valid ranked ids (< ${minCount})`);
      if (i === 0) {
        log.log(`[groq] ${type}: ranked ${ranked.length} by PRIMARY model ${model}`);
      } else {
        log.warn(`[groq] ${type}: ⚠ ranked by BACKUP model "${model}" — primary "${primary}" was unavailable (see above). ${ranked.length} items.`);
      }
      return ranked;
    } catch (err) {
      lastError = err;
      const rate = err.status === 429 || /rate.?limit|quota|free.?tier|too many requests/i.test(err.message);
      const next = FALLBACK_MODELS[i + 1];
      const tail = next ? `falling back to backup model "${next}"` : 'no backup models left — this rebuild will fail';
      if (rate) log.warn(`[groq] ⚠ FREE-TIER RATE LIMIT hit on "${model}" (HTTP 429) — ${tail}`);
      else log.warn(`[groq] "${model}" ranking failed (${err.message}) — ${tail}`);
      continue;
    }
  }
  throw lastError || new Error('All Groq models failed');
}

module.exports = { rankCandidates, buildRankPrompt, parseRanking, FALLBACK_MODELS };
