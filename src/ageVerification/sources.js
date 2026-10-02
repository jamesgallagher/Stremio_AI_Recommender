// AGE-1: the TV-14 source adapters — bridge the real services to the chain's
// injected seams. Each seam returns the shape the chain expects; a failing
// source gives no answer (the chain's `safe` handles that — the chain
// continues). `buildSources(profile, log)` returns the full source set the
// chain's `decide` takes.
const settings = require('../settings');
const mdblist = require('../services/mdblist');
const tvdb = require('../services/tvdb');
const groq = require('../services/groq');
const governor = require('../services/governor');
const store = require('../store');

const TMDB_API = 'https://api.themoviedb.org/3';
const COUNTRIES = ['AU', 'US', 'GB', 'IE', 'NZ', 'CA'];

// The TMDB fetch seam. Defaults to the global fetch; a test can replace it via
// `setTmdbFetch` so a fetch-level test (T1) is isolated from the other AGE-1
// async tests (which run in parallel and stub the global fetch for TVDB).
let tmdbFetch = global.fetch;
function setTmdbFetch(fn) { tmdbFetch = fn; }

// Per-country TMDB ratings (AU/US/GB/IE/NZ/CA) for a batch of titles. `titles`
// are the chain's shape ({ key: `${type}:${tmdbId}`, ... }); the tmdb id is read
// off the key. A per-title failure yields an empty object (no answer from this
// step — the chain continues), never a throw.
//
// The key is read via keyFor(profile, 'tmdb_api_key') (Server Config first, the
// per-profile value as a legacy fallback) — the same resolution the rest of the
// app uses, so a per-profile key still works on older profiles.
async function tmdbRatings(profile, type, titles, log = console) {
  const out = new Map();
  const apiKey = (settings.keyFor(profile, 'tmdb_api_key') || '').trim();
  if (!apiKey) return out; // no key → no answer from this step
  const headers = apiKey.length > 50 ? { Authorization: `Bearer ${apiKey}` } : {};
  const authParams = apiKey.length > 50 ? {} : { api_key: apiKey };
  // `get` takes a params argument so the append_to_response query survives (F1:
  // the old one-arg get silently dropped {append_to_response:…}, so TMDB never
  // returned per-country ratings and the hard floor never fired).
  const get = async (endpoint, params = {}) => {
    const url = new URL(`${TMDB_API}/${endpoint}`);
    for (const [k, v] of Object.entries({ ...authParams, ...params })) url.searchParams.set(k, v);
    const res = await governor.schedule('tmdb', () => tmdbFetch(url, { headers }));
    if (!res.ok) throw new Error(`TMDB ${endpoint} failed (${res.status})`);
    return res.json();
  };
  for (const t of titles) {
    const tmdbId = t.key.split(':')[1];
    try {
      const data = type === 'movie'
        ? await get(`movie/${tmdbId}`, { append_to_response: 'release_dates' })
        : await get(`tv/${tmdbId}`, { append_to_response: 'content_ratings' });
      const cert = {};
      if (type === 'movie') {
        const results = data.release_dates?.results || [];
        for (const cc of COUNTRIES) {
          const entry = results.find((r) => r.iso_3166_1 === cc);
          const c = (entry?.release_dates || []).map((d) => d.certification).find((x) => x);
          if (c) cert[cc] = c;
        }
      } else {
        const results = data.content_ratings?.results || [];
        for (const cc of COUNTRIES) {
          const entry = results.find((r) => r.iso_3166_1 === cc);
          if (entry?.rating) cert[cc] = entry.rating;
        }
      }
      out.set(t.key, cert);
    } catch (err) {
      log.warn?.(`[age-verify] tmdbRatings ${tmdbId} failed: ${err.message}`);
      out.set(t.key, {});
    }
  }
  return out;
}

// Simkl certification (step 4a). Simkl is a watch tracker keyed by its own ids,
// not by IMDb — a batch certification lookup by IMDb id is out of scope for
// AGE-1. Return no answer so the chain continues to the next step (MDBList).
function simklCerts() {
  return Promise.resolve(new Map());
}

// The LLM gate (step 5). The chain's seam expects Map<key, true|false> where
// true = suitable (allow), false = vetoed (block), absent = the LLM omitted the
// title (unknown — kept). The real gate returns a veto Set and caches its
// verdicts under the tier's cache key; read the cache back into the chain's
// shape so an omitted title stays absent (unknown).
async function llmGate(type, tier, titles, log = console) {
  await groq.ageGate(type, tier.llm.age,
    titles.map((t) => ({
      id: t.key.split(':')[1],
      title: t.title, year: t.year,
      genres: t.genres || [], certification: t.certification || null,
      cacheId: t.key.split(':')[1],
    })), log, { tier });
  const cache = store.loadAgeVerdicts();
  const out = new Map();
  for (const t of titles) {
    const v = cache[`${type}:${tier.llm.cacheKey}:${t.key.split(':')[1]}`];
    if (v === true) out.set(t.key, true);
    else if (v === false) out.set(t.key, false);
    // else: omitted (unknown) — leave absent
  }
  return out;
}

// Build the full source set for a profile. `profile` carries the Simkl
// connection (for simklCerts, when a real source lands). The chain's `decide`
// takes this object as its `sources` argument.
function buildSources(profile, log = console) {
  const mdbKey = () => (settings.getSettings()?.keys?.mdblist_api_key || '').trim();
  return {
    tmdbRatings: (type, titles) => tmdbRatings(profile, type, titles, log),
    csmAges: (type, imdbIds) => {
      const key = mdbKey();
      return key ? mdblist.commonSenseAges(key, type, imdbIds, log) : Promise.resolve(new Map());
    },
    tvdbRatings: (type, imdbIds) => tvdb.mediaCerts(imdbIds, type, log),
    simklCerts: (type, imdbIds) => simklCerts(),
    mdblistCerts: (type, imdbIds) => {
      const key = mdbKey();
      return key ? mdblist.mediaCerts(key, type, imdbIds, log) : Promise.resolve(new Map());
    },
    llmGate: (type, tier, titles) => llmGate(type, tier, titles, log),
  };
}

module.exports = { buildSources, tmdbRatings, llmGate, setTmdbFetch };
