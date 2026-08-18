// LLM recommendation prompts + parsing. The DOMAIN layer: it builds the
// generation and age-gate prompts and parses the results. The TRANSPORT — which
// provider/model actually answers, and the fallback chain — lives in
// services/llm.js (v6). This file no longer talks HTTP; it hands a prompt +
// validator to llm.chat and gets back a parsed result.
//
// v6: the provider chain is global (Custom local endpoint → Groq primary →
// Groq backup), sourced from Server Config, NOT a per-profile Groq key. So the
// two entry points below take no apiKey — the chain is resolved from settings.
const llm = require('./llm');
const settings = require('../settings');

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

// Pull a JSON array out of a model response. Tolerates fenced JSON,
// prose-wrapped arrays, and json-mode object wrappers ({"results":[...]}).
function extractArray(text) {
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
  return arr;
}

// Parse verdicts into Map<id, boolean>. Ids not in validIds are dropped
// (hallucination guard); duplicates keep the first verdict.
function parseVerdicts(text, validIds) {
  const arr = extractArray(text);
  const out = new Map();
  for (const x of arr) {
    if (!x || typeof x.id !== 'string') continue;
    if (validIds && !validIds.has(x.id)) continue;
    if (out.has(x.id)) continue;
    out.set(x.id, x.ok === true);
  }
  return out;
}

const REVIEWER_SYSTEM = 'You are a strict parental-guidance reviewer for Australian audiences. Reply with raw JSON only.';
const CURATOR_SYSTEM = 'You are a film and television curator with broad knowledge of world cinema, TV and anime. Reply with raw JSON only.';

// Run the age gate over `titles` ([{id,title,year,genres,certification,
// overview}]). Returns the Set of VETOED ids. Requires verdicts for >= 60% of
// the list (a thinner response is rejected and the chain falls through to the
// next provider/model); throws when the WHOLE chain fails — kids-mode callers
// treat that as fail-closed: keep the previous list rather than serve an
// unverified one. Provider order (Custom → Groq primary → Groq backup) and the
// per-provider quirks (gpt-oss reasoning_effort, etc.) are handled in llm.chat.
async function ageGate(type, ageLimit, titles, log = console) {
  if (!titles.length) return new Set();
  const validIds = new Set(titles.map((t) => t.id));
  const prompt = buildAgePrompt(type, ageLimit, titles);
  log.log(`[llm] full age-gate prompt for ${type}:\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`);
  const minVerdicts = Math.ceil(titles.length * 0.6);
  const validate = (text) => {
    const verdicts = parseVerdicts(text, validIds);
    if (verdicts.size < minVerdicts) throw new Error(`only ${verdicts.size}/${titles.length} verdicts`);
    return verdicts;
  };
  const verdicts = await llm.chat(
    settings.llmChain(), [{ role: 'user', content: prompt }],
    { temperature: 0, system: REVIEWER_SYSTEM, validate }, log,
  );
  const vetoed = new Set([...verdicts.entries()].filter(([, ok]) => !ok).map(([id]) => id));
  log.log(`[llm] ${type}: age gate — ${vetoed.size} of ${titles.length} vetoed`);
  if (vetoed.size) {
    const names = titles.filter((t) => vetoed.has(t.id)).map((t) => t.title).join(', ');
    log.log(`[llm] ${type}: age-gate vetoed: ${names}`);
  }
  return vetoed;
}

// ---- Generation pass (v5 'ai' engine) ----
// The reason this exists: Trakt's collaborative filtering is structurally
// blind to age. It answers "what do people with this history watch next", and
// for a 13-year-old anime viewer the nearest neighbours are ADULT anime
// viewers. Filtering that output afterwards is rescue work; here age is a
// constraint at generation time.
//
// Output is a SUGGESTION, never ground truth — every title is resolved against
// TMDB, run through the deterministic filters, and vetted by a second pass
// before anyone sees it.
// Seeds arrive as a weighted mix of the viewer's own history for this type and
// borrowed history from the other type (see rebuild.seedsFor). They MUST be
// presented as separate, labelled groups: given a flat list, the model reads
// "Haikyu" in a movie prompt as a film and starts proposing spin-offs of
// things that aren't films. Labelled, it makes the useful jump instead —
// anime series in, anime films out.
function renderSeeds(seeds, type) {
  if (!seeds.length) return '(no watch history yet — recommend well-regarded, widely-loved titles)';
  const label = (t) => (t === 'series' ? 'TV series' : 'films');
  const fmt = (s) => `- ${s.title}${s.year ? ` (${s.year})` : ''}`;
  const otherType = type === 'movie' ? 'series' : 'movie';
  const own = seeds.filter((s) => (s.type || type) === type);
  const other = seeds.filter((s) => (s.type || type) !== type);

  const parts = [];
  if (own.length) parts.push(`Recently watched ${label(type)}:\n${own.map(fmt).join('\n')}`);
  if (other.length) {
    parts.push(`Recently watched ${label(otherType)} — a different format, so read these for taste (genre, tone, sensibility), not as titles to sequel or spin off:\n${other.map(fmt).join('\n')}`);
  }
  if (!own.length && other.length) {
    parts.push(`This viewer has not watched many ${label(type)} yet, so infer what they would enjoy from the ${label(otherType)} above. Do not fall back on generic crowd-pleasers — their taste is already visible.`);
  }
  return parts.join('\n\n');
}

