// Stale-while-revalidate rebuild pipeline.
//
// - Staleness-gated: rebuild only when generated_at is past STALE_MS (24h).
// - Per-profile in-memory lock: overlapping catalog opens serve stale, never
//   trigger a second concurrent job.
// - Backoff: failed attempts set last_attempt_at; no retry within BACKOFF_MS.
// - Failure never purges cache: each catalog type is atomically swapped only on
//   success with >= MIN_METAS usable titles.
// - v4 engine: TRAKT RECOMMENDS, CODE FILTERS, LLM GUARDS. The list comes
//   from Trakt's personalized /recommendations (collaborative filtering over
//   the user's full history, watched excluded at source); every profile
//   filter (rating floor, statuses, genres/Anime, recency, vote floor) is
//   applied locally and deterministically; the LLM's only job is a
//   remove-only age goalkeeper for kids profiles. Top list_size displayed +
//   equal bench, in Trakt's confidence order.
// - Bench backfills the displayed list when items are watched (free, no LLM).
// - Watched exclusion is cross-type on IMDb IDs: a title watched as a movie
//   on Trakt can never appear in the series catalog (or vice versa), covering
//   docs/miniseries that TMDB and Trakt classify differently.
// - Age limit (kids mode): when filters.age_limit > 0, EVERY candidate is
//   verified against Common Sense Media (via MDBList). No CSM rating => not
//   listed. CSM only — no fallback to other rating systems. A broken MDBList
//   lookup fails the rebuild (old list stays) rather than serving unverified.
// - Extra catalogs (curated MDBList lists, per-profile toggles): built and
//   swapped with the same discipline, but no watched exclusion and no taste
//   input. Popular charts unfiltered; the rest gated on IMDb rating >= 6.
//   The kids-mode CSM gate applies to extras too.
const store = require('./store');
const config = require('./config');
const catalogs = require('./catalogs');
const trakt = require('./services/trakt');
const llm = require('./services/groq');
const tmdb = require('./services/tmdb');
const mdblist = require('./services/mdblist');
const animeMap = require('./services/animeMap');
const mal = require('./services/mal');

const STALE_MS = (parseInt(process.env.STALE_HOURS, 10) || 24) * 3600e3;
const BACKOFF_MS = (parseInt(process.env.BACKOFF_MINUTES, 10) || 30) * 60e3;
const WATCHED_REFRESH_MS = 60 * 60e3; // exclusion-only refresh cadence
const MIN_METAS = 5;
const DEFAULT_LIST_SIZE = 20;
// Bench (hidden reserve) is always the same size as the displayed list.
const TRAKT_REC_LIMIT = 100;     // /recommendations max; no pagination exists
const EXTRA_LIST_TARGET = 20; // default extra-catalog size (per-catalog `target` overrides)
const MAX_EXTRA_PAGES = 8;    // headroom for the larger (50-title) kids lists
const EXTRA_PAGE_SIZE = 50;

const locks = new Set(); // profile ids currently rebuilding
const exclusionLocks = new Set(); // profile ids currently refreshing watched sets
// Per-catalog outcome of each profile's most recent completed rebuild.
// In-memory: the portal polls status.rebuilding after firing a rebuild (the
// endpoint returns immediately — a response held open for a multi-minute
// rebuild gets killed by proxies) and reads the results from here when done.
const lastResults = new Map(); // profile id -> { results, finished_at }

function isRebuilding(profileId) {
  return locks.has(profileId);
}

function isStale(catalog) {
  return !catalog || Date.now() - (catalog.generated_at || 0) > STALE_MS;
}

function status(profile) {
  const cache = store.loadCache(profile.id);
  return {
    movie: cache.movie
      ? { generated_at: cache.movie.generated_at, count: cache.movie.metas.length, source: cache.movie.source }
      : null,
    series: cache.series
      ? { generated_at: cache.series.generated_at, count: cache.series.metas.length, source: cache.series.source }
      : null,
    last_attempt_at: cache.last_attempt_at || 0,
    rebuilding: locks.has(profile.id),
    stale: isStale(cache.movie) || isStale(cache.series),
    last_results: lastResults.get(profile.id) || null,
  };
}

// Cross-type watched exclusion sets. IMDb tt IDs are globally unique, so a
// title Trakt logged as a movie but TMDB resolved as a series (docs and
// miniseries flip type between the two databases) is still excluded. TMDB ids
// stay per-type: movie id 550 and TV id 550 are different titles.
function exclusionSets(watchedByType, type) {
  return {
    imdbIds: new Set([...watchedByType.movie.imdbIds, ...watchedByType.series.imdbIds]),
    tmdbIds: watchedByType[type].tmdbIds,
  };
}

// Fetch the full watched state (both types) and persist the snapshot plus the
// last_activities timestamps it corresponds to. With force=false the cheap
// last_activities call runs first and null is returned when nothing was
// watched since the stored snapshot (callers skip the expensive work).
// Activity is read BEFORE the watched lists: a play landing in between makes
// the snapshot look older than it is, so the next hourly check re-fetches —
// errors in the safe direction.
async function syncWatched(profile, { force = false } = {}) {
  const activity = await trakt.getLastActivities(profile);
  const prev = store.loadCache(profile.id).watched_activity || {};
  const watchedChanged = force
    || !(prev.movies === activity.movies && prev.episodes === activity.episodes);
  const watchlistChanged = prev.watchlist !== activity.watchlist;
  let watchedByType = null;
  if (watchedChanged) {
    watchedByType = {
      movie: await trakt.getWatchedSets(profile, 'movie'),
      series: await trakt.getWatchedSets(profile, 'series'),
    };
    store.saveWatched(profile.id, 'movie', watchedByType.movie);
    store.saveWatched(profile.id, 'series', watchedByType.series);
  }
  store.saveWatchedActivity(profile.id, activity); // records watchlist stamp too
  return { watchedByType, watchlistChanged };
}

