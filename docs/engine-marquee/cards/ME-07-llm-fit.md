# ME-07 — LLM pointwise fit scoring + reasons

**Depends on:** ME-06 (ME-04 cache table) · **Blocks:** ME-09 · Spec: §6.3, §7

## Deliverable
`src/engines/marquee/llmFit.js`
```js
applyLlmFit(profileId, scored, { brief, briefHash, cfg, chain, chat, log, onProgress }) -> scored'
```
- If there's no `brief`, an empty `chain` (local-only), or `cfg.llm_fit.enabled === false`, return `scored` unchanged.
- Take the top `cfg.llm_fit.candidate_cap` (250). For each, a cache lookup in `marquee_llm_cache`
  (`kind='fit'`, key `${tmdb_id}:${briefHash}`, TTL `cfg.llm_fit.ttl_days` = 14).
- Send uncached items in batches of `cfg.llm_fit.batch` (20). The prompt includes the brief + items
  (`id, title, year, overview[:160], director, keywords[:5], cert`) and asks for
  `[{id, fit:0-10, reason:"<=14 words"}]`. Use `llm.chat(chain, …, {validate: llm.extractArray, timeoutMs})`.
- Validation: ids must be in the batch; `fit` is clamped 0–10; a missing item gets `fit=5`, not cached.
  If a batch errors or times out, that batch keeps `fit=5` (uncached) and the rest continue.
- Fold `llm_fit = fit/10` into features, recompute `rankScore` with the full weight vector (renormalised),
  set `reason` from the LLM (fallback: `because you watched <strongest seed title>`), re-sort.

## Traps
- Local only: `chain = settings.llmChain(ctx.settings).filter(p => p.type === 'custom')`. Never Groq.
- Don't mention age or classification suitability in the prompt. The cert is given only as
  descriptive context.
- The timeout comes from env `MARQUEE_LLM_TIMEOUT_MS` or `cfg.llm_fit.timeout_ms` (60000).

## Tests
Stubbed chat: an invented id is ignored, a missing id gets 5, a cache hit skips the call, one
failing batch doesn't sink the others, `reason` populates `because_title` via the pipeline normalize.

## Acceptance
Tests pass. With no local LLM the output is identical to ME-06's.
