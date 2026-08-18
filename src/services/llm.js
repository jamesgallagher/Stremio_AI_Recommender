// LLM transport (v6). Provider-aware chat over an ordered chain:
//   custom (local, OpenAI v1) → Groq primary → Groq backup
// The chain comes from global settings (settings.llmChain). Domain prompts and
// parsing stay in services/groq.js; this module only knows how to talk to a
// provider and how to fall through to the next one.
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

// One request to one model on one provider. Returns the message content string.
// Groq: strict json_object + reasoning_effort:low on gpt-oss (proven in v5.2.1).
// Custom: minimal body (model/messages/temperature) for maximum local-server
// compatibility — we lean on tolerant parsing rather than forcing response_format,
// which many local runtimes reject.
async function callProvider(provider, model, messages, { temperature = 0 } = {}) {
  const isGroq = provider.type === 'groq';
  const url = isGroq ? GROQ_URL : chatUrl(provider.uri);
  const body = { model, messages, temperature };
  if (isGroq) {
    body.response_format = { type: 'json_object' };
    if (/^openai\/gpt-oss/.test(model)) body.reasoning_effort = 'low';
  }
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`${provider.label || provider.type}/${model} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
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
async function chat(chain, messages, { temperature = 0, validate = (t) => t, system } = {}, log = console) {
  if (!chain.length) throw new Error('No LLM provider configured (set a custom endpoint or a Groq key in Server Config)');
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  let lastErr = null;
  for (const provider of chain) {
    for (const model of modelsFor(provider)) {
      try {
        return validate(await callProvider(provider, model, msgs, { temperature }));
      } catch (err) {
        lastErr = err;
        log.warn(`[llm] ${provider.label || provider.type}/${model}: ${err.message} — trying next`);
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
// work. Three checks, each returning {name, ok, detail}. The endpoint is only
// worth enabling if all pass (docs/v6-ui.md).
async function testCustomLlm({ name, uri, apiKey } = {}, log = console) {
  const provider = { type: 'custom', name: name || 'custom', uri, apiKey, label: 'custom' };
  const model = name || 'default';
  const checks = [];
  const run = async (label, fn) => {
    try { const detail = await fn(); checks.push({ name: label, ok: true, detail }); return true; }
    catch (err) { checks.push({ name: label, ok: false, detail: err.message }); return false; }
  };

  if (!uri) return { ok: false, checks: [{ name: 'config', ok: false, detail: 'No URI provided' }] };

  // 1. OpenAI shape — a trivial call must return choices[0].message.content.
  const shapeOk = await run('OpenAI v1 chat/completions shape', async () => {
    const txt = await callProvider(provider, model, [{ role: 'user', content: 'Reply with the single word: ok' }], { temperature: 0 });
    return `responded (${txt.slice(0, 40).replace(/\s+/g, ' ')})`;
  });

  // 2. Generation JSON task — must return a parseable [{title,year}].
  let genOk = false;
  if (shapeOk) {
    genOk = await run('JSON generation task', async () => {
      const txt = await callProvider(provider, model, [
        { role: 'system', content: 'Reply with raw JSON only.' },
        { role: 'user', content: 'Return a JSON array of exactly 2 objects, each {"title": string, "year": number}. Example: [{"title":"Inception","year":2010}]' },
      ], { temperature: 0 });
      const arr = extractArray(txt);
      if (!arr.length || typeof arr[0]?.title !== 'string') throw new Error('parsed but not {title,year} objects');
      return `parsed ${arr.length} title(s)`;
    });
  }

  // 3. Age-gate JSON task — must return a parseable [{id,ok}].
  let gateOk = false;
  if (shapeOk) {
    gateOk = await run('JSON age-gate task', async () => {
      const txt = await callProvider(provider, model, [
        { role: 'system', content: 'Reply with raw JSON only.' },
        { role: 'user', content: 'For each candidate return {"id": the id, "ok": boolean}. Candidates: [{"id":"tt1","title":"Bluey"},{"id":"tt2","title":"Saw"}]. Output ONLY a JSON array.' },
      ], { temperature: 0 });
      const arr = extractArray(txt);
      if (!arr.length || typeof arr[0]?.id !== 'string' || typeof arr[0]?.ok !== 'boolean') throw new Error('parsed but not {id,ok} objects');
      return `parsed ${arr.length} verdict(s)`;
    });
  }

  return { ok: shapeOk && genOk && gateOk, checks };
}

module.exports = { chat, callProvider, testCustomLlm, extractArray, GROQ_MODELS, chatUrl };
