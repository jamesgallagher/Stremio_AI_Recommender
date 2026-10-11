// WD-1 live check — NOT in npm test.
// Run inside the container: docker exec ai_recommender node --experimental-sqlite /app/test/verify-release-date-live.js
//
// Requires: a running server with Simkl + TMDB configured.
// Profile: Siobhan (default, or set WD1_PROFILE env var).
//
// What it does:
//   1. Picks a throwaway movie and a throwaway series NOT in her history
//      (checks ALL statuses: completed, plantowatch, watching, hold, dropped;
//      plus the anime section).
//   2. Calls markWatched for each (stamps the release date).
//   3. Fetches Simkl history and prints the stored watched_at for each.
//   4. Tests overwrite behaviour on the throwaway movie:
//      (a) mark it with NO date via simkl.addToHistory directly, read watched_at (before)
//      (b) call markWatched for the same title (stamps release date), read again (after)
//      Print before/after and whether Simkl UPDATED or IGNORED the second post.
//      If res4.watchedAt is null, prints "UNDETERMINED (no release date resolved)".
//   5. Clean up: remove the throwaway movie and series from history + removeWatched
//      (NOT deleteForProfile — that would wipe her entire local database).
//
// --dry flag: only prints what it would do and which titles it picked.
// --selftest flag: substitutes a fake profile and stubbed simkl.getAllItems
//   (no network, no DB writes), runs the full dry path, prints the dry plan.
//   Second case: stubs report the first candidate present in plantowatch,
//   proving the next candidate is chosen.
//
// Findings go to temp/wd1-handback.md.

const config = require('../src/config');
const simkl = require('../src/services/simkl');
const markWatched = require('../src/markWatched');
const watchedStore = require('../src/watchedStore');

const PROFILE_NAME = process.env.WD1_PROFILE || 'Siobhan';
const DRY = process.argv.includes('--dry');
const SELFTEST = process.argv.includes('--selftest');

// All statuses to check for "not in her history".
const ALL_STATUSES = ['completed', 'plantowatch', 'watching', 'hold', 'dropped'];

// Hard-coded candidate lists (well-known titles with verified IMDb ids).
// Names are NOT printed — the Simkl/TMDB response provides the real title.
const MOVIE_CANDIDATES = [
  { imdbId: 'tt0068646' },
  { imdbId: 'tt0111161' },
  { imdbId: 'tt0109830' },
  { imdbId: 'tt0114369' },
  { imdbId: 'tt0120737' },
];
const SERIES_CANDIDATES = [
  { imdbId: 'tt0903747' },
  { imdbId: 'tt0944947' },
  { imdbId: 'tt0108778' },
  { imdbId: 'tt0386676' },
  { imdbId: 'tt0141842' },
];

// Build the exclusion set from ALL statuses for movies and shows (+ anime).
async function buildExclusionSet(profile) {
  const movieIds = new Set();
  const showIds = new Set();

  for (const status of ALL_STATUSES) {
    try {
      const movies = await simkl.getAllItems(profile, 'movies', { status });
      for (const m of movies) {
        const imdb = m.movie?.ids?.imdb;
        if (imdb) movieIds.add(imdb);
      }
    } catch (err) {
      if (status === 'completed') {
        console.error(`FATAL: getAllItems movies/completed failed: ${err.message}`);
        process.exit(1);
      }
      console.warn(`Warning: getAllItems movies/${status} failed: ${err.message}`);
    }
  }

  for (const status of ALL_STATUSES) {
    try {
      const shows = await simkl.getAllItems(profile, 'shows', { status });
      for (const s of shows) {
        const imdb = s.show?.ids?.imdb || s.anime?.ids?.imdb;
        if (imdb) showIds.add(imdb);
      }
    } catch (err) {
      if (status === 'completed') {
        console.error(`FATAL: getAllItems shows/completed failed: ${err.message}`);
        process.exit(1);
      }
      console.warn(`Warning: getAllItems shows/${status} failed: ${err.message}`);
    }
  }

  // Include the anime section in the shows set.
  for (const status of ALL_STATUSES) {
    try {
      const anime = await simkl.getAllItems(profile, 'anime', { status });
      for (const a of anime) {
        const imdb = a.anime?.ids?.imdb;
        if (imdb) showIds.add(imdb);
      }
    } catch (err) {
      console.warn(`Warning: getAllItems anime/${status} failed: ${err.message}`);
    }
  }

  return { movieIds, showIds };
}

