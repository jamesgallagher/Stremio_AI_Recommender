// Stremio addon endpoints — deliberately thin. Reads pre-computed cache only;
// never calls Trakt/LLM/TMDB in the request path. Stale cache triggers a
// background rebuild (fire-and-forget) via rebuild.ensureFresh.
const express = require('express');
const config = require('./config');
const settings = require('./settings');
const store = require('./store');
const rebuild = require('./rebuild');
const catalogs = require('./catalogs');
const recommendationStore = require('./recommendationStore');
const dontRecommend = require('./dontRecommend');
const watchedStore = require('./watchedStore');
const tmdb = require('./services/tmdb');
const llm = require('./services/groq');
const animeMap = require('./services/animeMap');
const cinemeta = require('./services/cinemeta');
const { version } = require('../package.json'); // single source of truth for the addon version

const router = express.Router({ mergeParams: true });

// Always-on AI catalogs. Optional extras (per-profile toggles) live in
// ./catalogs and are appended to the manifest dynamically.
const CATALOGS = {
  'ai-recs-movies': { type: 'movie', name: 'Movies recommended for you' },
  'ai-recs-series': { type: 'series', name: 'Series recommended for you' },
};

// Search-only catalogs (extraRequired: search — never shown on the board).
// Live TMDB search; kids profiles get the same two-layer age protection as
// their lists (CSM gate + AI goalkeeper), fail-closed.
const SEARCH_CATALOGS = {
  'ai-search-movies': { type: 'movie' },
  'ai-search-series': { type: 'series' },
};

// RPDB (ratingposterdb.com): poster images with the rating rendered on them.
// Pure URL substitution at serve time — cache keeps canonical TMDB posters, so
// adding/removing a key applies instantly without a rebuild. fallback=true
// makes RPDB redirect to a plain poster when it doesn't know the title.
function applyRpdb(metas, rpdbKey) {
  if (!rpdbKey) return metas;
  return metas.map((m) => (m.id && m.id.startsWith('tt')
    ? { ...m, poster: `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${m.id}.jpg?fallback=true` }
    : m));
}

// Watch Later mirrors the Simkl plan-to-watch list, so "empty" is a normal,
// lasting state — not a list still warming up. Advertising it anyway puts a
// permanent placeholder row on the home screen, so an empty one is dropped from
// the manifest entirely. Curated MDBList catalogs are NOT dropped: empty there
// means not-built-yet, and the warming-up card is the right answer.
//
// Trade-off: clients cache the manifest, so a watchlist that later gains its
// first title may not show the row again until the addon is reloaded.
function hasContent(profile, def) {
  if (def.source !== 'simkl_plantowatch') return true;
  return (store.loadCache(profile.id).extras?.[def.id]?.metas || []).length > 0;
}

// The in-player "Don't recommend" control. Stremio & Nuvio render a meta's
// `links` as tappable chips beneath the detail page; a link whose url is an
// external http(s) address opens the device's browser, which hits our public
// GET /dnr route — no typing, no auth prompt (a player can't answer one). The
// link is injected at SERVE time, per-profile (like the RPDB poster swap): the
// cached meta is profile-agnostic, and the link has to carry THIS profile's
// token + the title's id, which are exactly "the user profile and the title".
function withDnrLink(meta, req) {
  if (!meta || !meta.id || !meta.type) return meta;
  const url = `${baseUrl(req)}${req.baseUrl}/dnr/${meta.type}/${encodeURIComponent(meta.id)}`;
  const link = { name: 'Don’t recommend', category: 'AI Recommender', url };
  return { ...meta, links: [...(meta.links || []), link] };
}

