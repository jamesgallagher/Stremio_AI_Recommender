// Marquee ME-08 (spec §8.3) — output shaping: the franchise cap (at most
// cfg.franchise_cap per collection), the store-cap truncation, and the
// shortfall warning that explains WHY a list is short (the envelope's
// rejection counters, dominant blockers first).
//
// Pure apart from log: no network, no DB. The _fit/_preScore working fields
// never leave this function (they must not reach the DB).
function shapeOutput(scored, { cfg, listSize = 0, envelopeStats = {}, log = console, profileName = '', trace = null } = {}) {
  // (1) Franchise cap: at most cfg.franchise_cap per non-null collection,
  // walking the rankScore order (scored is already sorted desc); no-collection
  // rows are uncapped.
  const seen = new Map(); // collection_id → kept count
  const capped = [];
  for (const r of scored) {
    const cid = r.scoreComponents?.inputs?.collection_id;
    if (cid != null) {
      const n = seen.get(cid) || 0;
      if (n >= cfg.franchise_cap) { if (trace?.dropped) trace.dropped.set(r.tmdb_id, 'franchise_cap'); continue; }
      seen.set(cid, n + 1);
    }
    capped.push(r);
  }

  // (2) Truncate to the store cap.
  const final = capped.slice(0, cfg.store_cap);
  if (trace?.dropped) for (const r of capped.slice(cfg.store_cap)) trace.dropped.set(r.tmdb_id, 'store_cap');

  // (3) Oversupply: warn with the dominant blockers when short of target.
  const target = Math.max(cfg.min_supply, listSize * cfg.supply_factor);
  if (final.length < target) {
    const counters = Object.entries(envelopeStats || {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const blockers = counters.length ? counters.map(([k, v]) => `${k} ${v}`).join(', ') : 'none recorded';
    log.warn(`[marquee] ${profileName}: shortfall ${final.length}/${target} — blockers: ${blockers}`);
  }

  // (4) Strip the working fields (they must not reach the DB).
  return final.map(({ _fit, _preScore, ...row }) => row);
}

module.exports = { shapeOutput };
