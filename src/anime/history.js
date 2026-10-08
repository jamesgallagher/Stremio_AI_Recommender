// AN-1a mandate 7: anime history is classified at READ time. Simkl's anime
// section is anime; a 'show' row the detector flags (e.g. Pokéglitch, filed by
// Simkl under shows) is anime too. Stored rows are never re-typed — a Simkl
// re-sync would undo it.
const watchedStore = require('../watchedStore');
const animeMap = require('../services/animeMap');
const { isAnimeShow } = require('./detect');

function isAnimeProgressRow(row) {
  if (row.kind === 'anime') return true;
  return isAnimeShow({ imdb_id: row.imdb_id, tmdb_id: row.tmdb_id }, { animeMap });
}

// Every anime series_progress row for a profile. Call animeMap.ensureLoaded first.
function animeProgress(profileId) {
  return watchedStore.getSeriesProgress(profileId).filter(isAnimeProgressRow);
}

// tmdb ids (strings) of the profile's anime history — for classifying ratings,
// ignores and pool rows.
function animeTmdbIds(profileId) {
  return new Set(animeProgress(profileId).map((r) => String(r.tmdb_id)).filter(Boolean));
}

module.exports = { isAnimeProgressRow, animeProgress, animeTmdbIds };
