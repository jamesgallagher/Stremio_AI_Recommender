// Glass LLM semantic rerank + explanations (Phase B / GE-08, design §4.4) — the
// PRIMARY semantic layer (GD-2: the free local chat model, promoted ahead of
// vector embeddings). It reorders the strongest deterministic slice and writes
// natural-language "because…" reasons, running ONLY in the background build.
//
// Prefer-local, degrade-to-deterministic (design §4.4): the rerank uses ONLY the
// custom/local provider from settings.llmChain — it NEVER spills a 100+-title
// rerank pass onto Groq's rate-limited quota. No local endpoint, a timeout, a
// malformed reply, or an empty result → the deterministic GE-06 order is returned
// unchanged. So this is a pure enhancement: Glass is fully functional without it.
//
// STRUCTURALLY SAFE (submitted §29): the model only reorders + annotates a set of
// candidates WE produced. It cannot reintroduce a watched title (not in the list,
// and the pipeline re-subtracts regardless), bypass the age gate (runs after,
// over the pool), or invent metadata (unknown ids are dropped; the only thing we
// take from the model is the ordering and a display-only reason string). It never
// touches rankScore's SCALE — it permutes the existing top-N score band, so the
// reranked head stays above the un-reranked tail and the affinity ordering stays
// valid (I6).
const llm = require('../../services/llm');

// Top-N entries of a dim affinity object, by weight, as bare keys.
function topKeys(obj, n) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

// A compact taste summary for the prompt — names only (a collection-id franchise
// key `c:<id>` isn't human-readable, so only network-name `n:` franchises show).
function tasteSummary(taste) {
  const d = taste.dims || {};
  return {
    genres: topKeys(d.genres, 6),
    directors: topKeys(d.directors, 5),
    franchises: topKeys(d.franchises, 6).filter((k) => k.startsWith('n:')).map((k) => k.slice(2)),
    keywords: topKeys(d.keywords, 8),
    decades: topKeys(d.decades, 3),
  };
}

// A one-line "why it matched" hint per candidate, from its stored intersects.
function matchHint(cand) {
  const m = cand.score_components?.matched || {};
  const bits = [];
  if (m.director?.length) bits.push(`director ${m.director[0]}`);
  if (m.franchise?.length) bits.push(`franchise ${m.franchise[0]}`);
  if (m.cast?.length) bits.push(`cast ${m.cast[0]}`);
  if (m.keywords?.length) bits.push(`themes ${m.keywords.slice(0, 3).join('/')}`);
  if ((cand.sources || []).includes('exploration')) bits.push('a fresh direction');
  return bits.join('; ');
}

const SYSTEM = 'You re-rank film/TV recommendations for one viewer and explain each pick. '
  + 'Reply with RAW JSON ONLY — no prose, no markdown fences.';

function buildUserPrompt(type, summary, items) {
  const kind = type === 'series' ? 'TV shows' : 'movies';
  const lines = items.map((it) => `${it.id}: "${it.title}"${it.year ? ` (${it.year})` : ''}`
    + `${it.genres.length ? ` [${it.genres.join(', ')}]` : ''}${it.why ? ` — ${it.why}` : ''}`);
  return [
    `This viewer's taste (${kind}):`,
    `- genres: ${summary.genres.join(', ') || 'n/a'}`,
    `- directors: ${summary.directors.join(', ') || 'n/a'}`,
    `- franchises/networks: ${summary.franchises.join(', ') || 'n/a'}`,
    `- recurring themes: ${summary.keywords.join(', ') || 'n/a'}`,
    `- favoured eras: ${summary.decades.join('s, ') || 'n/a'}`,
    '',
    `Candidate ${kind} (id: title):`,
    ...lines,
    '',
    'Return a JSON array ordering these BEST-FIRST for this viewer, one object per '
    + 'candidate: {"id": <the id>, "reason": "<=14 words on why it fits this viewer"}. '
    + 'Use ONLY the ids above, each exactly once. Output ONLY the JSON array.',
  ].join('\n');
}