async function main() {
  let profile;

  if (SELFTEST) {
    // --selftest: fake profile, stubbed getAllItems (no network, no DB writes).
    profile = { id: 'selftest', name: 'SelfTest', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    console.log('\n=== WD-1 Live Check: SELFTEST (fake profile, stubbed Simkl) ===\n');

    // Case 1: all candidates absent → first candidate chosen.
    console.log('--- Case 1: all candidates absent ---');
    const origGetAllItems = simkl.getAllItems;
    simkl.getAllItems = async (_profile, _type, _opts) => [];
    try {
      const { movieIds, showIds } = await buildExclusionSet(profile);
      const throwawayMovie = MOVIE_CANDIDATES.find((c) => !movieIds.has(c.imdbId));
      const throwawaySeries = SERIES_CANDIDATES.find((c) => !showIds.has(c.imdbId));
      console.log(`  Chosen movie: ${throwawayMovie.imdbId}`);
      console.log(`  Chosen series: ${throwawaySeries.imdbId}`);
      assert.strictEqual(throwawayMovie.imdbId, 'tt0068646', 'first movie candidate');
      assert.strictEqual(throwawaySeries.imdbId, 'tt0903747', 'first series candidate');
      console.log('  ✓ Case 1 passed (first candidate chosen when all absent)');
    } finally {
      simkl.getAllItems = origGetAllItems;
    }

    // Case 2: first candidate present in plantowatch → next candidate chosen.
    console.log('--- Case 2: first movie candidate in plantowatch ---');
    simkl.getAllItems = async (_profile, type, { status } = {}) => {
      if (type === 'movies' && status === 'plantowatch') {
        return [{ movie: { ids: { imdb: 'tt0068646' } } }];
      }
      return [];
    };
    try {
      const { movieIds, showIds } = await buildExclusionSet(profile);
      const throwawayMovie = MOVIE_CANDIDATES.find((c) => !movieIds.has(c.imdbId));
      const throwawaySeries = SERIES_CANDIDATES.find((c) => !showIds.has(c.imdbId));
      console.log(`  Chosen movie: ${throwawayMovie.imdbId}`);
      console.log(`  Chosen series: ${throwawaySeries.imdbId}`);
      assert.strictEqual(throwawayMovie.imdbId, 'tt0111161', 'second movie candidate (first is in plantowatch)');
      assert.strictEqual(throwawaySeries.imdbId, 'tt0903747', 'first series candidate');
      console.log('  ✓ Case 2 passed (plantowatch candidate skipped)');
    } finally {
      simkl.getAllItems = origGetAllItems;
    }

    console.log('\n=== SELFTEST PASSED ===');
    return;
  }

  // Normal run (or --dry).
  const profiles = config.listProfiles();
  profile = profiles.find((p) => p.name === PROFILE_NAME);
  if (!profile) {
    console.error(`Profile "${PROFILE_NAME}" not found. Available: ${profiles.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== WD-1 Live Check: ${PROFILE_NAME} ===\n`);

  // Build the exclusion set from ALL statuses.
  const { movieIds, showIds } = await buildExclusionSet(profile);

  const throwawayMovie = MOVIE_CANDIDATES.find((c) => !movieIds.has(c.imdbId));
  const throwawaySeries = SERIES_CANDIDATES.find((c) => !showIds.has(c.imdbId));

  if (!throwawayMovie) {
    console.error('All movie candidates are already in history (across all statuses). Cannot proceed.');
    process.exit(1);
  }
  if (!throwawaySeries) {
    console.error('All series candidates are already in history (across all statuses). Cannot proceed.');
    process.exit(1);
  }

  // Additional safety: check the pending shim.
  const pendingSets = watchedStore.watchedIdSets(profile.id);
  if (pendingSets.imdb.has(throwawayMovie.imdbId)) {
    console.error(`Safety check failed: ${throwawayMovie.imdbId} is in the pending shim.`);
    process.exit(1);
  }
  if (pendingSets.imdb.has(throwawaySeries.imdbId)) {
    console.error(`Safety check failed: ${throwawaySeries.imdbId} is in the pending shim.`);
    process.exit(1);
  }

  console.log(`Chosen throwaway movie: ${throwawayMovie.imdbId}`);
  console.log(`Chosen throwaway series: ${throwawaySeries.imdbId}`);

  if (DRY) {
    console.log('\n[dry] Would:');
    console.log(`  1. markWatched movie ${throwawayMovie.imdbId} (stamps release date)`);
    console.log(`  2. markWatched series ${throwawaySeries.imdbId} (stamps release date)`);
    console.log(`  3. Fetch Simkl history and print stored watched_at for each`);
    console.log(`  4. Overwrite test on ${throwawayMovie.imdbId}: addToHistory without date, then markWatched, print before/after`);
    console.log(`  5. Cleanup: removeFromHistory both + removeWatched (NOT deleteForProfile)`);
    console.log('\n[dry] Done. No changes made.');
    return;
  }

  try {
    // 1. Mark the throwaway movie via markWatched (stamps release date).
    console.log('\n1. markWatched throwaway movie...');
    const res1 = await markWatched.markWatched(profile, { type: 'movie', imdbId: throwawayMovie.imdbId }, console);
    console.log(`   result: ${JSON.stringify(res1)}`);

    // 2. Mark the throwaway series via markWatched (stamps release date).
    console.log('\n2. markWatched throwaway series...');
    const res2 = await markWatched.markWatched(profile, { type: 'series', imdbId: throwawaySeries.imdbId }, console);
    console.log(`   result: ${JSON.stringify(res2)}`);

    // 3. Fetch Simkl history and print stored watched_at.
    console.log('\n3. Fetching Simkl history...');
    const movies2 = await simkl.getAllItems(profile, 'movies', { status: 'completed' });
    const shows2 = await simkl.getAllItems(profile, 'shows', { status: 'completed' });
    const movieEntry = movies2.find((m) => m.movie?.ids?.imdb === throwawayMovie.imdbId);
    const seriesEntry = shows2.find((s) => s.show?.ids?.imdb === throwawaySeries.imdbId);
    const movieWatchedAt = movieEntry?.last_watched_at || movieEntry?.watched_at || null;
    const seriesWatchedAt = seriesEntry?.last_watched_at || seriesEntry?.watched_at || null;
    console.log(`   throwaway movie (${throwawayMovie.imdbId}) watched_at: ${movieWatchedAt || 'NOT FOUND'}`);
    console.log(`   throwaway series (${throwawaySeries.imdbId}) watched_at: ${seriesWatchedAt || 'NOT FOUND'}`);

    // 4. Overwrite test on the throwaway movie.
    console.log('\n4. Overwrite test on throwaway movie...');
    // (a) Mark with NO date via simkl.addToHistory directly.
    const noDateBody = markWatched.buildWatchedHistoryBody({ type: 'movie', imdbId: throwawayMovie.imdbId });
    await simkl.addToHistory(profile, noDateBody);
    const movies3 = await simkl.getAllItems(profile, 'movies', { status: 'completed' });
    const beforeEntry = movies3.find((m) => m.movie?.ids?.imdb === throwawayMovie.imdbId);
    const before = beforeEntry?.last_watched_at || beforeEntry?.watched_at || null;
    console.log(`   before (no-date post): ${before || 'NOT FOUND'}`);

    // (b) Call markWatched for the same title (stamps the release date).
    const res4 = await markWatched.markWatched(profile, { type: 'movie', imdbId: throwawayMovie.imdbId }, console);
    console.log(`   markWatched result: ${JSON.stringify(res4)}`);

    const movies4 = await simkl.getAllItems(profile, 'movies', { status: 'completed' });
    const afterEntry = movies4.find((m) => m.movie?.ids?.imdb === throwawayMovie.imdbId);
    const after = afterEntry?.last_watched_at || afterEntry?.watched_at || null;
    console.log(`   after (markWatched): ${after || 'NOT FOUND'}`);

    // G5: read the result honestly.
    if (res4.watchedAt == null) {
      console.log('   UNDETERMINED (no release date resolved)');
    } else if (before && after) {
      const updated = before !== after;
      console.log(`   Simkl ${updated ? 'UPDATED' : 'IGNORED'} the second post.`);
    } else {
      console.log(`   Could not determine update behaviour (before: ${before}, after: ${after}).`);
    }

    // 5. Cleanup: remove the throwaway titles from Simkl history + local DB.
    // G1: use removeWatched (per-title), NOT deleteForProfile (wipes the entire
    // local database: watched, sync_state, series_progress, scrobble_pushed_*,
    // unwatched_block). deleteForProfile is only appropriate for test profiles.
    console.log('\n5. Cleanup...');
    await simkl.removeFromHistory(profile, [{ type: 'movie', imdb_id: throwawayMovie.imdbId }]);
    await simkl.removeFromHistory(profile, [{ type: 'series', imdb_id: throwawaySeries.imdbId }]);
    // Per-title local cleanup: removeWatched deletes only this title's watched
    // and pending_watched rows. There is no per-title delete for series_progress
    // (noted in handback); the throwaway series was just marked watched, so no
    // series_progress row should exist for it.
    watchedStore.removeWatched(profile.id, 'movie', { imdbId: throwawayMovie.imdbId });
    watchedStore.removeWatched(profile.id, 'series', { imdbId: throwawaySeries.imdbId });
    console.log('   Cleanup succeeded — throwaway titles removed from history + local DB.');

  } finally {
    // Ensure cleanup runs even on failure.
    try {
      await simkl.removeFromHistory(profile, [{ type: 'movie', imdb_id: throwawayMovie.imdbId }]);
      await simkl.removeFromHistory(profile, [{ type: 'series', imdb_id: throwawaySeries.imdbId }]);
      watchedStore.removeWatched(profile.id, 'movie', { imdbId: throwawayMovie.imdbId });
      watchedStore.removeWatched(profile.id, 'series', { imdbId: throwawaySeries.imdbId });
      console.log('   [finally] Cleanup succeeded.');
    } catch (err) {
      console.error(`   [finally] Cleanup failed: ${err.message}`);
    }
  }

  console.log('\n=== Done ===');
  console.log('Report findings in temp/wd1-handback.md');
}

const assert = require('assert');
main().catch((err) => {
  console.error('Live check failed:', err.message);
  process.exit(1);
});
