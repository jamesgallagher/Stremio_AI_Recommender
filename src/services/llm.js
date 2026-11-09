// LLM transport (v6). Provider-aware chat over an ordered chain:
//   custom (local, OpenAI v1) → Groq primary → Groq backup
// The chain comes from global settings (settings.llmChain). Domain prompts and
// parsing stay in services/groq.js; this module only knows how to talk to a
// provider and how to fall through to the next one.
const governor = require('./governor');
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Groq model order within the Groq providers (override with GROQ_MODELS).
// gpt-oss-120b primary, gpt-oss-20b fallback — see the v5.2.1 migration note in
// groq.js for why both llama models were dropped.
const DEFAULT_GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const GROQ_MODELS = (process.env.GROQ_MODELS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!GROQ_MODELS.length) GROQ_MODELS.push(...DEFAULT_GROQ_MODELS);

const CHAT_PATH = '/chat/completions';
const chatUrl = (base) => `${String(base).replace(/\/+$/, '')}${CHAT_PATH}`;

// Per-request timeout. The age gate runs on the SEARCH request path with no
// timeout of its own — a hung provider (queue-stuck Groq, a dead/overloaded
// local box) used to block the whole search until Stremio abandoned it and a
// kids profile fail-closed to nothing. So each call is bounded and a timeout is
// just another fall-through in the chain. Groq is fast, so it's held to a tight
// bound; a local model can legitimately take far longer, so Custom gets a much
// larger default. Both are env-overridable (a slow local box, a bad network).
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS) || 8000;
const CUSTOM_TIMEOUT_MS = Number(process.env.CUSTOM_LLM_TIMEOUT_MS) || 25000;
const timeoutFor = (provider) => (provider.type === 'groq' ? GROQ_TIMEOUT_MS : CUSTOM_TIMEOUT_MS);
// Each Groq key has its OWN governor lane: rate limits (and a 429 Retry-After /
// exhausted quota) are per key, so a throttled primary must not stall the backup.
const groqLane = (provider) => (provider.label === 'groq-backup' ? 'groq_backup' : 'groq');

// ---- Provider health / failover ------------------------------------------------
// The chain (custom → groq-primary → groq-backup) always fell through on error,
// but every call still re-tried a dead provider first: a down local box cost a
// full 25s timeout PER call, and an exhausted Groq key was re-hit before the
// backup was reached. This tracks which providers are currently unavailable so
// the chain skips straight past them:
//   - connection error / timeout / 5xx  → "down": cooldown that doubles per
//     consecutive failure (30s → 5min cap). When it lapses the next call is a
//     half-open probe — success clears it, failure re-arms a longer cooldown.
//   - 401/402/403 (bad key, out of credits/billing) → long cooldown (15min).
//   - 429 with a long Retry-After (quota) → cooldown for that window (≤1h).
// If EVERY provider is cooling down we still try them all (a stale cooldown must
// never turn into "no answer"; callers fail-closed on a throw).
const DOWN_BASE_MS = Number(process.env.LLM_DOWN_COOLDOWN_MS) || 30000;
const DOWN_MAX_MS = 5 * 60000;
const EXHAUSTED_MS = Number(process.env.LLM_EXHAUSTED_COOLDOWN_MS) || 15 * 60000;
const MAX_INLINE_WAIT_MS = 10000; // a Groq 429 backoff longer than this → fail over, don't sleep
const health = new Map(); // label -> { downUntil, fails, reason }
const labelOf = (p) => p.label || p.type;

function isCoolingDown(provider, now = Date.now()) {
  const h = health.get(labelOf(provider));
  return !!h && h.downUntil > now;
}
function markDown(provider, reason, ms, log = console, now = Date.now()) {
  const label = labelOf(provider);
  const h = health.get(label) || { fails: 0 };
  h.fails += 1;
  const wait = ms != null ? ms : Math.min(DOWN_BASE_MS * 2 ** (h.fails - 1), DOWN_MAX_MS);
  const wasUp = !h.downUntil || h.downUntil <= now;
  h.downUntil = now + wait;
  h.reason = reason;
  health.set(label, h);
  if (wasUp) log.warn(`[llm] ${label} unavailable (${reason}) — failing over; retry in ${Math.round(wait / 1000)}s`);
}
function markUp(provider, log = console) {
  const label = labelOf(provider);
  if (health.delete(label)) log.log(`[llm] ${label} recovered`);
}
// 'down' (transport/5xx/timeout), 'exhausted' (key/credit), 'rate' (429), 'other'
// (bad content etc. — says nothing about provider health).
function classify(err) {
  const st = err && err.status;
  if (st === 401 || st === 402 || st === 403) return 'exhausted';
  if (st === 429) return 'rate';
  if (st >= 500) return 'down';
  if (err && (err.transport || err.timedOut)) return 'down';
  return 'other';
}
// Diagnostics (GET /api/llm-health): labels + state only, never keys.
function healthSnapshot(now = Date.now()) {
  const out = {};
  for (const [label, h] of health) {
    out[label] = { available: h.downUntil <= now, reason: h.reason, retry_in_ms: Math.max(0, h.downUntil - now), consecutive_failures: h.fails };
  }
  return out;
}
function _resetHealth() { health.clear(); }

