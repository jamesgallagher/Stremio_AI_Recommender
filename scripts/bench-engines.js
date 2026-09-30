// Engine backtest (ME-10, P5). Compares Genesis, Glass and Marquee on ONE
// profile's REAL history: it holds out the most recent N watched movies, deletes
// them from a throwaway copy of the store, rebuilds the movie pool with each
// engine, and reports how many of the held-out titles each engine ranks into the
// top-20 served / top-100 pool. This is the evidence for deciding whether to
// enable Marquee for the family (spec §5).
//
// Usage:
//   node --experimental-sqlite scripts/bench-engines.js <profileName>
//     [--holdout 10] [--engines genesis,glass,marquee] [--no-cache] [--json] [--keep]
//
// What it READS: the live store (profiles.json, settings.json, store.db) —
// snapshotted into a temp dir. It NEVER writes the live store.db (the snapshot
// is a VACUUM INTO of a read-only open of the live DB). The ONLY write to the
// live data dir is the optional --json report under <liveDir>/bench/ (no
// tokens/keys). All app modules are required only AFTER the snapshot, with
// DATA_DIR pointed at the temp copy, so the live DB is never opened for write.
//
// It makes NO live API calls: the build runs against the snapshotted store, and
// Marquee's Simkl ratings sync is skipped (ctx.marqueeSkipSync). Run it yourself
// on real profiles — the assistant never runs it against live services.

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const USAGE =
  'Usage: node --experimental-sqlite scripts/bench-engines.js <profileName>\n'
  + '  [--holdout 10] [--engines genesis,glass,marquee] [--no-cache] [--json] [--keep]';

function parseArgs(argv) {
  const a = { profile: null, holdout: 10, engines: ['genesis', 'glass', 'marquee'], noCache: false, json: false, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--holdout') a.holdout = Number(argv[++i]);
    else if (x === '--engines') a.engines = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--no-cache') a.noCache = true;
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
  if (!Number.isFinite(a.holdout) || a.holdout < 1) { console.error('--holdout must be a positive integer'); process.exit(2); }

  const liveDir = process.env.DATA_DIR || path.join(REPO_ROOT, 'data');
  const bench = require('../src/bench/engineBench');
  const { benchDir, readOnlyPath } = bench.snapshotStore(liveDir);

  // Point DATA_DIR at the throwaway copy ONLY NOW, then require the app modules
  // (they read DATA_DIR at require time). The live store.db is never opened for
  // write from here on.
  process.env.DATA_DIR = benchDir;
  const engines = require('../src/engines');
  const pipeline = require('../src/engines/pipeline');
  const rs = require('../src/recommendationStore');
  const watchedStore = require('../src/watchedStore');
  const db = require('../src/db');
  const settings = require('../src/settings');
  const config = require('../src/config');

  const profile = config.listProfiles().find((p) => p.name === a.profile);
  if (!profile) {
    console.error('profile not found: ' + a.profile);
    process.exit(2);
  }

  const quiet = { log() {}, warn() {}, error() {} };
  let results;
  try {
    results = await bench.runBench({
      profile, engineIds: a.engines, holdout: a.holdout,
      deps: {
        engines, pipeline, rs, watchedStore, db, settings,
        selectServe: rs.selectServe, log: quiet, noCache: a.noCache,
      },
    });
  } finally {
    db.close(); // release the bench DB before we remove the dir
  }

  console.log(bench.renderTable(results));
  console.log('\nNote: the age gate is NOT run in the bench — it measures ranking quality, not age safety.');
  console.log('Snapshot: live store.db read via node:sqlite ' + readOnlyPath + ' open + VACUUM INTO. Live store.db was never written.');

  if (a.json) {
    const benchOutDir = path.join(liveDir, 'bench');
    fs.mkdirSync(benchOutDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(benchOutDir, `bench-${a.profile}-${ts}.json`);
    const payload = {
      profile: results.profile,
      at: new Date().toISOString(),
      holdout: results.holdout,
      targets: results.targets,
      engines: Object.fromEntries(Object.entries(results.engines).map(([id, e]) => [id, { metrics: e.metrics, hitTargets: e.hitTargets }])),
    };
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
    console.log('JSON report written to: ' + outFile);
  }

  if (!a.keep) fs.rmSync(benchDir, { recursive: true, force: true });
  else console.log('Bench dir kept at: ' + benchDir + ' (--keep)');
}

main().catch((err) => {
  console.error('\n✗ BENCH FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