// Kids-mode gate: strict Common Sense verification via MDBList.
// Every candidate is looked up; unrated titles are dropped, full stop.
// Common Sense Media gate — RETIRED in v5 (2026-07-23).
//
// It was the primary age authority, strict by design: no CSM rating meant the
// title was dropped. That works for mainstream Western titles and fails for
// anime, where coverage is thin, so "unrated" was the common case rather than
// the exception. For an anime-heavy child profile the gate wasn't strict, it
// was absent — it emptied entire catalogs while letting nothing through, and
// a parse bug meant it had almost certainly never worked as intended.
//
// The AI age gate is now the sole age authority on every surface: lists,
// extra catalogs and search. It reads titles it recognises rather than
// requiring a database row, which is exactly the property anime needed.
// It stays remove-only and fail-closed.
//
// Kept as a pass-through for one release so any missed caller degrades to
// "no extra filtering" rather than crashing; the AI gate still runs after it.
async function applyCsmGate(metas) {
  return metas;
}

// Strip internal fields before the metas are served to Stremio.
// Strip every internal field (any `_`-prefixed key) before serving. Generic
// rather than a fixed list so a new pipeline field can't leak by omission.
function cleanMetas(metas) {
  return metas.map((meta) => Object.fromEntries(
    Object.entries(meta).filter(([k]) => !k.startsWith('_')),
  ));
}

// Anime gate (v5.2). Runs BEFORE the LLM on every surface and narrows what it
// has to judge; it never replaces it. Two rules, deliberately opposite:
//
//   BLACKLIST — any positive adult signal (MAL Rx, Hentai/Erotica genre) drops
//   the title permanently, for EVERY profile including adults. Presence is a
//   positive assertion, so it is terminal.
//
//   AGE — only a KNOWN rating above the limit drops a title. An unrated title
//   is KEPT and passed to the LLM. "No rating" is not "too old"; that
//   conflation is exactly what emptied the kids catalogs under CSM.
//
// Survivors carry the MAL band forward as `_certification`, so the LLM judges
// on a real classification instead of guessing at one.
async function applyAnimeGate(metas, profile, log = console) {
  if (!metas.length) return metas;
  const limit = profile.filters?.age_limit || 0;
  await animeMap.ensureLoaded(log);

  const malByMeta = new Map();
  for (const m of metas) {
    const hit = animeMap.lookup(m.id, m._tmdb_id);
    if (hit?.mal) malByMeta.set(m, hit.mal);
  }
  if (!malByMeta.size) return metas;

  const verdicts = await mal.ratings([...malByMeta.values()], log);
  const out = [];
  let blocked = 0;
  let aged = 0;
  for (const m of metas) {
    const malId = malByMeta.get(m);
    const v = malId ? verdicts.get(malId) : null;
    if (mal.isBlacklisted(v)) {
      log.log(`[anime] "${m.name}" is adult-rated (${v.code || 'flagged'}) — permanently blocked`);
      blocked++;
      continue;
    }
    if (mal.blockedForAge(v, limit === 0 ? 0 : judgementAge(profile.filters))) {
      log.log(`[anime] "${m.name}" rated ${v.code} (${v.minAge}+) > limit — dropped`);
      aged++;
      continue;
    }
    if (v?.code) m._certification = v.code; // evidence for the LLM
    out.push(m);
  }
  if (blocked || aged) {
    log.log(`[anime] ${profile.name}: ${blocked} adult-blocked, ${aged} above age band, ${out.length} kept of ${metas.length}`);
  }
  return out;
}

// Request-path blacklist check for `meta`. v5 left meta ungated because an LLM
// call before every title open was unacceptable latency — that reasoning does
// not apply to a local map lookup, so a permanent porn blacklist should not
// have a hole here. Deliberately CACHE-ONLY: an uncached title isn't blocked,
// because blocking must never cost an outbound call on the request path.
// Anything that came through our own lists is already cached.
async function isBlacklistedTitle(imdbId, tmdbId, log = console) {
  try {
    await animeMap.ensureLoaded(log);
    const hit = animeMap.lookup(imdbId, tmdbId);
    if (!hit?.mal) return false;
    return mal.isBlacklisted(mal.cachedVerdict(hit.mal));
  } catch {
    return false; // never fail a title open on a lookup error
  }
}

// Judgement age (decided 2026-07-23): titles are vetted one year ABOVE the
// profile's limit. Classification brackets are coarse — a 13-year-old's
// material sits in the 14+ bracket — and judging exactly AT the limit rejected
// most age-appropriate anime along with the genuinely unsuitable.
function judgementAge(filters) {
  return (filters.age_limit || 0) + 1;
}

// ---- v4 engine: Trakt recommends, code filters ----

