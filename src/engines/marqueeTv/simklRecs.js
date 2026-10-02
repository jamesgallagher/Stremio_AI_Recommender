// Marquee TV (TV-2 §5.3) — the Simkl show "users also liked" cache.
//
// One row per seed show's Simkl id: the parsed `users_recommendations`
// (TMDB/IMDb ids + title + year). TTL 30 days (like the movie summaries).
// MI-3/MI-4: a per-id fetch error logs + skips (not cached, retries next
// build) and never throws; fetches are sequential and capped. M3: anime
// recommendations are dropped at parse time (anime never appears in Marquee
// TV).
const db = require('../../db');
const simkl = require('../../services/simkl');

const TTL_MS = 30 * 24 * 3600e3; // 30 days

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS marquee_tv_simkl (
      simkl_id INTEGER PRIMARY KEY,
      recs     TEXT NOT NULL,
      at       INTEGER NOT NULL
    );
  `);
  ready = true;
}

// PURE: parse a /tv/{id}?extended=full body → [{ tmdb_id, imdb_id, title,
// year }] for items with a TMDB id and type !== 'anime' (M3). Missing
// users_recommendations → [].
function parseShowRecs(body) {
  const items = body && typeof body === 'object' && Array.isArray(body.users_recommendations) ? body.users_recommendations : [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'anime') continue; // M3: anime never appears
    const ids = it.ids || {};
    const tmdb = ids.tmdb != null ? String(ids.tmdb) : null;
    if (tmdb == null) continue; // no TMDB id — unusable
    out.push({ tmdb_id: tmdb, imdb_id: ids.imdb != null ? String(ids.imdb) : null, title: it.title || null, year: it.year != null ? Number(it.year) : null });
  }
  return out;
}

// Ensure the Simkl show recs for a set of seed Simkl ids. Fresh cached ids are
// served from the table; uncached ids are fetched SEQUENTIALLY (one at a time —
// the governor paces), stopping after `cap` even if more are pending; a per-id
// fetch error logs + skips (not cached, retries next build) and continues.
// Returns Map<simkl_id, recs[]> (cached + fetched). `fetcher` is injectable for
// tests (defaults to simkl.authedGet on /tv/{id}?extended=full, taking
// (profile, simklId) and returning the body).
async function ensureShowRecs(profile, simklIds, {
  fetcher = (p, id) => simkl.authedGet(p, `/tv/${id}`, { extended: 'full' }),
  cap = 40,
  now = Date.now(),
  log = console,
} = {}) {
  init();
  const ids = [...new Set((simklIds || []).filter((id) => id != null))];
  const out = new Map();
  const toFetch = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.get().prepare(`SELECT simkl_id, recs, at FROM marquee_tv_simkl WHERE simkl_id IN (${placeholders})`).all(...ids);
    const cached = new Map();
    for (const r of rows) {
      let recs;
      try { recs = JSON.parse(r.recs); } catch { recs = []; }
      cached.set(r.simkl_id, { recs: Array.isArray(recs) ? recs : [], at: r.at || 0 });
    }
    for (const id of ids) {
      const c = cached.get(id);
      if (c) {
        out.set(id, c.recs); // fresh or stale — stale is still served (better than nothing)
        if (now - c.at > TTL_MS) toFetch.push(id); // stale → due for refetch
      } else {
        toFetch.push(id);
      }
    }
  }
  let fetched = 0;
  for (const id of toFetch) {
    if (fetched >= cap) break; // stop after cap even if more pending
    fetched += 1; // an attempt counts against the cap whether it succeeds or not
    try {
      const body = await fetcher(profile, id);
      const recs = parseShowRecs(body);
      db.get().prepare(`
        INSERT INTO marquee_tv_simkl (simkl_id, recs, at) VALUES (?, ?, ?)
        ON CONFLICT(simkl_id) DO UPDATE SET recs = excluded.recs, at = excluded.at
      `).run(id, JSON.stringify(recs), now);
      out.set(id, recs);
    } catch (err) {
      log.warn(`[marquee-tv] simkl show recs for ${id} failed: ${err.message} — skipping (retries next build)`);
    }
  }
  return out;
}

module.exports = { init, parseShowRecs, ensureShowRecs };
