// WD-1 live check — NOT in npm test.
// Run against the Unraid test profile (Siobhan, not a kid profile).
//
// Usage:
//   node --experimental-sqlite test/verify-release-date-live.js
//
// Requires:
//   - A running server with Simkl + TMDB configured
//   - A profile named 'Siobhan' (or set WD1_PROFILE to the profile name)
//   - A throwaway movie and a throwaway series NOT in her history
//
// What it does:
//   1. Calls markWatched for a throwaway movie and a throwaway series.
//   2. Fetches Simkl history and prints the stored watched_at for each.
//   3. For a title ALREADY in history with a "now" date, re-posts with
//      watched_at and prints before/after to see if Simkl updates or ignores.
//
// Findings go to temp/wd1-handback.md.

const config = require('../src/config');
const markWatched = require('../src/markWatched');
const simkl = require('../src/services/simkl');

const PROFILE_NAME = process.env.WD1_PROFILE || 'Siobhan';
// Throwaway titles NOT in Siobhan's history. Adjust if needed.
const THROWAWAY_MOVIE = { type: 'movie', imdbId: 'tt0112470', tmdbId: '17384', title: 'A Throwaway Movie' };
const THROWAWAY_SERIES = { type: 'series', imdbId: 'tt0110087', tmdbId: '9000', title: 'A Throwaway Series' };
// A title ALREADY in history (adjust to one that is in Siobhan's history).
const EXISTING_TITLE = { type: 'movie', imdbId: 'tt0133093', tmdbId: '603', title: 'The Matrix' };

async function main() {
  const profile = config.getProfiles().find((p) => p.name === PROFILE_NAME);
  if (!profile) {
    console.error(`Profile "${PROFILE_NAME}" not found. Set WD1_PROFILE to the correct name.`);
    process.exit(1);
  }

  console.log(`\n=== WD-1 Live Check: ${PROFILE_NAME} ===\n`);

  // 1. Mark a throwaway movie
  console.log('1. markWatched throwaway movie...');
  const res1 = await markWatched.markWatched(profile, THROWAWAY_MOVIE, console);
  console.log(`   result: ${JSON.stringify(res1)}`);

  // 2. Mark a throwaway series
  console.log('2. markWatched throwaway series...');
  const res2 = await markWatched.markWatched(profile, THROWAWAY_SERIES, console);
  console.log(`   result: ${JSON.stringify(res2)}`);

  // 3. Fetch Simkl history and print stored watched_at
  console.log('\n3. Fetching Simkl history...');
  const history = await simkl.getHistory(profile);
  const movieEntry = (history.movies || []).find((m) => m.imdb_id === THROWAWAY_MOVIE.imdbId || m.tmdb_id === Number(THROWAWAY_MOVIE.tmdbId));
  const seriesEntry = (history.shows || []).find((s) => s.imdb_id === THROWAWAY_SERIES.imdbId || s.tmdb_id === Number(THROWAWAY_SERIES.tmdbId));
  console.log(`   throwaway movie watched_at: ${movieEntry ? movieEntry.watched_at : 'NOT FOUND'}`);
  console.log(`   throwaway series watched_at: ${seriesEntry ? seriesEntry.watched_at : 'NOT FOUND'}`);

  // 4. Re-post an existing title with watched_at
  console.log('\n4. Re-post existing title with watched_at...');
  const before = (history.movies || []).find((m) => m.imdb_id === EXISTING_TITLE.imdbId || m.tmdb_id === Number(EXISTING_TITLE.tmdbId));
  console.log(`   before: ${before ? before.watched_at : 'NOT FOUND'}`);

  const res4 = await markWatched.markWatched(profile, EXISTING_TITLE, console);
  console.log(`   markWatched result: ${JSON.stringify(res4)}`);

  const history2 = await simkl.getHistory(profile);
  const after = (history2.movies || []).find((m) => m.imdb_id === EXISTING_TITLE.imdbId || m.tmdb_id === Number(EXISTING_TITLE.tmdbId));
  console.log(`   after:  ${after ? after.watched_at : 'NOT FOUND'}`);

  console.log('\n=== Done ===');
  console.log('Report findings in temp/wd1-handback.md');
}

main().catch((err) => {
  console.error('Live check failed:', err.message);
  process.exit(1);
});