// Portal genre names -> Trakt genre slugs (unknown names simply never match).
const TRAKT_SLUGS = {
  Action: 'action', Adventure: 'adventure', Anime: 'anime', Animation: 'animation',
  Comedy: 'comedy', Crime: 'crime', Documentary: 'documentary', Drama: 'drama',
  Family: 'family', Fantasy: 'fantasy', History: 'history', Horror: 'horror',
  Kids: 'children', Music: 'music', Mystery: 'mystery', News: 'news',
  Reality: 'reality', Romance: 'romance', 'Science Fiction': 'science-fiction',
  Soap: 'soap', Talk: 'talk-show', Thriller: 'thriller', 'TV Movie': 'tv-movie',
  War: 'war', Western: 'western',
};

// Deterministic local filters over a parsed Trakt recommendation. The API
// takes no filter params, so this is where every profile constraint is
// enforced — on the extended=full fields Trakt already sent.
function recPasses(r, type, filters, log = console) {
  // Status: unwatchable or dead content out; unknown status is kept.
  if (r.status) {
    if (type === 'movie' && r.status !== 'released') return false;
    if (type === 'series' && ['canceled', 'planned', 'in production', 'upcoming', 'pilot'].includes(r.status)) return false;
  }
  // Rating floor against Trakt's own 0-10 rating (rating_source 'trakt').
  // The 'imdb' source gates later via an MDBList batch. Unrated titles kept.
  if (filters.min_rating > 0 && (filters.rating_source || 'trakt') !== 'imdb'
      && r.rating !== null && r.rating < filters.min_rating) {
    log.log(`[filter] "${r.title}" Trakt ${r.rating} < ${filters.min_rating} — dropped`);
    return false;
  }
  if ((r.votes || 0) < tmdb.voteFloor(filters, type)) return false;
  if (filters.max_age_years > 0 && r.year && r.year < new Date().getFullYear() - filters.max_age_years) return false;
  // Genre exclusions on Trakt slugs. 'Anime' uses Trakt's native anime tag,
  // with a ja-language+animation fallback for untagged titles.
  for (const name of filters.excluded_genres || []) {
    const slug = TRAKT_SLUGS[name];
    if (slug && r.genres.includes(slug)) return false;
    if (name === 'Anime' && r.language === 'ja' && r.genres.includes('animation')) return false;
  }
  return true;
}

// One AI catalog (movie|series): ONE Trakt recommendations call -> local
// deterministic filters -> cross-type watched verification (trust Trakt,
// verify locally) -> optional IMDb rating gate -> kids gates (CSM + AI
// goalkeeper) -> top list_size + equal bench in Trakt's confidence order ->
// TMDB enrichment for the survivors only.
// ---- v5 engine: LLM generates age-aware candidates, code verifies ----

// Ask for more than we need: watched-exclusion, the rating floor and the
// verify pass all cut into the pool, and a thin list is the acceptable
// outcome here — a wrong one is not.
const AI_GEN_MIN = 50;
const AI_GEN_MAX = 60;

// Deterministic filters over a resolved TMDB meta. Same intent as recPasses,
// different source fields — TMDB carries the rating/votes/genres here, Trakt's
// recommendation shape isn't available. Unrated (vote_average 0) passes, as
// everywhere else: "unrated" is not the same as "below the bar".
function aiPasses(m, type, filters) {
  if (filters.min_rating > 0 && m._vote_average && m._vote_average < filters.min_rating) return false;
  if ((m._vote_count || 0) < tmdb.voteFloor(filters, type)) return false;
  if (filters.max_age_years > 0) {
    const year = parseInt(m.releaseInfo, 10);
    if (year && year < new Date().getFullYear() - filters.max_age_years) return false;
  }
  const names = (m._genre_names || []).map((g) => g.toLowerCase());
  for (const name of filters.excluded_genres || []) {
    if (names.includes(name.toLowerCase())) return false;
    if (name === 'Anime' && m._original_language === 'ja' && names.includes('animation')) return false;
  }
  return true;
}

// Taste seeds for one type's generation: mostly this viewer's own history for
// that type, topped up from the OTHER type.
//
// A permanent weighted blend, not a cold-start branch, because the ratio then
// does the fading on its own. With no movie history at all (Ciara) the movie
// seeds are 100% borrowed from her series, and her list is useful on day one;
// as real movie history accumulates the borrowed share is squeezed out until
// it settles at the 70/30 floor. No flag, no special case, nothing to unset.
// The residual 30% is deliberate even for established profiles — it's a second
// angle that one type's history alone can never provide.
//
// AI engine only: Trakt's /recommendations endpoint takes no seed input, so
// profiles on the 'trakt' engine are unaffected.
const SEED_TARGET = 20;
const SEED_OWN_SHARE = 0.7;
const SEED_COLD_START = 3; // below this, a type has no usable signal of its own