// Confirmation page shown when the /dnr link is opened in the device browser.
// Self-contained (no external assets — a TV/phone browser may be offline-ish or
// sandboxed) and theme-aware. This presentation is addon-specific; the SHARED
// piece is dontRecommend.suppress(), which the Companion app calls with its own
// native UI instead of this page.
function dnrPage({ ok, title }, profile) {
  const safe = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const name = safe(title || 'This title');
  const who = safe(profile.name);
  const heading = ok ? `${name} won’t be recommended again` : 'Couldn’t update recommendations';
  const detail = ok
    ? `Removed from ${who}’s recommendations. You can close this tab.`
    : `We couldn’t match this title to ${who}’s recommendations. You can close this tab and try again from the recommendations row.`;
  const glyph = ok ? '✓' : '!';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? 'Removed from recommendations' : 'Not updated'}</title>
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; }
  body { display:grid; place-items:center; padding:24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background:#0f1115; color:#e7e9ee; }
  @media (prefers-color-scheme: light) { body { background:#f4f5f7; color:#1a1d24; } }
  .card { max-width:420px; text-align:center; padding:32px 28px; border-radius:16px;
    background:rgba(255,255,255,.04); box-shadow:0 10px 40px rgba(0,0,0,.35); }
  @media (prefers-color-scheme: light) { .card { background:#fff; box-shadow:0 10px 40px rgba(0,0,0,.08); } }
  .badge { width:64px; height:64px; margin:0 auto 20px; border-radius:50%;
    display:grid; place-items:center; font-size:32px; font-weight:700; color:#fff;
    background:${ok ? '#8b5cf6' : '#c2410c'}; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0; opacity:.75; }
</style></head><body><div class="card">
  <div class="badge">${glyph}</div>
  <h1>${heading}</h1>
  <p>${detail}</p>
</div></body></html>`;
}

function manifestFor(profile, baseUrl = '') {
  return {
    id: `au.com.jscc.airecommender.${profile.id.substring(0, 8)}`,
    version,
    name: `AI Recommender — ${profile.name}`,
    description: `Personalized movie & series recommendations for ${profile.name}, generated from Simkl watch history.`,
    ...(baseUrl ? { logo: `${baseUrl}/logo.png` } : {}),
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['catalog', 'meta'],
    catalogs: [
      { type: 'movie', id: 'ai-recs-movies', name: CATALOGS['ai-recs-movies'].name, extra: [{ name: 'skip', isRequired: false }] },
      { type: 'series', id: 'ai-recs-series', name: CATALOGS['ai-recs-series'].name, extra: [{ name: 'skip', isRequired: false }] },
      ...catalogs.enabledExtras(profile).filter((d) => hasContent(profile, d)).map((d) => (
        { type: d.type, id: d.id, name: d.name, extra: [{ name: 'skip', isRequired: false }] }
      )),
      ...Object.entries(SEARCH_CATALOGS).map(([id, s]) => ({
        type: s.type,
        id,
        name: 'Search',
        extra: [{ name: 'search', isRequired: true }],
        extraSupported: ['search'],
        extraRequired: ['search'],
      })),
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

function errorCard(type, description) {
  return {
    id: `ai-recs-notice-${Date.now()}`,
    type,
    name: 'List warming up',
    poster: 'https://placehold.co/500x750/1a1d24/8b5cf6?text=Warming+up...',
    description,
    releaseInfo: '...',
  };
}

// Resolve profile from token on every request
router.use((req, res, next) => {
  const profile = config.getProfileByToken(req.params.token);
  if (!profile) return res.status(404).json({ error: 'Unknown profile token' });
  req.profile = profile;
  next();
});

const { baseUrl } = require('./baseurl');

router.get('/manifest.json', (req, res) => {
  res.json(manifestFor(req.profile, baseUrl(req)));
});

// Live search. The only request-path external calls in the addon — search
// cannot be precomputed. Kids profiles (age_limit > 0) get the SAME age
// protection as their lists: the remove-only AI goalkeeper (v5: CSM retired,
// so this is now the sole age authority here too — search must never be the
// weakest surface). FAIL-CLOSED: any gate failure (missing key, Groq down)
// returns no results rather than unfiltered ones.
async function handleSearch(profile, type, extraStr, res) {
  const raw = (extraStr.match(/search=([^&]+)/) || [])[1] || '';
  let query = '';
  try { query = decodeURIComponent(raw).trim(); } catch { query = raw.trim(); }
  if (query.length < 2 || !settings.keyFor(profile, 'tmdb_api_key')) {
    return res.json({ metas: [], cacheMaxAge: 300 });
  }
  const kids = (profile.filters.age_limit || 0) > 0;
  try {
    let metas = await tmdb.searchTitles(settings.keyFor(profile, 'tmdb_api_key'), type, query, kids ? 10 : 20);
    // NSFW blacklist + anime age band — runs for ADULT searches too, since the
    // blacklist is not tied to an age limit.
    metas = await rebuild.applyAnimeGate(metas, profile, console);
    if (kids) {
      const vetoed = await llm.ageGate(
        type, rebuild.judgementAge(profile.filters),
        metas.map((m) => ({
          id: m.id, cacheId: m._tmdb_id, title: m.name, year: m.releaseInfo,
          genres: m._genre_names, certification: m._certification, overview: m.description,
        })),
        console,
      );
      metas = metas.filter((m) => !vetoed.has(m.id));
    }
    console.log(`[search] ${profile.name}/${type} "${query}": ${metas.length} result(s)${kids ? ' (age-gated)' : ''}`);
    return res.json({ metas: applyRpdb(rebuild.cleanMetas(metas), settings.keyFor(profile, 'rpdb_api_key')), cacheMaxAge: 3600 });
  } catch (err) {
    console.warn(`[search] ${profile.name}/${type} "${query}" failed (${err.message}) — returning no results${kids ? ' (fail-closed)' : ''}`);
    return res.json({ metas: [], cacheMaxAge: 300 });
  }
}

// In-player "Don't recommend". A plain GET the device browser opens from the
// meta link — no interaction, no auth beyond the profile token already in the
// path (the router.use above resolves it or 404s). GET-with-side-effect is
// deliberate: a browser link can only GET, and the action is idempotent (repeat
// taps are harmless — addDontRecommend upserts). Delegates to the shared
// dontRecommend.suppress() so the in-player path, the portal, and the Companion
// app can't drift apart; always answers with a human confirmation page (200),
// never a raw error a TV browser would render as a broken page.
router.get('/dnr/:type/:id', async (req, res) => {
  const profile = req.profile;
  const { type } = req.params;
  const id = req.params.id.replace(/\.json$/, '');
  const isImdb = id.startsWith('tt');
  let result;
  try {
    result = await dontRecommend.suppress(
      profile,
      { type, imdbId: isImdb ? id : null, tmdbId: isImdb ? null : id },
      console,
    );
  } catch (err) {
    console.warn(`[dnr] ${profile.name}/${type} ${id} failed: ${err.message}`);
    result = { ok: false, reason: 'error', title: null };
  }
  res.set('Cache-Control', 'no-store').type('html').send(dnrPage(result, profile));
});

// Metadata service. This exists so a device can run THIS addon plus a stream
// addon and nothing else: before it, a third-party metadata addon was required
// for playback, and that addon answered search UNFILTERED alongside our gated
// results — the kids' age protection was only as strong as the weakest addon
// installed next to it.
//
// Deliberately UNGATED by age: every discovery surface (lists, extras, search)
// is already gated, so nothing un-vetted reaches a child's screen through us,
// and gating here would put an LLM call in front of every title open. Opening
// a title by direct id is not discovery.
router.get('/meta/:type/:id', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id.replace(/\.json$/, '');
  const profile = req.profile;
  if ((type !== 'movie' && type !== 'series') || !id.startsWith('tt')) {
    return res.status(404).json({ error: 'Unknown meta' });
  }
  // Cache first: a cached meta is a fact about the title and needs no API key,
  // so a profile with a broken/absent TMDB key still plays what's already known.
  // Permanent NSFW blacklist applies here too — see rebuild.isBlacklistedTitle.
  if (await rebuild.isBlacklistedTitle(id, null, console)) {
    console.warn(`[meta] ${profile.name}/${type} ${id}: blocked (adult-rated)`);
    return res.status(404).json({ error: 'Not available' });
  }

  // Decay: opening a title's detail page is a soft interest signal — reset its
  // streak so an actively-opened recommendation won't decay out. No-op unless
  // it's in this profile's pool.
  try { recommendationStore.noteMetaOpen(profile.id, type, id); } catch { /* never fail a title open */ }

  const cached = store.loadMeta(type, id);
  if (cached) {
    return res.json({ meta: withDnrLink(applyRpdb([cached], settings.keyFor(profile, 'rpdb_api_key'))[0], req), cacheMaxAge: 43200 });
  }
  if (!settings.keyFor(profile, 'tmdb_api_key')) return res.status(404).json({ error: 'TMDB key not configured' });
  try {
    const result = await tmdb.fullMeta(settings.keyFor(profile, 'tmdb_api_key'), type, id, console);
    if (!result) return res.status(404).json({ error: 'Not found' });

    // Anime series: prefer Cinemeta's episode numbering. TMDB numbers anime by
    // broadcast season, IMDb/Cinemeta often don't, and stream addons key off
    // Cinemeta's ids — a mismatch means episodes that nothing can resolve.
    if (type === 'series') {
      await animeMap.ensureLoaded(console);
      if (animeMap.lookup(id, result.meta._tmdb_id)) {
        const videos = await cinemeta.seriesVideos(id, Date.now(), console);
        if (videos) {
          console.log(`[meta] ${id}: anime — using Cinemeta numbering (${videos.length} episodes, TMDB had ${result.meta.videos?.length || 0})`);
          result.meta.videos = videos;
        }
      }
    }

    store.saveMeta(type, id, result.meta, result.ttlMs);
    const eps = result.meta.videos ? ` (${result.meta.videos.length} episodes)` : '';
    console.log(`[meta] ${profile.name}/${type} ${id}: built${eps}`);
    return res.json({
      meta: withDnrLink(applyRpdb([result.meta], settings.keyFor(profile, 'rpdb_api_key'))[0], req),
      cacheMaxAge: Math.floor(result.ttlMs / 1000),
    });
  } catch (err) {
    console.warn(`[meta] ${profile.name}/${type} ${id} failed: ${err.message}`);
    return res.status(404).json({ error: 'Meta unavailable' });
  }
});

// Matches /catalog/movie/ai-recs-movies.json and .../ai-recs-movies/skip=20.json
router.get('/catalog/:type/:catalogId{/:extra}', async (req, res) => {
  const catalogId = req.params.catalogId.replace(/\.json$/, '');
  const profile = req.profile;

  const searchDef = SEARCH_CATALOGS[catalogId];
  if (searchDef) {
    if (searchDef.type !== req.params.type) return res.status(404).json({ error: 'Unknown catalog' });
    const extraStr = (req.params.extra || '').replace(/\.json$/, '');
    return handleSearch(profile, searchDef.type, extraStr, res);
  }

  const aiCatalog = CATALOGS[catalogId];
  const extraDef = !aiCatalog && catalogs.getExtra(catalogId);
  const def = aiCatalog || extraDef;
  // Age-band catalogs are refused outright, not merely hidden — a client
  // holding a cached manifest must not be able to keep pulling a TV-14 list
  // after the profile's age limit was lowered.
  if (!def || def.type !== req.params.type
    || (extraDef && !(catalogs.isEnabled(profile, extraDef) && catalogs.ageAppropriate(profile, extraDef)))) {
    return res.status(404).json({ error: 'Unknown catalog' });
  }

  // Pagination beyond the list: empty (list is a fixed-size daily selection)
  const extra = (req.params.extra || '').replace(/\.json$/, '');
  const skip = parseInt((extra.match(/skip=(\d+)/) || [])[1] || '0', 10);

  // v6 AI recommendations: served from the recommendationStore pool (built in
  // the background from Simkl history + TMDB). Genre-balanced and filtered at
  // SERVE time — rating floor, excluded genres, recency, age band — so changing
  // a filter takes effect immediately with no rebuild. Cache-only, no network.
  if (aiCatalog) {
    // SWR: fire-and-forget background build when the watched history moved
    // (no-op when fresh/locked). This request serves the current pool.
    if (profile.simkl_auth?.access_token) {
      recommendationStore.ensureBuilt(profile).catch((err) => console.warn(`[rec] ${profile.name}: background build failed — ${err.message}`));
    }
    const metas = recommendationStore.serveRecommendations(profile, def.type);
    if (!metas.length) {
      const description = !profile.simkl_auth?.access_token
        ? 'This profile has not connected Simkl yet — open the configure portal to connect it and build your recommendations.'
        : 'Your recommendations are being generated — check back in a minute or two, or press "Build recommendations" in the configure portal.';
      return res.json({ metas: skip > 0 ? [] : [errorCard(def.type, description)], cacheMaxAge: 5 * 60 });
    }
    // Serve-time watched prune: the pool excludes watched at build, this catches
    // titles watched since. Union of both types — IMDb ids are global and
    // Simkl/TMDB can disagree on movie vs show.
    const watched = watchedStore.watchedIdSets(profile.id);
    const pruned = metas.filter((m) => !watched.imdb.has(m.id));
    const sliced = skip > 0 ? pruned.slice(skip) : pruned;
    return res.json({
      metas: applyRpdb(sliced, settings.keyFor(profile, 'rpdb_api_key')),
      cacheMaxAge: 3600,
      staleRevalidate: 12 * 3600,
    });
  }

  rebuild.ensureFresh(profile); // SWR: fire-and-forget; this request serves cache

  const cache = store.loadCache(profile.id);
  const entry = extraDef ? cache.extras?.[extraDef.id] : cache[def.type];

  if (!entry || !entry.metas.length) {
    // An empty Watch Later is a real state, not a pending one — it's dropped
    // from the manifest, but a client with a cached manifest can still ask for
    // it. Answer honestly with nothing rather than a warming-up placeholder.
    if (extraDef?.source === 'simkl_plantowatch') {
      return res.json({ metas: [], cacheMaxAge: 5 * 60 });
    }
    // Nothing cached yet (first install / not onboarded) — friendly card, short client cache
    const description = extraDef.source === 'simkl_plantowatch'
      ? (!profile.simkl_auth?.access_token
        ? 'Watch Later mirrors your Simkl plan-to-watch list — connect Simkl in the configure portal.'
        : 'Your Simkl plan-to-watch list is empty — add titles on simkl.com or from your player, and they appear here.')
      : (settings.keyFor(profile, 'mdblist_api_key')
        ? 'This list is being generated — check back in a minute or two.'
        : 'This catalog needs an MDBList API key — add one in the configure portal.');
    return res.json({ metas: skip > 0 ? [] : [errorCard(def.type, description)], cacheMaxAge: 5 * 60 });
  }

  // Serve-time watched pruning (v6): de-dupe against the Simkl-backed watched
  // store — Watch Later always, and every curated list EXCEPT those flagged
  // dedupe_watched:false (Christmas re-watchables). IMDb IDs are global, so a
  // title Simkl/TMDB disagree on (movie vs show) is still pruned. Graceful when
  // there's nothing watched — the list serves in full.
  let served = entry.metas;
  if (extraDef.dedupe_watched !== false) {
    const watchedImdb = watchedStore.watchedIdSets(profile.id).imdb;
    served = served.filter((m) => !watchedImdb.has(m.id));
  }

  const sliced = skip > 0 ? served.slice(skip) : served;
  const metas = applyRpdb(sliced, settings.keyFor(profile, 'rpdb_api_key'));
  res.json({
    metas,
    cacheMaxAge: 3600, // short client hint so pruned/rebuilt lists appear quickly
    staleRevalidate: 12 * 3600,
  });
});

module.exports = { router, manifestFor };
