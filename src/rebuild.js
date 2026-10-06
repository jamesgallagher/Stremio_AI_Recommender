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
const settings = require('./settings');
const catalogs = require('./catalogs');
const simkl = require('./services/simkl');
const watchedStore = require('./watchedStore');
const tmdb = require('./services/tmdb');
const mdblist = require('./services/mdblist');
const animeMap = require('./services/animeMap');
const mal = require('./services/mal');

const STALE_MS = (parseInt(process.env.STALE_HOURS, 10) || 24) * 3600e3;
const BACKOFF_MS = (parseInt(process.env.BACKOFF_MINUTES, 10) || 30) * 60e3;
const MIN_METAS = 5;
const MAX_EXTRA_PAGES = 8;    // headroom for the larger reserve builds
const EXTRA_PAGE_SIZE = 50;

const locks = new Set(); // profile ids currently rebuilding
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

// CB-1: per-catalog staleness with the reserve-aware triggers. Returns true
// when a rebuild is needed:
//   - the old time-based staleness (generated_at > STALE_MS), OR
//   - a legacy cache without the 'reserve-v1' format marker (one-time migration), OR
//   - the cache was built for a smaller list size and its reserve is too small
//     to fill the current setting, OR
//   - the eligible visible count has dropped below what it was at build
//     (depletion from watches/suppressions).
// A source already thin at its last successful build does NOT trigger a
// refetch on every request: the depletion check compares against
// eligible_at_build, so a thin source that was thin at build stays put until
// the time-based staleness fires.
function isStaleForProfile(profile, def, entry) {
  if (!entry) return true;
  // Time-based staleness (the original trigger).
  if (Date.now() - (entry.generated_at || 0) > STALE_MS) return true;
  // Legacy cache without the format marker — one-time migration.
  if (!entry.format) return true;
  const listSize = require('./recommendationStore').listSizeFor(profile);
  const builtFor = entry.list_size;
  // List-size change: the pool was built for a smaller size and its eligible
  // count can't fill the current setting.
  if (builtFor && builtFor < listSize) {
    const currentEligible = eligibleVisible(entry.metas, profile, def);
    if (currentEligible < listSize) return true;
  }
  // Depletion: the eligible count has dropped below what it was at build
  // (capped at list size). A thin source that was thin at build does NOT
  // trigger on every request — the check is "the pool can no longer fill the
  // list size", not "any single watch happened".
  if (entry.eligible_at_build != null) {
    const currentEligible = eligibleVisible(entry.metas, profile, def);
    if (Math.min(listSize, currentEligible) < Math.min(listSize, entry.eligible_at_build)) return true;
  }
  return false;
}

// CB-1: the eligible visible count for a catalog's pool — how many titles
// would actually be served after filtering watched (unless dedupe_watched:false)
// and suppressed (unless source is simkl_plantowatch). Used by the swap gate
// and the refresh triggers.
function eligibleVisible(metas, profile, def) {
  if (!metas?.length) return 0;
  let visible = metas;
  if (def.dedupe_watched !== false) {
    const watched = watchedStore.watchedIdSets(profile.id).imdb;
    visible = visible.filter((m) => !watched.has(m.id));
  }
  if (def.source !== 'simkl_plantowatch') {
    const suppressed = require('./recommendationStore').dontRecommendImdbSet(profile.id);
    visible = visible.filter((m) => !suppressed.has(m.id));
  }
  return visible.length;
}