function seedsFor(watchedByType, type) {
  const other = type === 'movie' ? 'series' : 'movie';
  const own = (watchedByType[type]?.recent || []).slice(0, Math.round(SEED_TARGET * SEED_OWN_SHARE));
  const otherAll = watchedByType[other]?.recent || [];
  // 70/30 is a RATIO, not a quota to fill. Backfilling to 20 whenever own
  // history was short swamped it: Ciara's 7 anime series seeds were topped up
  // with 13 family-film seeds and the list came back Bakugan and Sofia the
  // First. Seven on-taste seeds beat twenty off-taste ones, so a short own
  // history yields a short seed list — borrowing scales down with it.
  const borrowed = own.length >= SEED_COLD_START
    ? otherAll.slice(0, Math.round(own.length * (1 - SEED_OWN_SHARE) / SEED_OWN_SHARE))
    : otherAll.slice(0, SEED_TARGET - own.length); // genuine cold start: borrow freely
  return [
    ...own.map((s) => ({ ...s, type })),
    ...borrowed.map((s) => ({ ...s, type: other })),
  ];
}

// Pass 1: generate, then prove. Every suggestion is resolved against TMDB, so
// a hallucinated title dies here rather than reaching a catalog.
async function buildAiPool(profile, type, watchedByType, watched, log) {
  const { filters } = profile;
  const listSize = filters.list_size || DEFAULT_LIST_SIZE;
  const count = Math.min(AI_GEN_MAX, Math.max(AI_GEN_MIN, listSize * 3));
  const seeds = seedsFor(watchedByType, type);
  const ownSeeds = seeds.filter((s) => s.type === type).length;
  // Seed composition explains most odd lists — a generation running on
  // borrowed seeds looks very different from one running on its own history,
  // and until this line existed that had to be inferred from the output.
  log.log(`[rebuild] ${profile.name}/${type}: seeds ${ownSeeds} own + ${seeds.length - ownSeeds} borrowed`);
  const suggestions = await llm.generateCandidates(
    profile.keys.groq_api_key, type,
    {
      ageLimit: filters.age_limit > 0 ? judgementAge(filters) : 0,
      seeds,
      count,
      excludedGenres: filters.excluded_genres || [],
    },
    log,
  );

  const resolved = [];
  for (let i = 0; i < suggestions.length; i += 5) {
    const chunk = suggestions.slice(i, i + 5);
    resolved.push(...await Promise.all(
      chunk.map((s) => tmdb.resolveTitle(profile.keys.tmdb_api_key, type, s.title, s.year, log)),
    ));
  }
  let pool = resolved.filter(Boolean);
  const lost = suggestions.length - pool.length;
  if (lost) log.log(`[rebuild] ${profile.name}/${type}: ${lost} suggestion(s) did not resolve on TMDB — dropped`);

  // Two suggestions can resolve to the same entry (alternate titles, or the
  // model naming a show twice).
  const seen = new Set();
  pool = pool.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  pool = pool.filter((m) => !watched.imdbIds.has(m.id) && !(m._tmdb_id && watched.tmdbIds.has(m._tmdb_id)));
  pool = pool.filter((m) => aiPasses(m, type, filters));
  log.log(`[rebuild] ${profile.name}/${type}: pool ${pool.length} after filters/exclusions`);
  return pool;
}

// Pass 2: a fresh remove-only review of what survived. Separated by JOB, not
// vendor — the verifier sees each title cold, with no investment in having
// suggested it.
//
// NOTE: no CSM gate on this path, deliberately. CSM's anime coverage is thin,
// so "unrated" is the common case there and strict mode dropped whole lists —
// which is exactly how Ciara's catalogs emptied. Stage 3 removes it elsewhere.
async function buildAiCatalog(profile, type, watchedByType, watched, listSize, log) {
  const { filters } = profile;
  let pool = await buildAiPool(profile, type, watchedByType, watched, log);
  // Blacklist + anime age band first — unconditional, and it hands the LLM a
  // real MAL classification instead of leaving it to guess.
  pool = await applyAnimeGate(pool, profile, log);
  if (filters.age_limit > 0) {
    const vetoed = await llm.ageGate(
      profile.keys.groq_api_key, type, judgementAge(filters),
      pool.map((m) => ({
        id: m.id, title: m.name, year: m.releaseInfo,
        genres: m._genre_names, certification: m._certification, overview: m.description,
      })),
      log,
    );
    pool = pool.filter((m) => !vetoed.has(m.id));
  }
  const all = cleanMetas(pool);
  const out = { displayed: all.slice(0, listSize), bench: all.slice(listSize, listSize * 2), source: 'ai' };
  log.log(`[rebuild] ${profile.name}/${type}: displayed (${out.displayed.length}, bench ${out.bench.length}): ${out.displayed.map((m) => m.name).join(', ')}`);
  return out;
}

