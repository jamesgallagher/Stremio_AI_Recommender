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
// Live calls: the build runs each engine's REAL generate() with the real keys,
// so a bench run makes READ-ONLY live calls — TMDB (recommendations, similar,
// discover, collections, trending refresh, deep meta for uncached candidates,
// title search for LLM suggestions), MDBList (the pipeline's IMDb-rating step),
// the local LLM (Glass's rerank; Marquee's brief, suggestions and fit), the
// Simkl trending CDN (public), and authed Simkl GETs (Marquee's S2 recs, up to
// 40 uncached summaries per Marquee run) — all paced through the governor. It
// NEVER writes to Simkl or the live store, and it skips the Simkl RATINGS sync
// (ctx.marqueeSkipSync). Everything fetched is cached in the throwaway copy
// only — the store.db snapshot's cache tables (marquee_trending,
// marquee_llm_cache, marquee_simkl_recs, glass_metadata, simkl_trending) and
// the cache/ + meta/ files — so the live caches never warm up and the next
// run starts equally cold.

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const USAGE =
  'Usage: node --experimental-sqlite scripts/bench-engines.js <profileName>\n'
  + '  [--holdout 10] [--engines genesis,glass,marquee] [--no-cache] [--json] [--keep]\n'
  + "  [--serve-opts '<json>']\n"
  + 'Expect several minutes per profile on a cold cache (Marquee\'s LLM fit dominates).\n'
  + "  --serve-opts: a JSON object of serve-config overrides (snake_case, e.g. '{\"window_factor\":4}')";

function parseArgs(argv) {
  const a = { profile: null, holdout: 10, engines: ['genesis', 'glass', 'marquee'], noCache: false, json: false, keep: false, serveOpts: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--holdout') a.holdout = Number(argv[++i]);
    else if (x === '--engines') a.engines = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--no-cache') a.noCache = true;
    else if (x === '--json') a.json = true;
    else if (x === '--keep') a.keep = true;
    else if (x === '--serve-opts') {
      const raw = argv[++i];
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error("--serve-opts must be a JSON object (e.g. '{\"window_factor\":4}')");
        console.error(USAGE);
        process.exit(2);
      }
      a.serveOpts = parsed;
    }
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
  console.log('Live read-only calls: TMDB, MDBList, local LLM, Simkl (trending CDN + ≤40 recs GETs). No writes to Simkl or the live store.');
  let results;
  try {
    results = await bench.runBench({
      profile, engineIds: a.engines, holdout: a.holdout, serveOptsOverride: a.serveOpts,
      deps: {
        engines, pipeline, rs, watchedStore, db, settings,
        selectServe: rs.selectServe, selectServeFor: rs.selectServeFor, filterServable: rs.filterServable,
        listSizeFor: rs.listSizeFor,
        serveCalibration: require('../src/serveCalibration'),
        log: quiet, noCache: a.noCache,
        // m2: could each held-out film be served at all under this profile's
        // filters? Cached deep meta first; a read-only TMDB fetch (≤ holdout
        // calls) only when the cache lacks it or predates availability data.
        reachability: async (targetIds, filters) => {
          const metaStore = require('../src/engines/glass/metaStore');
          const tmdb = require('../src/services/tmdb');
          const mdblist = require('../src/services/mdblist');
          const animeMap = require('../src/services/animeMap');
          const { compileEnvelope } = require('../src/engines/marquee/filters');
          await animeMap.ensureLoaded(quiet).catch(() => {});
          const tmdbKey = settings.keyFor(profile, 'tmdb_api_key');
          const mdbKey = settings.keyFor(profile, 'mdblist_api_key');
          return bench.assessReachability(targetIds, filters, {
            compileEnvelope,
            metaFor: async (id) => {
              const cached = metaStore.get('movie', id);
              if (cached && 'availability' in cached) return cached;
              const fresh = await tmdb.deepMeta(tmdbKey, 'movie', id, quiet);
              if (fresh) metaStore.put('movie', id, fresh); // the bench copy only
              return fresh || cached;
            },
            imdbRatingFor: async (imdbId) => (mdbKey
              ? (await mdblist.cachedImdbRatings(mdbKey, 'movie', [imdbId], quiet)).get(imdbId) ?? null
              : null),
            isAnime: (imdbId, tmdbId) => animeMap.isAnime(imdbId, tmdbId),
          });
        },
      },
    });
  } finally {
    db.close(); // release the bench DB before we remove the dir
  }

  console.log(bench.renderTable(results));
  // §6: Marquee serve-strategy comparison (round-robin vs calibrated vs pure
  // score) on the same pool — printed as a second table under the main one.
  if (results.engines.marquee && results.engines.marquee.serveStrategies) {
    console.log('\n' + bench.renderServeTable(results.engines.marquee.serveStrategies));
  }
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
      engines: Object.fromEntries(Object.entries(results.engines).map(([id, e]) => [id, {
        metrics: e.metrics, hitTargets: e.hitTargets, positions: e.positions,
        ...(e.serveStrategies
          ? { serveStrategies: e.serveStrategies, ...(e.serveOptsOverride ? { serveOptsOverride: e.serveOptsOverride } : {}) }
          : {}),
      }])),
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
