// TVDB v4 (AGE-1): country-specific certifications for the TV-14 decision chain.
//
// TMDB's per-country ratings (AU/US/GB/IE/NZ/CA) are the primary source in the
// chain; TVDB is the fallback for whatever TMDB didn't answer. This client
// resolves a batch of IMDb ids to their TVDB country certifications.
//
// The API key is read ONLY here (A6): Server Config (settings.keys.tvdb_api_key)
// first, then process.env.TVDB_API_KEY. No real key is ever in code, tests,
// fixtures, docs or .env.example (the repo is public).
const governor = require('./governor');
const settings = require('../settings');
const API = 'https://api.thetvdb.com/b4';

// The effective TVDB key: Server Config first, then the process env (A6: the
// env fallback is read ONLY in this module).
function tvdbKey() {
  const s = settings.getSettings();
  return (s?.keys?.tvdb_api_key || process.env.TVDB_API_KEY || '').trim();
}

// One governed GET. `key` is the bearer token; `endpoint` is relative to /b4.
async function get(key, endpoint, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await governor.schedule('tvdb', () => fetch(url, { headers: { Authorization: `Bearer ${key}` } }));
  if (!res.ok) throw new Error(`TVDB ${endpoint} failed (${res.status})`);
  return res.json();
}

// TVDB reports country codes as ISO 3166-1 two letters (US/AU/GB/IE/NZ/CA);
// the decision chain reads three-letter codes (usa/aus/gbr/irl/nzl/can). Map
// the six countries the chain reads; anything else is dropped.
const TVDB_COUNTRY = { au: 'aus', us: 'usa', gb: 'gbr', ie: 'irl', nz: 'nzl', ca: 'can' };

// Resolve a batch of IMDb ids to their TVDB country certifications. Returns
// Map<imdb, { aus, usa, gbr, irl, nzl, can }> (lowercase three-letter chain
// codes). A title with no TVDB match or no ratings gets an empty object.
// `type` ('movie' | 'series') is accepted for seam consistency; the match's own
// type selects the entity endpoint. A per-title failure yields an empty object
// (no answer from this step — the chain continues), never a throw.
async function mediaCerts(imdbIds, type, log = console) {
  const key = tvdbKey();
  if (!key) { log?.warn?.('[tvdb] no TVDB API key — no ratings'); return new Map(); }
  const out = new Map();
  for (const imdb of imdbIds) {
    try {
      // Search by external (IMDb) id; the match carries the TVDB id + type.
      const search = await get(key, 'search', { externalId: imdb });
      const match = (search.data || [])[0];
      if (!match) { out.set(imdb, {}); continue; }
      const entity = await get(key, match.type === 2 ? `movies/${match.id}` : `series/${match.id}`);
      const ratings = entity.data?.ratings || [];
      const cert = {};
      for (const r of ratings) {
        const cc = r.country?.iso_3166_1;
        const code = TVDB_COUNTRY[String(cc).toLowerCase()];
        if (code) cert[code] = r.rating;
      }
      out.set(imdb, cert);
    } catch (err) {
      log?.warn?.(`[tvdb] ${imdb} failed: ${err.message}`);
      out.set(imdb, {});
    }
  }
  return out;
}

module.exports = { mediaCerts, tvdbKey, get };
