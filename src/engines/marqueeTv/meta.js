// Marquee TV (TV-2 §5.2) — the TV meta cache.
//
// One row per show's TMDB id: the TV-specific `extras` (format, status, air
// dates, episode counts, AU/US content ratings) that the engine filters and
// scores on. The deep meta (Glass taste dimensions) is NOT stored here — it is
// written into the SHARED Glass metaStore (`series`) so the taste model sees
// the same metadata whether a show was watched or is a candidate. TTL 14 days
// (longer than the movie deep-meta static TTL, shorter than the live TTL — TV
// details change with new seasons but rarely).
const db = require('../../db');
const tmdb = require('../../services/tmdb');
const metaStore = require('../shared/metaStore');

const TTL_MS = 14 * 24 * 3600e3; // 14 days

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS marquee_tv_meta (
      tmdb_id TEXT PRIMARY KEY,
      extras  TEXT NOT NULL,
      at      INTEGER NOT NULL
    );
  `);
  ready = true;
}

// Ensure the TV meta for a set of TMDB ids. Fresh cached ids are served from
// the table; missing or expired ids are fetched (8 concurrent) via
// `tmdb.tvDetailsFull` (the governed internal `get`), the deep meta is written
// into the shared Glass metaStore (`series`) and the extras into
// `marquee_tv_meta`. A fetch that returns null (TMDB failure / no such title)
// is NOT cached — it retries on a later build. Returns Map<id, { ...deep,
// ...extras }>. `fetcher` is injectable for tests (defaults to
// tmdb.tvDetailsFull, which takes (apiKey, tmdbId)).
async function ensureTvMeta(apiKey, tmdbIds, { fetcher = tmdb.tvDetailsFull, now = Date.now(), log = console } = {}) {
  init();
  const ids = [...new Set((tmdbIds || []).filter((id) => id != null).map(String))];
  const out = new Map();
  const toFetch = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.get().prepare(`SELECT tmdb_id, extras, at FROM marquee_tv_meta WHERE tmdb_id IN (${placeholders})`).all(...ids);
    const cached = new Map();
    for (const r of rows) {
      let extras;
      try { extras = JSON.parse(r.extras); } catch { extras = null; }
      cached.set(r.tmdb_id, { extras, at: r.at || 0 });
    }
    for (const id of ids) {
      const c = cached.get(id);
      if (c && c.extras) {
        // stale is still served (better than nothing); expired → due for refetch
        const deep = metaStore.get('series', id);
        out.set(id, { ...(deep || {}), ...c.extras });
        if (now - c.at > TTL_MS) toFetch.push(id);
      } else {
        toFetch.push(id);
      }
    }
  }
  for (let i = 0; i < toFetch.length; i += 8) {
    const chunk = toFetch.slice(i, i + 8);
    const results = await Promise.all(chunk.map(async (id) => {
      try {
        const res = await fetcher(apiKey, id);
        if (!res) return { id, res: null };
        const { deep, extras } = res;
        if (deep) metaStore.put('series', id, deep, now);
        db.get().prepare(`
          INSERT INTO marquee_tv_meta (tmdb_id, extras, at) VALUES (?, ?, ?)
          ON CONFLICT(tmdb_id) DO UPDATE SET extras = excluded.extras, at = excluded.at
        `).run(id, JSON.stringify(extras), now);
        return { id, res: { ...(deep || {}), ...extras } };
      } catch (err) {
        log.warn(`[marquee-tv] tvDetailsFull ${id} failed: ${err.message}`);
        return { id, res: null };
      }
    }));
    for (const { id, res } of results) {
      if (res) out.set(id, res);
    }
  }
  return out;
}

module.exports = { init, ensureTvMeta };