async function buildCatalog(profile, type, watchedByType, log = console) {
  const { filters } = profile;
  const listSize = filters.list_size || DEFAULT_LIST_SIZE;
  const watched = exclusionSets(watchedByType, type);

  if (filters.engine === 'ai') {
    return buildAiCatalog(profile, type, watchedByType, watched, listSize, log);
  }

  const recs = await trakt.getRecommendations(profile, type, TRAKT_REC_LIMIT);
  log.log(`[rebuild] ${profile.name}/${type}: ${recs.length} Trakt recommendations`);
  let pool = recs.filter((r) => recPasses(r, type, filters, log));
  pool = pool.filter((r) => !(r.imdb_id && watched.imdbIds.has(r.imdb_id))
    && !(r.tmdb_id && watched.tmdbIds.has(r.tmdb_id)));

  if (filters.min_rating > 0 && filters.rating_source === 'imdb' && profile.keys.mdblist_api_key) {
    const ratings = await mdblist.imdbRatings(
      profile.keys.mdblist_api_key, type, pool.map((r) => r.imdb_id).filter(Boolean), log,
    );
    pool = pool.filter((r) => {
      const v = r.imdb_id ? ratings.get(r.imdb_id) : null;
      return v === null || v === undefined ? true : v >= filters.min_rating;
    });
  }
  log.log(`[rebuild] ${profile.name}/${type}: pool ${pool.length} after filters/exclusions`);

  // Blacklist + anime age band. Outside the age_limit branch on purpose: the
  // NSFW blacklist applies to adult profiles too. Order is preserved (Trakt's
  // ranking is meaningful) and recs without an IMDb id are left alone — they
  // resolve via TMDB later.
  {
    const wrapped = pool.filter((r) => r.imdb_id)
      .map((r) => ({ id: r.imdb_id, _tmdb_id: r.tmdb_id, name: r.title, __rec: r }));
    const kept = new Set((await applyAnimeGate(wrapped, profile, log)).map((x) => {
      if (x._certification) x.__rec.certification = x._certification;
      return x.__rec;
    }));
    pool = pool.filter((r) => !r.imdb_id || kept.has(r));
  }

  // Kids profiles: the AI age gate, now the sole age authority (CSM retired).
  if (filters.age_limit > 0) {
    pool = pool.filter((r) => r.imdb_id); // needs a stable id to veto against
    const vetoed = await llm.ageGate(
      profile.keys.groq_api_key, type, judgementAge(filters),
      pool.map((r) => ({ id: r.imdb_id, title: r.title, year: r.year, genres: r.genres, certification: r.certification, overview: r.overview })),
      log,
    );
    pool = pool.filter((r) => !vetoed.has(r.imdb_id));
  }

  // Enrich only display + bench, in Trakt's order (top recommendation first).
  const chosen = pool.slice(0, listSize * 2);
  const metas = [];
  for (let i = 0; i < chosen.length; i += 25) {
    const chunk = chosen.slice(i, i + 25);
    metas.push(...await Promise.all(chunk.map(async (r) => {
      if (r.tmdb_id) {
        const m = await tmdb.metaByTmdbId(profile.keys.tmdb_api_key, type, r.tmdb_id, log);
        if (m) return m;
      }
      // Minimal fallback — valid tt id for Stremio; RPDB fills the poster.
      return r.imdb_id
        ? { id: r.imdb_id, type, name: r.title, poster: null, description: r.overview || '', releaseInfo: r.year ? String(r.year) : null, imdbRating: r.rating !== null ? r.rating.toFixed(1) : null }
        : null;
    })));
  }
  const all = cleanMetas(metas.filter(Boolean));
  const out = { displayed: all.slice(0, listSize), bench: all.slice(listSize, listSize * 2), source: 'trakt' };
  log.log(`[rebuild] ${profile.name}/${type}: displayed (${out.displayed.length}, bench ${out.bench.length}): ${out.displayed.map((m) => m.name).join(', ')}`);
  return out;
}

// Fisher-Yates shuffle (in place, returns the same array). Used to randomize
// the order of extra catalogs on each rebuild so a static curated list looks
// fresh day to day and rotates different titles into the highlighted top slots.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Extra catalog: one curated MDBList list -> up to 20 metas. Rating-gated
// catalogs drop items whose IMDb rating is below the bar and keep paging until
// filled; popular charts (min_imdb 0) keep every item. The final selection is
// shuffled so the order looks fresh on each daily rebuild instead of serving
// the same fixed sequence. Watched status is ignored by design. Kids-mode age
// limits still apply — a child profile must never bypass the Common Sense gate
// via an extra catalog.
// Watch Later: mirror of the profile's built-in Trakt watchlist, in the
// user's own order. No taste/rating filters — every item is an explicit user
// choice — but watched titles are excluded (a watch-later list must not show
// what's been seen) and the kids-mode CSM gate still applies. Metas enrich
// via one TMDB details call each; items TMDB can't resolve fall back to a
// minimal tt-id meta (RPDB fills the poster at serve time).
const WATCHLIST_CAP = 100;

// Second age layer for EVERY extra catalog on an age-limited profile — the
// same remove-only AI goalkeeper the AI lists and search use, after the strict
// CSM gate. Adult profiles are untouched (no LLM call). FAIL-CLOSED: without a
// Groq key, or if the gate errors, the caller keeps the previous list rather
// than publishing an unvetted one to a child.
async function applyExtraAgeGate(profile, def, metas, log = console) {
  const ageLimit = profile.filters?.age_limit || 0;
  // The NSFW blacklist is NOT conditional on an age limit — it runs for adult
  // profiles too, and needs no Groq key, so it goes before both early exits.
  let list = await applyAnimeGate(metas, profile, log);
  if (ageLimit <= 0 || !list.length) return list;
  metas = list;
  if (!profile.keys.groq_api_key) {
    throw new Error(`Groq API key missing — required for the kids age check on "${def.name}"`);
  }
  const vetoed = await llm.ageGate(
    profile.keys.groq_api_key, def.type, judgementAge(profile.filters),
    // Genres matter: judging "Berserk" on a truncated overview alone is a
    // much weaker signal than judging it as Action/Horror/Fantasy. They were
    // being stripped before the gate saw them (cleanMetas ran too early).
    metas.map((m) => ({
      id: m.id, title: m.name, year: m.releaseInfo,
      genres: m._genre_names, certification: m._certification, overview: m.description,
    })),
    log,
  );
  const out = metas.filter((m) => !vetoed.has(m.id));
  if (vetoed.size) {
    log.log(`[extra] ${profile.name}/${def.id}: AI age gate removed ${vetoed.size} of ${metas.length}`);
  }
  return out;
}