function buildGeneratePrompt(type, { ageLimit = 0, seeds = [], count = 50, excludedGenres = [] } = {}) {
  const kind = type === 'series' ? 'TV series' : 'movies';
  const seedList = renderSeeds(seeds, type);
  // The age line has to do two jobs. Left as just "suitable for a 14-year-old",
  // models read it as "safe for children" and return Powerpuff Girls to a
  // shonen-anime watcher — technically compliant, useless in practice. So it
  // states the ceiling AND that the ceiling is not the target.
  const ageLine = ageLimit > 0
    ? `\nHARD REQUIREMENT: every title must be suitable for a ${ageLimit}-year-old, judged against Australian classification standards (ACB). This is not a preference to balance against popularity — if a title is acclaimed or beloved but not appropriate for a ${ageLimit}-year-old, leave it out. Anime is welcome, but the same age rule applies to it: many well-known anime series are aimed at adults.

The age is a CEILING, not a target. This viewer is ${ageLimit}, not a small child: recommend titles that a ${ageLimit}-year-old would actually choose, sitting near the top of what is appropriate for that age. Do NOT fall back on programmes made for young children, and do not water down the genre, tone or intensity that the watch history shows. Match their taste first, then apply the ceiling.`
    : '';
  const excl = excludedGenres.length
    ? `\nDo not recommend anything in these genres: ${excludedGenres.join(', ')}.`
    : '';

  return `Recommend ${count} ${kind} for the viewer whose recent watching is shown below.

Recently watched:
${seedList}
${ageLine}${excl}

Rules:
- Recommend real ${kind} that genuinely exist. Never invent a title.
- Do NOT recommend anything already listed above.
- Use the best-known English title, plus its release year.
- Favour variety: do not fill the list with one franchise, one studio or one genre.

Return a JSON array of ${count} objects, each with exactly:
- "title": the title
- "year": the release year as a number
Output ONLY the JSON array, no prose.
Example: [{"title":"Spirited Away","year":2001}]`;
}

// Parse [{title, year}] from a model response. Deduped case-insensitively;
// entries without a usable title are dropped, a missing year is tolerated
// (TMDB resolution can usually manage without it).
function parseTitles(text, limit = 200) {
  const out = [];
  const seen = new Set();
  for (const x of extractArray(text)) {
    if (!x || typeof x.title !== 'string') continue;
    const title = x.title.trim();
    if (!title) continue;
    const parsedYear = Number.parseInt(x.year, 10);
    const year = Number.isFinite(parsedYear) ? parsedYear : null;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, year });
    if (out.length >= limit) break;
  }
  return out;
}

// Generate candidate titles. Returns [{title, year}]. A near-empty generation
// is treated as a FAILURE (not a thin success), so the chain falls through to
// the next provider/model rather than shipping 4 titles. Throws when the whole
// chain fails — kids callers treat that as fail-closed (keep the previous list).
async function generateCandidates(type, opts = {}, log = console) {
  const count = opts.count || 50;
  const prompt = buildGeneratePrompt(type, { ...opts, count });
  const minTitles = Math.ceil(count * 0.4);
  const validate = (text) => {
    const titles = parseTitles(text, count * 2);
    if (titles.length < minTitles) throw new Error(`only ${titles.length}/${count} titles`);
    return titles;
  };
  const titles = await llm.chat(
    settings.llmChain(), [{ role: 'user', content: prompt }],
    { temperature: 0.6, system: CURATOR_SYSTEM, validate }, log,
  );
  log.log(`[llm] ${type}: generated ${titles.length} candidate(s)${opts.ageLimit ? ` (age-aware, ${opts.ageLimit}yo)` : ''}`);
  return titles;
}

module.exports = {
  ageGate,
  buildAgePrompt,
  parseVerdicts,
  buildGeneratePrompt,
  parseTitles,
  generateCandidates,
};
