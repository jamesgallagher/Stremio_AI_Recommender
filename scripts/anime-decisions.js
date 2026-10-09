#!/usr/bin/env node
// AN-1b card 3: the anime decision report CLI. Read-only — shows why each anime
// was picked or dropped by the trending engine (lane_decisions), for the same
// data the portal's Anime build report panel and the read API expose.
//
// Usage:
//   node --experimental-sqlite scripts/anime-decisions.js <profile name or id>
//     [--build <id>|prev] [--outcome selected|rejected_age|rejected_llm|filtered]
//     [--q <text>] [--limit N] [--diff] [--json]

const config = require('../src/config');

function fail(msg) {
  process.stderr.write('anime-decisions: ' + msg + '\n');
  process.exit(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// `9 Oct 14:02` — d Mon HH:mm, local time.
function fmtDate(at) {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Project a raw lane_decisions row to the report fields (+ delta in diff mode).
function shapeRow(r) {
  return {
    item_key: r.item_key, imdb_id: r.imdb_id, title: r.title, year: r.year,
    poster: r.poster, mal_rating: r.mal_rating, stage: r.stage, outcome: r.outcome,
    source: r.source, rating: r.rating, reason: r.reason, because: r.because,
    delta: r.delta ?? undefined,
  };
}

// `<outcome or +/-> <title> (<year>) <rating> <stage> — <reason>`
function rowLine(r) {
  const first = r.delta || r.outcome;
  const rating = r.rating ? r.rating + ' ' : '';
  return `${first} ${r.title} (${r.year ?? '?'}) ${rating}${r.stage} — ${r.reason || ''}`;
}

function main() {
  const args = process.argv.slice(2);
  let target = null;
  let build = null;
  let outcome = null;
  let q = null;
  let limit = 50;
  let diff = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--build') build = args[++i];
    else if (args[i] === '--outcome') outcome = args[++i];
    else if (args[i] === '--q') q = args[++i];
    else if (args[i] === '--limit') limit = parseInt(args[++i], 10);
    else if (args[i] === '--diff') diff = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node --experimental-sqlite scripts/anime-decisions.js <profile name or id> [--build <id>|prev] [--outcome selected|rejected_age|rejected_llm|filtered] [--q <text>] [--limit N] [--diff] [--json]');
      process.exit(0);
    } else if (!target) target = args[i];
    else fail('unexpected argument: ' + args[i]);
  }

  if (!target) fail('missing <profile name or id>');
  if (isNaN(limit) || limit < 1) limit = 50;

  // Find the profile by id or exact name (case-insensitive).
  const profiles = config.listProfiles();
  let profile = profiles.find((p) => p.id === target);
  if (!profile) profile = profiles.find((p) => p.name.trim().toLowerCase() === target.trim().toLowerCase());
  if (!profile) fail('Profile not found: ' + target);

  // Open the DB read-only. Never create the lane_decisions table: check
  // sqlite_master first, and behave as "no builds" if it is absent.
  const db = require('../src/db');
  const conn = db.get();
  const tableExists = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lane_decisions'").get();
  if (!tableExists) {
    console.log('No anime builds recorded for ' + profile.name + '.');
    process.exit(0);
  }

  const decisions = require('../src/anime/decisionLog');
  const lane = 'anime';
  const builds = decisions.builds(profile.id, lane);
  if (!builds.length) {
    console.log('No anime builds recorded for ' + profile.name + '.');
    process.exit(0);
  }

  // Resolve the build id (default: the newest build).
  let buildId;
  if (build === 'prev') {
    if (builds.length < 2) fail('no build before the newest');
    buildId = builds[1].build_id;
  } else if (build) {
    if (!builds.some((b) => b.build_id === build)) fail('unknown build: ' + build);
    buildId = build;
  } else {
    buildId = builds[0].build_id;
  }

  const counts = decisions.counts(profile.id, lane, buildId);
  const tier = require('../src/ageVerification').tierFor(profile.filters)?.label || null;
  const at = builds.find((b) => b.build_id === buildId).at;

  let rows;
  if (diff) {
    const idx = builds.findIndex((b) => b.build_id === buildId);
    const prevBuildId = idx < builds.length - 1 ? builds[idx + 1].build_id : null;
    if (!prevBuildId) {
      rows = [];
    } else {
      const d = decisions.diff(profile.id, lane, buildId, prevBuildId);
      rows = d.added.map((r) => ({ ...r, delta: '+' })).concat(d.removed.map((r) => ({ ...r, delta: '-' })));
    }
    if (q) {
      const ql = String(q).toLowerCase();
      rows = rows.filter((r) => (r.title || '').toLowerCase().includes(ql));
    }
    rows = rows.slice(0, limit);
  } else {
    const res = decisions.list(profile.id, lane, { build: buildId, outcome: outcome || undefined, q: q || undefined, limit, offset: 0 });
    rows = res.rows;
  }

  const header = `${profile.name} · build ${buildId.slice(0, 4)}… · ${fmtDate(at)} · tier ${tier || '—'} · selected ${counts.selected} · rejected_age ${counts.rejected_age} · rejected_llm ${counts.rejected_llm} · filtered ${counts.filtered}`;

  if (json) {
    console.log(JSON.stringify({ name: profile.name, build_id: buildId, at, tier, counts, rows: rows.map(shapeRow) }, null, 2));
  } else {
    console.log(header);
    for (const r of rows) console.log(rowLine(r));
  }
}

main();
