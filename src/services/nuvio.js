// Nuvio watched-history provider for auto-scrobble.
//
// Nuvio is a Netflix-style client: one account (email/password → Supabase
// GoTrue) holds several PROFILES (Daddo, kids, …), each an integer
// `profile_index`. Watched state lives in the sync_pull_watched_items RPC keyed
// by that index. This reads it read-only so the addon can mirror it to Trakt.
//
// Rides Nuvio's private backend (undocumented). Endpoint + anon key are
// overridable via env in case Nuvio rotates them; callers treat every failure
// as "leave Trakt untouched" (fail-closed) rather than guessing.
const { USER_AGENT } = require('./trakt');

// Public anon key (shipped in Nuvio's web bundle; RLS + login is the real
// guard). Overridable if it ever rotates — no image rebuild needed.
const DEFAULT_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';
const BASE = (process.env.NUVIO_API_URL || 'https://api.nuvio.tv').replace(/\/+$/, '');
const ANON_KEY = process.env.NUVIO_ANON_KEY || DEFAULT_ANON;
const PAGE_SIZE = 500;
const MAX_PAGES = 100;

async function login(email, password) {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 400) throw new Error('Nuvio login rejected — check the email and password');
    throw new Error(`Nuvio login failed (${res.status})${body ? `: ${body}` : ''}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Nuvio login returned no access token');
  return data.access_token;
}

async function rpc(token, fn, params) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(params || {}),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Nuvio ${fn} failed (${res.status})${body ? `: ${body}` : ''}`);
  }
  return res.json();
}

// [{ index, name }] — the profiles selectable at setup.
async function listProfiles(email, password) {
  const token = await login(email, password);
  const rows = await rpc(token, 'sync_pull_profiles', {});
  return (Array.isArray(rows) ? rows : [])
    .map((p) => ({ index: p.profile_index, name: p.name || `Profile ${p.profile_index}` }))
    .sort((a, b) => a.index - b.index);
}

// Normalized watched items for one profile:
//   { type: 'movie'|'series', imdbId, season?, episode?, watchedAtMs }
// Only IMDb-keyed rows survive (Trakt needs tt IDs).
async function pullWatched({ email, password, profileIndex }) {
  if (profileIndex === null || profileIndex === undefined) {
    throw new Error('No Nuvio profile selected');
  }
  const token = await login(email, password);
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await rpc(token, 'sync_pull_watched_items', {
      p_profile_id: profileIndex, p_page: page, p_page_size: PAGE_SIZE,
    });
    const arr = Array.isArray(chunk) ? chunk : [];
    rows.push(...arr);
    if (arr.length < PAGE_SIZE) break;
  }
  const out = [];
  for (const r of rows) {
    const imdbId = r.content_id;
    if (!imdbId || !String(imdbId).startsWith('tt')) continue;
    const isEpisode = r.season != null && r.episode != null;
    out.push({
      type: isEpisode ? 'series' : 'movie',
      imdbId,
      season: isEpisode ? r.season : undefined,
      episode: isEpisode ? r.episode : undefined,
      watchedAtMs: Number(r.watched_at) || 0,
    });
  }
  return out;
}

module.exports = { login, listProfiles, pullWatched };
