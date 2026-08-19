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
const llm = require('./services/groq');
const tmdb = require('./services/tmdb');
const mdblist = require('./services/mdblist');
const animeMap = require('./services/animeMap');
const mal = require('./services/mal');

const STALE_MS = (parseInt(process.env.STALE_HOURS, 10) || 24) * 3600e3;
const BACKOFF_MS = (parseInt(process.env.BACKOFF_MINUTES, 10) || 30) * 60e3;
const MIN_METAS = 5;
const DEFAULT_LIST_SIZE = 20;
// Bench (hidden reserve) is always the same size as the displayed list.
const EXTRA_LIST_TARGET = 20; // default extra-catalog size (per-catalog `target` overrides)
const MAX_EXTRA_PAGES = 8;    // headroom for the larger (50-title) kids lists
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
  if (!settings.hasLlm()) {
    throw new Error(`No LLM configured — required for the age check on "${def.name}" (set a Custom LLM or Groq key in Server Config)`);
  }
  const vetoed = await llm.ageGate(
    def.type, judgementAge(gateProfile.filters),
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
    log.log(`[extra] ${profile.name}/${def.id}: AI age gate removed ${vetoed.size} of ${metas.length} (band ${limit})`);
  }
  return out;
}

async function buildWatchlistCatalog(profile, def, log = console) {
  if (!profile.simkl_auth?.access_token) {
    throw new Error('Simkl is not connected — Watch Later mirrors your Simkl plan-to-watch list');
  }
  const items = await simkl.getPlanToWatch(profile, def.type);
  log.log(`[watchlist] ${profile.name}/${def.type}: ${items.length} item(s) on the Simkl plan-to-watch list`);
  const watched = watchedStore.watchedIdSets(profile.id);
  const capped = items.slice(0, WATCHLIST_CAP);
  const metas = [];
  for (let i = 0; i < capped.length; i += 25) {
    const chunk = capped.slice(i, i + 25);
    metas.push(...await Promise.all(chunk.map(async (it) => {
      if (it.imdb_id && watched.imdb.has(it.imdb_id)) return null;
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
  return metas.filter((m) => m && !watched.imdb.has(m.id)); // cleaned after the age gate
}

async function buildExtraCatalog(profile, def, log = console) {
  if (def.source === 'simkl_plantowatch') {
    return cleanMetas(await applyExtraAgeGate(profile, def, await buildWatchlistCatalog(profile, def, log), log));
  }
  const key = settings.keyFor(profile, 'mdblist_api_key');
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

// Rebuilds a profile's EXTRA catalogs (MDBList curated + the remaining
// list-backed catalogs). The AI recommendation catalogs are built separately by
// recommendationStore (v6) — this pipeline no longer touches them.
async function rebuildProfile(profile, log = console, opts = {}) {
  if (locks.has(profile.id)) return { skipped: 'locked' };
  locks.add(profile.id);
  const results = {};
  try {
    store.markAttempt(profile.id);
    if (opts.extras !== false) {
      for (const def of catalogs.enabledExtras(profile)) {
        try {
          const metas = await buildExtraCatalog(profile, def, log);
          // Watch Later is a mirror, not a generated list: any size — even
          // empty — is the true state of the user's watchlist, so it always
          // swaps. Curated lists keep the >= MIN_METAS quality gate.
          if (def.source === 'simkl_plantowatch' || metas.length >= MIN_METAS) {
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
  const extrasStale = catalogs.enabledExtras(profile).some(
    (d) => catalogs.requirementMet(profile, d) && isStale(cache.extras?.[d.id]),
  );
  if (!extrasStale) return false;
  if (locks.has(profile.id)) return false;
  if (Date.now() - (cache.last_attempt_at || 0) < BACKOFF_MS) return false;
  rebuildProfile(profile, log, { extras: true })
    .catch((err) => log.error(`[rebuild] unexpected: ${err.message}`));
  return true;
}

module.exports = {
  ensureFresh,
  rebuildProfile,
  buildExtraCatalog,
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
  STALE_MS,
  MIN_METAS,
  DEFAULT_LIST_SIZE,
};