async function buildWatchlistCatalog(profile, def, log = console) {
  if (!profile.trakt_auth?.access_token) {
    throw new Error('Trakt is not connected — Watch Later mirrors your Trakt watchlist');
  }
  const items = await trakt.getWatchlist(profile, def.type);
  log.log(`[watchlist] ${profile.name}/${def.type}: ${items.length} item(s) on the Trakt watchlist`);
  const watchedImdb = new Set([
    ...(store.loadCache(profile.id).watched?.movie?.imdb || []),
    ...(store.loadCache(profile.id).watched?.series?.imdb || []),
  ]);
  const capped = items.slice(0, WATCHLIST_CAP);
  const metas = [];
  for (let i = 0; i < capped.length; i += 25) {
    const chunk = capped.slice(i, i + 25);
    metas.push(...await Promise.all(chunk.map(async (it) => {
      if (it.imdb_id && watchedImdb.has(it.imdb_id)) return null;
      if (it.tmdb_id) {
        const m = await tmdb.metaByTmdbId(profile.keys.tmdb_api_key, def.type, it.tmdb_id, log);
        if (m) return m;
      }
      // Minimal fallback — still a valid tt id for Stremio; RPDB poster at serve time.
      return it.imdb_id
        ? { id: it.imdb_id, type: def.type, name: it.title, poster: null, description: '', releaseInfo: it.year ? String(it.year) : null }
        : null;
    })));
  }
  return metas.filter((m) => m && !watchedImdb.has(m.id)); // cleaned after the age gate
}

// A public Trakt list -> metas. The list's web-URL filters are site-side only,
// so the rating floor is applied here and the age ceiling by the AI gate in
// buildExtraCatalog. Watched exclusion is opt-in per definition
// (prune_watched), matching the list URL's ignore_watched.
async function buildTraktListCatalog(profile, def, log = console) {
  if (!profile.keys.trakt_client_id) {
    throw new Error('Trakt Client ID is required for Trakt list catalogs');
  }
  const target = def.target || EXTRA_LIST_TARGET;
  const items = await trakt.getListItems(profile, def.user, def.slug, def.type, Math.max(target * 2, 100));
  log.log(`[extra] ${profile.name}/${def.id}: ${items.length} item(s) on ${def.user}/${def.slug}`);

  const watchedImdb = def.prune_watched
    ? new Set([
      ...(store.loadCache(profile.id).watched?.movie?.imdb || []),
      ...(store.loadCache(profile.id).watched?.series?.imdb || []),
    ])
    : new Set();

  const picked = [];
  const seen = new Set();
  for (const it of items) {
    if (picked.length >= target) break;
    if (!it.imdb_id || seen.has(it.imdb_id)) continue;
    seen.add(it.imdb_id);
    if (watchedImdb.has(it.imdb_id)) continue;
    // Trakt's rating is 0-10 like IMDb's; unrated is kept, as everywhere else.
    if (def.min_imdb > 0 && it.rating !== null && it.rating < def.min_imdb) continue;
    picked.push(it);
  }

  const metas = [];
  for (let i = 0; i < picked.length; i += 25) {
    const chunk = picked.slice(i, i + 25);
    metas.push(...await Promise.all(chunk.map(async (it) => {
      if (it.tmdb_id) {
        const m = await tmdb.metaByTmdbId(profile.keys.tmdb_api_key, def.type, it.tmdb_id, log);
        if (m) return m;
      }
      return { id: it.imdb_id, type: def.type, name: it.title, poster: null, description: '', releaseInfo: it.year ? String(it.year) : null };
    })));
  }
  return metas.filter(Boolean); // cleaned after the age gate, which needs genres
}

