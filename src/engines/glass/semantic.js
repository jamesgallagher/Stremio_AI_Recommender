// Glass semantic-similarity layer (Phase C / GE-09, design §4.4/§5.2) — the
// optional, evidence-gated vector layer. When enabled it embeds candidate +
// watched-title content on the LOCAL /embeddings endpoint, builds a recency-
// weighted TASTE VECTOR (the "mushy centroid" is mitigated by recency-weighting;
// clustering is a noted later refinement), and folds cosine similarity in as the
// `semantic_similarity` feature.
//
// SAFE + MEASURABLE: off by default (cfg.embeddings.enabled). When on, the feature
// is computed and STORED in score_components even though weights.semantic_similarity
// defaults to 0 — so lift can be measured before it ever changes ranking. Degrades
// to a no-op on any failure (no endpoint, timeout, malformed) — never throws.
const embeddings = require('../../services/embeddings');
const embedStore = require('./embedStore');
const metaStore = require('./metaStore');
const events = require('./events');
const { weightedScore } = require('./scoring');
const { blendedWeight } = require('./tasteModel');
const { halfLivesFor } = require('./config');

const DAY_MS = 24 * 3600e3;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// A compact content string for one enriched title — what actually gets embedded.
// Title + genres + plot overview (the main semantic signal) + auteur/cast/themes.
function contentString(meta) {
  if (!meta) return '';
  const parts = [];
  if (meta.title) parts.push(meta.year ? `${meta.title} (${meta.year})` : meta.title);
  if (meta.genres?.length) parts.push(meta.genres.join(', '));
  if (meta.overview) parts.push(meta.overview);
  if (meta.director?.length) parts.push(`Directed by ${meta.director.join(', ')}`);
  if (meta.cast?.length) parts.push(`Starring ${meta.cast.slice(0, 3).join(', ')}`);
  if (meta.keywords?.length) parts.push(`Themes: ${meta.keywords.slice(0, 8).join(', ')}`);
  return parts.join('. ');
}

// Get vectors for `items` ([{tmdb_id, text}]) under `model`: cache hits from the
// embedStore, one batched embed() for the misses (then cached). Returns
// Map<tmdb_id, number[]>. `embedFn(texts) -> Promise<number[][]>` is injectable.
async function embedTitles(type, items, model, embedFn) {
  const out = embedStore.getMany(type, items.map((i) => i.tmdb_id), model);
  const misses = items.filter((i) => !out.has(String(i.tmdb_id)) && i.text);
  if (misses.length) {
    const vecs = await embedFn(misses.map((i) => i.text));
    for (let i = 0; i < misses.length; i++) {
      const v = vecs[i];
      if (Array.isArray(v) && v.length) { embedStore.put(type, misses[i].tmdb_id, model, v); out.set(String(misses[i].tmdb_id), v); }
    }
  }
  return out;
}

// Recency-weighted centroid of the profile's WATCHED-title vectors → the taste
// vector. Returns null when there's nothing to build one from.
async function buildTasteVector(profileId, type, cfg, model, embedFn, { nowMs = Date.now() } = {}) {
  const hl = halfLivesFor(cfg, type);
  const blend = cfg.horizon_blend;
  const cap = cfg.embeddings?.taste_cap || 150;
  const watched = events.buildEventList(profileId, type, cfg, { nowMs })
    .filter((e) => e.kind === 'watched')
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, cap);
  if (!watched.length) return null;
  const metas = metaStore.getMany(type, watched.map((e) => e.tmdb_id));
  const items = watched.filter((e) => metas.has(e.tmdb_id)).map((e) => ({ tmdb_id: e.tmdb_id, text: contentString(metas.get(e.tmdb_id)) }));
  if (!items.length) return null;
  const vecs = await embedTitles(type, items, model, embedFn);
  let centroid = null; let total = 0;
  for (const e of watched) {
    const v = vecs.get(String(e.tmdb_id));
    if (!v) continue;
    const days = Number.isNaN(e.ts) ? 0 : Math.max(0, (nowMs - e.ts) / DAY_MS);
    const w = blendedWeight(days, hl, blend);
    if (!centroid) centroid = new Array(v.length).fill(0);
    for (let i = 0; i < v.length && i < centroid.length; i++) centroid[i] += w * v[i];
    total += w;
  }
  return total > 0 ? centroid : null;   // magnitude is irrelevant (cosine); direction is recency-tilted
}

// Fold semantic_similarity into the scored candidates. Returns a re-sorted array
// (or the input unchanged on any failure / when disabled). `embedFn` + `model`
// come from the engine (settings.embedConfig); injectable for tests.
async function applySemantic(profile, type, scored, taste, cfg, { model, embedFn, nowMs = Date.now(), log = console, onProgress = () => {} } = {}) {
  if (!cfg.embeddings?.enabled) return scored;
  if (!model || typeof embedFn !== 'function') return scored;   // no local endpoint → degrade
  if (!Array.isArray(scored) || !scored.length) return scored;
  try {
    onProgress(10, 'Glass: building taste vector…');
    const tasteVec = await buildTasteVector(profile.id, type, cfg, model, embedFn, { nowMs });
    if (!tasteVec) return scored;

    const cap = Math.min(scored.length, cfg.embeddings.candidate_cap || 150);
    const head = scored.slice(0, cap);
    const metas = metaStore.getMany(type, head.map((c) => c.tmdb_id));
    const items = head.filter((c) => metas.has(String(c.tmdb_id))).map((c) => ({ tmdb_id: c.tmdb_id, text: contentString(metas.get(String(c.tmdb_id))) }));
    onProgress(50, `Glass: embedding ${items.length} ${type} candidate(s)…`);
    const vecs = await embedTitles(type, items, model, embedFn);

    for (const c of head) {
      const v = vecs.get(String(c.tmdb_id));
      if (!v) continue;
      const sim = clamp01(embeddings.cosine(tasteVec, v));      // cosine → [0,1] (negatives = unrelated)
      if (c.score_components?.features) {
        c.score_components.features.semantic_similarity = sim;
        // Re-derive rankScore with the feature present. weights.semantic_similarity
        // defaults to 0 (measure-only), so ordering is unchanged until it's weighted.
        c.rankScore = weightedScore(c.score_components.features, cfg.weights);
      }
    }
    scored.sort((a, b) => b.rankScore - a.rankScore);
    onProgress(100, `Glass: semantic pass over ${items.length} ${type} candidate(s)`);
    return scored;
  } catch (err) {
    log.warn(`[glass] semantic layer (${type}) skipped — ${err.message}; deterministic score kept`);
    return scored;
  }
}

module.exports = { applySemantic, buildTasteVector, contentString, embedTitles };