// One request to one model on one provider. Returns the message content string.
// Groq: strict json_object + reasoning_effort:low on gpt-oss (proven in v5.2.1).
// Custom: minimal body (model/messages/temperature) for maximum local-server
// compatibility — we lean on tolerant parsing rather than forcing response_format,
// which many local runtimes reject.
async function callProvider(provider, model, messages, { temperature = 0, timeoutMs: timeoutOverride } = {}) {
  const isGroq = provider.type === 'groq';
  const url = isGroq ? GROQ_URL : chatUrl(provider.uri);
  const body = { model, messages, temperature };
  if (isGroq) {
    body.response_format = { type: 'json_object' };
    if (/^openai\/gpt-oss/.test(model)) body.reasoning_effort = 'low';
  } else {
    // Local reasoning models (Qwen3.x "thinking", etc.) otherwise emit thousands
    // of chain-of-thought tokens before the answer — a 6-title age gate measured
    // at 65s / ~4300 output tokens, vs ~0.6s / ~30 tokens with thinking OFF, for
    // IDENTICAL verdicts. The gate is a yes/no classification that needs no
    // deliberation, so thinking is disabled. Servers that don't recognise
    // chat_template_kwargs (llama.cpp, vLLM both do) ignore the unknown field.
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  // The abort timer starts when the fetch actually fires (inside doFetch), NOT
  // when the call is queued — otherwise a call waiting behind the Groq governor
  // would time out before it ever ran. Only Groq is rate-governed; the local
  // Custom LLM has no quota to respect. A caller MAY override the per-provider
  // default (e.g. the Glass background rerank, which legitimately needs far
  // longer than the request-path age gate the Custom default is sized for).
  const timeoutMs = timeoutOverride || timeoutFor(provider);
  const doFetch = () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };
  let res;
  try {
    if (isGroq) {
      // The governor sleeps through a 429 backoff (Retry-After) — fine for a few
      // seconds, but an exhausted quota would stall the request for minutes.
      // Past MAX_INLINE_WAIT_MS fail over instead of waiting.
      const lane = groqLane(provider);
      const wait = governor.pendingWait(lane);
      if (wait > MAX_INLINE_WAIT_MS) {
        const e = new Error(`${provider.label || provider.type}/${model} rate-limited (backoff ${Math.round(wait / 1000)}s)`);
        e.status = 429; e.retryAfterMs = wait;
        throw e;
      }
      res = await governor.schedule(lane, doFetch);
    } else {
      res = await doFetch();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`${provider.label || provider.type}/${model} timed out after ${timeoutMs}ms`);
      e.timedOut = true;
      throw e;
    }
    if (!err.status && !err.retryAfterMs) err.transport = true; // fetch failed: refused/DNS/reset
    throw err;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`${provider.label || provider.type}/${model} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
    throw err;
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${provider.label || provider.type}/${model} returned empty content`);
  return text;
}

// Models to try for a provider: Groq iterates its model list; custom is the one
// configured model name.
function modelsFor(provider) {
  return provider.type === 'groq' ? GROQ_MODELS : [provider.name || 'default'];
}

// Run a chat across the whole chain. `validate(content)` returns the parsed
// result or throws — a throw (or an empty/HTTP error) advances to the next
// model, then the next provider. Throws if the entire chain fails, so callers
// (age gate, generation) fail-closed exactly as before.
async function chat(chain, messages, { temperature = 0, validate = (t) => t, system, timeoutMs } = {}, log = console) {
  if (!chain.length) throw new Error('No LLM provider configured (set a custom endpoint or a Groq key in Server Config)');
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  let lastErr = null;
  // Skip providers known to be unavailable; if that leaves nothing, try them all.
  const live = chain.filter((p) => !isCoolingDown(p));
  for (const provider of (live.length ? live : chain)) {
    for (const model of modelsFor(provider)) {
      try {
        const out = validate(await callProvider(provider, model, msgs, { temperature, timeoutMs }));
        markUp(provider, log);
        return out;
      } catch (err) {
        lastErr = err;
        const kind = classify(err);
        log.warn(`[llm] ${labelOf(provider)}/${model}: ${err.message} — trying next`);
        // Provider-level failures end this provider's turn (its other models share
        // the outage/key) and park it so later calls skip straight to the next one.
        if (kind === 'down') {
          markDown(provider, err.timedOut ? 'timeout' : (err.status ? `HTTP ${err.status}` : 'unreachable'), null, log);
          break;
        }
        if (kind === 'exhausted') { markDown(provider, `HTTP ${err.status} — key/credits`, EXHAUSTED_MS, log); break; }
        if (kind === 'rate' && err.retryAfterMs > MAX_INLINE_WAIT_MS) {
          markDown(provider, 'rate/quota limited', Math.min(err.retryAfterMs, 60 * 60000), log);
          break;
        }
      }
    }
  }
  throw lastErr || new Error('All LLM providers failed');
}

