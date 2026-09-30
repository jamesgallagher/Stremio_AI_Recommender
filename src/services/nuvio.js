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
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';

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

// ---- watch progress (Marquee engagement signal) ----
// Nuvio's "continue watching" state: how far into each title a profile got.
// RPC name, params and row shape are taken from Nuvio's own open-source client
// (NuvioMedia/NuvioTVSmart js/core/profile/watchProgressSyncService.js,
// PULL_RPC = "sync_pull_watch_progress", params { p_profile_id }). Read-only.

// Nuvio's unit rules (same constants as its client): legacy rows store
// position/duration WITHOUT a unit — a duration above 8 h in "seconds" can only
// be milliseconds; a *_ms pair larger than 24 h but ≤ 24 h once divided by 1000
// was double-scaled and is corrected.
const MAX_AMBIGUOUS_SECONDS = 8 * 60 * 60;
const MAX_REASONABLE_DURATION_MS = 24 * 60 * 60 * 1000;

// PURE: one sync_pull_watch_progress row → { type, imdbId, season, episode,
// positionMs, durationMs, percent (0–100|null), updatedAtMs, source } or null.
// A port of Nuvio's mapProgressRow; `percent` prefers the row's own
// progress_percent, else position/duration.
function normalizeProgressRow(row) {
  if (!row || typeof row !== 'object') return null;
  const imdbId = String(row.content_id || row.contentId || '');
  if (!imdbId.startsWith('tt')) return null;
  const hasMs = row.position_ms != null || row.positionMs != null || row.duration_ms != null || row.durationMs != null;
  const rawPos = Number(row.position_ms ?? row.positionMs ?? row.position ?? 0) || 0;
  const rawDur = Number(row.duration_ms ?? row.durationMs ?? row.duration ?? 0) || 0;
  let positionMs; let durationMs;
  if (hasMs) {
    positionMs = Math.max(0, Math.trunc(rawPos));
    durationMs = Math.max(0, Math.trunc(rawDur));
  } else {
    const legacyMs = rawDur > MAX_AMBIGUOUS_SECONDS;
    const conv = (n) => (n > 0 ? Math.trunc(legacyMs || n > MAX_AMBIGUOUS_SECONDS ? n : n * 1000) : 0);
    positionMs = conv(rawPos);
    durationMs = conv(rawDur);
  }
  if (durationMs > MAX_REASONABLE_DURATION_MS && durationMs / 1000 <= MAX_REASONABLE_DURATION_MS) {
    positionMs = Math.trunc(positionMs / 1000);
    durationMs = Math.trunc(durationMs / 1000);
  }
  const pctRaw = Number(row.progress_percent ?? row.progressPercent);
  let percent = Number.isFinite(pctRaw) && (row.progress_percent != null || row.progressPercent != null)
    ? Math.max(0, Math.min(100, pctRaw))
    : (durationMs > 0 ? Math.max(0, Math.min(100, (positionMs / durationMs) * 100)) : null);
  const source = String(row.source || '').trim() || 'local';
  if (source === 'trakt_history' && percent != null) percent = 100; // Nuvio treats imported history as complete
  const upd = row.updated_at ?? row.last_watched ?? row.lastWatched ?? null;
  let updatedAtMs = null;
  if (upd != null) {
    const n = Number(upd);
    updatedAtMs = Number.isFinite(n) ? (n > 1e12 ? n : Math.trunc(n * 1000)) : (Date.parse(upd) || null);
  }
  const season = row.season ?? row.season_number ?? null;
  const episode = row.episode ?? row.episode_number ?? null;
  const type = String(row.content_type || row.contentType || 'movie') === 'movie' && season == null && episode == null ? 'movie' : 'series';
  return { type, imdbId, season, episode, positionMs, durationMs, percent, updatedAtMs, source };
}

// Normalized progress rows for one Nuvio profile (movies AND series; callers
// filter). One login + one RPC call.
async function pullWatchProgress({ email, password, profileIndex }) {
  if (profileIndex === null || profileIndex === undefined) throw new Error('No Nuvio profile selected');
  const token = await login(email, password);
  const rows = await rpc(token, 'sync_pull_watch_progress', { p_profile_id: profileIndex });
  if (!Array.isArray(rows)) throw new Error('Nuvio watch progress returned an invalid snapshot');
  return rows
    .filter((r) => r?.profile_id == null || String(r.profile_id) === String(profileIndex))
    .map(normalizeProgressRow)
    .filter(Boolean);
}

module.exports = { login, listProfiles, pullWatched, pullWatchProgress, normalizeProgressRow };
