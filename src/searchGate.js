// Age-appropriate filtering for live TMDB SEARCH results — ONE implementation shared by
// the Stremio addon search catalog and the Mobile Companion search, so neither surface
// can be the weaker one.
//
//   • Everyone: the permanent NSFW blacklist + (age-limited only) the anime age band —
//     local lookups, no LLM.
//   • Age-limited profiles only: the multi-source age-verification chain (its LLM step
//     last; an unjudged title is dropped). An unrestricted (adult) profile NEVER reaches
//     the chain or the LLM from here.
//
// FAIL-CLOSED: for an age-limited profile any gate failure throws; callers must answer
// with no results rather than unfiltered ones.
const rebuild = require('./rebuild');

async function gateSearchResults(profile, type, metas, log = console) {
  let out = await rebuild.applyAnimeGate(metas, profile, log);
  const limit = profile.filters?.age_limit || 0;
  if (limit > 0 && out.length) {
    const ageVerify = require('./ageVerification');
    const tier = ageVerify.tierFor({ age_limit: limit });
    const sources = require('./ageVerification/sources').buildSources(profile, log);
    // TMDB search results are movies or TV shows; an 'anime' lane search is a TV search.
    const lookupType = type === 'anime' ? 'series' : type;
    const titles = out.map((m) => ({
      key: `${lookupType}:${m._tmdb_id}`,
      imdb_id: m.id,
      adult: m._adult || false,
      title: m.name,
      year: m.releaseInfo,
      genres: m._genre_names || [],
      certification: m._certification || null,
    }));
    const result = await ageVerify.verify(titles, lookupType, tier, sources, log);
    const blocked = new Set();
    for (const [k, v] of result) if (v.verdict === 'block') blocked.add(k.split(':')[1]);
    out = out.filter((m) => !blocked.has(String(m._tmdb_id)));
  }
  return out;
}

module.exports = { gateSearchResults };
