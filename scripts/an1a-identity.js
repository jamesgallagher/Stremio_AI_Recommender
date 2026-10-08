// AN-1a R1 identity check: run one buildRecommendations for a profile with
// engine_anime:'off' on a snapshot, and compare the movie/series pools
// (tmdb ids, affinity, served order for listSizeFor) against a reference.
//
// Usage: node --experimental-sqlite scripts/an1a-identity.js <snapshot-path> [reference-json]
//   snapshot-path: path to a copy of store.db (or a DATA_DIR containing store.db)
//   reference-json: optional JSON file with the expected pools (from v7); if
//   omitted, the script prints the pools for manual comparison.
//
// The script does NOT make network calls. It reads the snapshot's store.db,
// runs buildRecommendations with stubbed network (no real API calls), and
// prints the movie/series pool for comparison.
'use strict';

const path = require('path');
const fs = require('fs');

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error('Usage: node --experimental-sqlite scripts/an1a-identity.js <snapshot-path> [reference-json]');
  process.exit(1);
}

// Resolve the DATA_DIR from the snapshot path.
let dataDir;
if (fs.existsSync(path.join(snapshotPath, 'store.db'))) {
  dataDir = snapshotPath;
} else if (fs.existsSync(snapshotPath) && snapshotPath.endsWith('.db')) {
  dataDir = path.dirname(snapshotPath);
} else {
  console.error(`Cannot find store.db in ${snapshotPath}`);
  process.exit(1);
}

process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-key';

const config = require('../src/config');
const recommendationStore = require('../src/recommendationStore');
const pipeline = require('../src/pipeline');

(async () => {
  const profiles = config.listProfiles();
  if (!profiles.length) {
    console.error('No profiles found in the snapshot.');
    process.exit(1);
  }

  // Use the first profile (the script is for a single-profile snapshot).
  const profile = profiles[0];
  console.log(`Profile: ${profile.name} (${profile.id})`);
  console.log(`engine_anime: ${profile.filters?.engine_anime || 'off'}`);

  // Run buildRecommendations with the anime engine off (it's off by default).
  const result = await pipeline.buildRecommendations(profile, console, { ai: false });

  // Print the movie and series pools for comparison.
  const moviePool = recommendationStore.getPool(profile.id, 'movie');
  const seriesPool = recommendationStore.getPool(profile.id, 'series');

  const out = {
    profile: profile.name,
    movie: moviePool.map((r) => ({ tmdb_id: r.tmdb_id, affinity: r.affinity })),
    series: seriesPool.map((r) => ({ tmdb_id: r.tmdb_id, affinity: r.affinity })),
  };

  const json = JSON.stringify(out, null, 2);

  if (process.argv[3]) {
    // Compare against a reference JSON file.
    const ref = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const same = JSON.stringify(out.movie) === JSON.stringify(ref.movie) && JSON.stringify(out.series) === JSON.stringify(ref.series);
    if (same) {
      console.log('IDENTICAL: movie/series pools match the reference.');
    } else {
      console.log('MISMATCH: pools differ from the reference.');
      console.log('\n--- Branch pools ---');
      console.log(json);
      console.log('\n--- Reference pools ---');
      console.log(JSON.stringify(ref, null, 2));
      process.exit(1);
    }
  } else {
    // Print the pools for manual comparison.
    console.log(json);
  }
})().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
