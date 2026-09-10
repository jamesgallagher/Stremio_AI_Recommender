// Local embeddings transport (Glass GE-09, design §5.2) — an OpenAI-compatible
// `/embeddings` client, the `embed()` sibling of llm.chat. LOCAL ONLY by decision
// (GD-2): the vectors come from an embedding model on the same box as the custom
// chat LLM (a SEPARATE model from the chat "Qwen" — chat models embed poorly),
// e.g. nomic-embed-text / bge-*. No cloud embeddings (that reintroduces the API
// limits GD-2 avoids), so this never touches Groq and is not rate-governed.
//
// The transport is provider-agnostic OpenAI v1: POST {model, input:[...]} to
// `${base}/embeddings` → { data:[{embedding:[...]}] }. It throws on any failure;
// every Glass caller degrades to "no semantic feature" rather than failing a build.
const EMBED_PATH = '/embeddings';
const embedUrl = (base) => `${String(base).replace(/\/+$/, '')}${EMBED_PATH}`;
const TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) || Number(process.env.CUSTOM_LLM_TIMEOUT_MS) || 25000;

// Embed a batch of strings → number[][] (one vector per input, input order
// preserved). `cfg` = { uri, model, apiKey } (settings.embedConfig()). Throws on
// HTTP error, timeout, or a malformed/short response.
async function embed(cfg, inputs, { log = console, timeoutMs = TIMEOUT_MS } = {}) {
  if (!cfg || !cfg.uri || !cfg.model) throw new Error('no embeddings endpoint configured');
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length) return [];
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(embedUrl(cfg.uri), {
      method: 'POST', headers, body: JSON.stringify({ model: cfg.model, input: list }), signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`embeddings timed out after ${timeoutMs}ms`);
    throw err;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`embeddings failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : null;
  if (!rows || rows.length !== list.length) throw new Error('embeddings response shape mismatch');
  // OpenAI returns rows with an `index`; sort by it to guarantee input alignment.
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r) => {
    const v = r.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error('embeddings response missing a vector');
    return v;
  });
}

// Cosine similarity of two equal-length numeric vectors. Returns 0 for a zero
// vector or a length mismatch (never NaN) — a safe neutral for scoring.
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { embed, cosine, embedUrl };
