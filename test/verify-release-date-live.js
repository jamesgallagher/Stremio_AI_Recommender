// WD-1 live check — NOT in npm test.
// Run inside the container: docker exec ai_recommender node --experimental-sqlite /app/test/verify-release-date-live.js
//
// Requires: a running server with Simkl + TMDB configured.
// Profile: Siobhan (default, or set WD1_PROFILE env var).
//
// What it does:
//   1. Picks a throwaway movie and a throwaway series NOT in her history.
//   2. Calls markWatched for each (stamps the release date).
//   3. Fetches Simkl history and prints the stored watched_at for each.
//   4. Tests overwrite behaviour on the throwaway movie:
//      (a) mark it with NO date via simkl.addToHistory directly, read watched_at (before)
//      (b) call markWatched for the same title (stamps release date), read again (after)
//      Print before/after and whether Simkl UPDATED or IGNORED the second post.
//   5. Clean up: remove the throwaway movie and series from history + delete pending shim.
//
// --dry flag: only prints what it would do and which titles it picked.
//
// Findings go to temp/wd1-handback.md.

const config = require('../src/config');
const simkl = require('../src/services/simkl');
const markWatched = require('../src/markWatched');
const watchedStore = require('../src/watchedStore');

const PROFILE_NAME = process.env.WD1_PROFILE || 'Siobhan';
const DRY = process.argv.includes('--dry');

// Hard-coded candidate lists (well-known titles with verified IMDb ids).
const MOVIE_CANDIDATES = [
  { imdbId: 'tt0068646', title: 'Star Wars' },
  { imdbId: 'tt0111161', title: 'The Shawshank Redemption' },
  { imdbId: 'tt0109830', title: 'The Dark Knight' },
  { imdbId: 'tt0114369', title: 'Inception' },
  { imdbId: 'tt0120737', title: 'Pulp Fiction' },
];
const SERIES_CANDIDATES = [
  { imdbId: 'tt0903747', title: 'Breaking Bad' },
  { imdbId: 'tt0944947', title: 'Game of Thrones' },
  { imdbId: 'tt0108778', title: 'The Wire' },
  { imdbId: 'tt0386676', title: 'The Sopranos' },
  { imdbId: 'tt0141842', title: 'The Lord of the Rings: The Return of the King' },
];

