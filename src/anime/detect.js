// AN-1a: the anime detector, moved from engines/marqueeTv/filters.js (§2.4).
// Any one signal → anime. `genres` are TMDB's RAW genre names.
// `animeMap.ensureLoaded()` is called once per build. Why four signals:
// Pokémon (tt0313487) slipped past the anime map alone in the live research.
function isAnimeShow({ imdb_id, tmdb_id, genres = [], origin_country = [], original_language = null, simklType = null }, { animeMap: am }) {
  if (simklType === 'anime') return true;
  if (am && am.isAnime(imdb_id, tmdb_id)) return true;
  const animated = genres.includes('Animation');
  const japanese = (origin_country || []).includes('JP') || original_language === 'ja';
  return animated && japanese;
}

module.exports = { isAnimeShow };
