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
const store = require('../store');

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

// AGE-1: the TV-14 variant of the age-gate prompt. The first two lines are
// replaced by the tier's own wording (substituting `{kind}`) — the candidate
// list and the return contract are identical to buildAgePrompt.
function buildTierAgePrompt(type, tier, titles) {
  const kind = type === 'series' ? 'TV series' : 'movies';
  const lines = titles.map((t) => JSON.stringify({
    id: t.id,
    title: t.title,
    year: t.year || undefined,
    genres: t.genres && t.genres.length ? t.genres : undefined,
    certification: t.certification || undefined,
    overview: t.overview ? String(t.overview).slice(0, 160) : undefined,
  })).join('\n');
  const wording = tier.llm.wording.replace('{kind}', kind);

  return `${wording}

Candidates (one JSON object per line):
${lines}

Return a JSON array with one object PER candidate, each with exactly:
- "id": the candidate id, copied verbatim (never invent one)
- "ok": true if suitable, false if not
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

// Run the age gate over `titles` ([{id,title,year,genres,certification,
// overview, cacheId?}]). Returns the Set of VETOED ids (matched on `id`).
// Requires verdicts for >= 60% of the list (a thinner response is rejected and
// the chain falls through to the next provider/model); throws when the WHOLE
// chain fails — kids-mode callers treat that as fail-closed: keep the previous
// list rather than serve an unverified one. Provider order (Custom → Groq
// primary → Groq backup) and the per-provider quirks (gpt-oss reasoning_effort,
// etc.) are handled in llm.chat.
//
// The verdict CACHE is keyed on `cacheId ?? id`. Callers pass the TMDB id as
// `cacheId` so all three gate sites (search + extra-catalog on IMDb ids, the
// nightly pool rebuild on TMDB ids) share ONE cache space — the rebuild's
// verdicts then pre-warm the request-path search cache and vice versa. `id`
// stays whatever the caller matches its own list on, so the returned veto Set
// is unaffected.
//
// AGE-1: `opts.tier` (optional) switches the LLM step to a tier's own wording
// and cache key. Without `opts.tier` the behaviour is byte-identical to before
// (the legacy age+1 judgement, keyed on the age limit). With it, the cache key
// is `${type}:${tier.llm.cacheKey}:${id}` (so TV-14 judgements never mix with
// the legacy age-14/15 caches) and the prompt's first two lines are the tier's
// wording.
async function ageGate(type, ageLimit, titles, log = console, opts = {}) {
  if (!titles.length) return new Set();
  const tier = opts.tier;

  // Persistent verdict cache first: a title's suitability at a given age is a
  // stable fact, so a title judged once is never re-sent to the LLM. This is the
  // fix for the search hang — without it, every keystroke re-judged the same
  // candidates and the Groq governor queue grew faster than it drained. Only
  // NEW titles fall through to the LLM below.
  const cache = store.loadAgeVerdicts();
  const keyOf = (t) => `${type}:${tier ? tier.llm.cacheKey : ageLimit}:${t.cacheId ?? t.id}`;
  const vetoed = new Set();
  const uncached = [];
  let hits = 0;
  for (const t of titles) {
    const v = cache[keyOf(t)];
    if (v === true) { hits++; continue; }          // known suitable — keep
    if (v === false) { hits++; vetoed.add(t.id); continue; } // known unsuitable — drop
    uncached.push(t);
  }

  if (!uncached.length) {
    log.log(`[llm] ${type}: age gate — ${vetoed.size} of ${titles.length} vetoed (all ${hits} cached)`);
    if (vetoed.size) {
      const names = titles.filter((t) => vetoed.has(t.id)).map((t) => t.title).join(', ');
      log.log(`[llm] ${type}: age-gate vetoed: ${names}`);
    }
    return vetoed;
  }

  // One judging round over `list`. `minFrac` = the share of the list the model must
  // answer for the response to be accepted (a thinner one falls through the chain).
  const judge = (list, minFrac, label) => {
    const validIds = new Set(list.map((t) => t.id));
    const prompt = tier ? buildTierAgePrompt(type, tier, list) : buildAgePrompt(type, ageLimit, list);
    if (process.env.AGEGATE_DEBUG_PROMPT === '1') {
      log.log(`[llm] full age-gate prompt for ${type} (${label}):\n----- PROMPT START -----\n${prompt}\n----- PROMPT END -----`);
    }
    const minVerdicts = Math.max(1, Math.ceil(list.length * minFrac));
    const validate = (text) => {
      const v = parseVerdicts(text, validIds);
      if (v.size < minVerdicts) throw new Error(`only ${v.size}/${list.length} verdicts`);
      return v;
    };
    return llm.chat(settings.llmChain(), [{ role: 'user', content: prompt }], { temperature: 0, system: REVIEWER_SYSTEM, validate }, log);
  };
  const verdicts = await judge(uncached, 0.6, `${uncached.length} new, ${hits} cached`);

  // A title the model OMITTED is re-asked ONCE on its own. If it is still unanswered it
  // gets no verdict here (not cached, so the next build judges it afresh); the chain
  // reports it as 'unknown' and ageVerification.verify() DROPS it (fail-closed).
  let missing = uncached.filter((t) => !verdicts.has(t.id));
  if (missing.length) {
    log.warn(`[llm] ${type}: age gate — ${missing.length} title(s) unanswered, re-asking once`);
    try {
      for (const [id, ok] of await judge(missing, 0, 're-ask')) verdicts.set(id, ok);
    } catch (err) { log.warn(`[llm] ${type}: age-gate re-ask failed — ${err.message}`); }
    missing = uncached.filter((t) => !verdicts.has(t.id));
    if (missing.length) log.warn(`[llm] ${type}: age gate — ${missing.length} title(s) the model would not judge will be dropped: ${missing.map((t) => t.title).join(', ')}`);
  }

  // Persist every definitive verdict (both directions — a veto is as stable as a
  // pass, and re-judging the vetoes is most of the cost). Verdicts come back keyed
  // on the prompt `id`, so map each back to its cache key (which may be the
  // caller's cacheId) before storing.
  const keyById = new Map(uncached.map((t) => [t.id, keyOf(t)]));
  let changed = false;
  for (const [id, ok] of verdicts) {
    const k = keyById.get(id);
    if (k) { cache[k] = ok; changed = true; }
    if (!ok) vetoed.add(id);
  }
  if (changed) store.saveAgeVerdicts(cache);

  log.log(`[llm] ${type}: age gate — ${vetoed.size} of ${titles.length} vetoed (${hits} cached, ${uncached.length} judged)`);
  if (vetoed.size) {
    const names = titles.filter((t) => vetoed.has(t.id)).map((t) => t.title).join(', ');
    log.log(`[llm] ${type}: age-gate vetoed: ${names}`);
  }
  return vetoed;
}

// AGE-3b: the anime borderline review prompt. The first line is the tier's
// wording ({kind} → anime); then the instruction; then one block per title
// (id, title (year), genres, MAL band, Kitsu rating, content tags, AniDB
// content, the trigger). Lines whose data is missing are omitted.
function buildAnimeReviewPrompt(tier, items) {
  const wording = tier.llm.wording.replace('{kind}', 'anime');
  const blocks = items.map((it) => {
    const lines = [`id: ${it.id}`];
    lines.push(`${it.title}${it.year ? ` (${it.year})` : ''}`);
    if (it.genres && it.genres.length) lines.push(`Genres: ${it.genres.join(', ')}`);
    if (it.mal && it.mal.code) lines.push(`MAL ${it.mal.code}${it.mal.minAge != null ? ` (${it.mal.minAge}+)` : ''}`);
    if (it.kitsu && it.kitsu.rating) lines.push(`Kitsu ${it.kitsu.rating}: ${it.kitsu.guide || ''}`);
    if (it.tags && it.tags.length) lines.push(`Tags: ${it.tags.map((t) => `${t.name} ${t.rank}%`).join(', ')}`);
    if (it.anidb && it.anidb.content) {
      const content = Object.entries(it.anidb.content).filter(([, v]) => v != null && v > 0);
      if (content.length) lines.push(`AniDB: ${content.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    if (it.trigger) lines.push(`Flagged because: ${it.trigger}`);
    return lines.join('\n');
  });

  return `${wording}

Each title below was already allowed by rating sources but shows content that may be unsuitable. You may only **reject** a title if the evidence shows content beyond that standard. Judge by the evidence, not the title's reputation. Reply with a JSON array of {"id":"…","ok":true|false,"reason":"…"} — reason at most 20 words, required when ok is false.

${blocks.join('\n\n')}`;
}

