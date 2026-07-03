// Gemini recommendation generation.
// Prompt structure and 429 model-fallback chain adapted from the reference addon
// (rocsx/stremiorecomendacion), parameterized per profile.
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Highest quality first; on 429/quota we fall through to the next.
const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
];

const ASK_COUNT = 25; // ask for more than we need; hard filters will drop some

function buildPrompt(type, history, filters, excludeTitles) {
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
  rules.push(`Do not include ${kind} I already watched.`);

  const excludeBlock = excludeTitles.length
    ? `\nDo absolutely NOT include these titles I already watched:\n- ${excludeTitles.slice(0, 80).join('\n- ')}`
    : '';

  return `Based on the following ${kind} I recently watched:
${historyText}

Recommend ${ASK_COUNT} ${kind} I might like. Consider similar themes, genres, actors, and creators.
CRITICAL RULES YOU MUST FOLLOW:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}${excludeBlock}

Output ONLY a JSON array of objects. No markdown, no explanations, just the raw JSON. Each object must have exactly two properties:
- "title": The title in English (string)
- "year": The release year (number)
Example: [{"title": "Severance", "year": 2022}, {"title": "The Last of Us", "year": 2023}]`;
}

function parseJsonArray(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Gemini did not return a JSON array');
  return parsed
    .filter((x) => x && typeof x.title === 'string')
    .map((x) => ({ title: x.title, year: Number(x.year) || null }));
}

async function callModel(apiKey, model, prompt) {
  const res = await fetch(`${API}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const err = new Error(`Gemini ${model} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini ${model} returned empty response`);
  return parseJsonArray(text);
}

// Returns [{title, year}] suggestions — treated as suggestions, not ground truth.
// Every title must still resolve against TMDB before it can appear in a catalog.
async function getSuggestions(apiKey, type, history, filters, excludeTitles, log = console) {
  const prompt = buildPrompt(type, history, filters, excludeTitles);
  let lastError = null;
  for (const model of FALLBACK_MODELS) {
    try {
      const result = await callModel(apiKey, model, prompt);
      log.log(`[gemini] ${type}: ${result.length} suggestions from ${model}`);
      return result;
    } catch (err) {
      lastError = err;
      const quota = err.status === 429 || /quota/i.test(err.message);
      if (quota) {
        log.warn(`[gemini] ${model} quota exhausted, trying next model`);
        continue;
      }
      // Non-quota errors on the primary model: try one fallback anyway
      // (transient 500s are common on free tier), then give up.
      log.warn(`[gemini] ${model} error: ${err.message}`);
      continue;
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

module.exports = { getSuggestions, buildPrompt, parseJsonArray, FALLBACK_MODELS };
