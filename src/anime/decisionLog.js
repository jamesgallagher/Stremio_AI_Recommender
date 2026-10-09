// AN-1b card 2a: decision log storage. Records why each anime was picked or
// dropped by the trending engine, so the lane owner can see and tune the lane.
// Same shape as migration.js: a lazy init() that runs CREATE TABLE IF NOT EXISTS
// on require('../db').get().
const db = require('../db');

let ready = false;
let lastBuildId = null;

function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS lane_decisions (
      profile_id TEXT NOT NULL,
      lane       TEXT NOT NULL,
      build_id   TEXT NOT NULL,
      item_key   TEXT NOT NULL,
      imdb_id    TEXT,
      title      TEXT,
      year       INTEGER,
      poster     TEXT,
      mal_rating REAL,
      stage      TEXT NOT NULL,
      outcome    TEXT NOT NULL,
      source     TEXT,
      rating     TEXT,
      reason     TEXT,
      because    TEXT,
      at         INTEGER NOT NULL,
      PRIMARY KEY (profile_id, lane, build_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS lane_decisions_build ON lane_decisions(profile_id, lane, build_id, outcome);
    CREATE TABLE IF NOT EXISTS lane_build_meta (
      profile_id TEXT,
      lane       TEXT,
      build_id   TEXT,
      mode       TEXT,
      engaged    INTEGER,
      at         INTEGER,
      PRIMARY KEY (profile_id, lane, build_id)
    );
  `);
  ready = true;
}

// Strictly increasing within this process: never equal to or below the previous
// id, even for many calls in the same millisecond (prune/list order by it).
function newBuildId() {
  let n = Date.now();
  if (lastBuildId !== null && n <= lastBuildId) n = lastBuildId + 1;
  lastBuildId = n;
  return String(n);
}

const VALID_OUTCOMES = new Set(['selected', 'rejected_age', 'rejected_llm', 'filtered']);

// Insert all rows in one transaction, using INSERT OR REPLACE (a later row for
// the same key replaces the earlier one). Row fields are the columns above
// minus the three keys (profile_id, lane, build_id); missing fields are null.
// stage/outcome are required — throw Error if missing or if outcome is not one
// of the four.
function record(profileId, lane, buildId, rows) {
  init();
  const conn = db.get();
  const stmt = conn.prepare(`
    INSERT OR REPLACE INTO lane_decisions
      (profile_id, lane, build_id, item_key, imdb_id, title, year, poster, mal_rating, stage, outcome, source, rating, reason, because, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = Date.now();
  conn.exec('BEGIN');
  try {
    for (const row of rows) {
      if (row.stage == null) throw new Error('stage is required');
      if (row.outcome == null || !VALID_OUTCOMES.has(row.outcome))
        throw new Error(`outcome must be one of selected, rejected_age, rejected_llm, filtered (got ${row.outcome})`);
      stmt.run(
        profileId, lane, buildId,
        row.item_key,
        row.imdb_id ?? null,
        row.title ?? null,
        row.year ?? null,
        row.poster ?? null,
        row.mal_rating ?? null,
        row.stage,
        row.outcome,
        row.source ?? null,
        row.rating ?? null,
        row.reason ?? null,
        row.because ?? null,
        at,
      );
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

// Delete rows of every build except the keep newest build_ids for that
// profile + lane (newest = greatest CAST(build_id AS INTEGER)).
// AN-2: also deletes the meta rows of every build it deletes.
function prune(profileId, lane, keep = 3) {
  init();
  const conn = db.get();
  conn.prepare(`
    DELETE FROM lane_decisions
    WHERE profile_id = ? AND lane = ?
      AND build_id NOT IN (
        SELECT build_id FROM lane_decisions
        WHERE profile_id = ? AND lane = ?
        GROUP BY build_id
        ORDER BY CAST(build_id AS INTEGER) DESC
        LIMIT ?
      )
  `).run(profileId, lane, profileId, lane, keep);
  conn.prepare(`
    DELETE FROM lane_build_meta
    WHERE profile_id = ? AND lane = ?
      AND build_id NOT IN (
        SELECT build_id FROM lane_decisions
        WHERE profile_id = ? AND lane = ?
        GROUP BY build_id
        ORDER BY CAST(build_id AS INTEGER) DESC
        LIMIT ?
      )
  `).run(profileId, lane, profileId, lane, keep);
}

// [{ build_id, at, total }], newest first (at = max at of the build).
function builds(profileId, lane) {
  init();
  const conn = db.get();
  return conn.prepare(`
    SELECT build_id, MAX(at) AS at, COUNT(*) AS total
    FROM lane_decisions
    WHERE profile_id = ? AND lane = ?
    GROUP BY build_id
    ORDER BY CAST(build_id AS INTEGER) DESC
  `).all(profileId, lane);
}

// { selected, rejected_age, rejected_llm, filtered } (all four keys, zeros included).
function counts(profileId, lane, buildId) {
  init();
  const conn = db.get();
  const rows = conn.prepare(`
    SELECT outcome, COUNT(*) AS n
    FROM lane_decisions
    WHERE profile_id = ? AND lane = ? AND build_id = ?
    GROUP BY outcome
  `).all(profileId, lane, buildId);
  const result = { selected: 0, rejected_age: 0, rejected_llm: 0, filtered: 0 };
  for (const row of rows) result[row.outcome] = row.n;
  return result;
}

// { rows, total }. build defaults to the newest build. outcome and q
// (case-insensitive LIKE %q% on title) are optional filters. Order: outcome
// order selected → rejected_age → rejected_llm → filtered, then title ascending.
function list(profileId, lane, opts = {}) {
  init();
  const conn = db.get();
  const { build, outcome, q, limit = 25, offset = 0 } = opts;

  let buildId = build;
  if (!buildId) {
    const row = conn.prepare(`
      SELECT build_id FROM lane_decisions
      WHERE profile_id = ? AND lane = ?
      GROUP BY build_id
      ORDER BY CAST(build_id AS INTEGER) DESC
      LIMIT 1
    `).get(profileId, lane);
    buildId = row ? row.build_id : null;
  }
  if (!buildId) return { rows: [], total: 0 };

  let where = 'profile_id = ? AND lane = ? AND build_id = ?';
  const params = [profileId, lane, buildId];
  if (outcome) {
    where += ' AND outcome = ?';
    params.push(outcome);
  }
  if (q) {
    where += ' AND title LIKE ?';
    params.push(`%${q}%`);
  }

  const orderClause = `CASE outcome WHEN 'selected' THEN 0 WHEN 'rejected_age' THEN 1 WHEN 'rejected_llm' THEN 2 WHEN 'filtered' THEN 3 ELSE 4 END, title ASC`;

  const total = conn.prepare(`SELECT COUNT(*) AS n FROM lane_decisions WHERE ${where}`).get(...params).n;
  const rows = conn.prepare(`SELECT * FROM lane_decisions WHERE ${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  return { rows, total };
}

// rating column convention: for gate rows, rating holds the decision as {source}:{rating}:
// mal:PG-13, csm:12, au:M, hard-floor:adult, llm (no rating part for the LLM).
// The list source column from 2a stays the *list* source (simkl+anilist).
function update(profileId, lane, buildId, itemKey, patch) {
  init();
  const conn = db.get();
  const allowed = new Set(['outcome', 'stage', 'rating', 'reason']);
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    if (k === 'outcome') {
      if (!VALID_OUTCOMES.has(v)) throw new Error(`outcome must be one of selected, rejected_age, rejected_llm, filtered (got ${v})`);
    }
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (!sets.length) return false;
  params.push(profileId, lane, buildId, itemKey);
  const result = conn.prepare(`UPDATE lane_decisions SET ${sets.join(', ')} WHERE profile_id = ? AND lane = ? AND build_id = ? AND item_key = ?`).run(...params);
  return result.changes > 0;
}

// AN-1b card 3: compare two builds' selected sets. `added` = rows of buildId
// with outcome selected whose item_key is not selected in prevBuildId; `removed`
// = rows of prevBuildId with outcome selected whose item_key is not selected in
// buildId. Each is an array of full rows, ordered by title ascending. Synchronous.
// A build id with no rows (or null) is treated as empty.
function diff(profileId, lane, buildId, prevBuildId) {
  init();
  const conn = db.get();
  const selectedKeys = (bid) => {
    if (!bid) return new Set();
    const rows = conn.prepare(`
      SELECT item_key FROM lane_decisions
      WHERE profile_id = ? AND lane = ? AND build_id = ? AND outcome = 'selected'
    `).all(profileId, lane, bid);
    return new Set(rows.map((r) => r.item_key));
  };
  const byTitle = (a, b) => {
    const ta = a.title || '';
    const tb = b.title || '';
    return ta < tb ? -1 : (ta > tb ? 1 : 0);
  };
  const newSel = selectedKeys(buildId);
  const prevSel = selectedKeys(prevBuildId);
  const added = [];
  if (buildId) {
    const rows = conn.prepare(`
      SELECT * FROM lane_decisions
      WHERE profile_id = ? AND lane = ? AND build_id = ? AND outcome = 'selected'
    `).all(profileId, lane, buildId);
    for (const r of rows) if (!prevSel.has(r.item_key)) added.push(r);
  }
  const removed = [];
  if (prevBuildId) {
    const rows = conn.prepare(`
      SELECT * FROM lane_decisions
      WHERE profile_id = ? AND lane = ? AND build_id = ? AND outcome = 'selected'
    `).all(profileId, lane, prevBuildId);
    for (const r of rows) if (!newSel.has(r.item_key)) removed.push(r);
  }
  added.sort(byTitle);
  removed.sort(byTitle);
  return { added, removed };
}

// AN-2: build meta — the mode and engaged count for a build.
const VALID_MODES = new Set(['trending', 'mixed', 'personalised']);

function recordMeta(profileId, lane, buildId, { mode, engaged }) {
  init();
  if (!VALID_MODES.has(mode)) {
    throw new Error(`mode must be one of trending, mixed, personalised (got ${mode})`);
  }
  const conn = db.get();
  conn.prepare(`
    INSERT OR REPLACE INTO lane_build_meta
      (profile_id, lane, build_id, mode, engaged, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(profileId, lane, buildId, mode, engaged, Date.now());
}

function getMeta(profileId, lane, buildId) {
  init();
  const conn = db.get();
  const row = conn.prepare(
    'SELECT mode, engaged FROM lane_build_meta WHERE profile_id = ? AND lane = ? AND build_id = ?'
  ).get(profileId, lane, buildId);
  return row ? { mode: row.mode, engaged: row.engaged } : null;
}

module.exports = { init, newBuildId, record, prune, builds, counts, list, update, diff, recordMeta, getMeta };