function status(profile) {
  const rs = require('./recommendationStore');   // lazy — heavy module, avoids a load cycle
  const engines = require('./engines');          // lazy — avoids a load cycle
  const cache = store.loadCache(profile.id);
  const perType = (type) => {
    const pool = rs.getRecommended(profile.id, { type, limit: 100000 });
    if (!pool.length) return null;
    const engine = engines.resolveFor(profile, type);
    return {
      count: rs.serveRecommendations(profile, type, { record: false }).length,
      pool: pool.length,
      engine: engine.name,
      generated_at: rs.getBuiltAt(profile.id) || null,
      source: engine.id,
    };
  };
  return {
    movie: perType('movie'),
    series: perType('series'),
    last_attempt_at: cache.last_attempt_at || 0,
    rebuilding: locks.has(profile.id),
    stale: isStale(cache.movie) || isStale(cache.series),
    last_results: lastResults.get(profile.id) || null,
  };
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

// Normalise a TMDB id (number or string) to a string, or null if absent. The
// age gate keys titles by TMDB id, so the identity must be a stable string
// across the MDBList path (string ids) and the Watch Later path (numeric
// _tmdb_id from tmdb.toMeta) — otherwise a blocked id never matches the
// `blocked` set and the gate removes nothing.
function tmdbIdOf(item) {
  const raw = item.ids?.tmdb ?? item.tmdb_id;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
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
  // AGE-2: the MAL band is per tier — the tier's `malMaxAge` replaces the
  // legacy "judged one year above the limit" (judgementAge). 10+/12+ allow
  // MAL G/PG (block PG-13); TV-14/15+ allow PG-13 (block R); R+ stays blocked
  // (adultish) at every tier. `limit` is still read for the no-limit case.
  const ageVerification = require('./ageVerification');
  const tier = ageVerification.tierFor(profile.filters);
  for (const m of metas) {
    const malId = malByMeta.get(m);
    const v = malId ? verdicts.get(malId) : null;
    if (mal.isBlacklisted(v)) {
      log.log(`[anime] "${m.name}" is adult-rated (${v.code || 'flagged'}) — permanently blocked`);
      blocked++;
      continue;
    }
    if (mal.blockedForAge(v, tier ? tier.malMaxAge : 0)) {
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
// Watch Later: mirror of the profile's Simkl plan-to-watch list, in the user's
// own order. No taste/rating filters — every item is an explicit user choice —
// but watched titles are excluded (a watch-later list must not show what's been
// seen) and the kids-mode age gate still applies. Metas enrich via one TMDB
// details call each; items TMDB can't resolve fall back to a minimal tt-id meta
// (RPDB fills the poster at serve time).
const WATCHLIST_CAP = 100;

// Second age layer for EVERY extra catalog on an age-limited profile — the
// same remove-only AI goalkeeper the AI lists and search use, after the strict
// CSM gate. Adult profiles are untouched (no LLM call). FAIL-CLOSED: without a
// Groq key, or if the gate errors, the caller keeps the previous list rather
// than publishing an unvetted one to a child.
// Catalog-level age band (v6): a catalog carrying `age_band` (Trending Kids 12,
// Anime TV-14 13) is gated to that band ALWAYS — even on an adult profile — so
// the row is trustworthy on its own, not only when a profile sets a limit.
// Effective band = min(catalog band, profile limit) when the profile is itself
// limited; otherwise just the catalog band. Ordinary catalogs (no age_band) keep
// the old behaviour: gated only for age-limited profiles.
function effectiveAgeLimit(profile, def) {
  const profileLimit = profile.filters?.age_limit || 0;
  const band = def.age_band || 0;
  if (!band) return profileLimit;
  return profileLimit > 0 ? Math.min(band, profileLimit) : band;
}

async function applyExtraAgeGate(profile, def, metas, log = console) {
  const limit = effectiveAgeLimit(profile, def);
  // The gate stack reads the age limit off the profile's filters, so run it
  // against the EFFECTIVE limit (a banded catalog on an adult profile still gets
  // gated). A no-op clone when the effective limit already equals the profile's.
  const gateProfile = limit === (profile.filters?.age_limit || 0)
    ? profile : { ...profile, filters: { ...profile.filters, age_limit: limit } };
  // The NSFW blacklist is NOT conditional on an age limit — it runs for adult
  // profiles too, and needs no Groq key, so it goes before both early exits.
  let list = await applyAnimeGate(metas, gateProfile, log);
  if (limit <= 0 || !list.length) return list;
  metas = list;
  // CB-0 fail-closed: a title the chain can't identify (no TMDB id) can't be
  // checked individually, so it is withheld from this gated catalog. Log the
  // count (no titles or ids) — applies to Watch Later too.
  const identified = metas.filter((m) => m._tmdb_id != null && String(m._tmdb_id) !== '');
  if (identified.length < metas.length) {
    log.log(`[extra] ${profile.name}/${def.id}: ${metas.length - identified.length} title(s) without a TMDB id withheld (age gate, band ${limit})`);
  }
  // AGE-2: every positive age limit is a chain tier — the multi-source decision
  // chain is the ONLY age gate (mandate B3: no legacy LLM age path remains).
  // The chain's LLM step (step 5) is fail-closed: without an LLM it throws, so
  // the caller keeps the previous list rather than publishing an unvetted one.
  // That tripwire must fire even when every title is unidentifiable (CB-0), so
  // check the provider before the chain is built.
  if (!require('./settings').hasLlm()) {
    throw new Error('No LLM provider configured (set a custom endpoint or a Groq key in Server Config)');
  }
  const ageVerify = require('./ageVerification');
  const tier = ageVerify.tierFor({ age_limit: limit });
  const sources = require('./ageVerification/sources').buildSources(profile, log);
  // CB-0: key by the normalised (string) TMDB id so numeric (Watch Later) and
  // string (MDBList) ids match the `blocked` set.
  const titles = identified.map((m) => ({
    key: `${def.type}:${String(m._tmdb_id)}`,
    imdb_id: m.id,
    adult: m._adult || false,
    title: m.name,
    year: m.releaseInfo,
    genres: m._genre_names || [],
    certification: m._certification || null,
  }));
  const result = await ageVerify.verify(titles, def.type, tier, sources, log);
  const blocked = new Set();
  for (const [k, v] of result) {
    if (v.verdict === 'block') blocked.add(String(k.split(':')[1]));
  }
  const out = identified.filter((m) => !blocked.has(String(m._tmdb_id)));
  if (blocked.size) {
    log.log(`[extra] ${profile.name}/${def.id}: chain removed ${blocked.size} of ${identified.length} (band ${limit})`);
  }
  return out;
}

async function buildWatchlistCatalog(profile, def, log = console) {
  if (!profile.simkl_auth?.access_token) {
    throw new Error('Simkl is not connected — Watch Later mirrors your Simkl plan-to-watch list');
  }
  const items = await simkl.getPlanToWatch(profile, def.type);
  log.log(`[watchlist] ${profile.name}/${def.type}: ${items.length} item(s) on the Simkl plan-to-watch list`);
  // WL-KW: Watch Later ships dedupe_watched:false — a hand-added plan-to-watch
  // title is KEPT even once it's in the watched store. The flag reaches serve
  // time already (addon.js); this makes the BUILD honour it too, so the two
  // prune points below no longer strip watched titles for Watch Later. A future
  // watchlist-style catalog without the flag still prunes.
  const keepWatched = def.dedupe_watched === false;
  const watched = watchedStore.watchedIdSets(profile.id);
  const capped = items.slice(0, WATCHLIST_CAP);
  // WL-AV: suppress plan-to-watch titles that aren't yet streamable at home (a
  // film still in its theatrical/pre-digital window; a show that hasn't aired).
  // SUPPRESS, NEVER REMOVE — nothing is written to Simkl; the title stays on the
  // list and reappears by itself the first rebuild after it's available (an
  // emergent property of build-time filtering + the daily rebuild). "Available"
  // = a past Digital/Physical/TV release in ANY country (movies) or a past
  // first_air_date (series). FAIL OPEN: a title TMDB can't resolve, or one with
  // no usable release rows, is UNKNOWN and shown. NOT_YET/UNKNOWN verdicts are
  // NEVER persisted — they ride the live TMDB fetch each rebuild, since those
  // states can still change; a confirmed AVAILABLE title is memoized in the
  // global released cache (release is a one-way, terminal fact) and skips both
  // the release_dates append and the verdict on every later rebuild. Always-on
  // for both Watch Later rows — no toggle. See docs/watch-later-availability.md.
  const released = store.loadReleasedCache();
  const keyOf = (it) => `${def.type}:${it.imdb_id || it.tmdb_id}`;
  const newlyReleased = [];
  const metas = [];
  for (let i = 0; i < capped.length; i += 25) {
    const chunk = capped.slice(i, i + 25);
    metas.push(...await Promise.all(chunk.map(async (it) => {
      if (!keepWatched && it.imdb_id && watched.imdb.has(it.imdb_id)) return null;
      if (it.tmdb_id) {
        const known = released[keyOf(it)] === true; // terminal AVAILABLE — never re-checked
        const m = await tmdb.metaByTmdbId(profile.keys.tmdb_api_key, def.type, it.tmdb_id, log,
          { append: (!known && def.type === 'movie') ? 'release_dates' : null }); // skip the append when known
        if (m) {
          if (known) return m; // already released -> show, no verdict
          const verdict = def.type === 'series'
            ? tmdb.seriesAvailability(m._release_date)
            : tmdb.movieAvailability(m._release_dates_results); // any-country
          if (verdict === 'NOT_YET') return null;               // suppress (fail-open on UNKNOWN)
          if (verdict === 'AVAILABLE') newlyReleased.push(keyOf(it)); // memoize the terminal state
          return m;                                             // AVAILABLE or UNKNOWN -> show
        }
      }
      // Minimal fallback — TMDB couldn't resolve it -> UNKNOWN -> kept (fail-open),
      // not memoized. Still a valid tt id for Stremio; RPDB poster at serve time.
      return it.imdb_id
        ? { id: it.imdb_id, type: def.type, name: it.title, poster: null, description: '', releaseInfo: it.year ? String(it.year) : null }
        : null;
    })));
  }
  // Persist any newly-confirmed releases in ONE write (like the CP-03 rating batch).
  if (newlyReleased.length) {
    for (const k of newlyReleased) released[k] = true;
    store.saveReleasedCache(released);
  }
  const built = keepWatched
    ? metas.filter(Boolean)
    : metas.filter((m) => m && !watched.imdb.has(m.id)); // cleaned after the age gate

  // CP-03: give each Watch Later title its true IMDb rating (the badge CP-01/
  // CP-02 render), resolved through the shared 2-week cache — one batch fetch of
  // cache misses at BUILD (never the serve path), shared across profiles. The
  // meta already carries a TMDB-derived rating from metaByTmdbId; we only
  // OVERWRITE it when MDBList yields a real IMDb number, so a populated badge is
  // never blanked. No MDBList key -> skip entirely (RPDB poster overlay is
  // unaffected either way).
  const { key: mdblistKey } = settings.resolveMdblistKey(profile);
  if (mdblistKey && built.length) {
    try {
      const ratings = await mdblist.cachedImdbRatings(mdblistKey, def.type, built.map((m) => m.id), log);
      for (const m of built) {
        const r = ratings.get(m.id);
        if (r != null) m.imdbRating = r.toFixed(1);
      }
    } catch (err) {
      log.warn(`[watchlist] ${profile.name}/${def.type}: IMDb rating enrich failed (${err.message}) — keeping TMDB ratings`);
    }
  }
  return built;
}

// Fetch one page of MDBList items and convert them to metas (rating-gated).
// Returns { metas, items } where items is the raw page (empty if no more data).
async function fetchExtraPage(key, def, page, seen, log) {
  const items = await mdblist.listItemsPage(key, def.user, def.slug, def.type, {
    limit: EXTRA_PAGE_SIZE, offset: page * EXTRA_PAGE_SIZE, sort: def.sort,
  });
  if (!items.length) return { metas: [], items };

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

  const metas = [];
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
    metas.push({
      id: imdb,
      type: def.type,
      name: item.title || info?.title || imdb,
      poster: item.poster || info?.poster || null,
      description: item.description || info?.description || '',
      releaseInfo: String(item.release_year || info?.year || '') || null,
      imdbRating: rating !== null ? rating.toFixed(1) : null,
      // CB-0: the age gate keys titles by TMDB id — the real id from the live
      // payload (ids.tmdb, falling back to tmdb_id), not a collapsed `undefined`.
      _tmdb_id: tmdbIdOf(item),
    });
  }
  return { metas, items };
}

async function buildExtraCatalog(profile, def, log = console) {
  if (def.source === 'simkl_plantowatch') {
    return cleanMetas(await applyExtraAgeGate(profile, def, await buildWatchlistCatalog(profile, def, log), log));
  }
  const { key } = settings.resolveMdblistKey(profile);
  if (!key) throw new Error('MDBList API key is required for extra catalogs');
  // CB-1: the visible count comes from the profile's list-size setting (one
  // number for every non-Watch-Later catalog). Watch Later keeps its source-sized
  // list (handled above, before this point). The reserve is 2× the list size so
  // that watched/suppressed titles can be replaced locally without a refetch.
  const listSize = require('./recommendationStore').listSizeFor(profile);
  const target = 2 * listSize;
  const collected = [];
  const seen = new Set();
  // Eligibility filter for counting toward the reserve target: a title is
  // "eligible" if it would be served (not watched unless dedupe_watched:false,
  // not suppressed unless source is simkl_plantowatch). Ineligible titles stay
  // in the cache so undo works locally.
  const watched = watchedStore.watchedIdSets(profile.id).imdb;
  const suppressed = def.source !== 'simkl_plantowatch'
    ? require('./recommendationStore').dontRecommendImdbSet(profile.id)
    : new Set();
  const isEligible = (m) => {
    if (def.dedupe_watched !== false && watched.has(m.id)) return false;
    if (def.source !== 'simkl_plantowatch' && suppressed.has(m.id)) return false;
    return true;
  };
  let eligibleCount = 0;
  let page = 0;

  // Page until 2×listSize ELIGIBLE candidates are collected (or MAX_EXTRA_PAGES).
  // ALL titles (including ineligible) stay in the cache.
  while (page < MAX_EXTRA_PAGES && eligibleCount < target) {
    const { metas: pageMetas, items } = await fetchExtraPage(key, def, page, seen, log);
    if (!items.length) break;
    for (const m of pageMetas) {
      collected.push(m);
      if (isEligible(m)) eligibleCount++;
    }
    log.log(`[extra] ${profile.name}/${def.id}: page ${page + 1} -> ${eligibleCount}/${target} eligible (${collected.length} total)`);
    page++;
  }

  // Second age layer for kids profiles.
  let result = await applyExtraAgeGate(profile, def, collected, log);

  // If the age gate left fewer than listSize eligible and more pages exist,
  // keep paging and run the age gate on the new titles (within MAX_EXTRA_PAGES).
  // Stop only when the source is exhausted (!items.length) — a page of
  // rating-dropped titles doesn't mean the source is exhausted.
  let postAgeEligible = result.filter(isEligible).length;
  while (postAgeEligible < listSize && page < MAX_EXTRA_PAGES) {
    const { metas: pageMetas, items } = await fetchExtraPage(key, def, page, seen, log);
    if (!items.length) break;
    if (pageMetas.length) {
      const aged = await applyExtraAgeGate(profile, def, pageMetas, log);
      result.push(...aged);
      postAgeEligible = result.filter(isEligible).length;
    }
    page++;
  }

  // Randomize so the daily list looks fresh instead of serving the same fixed
  // sequence. cleanMetas strips the internal `_tmdb_id` (and any other `_`
  // field) before the list is cached/served.
  return cleanMetas(shuffle(result));
}

// Rebuilds a profile's EXTRA catalogs (MDBList curated + the remaining
// list-backed catalogs). The AI recommendation catalogs are built separately by
// recommendationStore (v6) — this pipeline no longer touches them.
async function rebuildProfile(profile, log = console, opts = {}, onProgress = () => {}) {
  if (locks.has(profile.id)) return { skipped: 'locked' };
  locks.add(profile.id);
  const results = {};
  try {
    store.markAttempt(profile.id);
    if (opts.extras !== false) {
      const defs = catalogs.enabledExtras(profile);
      let done = 0;
      onProgress(0, `Rebuilding ${defs.length} extra catalog(s)…`);
      for (const def of defs) {
        try {
          const metas = await buildExtraCatalog(profile, def, log);
          // Watch Later is a mirror, not a generated list: any size — even
          // empty — is the true state of the user's watchlist, so it always
          // swaps. Curated lists keep the >= MIN_METAS quality gate plus the
          // CB-1 swap gate: never replace an old catalog with one showing
          // fewer eligible titles.
          if (def.source === 'simkl_plantowatch') {
            store.swapExtra(profile.id, def.id, metas);
            results[def.id] = { ok: true, count: metas.length };
            log.log(`[extra] ${profile.name}/${def.id}: swapped in ${metas.length} titles`);
          } else {
            const listSize = require('./recommendationStore').listSizeFor(profile);
            const newVisible = eligibleVisible(metas, profile, def);
            const oldEntry = store.loadCache(profile.id).extras?.[def.id];
            const oldVisible = oldEntry ? eligibleVisible(oldEntry.metas, profile, def) : 0;
            const gate = newVisible >= Math.min(listSize, oldVisible);
            if (metas.length >= MIN_METAS && gate) {
              const meta = { format: 'reserve-v1', list_size: listSize, eligible_at_build: newVisible };
              store.swapExtra(profile.id, def.id, metas, meta);
              results[def.id] = { ok: true, count: metas.length, visible: newVisible };
              log.log(`[extra] ${profile.name}/${def.id}: swapped in ${metas.length} titles (${newVisible} eligible)`);
            } else {
              const reason = metas.length < MIN_METAS
                ? `only ${metas.length} usable titles (< ${MIN_METAS})`
                : `new visible ${newVisible} < gate ${Math.min(listSize, oldVisible)}`;
              results[def.id] = { ok: false, error: `${reason} — kept previous list` };
              log.warn(`[extra] ${profile.name}/${def.id}: ${results[def.id].error}`);
            }
          }
        } catch (err) {
          results[def.id] = { ok: false, error: err.message };
          log.warn(`[extra] ${profile.name}/${def.id} failed: ${err.message} — kept previous list`);
        }
        done++;
        onProgress((done / (defs.length || 1)) * 100, `Rebuilt ${done}/${defs.length} catalogs (${def.name})`);
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
  const extrasStale = catalogs.enabledExtras(profile).some(
    (d) => catalogs.requirementMet(profile, d) && isStaleForProfile(profile, d, cache.extras?.[d.id]),
  );
  if (!extrasStale) return false;
  if (locks.has(profile.id)) return false;
  if (Date.now() - (cache.last_attempt_at || 0) < BACKOFF_MS) return false;
  require('./jobs').enqueue(profile.id, 'extras', (progress) => rebuildProfile(profile, log, { extras: true }, progress))
    .catch((err) => log.error(`[rebuild] unexpected: ${err.message}`));
  return true;
}

module.exports = {
  ensureFresh,
  rebuildProfile,
  buildExtraCatalog,
  buildWatchlistCatalog,
  status,
  isRebuilding,
  applyCsmGate,
  applyExtraAgeGate,
  effectiveAgeLimit,
  cleanMetas,
  judgementAge,
  applyAnimeGate,
  isBlacklistedTitle,
  isStale,
  isStaleForProfile,
  eligibleVisible,
  STALE_MS,
  MIN_METAS,
};
