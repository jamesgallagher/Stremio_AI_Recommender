// Marquee TV (TV-2 §4.6/§4.7) — the pure scoring pieces.
//
// `commitmentFit` (Q6) penalises a show that is much longer than the profile's
// comfort (median total_eps of finished + committed shows); shorter or similar
// shows are never penalised. `airing` rewards a show that has an episode airing
// near now (last or next), else a Returning Series gets a half credit and
// anything else gets 0. Both are pure (no network, no DB).
//
// `scoreTv` (the full feature×weight sum + the one-season-cancelled penalty) is
// added in the orchestrator step.

// Commitment comfort (spec §4.6): median total_eps of the profile's finished +
// committed shows (non-anime, total known); cfg.default_comfort_eps when there
// are none.
function commitmentFit(candEps, comfort) {
  if (!candEps || !comfort) return 0.5;               // unknown → neutral
  const r = candEps / comfort;
  if (r <= 2) return 1;                               // shorter or similar: never penalised
  return Math.max(0, 1 - Math.log2(r / 2) / 3);       // 4× → 0.667, 8× → 0.333, 16× → 0
}

// Airing (spec §4.7): an episode airing within windowDays of now (last or next)
// → 1; else a Returning Series → 0.5; anything else → 0.
function airing(c, nowMs, windowDays) {
  const near = (d) => d && Math.abs(nowMs - Date.parse(d)) <= windowDays * 86400e3;
  if (near(c.last_episode_air_date) || near(c.next_episode_air_date)) return 1;
  return c.status === 'Returning Series' ? 0.5 : 0;
}

module.exports = { commitmentFit, airing };