// AGE-3b: the anime borderline LLM review. `items` = [{ id, title, year,
// genres, mal, kitsu, tags:[{name,rank}], anidb:{…}, trigger }]. Returns
// Map<id, { ok, reason }>: ok === true → {ok:true, reason}; anything else →
// {ok:false, reason}; the reason is trimmed and cut to 20 words; an id the
// model omitted is absent. Throws when the whole chain fails (the caller
// decides). Runs exactly like ageGate: llm.chat with the reviewer system and
// a validator that drops hallucinated ids and requires verdicts for ≥ 60% of
// the items (else the chain falls to the next model).
async function animeAgeReview(tier, items, log = console) {
  if (!items.length) return new Map();
  const prompt = buildAnimeReviewPrompt(tier, items);
  const validIds = new Set(items.map((it) => it.id));
  const validate = (text) => {
    const arr = extractArray(text);
    const out = new Map();
    for (const x of arr) {
      if (!x || typeof x.id !== 'string') continue;
      if (!validIds.has(x.id)) continue; // hallucination guard
      if (out.has(x.id)) continue; // keep first
      out.set(x.id, x);
    }
    const minVerdicts = Math.ceil(items.length * 0.6);
    if (out.size < minVerdicts) throw new Error(`only ${out.size}/${items.length} verdicts`);
    return out;
  };
  const results = await llm.chat(
    settings.llmChain(), [{ role: 'user', content: prompt }],
    { temperature: 0, system: REVIEWER_SYSTEM, validate }, log,
  );
  const out = new Map();
  for (const [id, x] of results) {
    const ok = x.ok === true;
    let reason = x.reason != null ? String(x.reason).trim() : '';
    const words = reason.split(/\s+/).filter(Boolean);
    if (words.length > 20) reason = words.slice(0, 20).join(' ');
    out.set(id, { ok, reason });
  }
  return out;
}

