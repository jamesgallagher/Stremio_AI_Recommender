// FG-1: the fact ladder.
//
// resolveFacts(profile, type, candidates, needs, deps) returns Map<key, facts>.
// A candidate is { key, tmdb_id, imdb_id, title, year, imdbRating? }.
// It only fetches what `needs` asks for, in batches, and stops asking about
// a fact once it has it.
//
// The ladder, per title, per missing fact:
// 1. Cached TMDB deep-meta (metaStore.get / getMany)
// 2. Fetch it (metaStore.enrich) — at most 5 at a time
// 3. IMDb rating (mdblist.cachedImdbRatings) + mediaInfoBatch for other fields
// 4. The LLM (groq.titleFacts) — one batched call, max 40 titles
// 5. Still missing => no_data
//
// It never throws. Every network/LLM failure is caught per title/batch.
const metaStoreDefault = require('../engines/shared/metaStore');
const tmdbDefault = require('../services/tmdb');
const mdblistDefault = require('../services/mdblist');
const groqDefault = require('../services/groq');
const animeMapDefault = require('../services/animeMap');

// The anime detector (AN-1a): adds 'Anime' to a title's genres when flagged.
function animeFlag(candidate, deps) {
  const am = deps.animeMap;
  if (!am) return false;
  // isAnimeShow expects { imdb_id, tmdb_id, genres, origin_country, original_language }
  return am.isAnime(candidate.imdb_id, candidate.tmdb_id);
}

