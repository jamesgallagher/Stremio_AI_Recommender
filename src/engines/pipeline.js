// Shared candidate pipeline (SC-01) — everything the recommendation build did
// AFTER candidate generation, made per-type and ENGINE-AGNOSTIC:
//
//   engine.generate() → NormalizedCandidate[]           (0–40%)
//     → normalize contract fields (rankScore→affinity, reason→because_title, …)
//     → subtract watched + dont_recommend                 (I5)
//     → resolve tt-id + poster + genres + Anime tag        (40–85%, unless preResolved)
//     → IMDb-rating enrich via MDBList                      (85–95%)
//     → upsert into the pool                               (I4, 95–100%)
//     → purge below the vote-count floor                   (I3)
//
// The AGE GATE (I1) and the whole-pool IMDb-rating heal run ONCE over the whole
// pool after BOTH types are built, so they live in recommendationStore, NOT here.
//
// Boundaries: this module reuses recommendationStore's low-level pool helpers
// (upsertCandidates / purgeBelowVoteFloor / dontRecommendKeys) via a LAZY require
// so recommendationStore can require this module eagerly for its build wrapper
// without a load-order cycle. recommendationStore keeps those helpers exported.
const tmdb = require('../services/tmdb');
const animeMap = require('../services/animeMap');
const watchedStore = require('../watchedStore');

const key = (type, tmdbId) => `${type}:${tmdbId}`;

// Map a NormalizedCandidate's CONTRACT fields onto the pool-row keys
// upsertCandidates expects, accepting either the contract names
// (rankScore/reason/recCount — what a conformant engine emits) or the internal
// names (affinity/because_title/rec_count — what Genesis already carries). This
// keeps the pool schema the single output contract (I4/I6) and lets
// upsertCandidates stay dumb. Mutates + returns the candidate.
function normalize(c) {
  c.affinity = c.rankScore ?? c.affinity ?? 0;
  c.because_title = c.reason ?? c.because_title ?? null;
  c.rec_count = c.recCount ?? c.rec_count ?? null;
  return c;
}

// Build one type's pool slice from one engine's output. Returns
// { seeds, raw, strong, kept, stored, purged } — seeds/raw/strong/kept are the
// engine's own stats (via ctx.stats), stored/purged are the pipeline's.
async function runEngineBuild(profile, type, engine, ctx, onProgress = () => {}) {
  const store = require('../recommendationStore'); // lazy — see Boundaries
  const { tmdbKey, filters = {}, log = console } = ctx;

  // Shared exclusion sets (I5), resolved once per build and shared with the
  // engine via ctx so a pre-filtering engine (Genesis) and this invariant agree
  // on the same data. Profile-wide, so both type-builds reuse them.
  ctx.watchedIds = ctx.watchedIds || watchedStore.watchedIdSets(profile.id);
  ctx.dont = ctx.dont || store.dontRecommendKeys(profile.id);
  ctx.stats = {};

  // 1. Candidates from the engine (0–40%).
  const cands = (await engine.generate(profile, type, ctx, (p, l) => onProgress(p * 0.40, l))) || [];

  // 2. Normalize + subtract watched + dont_recommend + porn for THIS type. The
  //    shared invariant (I5): Genesis already pre-excluded, so this is a no-op
  //    for it, but it GUARANTEES the gate for every engine. Porn is dropped here
  //    too (I7 blacklist proper lives in the age gate).
  const filtered = cands
    .map(normalize)
    .filter((c) => c.type === type)
    .filter((c) => !ctx.watchedIds.tmdb.has(c.tmdb_id))
    .filter((c) => !ctx.dont.has(key(c.type, c.tmdb_id)))
    .filter((c) => !c.adult);

  // 3. Resolve tt-id + poster + genre names + Anime tag — unless the engine
  //    pre-resolved. No tt id → not servable → dropped (I4). This is the one
  //    heavy step (a light TMDB call per candidate); background build only.
  let servable = [];
  if (engine.capabilities?.preResolved) {
    servable = filtered.filter((c) => c.imdb_id); // trust the engine's fields; drop tt-less
    onProgress(85, `Resolved ${servable.length} ${type} recommendation(s) (pre-resolved)`);
  } else {
    // Resolve the FULL genre list (serve-time exclusion needs every genre, not
    // just the primary). genreMap is fetched once and cached in tmdb.
    const genreMap = await tmdb.getGenreMap(tmdbKey);
    for (const c of filtered) {
      const names = (c.genre_ids || []).map((g) => genreMap[g]).filter(Boolean);
      c.primary_genre = names[0] || null;
      c.genres = names.join(',');
    }
    await animeMap.ensureLoaded(log);
    let resolvedDone = 0;
    onProgress(40, `Resolving ${filtered.length} ${type} recommendation(s)…`);
    for (let i = 0; i < filtered.length; i += 8) {
      const chunk = filtered.slice(i, i + 8);
      await Promise.all(chunk.map(async (c) => {
        const imdb = await tmdb.imdbFor(tmdbKey, c.type, c.tmdb_id);
        if (imdb) {
          c.imdb_id = imdb;
          c.poster = tmdb.posterUrl(c.poster); // bare path → full URL
          if (animeMap.isAnime(imdb, c.tmdb_id) && !c.genres.split(',').includes('Anime')) {
            c.genres = c.genres ? `Anime,${c.genres}` : 'Anime';
          }
          servable.push(c);
        }
        resolvedDone++;
      }));
      onProgress(40 + (resolvedDone / (filtered.length || 1)) * 45, `Resolved ${resolvedDone}/${filtered.length} ${type} recommendation(s)`);
    }
  }

  // 4. Enrich with the IMDb rating (the poster-badge number, via MDBList) so the
  //    serve-time rating floor judges the SAME rating the user sees. Absent key
  //    or an unrated title leaves imdb_rating null; the floor falls back to
  //    TMDB's vote_average at serve.
  const { mdblistKey } = ctx;
  if (mdblistKey && servable.length) {
    const mdblist = require('../services/mdblist');
    const ids = servable.map((c) => c.imdb_id);
    try {
      const ratings = await mdblist.imdbRatings(mdblistKey, type, ids, log);
      let rated = 0;
      for (const c of servable) { const v = ratings.get(c.imdb_id); if (v != null) { c.imdb_rating = v; rated++; } }
      log.log(`[rec] ${profile.name}: IMDb ratings resolved for ${rated}/${servable.length} ${type} recommendation(s)`);
    } catch (err) { log.warn(`[rec] IMDb-rating enrichment (${type}) failed: ${err.message}`); }
  }
  onProgress(95, `Storing ${servable.length} ${type} recommendation(s)…`);

  // 5. Upsert (I4). Stamp imdb_rating_at only when a key was present, so the heal
  //    pass re-checks these rows later once a key is configured.
  store.upsertCandidates(profile.id, servable, { ratingCheckedAt: mdblistKey ? Date.now() : null });
  // 6. Purge any already-stored row now under the vote-count floor (I3) — old
  //    fixed gate, or a raised floor. New sub-floor titles were gated at build.
  const purged = store.purgeBelowVoteFloor(profile.id, filters);
  onProgress(100, `Stored ${servable.length} ${type} recommendation(s)`);

  const st = ctx.stats || {};
  return {
    seeds: st.seeds ?? 0,
    raw: st.raw ?? 0,
    strong: st.strong ?? 0,
    kept: st.kept ?? 0,
    stored: servable.length,
    purged,
  };
}

module.exports = { runEngineBuild, normalize };
