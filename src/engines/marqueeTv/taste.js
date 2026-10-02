// Marquee TV (TV-2 §4.4) — format history.
//
// Pure: which format families the profile has history in (rung `tried` or
// better). Q4: formats with no history are hard-excluded, so this Set is the
// `formatsAllowed` the hard filter checks against. Cold start (no history)
// never empties the pool → scripted.
const { formatFamily } = require('./filters');

// Formats with history (Q4): families of the profile's shows at rung tried or
// better. `ladderEntries` are the profile's series ladder rows ({ rung, value,
// row }) and `metaById` maps tmdb_id → merged meta ({ tvType, ... }).
function formatHistory(ladderEntries, metaById) {
  const fams = new Set();
  for (const e of ladderEntries) {
    if (!['tried', 'engaged', 'committed', 'finished'].includes(e.rung)) continue;
    const m = metaById.get(String(e.row.tmdb_id));
    if (m && m.tvType) fams.add(formatFamily(m.tvType));
  }
  if (!fams.size) fams.add('scripted');   // cold start never empties the pool
  return fams;
}

// §4.5 Taste events: one event per non-anime show with ladder value > 0 (the
// ladder value already includes recency, so ts = now — the Glass blend then
// multiplies by ~1). Plus the profile's series dont_recommend rows as
// negatives (Glass's own weights/timestamps).
function tasteEvents(ladderEntries, dontRows, nowMs, isAnimeRow) {
  const ev = [];
  for (const e of ladderEntries) {
    if (e.value <= 0 || !e.row.tmdb_id || isAnimeRow(e.row)) continue;
    ev.push({ type: 'series', tmdb_id: String(e.row.tmdb_id), weight: e.value, ts: nowMs, kind: 'watched', fallback_genre: null });
  }
  for (const r of dontRows) {
    const isUser = r.reason === 'user';
    ev.push({ type: 'series', tmdb_id: String(r.tmdb_id), weight: isUser ? -1.5 : -0.5, ts: r.at || nowMs, kind: isUser ? 'rejected_user' : 'rejected_decayed', fallback_genre: null });
  }
  return ev;
}

// §4.5 Seeds: the seed-eligible ladder entries (the ladder's own `seedEligible`
// flag — engaged-or-better by rung, then the rating override), non-anime,
// tmdb_id present, sorted by value DESC, first cfg.seed_cap.
function seeds(ladderEntries, cfg, isAnimeRow) {
  const eligible = ladderEntries
    .filter((e) => e.seedEligible && e.row.tmdb_id && !isAnimeRow(e.row))
    .sort((a, b) => b.value - a.value);
  return eligible.slice(0, cfg.seed_cap);
}

module.exports = { formatHistory, tasteEvents, seeds };
