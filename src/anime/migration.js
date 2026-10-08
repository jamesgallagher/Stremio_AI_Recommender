// AN-1a §8.2: one-time lane migration. For each profile without a marker:
//   1. Load the Fribb anime map.
//   2. Classify the profile's Simkl anime history (kind='anime' plus 'show'
//      rows the detector flags) and count engaged titles.
//   3. Count series-typed taste rows (ratings, ignores, dont_recommend) whose
//      tmdb_id is in the profile's anime history.
//   4. Delete recommended rows with type='series' that the Fribb map flags as
//      anime, and count them.
//   5. Insert the marker with the JSON report.
// Idempotent: a profile with a marker is skipped. Read-only for everything
// except the pool delete and the marker insert.
const db = require('../db');
const config = require('../config');
const animeMap = require('../services/animeMap');
const { animeProgress, animeTmdbIds } = require('./history');

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS anime_lane_migration (
      profile_id TEXT PRIMARY KEY,
      migrated_at INTEGER NOT NULL,
      report TEXT NOT NULL
    );
  `);
  ready = true;
}

// Returns the parsed report for a profile, or null.
function getReport(profileId) {
  init();
  const row = db.get().prepare('SELECT report FROM anime_lane_migration WHERE profile_id = ?').get(profileId);
  return row ? JSON.parse(row.report) : null;
}

async function runAll(log = console) {
  init();
  const conn = db.get();
  const profiles = config.listProfiles();

  for (const profile of profiles) {
    // Idempotent: skip profiles already migrated.
    const existing = conn.prepare('SELECT 1 FROM anime_lane_migration WHERE profile_id = ?').get(profile.id);
    if (existing) continue;

    // 1. Load the anime map.
    await animeMap.ensureLoaded(log);

    // 2. Classify anime history.
    const progress = animeProgress(profile.id);
    const animeSimkl = progress.filter((r) => r.kind === 'anime').length;
    const animeDetectedInShows = progress.filter((r) => r.kind === 'show').length;
    const engaged = progress.filter((r) => r.watched_eps >= 3 || r.status === 'completed').length;

    // 3. Count series-typed taste rows whose tmdb_id is in animeTmdbIds.
    const ids = animeTmdbIds(profile.id);
    let ratings = 0, ignores = 0, dontRecommend = 0;
    if (ids.size > 0) {
      const idList = [...ids];
      const placeholders = idList.map(() => '?').join(',');
      ratings = conn.prepare(`SELECT COUNT(*) AS n FROM taste_ratings WHERE profile_id = ? AND type = 'series' AND tmdb_id IN (${placeholders})`).get(profile.id, ...idList).n;
      ignores = conn.prepare(`SELECT COUNT(*) AS n FROM taste_ignore WHERE profile_id = ? AND type = 'series' AND tmdb_id IN (${placeholders})`).get(profile.id, ...idList).n;
      dontRecommend = conn.prepare(`SELECT COUNT(*) AS n FROM dont_recommend WHERE profile_id = ? AND type = 'series' AND tmdb_id IN (${placeholders})`).get(profile.id, ...idList).n;
    }

    // 4. Delete recommended rows with type='series' that the Fribb map flags as anime.
    const recRows = conn.prepare("SELECT tmdb_id, imdb_id FROM recommended WHERE profile_id = ? AND type = 'series'").all(profile.id);
    let seriesPoolRemoved = 0;
    for (const rec of recRows) {
      if (animeMap.isAnime(rec.imdb_id, rec.tmdb_id)) {
        conn.prepare("DELETE FROM recommended WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").run(profile.id, rec.tmdb_id);
        seriesPoolRemoved++;
      }
    }

    // 5. Insert the marker.
    const report = {
      anime_simkl: animeSimkl,
      anime_detected_in_shows: animeDetectedInShows,
      engaged,
      ratings,
      ignores,
      dont_recommend: dontRecommend,
      series_pool_removed: seriesPoolRemoved,
    };
    conn.prepare('INSERT INTO anime_lane_migration (profile_id, migrated_at, report) VALUES (?, ?, ?)').run(profile.id, Date.now(), JSON.stringify(report));

    // 6. Log.
    log.log(`[anime] ${profile.name}: lane migration — ${animeSimkl} Simkl anime + ${animeDetectedInShows} detected under shows (${engaged} engaged), ${ratings} rating(s), ${ignores} ignore(s), ${dontRecommend} don't-recommend, ${seriesPoolRemoved} removed from the series pool`);
  }
}

module.exports = { runAll, getReport };
