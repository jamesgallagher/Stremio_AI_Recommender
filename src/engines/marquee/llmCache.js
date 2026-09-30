// Marquee ME-04 (spec §4.4) — engine-owned LLM response cache. A small table
// keyed (profile_id, kind, key); values are stored as JSON. An expired or
// corrupt entry is a MISS (the LLM is called again), never an error — MI-3
// graceful degradation.
const db = require('../../db');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS marquee_llm_cache (
      profile_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT, at INTEGER,
      PRIMARY KEY (profile_id, kind, key));
  `);
  ready = true;
}

// Parsed value or null (expired / corrupt = miss).
function get(profileId, kind, key, { ttlMs = Infinity, now = Date.now() } = {}) {
  init();
  const row = db.get().prepare('SELECT value, at FROM marquee_llm_cache WHERE profile_id = ? AND kind = ? AND key = ?').get(profileId, kind, key);
  if (!row) return null;
  if (now - (row.at || 0) > ttlMs) return null; // expired
  try { return JSON.parse(row.value); } catch { return null; } // corrupt
}

// Map<key, value> for many keys (one query); misses are absent from the map.
function getMany(profileId, kind, keys, { ttlMs = Infinity, now = Date.now() } = {}) {
  init();
  const out = new Map();
  const list = [...new Set((keys || []).filter((k) => k != null))];
  if (!list.length) return out;
  const placeholders = list.map(() => '?').join(',');
  const rows = db.get().prepare(`SELECT key, value, at FROM marquee_llm_cache WHERE profile_id = ? AND kind = ? AND key IN (${placeholders})`).all(profileId, kind, ...list);
  for (const r of rows) {
    if (now - (r.at || 0) > ttlMs) continue; // expired
    try { out.set(r.key, JSON.parse(r.value)); } catch { /* corrupt: miss */ }
  }
  return out;
}

function put(profileId, kind, key, value, at = Date.now()) {
  init();
  db.get().prepare(`
    INSERT INTO marquee_llm_cache (profile_id, kind, key, value, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, kind, key) DO UPDATE SET value = excluded.value, at = excluded.at
  `).run(profileId, kind, key, JSON.stringify(value), at);
}

// Drop rows older than `olderThanMs` (relative to now); returns rows pruned.
function prune(profileId, kind, olderThanMs, now = Date.now()) {
  init();
  const r = db.get().prepare('DELETE FROM marquee_llm_cache WHERE profile_id = ? AND kind = ? AND (at IS NULL OR at < ?)').run(profileId, kind, now - olderThanMs);
  return Number(r.changes || 0);
}

// Test/maintenance helper.
function _clear() {
  init();
  db.get().prepare('DELETE FROM marquee_llm_cache').run();
}

module.exports = { init, get, getMany, put, prune, _clear };
