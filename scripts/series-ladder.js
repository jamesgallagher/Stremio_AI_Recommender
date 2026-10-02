// Marquee TV TV-1: a read-only debug script that prints the engagement ladder
// for every show in a profile's per-show progress store (series_progress).
//
// It snapshots the live store into a throwaway copy (read-only VACUUM INTO),
// points DATA_DIR at the copy, and reads getSeriesProgress + the pure ladder.
// It NEVER writes the live store.db or the live settings, and makes NO network
// calls (no Simkl, no TMDB, no LLM) — the ladder is computed purely from the
// stored progress rows.
//
// Usage:
//   node --experimental-sqlite scripts/series-ladder.js <profileName>
//     [--kind show|anime] [--json] [--keep]
//
// Prints one row per show: the rung, the taste weight (with the rating
// override applied), recency, active-now, binge bonus, seed eligibility, and
// the final value — plus the raw progress (watched/total eps, real stamps,
// eps/week). Useful for the TV-1 exit check ("ladder matches hand-labelled
// shows for 3 profiles").

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const USAGE =
  'Usage: node --experimental-sqlite scripts/series-ladder.js <profileName>\n'
  + '  [--kind show|anime] [--json] [--keep]\n'
  + '  --kind: show (default) or anime — which section of series_progress to print.\n'
  + '  --json: print the ladder as a JSON array instead of a table.\n'
  + '  --keep: keep the temp snapshot dir (it is removed otherwise).';

function parseArgs(argv) {
  const a = { profile: null, kind: 'show', json: false, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--kind') a.kind = String(argv[++i]);
    else if (x === '--json') a.json = true;
    else if (x === '--keep') a.keep = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x.startsWith('--')) { console.error('unknown flag: ' + x); console.error(USAGE); process.exit(2); }
    else if (a.profile === null) a.profile = x;
    else { console.error('unexpected argument: ' + x); console.error(USAGE); process.exit(2); }
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(USAGE); return; }
  if (!a.profile) { console.error('profileName is required'); console.error(USAGE); process.exit(2); }
  if (a.kind !== 'show' && a.kind !== 'anime') { console.error('--kind must be show or anime'); process.exit(2); }

  const liveDir = process.env.DATA_DIR || path.join(REPO_ROOT, 'data');
  const bench = require('../src/bench/engineBench');
  const { benchDir } = bench.snapshotStore(liveDir);

  // Point DATA_DIR at the throwaway copy ONLY NOW, then require the app modules
  // (they read DATA_DIR at require time). The live store.db is never opened for
  // write from here on.
  process.env.DATA_DIR = benchDir;
  const config = require('../src/config');
  const watchedStore = require('../src/watchedStore');
  const seriesEngagement = require('../src/seriesEngagement');
  const db = require('../src/db');

  const profile = config.listProfiles().find((p) => p.name === a.profile);
  if (!profile) {
    console.error('profile not found: ' + a.profile);
    process.exit(2);
  }

  let rows;
  try {
    rows = seriesEngagement.ladderFor(profile.id, { kind: a.kind });
  } finally {
    db.close(); // release the bench DB before we remove the dir
  }

  const list = [...rows.values()].map((e) => ({
    title: e.row.title,
    kind: e.row.kind,
    simkl_id: e.row.simkl_id,
    tmdb_id: e.row.tmdb_id,
    rung: e.rung,
    weight: e.weight,
    recency: Number(e.recency.toFixed(3)),
    activeNow: e.activeNow,
    binge: e.binge,
    seedEligible: e.seedEligible,
    rated: e.rated,
    value: Number(e.value.toFixed(3)),
    watched_eps: e.row.watched_eps,
    total_eps: e.row.total_eps,
    not_aired_eps: e.row.not_aired_eps,
    real_stamps: e.row.real_stamps,
    eps_per_week: e.row.eps_per_week != null ? Number(e.row.eps_per_week.toFixed(2)) : null,
  })).sort((x, y) => (y.value - x.value) || String(x.title).localeCompare(String(y.title)));

  if (a.json) {
    console.log(JSON.stringify(list, null, 2));
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    const head = [
      pad('title', 28), pad('kind', 6), pad('rung', 13), pad('weight', 8),
      pad('recency', 9), pad('active', 8), pad('binge', 7), pad('seed', 6),
      pad('rated', 7), pad('value', 9), 'eps',
    ].join(' ');
    const lines = [`Profile: ${a.profile}   kind: ${a.kind}   shows: ${list.length}`, head, '─'.repeat(head.length)];
    for (const r of list) {
      lines.push([
        pad(r.title, 28),
        pad(r.kind, 6),
        pad(r.rung, 13),
        pad(String(r.weight), 8),
        pad(String(r.recency), 9),
        pad(r.activeNow ? 'yes' : 'no', 8),
        pad(String(r.binge), 7),
        pad(r.seedEligible ? 'yes' : 'no', 6),
        pad(r.rated ? 'yes' : 'no', 7),
        pad(String(r.value), 9),
        `${r.watched_eps}/${r.total_eps}`,
      ].join(' '));
    }
    lines.push('');
    lines.push('value = weight × recency × (active?1.3:1) + binge; a rated show\'s weight is the film rating table (Q9).');
    console.log(lines.join('\n'));
  }

  if (!a.keep) fs.rmSync(benchDir, { recursive: true, force: true });
  else console.log('Snapshot dir kept at: ' + benchDir + ' (--keep)');
}

main().catch((err) => {
  console.error('\n✗ SERIES-LADDER FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
