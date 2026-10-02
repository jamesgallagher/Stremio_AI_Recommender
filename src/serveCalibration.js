// Calibrated serving (spec §16) — the pure helpers + the per-profile taste
// target store.
//
// The served list's genre mix should match the person's own taste mix, built
// greedily from the best-scored films (Steck, Netflix, RecSys 2018): at each
// step pick the remaining window row that maximises
//   U = (1−λ)·Σ normScore − λ·KL(target ‖ mix)
// where the mix counts each film fractionally (1/k per genre of a k-genre
// film). A quality window keeps only the top `window_factor × list_size`
// filter-passing rows as candidates, so a liked genre with no strong candidate
// is simply under-filled — never a weak filler (C2). The full ordering is
// independent of the caller's limit (C3): every caller takes a prefix.
//
// The pure helpers here are network-free and DB-free (K1–K9); the target store
// (§3.2) is the only thing that touches SQLite, and only on the build/serve
// path — never on the network.
const db = require('./db');

// §3.1 — PURE helpers ------------------------------------------------------

// A row's genre list: `row.genres` (full CSV) else `row.primary_genre`, split
// on commas, trimmed, minus 'Anime', de-duplicated. Empty when the row has no
// genre signal at all.
function rowGenres(row) {
  const csv = (row && (row.genres || row.primary_genre)) || '';
  const seen = new Set();
  const out = [];
  for (const g of csv.split(',')) {
    const t = g.trim();
    if (!t || t === 'Anime' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// The genre mix of a row list: Map<genre, share>, each film counted
// fractionally (1/k to each of its k genres), normalised to sum to 1. Rows
// with no genres are skipped; an empty list → an empty Map.
function genreMix(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const gs = rowGenres(r);
    if (!gs.length) continue;
    for (const g of gs) counts.set(g, (counts.get(g) || 0) + 1 / gs.length);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const out = new Map();
  if (total > 0) for (const [g, v] of counts) out.set(g, v / total);
  return out;
}

// The taste TARGET from a profile's watched films: films = [{ genres: […],
// weight }]. Weights ≤ 0 are ignored; each film's weight is split 1/k across
// its genres; the result is normalised to sum 1 and returned as a plain object
// { genre: share } sorted by share descending. Empty → {}.
function computeTarget(films) {
  const counts = new Map();
  for (const f of films || []) {
    const w = Number(f && f.weight);
    if (!Number.isFinite(w) || w <= 0) continue;
    const gs = (f.genres || []).map((g) => String(g).trim()).filter(Boolean);
    if (!gs.length) continue;
    for (const g of gs) counts.set(g, (counts.get(g) || 0) + w / gs.length);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return {};
  const out = {};
  for (const [g, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) out[g] = v / total;
  return out;
}

// Drop excluded genres from a target and renormalise the rest to sum 1. All
// excluded → {}. `excludedGenres` is a list of genre names.
function applyExclusions(target, excludedGenres) {
  const excluded = new Set(excludedGenres || []);
  const out = {};
  let total = 0;
  for (const [g, v] of Object.entries(target || {})) {
    if (excluded.has(g)) continue;
    out[g] = v;
    total += v;
  }
  if (!total) return {};
  for (const g of Object.keys(out)) out[g] = out[g] / total;
  return out;
}

// KL(p ‖ q) with smoothing: Σ_g p(g)·ln(p(g) / ((1−α)·q(g) + α·p(g))) over the
// genres of `p`. `p` is a plain object {genre: share}; `q` is a Map (or object).
// 0 when q = p; > 0 otherwise.
function klDivergence(p, q, alpha = 0.01) {
  const qMap = q instanceof Map ? q : new Map(Object.entries(q || {}));
  let s = 0;
  for (const [g, pv] of Object.entries(p || {})) {
    if (!(pv > 0)) continue;
    const qv = qMap.get(g) || 0;
    const qtilde = (1 - alpha) * qv + alpha * pv;
    s += pv * Math.log(pv / qtilde);
  }
  return s;
}

// §3.3 — the calibrated full ordering.
//
// `rows` are the filter-passing pool rows, already sorted by score descending.
// `target` is the taste target (plain object {genre: share}). `opts`:
//   listSize        the profile's list size (NOT the caller's limit)
//   lambda          = 0.5        score-vs-mix blend
//   windowFactor    = 3          W = windowFactor × listSize candidate rows
//   klAlpha         = 0.01       KL smoothing
//   wildcardSlots   = 0          discovery slots (OFF by default)
//   wildcardMaxShare= 0.05       a genre qualifies for a wildcard only if its
//                                target share is below this
//   wildcardPosition= 6          1-based position of the first wildcard slot
//
// Returns a NEW array — the full ordering, independent of the caller's limit
// (C3). Every caller takes a prefix.
function calibratedOrder(rows, target, opts = {}) {
  const lambda = opts.lambda ?? 0.5;
  const windowFactor = opts.windowFactor ?? 3;
  const klAlpha = opts.klAlpha ?? 0.01;
  const wildcardSlots = opts.wildcardSlots ?? 0;
  const wildcardMaxShare = opts.wildcardMaxShare ?? 0.05;
  const wildcardPosition = opts.wildcardPosition ?? 6;
  const listSize = opts.listSize ?? 20;

  const all = rows || [];
  const W = Math.min(all.length, windowFactor * listSize);
  const window = all.slice(0, W);
  const rest = all.slice(W);

  // Normalised scores over the window: (score − minW) / (maxW − minW || 1).
  const raw = window.map((r) => r.affinity || 0);
  const minW = raw.length ? Math.min(...raw) : 0;
  const maxW = raw.length ? Math.max(...raw) : 0;
  const span = (maxW - minW) || 1;
  const normByRow = new Map(window.map((r, i) => [r, (raw[i] - minW) / span]));

  // Greedy set-selection over the whole window: at each step pick the remaining
  // row maximising U(S∪{r}) = (1−λ)·Σ normScore − λ·KL(target, mix(S∪{r})).
  // Ties break by higher score, then tmdb_id string order (C9).
  const S = [];
  let pool = window.slice();
  let sumNorm = 0;
  while (pool.length) {
    let best = null;
    let bestU = -Infinity;
    for (const r of pool) {
      const U = (1 - lambda) * (sumNorm + normByRow.get(r))
        - lambda * klDivergence(target, genreMix([...S, r]), klAlpha);
      if (U > bestU) { bestU = U; best = r; continue; }
      if (U === bestU && best !== null) {
        const sa = r.affinity || 0;
        const sb = best.affinity || 0;
        if (sa > sb || (sa === sb && String(r.tmdb_id) < String(best.tmdb_id))) best = r;
      }
    }
    S.push(best);
    sumNorm += normByRow.get(best);
    pool = pool.filter((r) => r !== best);
  }

  let order = [...S, ...rest];

  // Wildcard (discovery) slots — OFF by default (wildcardSlots 0). When ≥1 and
  // the list is long enough to hold the slot, each slot takes the highest-scored
  // row among the top 2W that is not already in the first listSize positions and
  // whose genres ALL have target share below wildcardMaxShare (a missing genre
  // counts as 0). It is removed from its old position and placed at the slot.
  if (wildcardSlots > 0 && listSize > wildcardPosition) {
    const top2W = all.slice(0, 2 * W);
    const targetMap = target instanceof Map ? target : new Map(Object.entries(target || {}));
    for (let slot = 0; slot < wildcardSlots; slot++) {
      const firstSet = new Set(order.slice(0, listSize));
      let pick = null;
      for (const r of top2W) {
        if (firstSet.has(r)) continue;
        const gs = rowGenres(r);
        if (!gs.length) continue;
        if (!gs.every((g) => (targetMap.get(g) || 0) < wildcardMaxShare)) continue;
        if (pick === null || (r.affinity || 0) > (pick.affinity || 0)
          || ((r.affinity || 0) === (pick.affinity || 0) && String(r.tmdb_id) < String(pick.tmdb_id))) pick = r;
      }
      if (!pick) break; // no qualifier → skip (order unchanged)
      order.splice(order.indexOf(pick), 1);
      order.splice(wildcardPosition - 1 + 7 * slot, 0, pick);
    }
  }

  return order;
}

// §3.2 — the per-profile taste target store (SQLite). ----------------------

function initTargets() {
  db.get().exec(`CREATE TABLE IF NOT EXISTS serve_targets (
    profile_id TEXT NOT NULL, type TEXT NOT NULL, engine_id TEXT NOT NULL,
    target TEXT NOT NULL,            -- JSON {genre: share}
    film_count INTEGER NOT NULL, computed_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, type));`);
}

// Store (or replace) a profile's taste target for a type.
function setTarget(profileId, type, engineId, target, filmCount, now) {
  initTargets();
  db.get().prepare(
    'INSERT OR REPLACE INTO serve_targets (profile_id, type, engine_id, target, film_count, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(profileId, type, engineId, JSON.stringify(target || {}), filmCount, now);
}

// Read a profile's stored target for a type → { engine_id, target, film_count,
// computed_at } or null when absent. `target` is the parsed {genre: share} object.
function getTarget(profileId, type) {
  initTargets();
  const row = db.get().prepare(
    'SELECT engine_id, target, film_count, computed_at FROM serve_targets WHERE profile_id = ? AND type = ?',
  ).get(profileId, type);
  if (!row) return null;
  let target = {};
  try { target = JSON.parse(row.target); } catch { target = {}; }
  return { engine_id: row.engine_id, target, film_count: row.film_count, computed_at: row.computed_at };
}

// Drop every stored target for a profile (profile delete).
function deleteForProfile(profileId) {
  initTargets();
  db.get().prepare('DELETE FROM serve_targets WHERE profile_id = ?').run(profileId);
}

module.exports = {
  rowGenres,
  genreMix,
  computeTarget,
  applyExclusions,
  klDivergence,
  calibratedOrder,
  setTarget,
  getTarget,
  deleteForProfile,
};