// Reorder + annotate the strongest slice of `scored` (GE-06 output, rankScore
// desc). `chain` MUST be the local-only provider list (the caller filters
// settings.llmChain to type 'custom'); `chat` is injectable for tests (defaults
// to llm.chat). Returns a NEW array (same members, reordered) or the input
// unchanged on any failure. Never throws.
async function rerankCandidates(type, scored, taste, cfg, { chain, chat = llm.chat, log = console, onProgress = () => {} } = {}) {
  const rc = cfg.rerank || {};
  if (rc.enabled === false) return scored;
  if (!Array.isArray(chain) || !chain.length) return scored;      // prefer-local: no local endpoint → deterministic
  if (!Array.isArray(scored) || scored.length < 2) return scored;

  const cap = Math.min(scored.length, Math.max(2, rc.candidate_cap || 120));
  const head = scored.slice(0, cap);
  const tail = scored.slice(cap);
  const items = head.map((c) => ({
    id: c.tmdb_id,
    title: c.title || '',
    year: c.year || null,
    genres: (c.genres || '').split(',').filter(Boolean).slice(0, 3),
    why: matchHint(c),
  }));

  // Background call → its own generous timeout (env override wins), NOT the tight
  // request-path Custom default the age gate shares.
  const timeoutMs = Number(process.env.GLASS_RERANK_TIMEOUT_MS) || rc.timeout_ms || 120000;
  onProgress(10, `Glass: LLM re-ranking ${items.length} ${type} candidate(s) (timeout ${Math.round(timeoutMs / 1000)}s)…`);
  const startedAt = Date.now();
  let ordered;
  try {
    ordered = await chat(chain, [{ role: 'user', content: buildUserPrompt(type, tasteSummary(taste), items) }],
      { temperature: 0, system: SYSTEM, validate: llm.extractArray, timeoutMs }, log);
  } catch (err) {
    log.warn(`[glass] LLM rerank (${type}) skipped after ${Math.round((Date.now() - startedAt) / 1000)}s — ${err.message}; keeping deterministic order`);
    return scored;
  }
  if (!Array.isArray(ordered) || !ordered.length) return scored;

  // Validate the model's order against the head set: keep known ids, once each,
  // in the model's order; append any head item the model dropped (original order).
  const byId = new Map(head.map((c) => [String(c.tmdb_id), c]));
  const seen = new Set();
  const newHead = [];
  for (const o of ordered) {
    const id = String((o && (o.id ?? o.tmdb_id)) ?? '');
    const c = byId.get(id);
    if (!c || seen.has(id)) continue;                            // unknown/duplicate id → ignored (can't invent)
    seen.add(id);
    const reason = o && typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : null;
    if (reason) c.reason = reason;                               // → because_title (§39 explanation)
    if (c.score_components) c.score_components.rerank = { by: 'llm', reason: reason || c.reason || null };
    newHead.push(c);
  }
  if (!seen.size) return scored;                                 // nothing usable → deterministic
  for (const c of head) if (!seen.has(String(c.tmdb_id))) newHead.push(c);

  // Re-stamp the head's ORIGINAL descending score band onto the new order — the
  // reranked block occupies exactly the slots it already held, so it stays above
  // the tail and remains a valid affinity ordering (I6). features stay as the
  // deterministic breakdown; score_components.rerank records that a reorder ran.
  const band = head.map((c) => c.rankScore);
  for (let i = 0; i < newHead.length; i++) newHead[i].rankScore = band[i];

  log.log(`[glass] LLM rerank (${type}): reordered ${seen.size}/${head.length} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  onProgress(100, `Glass: LLM re-ranked ${seen.size} ${type} candidate(s)`);
  return [...newHead, ...tail];
}

module.exports = { rerankCandidates, tasteSummary, matchHint, buildUserPrompt };
