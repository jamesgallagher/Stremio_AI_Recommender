// Trakt: OAuth device flow per profile + /sync endpoints.
// One Trakt API app per profile (client ID/secret stored on the profile).
const config = require('../config');

const API = 'https://api.trakt.tv';

// Node's built-in fetch sends NO User-Agent by default; Trakt (behind
// Cloudflare) rejects UA-less requests with 403. Always send a real one,
// and send the trakt-api-key/version headers on every call including OAuth,
// per Trakt's API docs.
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';

function baseHeaders(clientId) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  };
}

function headers(profile, withAuth = true) {
  const h = baseHeaders(profile.keys.trakt_client_id);
  if (withAuth && profile.trakt_auth?.access_token) {
    h.Authorization = `Bearer ${profile.trakt_auth.access_token}`;
  }
  return h;
}

// ---- Device flow ----
async function startDeviceFlow(profile) {
  console.log(`[trakt] ${profile.name}: requesting device code (client_id ${profile.keys.trakt_client_id.slice(0, 8)}…)`);
  const res = await fetch(`${API}/oauth/device/code`, {
    method: 'POST',
    headers: baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({ client_id: profile.keys.trakt_client_id }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[trakt] ${profile.name}: device code failed ${res.status}${body ? ` — response: ${body}` : ''}`);
    const hint = res.status === 403
      ? ' (403 = Trakt does not recognize this Client ID — re-copy it from your Trakt app page)'
      : ' — check the Client ID';
    throw new Error(`Trakt device code failed (${res.status})${body ? `: ${body}` : ''}${hint}`);
  }
  const dc = await res.json();
  console.log(`[trakt] ${profile.name}: device code issued, user code ${dc.user_code}, expires in ${dc.expires_in}s`);
  return dc; // { device_code, user_code, verification_url, expires_in, interval }
}

async function pollDeviceToken(profile, deviceCode) {
  const res = await fetch(`${API}/oauth/device/token`, {
    method: 'POST',
    headers: baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({
      code: deviceCode,
      client_id: profile.keys.trakt_client_id,
      client_secret: profile.keys.trakt_client_secret,
    }),
  });
  if (res.status === 400) return { pending: true }; // user hasn't approved yet
  if (res.status === 409) return { pending: true }; // already polled too fast
  if (res.status === 404) return { error: 'Invalid device code (expired?)' };
  if (res.status === 410) return { error: 'Code expired — start again' };
  if (res.status === 418) return { error: 'User denied the authorization' };
  if (res.status === 403) return { error: 'Trakt rejected the Client Secret (403) — re-copy it from your Trakt app page' };
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`[trakt] ${profile.name}: token poll failed ${res.status}${body ? ` — ${body}` : ''}`);
    return { error: `Trakt token poll failed (${res.status})${body ? `: ${body}` : ''}` };
  }
  const tok = await res.json();
  console.log(`[trakt] ${profile.name}: authorization complete, token expires ${new Date(Date.now() + (tok.expires_in || 7776000) * 1000).toISOString()}`);
  return {
    token: {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 7776000) * 1000,
    },
  };
}

// ---- Token refresh ----
async function refreshToken(profile) {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({
      refresh_token: profile.trakt_auth.refresh_token,
      client_id: profile.keys.trakt_client_id,
      client_secret: profile.keys.trakt_client_secret,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`[trakt] ${profile.name}: token refresh failed ${res.status}${body ? ` — ${body}` : ''}`);
    throw new Error(`Trakt token refresh failed (${res.status}) — profile may need re-authorization`);
  }
  console.log(`[trakt] ${profile.name}: token refreshed`);
  const tok = await res.json();
  const trakt_auth = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 7776000) * 1000,
  };
  config.updateProfile(profile.id, { trakt_auth });
  profile.trakt_auth = trakt_auth;
  return trakt_auth;
}

async function authedGet(profile, urlPath) {
  if (!profile.trakt_auth?.access_token) {
    throw new Error('Trakt not authorized for this profile');
  }
  // Proactive refresh if within 24h of expiry
  if (profile.trakt_auth.expires_at && profile.trakt_auth.expires_at - Date.now() < 24 * 3600e3) {
    await refreshToken(profile);
  }
  let res = await fetch(`${API}${urlPath}`, { headers: headers(profile) });
  if (res.status === 401) {
    // Token invalidated server-side — try one refresh, then re-request
    await refreshToken(profile);
    res = await fetch(`${API}${urlPath}`, { headers: headers(profile) });
  }
  if (!res.ok) throw new Error(`Trakt GET ${urlPath} failed (${res.status})`);
  return res.json();
}

// ---- Taste signal: recent history (unique titles) ----
async function getRecentHistory(profile, type /* 'movie' | 'series' */) {
  const endpoint = type === 'series' ? 'shows' : 'movies';
  const items = await authedGet(profile, `/sync/history/${endpoint}?limit=50`);
  const seen = new Set();
  const recent = [];
  for (const item of items) {
    const media = type === 'series' ? item.show : item.movie;
    if (!media?.ids) continue;
    if (seen.has(media.ids.trakt)) continue;
    seen.add(media.ids.trakt);
    recent.push({ title: media.title, year: media.year });
    if (recent.length >= 15) break;
  }
  return recent;
}

// ---- Exclusion: full watched state (canonical IDs + titles) ----
// A show with ANY watched history is excluded, even if only partially watched.
async function getWatchedSets(profile, type) {
  const endpoint = type === 'series' ? 'shows' : 'movies';
  const items = await authedGet(profile, `/sync/watched/${endpoint}`);
  const imdbIds = new Set();
  const tmdbIds = new Set();
  const titles = [];
  for (const item of items) {
    const media = type === 'series' ? item.show : item.movie;
    if (!media?.ids) continue;
    if (media.ids.imdb) imdbIds.add(media.ids.imdb);
    if (media.ids.tmdb) tmdbIds.add(media.ids.tmdb);
    titles.push(media.title);
  }
  return { imdbIds, tmdbIds, titles };
}

module.exports = {
  startDeviceFlow,
  pollDeviceToken,
  refreshToken,
  getRecentHistory,
  getWatchedSets,
  baseHeaders,
  USER_AGENT,
};
