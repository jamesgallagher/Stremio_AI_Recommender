// Glass embedding store (GE-09, design §5.2) — a Glass-owned cache of per-title
// content vectors as Float32 BLOBs, keyed by (type, tmdb_id). Vectors are STATIC
// (a title's content doesn't change), so each is embedded ONCE and cached forever;
// steady state is one embed per newly-seen title. Comparison is brute-force cosine
// (services/embeddings.cosine) at build scale — no ANN index, no sqlite-vec, no
// external vector store (the decision, GD-2): a few hundred candidates vs one
// taste vector doesn't warrant it.
//
// `model` is stored per row so a model change is detectable: a cached vector from
// a different model is ignored (cosine across models is meaningless), and the
// title is re-embedded under the new model.
const db = require('../../db');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS glass_embeddings (
      type       TEXT NOT NULL,           -- 'movie' | 'series'
      tmdb_id    TEXT NOT NULL,
      model      TEXT NOT NULL,           -- embedding model id (guards cross-model reuse)
      dim        INTEGER,
      vec        BLOB,                    -- Float32Array bytes
      created_at INTEGER,
      PRIMARY KEY (type, tmdb_id)
    );
  `);
  ready = true;
}

const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
const fromBlob = (buf) => Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));

// Cached vector for one title UNDER `model`, or null (absent, or a different-model
// row that must be re-embedded).
function get(type, tmdbId, model) {
  init();
  const row = db.get().prepare('SELECT model, vec FROM glass_embeddings WHERE type = ? AND tmdb_id = ?').get(type, String(tmdbId));
  if (!row || !row.vec || row.model !== model) return null;
  return fromBlob(row.vec);
}

// Map<tmdb_id, number[]> for many ids of one type under `model` (one query).
function getMany(type, tmdbIds, model) {
  init();
  const out = new Map();
  const ids = [...new Set((tmdbIds || []).map(String))];
  if (!ids.length) return out;
  const rows = db.get().prepare(
    `SELECT tmdb_id, model, vec FROM glass_embeddings WHERE type = ? AND tmdb_id IN (${ids.map(() => '?').join(',')})`,
  ).all(type, ...ids);
  for (const r of rows) if (r.vec && r.model === model) out.set(r.tmdb_id, fromBlob(r.vec));
  return out;
}

function put(type, tmdbId, model, vec, at = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO glass_embeddings (type, tmdb_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, tmdb_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at
  `).run(type, String(tmdbId), model, vec.length, toBlob(vec), at);
}

function count() {
  init();
  return db.get().prepare('SELECT COUNT(*) AS n FROM glass_embeddings').get().n;
}

function _clear() {
  init();
  db.get().prepare('DELETE FROM glass_embeddings').run();
}

module.exports = { init, get, getMany, put, count, _clear };