// FG-1: titleFacts — ask the LLM for specific facts about a batch of titles.
// `titles` is an array of { title, type, needs, year?, imdb_id? } where `needs`
// is the per-title set of fact names to fetch (e.g. ['genres', 'year', 'rating']).
// Returns an array aligned with `titles` BY INDEX: each entry is
// { genres?, year?, rating? } or null (the model omitted the title or the
// answer was unparseable).
//
// B3: each title carries its own `needs` (not a shared list). The prompt sends
// `imdb_id` and `year` with each title to disambiguate remakes/same-name titles.
// The model echoes the `id` back; results are matched by that id (falling back
// to index position). `votes` is never asked (the LLM can't answer it sensibly).
//
// Uses the same endpoint/plumbing as ageGate (llm.chat with settings.llmChain()).
// Strict JSON out; any title the model omits or any unparseable answer is
// simply left missing. The prompt says: answer only if you know it, otherwise
// omit the title; never guess.
// FG-1: titleFacts — ask the LLM for specific facts about a batch of titles.
// `titles` is an array of { title, type, needs, year?, imdb_id? } where `needs`
// is the per-title set of fact names to fetch (e.g. ['genres', 'year', 'rating']).
// Returns an array aligned with `titles` BY INDEX: each entry is
// { genres?, year?, rating? } or null (the model omitted the title or the
// answer was unparseable).
//
// B3: each title carries its own `needs` (not a shared list). The prompt sends
// `imdb_id` and `year` with each title to disambiguate remakes/same-name titles.
// The model echoes the `id` back; results are matched by that id (falling back
// to index position). `votes` is never asked (the LLM can't answer it sensibly).
//
// Uses the same endpoint/plumbing as ageGate (llm.chat with settings.llmChain()).
// Strict JSON out; any title the model omits or any unparseable answer is
// simply left missing. The prompt says: answer only if you know it, otherwise
// omit the title; never guess.
async function titleFacts(type, titles, log = console) {
  if (!titles.length) return [];
  const kind = type === 'series' ? 'TV series' : 'movies';
  const allNeeds = new Set();
  for (const t of titles) for (const n of t.needs || []) allNeeds.add(n);
  const needList = [...allNeeds].join(', ');

  // Each line carries the id (imdb_id), title, year (when known), and the
  // per-title needs. The model echoes the id back.
  const lines = titles.map((t) => JSON.stringify({
    id: t.imdb_id || t.title,
    title: t.title,
    year: t.year != null ? t.year : undefined,
    needs: t.needs,
  })).join('\n');

  const prompt = `For each ${kind} below, answer ONLY the facts listed in its "needs" field.
Answer only if you know it; otherwise omit that title. Never guess.

Titles (one JSON object per line):
${lines}

Return a JSON array with one object PER title you can answer (omit titles you cannot), each with:
- "id": the id, copied verbatim from the input
- "genres": array of genre names (only if in that title's needs)
- "year": release year as a number (only if in that title's needs)
- "rating": IMDb rating as a number 0-10 (only if in that title's needs)
Output ONLY the JSON array, no prose.
Example: [{"id":"tt123","genres":["Sci-Fi","Thriller"],"year":2010,"rating":8.8}]`;

  // Valid ids: the set of ids we sent (imdb_id or title as fallback).
  const validIds = new Set(titles.map((t) => t.imdb_id || t.title));
  const validate = (text) => {
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
    if (!Array.isArray(parsed)) throw new Error('LLM did not return a JSON array');
    // Validate: drop hallucinated ids, keep first occurrence.
    const seen = new Set();
    const out = [];
    for (const x of parsed) {
      if (!x || typeof x.id !== 'string') continue;
      if (!validIds.has(x.id)) continue;
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      out.push(x);
    }
    return out;
  };

  try {
    const results = await llm.chat(
      settings.llmChain(), [{ role: 'user', content: prompt }],
      { temperature: 0, system: 'You are a film and television database. Reply with raw JSON only.', validate }, log,
    );
    // Align results with the input titles BY ID (the model echoes the id back).
    const byId = new Map(results.map((r) => [r.id, r]));
    return titles.map((t) => {
      const r = byId.get(t.imdb_id || t.title);
      if (!r) return null;
      const out = {};
      const needs = t.needs || [];
      if (needs.includes('genres') && Array.isArray(r.genres)) out.genres = r.genres;
      if (needs.includes('year') && r.year != null) out.year = r.year;
      if (needs.includes('rating') && r.rating != null) out.rating = r.rating;
      return Object.keys(out).length ? out : null;
    });
  } catch (err) {
    // The whole LLM chain failed: return null for every title.
    log.warn(`[llm] titleFacts batch failed (${err.message})`);
    return titles.map(() => null);
  }
}

module.exports = {
  ageGate,
  buildAgePrompt,
  buildTierAgePrompt,
  parseVerdicts,
  animeAgeReview,
  buildAnimeReviewPrompt,
  titleFacts,
};
