// Stremio watched-history provider for auto-scrobble.
//
// Stremio syncs a per-account "library" (movies + series with playback state)
// to api.strem.io. One account = one library (no sub-profiles), so — unlike
// Nuvio — there's nothing to select. Library items are keyed by IMDb tt id.
//
// Watched detection (field names per stremio-core LibraryItemState):
//   movies  -> state.flaggedWatched > 0
//   series  -> the last watched episode lives in state.video_id, formatted
//              "<seriesId>:<season>:<episode>" (e.g. "tt0898266:9:18"). There
//              is NO state.season / state.episode field. v1 scrobbles that one
//              episode: enough to register the show in Trakt history (and
//              satisfy the recommender's show-level exclusion) without
//              over-claiming. Full per-episode history means decoding
//              state.watched (a bitfield) against Cinemeta — a clean v2.
const { USER_AGENT } = require('./trakt');

const BASE = (process.env.STREMIO_API_URL || 'https://api.strem.io/api').replace(/\/+$/, '');

async function post(path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Stremio ${path} failed (${res.status})`);
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    throw new Error(`Stremio ${path}: ${msg}`);
  }
  return data.result;
}

async function login(email, password) {
  const result = await post('login', { email, password, type: 'Login' });
  if (!result?.authKey) throw new Error('Stremio login returned no authKey');
  return result.authKey;
}

// Parse a series item's current-episode pointer out of state.video_id
// ("<seriesId>:<season>:<episode>", e.g. "tt0898266:9:18"). The series id is a
// single tt token with no colons, so the season/episode are the last two
// colon-separated parts. Returns { season, episode } or null (no episode
// selected, or unparseable). The field is snake_case even in the otherwise
// camelCase state — tolerate both spellings just in case.
function parseEpisode(state) {
  const vid = state.video_id || state.videoId;
  if (!vid) return null;
  const parts = String(vid).split(':');
  if (parts.length < 3) return null; // series id only — no episode watched yet
  const season = parseInt(parts[parts.length - 2], 10);
  const episode = parseInt(parts[parts.length - 1], 10);
  return Number.isInteger(season) && Number.isInteger(episode) ? { season, episode } : null;
}

// Normalize raw libraryItem rows -> watched items:
//   { type: 'movie'|'series', imdbId, season?, episode?, watchedAtMs }
// Pure — exported for tests.
function normalizeItems(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const imdbId = item._id;
    if (!imdbId || !String(imdbId).startsWith('tt')) continue;
    const st = item.state || {};
    const watchedAtMs = st.lastWatched ? (Date.parse(st.lastWatched) || 0) : 0;
    if (item.type === 'movie') {
      if ((st.flaggedWatched || 0) > 0) out.push({ type: 'movie', imdbId, watchedAtMs });
    } else if (item.type === 'series') {
      // Watched signal for series is the play counter / bitfield, not the
      // movie-only flaggedWatched. The episode itself comes from video_id.
      const watched = !!st.watched || (st.timesWatched || 0) > 0;
      const ep = watched ? parseEpisode(st) : null;
      if (ep) out.push({ type: 'series', imdbId, season: ep.season, episode: ep.episode, watchedAtMs });
    }
  }
  return out;
}

async function pullWatched({ email, password }) {
  const authKey = await login(email, password);
  const items = await post('datastoreGet', { authKey, collection: 'libraryItem', all: true });
  return normalizeItems(items);
}

module.exports = { login, pullWatched, normalizeItems, parseEpisode };
