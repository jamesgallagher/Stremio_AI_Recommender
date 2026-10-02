// AGE-1: the TV-14 verdict store (SQLite).
//
// Every TV-14 verdict is recorded here (mandate A7): the source that answered,
// the rating it carried, and the verdict. A TTL prunes old rows (steps 0-4 =
// 30 days, the LLM = 90 days; an "unknown" verdict — the LLM omitted the title
// — is never stored, A5). Serve-time re-check reads this without network.
const db = require('../db');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS age_verdicts (
      type        TEXT NOT NULL,
      tmdb_id     TEXT NOT NULL,
      verdict     TEXT NOT NULL,   -- 'allow' | 'block'
      source      TEXT NOT NULL,   -- 'csm' | 'au' | 'us' | 'tvdb-au' | ... | 'llm'
      rating      TEXT,            -- the rating that answered (null for llm)
      at          INTEGER NOT NULL,
      PRIMARY KEY (type, tmdb_id)
    );
  `);
  ready = true;
}

const DAY_MS = 24 * 3600e3;
const SOURCE_TTL_MS = 30 * DAY_MS; // steps 0-4 (deterministic sources)
const LLM_TTL_MS = 90 * DAY_MS;    // step 5 (the LLM judgement is the most stable)

// The TTL for a verdict by its source (LLM judgements live longest).
function ttlFor(source) {
  return source === 'llm' ? LLM_TTL_MS : SOURCE_TTL_MS;
}

// Record a TV-14 verdict. An "unknown" verdict is never stored (A5: the LLM
// omitted the title — it stays kept and is re-judged next time). Returns true
// if a row was written.
function recordVerdict(type, tmdbId, verdict, source, rating, at = Date.now()) {
  init();
  if (verdict !== 'allow' && verdict !== 'block') return false;
  db.get().prepare(`
    INSERT INTO age_verdicts (type, tmdb_id, verdict, source, rating, at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, tmdb_id) DO UPDATE SET
      verdict = excluded.verdict, source = excluded.source, rating = excluded.rating, at = excluded.at
  `).run(type, String(tmdbId), verdict, source, rating == null ? null : String(rating), at);
  return true;
}

// Read one verdict (null when absent or past its TTL).
function getVerdict(type, tmdbId, now = Date.now()) {
  init();
  const row = db.get().prepare('SELECT verdict, source, rating, at FROM age_verdicts WHERE type = ? AND tmdb_id = ?').get(type, String(tmdbId));
  if (!row) return null;
  if (now - row.at > ttlFor(row.source)) return null; // expired
  return { verdict: row.verdict, source: row.source, rating: row.rating };
}

// Batch read (Map<tmdbId, {verdict, source, rating}>), TTL-aware.
function getVerdicts(type, tmdbIds, now = Date.now()) {
  init();
  const out = new Map();
  const rows = db.get().prepare('SELECT tmdb_id, verdict, source, rating, at FROM age_verdicts WHERE type = ?').all(type);
  const want = new Set(tmdbIds.map(String));
  for (const r of rows) {
    if (!want.has(r.tmdb_id)) continue;
    if (now - r.at > ttlFor(r.source)) continue;
    out.set(r.tmdb_id, { verdict: r.verdict, source: r.source, rating: r.rating });
  }
  return out;
}

// Prune expired rows (called on a build). Returns the count removed.
function prune(now = Date.now()) {
  init();
  const r1 = db.get().prepare("DELETE FROM age_verdicts WHERE source = 'llm' AND at < ?").run(now - LLM_TTL_MS);
  const r2 = db.get().prepare("DELETE FROM age_verdicts WHERE source != 'llm' AND at < ?").run(now - SOURCE_TTL_MS);
  return Number(r1.changes || 0) + Number(r2.changes || 0);
}

module.exports = { init, recordVerdict, getVerdict, getVerdicts, prune, ttlFor, SOURCE_TTL_MS, LLM_TTL_MS };