async function main() {
  const profiles = config.listProfiles();
  const profile = profiles.find((p) => p.name === PROFILE_NAME);
  if (!profile) {
    console.error(`Profile "${PROFILE_NAME}" not found. Available: ${profiles.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== WD-1 Live Check: ${PROFILE_NAME} ===\n`);

  // Fetch existing history to determine which candidates are NOT watched.
  const movies = await simkl.getAllItems(profile, 'movies');
  const shows = await simkl.getAllItems(profile, 'shows');
  const movieImdbIds = new Set(movies.map((m) => m.movie?.ids?.imdb).filter(Boolean));
  const showImdbIds = new Set(shows.map((s) => s.show?.ids?.imdb || s.anime?.ids?.imdb).filter(Boolean));

  const throwawayMovie = MOVIE_CANDIDATES.find((c) => !movieImdbIds.has(c.imdbId));
  const throwawaySeries = SERIES_CANDIDATES.find((c) => !showImdbIds.has(c.imdbId));

  if (!throwawayMovie) {
    console.error('All movie candidates are already in history. Cannot proceed.');
    process.exit(1);
  }
  if (!throwawaySeries) {
    console.error('All series candidates are already in history. Cannot proceed.');
    process.exit(1);
  }

  console.log(`Chosen throwaway movie: ${throwawayMovie.title} (${throwawayMovie.imdbId})`);
  console.log(`Chosen throwaway series: ${throwawaySeries.title} (${throwawaySeries.imdbId})`);

  if (DRY) {
    console.log('\n[dry] Would:');
    console.log(`  1. markWatched movie ${throwawayMovie.imdbId} (stamps release date)`);
    console.log(`  2. markWatched series ${throwawaySeries.imdbId} (stamps release date)`);
    console.log(`  3. Fetch Simkl history and print stored watched_at for each`);
    console.log(`  4. Overwrite test on ${throwawayMovie.imdbId}: addToHistory without date, then markWatched, print before/after`);
    console.log(`  5. Cleanup: removeFromHistory both + delete pending shim`);
    console.log('\n[dry] Done. No changes made.');
    return;
  }

  let throwawayMovieMarked = false;
  let throwawaySeriesMarked = false;

  try {
    // 1. Mark the throwaway movie via markWatched (stamps release date).
    console.log('\n1. markWatched throwaway movie...');
    const res1 = await markWatched.markWatched(profile, { type: 'movie', imdbId: throwawayMovie.imdbId, title: throwawayMovie.title }, console);
    console.log(`   result: ${JSON.stringify(res1)}`);
    throwawayMovieMarked = res1.ok;

    // 2. Mark the throwaway series via markWatched (stamps release date).
    console.log('\n2. markWatched throwaway series...');
    const res2 = await markWatched.markWatched(profile, { type: 'series', imdbId: throwawaySeries.imdbId, title: throwawaySeries.title }, console);
    console.log(`   result: ${JSON.stringify(res2)}`);
    throwawaySeriesMarked = res2.ok;

    // 3. Fetch Simkl history and print stored watched_at.
    console.log('\n3. Fetching Simkl history...');
    const movies2 = await simkl.getAllItems(profile, 'movies');
    const shows2 = await simkl.getAllItems(profile, 'shows');
    const movieEntry = movies2.find((m) => m.movie?.ids?.imdb === throwawayMovie.imdbId);
    const seriesEntry = shows2.find((s) => s.show?.ids?.imdb === throwawaySeries.imdbId);
    const movieWatchedAt = movieEntry?.last_watched_at || movieEntry?.watched_at || null;
    const seriesWatchedAt = seriesEntry?.last_watched_at || seriesEntry?.watched_at || null;
    console.log(`   throwaway movie watched_at: ${movieWatchedAt || 'NOT FOUND'}`);
    console.log(`   throwaway series watched_at: ${seriesWatchedAt || 'NOT FOUND'}`);

    // 4. Overwrite test on the throwaway movie.
    console.log('\n4. Overwrite test on throwaway movie...');
    // (a) Mark with NO date via simkl.addToHistory directly.
    const noDateBody = markWatched.buildWatchedHistoryBody({ type: 'movie', imdbId: throwawayMovie.imdbId });
    await simkl.addToHistory(profile, noDateBody);
    const movies3 = await simkl.getAllItems(profile, 'movies');
    const beforeEntry = movies3.find((m) => m.movie?.ids?.imdb === throwawayMovie.imdbId);
    const before = beforeEntry?.last_watched_at || beforeEntry?.watched_at || null;
    console.log(`   before (no-date post): ${before || 'NOT FOUND'}`);

    // (b) Call markWatched for the same title (stamps the release date).
    const res4 = await markWatched.markWatched(profile, { type: 'movie', imdbId: throwawayMovie.imdbId, title: throwawayMovie.title }, console);
    console.log(`   markWatched result: ${JSON.stringify(res4)}`);

    const movies4 = await simkl.getAllItems(profile, 'movies');
    const afterEntry = movies4.find((m) => m.movie?.ids?.imdb === throwawayMovie.imdbId);
    const after = afterEntry?.last_watched_at || afterEntry?.watched_at || null;
    console.log(`   after (markWatched): ${after || 'NOT FOUND'}`);

    if (before && after) {
      const updated = before !== after;
      console.log(`   Simkl ${updated ? 'UPDATED' : 'IGNORED'} the second post.`);
    } else {
      console.log(`   Could not determine update behaviour (before: ${before}, after: ${after}).`);
    }

    // 5. Cleanup.
    console.log('\n5. Cleanup...');
    await simkl.removeFromHistory(profile, [{ type: 'movie', imdb_id: throwawayMovie.imdbId }]);
    await simkl.removeFromHistory(profile, [{ type: 'series', imdb_id: throwawaySeries.imdbId }]);
    watchedStore.deleteForProfile(profile.id);
    console.log('   Cleanup succeeded — throwaway titles removed from history, pending shim cleared.');

  } finally {
    // Ensure cleanup runs even on failure.
    if (throwawayMovieMarked || throwawaySeriesMarked) {
      try {
        await simkl.removeFromHistory(profile, [{ type: 'movie', imdb_id: throwawayMovie.imdbId }]);
        await simkl.removeFromHistory(profile, [{ type: 'series', imdb_id: throwawaySeries.imdbId }]);
        watchedStore.deleteForProfile(profile.id);
        console.log('   [finally] Cleanup succeeded.');
      } catch (err) {
        console.error(`   [finally] Cleanup failed: ${err.message}`);
      }
    }
  }

  console.log('\n=== Done ===');
  console.log('Report findings in temp/wd1-handback.md');
}

main().catch((err) => {
  console.error('Live check failed:', err.message);
  process.exit(1);
});
