// Cinemeta — Stremio's own default metadata addon.
//
// Used for ONE narrow job: anime episode numbering. TMDB numbers anime by
// broadcast season; IMDb (and therefore Cinemeta) often numbers the same show
// differently, and stream addons like Torrentio and Comet were built and
// tested against Cinemeta's ids. When the two disagree, our `tt:S:E` can point
// at an episode no stream addon can resolve — which is what "nothing opens"
// looks like from the sofa.
//
// So for ANIME SERIES ONLY we take Cinemeta's episode list as authoritative
// and keep TMDB for everything else. Non-anime numbering already agrees.
const CINEMETA = 'https://v3-cinemeta.strem.io';
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';
const TIMEOUT_MS = 6000;

// Returns Stremio-shaped videos, or null when Cinemeta can't help — in which
// case the caller keeps the TMDB list. Never throws: a metadata lookup failing
// must not fail the title open.
async function seriesVideos(imdbId, nowMs = Date.now(), log = console) {
  try {
    const res = await fetch(`${CINEMETA}/meta/series/${encodeURIComponent(imdbId)}.json`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const videos = (await res.json())?.meta?.videos;
    if (!Array.isArray(videos) || !videos.length) return null;

    const out = [];
    for (const v of videos) {
      if (!Number.isInteger(v.season) || !Number.isInteger(v.episode)) continue;
      const ts = v.released ? Date.parse(v.released) : NaN;
      out.push({
        id: v.id || `${imdbId}:${v.season}:${v.episode}`,
        title: v.name || v.title || `Episode ${v.episode}`,
        season: v.season,
        episode: v.episode,
        released: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
        available: Number.isNaN(ts) ? true : ts <= nowMs,
        overview: v.overview || v.description || '',
        thumbnail: v.thumbnail || null,
      });
    }
    if (!out.length) return null;
    return out.sort((a, b) => a.season - b.season || a.episode - b.episode);
  } catch (err) {
    log.warn(`[cinemeta] ${imdbId} lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = { seriesVideos };
