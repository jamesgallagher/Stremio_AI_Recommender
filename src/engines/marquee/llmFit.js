// Marquee ME-07 (spec §4.6/§6.2) — LLM fit: the LOCAL LLM judges how well the
// top candidates fit the profile's taste brief, as a 0–10 score folded into the
// deterministic score as the llm_fit feature.
//
// MI-3 graceful degradation: no brief, no local LLM chain, or the feature
// disabled → the scored list is returned UNCHANGED (same array, order, scores —
// NOT a re-sort). I1: the fit prompt never mentions age, suitability, children
// or classification appropriateness — the certification appears only as
// descriptive context. A neutral fit of 5 (feature 0.5) is applied to rows
// below the candidate cap and to items the LLM did not return — never cached.
const llmCache = require('./llmCache');
const features = require('./features');
const llm = require('../../services/llm');

const DAY_MS = 24 * 3600e3;

// The fit prompt (spec §6.2): the taste brief + a batch of items. The
// certification is given ONLY as descriptive context ("Classification: M") —
// deliberately no age/suitability/children/appropriateness instruction (I1).
// Exported so a test can assert the exact prompt shape.
function buildFitPrompt(brief, items) {
  const lines = [
    'You are judging how well each film fits a movie-watching profile.',
    '',
  ];
  if (brief) {
    lines.push('Profile brief:');
    for (const key of ['loves', 'avoids', 'moods', 'eras', 'standout_titles']) {
      const v = brief[key];
      if (v && v.length) lines.push(`- ${key}: ${v.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('For each film below, return a fit score 0-10 (10 = perfect fit) and a short reason (at most 14 words).');
  lines.push('');
  for (const it of items) {
    lines.push(`- id ${it.id}: "${it.title}" (${it.year ?? 'n.d.'})`);
    if (it.overview) lines.push(`  Overview: ${it.overview}`);
    if (it.director) lines.push(`  Director: ${it.director}`);
    if (it.keywords && it.keywords.length) lines.push(`  Keywords: ${it.keywords.join(', ')}`);
    if (it.cert) lines.push(`  Classification: ${it.cert}`);
  }
  lines.push('');
  lines.push('Respond with a JSON array: [{"id": "<id>", "fit": 0-10, "reason": "<= 14 words"}]');
  lines.push('Output ONLY the JSON array.');
  return lines.join('\n');
}

// PURE (spec §6.2): parse a fit batch. Ignores ids outside the batch; duplicate
// ids keep the first; fit is clamped to 0-10 (a non-number fit = the item is
// missing); reason is a trimmed string truncated to <= 14 words and <= 120
// chars, else null. Returns Map<id, {fit, reason}>.
function parseFit(arr, batchIds) {
  const valid = new Set(batchIds);
  const out = new Map();
  for (const e of Array.isArray(arr) ? arr : []) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id);
    if (!valid.has(id) || out.has(id)) continue; // unknown id / duplicate: keep first
    const fit = Number(e.fit);
    if (!Number.isFinite(fit)) continue; // non-number fit → item missing
    let reason = typeof e.reason === 'string' ? e.reason.trim() : null;
    if (reason === '') reason = null;
    if (reason) {
      const words = reason.split(/\s+/);
      if (words.length > 14) reason = words.slice(0, 14).join(' ');
      if (reason.length > 120) reason = null;
    }
    out.set(id, { fit: Math.max(0, Math.min(10, fit)), reason });
  }
  return out;
}

// ME-07 entry (spec §4.6). Returns the scored list with the llm_fit feature
// folded in, re-sorted rankScore desc (ties by tmdb_id).
async function applyLlmFit(profileId, scored, {
  brief, briefHash, cfg, chain, chat = llm.chat, log = console, onProgress = () => {}, now = Date.now(),
} = {}) {
  // MI-3: no brief, no local LLM, or the feature disabled → the list is
  // returned UNCHANGED (same array, order, scores — NOT a re-sort).
  if (!brief || !chain || !chain.length || cfg.llm_fit.enabled === false) return scored;

  const top = scored.slice(0, cfg.llm_fit.candidate_cap);

  // One cache lookup for the whole top set (kind 'fit', keyed tmdb_id:briefHash).
  const cached = llmCache.getMany(profileId, 'fit', top.map((r) => `${r.tmdb_id}:${briefHash}`), {
    ttlMs: cfg.llm_fit.ttl_days * DAY_MS, now,
  });
  const fitOf = new Map(); // tmdb_id → { fit, reason, cached }
  const uncached = [];
  for (const r of top) {
    const c = cached.get(`${r.tmdb_id}:${briefHash}`);
    if (c && typeof c === 'object' && typeof c.fit === 'number') {
      fitOf.set(r.tmdb_id, { fit: c.fit, reason: c.reason ?? null, cached: true });
    } else {
      uncached.push(r);
    }
  }

  // Batches of cfg.llm_fit.batch, SEQUENTIAL (single GPU — parallel just
  // times out). A batch that throws/times out → every item in it fit 5,
  // uncached; the next batch still runs.
  const batches = [];
  for (let i = 0; i < uncached.length; i += cfg.llm_fit.batch) batches.push(uncached.slice(i, i + cfg.llm_fit.batch));
  const timeoutMs = Number(process.env.MARQUEE_LLM_TIMEOUT_MS) || cfg.llm_fit.timeout_ms;
  let done = 0;
  for (const b of batches) {
    const items = b.map((r) => ({
      id: r.tmdb_id, title: r.title, year: r.year,
      overview: r._fit?.overview, director: r._fit?.director, keywords: r._fit?.keywords,
      cert: r.scoreComponents?.inputs?.cert,
    }));
    try {
      const arr = await chat(chain, [{ role: 'user', content: buildFitPrompt(brief, items) }], {
        temperature: 0, timeoutMs, validate: llm.extractArray,
      }, log);
      const parsed = parseFit(arr, b.map((r) => r.tmdb_id));
      for (const r of b) {
        const p = parsed.get(r.tmdb_id);
        if (p) {
          fitOf.set(r.tmdb_id, { fit: p.fit, reason: p.reason, cached: false });
          llmCache.put(profileId, 'fit', `${r.tmdb_id}:${briefHash}`, { fit: p.fit, reason: p.reason }, now);
        }
        // missing item → fit 5, reason null, NOT cached (the next build retries)
      }
    } catch (err) {
      log.warn(`[marquee] fit batch ${done + 1}/${batches.length} failed: ${err.message}`);
    }
    done += 1;
    onProgress(Math.round((done / batches.length) * 100), `LLM fit ${done}/${batches.length} batch(es)`);
  }

  // Fold in: llm_fit = fit/10 for EVERY row (neutral 5 below the cap and for
  // missing items — the feature set stays uniform), weights renormalized over
  // the existing weight keys ∪ llm_fit, rankScore recomputed.
  const result = scored.map((r) => {
    const f = fitOf.get(r.tmdb_id);
    const fit = f ? f.fit : 5;
    const reason = f ? f.reason : null;
    const feat = { ...r.scoreComponents.features, llm_fit: fit / 10 };
    const w = features.renormalize(cfg.weights, [...Object.keys(r.scoreComponents.weights), 'llm_fit']);
    const rankScore = features.weightedSum(feat, w) - r.scoreComponents.penalty;
    return {
      ...r,
      rankScore,
      reason: reason ?? (r._fit?.seedTitle ? `because you watched ${r._fit.seedTitle}` : null),
      scoreComponents: { ...r.scoreComponents, features: feat, weights: w, llm: { fit, reason, cached: f ? f.cached : false } },
    };
  });
  result.sort((a, b) => (b.rankScore - a.rankScore) || (a.tmdb_id < b.tmdb_id ? -1 : 1));
  return result;
}

module.exports = { applyLlmFit, buildFitPrompt, parseFit };
