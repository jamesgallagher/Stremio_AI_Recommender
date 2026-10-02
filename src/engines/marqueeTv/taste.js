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

module.exports = { formatHistory };
