// FG-1: the filter verdict store (SQLite).
//
// Every filter-gate verdict is recorded here. A TTL prunes old rows
// (14 days for 'rules' source, 30 days for 'llm' source). A bad verdict
// caused ONLY by no_data is never stored (it is retried next build).
const db = require('../db');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS filter_verdicts (
      profile_id TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      fhash TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reason TEXT,
      detail TEXT,
      source TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, type, key, fhash)
    );
  `);
  ready = true;
}

const DAY_MS = 24 * 3600e3;
const RULES_TTL_MS = 14 * DAY_MS;
const LLM_TTL_MS = 30 * DAY_MS;

function ttlFor(source) {
  return source === 'llm' ? LLM_TTL_MS : RULES_TTL_MS;
}

// Record a verdict. `no_data` bad verdicts are never stored.
function recordVerdict(profileId, type, key, fhash, verdict, reason, detail, source, at = Date.now()) {
  init();
  if (verdict === 'bad' && reason === 'no_data') return false;
  db.get().prepare(`
    INSERT INTO filter_verdicts (profile_id, type, key, fhash, verdict, reason, detail, source, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, type, key, fhash) DO UPDATE SET
      verdict = excluded.verdict, reason = excluded.reason, detail = excluded.detail,
      source = excluded.source, at = excluded.at
  `).run(profileId, type, key, fhash, verdict, reason, detail, source, at);
  return true;
}

// Read one verdict (null when absent or past its TTL).
function getVerdict(profileId, type, key, fhash, now = Date.now()) {
  init();
  const row = db.get().prepare(
    'SELECT verdict, reason, detail, source, at FROM filter_verdicts WHERE profile_id = ? AND type = ? AND key = ? AND fhash = ?'
  ).get(profileId, type, key, fhash);
  if (!row) return null;
  if (now - row.at > ttlFor(row.source)) return null;
  return { verdict: row.verdict, reason: row.reason, detail: row.detail, source: row.source };
}

// Batch read (Map<key, {verdict, reason, detail, source}>, TTL-aware).
function getVerdicts(profileId, type, fhash, keys, now = Date.now()) {
  init();
  const out = new Map();
  const placeholders = keys.map(() => '?').join(',');
  const rows = db.get().prepare(
    `SELECT key, verdict, reason, detail, source, at FROM filter_verdicts WHERE profile_id = ? AND type = ? AND fhash = ? AND key IN (${placeholders})`
  ).all(profileId, type, fhash, ...keys);
  for (const r of rows) {
    if (now - r.at > ttlFor(r.source)) continue;
    out.set(r.key, { verdict: r.verdict, reason: r.reason, detail: r.detail, source: r.source });
  }
  return out;
}

// Prune expired rows.
function prune(now = Date.now()) {
  init();
  const r1 = db.get().prepare("DELETE FROM filter_verdicts WHERE source = 'llm' AND at < ?").run(now - LLM_TTL_MS);
  const r2 = db.get().prepare("DELETE FROM filter_verdicts WHERE source != 'llm' AND at < ?").run(now - RULES_TTL_MS);
  return Number(r1.changes || 0) + Number(r2.changes || 0);
}

module.exports = { init, recordVerdict, getVerdict, getVerdicts, prune, RULES_TTL_MS, LLM_TTL_MS };
