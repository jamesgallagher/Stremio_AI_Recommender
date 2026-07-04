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

  // Exclusions here are ONLY titles Gemini already suggested in earlier
  // rounds of this same rebuild (round 1 sends none). Watched-history
  // enforcement is done locally on canonical IDs after TMDB resolution —
  // never via the prompt.
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
async function getSuggestions(apiKey, type, history, filters, excludeTitles, log = console, askCount = 25) {
  const prompt = buildPrompt(type, history, filters, excludeTitles, askCount);
  log.log(`[gemini] full prompt for ${type}:\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`);
  let lastError = null;
  for (const model of FALLBACK_MODELS) {
    try {
      const result = await callModel(apiKey, model, prompt);
      log.log(`[gemini] ${type}: ${result.length} suggestions from ${model}`);
      log.log(`[gemini] suggested: ${result.map((r) => `${r.title} (${r.year ?? '?'})`).join(', ')}`);
      return result;
    } catch (err) {
      lastError = err;
      const quota = err.status === 429 || /quota/i.test(err.message);
      log.warn(`[gemini] ${model} ${quota ? 'quota exhausted' : `error: ${err.message}`} — trying next model`);
      continue;
    }
  }
  throw lastError || new Error('All Gemini models failed');
}

module.exports = { getSuggestions, buildPrompt, parseJsonArray, FALLBACK_MODELS };
