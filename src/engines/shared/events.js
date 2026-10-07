// Glass feedback event list (Phase D / GE-10, design §4.1/§5.4) — turns the
// profile's durable feedback into the WEIGHTED EVENT LIST the taste model
// consumes, so positive and negative signals both shape taste and richer events
// can slot in later without a rewrite.
//
// v1 maps ONLY what already exists as durable data (design §5.4: "map to what
// exists before inventing new events"):
//   • watched (Simkl history)        → positive base  (+feedback.watched)
//   • dont_recommend, reason='user'  → strong negative (an explicit "not
//                                       interested"; steers taste away from its
//                                       director/genre/franchise/etc.)
//   • dont_recommend, reason='decayed' → mild negative (shown repeatedly, never
//                                       engaged — an implicit rejection)
// engaged_at (meta-open) is NOT wired: the column is reserved and nothing sets it
// yet, so there is no data to map (adding the event now would be inventing one).
//
// Each event is recency-decayed by the SAME three-horizon blend as watched
// (tasteModel), so an old rejection fades on its own — no hard cooldown cliff.
const watchedStore = require('../../watchedStore');

// Build the weighted event list for one (profile, type). `weight` is the SIGNED
// event-type magnitude (recency decay is applied by the taste model from `ts`);
// `fallback_genre` lets a not-yet-enriched WATCHED title still contribute its
// thin genre (rejections have no such fallback — a rejection with no cached deep
// metadata simply contributes nothing). Pure of network.
function buildEventList(profileId, type, cfg, { nowMs = Date.now() } = {}) {
  const fb = cfg.feedback || {};
  const rs = require('../../recommendationStore'); // lazy — avoids any load-order surprise
  const events = [];

  for (const w of watchedStore.getWatched(profileId, { type })) {
    if (!w.tmdb_id) continue;
    events.push({
      type,
      tmdb_id: String(w.tmdb_id),
      weight: fb.watched ?? 1,
      ts: w.watched_at ? Date.parse(w.watched_at) : NaN,
      kind: 'watched',
      fallback_genre: w.primary_genre || null,
    });
  }

  for (const r of rs.getDontRecommendRows(profileId, type)) {
    const isUser = r.reason === 'user';
    events.push({
      type,
      tmdb_id: String(r.tmdb_id),
      weight: isUser ? (fb.dont_recommend_user ?? -1.5) : (fb.dont_recommend_decayed ?? -0.5),
      ts: r.at || NaN,
      kind: isUser ? 'rejected_user' : 'rejected_decayed',
      fallback_genre: null,
    });
  }

  return events;
}

module.exports = { buildEventList };
