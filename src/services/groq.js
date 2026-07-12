// LLM recommendation generation via Groq (OpenAI-compatible Chat Completions).
// Groq's API is a drop-in for OpenAI's /chat/completions. Prompt structure and
// the 429 model-fallback chain are preserved from the original design,
// parameterized per profile.
const API = 'https://api.groq.com/openai/v1/chat/completions';

// Quality first: a recommender should favour the best recommendations over
// throughput. The fallback chain only triggers on 429/error, so preferring the
// heavier model costs nothing while it's available. Override with GROQ_MODELS.
//  - openai/gpt-oss-120b: highest-quality, most sophisticated taste-matching
//    (spends reasoning tokens, tighter free-tier limits). Primary.
//  - llama-3.3-70b-versatile: strong and fast with the most rate-limit
//    headroom — the fallback when gpt-oss-120b is throttled.
//  - gpt-oss-20b / llama-3.1-8b-instant: lighter last-resort fallbacks.
const DEFAULT_MODELS = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];
const FALLBACK_MODELS = (process.env.GROQ_MODELS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!FALLBACK_MODELS.length) FALLBACK_MODELS.push(...DEFAULT_MODELS);

function buildPrompt(type, history, filters, excludeTitles, askCount = 25) {
  const kind = type === 'series' ? 'TV series' : 'movies';
  const historyText = history.map((m) => `${m.title} (${m.year})`).join(', ');

  const rules = [];
  rules.push('Only recommend well-known titles that are easy to find in databases like IMDB/TMDB.');
  rules.push('Prioritize critically acclaimed, high-quality productions over pure popularity to avoid low-rated content.');
  if (filters.min_rating > 0) {
    rules.push(`ONLY recommend ${kind} with a TMDB/IMDB audience rating of ${filters.min_rating.toFixed(1)} or higher.`);
  }
  if (filters.max_age_years > 0) {
    rules.push(`ONLY recommend ${kind} released in the last ${filters.max_age_years} years.`);
  }
  if (filters.excluded_genres.length > 0) {
    rules.push(`NEVER recommend anything in these genres: ${filters.excluded_genres.join(', ')}.`);
  }
  if (filters.age_limit > 0) {
    rules.push(`Every recommendation MUST be age-appropriate for a viewer aged ${filters.age_limit} or younger, with a Common Sense Media age rating of ${filters.age_limit}+ or lower. Family and children's ${kind} only — no exceptions.`);
  }
  rules.push(`Do not include the ${kind} listed above that I already watched.`);

  // Exclusions here are titles already suggested this rebuild plus recently-
  // listed titles from earlier rebuilds (variety). Watched-history enforcement
  // is done locally on canonical IDs after TMDB resolution — never via the prompt.
  const excludeBlock = excludeTitles.length
    ? `\nYou already suggested the following titles — do NOT suggest them again, suggest different ones:\n- ${excludeTitles.slice(0, 100).join('\n- ')}`
    : '';

  return `Based on the following ${kind} I recently watched:
${historyText}

Recommend ${askCount} ${kind} I might like. Consider similar themes, genres, actors, and creators.
CRITICAL RULES YOU MUST FOLLOW:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}${excludeBlock}

Output ONLY a JSON array of objects. No markdown, no explanations, just the raw JSON. Each object must have exactly two properties:
- "title": The title in English (string)
- "year": The release year (number)
Example: [{"title": "Severance", "year": 2022}, {"title": "The Last of Us", "year": 2023}]`;
}

// Tolerant parse: accepts a bare JSON array, a fenced array, an array wrapped
// in prose, OR an object that wraps the array under some key (json-mode models
// like llama return {"recommendations": [...]}). Returns [{title, year}].
function parseJsonArray(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Salvage the outermost array (preferred) or object block from prose.
    const aStart = cleaned.indexOf('[');
    const aEnd = cleaned.lastIndexOf(']');
    const oStart = cleaned.indexOf('{');
    const oEnd = cleaned.lastIndexOf('}');
    let block = null;
    if (aStart !== -1 && aEnd > aStart) block = cleaned.slice(aStart, aEnd + 1);
    else if (oStart !== -1 && oEnd > oStart) block = cleaned.slice(oStart, oEnd + 1);
    if (!block) throw err;
    parsed = JSON.parse(block);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' ? Object.values(parsed).find(Array.isArray) : null);
  if (!Array.isArray(arr)) throw new Error('LLM did not return a JSON array');
  return arr
    .filter((x) => x && typeof x.title === 'string')
    .map((x) => ({ title: x.title, year: Number(x.year) || null }));
}

async function callModel(apiKey, model, prompt) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a film and TV recommendation engine. Reply with raw JSON only — no markdown, no commentary.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8, // some variety between rebuilds without going off-taste
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
  return parseJsonArray(text);
}

// Returns [{title, year}] suggestions — treated as suggestions, not ground truth.
// Every title must still resolve against TMDB before it can appear in a catalog.
async function getSuggestions(apiKey, type, history, filters, excludeTitles, log = console, askCount = 25) {
  const prompt = buildPrompt(type, history, filters, excludeTitles, askCount);
  log.log(`[groq] full prompt for ${type}:\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`);
  const primary = FALLBACK_MODELS[0];
  let lastError = null;
  for (let i = 0; i < FALLBACK_MODELS.length; i++) {
    const model = FALLBACK_MODELS[i];
    try {
      const result = await callModel(apiKey, model, prompt);
      // Make backup-model usage obvious in the logs: the primary succeeding is
      // routine (info); a fallback serving is notable (warn) — it means the
      // primary was rate-limited/errored above.
      if (i === 0) {
        log.log(`[groq] ${type}: ${result.length} suggestions from PRIMARY model ${model}`);
      } else {
        log.warn(`[groq] ${type}: ⚠ served by BACKUP model "${model}" — primary "${primary}" was unavailable (see rate-limit/error above). ${result.length} suggestions.`);
      }
      log.log(`[groq] suggested: ${result.map((r) => `${r.title} (${r.year ?? '?'})`).join(', ')}`);
      return result;
    } catch (err) {
      lastError = err;
      const rate = err.status === 429 || /rate.?limit|quota|free.?tier|too many requests/i.test(err.message);
      const next = FALLBACK_MODELS[i + 1];
      const tail = next ? `falling back to backup model "${next}"` : 'no backup models left — this rebuild will fail';
      if (rate) {
        log.warn(`[groq] ⚠ FREE-TIER RATE LIMIT hit on "${model}" (HTTP 429) — ${tail}`);
      } else {
        log.warn(`[groq] "${model}" failed (${err.message}) — ${tail}`);
      }
      continue;
    }
  }
  throw lastError || new Error('All Groq models failed');
}

module.exports = { getSuggestions, buildPrompt, parseJsonArray, FALLBACK_MODELS };