async function buildExtraCatalog(profile, def, log = console) {
  if (def.source === 'trakt_watchlist') {
    return cleanMetas(await applyExtraAgeGate(profile, def, await buildWatchlistCatalog(profile, def, log), log));
  }
  if (def.source === 'trakt_list') {
    return shuffle(cleanMetas(await applyExtraAgeGate(profile, def, await buildTraktListCatalog(profile, def, log), log)));
  }
  const key = profile.keys.mdblist_api_key;
  if (!key) throw new Error('MDBList API key is required for extra catalogs');
  const target = def.target || EXTRA_LIST_TARGET;
  const collected = [];
  const seen = new Set();
  for (let page = 0; page < MAX_EXTRA_PAGES && collected.length < target; page++) {
    const items = await mdblist.listItemsPage(key, def.user, def.slug, def.type, {
      limit: EXTRA_PAGE_SIZE, offset: page * EXTRA_PAGE_SIZE, sort: def.sort,
    });
    if (!items.length) break;

    // Batch-enrich items whose list entry lacks a poster or (when gated) a
    // rating — one POST for the whole page instead of per-item lookups.
    const needInfo = items.filter((i) => {
      const id = i.imdb_id || i.ids?.imdb;
      return id && (!i.poster || (def.min_imdb > 0 && mdblist.parseImdbRating(i) === null));
    }).map((i) => i.imdb_id || i.ids?.imdb);
    let infoMap = new Map();
    if (needInfo.length) {
      try {
        infoMap = await mdblist.mediaInfoBatch(key, def.type, needInfo);
      } catch (err) {
        log.warn(`[extra] ${def.id}: batch enrich failed (${err.message}) — serving list data as-is`);
      }
    }

    let pageMetas = [];
    for (const item of items) {
      const imdb = item.imdb_id || item.ids?.imdb;
      if (!imdb || seen.has(imdb)) continue;
      seen.add(imdb);
      const info = infoMap.get(imdb);
      const rating = mdblist.parseImdbRating(item) ?? mdblist.parseImdbRating(info);
      // Unrated titles are kept — the gate only drops a rating that exists
      // and is below the bar (same semantics as the AI min-rating filter).
      if (def.min_imdb > 0 && rating !== null && rating < def.min_imdb) {
        log.log(`[extra] ${def.id}: "${item.title}" IMDb ${rating} < ${def.min_imdb} — dropped`);
        continue;
      }
      pageMetas.push({
        id: imdb,
        type: def.type,
        name: item.title || info?.title || imdb,
        poster: item.poster || info?.poster || null,
        description: item.description || info?.description || '',
        releaseInfo: String(item.release_year || info?.year || '') || null,
        imdbRating: rating !== null ? rating.toFixed(1) : null,
      });
    }
    for (const m of pageMetas) {
      if (collected.length >= target) break;
      collected.push(m);
    }
    log.log(`[extra] ${profile.name}/${def.id}: page ${page + 1} -> ${collected.length}/${target}`);
  }
  // Second age layer for kids profiles, then randomize so the daily list
  // looks fresh instead of serving the same fixed sequence.
  return shuffle(await applyExtraAgeGate(profile, def, collected, log));
}

// AI catalogs (movie + series): Trakt-seeded, LLM/discover, watched-excluded.
async function buildAiCatalogs(profile, results, log) {
  // The Groq key is required for the kids-mode age goalkeeper AND, since v5,
  // for the 'ai' engine itself (which is the generator, not just a gate).
  // Checked before any network.
  if ((profile.filters.age_limit > 0 || profile.filters.engine === 'ai') && !profile.keys.groq_api_key) {
    const need = profile.filters.engine === 'ai'
      ? "the 'AI' recommendation engine"
      : 'the kids-mode AI age check';
    const error = `Groq API key missing — required for ${need}; AI catalogs are disabled until one is added`;
    log.warn(`[rebuild] ${profile.name}: ${error}`);
    results.movie = { ok: false, error };
    results.series = { ok: false, error };
    return;
  }
  // Backfill the Trakt account name for profiles connected before we
  // started recording it — surfaces wrong-account authorizations.
  if (!profile.trakt_auth.username) {
    try {
      const username = await trakt.getAccountUsername(profile);
      config.updateProfile(profile.id, { trakt_auth: { ...profile.trakt_auth, username } });
      log.log(`[trakt] ${profile.name}: profile is authorized as Trakt user "${username}"`);
    } catch { /* non-fatal */ }
  }
  // One watched fetch per rebuild, shared by both catalogs — snapshot for
  // serve-time pruning, exclusion sets, and the taste seed. force: the full
  // lists are needed even when nothing changed since the last snapshot.
  let watchedByType;
  try {
    ({ watchedByType } = await syncWatched(profile, { force: true }));
  } catch (err) {
    const error = `Trakt watched fetch failed: ${err.message} — kept previous lists`;
    log.warn(`[rebuild] ${profile.name}: ${error}`);
    results.movie = { ok: false, error };
    results.series = { ok: false, error };
    return;
  }
  const listSize = profile.filters.list_size || DEFAULT_LIST_SIZE;
  for (const type of ['movie', 'series']) {
    try {
      const { displayed, bench, source } = await buildCatalog(profile, type, watchedByType, log);
      if (displayed.length >= MIN_METAS) {
        store.swapCatalog(profile.id, type, displayed, bench, source, listSize); // atomic swap on success only
        results[type] = { ok: true, count: displayed.length, bench: bench.length, source };
        log.log(`[rebuild] ${profile.name}/${type}: swapped in ${displayed.length} + ${bench.length} bench (${source})`);
      } else {
        results[type] = { ok: false, error: `only ${displayed.length} usable titles (< ${MIN_METAS}) — kept previous list` };
        log.warn(`[rebuild] ${profile.name}/${type}: ${results[type].error}`);
      }
    } catch (err) {
      results[type] = { ok: false, error: err.message };
      log.warn(`[rebuild] ${profile.name}/${type} failed: ${err.message} — kept previous list`);
    }
  }
}

