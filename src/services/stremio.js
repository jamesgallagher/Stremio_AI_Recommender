// Stremio watched-history provider for auto-scrobble.
//
// Stremio syncs a per-account "library" (movies + series with playback state)
// to api.strem.io. One account = one library (no sub-profiles), so — unlike
// Nuvio — there's nothing to select. Library items are keyed by IMDb tt id.
//
// Watched detection:
//   movies  -> state.flaggedWatched > 0
//   series  -> state carries the LAST watched season/episode (state.season /
//              state.episode). v1 scrobbles that one episode: enough to register
//              the show in Trakt history (and satisfy the recommender's
//              show-level exclusion) without over-claiming. Full per-episode
//              history means decoding state.watched (a zlib bitfield) against
//              Cinemeta — a clean v2.
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

// Normalized watched items:
//   { type: 'movie'|'series', imdbId, season?, episode?, watchedAtMs }
async function pullWatched({ email, password }) {
  const authKey = await login(email, password);
  const items = await post('datastoreGet', { authKey, collection: 'libraryItem', all: true });
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const imdbId = item._id;
    if (!imdbId || !String(imdbId).startsWith('tt')) continue;
    const st = item.state || {};
    const watchedAtMs = st.lastWatched ? (Date.parse(st.lastWatched) || 0) : 0;
    if (item.type === 'movie') {
      if ((st.flaggedWatched || 0) > 0) {
        out.push({ type: 'movie', imdbId, watchedAtMs });
      }
    } else if (item.type === 'series') {
      // Last watched episode only (v1). season/episode are on the state.
      if (st.season != null && st.episode != null && (st.watched || (st.timesWatched || 0) > 0)) {
        out.push({ type: 'series', imdbId, season: st.season, episode: st.episode, watchedAtMs });
      }
    }
  }
  return out;
}

module.exports = { login, pullWatched };