// Tolerant JSON-array extractor for the Test (kept local to avoid a circular
// dep with groq.js).
function extractArray(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    const a = cleaned.indexOf('['); const b = cleaned.lastIndexOf(']');
    if (a === -1 || b <= a) throw new Error('no JSON array found');
    parsed = JSON.parse(cleaned.slice(a, b + 1));
  }
  const arr = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' ? Object.values(parsed).find(Array.isArray) : null);
  if (!Array.isArray(arr)) throw new Error('response was not a JSON array');
  return arr;
}

// Custom LLM "Test" — proves the endpoint is not just reachable but can do OUR
// work. The three checks are named steps so the portal can run them one at a
// time and show live progress ("Running test 1/3 …"). Each returns
// {name, ok, detail}. The endpoint is only worth enabling if all pass.
const TEST_STEPS = ['shape', 'generation', 'agegate'];
const STEP_LABELS = { shape: 'OpenAI v1 shape', generation: 'JSON generation task', agegate: 'JSON age-gate task' };

async function runStep(provider, model, step) {
  if (step === 'shape') {
    const txt = await callProvider(provider, model, [{ role: 'user', content: 'Reply with the single word: ok' }], { temperature: 0 });
    return `responded (${txt.slice(0, 40).replace(/\s+/g, ' ')})`;
  }
  if (step === 'generation') {
    const txt = await callProvider(provider, model, [
      { role: 'system', content: 'Reply with raw JSON only.' },
      { role: 'user', content: 'Return a JSON array of exactly 2 objects, each {"title": string, "year": number}. Example: [{"title":"Inception","year":2010}]' },
    ], { temperature: 0 });
    const arr = extractArray(txt);
    if (!arr.length || typeof arr[0]?.title !== 'string') throw new Error('parsed but not {title,year} objects');
    return `parsed ${arr.length} title(s)`;
  }
  if (step === 'agegate') {
    const txt = await callProvider(provider, model, [
      { role: 'system', content: 'Reply with raw JSON only.' },
      { role: 'user', content: 'For each candidate return {"id": the id, "ok": boolean}. Candidates: [{"id":"tt1","title":"Bluey"},{"id":"tt2","title":"Saw"}]. Output ONLY a JSON array.' },
    ], { temperature: 0 });
    const arr = extractArray(txt);
    if (!arr.length || typeof arr[0]?.id !== 'string' || typeof arr[0]?.ok !== 'boolean') throw new Error('parsed but not {id,ok} objects');
    return `parsed ${arr.length} verdict(s)`;
  }
  throw new Error(`unknown test step: ${step}`);
}

// Run one step (when `step` is given) or all three. One-step mode powers the
// portal's live per-test progress; all-mode is kept for programmatic callers.
async function testCustomLlm({ name, uri, apiKey, step } = {}, log = console) {
  if (!uri) return { ok: false, checks: [{ name: 'config', ok: false, detail: 'No URI provided' }] };
  const provider = { type: 'custom', name: name || 'custom', uri, apiKey, label: 'custom' };
  const model = name || 'default';
  const one = async (s) => {
    try { return { name: STEP_LABELS[s], ok: true, detail: await runStep(provider, model, s) }; }
    catch (err) { return { name: STEP_LABELS[s], ok: false, detail: err.message }; }
  };

  if (step) {
    if (!TEST_STEPS.includes(step)) return { ok: false, checks: [{ name: 'step', ok: false, detail: `unknown step: ${step}` }] };
    const r = await one(step);
    return { ok: r.ok, step, checks: [r] };
  }

  const checks = [];
  for (const s of TEST_STEPS) {
    const r = await one(s);
    checks.push(r);
    if (!r.ok) break; // a failed step makes later steps meaningless
  }
  return { ok: checks.length === TEST_STEPS.length && checks.every((c) => c.ok), checks };
}

module.exports = { chat, callProvider, testCustomLlm, extractArray, TEST_STEPS, STEP_LABELS, GROQ_MODELS, chatUrl, healthSnapshot, _resetHealth };
