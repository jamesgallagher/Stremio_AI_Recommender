// Marquee ME-02 (spec §5 S5): the TMDB trending cache — week (5 pages) and
// day (2 pages), cached server-wide for 6 h in a small table, with the
// ensureFresh pattern from simklTrending.js: a failed refresh degrades to
// stale-but-usable rows and NEVER throws (MI-3 graceful degradation — a
// trending outage must never fail a Marquee build).
const db = require('../../db');
const tmdb = require('../../services/tmdb');

// 6 h TTL, env-overridable (spec §5: "cached server-wide for 6 h").
const TTL_MS = parseInt(process.env.MARQUEE_TRENDING_TTL_MS, 10) || 6 * 3600e3;
// Pages per window (spec §5 S5: week pages 1–5, day pages 1–2).
const PAGES = { week: 5, day: 2 };

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS marquee_trending (
      window     TEXT    NOT NULL,   -- 'week' | 'day'
      rank       INTEGER NOT NULL,
      tmdb_id    TEXT    NOT NULL,
      item       TEXT,               -- JSON: the trendingMovies item
      fetched_at INTEGER,
      PRIMARY KEY (window, rank)
    );
  `);
  ready = true;
}

// Replace one window's rows in one transaction (delete, then insert).
function replaceWindow(window, items, at) {
  const d = db.get();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM marquee_trending WHERE window = ?').run(window);
    const ins = d.prepare('INSERT INTO marquee_trending (window, rank, tmdb_id, item, fetched_at) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) ins.run(window, it.rank, it.tmdb_id, JSON.stringify(it), at);
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* commit already ran */ }
    throw err;
  }
}

// Fetch + store both windows. `fetcher` is injectable for tests (defaults to
// tmdb.trendingMovies). Per window, a fetch that throws OR returns 0 items
// keeps that window's old rows and logs a warning — never throws. Returns
// { ok, counts: { week, day } }.
async function refresh({ apiKey, fetcher = tmdb.trendingMovies, now = Date.now(), log = console } = {}) {
  init();
  let ok = true;
  const counts = {};
  for (const window of Object.keys(PAGES)) {
    let items;
    try {
      items = await fetcher(apiKey, window, PAGES[window]);
    } catch (err) {
      ok = false;
      log.warn(`[marquee] trending ${window} fetch failed: ${err.message} — keeping last cached rows`);
      continue;
    }
    if (!Array.isArray(items) || !items.length) {
      ok = false;
      log.warn(`[marquee] trending ${window} returned 0 items — keeping last cached rows`);
      continue;
    }
    replaceWindow(window, items, now);
    counts[window] = items.length;
  }
  return { ok, counts };
}

// When was any row last fetched? 0 = never. Drives ensureFresh's TTL check.
function newestFetchedAt() {
  init();
  const row = db.get().prepare('SELECT MAX(fetched_at) AS m FROM marquee_trending').get();
  return row?.m || 0;
}

// Refresh only when the newest row is older than the TTL (or the table is
// empty). A failed refresh degrades to stale (refresh never throws). Returns
// the refresh result, or { ok: true, skipped: 'fresh' } when nothing was due.
async function ensureFresh({ apiKey, ttlMs = TTL_MS, now = Date.now(), fetcher, log = console } = {}) {
  init();
  const newest = newestFetchedAt();
  if (newest && (now - newest) < ttlMs) return { ok: true, skipped: 'fresh' };
  return refresh({ apiKey, fetcher, now, log });
}

// The cached items for one window, in rank order (each item carries its rank).
// [] when never fetched.
function getWindow(window) {
  init();
  const rows = db.get().prepare('SELECT item FROM marquee_trending WHERE window = ? ORDER BY rank ASC').all(window);
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.item)); } catch { /* corrupt row: skip */ }
  }
  return out;
}

module.exports = {
  init,
  refresh,
  ensureFresh,
  getWindow,
  newestFetchedAt,
  TTL_MS,
  PAGES,
};