// opts.ai / opts.extras scope the rebuild (both default on) so an extras-only
// refresh never burns LLM quota and vice versa.
async function rebuildProfile(profile, log = console, opts = {}) {
  if (locks.has(profile.id)) return { skipped: 'locked' };
  locks.add(profile.id);
  const results = {};
  try {
    store.markAttempt(profile.id);
    if (opts.ai !== false) {
      if (profile.trakt_auth?.access_token) {
        await buildAiCatalogs(profile, results, log);
      } else {
        const error = 'Trakt not connected — AI catalogs skipped';
        results.movie = { ok: false, error };
        results.series = { ok: false, error };
      }
    }
    if (opts.extras !== false) {
      for (const def of catalogs.enabledExtras(profile)) {
        try {
          const metas = await buildExtraCatalog(profile, def, log);
          // Watch Later is a mirror, not a generated list: any size — even
          // empty — is the true state of the user's watchlist, so it always
          // swaps. Curated lists keep the >= MIN_METAS quality gate.
          if (def.source === 'trakt_watchlist' || metas.length >= MIN_METAS) {
            store.swapExtra(profile.id, def.id, metas);
            results[def.id] = { ok: true, count: metas.length };
            log.log(`[extra] ${profile.name}/${def.id}: swapped in ${metas.length} titles`);
          } else {
            results[def.id] = { ok: false, error: `only ${metas.length} usable titles (< ${MIN_METAS}) — kept previous list` };
            log.warn(`[extra] ${profile.name}/${def.id}: ${results[def.id].error}`);
          }
        } catch (err) {
          results[def.id] = { ok: false, error: err.message };
          log.warn(`[extra] ${profile.name}/${def.id} failed: ${err.message} — kept previous list`);
        }
      }
    }
  } finally {
    locks.delete(profile.id);
  }
  lastResults.set(profile.id, { results, finished_at: Date.now() });
  return results;
}

// Fire-and-forget SWR trigger from the addon request path and the scheduler.
// Scoped: only the stale halves (AI vs extras) are rebuilt, and each half is
// skipped when its prerequisite key/auth is missing.
function ensureFresh(profile, log = console) {
  const cache = store.loadCache(profile.id);
  const aiStale = (isStale(cache.movie) || isStale(cache.series))
    && !!profile.trakt_auth?.access_token
    // Groq is only a prerequisite for kids profiles (AI age goalkeeper)
    && (profile.filters.age_limit <= 0 || !!profile.keys.groq_api_key);
  const extrasStale = catalogs.enabledExtras(profile).some(
    (d) => catalogs.requirementMet(profile, d) && isStale(cache.extras?.[d.id]),
  );
  if (!aiStale && !extrasStale) return false;
  if (locks.has(profile.id) || exclusionLocks.has(profile.id)) return false;
  if (Date.now() - (cache.last_attempt_at || 0) < BACKOFF_MS) return false;
  rebuildProfile(profile, log, { ai: aiStale, extras: extrasStale })
    .catch((err) => log.error(`[rebuild] unexpected: ${err.message}`));
  return true;
}

// Cheap hourly exclusion refresh: one last_activities call, and only when
// something new was watched, re-fetch the watched sets and prune those titles
// from the cached lists in place — watched items disappear within the hour
// instead of waiting for the daily rebuild. Never generates recommendations.
function ensureExclusionsFresh(profile, log = console) {
  const cache = store.loadCache(profile.id);
  if (Date.now() - (cache.watched_synced_at || 0) < WATCHED_REFRESH_MS) return false;
  if (locks.has(profile.id) || exclusionLocks.has(profile.id)) return false;
  if (!profile.trakt_auth?.access_token) return false;
  exclusionLocks.add(profile.id);
  (async () => {
    try {
      const { watchedByType, watchlistChanged } = await syncWatched(profile);
      if (watchedByType) {
        const unionImdb = new Set([...watchedByType.movie.imdbIds, ...watchedByType.series.imdbIds]);
        for (const type of ['movie', 'series']) {
          const removed = store.pruneWatched(profile.id, type, unionImdb);
          if (removed > 0) {
            log.log(`[exclusions] ${profile.name}/${type}: pruned ${removed} newly-watched title(s)`);
          }
        }
      }
      // Watch Later freshness: when last_activities says the watchlist moved,
      // rebuild just the watchlist catalogs (no LLM, a handful of API calls) —
      // titles added from Stremio/Nuvio's long-press appear within the hour.
      if (watchlistChanged) {
        for (const def of catalogs.enabledExtras(profile).filter((d) => d.source === 'trakt_watchlist')) {
          try {
            const metas = await buildExtraCatalog(profile, def, log);
            store.swapExtra(profile.id, def.id, metas);
            log.log(`[watchlist] ${profile.name}/${def.id}: refreshed (${metas.length} titles) — watchlist changed on Trakt`);
          } catch (err) {
            log.warn(`[watchlist] ${profile.name}/${def.id}: refresh failed: ${err.message}`);
          }
        }
      }
    } catch (err) {
      log.warn(`[exclusions] ${profile.name}: refresh failed: ${err.message}`);
    } finally {
      exclusionLocks.delete(profile.id);
    }
  })();
  return true;
}

module.exports = {
  ensureFresh,
  ensureExclusionsFresh,
  rebuildProfile,
  buildExtraCatalog,
  status,
  isRebuilding,
  applyCsmGate,
  applyExtraAgeGate,
  cleanMetas,
  recPasses,
  aiPasses,
  judgementAge,
  seedsFor,
  applyAnimeGate,
  isBlacklistedTitle,
  isStale,
  STALE_MS,
  MIN_METAS,
  DEFAULT_LIST_SIZE,
};