async function resolveFacts(profile, type, candidates, needs, deps) {
  const metaStore = deps.metaStore || metaStoreDefault;
  const tmdb = deps.tmdb || tmdbDefault;
  const mdblist = deps.mdblist || mdblistDefault;
  const groq = deps.groq || groqDefault;
  const animeMap = deps.animeMap || animeMapDefault;
  const log = deps.log || console;
  const now = deps.now || Date.now;

  // The TMDB key for enrichment (injectable for tests).
  const tmdbKey = deps.tmdbKey || require('../settings').keyFor(profile, 'tmdb');
  const mdblistKey = deps.mdblistKey || require('../settings').resolveMdblistKey(profile).key;

  const out = new Map();

  // Initialize facts from the candidate's own data (year, imdbRating).
  for (const c of candidates) {
    const facts = { rating: null, year: null, votes: null, genres: null };
    // The candidate's own year (from the list page).
    if (needs.has('year') && c.year) facts.year = parseInt(c.year, 10) || null;
    // The candidate's own imdbRating (from the list page).
    if (needs.has('rating') && c.imdbRating != null) {
      const r = parseFloat(c.imdbRating);
      if (Number.isFinite(r) && r > 0) facts.rating = r;
    }
    out.set(c.key, { facts, candidate: c, source: 'rules' });
  }

  // Step 1: cached TMDB deep-meta.
  const tmdbIds = [];
  for (const [key, entry] of out) {
    const c = entry.candidate;
    if (c.tmdb_id) tmdbIds.push(String(c.tmdb_id));
  }
  if (tmdbIds.length) {
    let cached;
    try {
      cached = metaStore.getMany(type, tmdbIds);
    } catch (err) {
      cached = new Map();
    }
    for (const [key, entry] of out) {
      const c = entry.candidate;
      if (!c.tmdb_id) continue;
      const meta = cached.get(String(c.tmdb_id));
      if (!meta) continue;
      if (needs.has('genres') && entry.facts.genres === null) {
        entry.facts.genres = meta.genres || [];
      }
      if (needs.has('year') && entry.facts.year === null) {
        entry.facts.year = meta.year || null;
      }
      if (needs.has('votes') && entry.facts.votes === null) {
        entry.facts.votes = meta.vote_count || null;
      }
      if (needs.has('rating') && entry.facts.rating === null) {
        entry.facts.rating = meta.vote_average || null;
      }
    }
  }

  // Step 2: enrich the misses (at most 5 at a time).
  if (tmdbKey) {
    const toEnrich = [];
    for (const [key, entry] of out) {
      const c = entry.candidate;
      if (!c.tmdb_id) continue;
      // Check if any needed fact is still missing.
      const missing = [...needs].some((n) => entry.facts[n] === null || (n === 'genres' && entry.facts[n] === null));
      if (missing) toEnrich.push(entry);
    }
    for (let i = 0; i < toEnrich.length; i += 5) {
      const batch = toEnrich.slice(i, i + 5);
      await Promise.all(batch.map(async (entry) => {
        try {
          const meta = await metaStore.enrich(tmdbKey, type, entry.candidate.tmdb_id, log);
          if (!meta) return;
          if (needs.has('genres') && entry.facts.genres === null) {
            entry.facts.genres = meta.genres || [];
          }
          if (needs.has('year') && entry.facts.year === null) {
            entry.facts.year = meta.year || null;
          }
          if (needs.has('votes') && entry.facts.votes === null) {
            entry.facts.votes = meta.vote_count || null;
          }
          if (needs.has('rating') && entry.facts.rating === null) {
            entry.facts.rating = meta.vote_average || null;
          }
        } catch (err) {
          // Per-title failure: facts stay missing.
        }
      }));
    }
  }

  // For titles with no tmdb_id, try tmdb.findByImdbId.
  if (tmdbKey) {
    for (const [key, entry] of out) {
      const c = entry.candidate;
      if (c.tmdb_id) continue;
      if (!c.imdb_id) continue;
      const missing = [...needs].some((n) => entry.facts[n] === null || (n === 'genres' && entry.facts[n] === null));
      if (!missing) continue;
      try {
        const foundId = await tmdb.findByImdbId(tmdbKey, type, c.imdb_id);
        if (foundId) {
          const meta = await metaStore.enrich(tmdbKey, type, foundId, log);
          if (meta) {
            if (needs.has('genres') && entry.facts.genres === null) entry.facts.genres = meta.genres || [];
            if (needs.has('year') && entry.facts.year === null) entry.facts.year = meta.year || null;
            if (needs.has('votes') && entry.facts.votes === null) entry.facts.votes = meta.vote_count || null;
            if (needs.has('rating') && entry.facts.rating === null) entry.facts.rating = meta.vote_average || null;
          }
        }
      } catch (err) {
        // Per-title failure: facts stay missing.
      }
    }
  }

  // Step 3: IMDb rating via mdblist.cachedImdbRatings (wins over TMDB vote_average).
  if (mdblistKey && needs.has('rating')) {
    const imdbIds = [];
    for (const [key, entry] of out) {
      const c = entry.candidate;
      if (c.imdb_id && entry.facts.rating === null) imdbIds.push(c.imdb_id);
    }
    if (imdbIds.length) {
      try {
        const ratings = await mdblist.cachedImdbRatings(mdblistKey, type, imdbIds, log);
        for (const [key, entry] of out) {
          const c = entry.candidate;
          if (!c.imdb_id) continue;
          if (entry.facts.rating !== null) continue;
          const r = ratings.get(c.imdb_id);
          if (r != null) entry.facts.rating = r;
        }
      } catch (err) {
        // Batch failure: ratings stay missing.
      }
    }

    // For genres/year/votes still missing, read mediaInfoBatch.
    const stillMissing = [];
    for (const [key, entry] of out) {
      const c = entry.candidate;
      if (!c.imdb_id) continue;
      const missingFields = [];
      if (needs.has('genres') && entry.facts.genres === null) missingFields.push('genres');
      if (needs.has('year') && entry.facts.year === null) missingFields.push('year');
      if (needs.has('votes') && entry.facts.votes === null) missingFields.push('votes');
      if (missingFields.length) stillMissing.push({ entry, c, missingFields });
    }
    if (stillMissing.length) {
      const ids = stillMissing.map((x) => x.c.imdb_id);
      try {
        const infoMap = await mdblist.mediaInfoBatch(mdblistKey, type, ids);
        for (const { entry, c, missingFields } of stillMissing) {
          const info = infoMap.get(c.imdb_id);
          if (!info) continue;
          // Use the fields the MDBList media-info actually has.
          if (missingFields.includes('year') && entry.facts.year === null) {
            // MDBList media-info has release_year or year.
            const y = info.release_year || info.year;
            if (y) entry.facts.year = parseInt(y, 10) || null;
          }
          if (missingFields.includes('genres') && entry.facts.genres === null) {
            // MDBList media-info may have genres as an array of names or ids.
            if (Array.isArray(info.genres)) {
              // If they're names, use them; if ids, we can't map without a genre map.
              if (info.genres.every((g) => typeof g === 'string')) {
                entry.facts.genres = info.genres;
              }
            }
          }
          // votes: MDBList media-info does not typically carry vote_count.
        }
      } catch (err) {
        // Batch failure: facts stay missing.
      }
    }
  }

  // Anime detection: add 'Anime' to genres when the detector flags it.
  if (needs.has('genres') && animeMap) {
    for (const [key, entry] of out) {
      const c = entry.candidate;
      if (animeMap.isAnime(c.imdb_id, c.tmdb_id)) {
        const genres = entry.facts.genres || [];
        if (!genres.includes('Anime')) {
          entry.facts.genres = [...genres, 'Anime'];
        }
      }
    }
  }

  // Step 4: the LLM for titles still missing a needed fact.
  const llmMissing = [];
  for (const [key, entry] of out) {
    const missingNeeds = [...needs].filter((n) => entry.facts[n] === null || (n === 'genres' && entry.facts[n] === null));
    if (missingNeeds.length) {
      llmMissing.push({ key, entry, missingNeeds });
    }
  }

  const hasLlm = deps.hasLlm ? deps.hasLlm() : require('../settings').hasLlm();
  if (hasLlm && llmMissing.length) {
    // Batch in groups of 40.
    for (let i = 0; i < llmMissing.length; i += 40) {
      const batch = llmMissing.slice(i, i + 40);
      const titles = batch.map((x) => ({
        title: x.entry.candidate.title,
        type,
        needs: x.missingNeeds,
      }));
      try {
        const results = await groq.titleFacts(type, titles, batch.map((x) => x.missingNeeds[0]), log);
        for (let j = 0; j < batch.length; j++) {
          const { entry, missingNeeds } = batch[j];
          const res = results?.[j];
          if (!res) continue; // LLM omitted this title.
          for (const n of missingNeeds) {
            if (entry.facts[n] === null) {
              if (n === 'genres' && Array.isArray(res.genres)) {
                entry.facts.genres = res.genres;
              } else if (n === 'year' && res.year != null) {
                entry.facts.year = res.year;
              } else if (n === 'rating' && res.rating != null) {
                entry.facts.rating = res.rating;
              }
              entry.source = 'llm';
            }
          }
        }
      } catch (err) {
        // LLM batch failure: facts stay missing.
        log.warn(`[filterGate] LLM titleFacts batch failed (${err.message})`);
      }
    }
  }

  // Build the final Map<key, facts>.
  const final = new Map();
  for (const [key, entry] of out) {
    final.set(key, {
      rating: entry.facts.rating,
      year: entry.facts.year,
      votes: entry.facts.votes,
      genres: entry.facts.genres,
      source: entry.source,
    });
  }
  return final;
}

module.exports = { resolveFacts };
