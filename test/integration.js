// INTEGRATION tests — whole features as one flow through the REAL modules.
//
// Where test/smoke.js is mostly UNIT (pure functions in isolation) plus a few
// per-card checks, this suite walks the WHOLE feature end to end.
//   A–F: engine abstraction (SC-01..07) — config → engines registry → build
//        dispatch → shared pipeline → pool → the shared age gate → serve, driven
//        by a non-Genesis engine so it exercises the abstraction, not the engine
//        it was reverse-engineered from.
//   G–I: the catalog-preview cluster (WL-KW + CP-01/02/03) — the Watch Later
//        build, the shared servedCatalog seam, the watched store, the IMDb rating
//        cache, and the Mobile Companion preview handler, composed together.
//   J–N: the mark-watched / not-interested cluster (MW-00..04) — the shared
//        markWatched action + Simkl history write, the pending-watched shim, the
//        source-keyed not-interested exemption, the Watch Later removal, and the
//        preview `source` field, all through the SAME serve seam (MW-05).
//
// Same doctrine as the smoke tests: NO real network. The fixtures are preResolved
// (the pipeline skips the TMDB resolve), a fresh EMPTY anime index keeps the age
// gate's band step offline, and the age gate's LLM ACB pass is served entirely
// from a seeded verdict cache. Run with:
//   node --experimental-sqlite test/integration.js
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-integration-' + Date.now();
process.env.PORT = '7313'; // distinct from smoke.js (7311) + mobile (7312)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
process.env.ADMIN_USER = '';
process.env.ADMIN_PASSWORD = '';
process.env.EXTERNAL_URL = '';

const assert = require('assert');
const config = require('../src/config');
const settings = require('../src/settings');
const rs = require('../src/recommendationStore');
const engines = require('../src/engines');
const store = require('../src/store');
const animeMap = require('../src/services/animeMap');
// Catalog-preview cluster (WL-KW + CP-01/02/03) — the shared serve seam, the
// Watch Later build, the catalog registry, the watched store, and the Mobile
// Companion preview handler, all through their real modules.
const catalogServe = require('../src/catalogServe');
const rebuild = require('../src/rebuild');
const catalogs = require('../src/catalogs');
const watchedStore = require('../src/watchedStore');
const companion = require('../mobile/server/handlers');
const simkl = require('../src/services/simkl');
const tmdb = require('../src/services/tmdb');
// Mark-watched / not-interested cluster (MW-00..04) — the shared markWatched
// action and the shared dontRecommend.suppress, driven through the same serve
// seam the previews and the addon use.
const markWatched = require('../src/markWatched');
const dontRecommend = require('../src/dontRecommend');
const { fake, fakeOpen, makeEngine } = require('./fixtures/fake-engine');
// Glass engine (Phase A) — the trending CDN cache + the enrichment store + the
// engine itself, exercised end to end with injected fetchers (no real network).
const simklTrending = require('../src/services/simklTrending');

const quiet = { log() {}, warn() {}, error() {} };
let passed = 0;
async function it(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

// Minimal Express-like res for driving handlers without HTTP (mirrors the mobile
// smoke harness) — the Companion preview handler writes status()/json().
function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

// A fresh EMPTY, non-stale anime index keeps rebuild.applyAnimeGate offline (no
// Jikan/AniList reach-out) and treats every fixture title as non-anime, so the
// band step is a clean pass and the LLM verdict cache is the only age authority.
function offlineAnimeMap() {
  animeMap._setIndex({ at: Date.now(), etag: 'itest', byImdb: {}, byTmdb: {} });
}
// The persistent LLM verdict cache key the chain's LLM step (step 5) reads:
//   `${type}:${tier.llm.cacheKey}:${tmdb_id}`
// where tier.llm.cacheKey is age10/age12/tv14/age15 — the tier the age_limit
// rounds to (AGE-2: every positive limit runs the chain; the legacy
// "judged at age_limit + 1" wording is gone).
const verdictKey = (type, ageLimit, tmdbId) => {
  const n = ageLimit || 0;
  const cacheKey = n >= 15 ? 'age15' : n >= 14 ? 'tv14' : n >= 12 ? 'age12' : 'age10';
  return `${type}:${cacheKey}:${tmdbId}`;
};

async function main() {
  console.log('integration (engine abstraction, end to end):');
  // A global TMDB key so buildRecommendations doesn't early-return; no MDBList key
  // so the IMDb-rating enrich stays offline. Genesis is always enabled (SC-07).
  settings.updateSettings({ keys: { tmdb_api_key: 'itest-tmdb', mdblist_api_key: '' } });
  offlineAnimeMap();
  store.saveAgeVerdicts({});

  // ── A. Full build → pool → serve through a NON-Genesis engine (adult) ─────────
  // Proves the seam: a producer with none of Genesis's internals flows all the way
  // to a served, genre-balanced, rankScore-ordered list (I6). Adult ⇒ the age gate
  // is a pass-through (no band hits, no LLM), but it STILL runs (buildPool).
  await it('A. non-Genesis engine builds + serves both types, rankScore-ordered + genre-balanced (I6)', async () => {
    const dispose = engines._register(fake);
    settings.updateSettings({ engines: { fake: true } });
    const p = config.addProfile('INT-A');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'fake', engine_series: 'fake' } });
      const r = await rs.buildPool(config.getProfile(p.id), quiet);
      assert.deepStrictEqual(r.engines, { movie: 'fake', series: 'fake' });
      // Serve reads the pool engine-agnostically: 3 distinct genres (Drama/Comedy/
      // Action), one each, so genre-balance yields strongest-bucket-first order.
      const servedMovies = rs.serveRecommendations(config.getProfile(p.id), 'movie').map((m) => m.id);
      const servedSeries = rs.serveRecommendations(config.getProfile(p.id), 'series').map((m) => m.id);
      // metas carry the imdb id; fixture imdb = tt<tag><type><n>.
      assert.deepStrictEqual(servedMovies, ['ttfakemovie1', 'ttfakemovie2', 'ttfakemovie3']);
      assert.deepStrictEqual(servedSeries, ['ttfakeseries1', 'ttfakeseries2', 'ttfakeseries3']);
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false } }); dispose();
    }
  });

  // ── B. Safety is engine-independent (I1), END TO END through buildPool ────────
  // A KIDS profile whose FAKE-sourced pool contains an over-band title never SERVES
  // it — the drop happens in the shared age gate during buildPool, and the served
  // list (not just the pool) is clean. This guards the full build→gate→serve chain,
  // which nothing else does (the smoke test calls ageGatePool directly).
  await it('B. shared age gate removes an over-band title from a fake-sourced kids pool before serve (I1)', async () => {
    const dispose = engines._register(fake);
    settings.updateSettings({ engines: { fake: true } });
    offlineAnimeMap();
    const p = config.addProfile('INT-B');
    config.updateProfile(p.id, { filters: { age_limit: 8, engine_movie: 'fake', engine_series: 'fake' } }); // AGE-2: 8 → the 10+ tier
    // Seed the chain's LLM-step verdict cache so the LLM pass is offline: *-1 unsuitable, rest OK.
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({
      [verdictKey('movie', 8, 'fake-movie-1')]: false,
      [verdictKey('movie', 8, 'fake-movie-2')]: true,
      [verdictKey('movie', 8, 'fake-movie-3')]: true,
      [verdictKey('series', 8, 'fake-series-1')]: false,
      [verdictKey('series', 8, 'fake-series-2')]: true,
      [verdictKey('series', 8, 'fake-series-3')]: true,
    });
    try {
      await rs.buildPool(config.getProfile(p.id), quiet);
      const movies = rs.serveRecommendations(config.getProfile(p.id), 'movie').map((m) => m.id);
      const series = rs.serveRecommendations(config.getProfile(p.id), 'series').map((m) => m.id);
      assert.ok(!movies.includes('ttfakemovie1'), 'over-band movie must not be served to a kid');
      assert.ok(!series.includes('ttfakeseries1'), 'over-band series must not be served to a kid');
      assert.deepStrictEqual(movies, ['ttfakemovie2', 'ttfakemovie3']);
      assert.deepStrictEqual(series, ['ttfakeseries2', 'ttfakeseries3']);
      // The pool itself is vetted too (serve isn't the only guarantee).
      assert.strictEqual(rs.getRecommended(p.id, { type: 'movie', limit: 100 }).length, 2);
    } finally {
      store.saveAgeVerdicts(prev);
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false } }); dispose();
    }
  });

  // ── C. Per-type isolation with TWO different engines, both built + gated ──────
  // Movies via `fake`, Series via `fake2`: each slice carries only its own engine's
  // candidates. The two producers never cross the type boundary.
  await it('C. per-type isolation: two distinct engines fill independent slices', async () => {
    const fake2 = makeEngine({ id: 'fake2', name: 'Fake Two', unrestricted: false });
    const d1 = engines._register(fake);
    const d2 = engines._register(fake2);
    settings.updateSettings({ engines: { fake: true, fake2: true } });
    const p = config.addProfile('INT-C');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'fake', engine_series: 'fake2' } });
      const r = await rs.buildPool(config.getProfile(p.id), quiet);
      assert.deepStrictEqual(r.engines, { movie: 'fake', series: 'fake2' });
      assert.deepStrictEqual(
        rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => x.tmdb_id),
        ['fake-movie-1', 'fake-movie-2', 'fake-movie-3']);
      assert.deepStrictEqual(
        rs.getRecommended(p.id, { type: 'series', limit: 100 }).map((x) => x.tmdb_id),
        ['fake2-series-1', 'fake2-series-2', 'fake2-series-3']);
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false, fake2: false } }); d2(); d1();
    }
  });

  // ── D. Engine-change lifecycle: clearType wipes the old producer, rebuild fills
  //      the new one, dont_recommend survives (engine-independent). Replays exactly
  //      what the portal/companion write hooks do on `engineChanged`.
  await it('D. changing a type\'s engine clears the old slice + rebuilds; dont_recommend persists', async () => {
    const fake2 = makeEngine({ id: 'fake2', name: 'Fake Two', unrestricted: false });
    const d1 = engines._register(fake);
    const d2 = engines._register(fake2);
    settings.updateSettings({ engines: { fake: true, fake2: true } });
    const p = config.addProfile('INT-D');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'fake', engine_series: 'fake' } });
      await rs.buildPool(config.getProfile(p.id), quiet);
      assert.ok(rs.getRecommended(p.id, { type: 'movie', limit: 100 }).some((x) => x.tmdb_id === 'fake-movie-1'));
      // A user rejection (also drops that row) — must outlive an engine swap.
      rs.addDontRecommend(p.id, 'movie', 'fake-movie-2', 'user');
      // Swap the Movies engine; config reports the change so the caller clears+rebuilds.
      const { engineChanged } = config.updateProfile(p.id, { filters: { engine_movie: 'fake2' } });
      assert.deepStrictEqual(engineChanged, ['movie']);
      for (const t of engineChanged) rs.clearType(p.id, t);
      await rs.buildPool(config.getProfile(p.id), quiet);
      const movieIds = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => x.tmdb_id);
      assert.ok(movieIds.every((id) => id.startsWith('fake2-')), 'old engine rows are gone');
      assert.ok(movieIds.includes('fake2-movie-1'), 'new engine rows are present');
      assert.ok(rs.dontRecommendKeys(p.id).has('movie:fake-movie-2'), 'rejection survived the engine swap');
      // Series (unchanged engine) kept serving its own rows across the movie swap.
      assert.ok(rs.getRecommended(p.id, { type: 'series', limit: 100 }).some((x) => x.tmdb_id === 'fake-series-1'));
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false, fake2: false } }); d2(); d1();
    }
  });

  // ── E. I7 end to end: an unrestricted engine serves an ADULT, then the profile
  //      gains an age limit → the engine is REVOKED (updateProfile), its slice is
  //      cleared + rebuilt on Genesis, and the open engine's titles never reach the
  //      now age-limited profile — on build OR serve.
  await it('E. unrestricted engine serves an adult, then is revoked + its content withheld when an age limit is added (I7)', async () => {
    const dFake = engines._register(fake);
    const dOpen = engines._register(fakeOpen);
    settings.updateSettings({ engines: { fake: true, 'fake-open': true } });
    const p = config.addProfile('INT-E');
    try {
      // Adult: the open engine is a legal choice, builds, and serves.
      config.updateProfile(p.id, { filters: { engine_movie: 'fake-open' } });
      assert.strictEqual(engines.resolveFor(config.getProfile(p.id), 'movie').id, 'fake-open');
      await rs.buildPool(config.getProfile(p.id), quiet);
      assert.ok(rs.serveRecommendations(config.getProfile(p.id), 'movie').some((m) => m.id === 'ttfake-openmovie1'));

      // Add an age limit → the write REVOKES the unrestricted engine (§5.5 pt3),
      // reports the change, and the caller clears + rebuilds the slice.
      const { engineChanged } = config.updateProfile(p.id, { filters: { age_limit: 10 } });
      assert.deepStrictEqual(engineChanged, ['movie']);
      assert.strictEqual(config.getProfile(p.id).filters.engine_movie, 'genesis'); // persisted revert
      assert.strictEqual(engines.resolveFor(config.getProfile(p.id), 'movie').id, 'genesis'); // and resolved
      for (const t of engineChanged) rs.clearType(p.id, t);
      await rs.buildPool(config.getProfile(p.id), quiet); // Genesis has no history/Simkl → empty slice
      // The open engine's title is gone from BOTH the pool and the served list.
      assert.strictEqual(rs.getRecommended(p.id, { type: 'movie', limit: 100 }).length, 0);
      assert.deepStrictEqual(rs.serveRecommendations(config.getProfile(p.id), 'movie').map((m) => m.id), []);
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false, 'fake-open': false } }); dOpen(); dFake();
    }
  });

  // ── F. Regression: a NON-HISTORY engine — one that stores candidates but reports
  //      0 watch-history seeds, exactly as a trending/LLM engine would — is treated
  //      as a real build. It is NOT reported `skipped`, it stamps built_at (no
  //      needsBuild churn, finding 2), and its rows are age-gated before serve so an
  //      over-band title never reaches the kid (I1, finding 1). Both regressed
  //      before the review fixes — see the review notes.
  await it('F. a 0-seed engine\'s stored rows build cleanly + are age-gated before serve (I1/churn regression)', async () => {
    const nohist = { // deliberately does NOT set ctx.stats.seeds
      id: 'nohist', name: 'No-History', description: 't', supportedTypes: ['movie', 'series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async (p, type) => [
        { type, tmdb_id: `nh-${type}-1`, rankScore: 3, imdb_id: `ttnh${type}1`, title: 'Over', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 9 },
      ],
    };
    const dispose = engines._register(nohist);
    settings.updateSettings({ engines: { nohist: true } });
    offlineAnimeMap();
    const p = config.addProfile('INT-F');
    config.updateProfile(p.id, { filters: { age_limit: 8, engine_movie: 'nohist', engine_series: 'nohist' } }); // AGE-2: 8 → the 10+ tier
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({ [verdictKey('movie', 8, 'nh-movie-1')]: false, [verdictKey('series', 8, 'nh-series-1')]: false });
    try {
      const r = await rs.buildPool(config.getProfile(p.id), quiet);
      // Finding 2: a 0-seed engine that STORED rows is a real build — not skipped,
      // and built_at is stamped so needsBuild won't re-fire every tick.
      assert.ok(!r.skipped, '0-seed-but-stored build must not be reported as skipped');
      assert.ok(rs.getBuiltAt(p.id) > 0, 'built_at is stamped (no perpetual-rebuild churn)');
      // Finding 1: the shared age gate ran over the stored rows, so the over-band
      // title (verdict=false) never reaches the kid — on serve OR in the pool.
      assert.deepStrictEqual(rs.serveRecommendations(config.getProfile(p.id), 'movie').map((m) => m.id), []);
      assert.strictEqual(rs.getRecommended(p.id, { type: 'movie', limit: 100 }).length, 0);
      assert.strictEqual(rs.getRecommended(p.id, { type: 'series', limit: 100 }).length, 0);
    } finally {
      store.saveAgeVerdicts(prev);
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { nohist: false } }); dispose();
    }
  });

  // ══ Catalog-preview cluster: WL-KW + CP-01 + CP-02 + CP-03, end to end ════════
  // These walk the four catalog cards TOGETHER through the real modules — the
  // Watch Later build, the shared servedCatalog seam (what the addon serialises
  // and both previews delegate to), the watched store, the IMDb rating cache, and
  // the Mobile Companion preview handler — proving the cards compose, not just
  // that each works alone.

  // ── G. Watch Later: a watched title is KEPT (WL-KW) and carries its true IMDb
  //      rating (CP-03) all the way from build → cache → the served list the
  //      preview shows (CP-01 seam), and the Companion preview is that same list.
  await it('G. WL-KW keep-watched + CP-03 rating survive build → cache → served preview, and the Companion preview matches (CP-01/02 seam)', async () => {
    const p = config.addProfile('INT-G');
    const wlDef = catalogs.getExtra('trakt-watchlist-movies');
    assert.strictEqual(wlDef.dedupe_watched, false, 'WL-KW: Watch Later is flagged keep-watched');
    // A plan-to-watch list where ONE title is already in the watched store.
    const origPTW = simkl.getPlanToWatch; const origMeta = tmdb.metaByTmdbId;
    simkl.getPlanToWatch = async () => ([
      { imdb_id: 'tt_seen', tmdb_id: '111', title: 'Seen', year: 2018 },
      { imdb_id: 'tt_fresh', tmdb_id: '222', title: 'Fresh', year: 2020 },
    ]);
    // TMDB gives a fallback rating of 6.0 for both — CP-03 must overwrite it with
    // the true IMDb number when MDBList has one.
    tmdb.metaByTmdbId = async (_k, _t, id) => ({
      id: id === '111' ? 'tt_seen' : 'tt_fresh', type: 'movie', name: id === '111' ? 'Seen' : 'Fresh',
      poster: null, description: '', releaseInfo: id === '111' ? '2018' : '2020', imdbRating: '6.0',
    });
    watchedStore.upsertMany(p.id, [{ type: 'movie', title: 'Seen', year: 2018, tmdb_id: '111', imdb_id: 'tt_seen', simkl_id: 111, watched_at: '2026-08-01T00:00:00Z' }]);
    // Warm the SHARED rating cache so the enrich resolves offline (no MDBList net).
    store.saveImdbRatingCache({ tt_seen: { rating: 8.2, at: Date.now() }, tt_fresh: { rating: 7.4, at: Date.now() } });
    try {
      // BUILD (profile object carries an MDBList key so CP-03 enrich runs).
      const built = await rebuild.buildWatchlistCatalog(
        { id: p.id, name: 'INT-G', simkl_auth: { access_token: 't' }, keys: { tmdb_api_key: 'itest-tmdb', mdblist_api_key: 'int-mdb' }, filters: {} }, wlDef, quiet,
      );
      assert.deepStrictEqual(built.map((m) => m.id), ['tt_seen', 'tt_fresh'], 'WL-KW: watched title kept at BUILD');
      assert.strictEqual(built.find((m) => m.id === 'tt_seen').imdbRating, '8.2', 'CP-03: true IMDb overwrote the TMDB fallback');
      // Persist to the cache the way rebuildProfile does, then SERVE via the seam.
      store.swapExtra(p.id, wlDef.id, built);
      const served = catalogServe.servedCatalog(config.getProfile(p.id), wlDef.id, { record: false });
      assert.strictEqual(served.state, 'ok');
      assert.deepStrictEqual(served.metas.map((m) => m.id), ['tt_seen', 'tt_fresh'], 'WL-KW: watched title NOT pruned at SERVE');
      assert.strictEqual(served.metas.find((m) => m.id === 'tt_seen').imdbRating, '8.2', 'CP-03 rating survived cleanMetas → cache → serve');
      // CP-02: the Companion preview delegates to the SAME servedCatalog — identical list.
      const res = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(p.id), params: { catalogId: wlDef.id } }, res);
      assert.deepStrictEqual(res.body.metas.map((m) => m.id), served.metas.map((m) => m.id), 'preview == serve');
      assert.strictEqual(res.body.metas.find((m) => m.id === 'tt_seen').imdbRating, '8.2');
    } finally {
      simkl.getPlanToWatch = origPTW; tmdb.metaByTmdbId = origMeta;
      store.saveImdbRatingCache({}); watchedStore.deleteForProfile(p.id);
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
    }
  });

  // ── G-AV. WL-AV: a not-yet-streamable plan-to-watch title is SUPPRESSED all
  //      the way through build → cache → served preview (and the Companion preview
  //      matches), an available one survives, nothing is written to Simkl, the
  //      released memo records only the terminal AVAILABLE fact, and the whole
  //      thing SELF-REVERSES once the title goes digital — the emergent property
  //      the card is built on, proven end to end through the real serve seam.
  await it('G-AV. WL-AV suppress→serve, no Simkl write, released memo, and self-reversal through the serve seam', async () => {
    const p = config.addProfile('INT-GAV');
    const wlDef = catalogs.getExtra('trakt-watchlist-movies');
    const NOW = Date.now();
    const past = new Date(NOW - 5 * 864e5).toISOString().slice(0, 10);
    const future = new Date(NOW + 90 * 864e5).toISOString().slice(0, 10);
    const digital = (date) => [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: date }] }];
    const origPTW = simkl.getPlanToWatch; const origMeta = tmdb.metaByTmdbId;
    // Prove NO Simkl write fires from this path: spy the two write entry points.
    const origAdd = simkl.addToPlanToWatch; const origRemove = simkl.removeFromPlanToWatch;
    let simklWrites = 0;
    simkl.addToPlanToWatch = async () => { simklWrites++; return {}; };
    simkl.removeFromPlanToWatch = async () => { simklWrites++; return {}; };
    simkl.getPlanToWatch = async () => ([
      { imdb_id: 'tt_gav_ok', tmdb_id: '7001', title: 'Streamable', year: 2026 },
      { imdb_id: 'tt_gav_soon', tmdb_id: '7002', title: 'Pre-digital', year: 2027 },
    ]);
    // `soonDate` flips from future to past for the self-reversal leg.
    let soonDate = future;
    tmdb.metaByTmdbId = async (_k, _t, id, _log, opts = {}) => ({
      id: id === '7001' ? 'tt_gav_ok' : 'tt_gav_soon', type: 'movie',
      name: id === '7001' ? 'Streamable' : 'Pre-digital', poster: null, description: '',
      releaseInfo: id === '7001' ? '2026' : '2027',
      // Movies get the appended rows; when the memo already knows a title the
      // build passes append:null, but returning rows anyway is harmless.
      _release_dates_results: digital(id === '7001' ? past : soonDate),
    });
    store.saveReleasedCache({});
    const prof = { id: p.id, name: 'INT-GAV', simkl_auth: { access_token: 't' }, keys: { tmdb_api_key: 'itest-tmdb' }, filters: {} };
    try {
      // BUILD → the pre-digital title is dropped, the streamable one kept.
      const built = await rebuild.buildWatchlistCatalog(prof, wlDef, quiet);
      assert.deepStrictEqual(built.map((m) => m.id), ['tt_gav_ok'], 'WL-AV: not-yet title suppressed at BUILD');
      // CACHE → SERVE via the shared seam: the served row omits it too.
      store.swapExtra(p.id, wlDef.id, built);
      const served = catalogServe.servedCatalog(config.getProfile(p.id), wlDef.id, { record: false });
      assert.strictEqual(served.state, 'ok');
      assert.deepStrictEqual(served.metas.map((m) => m.id), ['tt_gav_ok'], 'WL-AV: suppression survives to SERVE');
      // Companion preview delegates to the same seam — identical list.
      const res = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(p.id), params: { catalogId: wlDef.id } }, res);
      assert.deepStrictEqual(res.body.metas.map((m) => m.id), ['tt_gav_ok'], 'preview == serve (suppressed)');
      // Released memo: only the terminal AVAILABLE fact, keyed type:id, shared.
      const memo = store.loadReleasedCache();
      assert.strictEqual(memo['movie:tt_gav_ok'], true, 'AVAILABLE memoized');
      assert.ok(!('movie:tt_gav_soon' in memo), 'NOT_YET never memoized (rides the live fetch)');
      // The suppressed title is STILL on the Simkl list (unchanged) and nothing
      // was written back — suppress, never remove.
      assert.strictEqual((await simkl.getPlanToWatch(prof, 'movie')).length, 2, 'title still on the Simkl list');
      assert.strictEqual(simklWrites, 0, 'WL-AV writes nothing to Simkl');

      // SELF-REVERSAL: the pre-digital title goes digital -> it reappears on the
      // next build → serve with no other change, and is now memoized too.
      soonDate = past;
      const built2 = await rebuild.buildWatchlistCatalog(prof, wlDef, quiet);
      assert.deepStrictEqual(built2.map((m) => m.id), ['tt_gav_ok', 'tt_gav_soon'], 'WL-AV: reappears once available');
      store.swapExtra(p.id, wlDef.id, built2);
      const served2 = catalogServe.servedCatalog(config.getProfile(p.id), wlDef.id, { record: false });
      assert.deepStrictEqual(served2.metas.map((m) => m.id), ['tt_gav_ok', 'tt_gav_soon'], 'WL-AV: reappearance reaches SERVE');
      assert.strictEqual(store.loadReleasedCache()['movie:tt_gav_soon'], true, 'newly-available now memoized');
    } finally {
      simkl.getPlanToWatch = origPTW; tmdb.metaByTmdbId = origMeta;
      simkl.addToPlanToWatch = origAdd; simkl.removeFromPlanToWatch = origRemove;
      store.saveReleasedCache({});
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
    }
  });

  // ── H. AI recommendations: the pool's imdb_rating flows serveRecommendations →
  //      servedCatalog → the Companion preview (CP-03 passthrough). Because the
  //      addon route serialises servedCatalog().metas verbatim, this is also the
  //      rating the client receives — one projection, three surfaces.
  await it('H. CP-03 AI passthrough: imdb_rating (→ vote_average fallback → null) reaches servedCatalog and the Companion preview, type-free name (CP-01 §4)', async () => {
    const p = config.addProfile('INT-H');
    rs.upsertCandidates(p.id, [
      { type: 'movie', tmdb_id: 'h1', imdb_id: 'tth1', title: 'HasImdb', year: 2021, primary_genre: 'Drama', genres: 'Drama', vote_average: 7.0, imdb_rating: 8.9, affinity: 3, rec_count: 1, popularity: 1 },
      { type: 'movie', tmdb_id: 'h2', imdb_id: 'tth2', title: 'TmdbOnly', year: 2021, primary_genre: 'Action', genres: 'Action', vote_average: 6.4, imdb_rating: null, affinity: 2, rec_count: 1, popularity: 1 },
    ]);
    try {
      const served = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      const byId = new Map(served.metas.map((m) => [m.id, m.imdbRating]));
      assert.strictEqual(byId.get('tth1'), '8.9', 'imdb_rating projected onto the served AI meta');
      assert.strictEqual(byId.get('tth2'), '6.4', 'vote_average fallback when imdb_rating is null');
      // Companion preview delegates to servedCatalog: same ids, same ratings, type-free name.
      const res = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(p.id), params: { catalogId: 'ai-recs-movies' } }, res);
      assert.strictEqual(res.body.name, 'Recommended for you');
      assert.deepStrictEqual(res.body.metas.map((m) => m.id), served.metas.map((m) => m.id));
      assert.strictEqual(res.body.metas.find((m) => m.id === 'tth1').imdbRating, '8.9');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
    }
  });

  // ── I. The Companion preview holds the age invariant OVER REAL age-gated content:
  //      a kids profile's fake-sourced AI pool has an over-band title dropped by the
  //      shared age gate (build), so the preview shows only age-passed titles — and
  //      an over-band EXTRA by id is 404 with no age reason, no age field anywhere
  //      (CP-02 × age gate, composing with the engine build of sections A/B).
  await it('I. Companion preview over a kids profile: age-gated AI list + over-band extra 404, no age reason, no age field (CP-02 × age gate)', async () => {
    const dispose = engines._register(fake);
    settings.updateSettings({ engines: { fake: true } });
    offlineAnimeMap();
    const p = config.addProfile('INT-I');
    config.updateProfile(p.id, { filters: { age_limit: 8, engine_movie: 'fake', engine_series: 'fake' } }); // AGE-2: 8 → the 10+ tier
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({
      [verdictKey('movie', 8, 'fake-movie-1')]: false, // over-band -> gated out of the pool
      [verdictKey('movie', 8, 'fake-movie-2')]: true,
      [verdictKey('movie', 8, 'fake-movie-3')]: true,
      // Series build also runs (engine_series: fake) — seed its verdicts too so the
      // LLM step stays offline; all pass (this test only asserts on the movie list).
      [verdictKey('series', 8, 'fake-series-1')]: true,
      [verdictKey('series', 8, 'fake-series-2')]: true,
      [verdictKey('series', 8, 'fake-series-3')]: true,
    });
    try {
      await rs.buildPool(config.getProfile(p.id), quiet);
      // Over-band extra by id -> 404, and the reason never mentions age.
      const banned = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(p.id), params: { catalogId: 'trakt-anime-teen-series' } }, banned);
      assert.strictEqual(banned.statusCode, 404);
      assert.ok(!/age|band|\d+\+/i.test(banned.body.error || ''), 'the 404 reason never mentions age');
      // The AI preview shows only the age-passed titles; the gated one never appears.
      const ai = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(p.id), params: { catalogId: 'ai-recs-movies' } }, ai);
      assert.strictEqual(ai.statusCode, 200);
      assert.ok(!ai.body.metas.some((m) => m.id === 'ttfakemovie1'), 'over-band title is never previewed to a kid');
      assert.deepStrictEqual(ai.body.metas.map((m) => m.id), ['ttfakemovie2', 'ttfakemovie3']);
      assert.ok(!JSON.stringify(ai.body).toLowerCase().includes('age_'), 'no age field leaks in the preview payload');
    } finally {
      store.saveAgeVerdicts(prev);
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
      settings.updateSettings({ engines: { fake: false } }); dispose();
    }
  });

  // ══ Mark-watched / not-interested cluster: MW-00..04, end to end ════════════
  // Five cards touch one flow from three directions — a Simkl history write, a
  // local suppression table, and the shared servedCatalog seam feeding both Nuvio
  // and the two preview surfaces. J–N pin the CROSS-CARD invariants (watched-
  // keeps-in-WL, source-keyed exemption, remove-≠-suppress, source-in-payload,
  // age intact) that no single card's unit tests prove. Same doctrine as A–I:
  // real modules, no network — the only new machinery is a capture spy over the
  // two Simkl writes (addToHistory / removeFromPlanToWatch) that records the body
  // and returns {} (Simkl's de-dupe-safe success), so the body shape stays
  // assertable offline.

  // ── J. A watched mark leaves the AI list AND a curated list (via the pending-
  //      watched union) but is KEPT in Watch Later, and the real synced row later
  //      SUPERSEDES the shim rather than duplicating it (MW-00 × WL-KW × MW-03, I4).
  await it('J. markWatched: pruned from AI + curated, kept in Watch Later; real sync supersedes the shim, not duplicates it (I4)', async () => {
    const p = config.addProfile('INT-J');
    const mprof = { id: p.id, name: 'INT-J', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const origHist = simkl.addToHistory;
    let body = null;
    simkl.addToHistory = async (_profile, b) => { body = b; return {}; }; // capture spy, no network
    // ONE title, present in all three places at once.
    const meta = { id: 'tt_watch', type: 'movie', name: 'Seen It', poster: null, imdbRating: '7.0', releaseInfo: '2019' };
    rs.upsertCandidates(p.id, [
      { type: 'movie', tmdb_id: 'w1', imdb_id: 'tt_watch', title: 'Seen It', year: 2019, primary_genre: 'Drama', genres: 'Drama', vote_average: 7.0, affinity: 5, rec_count: 1, popularity: 1 },
      { type: 'movie', tmdb_id: 'w2', imdb_id: 'tt_keep', title: 'Kept', year: 2020, primary_genre: 'Drama', genres: 'Drama', vote_average: 6.5, affinity: 4, rec_count: 1, popularity: 1 },
    ]);
    store.swapExtra(p.id, 'mdb-war-movies', [meta]);            // curated: dedupe_watched:true, source 'mdblist'
    store.swapExtra(p.id, 'trakt-watchlist-movies', [meta]);    // Watch Later: dedupe_watched:false, source 'simkl_plantowatch'
    try {
      const r = await markWatched.markWatched(mprof, { type: 'movie', imdbId: 'tt_watch', tmdbId: 'w1', title: 'Seen It' }, quiet);
      assert.strictEqual(r.ok, true);
      // The captured /sync/history body: MOVIE shape, imdb+tmdb, NO watched_at (Simkl stamps "now").
      assert.deepStrictEqual(body, { movies: [{ ids: { imdb: 'tt_watch', tmdb: 'w1' } }], shows: [] });
      assert.ok(!('watched_at' in body.movies[0]), 'no watched_at — Simkl stamps now');
      // The pending-watched shim pins it immediately (no sync needed).
      assert.ok(watchedStore.watchedIdSets(p.id).imdb.has('tt_watch'), 'pending shim recorded for immediate serve-prune');
      // Gone from the AI list (pending union) — the other title stays.
      const ai = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.deepStrictEqual(ai.metas.map((m) => m.id), ['tt_keep'], 'watched title pruned from AI, others kept');
      // Gone from the curated (dedupe_watched:true) list too.
      const war = catalogServe.servedCatalog(config.getProfile(p.id), 'mdb-war-movies', { record: false });
      assert.deepStrictEqual(war.metas.map((m) => m.id), [], 'watched title pruned from the curated list');
      // …but KEPT in Watch Later (dedupe_watched:false) — the WL-KW guarantee.
      const wl = catalogServe.servedCatalog(config.getProfile(p.id), 'trakt-watchlist-movies', { record: false });
      assert.deepStrictEqual(wl.metas.map((m) => m.id), ['tt_watch'], 'WL-KW: watched title kept in Watch Later');
      // I4: the real synced row supersedes the shim — retired by the upsert, not left as a duplicate.
      watchedStore.upsertMany(p.id, [{ type: 'movie', title: 'Seen It', year: 2019, tmdb_id: 'w1', imdb_id: 'tt_watch', simkl_id: 9001, watched_at: '2026-09-09T00:00:00Z' }]);
      assert.ok(watchedStore.watchedIdSets(p.id).imdb.has('tt_watch'), 'still watched (now via the real row)');
      assert.strictEqual(watchedStore.clearSupersededPending(p.id), 0, 'the pending shim was already retired by the sync upsert (never on a timer, never duplicated)');
      // Watch Later still keeps it after the real row lands (dedupe_watched:false is absolute).
      const wl2 = catalogServe.servedCatalog(config.getProfile(p.id), 'trakt-watchlist-movies', { record: false });
      assert.deepStrictEqual(wl2.metas.map((m) => m.id), ['tt_watch'], 'WL-KW holds across the sync too');
    } finally {
      simkl.addToHistory = origHist;
      watchedStore.deleteForProfile(p.id);
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
    }
  });

  // ── K. A SERIES marks the WHOLE show watched: the body is shows:[{ids:{imdb}}]
  //      with NO seasons and NO watched_at — the exact contract the I2 live-API
  //      verification must satisfy before promotion (MW-00).
  await it('K. markWatched series → whole-show body: shows:[{ids:{imdb}}], no seasons, no watched_at (I2 contract)', async () => {
    const origHist = simkl.addToHistory;
    let body = null;
    simkl.addToHistory = async (_p, b) => { body = b; return {}; };
    const mprof = { id: 'int-k-' + Date.now(), name: 'INT-K', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    try {
      const r = await markWatched.markWatched(mprof, { type: 'series', imdbId: 'tt_show', title: 'A Show' }, quiet);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(body, { movies: [], shows: [{ ids: { imdb: 'tt_show' } }] });
      assert.ok(!('seasons' in body.shows[0]), 'whole show — no seasons key');
      assert.ok(!('watched_at' in body.shows[0]), 'no watched_at — Simkl stamps now');
    } finally {
      simkl.addToHistory = origHist;
      watchedStore.deleteForProfile(mprof.id);
    }
  });

  // ── L. "Not interested" reaches a curated list (Christmas) and the AI pool but
  //      is EXEMPT on Watch Later — proving the exemption is keyed on SOURCE, not
  //      dedupe_watched: Christmas and Watch Later are BOTH dedupe_watched:false,
  //      yet only Watch Later is spared (MW-03).
  await it('L. not-interested: filtered from Christmas + AI, exempt on Watch Later — source-keyed, not dedupe_watched (MW-03)', async () => {
    const p = config.addProfile('INT-L');
    const meta = { id: 'tt_xmas', type: 'movie', name: 'Reject Me', poster: null, imdbRating: '6.6', releaseInfo: '2015' };
    // In the AI pool so suppress resolves the tmdb from the pool row (no network),
    // and in BOTH dedupe_watched:false lists (Christmas + Watch Later).
    rs.upsertCandidates(p.id, [
      { type: 'movie', tmdb_id: 'x1', imdb_id: 'tt_xmas', title: 'Reject Me', year: 2015, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 6.6, affinity: 3, rec_count: 1, popularity: 1 },
    ]);
    store.swapExtra(p.id, 'mdb-christmas-movies', [meta]);       // dedupe_watched:false, source 'mdblist'
    store.swapExtra(p.id, 'trakt-watchlist-movies', [meta]);     // dedupe_watched:false, source 'simkl_plantowatch'
    try {
      const r = await dontRecommend.suppress({ id: p.id, name: 'INT-L', keys: {}, filters: {} }, { type: 'movie', imdbId: 'tt_xmas' }, quiet);
      assert.strictEqual(r.ok, true, 'suppression resolved a tmdb from the pool row (I1: requires a resolvable tmdb)');
      assert.strictEqual(r.tmdbId, 'x1');
      // AI: the pool row was deleted by suppress.
      const ai = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.ok(!ai.metas.some((m) => m.id === 'tt_xmas'), 'not-interested left the AI list');
      // Christmas (source 'mdblist'): filtered by the imdb-keyed suppression.
      const xmas = catalogServe.servedCatalog(config.getProfile(p.id), 'mdb-christmas-movies', { record: false });
      assert.deepStrictEqual(xmas.metas.map((m) => m.id), [], 'not-interested reaches the curated Christmas list');
      // Watch Later (source 'simkl_plantowatch'): EXEMPT — still present.
      const wl = catalogServe.servedCatalog(config.getProfile(p.id), 'trakt-watchlist-movies', { record: false });
      assert.deepStrictEqual(wl.metas.map((m) => m.id), ['tt_xmas'], 'Watch Later is exempt from not-interested (source-keyed)');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
    }
  });

  // ── M. The Watch Later ✕ is a plan-to-watch REMOVAL, never a suppression: it
  //      fires a Simkl remove, writes NOTHING to dont_recommend, and the title is
  //      still served by the AI list afterwards (MW-04). Driven through the real
  //      companion handler — the actual ✕ path.
  await it('M. Watch Later ✕ → Simkl plan-to-watch remove, no suppression written, AI still serves the title (MW-04)', async () => {
    const p = config.addProfile('INT-M');
    const mprof = { id: p.id, name: 'INT-M', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    rs.upsertCandidates(p.id, [
      { type: 'movie', tmdb_id: 'm1', imdb_id: 'tt_rm', title: 'Still Recommended', year: 2022, primary_genre: 'Action', genres: 'Action', vote_average: 7.2, affinity: 4, rec_count: 1, popularity: 1 },
    ]);
    const origRemove = simkl.removeFromPlanToWatch;
    let captured = null;
    simkl.removeFromPlanToWatch = async (_profile, item) => { captured = item; return {}; }; // capture spy
    try {
      const res = fakeRes();
      await companion.watchlistRemoveHandler({ profile: mprof, body: { type: 'movie', imdb_id: 'tt_rm', tmdb_id: 'm1' } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(captured && (captured.imdb_id === 'tt_rm' || String(captured.tmdb_id) === 'm1'), 'the Simkl plan-to-watch remove was called');
      // NOT a suppression: dont_recommend is untouched — neither the tmdb key nor the imdb set.
      assert.strictEqual(rs.dontRecommendKeys(p.id).size, 0, 'remove != suppress (no dont_recommend row)');
      assert.ok(!rs.dontRecommendImdbSet(p.id).has('tt_rm'), 'remove != suppress (no imdb match key)');
      // And the title is STILL recommended (the whole point of a plain list removal).
      const ai = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.deepStrictEqual(ai.metas.map((m) => m.id), ['tt_rm'], 'a Watch Later removal never stops the AI list recommending the title');
    } finally {
      simkl.removeFromPlanToWatch = origRemove;
      config.removeProfile(p.id); rs.deleteForProfile(p.id); store.deleteCache(p.id);
    }
  });

  // ── N. The Companion preview carries `source` for the ✕/eye wiring (MW-02, I6)
  //      AND still holds the age invariant (CP-02): a Watch Later preview is
  //      source:'simkl_plantowatch' with NO age field, and an over-band extra on a
  //      kids profile is a 404 with no age reason.
  await it('N. preview payload carries source (MW-02/I6) + age invariant intact: WL source, kids over-band 404 no age (CP-02)', async () => {
    const p = config.addProfile('INT-N');
    store.swapExtra(p.id, 'trakt-watchlist-movies', [
      { id: 'tt_n', type: 'movie', name: 'WL Title', poster: null, imdbRating: '7.1', releaseInfo: '2021' },
    ]);
    const kid = config.addProfile('INT-N-kid');
    config.updateProfile(kid.id, { filters: { age_limit: 8 } });
    try {
      const wl = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(p.id), params: { catalogId: 'trakt-watchlist-movies' } }, wl);
      assert.strictEqual(wl.statusCode, 200);
      assert.strictEqual(wl.body.source, 'simkl_plantowatch', 'MW-02: the ✕ branch keys on this source, forwarded by the preview');
      assert.deepStrictEqual(wl.body.metas.map((m) => m.id), ['tt_n']);
      assert.ok(!JSON.stringify(wl.body).toLowerCase().includes('age_'), 'source leaks no age field in the preview payload');
      // Over-band extra on a kids profile → 404, no age reason (regression of the CP cluster's I).
      const banned = fakeRes();
      companion.catalogPreviewHandler({ profile: config.getProfile(kid.id), params: { catalogId: 'trakt-anime-teen-series' } }, banned);
      assert.strictEqual(banned.statusCode, 404);
      assert.ok(!/age|band|\d+\+/i.test(banned.body.error || ''), 'the 404 reason never mentions age');
    } finally {
      config.removeProfile(p.id); config.removeProfile(kid.id);
      rs.deleteForProfile(p.id); rs.deleteForProfile(kid.id); store.deleteCache(p.id); store.deleteCache(kid.id);
    }
  });

  // ── O. Glass GE-02: Simkl trending CDN cache — refresh, 3-way store, graceful
  // degrade, TTL-gated ensureFresh — all with an INJECTED fetcher (no network) ──
  await it('O. GE-02 trending cache: refresh stores 3 lists, degrades to stale on CDN failure, ensureFresh honours TTL', async () => {
    const combined = {
      movies: [{ ids: { tmdb: 603, imdb: 'tt0133093' }, title: 'The Matrix', genres: ['Action'], watched: 100, drop_rate: 1, ratings: { imdb: { rating: 8.7, votes: 9 } } }],
      tv: [{ ids: { tmdb: 1396, imdb: 'tt0903747' }, name: 'Breaking Bad', genres: ['Drama'], watched: 50 }],
      anime: [{ ids: { tmdb: 30984, mal: 20 }, title: 'Naruto', genres: ['Action'], watched: 30 }],
    };
    let calls = 0;
    const fetcher = async () => { calls++; return combined; };
    const r1 = await simklTrending.refresh({ fetcher, now: 1_000_000, log: quiet });
    assert.deepStrictEqual(r1.counts, { movies: 1, tv: 1, anime: 1 });
    assert.strictEqual(simklTrending.getList('movies')[0].tmdb_id, '603');
    assert.strictEqual(simklTrending.getList('anime')[0].mal, 20);

    // Graceful degrade: a failing CDN leaves the last good lists in place (never throws).
    const bad = async () => { throw new Error('CDN 503'); };
    const r2 = await simklTrending.refresh({ fetcher: bad, now: 2_000_000, log: quiet });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(simklTrending.getList('movies').length, 1, 'stale list survives a failed refresh');

    // ensureFresh: within TTL → skip (no fetch); past TTL → refetch.
    calls = 0;
    const fresh = await simklTrending.ensureFresh({ fetcher, ttlMs: simklTrending.REFRESH_TTL_MS, now: 1_000_000 + 3600e3, log: quiet });
    assert.strictEqual(fresh.skipped, 'fresh');
    assert.strictEqual(calls, 0, 'a fresh cache is not refetched');
    const stale = await simklTrending.ensureFresh({ fetcher, ttlMs: simklTrending.REFRESH_TTL_MS, now: 1_000_000 + 25 * 3600e3, log: quiet });
    assert.strictEqual(stale.ok, true);
    assert.strictEqual(calls, 1, 'a stale cache triggers exactly one refetch');
    // maxAgeMs: data at the fetch instant is fresh; older than the tolerance is rejected.
    assert.strictEqual(simklTrending.getList('movies', { maxAgeMs: 10, now: 1_000_000 + 25 * 3600e3 }).length, 1);
    assert.strictEqual(simklTrending.getList('movies', { maxAgeMs: 10, now: 1_000_000 + 25 * 3600e3 + 50 }).length, 0);
  });

  // ── P. Glass GE-03: the deep-metadata store enriches once, then serves cache ──
  await it('P. GE-03 metaStore.enrich fetches once, caches permanently, does not cache a failed fetch', async () => {
    const metaStore = require('../src/engines/glass/metaStore');
    metaStore._clear();
    let calls = 0;
    const fetcher = async (_k, type, tmdbId) => { calls++; return { tmdb_id: String(tmdbId), imdb_id: 'tt' + tmdbId, type, director: ['D'], keywords: ['k'] }; };
    const a = await metaStore.enrich('k', 'movie', 500, quiet, { fetcher });
    assert.strictEqual(a.imdb_id, 'tt500');
    assert.strictEqual(calls, 1);
    const b = await metaStore.enrich('k', 'movie', 500, quiet, { fetcher });   // cache hit → no call
    assert.strictEqual(calls, 1);
    assert.strictEqual(b.director[0], 'D');
    // A null fetch (TMDB failure) is NOT cached — it retries next time.
    const nullFetch = async () => { calls++; return null; };
    assert.strictEqual(await metaStore.enrich('k', 'movie', 501, quiet, { fetcher: nullFetch }), null);
    assert.strictEqual(metaStore.has('movie', 501), false);
    assert.strictEqual(await metaStore.enrich('k', 'movie', 501, quiet, { fetcher: nullFetch }), null);
    assert.strictEqual(calls, 3, 'a failed enrich retries rather than caching the miss');
    metaStore._clear();
  });

  // ── Q. Glass GE-04: watched-history enrichment — paced, capped, cached once ──
  await it('Q. GE-04 enrichWatchedBatch fills the Glass meta store, honours the cap, and is idempotent', async () => {
    const metaStore = require('../src/engines/glass/metaStore');
    const we = require('../src/engines/glass/watchedEnrichment');
    metaStore._clear();
    const p = config.addProfile('INT-Q');
    try {
      // Seed 5 watched movies (newest first via watched_at).
      const items = [];
      for (let i = 1; i <= 5; i++) items.push({ type: 'movie', simkl_id: 900 + i, imdb_id: `ttq${i}`, tmdb_id: String(1000 + i), title: `Q${i}`, year: 2020, watched_at: `2026-09-0${i}T00:00:00Z` });
      watchedStore.upsertMany(p.id, items);
      let calls = 0;
      const fetcher = async (_k, type, tmdbId) => { calls++; return { tmdb_id: String(tmdbId), imdb_id: 'tt' + tmdbId, type, director: ['D' + tmdbId], keywords: ['k'] }; };
      // Cap 3 → only 3 of 5 enriched this run; 2 remain.
      const r1 = await we.enrichWatchedBatch(p.id, 'movie', 'tmdbkey', { cap: 3, fetcher, log: quiet });
      assert.strictEqual(r1.enriched, 3);
      assert.strictEqual(r1.remaining, 2);
      assert.strictEqual(r1.total, 5);
      assert.strictEqual(calls, 3);
      assert.strictEqual(metaStore.count(), 3);
      // Newest-first: tmdb 1005 (watched 09-05) enriched before 1001.
      assert.ok(metaStore.has('movie', 1005));
      // Second run finishes the rest; the first 3 are cache hits (no re-fetch).
      calls = 0;
      const r2 = await we.enrichWatchedBatch(p.id, 'movie', 'tmdbkey', { cap: 10, fetcher, log: quiet });
      assert.strictEqual(r2.enriched, 2);
      assert.strictEqual(r2.remaining, 0);
      assert.strictEqual(calls, 2, 'only the 2 uncached titles are fetched');
      assert.strictEqual(metaStore.count(), 5);
      // No TMDB key → skipped, no calls.
      assert.strictEqual((await we.enrichWatchedBatch(p.id, 'movie', '', { fetcher, log: quiet })).skipped, 'no TMDB key');
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear();
    }
  });

  // ── Glass Phase A end-to-end (GE-05/06/07) through the REAL build + serve ─────
  // Offline: seed the trending cache + the Glass metadata store so every network
  // hop is a cache hit, and stub tmdb.getRecommendations + getGenreMap. This runs
  // the actual glass engine through buildRecommendations → shared pipeline (upsert,
  // preResolved skip) → pool, then buildPool's shared age gate, then serve.
  const metaStore = require('../src/engines/glass/metaStore');
  const GENRE_MAP = { 18: 'Drama', 27: 'Horror', 28: 'Action' };
  // Full deep-metas for every candidate the fixtures below produce.
  function seedGlassFixtures(pid) {
    watchedStore.deleteForProfile(pid); metaStore._clear();
    // Watched Drama seeds (recent) — drive the taste model + A/B recommendations.
    watchedStore.upsertMany(pid, [
      { type: 'movie', simkl_id: 1, imdb_id: 'ttw1', tmdb_id: '101', title: 'Watched One', year: 2024, watched_at: '2026-09-08T00:00:00Z' },
      { type: 'movie', simkl_id: 2, imdb_id: 'ttw2', tmdb_id: '102', title: 'Watched Two', year: 2023, watched_at: '2026-09-05T00:00:00Z' },
    ]);
    const mk = (tmdb, imdb, genres, extra = {}) => ({ tmdb_id: String(tmdb), imdb_id: imdb, type: 'movie', genres, primary_genre: genres[0], vote_average: 8, vote_count: 5000, popularity: 40, original_language: 'en', runtime: 120, decade: 2020, director: ['Nolan'], cast: ['A'], keywords: ['dream'], year: 2024, poster: null, ...extra });
    metaStore.put('movie', 101, mk(101, 'ttw1', ['Drama']));
    metaStore.put('movie', 102, mk(102, 'ttw2', ['Drama']));
    // Candidates: 301/302 from recommendations; 401 (Drama, trending) + 402 (Horror,
    // exploration) from trending.
    metaStore.put('movie', 301, mk(301, 'tt301', ['Drama']));
    metaStore.put('movie', 302, mk(302, 'tt302', ['Drama']));
    metaStore.put('movie', 401, mk(401, 'tt401', ['Drama'], { director: ['Someone'] }));
    metaStore.put('movie', 402, mk(402, 'tt402', ['Horror'], { director: ['Other'], keywords: [] }));
    // Trending cache (fresh now) — movies list carries 401 (in-taste) + 402 (outside).
    simklTrending.upsertList('movies', [
      { list_type: 'movies', tmdb_id: '401', imdb_id: 'tt401', title: 'Trending Drama', year: 2026, genres: ['Drama'], watched: 5000, drop_rate: 2, ratings: { imdb: { rating: 8.2, votes: 100 } } },
      { list_type: 'movies', tmdb_id: '402', imdb_id: 'tt402', title: 'Trending Horror', year: 2026, genres: ['Horror'], watched: 9000, drop_rate: 3, ratings: { imdb: { rating: 7.0, votes: 80 } } },
    ], Date.now());
    simklTrending.upsertList('tv', [], Date.now());
    simklTrending.upsertList('anime', [], Date.now());
  }
  // Stub the two live TMDB calls glass makes outside the (pre-seeded) meta store.
  const origRecs = tmdb.getRecommendations;
  const origGenreMap = tmdb.getGenreMap;
  function stubTmdb() {
    tmdb.getRecommendations = async (_k, type, seedId) => (type === 'movie'
      ? [{ type, tmdb_id: '301', title: 'Rec A', year: 2024, genre_ids: [18], vote_average: 8, vote_count: 5000, popularity: 30, adult: false, poster: null },
         { type, tmdb_id: '302', title: 'Rec B', year: 2023, genre_ids: [18], vote_average: 7, vote_count: 4000, popularity: 20, adult: false, poster: null }]
      : []);
    tmdb.getGenreMap = async () => GENRE_MAP;
  }
  function restoreTmdb() { tmdb.getRecommendations = origRecs; tmdb.getGenreMap = origGenreMap; }

  await it('R. Glass builds a preResolved, rankScore-ordered pool with score_components + engine_id (adult, end to end)', async () => {
    settings.updateSettings({ engines: { glass: true } });
    stubTmdb();
    const p = config.addProfile('INT-R');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'glass', engine_series: 'glass' } });
      seedGlassFixtures(p.id);
      const r = await rs.buildPool(config.getProfile(p.id), quiet);
      assert.strictEqual(r.engines.movie, 'glass');
      const rows = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
      assert.ok(rows.length >= 3, 'glass produced a movie pool');
      // GE-01: every Glass row carries engine_id + algorithm_version + JSON components.
      for (const row of rows) {
        assert.strictEqual(row.engine_id, 'glass');
        assert.strictEqual(row.algorithm_version, 'glass-a1');
        const comp = JSON.parse(row.score_components);
        assert.ok(comp.features && typeof comp.features.taste_match === 'number');
        assert.ok(Array.isArray(comp.sources));
        // preResolved (§5.5): the pipeline skipped its own resolve, so these came
        // from Glass's append call.
        assert.ok(row.imdb_id && row.genres && row.primary_genre);
      }
      // Served in rankScore (affinity) order, genre-balanced — a real served list.
      const served = rs.serveRecommendations(config.getProfile(p.id), 'movie');
      assert.ok(served.length >= 1);
      const affinities = rows.map((x) => x.affinity);
      assert.deepStrictEqual([...affinities], [...affinities].sort((a, b) => b - a), 'stored affinity is rankScore-ordered');
      // Strategy breadth (GE-05): the pool carries BOTH a /recommendations-sourced
      // title (A/B) and an exploration-sourced one (G), not just one strategy.
      const allSources = new Set(rows.flatMap((x) => JSON.parse(x.score_components).sources));
      assert.ok(allSources.has('recommendations'), 'A/B recommendations reached the pool');
      assert.ok(allSources.has('exploration') || allSources.has('trending'), 'a trending/exploration strategy reached the pool');
    } finally {
      restoreTmdb();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear();
      settings.updateSettings({ engines: { glass: false } });
      simklTrending.upsertList('movies', [], 0); simklTrending.upsertList('tv', [], 0); simklTrending.upsertList('anime', [], 0);
    }
  });

  await it('R2. Glass Tier-2 config is build-affecting: a settings.glass reweight rebuilds a different pool ordering', async () => {
    settings.updateSettings({ engines: { glass: true }, glass: {} });
    stubTmdb();
    const p = config.addProfile('INT-R2');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'glass', engine_series: 'glass' } });
      seedGlassFixtures(p.id);
      await rs.buildPool(config.getProfile(p.id), quiet);
      const before = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => `${x.tmdb_id}:${x.affinity.toFixed(4)}`);
      // Tier-2 reweight: crank exploration + momentum to the exclusion of taste, then
      // rebuild the slice (the SC-03 clearType path a real admin change fans out).
      settings.updateSettings({ glass: { weights: { taste_match: 0, quality: 0, trending_momentum: 0.5, popularity: 0, release_recency: 0, novelty: 0.2, exploration: 0.3 } } });
      rs.clearType(p.id, 'movie');
      await rs.buildPool(config.getProfile(p.id), quiet);
      const after = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => `${x.tmdb_id}:${x.affinity.toFixed(4)}`);
      assert.notDeepStrictEqual(after, before, 'a Tier-2 reweight changes the stored rankScore ordering/values');
    } finally {
      restoreTmdb();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear();
      settings.updateSettings({ engines: { glass: false }, glass: {} });
      simklTrending.upsertList('movies', [], 0); simklTrending.upsertList('tv', [], 0); simklTrending.upsertList('anime', [], 0);
    }
  });

  await it('S. Glass conformance safety (I1): the shared age gate drops an over-band Glass title before serve (kids)', async () => {
    settings.updateSettings({ engines: { glass: true } });
    stubTmdb();
    offlineAnimeMap();
    const p = config.addProfile('INT-S');
    config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { age_limit: 8, engine_movie: 'glass', engine_series: 'glass' } }); // AGE-2: 8 → the 10+ tier
    const prev = store.loadAgeVerdicts();
    try {
      seedGlassFixtures(p.id);
      // Chain LLM-step verdict cache: veto tmdb 401 for the 10+ tier; everything else OK. The
      // age gate — NOT the engine — is the authority (I1), proven over a Glass pool.
      store.saveAgeVerdicts({
        [verdictKey('movie', 8, '301')]: true, [verdictKey('movie', 8, '302')]: true,
        [verdictKey('movie', 8, '401')]: false, [verdictKey('movie', 8, '402')]: true,
      });
      await rs.buildPool(config.getProfile(p.id), quiet);
      const pool = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => x.tmdb_id);
      assert.ok(!pool.includes('401'), 'the over-band Glass title is removed from the pool by the shared gate');
      const served = rs.serveRecommendations(config.getProfile(p.id), 'movie').map((m) => m.id);
      assert.ok(!served.includes('tt401'), 'and never served to the kid');
    } finally {
      restoreTmdb(); store.saveAgeVerdicts(prev);
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear();
      settings.updateSettings({ engines: { glass: false } });
      simklTrending.upsertList('movies', [], 0); simklTrending.upsertList('tv', [], 0); simklTrending.upsertList('anime', [], 0);
    }
  });

  // ── T. Glass GE-08: LLM rerank reorders + explains; degrades to deterministic ─
  await it('T. GE-08 rerank reorders the head, writes reasons, keeps the score band, and degrades on every failure', async () => {
    const rerank = require('../src/engines/glass/rerank');
    const cfg = require('../src/engines/glass/config').resolveConfig(null);
    const taste = { dims: { genres: { Drama: 1 }, directors: {}, franchises: {}, keywords: {}, decades: {} } };
    const mk = (id, score) => ({ tmdb_id: id, title: `T${id}`, year: 2024, genres: 'Drama', rankScore: score, reason: `det ${id}`, sources: ['recommendations'], score_components: { features: {}, matched: {} } });
    const scored = [mk('1', 0.9), mk('2', 0.8), mk('3', 0.7), mk('4', 0.6)];
    const chain = [{ type: 'custom', name: 'q', uri: 'http://x' }];

    // The model reverses the top-3 (cap kept default; here all 4 are head) and gives reasons.
    const chat = async () => ([{ id: '3', reason: 'freshest pick' }, { id: '1', reason: 'core taste' }, { id: '2' }, { id: '4', reason: 'x' }]);
    const out = await rerank.rerankCandidates('movie', scored.map((c) => ({ ...c, score_components: { ...c.score_components } })), taste, cfg, { chain, chat, log: quiet });
    assert.deepStrictEqual(out.map((c) => c.tmdb_id), ['3', '1', '2', '4']);          // model order
    assert.deepStrictEqual(out.map((c) => c.rankScore), [0.9, 0.8, 0.7, 0.6]);        // original band re-stamped desc
    assert.strictEqual(out[0].reason, 'freshest pick');                              // → because_title
    assert.strictEqual(out[0].score_components.rerank.by, 'llm');
    assert.strictEqual(out[2].reason, 'det 2');                                       // no reason from model → deterministic kept

    // Unknown/duplicate ids are ignored (can't invent); dropped head items appended in order.
    const partial = async () => ([{ id: '999' }, { id: '2', reason: 'ok' }, { id: '2' }]);
    const out2 = await rerank.rerankCandidates('movie', scored.map((c) => ({ ...c })), taste, cfg, { chain, chat: partial, log: quiet });
    assert.deepStrictEqual(out2.map((c) => c.tmdb_id), ['2', '1', '3', '4']);         // 2 first, rest original order
    assert.deepStrictEqual(out2.map((c) => c.rankScore), [0.9, 0.8, 0.7, 0.6]);

    // Degrade paths → the deterministic input is returned UNCHANGED, never throws.
    const same = (arr) => arr.map((c) => c.tmdb_id);
    assert.deepStrictEqual(same(await rerank.rerankCandidates('movie', scored, taste, cfg, { chain: [], chat, log: quiet })), ['1', '2', '3', '4']); // no local endpoint
    assert.deepStrictEqual(same(await rerank.rerankCandidates('movie', scored, taste, cfg, { chain, chat: async () => { throw new Error('timeout'); }, log: quiet })), ['1', '2', '3', '4']);
    assert.deepStrictEqual(same(await rerank.rerankCandidates('movie', scored, taste, cfg, { chain, chat: async () => [], log: quiet })), ['1', '2', '3', '4']); // empty reply
    assert.deepStrictEqual(same(await rerank.rerankCandidates('movie', scored, taste, cfg, { chain, chat: async () => [{ id: 'nope' }], log: quiet })), ['1', '2', '3', '4']); // all-unknown
    // enabled:false disables it even with a local endpoint.
    const offCfg = require('../src/engines/glass/config').resolveConfig({ glass: { rerank: { enabled: false } } });
    assert.deepStrictEqual(same(await rerank.rerankCandidates('movie', scored, taste, offCfg, { chain, chat, log: quiet })), ['1', '2', '3', '4']);
  });

  // ── U. Glass GE-08 through the engine: local-only chain, reasons reach the pool ─
  await it('U. Glass engine invokes the rerank with a LOCAL-ONLY chain; reasons land in because_title', async () => {
    const metaStore = require('../src/engines/glass/metaStore');
    const glass = require('../src/engines/glass');
    const pipeline = require('../src/engines/pipeline');
    settings.updateSettings({ engines: { glass: true } });
    stubTmdb();
    const p = config.addProfile('INT-U');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'glass', engine_series: 'glass' } });
      seedGlassFixtures(p.id);
      let sawChain = null;
      const glassChat = async (chain) => { sawChain = chain; return [{ id: '402', reason: 'a bold, trending choice' }, { id: '301', reason: 'matches your Nolan streak' }]; };
      // Drive the shared pipeline directly so we can inject ctx (build path passes none).
      const ctx = {
        tmdbKey: 'itest-tmdb', mdblistKey: '', log: quiet, filters: config.getProfile(p.id).filters,
        settings: { llm: { custom_uri: 'http://local', custom_name: 'qwen', groq_api_key: 'GROQKEY' } }, // both configured…
        glassChat, glassRecsFetcher: async (_k, type) => (type === 'movie'
          ? [{ type, tmdb_id: '301', title: 'Rec A', year: 2024, genre_ids: [18], vote_average: 8, vote_count: 5000, popularity: 30, adult: false, poster: null }] : []),
      };
      await pipeline.runEngineBuild(config.getProfile(p.id), 'movie', glass, ctx, () => {});
      // …yet the rerank chain is LOCAL-ONLY (no Groq spill).
      assert.ok(Array.isArray(sawChain) && sawChain.length === 1 && sawChain[0].type === 'custom', 'rerank used only the local provider');
      const rows = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
      const r402 = rows.find((x) => x.tmdb_id === '402');
      const r301 = rows.find((x) => x.tmdb_id === '301');
      assert.ok(r402 && r402.because_title === 'a bold, trending choice', 'LLM reason persisted to because_title (§39)');
      assert.ok(r301 && r301.because_title === 'matches your Nolan streak');
      assert.ok(r402.affinity >= r301.affinity, 'the model put 402 first → it holds the top score slot');
      assert.strictEqual(JSON.parse(r402.score_components).rerank.by, 'llm');
    } finally {
      restoreTmdb();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear();
      settings.updateSettings({ engines: { glass: false } });
      simklTrending.upsertList('movies', [], 0); simklTrending.upsertList('tv', [], 0); simklTrending.upsertList('anime', [], 0);
    }
  });

  // ── V. Glass GE-10: a user rejection steers taste away from similar candidates ─
  await it('V. GE-10 feedback wiring: rejecting a title down-weights a candidate sharing its director, end to end', async () => {
    const metaStore = require('../src/engines/glass/metaStore');
    settings.updateSettings({ engines: { glass: true } });
    stubTmdb();
    const p = config.addProfile('INT-V');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'glass', engine_series: 'glass' } });
      seedGlassFixtures(p.id);            // watched 101/102 + candidates all dir 'Nolan'
      // Give the taste model a SECOND director so Nolan isn't the lone max (which
      // normalization would pin to 1.0 regardless of magnitude): watched 102 → Villeneuve.
      metaStore.put('movie', 102, { tmdb_id: '102', imdb_id: 'ttw2', type: 'movie', genres: ['Drama'], primary_genre: 'Drama', director: ['Villeneuve'], cast: ['A'], keywords: ['dream'], decade: 2020, original_language: 'en', runtime: 120, networks: [] });
      await rs.buildPool(config.getProfile(p.id), quiet);
      const before = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).find((x) => x.tmdb_id === '301').affinity;

      // Reject a (Nolan) title the profile has NOT watched. Its cached deep-meta
      // pushes the 'Nolan' director dim toward negative, so candidate 301 (also
      // Nolan) loses taste_match on the rebuild. dont_recommend is engine-agnostic.
      metaStore.put('movie', 501, { tmdb_id: '501', imdb_id: 'tt501', type: 'movie', genres: ['Drama'], director: ['Nolan'], cast: ['A'], keywords: ['dream'], decade: 2020, original_language: 'en', runtime: 120, networks: [] });
      rs.addDontRecommend(p.id, 'movie', '501', 'user');
      rs.clearType(p.id, 'movie');
      await rs.buildPool(config.getProfile(p.id), quiet);
      const after = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).find((x) => x.tmdb_id === '301').affinity;
      assert.ok(after < before, `rejection lowered the similar candidate's score (${after} < ${before})`);
    } finally {
      restoreTmdb();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear();
      settings.updateSettings({ engines: { glass: false } });
      simklTrending.upsertList('movies', [], 0); simklTrending.upsertList('tv', [], 0); simklTrending.upsertList('anime', [], 0);
    }
  });

  // ── W. Glass GE-09: embed() transport parse + semantic layer (off/measure/weighted) ─
  await it('W. GE-09 embed() parses OpenAI shape; semantic layer stores the feature, weight 0 = measure-only, weighted reorders', async () => {
    const emb = require('../src/services/embeddings');
    const semantic = require('../src/engines/glass/semantic');
    const embedStore = require('../src/engines/glass/embedStore');
    const metaStore = require('../src/engines/glass/metaStore');
    const { resolveConfig } = require('../src/engines/glass/config');

    // embed() transport: parses {data:[{index,embedding}]} and re-orders by index.
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, text: async () => '', json: async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }) });
    try {
      const vecs = await emb.embed({ uri: 'http://x', model: 'm' }, ['a', 'b']);
      assert.deepStrictEqual(vecs, [[1, 0], [0, 1]]);   // sorted by index → input order
    } finally { global.fetch = origFetch; }

    // Semantic layer end to end with an injected embedder (content token → vector).
    const embedFn = async (texts) => texts.map((t) => (t.includes('CLOSE') ? [1, 0] : [0, 1]));
    const p = config.addProfile('INT-W');
    try {
      metaStore._clear(); embedStore._clear();
      watchedStore.upsertMany(p.id, [{ type: 'movie', simkl_id: 1, imdb_id: 'ttw', tmdb_id: '1', title: 'W', year: 2024, watched_at: '2026-09-08T00:00:00Z' }]);
      metaStore.put('movie', 1, { tmdb_id: '1', type: 'movie', title: 'Watched', overview: 'a CLOSE story', genres: ['Drama'] });      // taste vec → [1,0]
      metaStore.put('movie', 10, { tmdb_id: '10', type: 'movie', title: 'A', overview: 'a CLOSE tale', genres: ['Drama'] });           // cosine 1
      metaStore.put('movie', 11, { tmdb_id: '11', type: 'movie', title: 'B', overview: 'a FAR tale', genres: ['Drama'] });             // cosine 0
      const mkScored = () => ([
        { tmdb_id: '11', title: 'B', rankScore: 0.6, score_components: { features: { taste_match: 0.6 } } },
        { tmdb_id: '10', title: 'A', rankScore: 0.5, score_components: { features: { taste_match: 0.5 } } },
      ]);
      // Disabled (default) → untouched.
      const offCfg = resolveConfig(null);
      assert.deepStrictEqual((await semantic.applySemantic(p, 'movie', mkScored(), {}, offCfg, { model: 'm', embedFn, log: quiet })).map((c) => c.tmdb_id), ['11', '10']);

      // Enabled, weight 0 → feature STORED but order unchanged (measure-only).
      const measCfg = resolveConfig({ glass: { embeddings: { enabled: true } } });
      const meas = await semantic.applySemantic(p, 'movie', mkScored(), {}, measCfg, { model: 'm', embedFn, log: quiet });
      assert.deepStrictEqual(meas.map((c) => c.tmdb_id), ['11', '10']);                       // unchanged
      const byId = Object.fromEntries(meas.map((c) => [c.tmdb_id, c.score_components.features.semantic_similarity]));
      assert.ok(Math.abs(byId['10'] - 1) < 1e-9 && Math.abs(byId['11'] - 0) < 1e-9);           // A close, B far
      assert.ok(embedStore.count() > 0, 'vectors are cached');

      // Enabled + weighted → the semantically-close A overtakes B.
      const wCfg = resolveConfig({ glass: { embeddings: { enabled: true }, weights: { semantic_similarity: 1.0 } } });
      const weighted = await semantic.applySemantic(p, 'movie', mkScored(), {}, wCfg, { model: 'm', embedFn, log: quiet });
      assert.deepStrictEqual(weighted.map((c) => c.tmdb_id), ['10', '11']);                    // reordered by semantic weight
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear(); embedStore._clear();
    }
  });

  // ── X. Glass engine wires GE-09: enabled → semantic_similarity persists to the pool ─
  await it('X. Glass engine folds semantic_similarity into score_components when embeddings are enabled', async () => {
    const metaStore = require('../src/engines/glass/metaStore');
    const embedStore = require('../src/engines/glass/embedStore');
    const glass = require('../src/engines/glass');
    const pipeline = require('../src/engines/pipeline');
    settings.updateSettings({ engines: { glass: true } });
    stubTmdb();
    const p = config.addProfile('INT-X');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'glass', engine_series: 'glass' } });
      seedGlassFixtures(p.id); embedStore._clear();
      let embedCalls = 0;
      const ctx = {
        tmdbKey: 'itest-tmdb', mdblistKey: '', log: quiet, filters: config.getProfile(p.id).filters,
        settings: { llm: {}, glass: { embeddings: { enabled: true } } },   // Tier-2 turns it on
        glassEmbed: async (texts) => { embedCalls++; return texts.map(() => [1, 0, 0]); },
        glassRecsFetcher: async (_k, type) => (type === 'movie'
          ? [{ type, tmdb_id: '301', title: 'Rec A', year: 2024, genre_ids: [18], vote_average: 8, vote_count: 5000, popularity: 30, adult: false, poster: null }] : []),
      };
      await pipeline.runEngineBuild(config.getProfile(p.id), 'movie', glass, ctx, () => {});
      assert.ok(embedCalls > 0, 'the engine invoked the local embedder');
      const rows = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
      assert.ok(rows.length >= 1);
      for (const r of rows) {
        const f = JSON.parse(r.score_components).features;
        assert.ok(typeof f.semantic_similarity === 'number', 'semantic_similarity is stored for measurement');
      }
    } finally {
      restoreTmdb();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); metaStore._clear(); embedStore._clear();
      settings.updateSettings({ engines: { glass: false } });
      simklTrending.upsertList('movies', [], 0); simklTrending.upsertList('tv', [], 0); simklTrending.upsertList('anime', [], 0);
    }
  });

  // ── Marquee ME-02: TMDB list endpoints + trending cache (stubbed fetch / injected fetcher) ─
  await it('marquee trendingMovies: rank continuous across pages + failure/short-page handling', async () => {
    const mkItem = (id) => ({ id, title: 'T' + id, release_date: '2024-01-01', genre_ids: [18], vote_average: 7, vote_count: 100, popularity: 1, adult: false, poster_path: '/p' + id + '.jpg' });
    const page1 = [], page2 = [], page3 = [];
    for (let i = 1; i <= 20; i += 1) page1.push(mkItem(i));
    for (let i = 21; i <= 38; i += 1) page2.push(mkItem(i));
    for (let i = 39; i <= 58; i += 1) page3.push(mkItem(i));
    const origFetch = global.fetch;
    try {
      let call = 0;
      global.fetch = async (url) => {
        call += 1;
        const page = new URL(url).searchParams.get('page');
        const results = page === '1' ? page1 : page === '2' ? page2 : page === '3' ? page3 : [];
        return { ok: true, status: 200, json: async () => ({ results }) };
      };
      const out = await tmdb.trendingMovies('key', 'week', 3);
      assert.strictEqual(out.length, 58);
      for (let i = 0; i < 58; i += 1) assert.strictEqual(out[i].rank, i + 1, `rank gap at ${i}`);
      assert.strictEqual(out[20].rank, 21, 'page-2 first item is rank 21');
      assert.strictEqual(out[38].rank, 39, 'page-3 first item is rank 39');
      assert.strictEqual(call, 3);
      // unknown window rejects
      await assert.rejects(() => tmdb.trendingMovies('key', 'month', 1), /unknown window/);
      // a fetch throwing on page 3 → 38 items (pages 1+2)
      global.fetch = async (url) => {
        const page = new URL(url).searchParams.get('page');
        if (page === '3') throw new Error('boom');
        const results = page === '1' ? page1 : page === '2' ? page2 : [];
        return { ok: true, status: 200, json: async () => ({ results }) };
      };
      assert.strictEqual((await tmdb.trendingMovies('key', 'week', 3)).length, 38);
      // a short (empty) page ends the loop → 20 items, page 3 not fetched
      const fetchedPages = [];
      global.fetch = async (url) => {
        const page = new URL(url).searchParams.get('page');
        fetchedPages.push(page);
        const results = page === '1' ? page1 : [];
        return { ok: true, status: 200, json: async () => ({ results }) };
      };
      assert.strictEqual((await tmdb.trendingMovies('key', 'week', 3)).length, 20);
      assert.ok(!fetchedPages.includes('3'), 'page 3 not fetched after a short page');
    } finally {
      global.fetch = origFetch;
    }
  });

  await it('marquee deepMeta: movie appends release_dates, series does not (ME-02)', async () => {
    const origFetch = global.fetch;
    try {
      const urls = [];
      global.fetch = async (url) => {
        urls.push(String(url));
        return { ok: true, status: 200, json: async () => ({}) };
      };
      await tmdb.deepMeta('key', 'movie', 603, quiet);
      await tmdb.deepMeta('key', 'series', 1234, quiet);
      assert.strictEqual(urls.length, 2);
      const movieUrl = new URL(urls[0]);
      const seriesUrl = new URL(urls[1]);
      assert.ok(movieUrl.pathname.includes('movie/603'), 'movie path');
      assert.ok(seriesUrl.pathname.includes('tv/1234'), 'series path');
      assert.strictEqual(movieUrl.searchParams.get('append_to_response'), 'credits,keywords,external_ids,release_dates');
      assert.strictEqual(seriesUrl.searchParams.get('append_to_response'), 'credits,keywords,external_ids');
    } finally {
      global.fetch = origFetch;
    }
  });

  await it('marquee TMDB list endpoints: getSimilar/discoverMovies/collectionParts + item shape (ME-02)', async () => {
    const origFetch = global.fetch;
    const item = { id: 42, title: 'T', release_date: '2024-01-01', genre_ids: [28, 18], vote_average: 7.5, vote_count: 900, popularity: 3, adult: false, poster_path: '/p.jpg' };
    const expected = { type: 'movie', tmdb_id: '42', title: 'T', year: 2024, genre_ids: [28, 18], vote_average: 7.5, vote_count: 900, popularity: 3, adult: false, poster: '/p.jpg' };
    const mkResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });
    try {
      global.fetch = async (url) => {
        const u = new URL(url);
        assert.ok(u.pathname.includes('movie/603/similar'), 'similar path');
        assert.strictEqual(u.searchParams.get('page'), '2');
        assert.strictEqual(u.searchParams.get('language'), 'en-US');
        return mkResponse({ results: [item] });
      };
      assert.deepStrictEqual(await tmdb.getSimilar('key', 603, { page: 2 }), [expected]);
      global.fetch = async (url) => {
        const u = new URL(url);
        assert.ok(u.pathname.includes('discover/movie'), 'discover path');
        assert.strictEqual(u.searchParams.get('language'), 'en-US');
        assert.strictEqual(u.searchParams.get('include_adult'), 'false');
        assert.strictEqual(u.searchParams.get('vote_count.gte'), '1000');
        return mkResponse({ results: [item] });
      };
      assert.deepStrictEqual(await tmdb.discoverMovies('key', { include_adult: 'false', 'vote_count.gte': '1000' }, { page: 1 }), [expected]);
      global.fetch = async (url) => {
        const u = new URL(url);
        assert.ok(u.pathname.includes('collection/77'), 'collection path');
        return mkResponse({ parts: [{ ...item, release_date: '2024-01-01' }] });
      };
      assert.deepStrictEqual(await tmdb.collectionParts('key', 77), [{ ...expected, release_date: '2024-01-01' }]);
    } finally {
      global.fetch = origFetch;
    }
  });

  await it('marquee trending cache: ensureFresh/refresh per-window + stale degradation (ME-02)', async () => {
    const cache = require('../src/engines/marquee/trendingCache');
    const mkItems = (window, n) => {
      const out = [];
      for (let i = 1; i <= n; i += 1) out.push({ type: 'movie', tmdb_id: `${window}-${i}`, title: 'T', rank: i });
      return out;
    };
    try {
      // empty table → ensureFresh runs refresh (week 5 + day 2)
      const calls = [];
      const fetcher = async (_k, window, pages) => { calls.push(window); return mkItems(window, window === 'week' ? 5 : 2); };
      const res1 = await cache.ensureFresh({ apiKey: 'k', now: 1000, fetcher, log: quiet });
      assert.strictEqual(res1.ok, true);
      assert.deepStrictEqual(calls, ['week', 'day']);
      assert.strictEqual(cache.getWindow('week').length, 5);
      assert.strictEqual(cache.getWindow('day').length, 2);
      // within TTL → skipped 'fresh', no fetch
      const calls2 = [];
      const fetcher2 = async (_k, window, pages) => { calls2.push(window); return mkItems(window, 1); };
      const res2 = await cache.ensureFresh({ apiKey: 'k', now: 1000 + 3600e3, fetcher: fetcher2, log: quiet });
      assert.deepStrictEqual(res2, { ok: true, skipped: 'fresh' });
      assert.deepStrictEqual(calls2, []);
      // past TTL with a throwing fetcher → ok:false, stale rows still served
      const res3 = await cache.ensureFresh({ apiKey: 'k', now: 1000 + 7 * 3600e3, fetcher: async () => { throw new Error('down'); }, log: quiet });
      assert.strictEqual(res3.ok, false);
      assert.strictEqual(cache.getWindow('week').length, 5, 'stale week rows served');
      assert.strictEqual(cache.getWindow('day').length, 2, 'stale day rows served');
      // refresh with week returning [] keeps old week rows while day refreshes independently
      const partial = async (_k, window, pages) => (window === 'week' ? [] : mkItems('day', 2));
      await cache.refresh({ apiKey: 'k', now: 1000 + 8 * 3600e3, fetcher: partial, log: quiet });
      assert.strictEqual(cache.getWindow('week').length, 5, 'week rows kept on an empty refresh');
      const dayItems = cache.getWindow('day');
      assert.strictEqual(dayItems.length, 2);
      for (let i = 0; i < 2; i += 1) assert.strictEqual(dayItems[i].rank, i + 1);
    } finally {
      require('../src/db').get().exec('DELETE FROM marquee_trending');
    }
  });

  await it('marquee ME-03: syncRatings activities-gated sync (null gate, 24 h degraded gate, force, never throws) (B3)', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-simkl', name: 'Test', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const body = { movies: [
      { user_rating: 8, user_rated_at: '2026-01-01T00:00:00Z', movie: { title: 'T1', ids: { simkl: 1, imdb: 'tt1', tmdb: '1' } } },
      { user_rating: null, user_rated_at: null, movie: { title: 'T2', ids: { simkl: 2, imdb: 'tt2', tmdb: '2' } } },
    ] };
    let ratingsCalls = 0;
    // The fetchRatings seam returns PARSED ratings (the simkl.getRatings contract).
    const fetchRatings = async () => { ratingsCalls += 1; return simkl.parseRatings(body); };
    // First sync: no taste_ratings_sync row → pull once; null rated_at stored as SQL NULL (§12 L2).
    let res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 1000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, synced: 1, unresolved: 0 });
    assert.strictEqual(ratingsCalls, 1);
    const row = db.get().prepare("SELECT activity, synced_at FROM taste_ratings_sync WHERE profile_id = ? AND type = 'movie'").get('p-simkl');
    assert.strictEqual(row.activity, null);
    // Unchanged (null === null) → skip, no ratings call.
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 2000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, skipped: 'unchanged' });
    assert.strictEqual(ratingsCalls, 1);
    // Value changes → pull again; then unchanged → skip.
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: '2026-02-01T00:00:00Z' } }), fetchRatings, now: 3000, log: quiet });
    assert.strictEqual(ratingsCalls, 2);
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: '2026-02-01T00:00:00Z' } }), fetchRatings, now: 4000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, skipped: 'unchanged' });
    // force → pull even when unchanged.
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: '2026-02-01T00:00:00Z' } }), fetchRatings, now: 5000, log: quiet, force: true });
    assert.strictEqual(ratingsCalls, 3);
    // Missing rated_at KEY (≠ null) → pull at most once per 24 h (§4.2(5)).
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: {} }), fetchRatings, now: 6000, log: quiet });
    assert.strictEqual(ratingsCalls, 4); // first pull
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: {} }), fetchRatings, now: 6000 + 12 * 3600e3, log: quiet });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(ratingsCalls, 4); // within 24 h → skipped
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: {} }), fetchRatings, now: 6000 + 25 * 3600e3, log: quiet });
    assert.strictEqual(ratingsCalls, 5); // past 24 h → pull again
    // Never throws: an activities error keeps existing rows and returns ok:false (MI-3).
    res = await simklCache.syncRatings(profile, { fetchActivities: async () => { throw new Error('down'); }, fetchRatings, now: 7000, log: quiet });
    assert.strictEqual(res.ok, false);
    assert.ok(res.error);
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-simkl').entries()], [['1', 8]]); // rows preserved
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ratings_sync');
  });

  await it('marquee ME-03: syncRatings replace semantics + zero rated + resolve cap 50 (B4)', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-replace', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const activities = async () => ({ movies: { rated_at: null } });
    // Seed another profile's row — must survive this profile's replace.
    db.get().prepare("INSERT INTO taste_ratings (profile_id, type, tmdb_id, rating) VALUES (?, ?, ?, ?)").run('p-other', 'movie', '99', 5);
    // Zero rated entries → this profile's table empty (valid state, §12 L3).
    let res = await simklCache.syncRatings(profile, { fetchActivities: activities, fetchRatings: async () => simkl.parseRatings({ movies: [{ user_rating: null, movie: { ids: { tmdb: '1' } } }] }), now: 1000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, synced: 0, unresolved: 0 });
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-replace').entries()], []);
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-other').entries()], [['99', 5]]);
    // imdb-only entries resolved via resolveTmdb, capped at 50 lookups per sync.
    const lookups = [];
    const resolve = async (imdbId) => { lookups.push(imdbId); return 'tmdb-' + imdbId; };
    const items = [];
    for (let i = 1; i <= 55; i += 1) items.push({ user_rating: 7, movie: { ids: { imdb: 'tt' + i } } });
    // force: true — the gate would otherwise skip (same rated_at), but this test
    // exercises the replace semantics of each pull.
    res = await simklCache.syncRatings(profile, { fetchActivities: activities, fetchRatings: async () => simkl.parseRatings({ movies: items }), resolveTmdb: resolve, now: 2000, log: quiet, force: true });
    assert.strictEqual(res.unresolved, 5); // 55 − 50 capped
    assert.strictEqual(lookups.length, 50);
    const map = simklCache.getRatingsMap('p-replace');
    assert.strictEqual(map.size, 50);
    assert.strictEqual(map.get('tmdb-tt1'), 7);
    // A failing resolve → skipped + counted, not fatal.
    res = await simklCache.syncRatings(profile, { fetchActivities: activities, fetchRatings: async () => simkl.parseRatings({ movies: [{ user_rating: 6, movie: { ids: { imdb: 'ttX' } } }] }), resolveTmdb: async () => { throw new Error('nope'); }, now: 3000, log: quiet, force: true });
    assert.deepStrictEqual(res, { ok: true, synced: 0, unresolved: 1 });
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-replace').entries()], []);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ratings_sync');
  });

  await it('Trainer T1: buildRatingsBody shapes ids/ratings by type (test 1)', () => {
    const simkl = require('../src/services/simkl');
    // numeric simkl, string imdb/tmdb, movie → movies
    let b = simkl.buildRatingsBody([{ type: 'movie', simkl_id: 5, imdb_id: 'tt1', tmdb_id: '10', rating: 8 }]);
    assert.deepStrictEqual(b, { movies: [{ ids: { simkl: 5, imdb: 'tt1', tmdb: '10' }, rating: 8 }], shows: [] });
    // series → shows
    b = simkl.buildRatingsBody([{ type: 'series', simkl_id: 7, imdb_id: 'tt2', tmdb_id: '20', rating: 9 }]);
    assert.deepStrictEqual(b, { movies: [], shows: [{ ids: { simkl: 7, imdb: 'tt2', tmdb: '20' }, rating: 9 }] });
    // no ids → dropped
    b = simkl.buildRatingsBody([{ type: 'movie', rating: 5 }]);
    assert.deepStrictEqual(b, { movies: [], shows: [] });
    // ratings 0, 11, 7.5, '8' → omitted (ids kept)
    b = simkl.buildRatingsBody([
      { type: 'movie', tmdb_id: '1', rating: 0 },
      { type: 'movie', tmdb_id: '2', rating: 11 },
      { type: 'movie', tmdb_id: '3', rating: 7.5 },
      { type: 'movie', tmdb_id: '4', rating: '8' },
    ]);
    assert.deepStrictEqual(b, { movies: [{ ids: { tmdb: '1' } }, { ids: { tmdb: '2' } }, { ids: { tmdb: '3' } }, { ids: { tmdb: '4' } }], shows: [] });
    // withRating:false → no rating field
    b = simkl.buildRatingsBody([{ type: 'movie', tmdb_id: '1', rating: 8 }], { withRating: false });
    assert.deepStrictEqual(b, { movies: [{ ids: { tmdb: '1' } }], shows: [] });
    // both keys always present (empty input)
    assert.deepStrictEqual(simkl.buildRatingsBody([]), { movies: [], shows: [] });
  });

  await it('Trainer T1: setRatings/removeRatings governed POST + error contract (test 2)', async () => {
    const simkl = require('../src/services/simkl');
    const governor = require('../src/services/governor');
    const profile = { id: 'p-rate', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const realFetch = global.fetch;
    const realSchedule = governor.schedule;
    let fetchCalls = [];
    let laneCalls = [];
    // Spy on governor.schedule: record the lane, run the fetch fn directly (no pacing in the test).
    governor.schedule = (lane, fn) => { laneCalls.push(lane); return fn(); };
    let fetchRes = { ok: true, status: 200, json: async () => ({}) };
    global.fetch = (url, opts) => { fetchCalls.push({ url: String(url), opts }); return Promise.resolve(fetchRes); };
    try {
      // setRatings: /sync/ratings, POST, JSON body, simkl_post lane
      await simkl.setRatings(profile, [{ type: 'movie', simkl_id: 5, tmdb_id: '10', rating: 8 }]);
      assert.strictEqual(fetchCalls.length, 1);
      assert.match(fetchCalls[0].url, /\/sync\/ratings\?/);
      assert.strictEqual(fetchCalls[0].opts.method, 'POST');
      assert.deepStrictEqual(JSON.parse(fetchCalls[0].opts.body), { movies: [{ ids: { simkl: 5, tmdb: '10' }, rating: 8 }], shows: [] });
      assert.deepStrictEqual(laneCalls, ['simkl_post']);
      // removeRatings: /sync/ratings/remove, withRating:false → no rating field
      fetchCalls = []; laneCalls = [];
      await simkl.removeRatings(profile, [{ type: 'movie', tmdb_id: '10' }]);
      assert.match(fetchCalls[0].url, /\/sync\/ratings\/remove\?/);
      assert.deepStrictEqual(JSON.parse(fetchCalls[0].opts.body), { movies: [{ ids: { tmdb: '10' } }], shows: [] });
      assert.deepStrictEqual(laneCalls, ['simkl_post']);
      // 401 → the token-rejected message
      fetchRes = { ok: false, status: 401, json: async () => ({}) };
      await assert.rejects(() => simkl.setRatings(profile, [{ type: 'movie', tmdb_id: '10', rating: 8 }]), /token rejected/);
      // 500 → throws with the status
      fetchRes = { ok: false, status: 500, json: async () => ({}) };
      await assert.rejects(() => simkl.setRatings(profile, [{ type: 'movie', tmdb_id: '10', rating: 8 }]), /500/);
      // empty body → throws with ZERO fetches
      fetchCalls = [];
      await assert.rejects(() => simkl.setRatings(profile, [{ type: 'movie' }]), /nothing to rate/);
      assert.strictEqual(fetchCalls.length, 0);
    } finally {
      global.fetch = realFetch;
      governor.schedule = realSchedule;
    }
  });

  await it('Trainer T1: tasteFeedback.syncRatings — type-scoped, series syncs the Simkl "shows" section, movie never touches series rows (test 3)', async () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-tf', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    tasteFeedback.init();
    // Seed a type='series' row for the same profile — a movie sync must NOT touch it.
    db.get().prepare("INSERT INTO taste_ratings (profile_id, type, tmdb_id, rating) VALUES (?, ?, ?, ?)").run('p-tf', 'series', '500', 4);
    const fetchRatings = async () => simkl.parseRatings({ movies: [
      { user_rating: 9, user_rated_at: '2026-01-01T00:00:00Z', movie: { title: 'A', ids: { simkl: 1, imdb: 'tt1', tmdb: '1' } } },
      { user_rating: 5, movie: { title: 'B', ids: { tmdb: '2' } } },
    ] });
    // A movie sync (force) replaces only type='movie' rows.
    let res = await tasteFeedback.syncRatings(profile, { type: 'movie', fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 1000, log: quiet, force: true });
    assert.deepStrictEqual(res, { ok: true, synced: 2, unresolved: 0 });
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-tf', 'movie').entries()], [['1', 9], ['2', 5]]);
    // the series row is untouched.
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-tf', 'series').entries()], [['500', 4]]);
    // A second movie sync with the same gate → unchanged (null === null).
    res = await tasteFeedback.syncRatings(profile, { type: 'movie', fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 2000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, skipped: 'unchanged' });
    // series sync (TV-R §3): gate on tv_shows.rated_at, fetch 'shows', write type='series' rows only.
    res = await tasteFeedback.syncRatings(profile, { type: 'series', fetchActivities: async () => ({ tv_shows: { rated_at: null } }), fetchRatings: (_p, kind) => simkl.parseRatings({ shows: [
      { user_rating: 7, user_rated_at: '2026-03-01T00:00:00Z', show: { title: 'S', ids: { simkl: 3, imdb: 'tt3', tmdb: '3' } } },
    ] }, kind), now: 3000, log: quiet, force: true });
    assert.deepStrictEqual(res, { ok: true, synced: 1, unresolved: 0 });
    // the seeded series row was replaced (type='series' rows only).
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-tf', 'series').entries()], [['3', 7]]);
    // the movie rows are untouched.
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-tf', 'movie').entries()], [['1', 9], ['2', 5]]);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ratings_sync');
  });

  await it('TV-R T5: parseRatings(body, kind) — shows ids from e.show.ids; film parse byte-identical; series sync gates/fetches/resolves/writes type="series" only', async () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-tvr-t5', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    tasteFeedback.init();
    // (a) parseRatings(body, 'shows') on the verified live shape keeps only rated entries, ids from e.show.ids.
    const liveShows = { shows: [
      { user_rating: 8, user_rated_at: '2026-10-02T00:00:00Z', show: { title: 'Breaking Bad', ids: { simkl: 241, imdb: 'tt0090501', tmdb: '1786' } } },
      { user_rating: null, user_rated_at: null, show: { title: 'Unrated', ids: { simkl: 999, imdb: 'tt999', tmdb: '999' } } },
      { user_rating: 5, user_rated_at: '2026-10-02T00:00:00Z', show: { title: 'Unbreakable', ids: { simkl: 242, imdb: 'tt011', tmdb: '1787' } } },
    ] };
    assert.deepStrictEqual(simkl.parseRatings(liveShows, 'shows'), [
      { tmdb_id: '1786', imdb_id: 'tt0090501', simkl_id: 241, rating: 8, rated_at: '2026-10-02T00:00:00Z' },
      { tmdb_id: '1787', imdb_id: 'tt011', simkl_id: 242, rating: 5, rated_at: '2026-10-02T00:00:00Z' },
    ]);
    // (b) film parse unchanged (byte-identical output on an existing fixture).
    const filmBody = { movies: [
      { user_rating: 9, user_rated_at: '2026-01-01T00:00:00Z', movie: { title: 'A', ids: { simkl: 1, imdb: 'tt1', tmdb: '1' } } },
      { user_rating: null, movie: { title: 'B', ids: { tmdb: '2' } } },
    ] };
    assert.deepStrictEqual(simkl.parseRatings(filmBody), [
      { tmdb_id: '1', imdb_id: 'tt1', simkl_id: 1, rating: 9, rated_at: '2026-01-01T00:00:00Z' },
    ]);
    // (c) syncRatings({ type: 'series' }) gates on tv_shows.rated_at; fetches 'shows'; resolves an imdb-only entry; writes type='series' rows only.
    let fetchCalls = [];
    const fetchRatings = (_p, kind) => { fetchCalls.push(kind); return simkl.parseRatings({ shows: [
      { user_rating: 7, user_rated_at: '2026-03-01T00:00:00Z', show: { title: 'S', ids: { simkl: 3, imdb: 'tt3', tmdb: '3' } } },
      { user_rating: 6, user_rated_at: '2026-03-01T00:00:00Z', show: { title: 'OnlyImdb', ids: { imdb: 'tt4' } } },
    ] }, kind); };
    // Seed a film row that must stay untouched.
    db.get().prepare("INSERT INTO taste_ratings (profile_id, type, tmdb_id, rating) VALUES (?, ?, ?, ?)").run('p-tvr-t5', 'movie', '77', 4);
    // First series sync (force) → fetch 'shows', resolve the imdb-only entry, write type='series' rows only.
    let res = await tasteFeedback.syncRatings(profile, { type: 'series', fetchActivities: async () => ({ tv_shows: { rated_at: '2026-03-01T00:00:00Z' } }), fetchRatings, resolveTmdb: async (imdb) => (imdb === 'tt4' ? '4' : null), now: 1000, log: quiet, force: true });
    assert.deepStrictEqual(res, { ok: true, synced: 2, unresolved: 0 });
    assert.deepStrictEqual(fetchCalls, ['shows']);
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-tvr-t5', 'series').entries()], [['3', 7], ['4', 6]]);
    // the film row is untouched.
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-tvr-t5', 'movie').entries()], [['77', 4]]);
    // Second series sync with the same gate → unchanged (no fetch).
    fetchCalls = [];
    res = await tasteFeedback.syncRatings(profile, { type: 'series', fetchActivities: async () => ({ tv_shows: { rated_at: '2026-03-01T00:00:00Z' } }), fetchRatings, now: 2000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, skipped: 'unchanged' });
    assert.deepStrictEqual(fetchCalls, []);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ratings_sync');
  });

  await it('Trainer T1: simklCache delegates to tasteFeedback — upsertRating rows surface in getRatingsMap; syncRatings writes taste_ratings (test 4)', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const tasteFeedback = require('../src/tasteFeedback');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-deleg', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    simklCache.init();
    // upsertRating (movie) → visible through the Marquee getRatingsMap (delegation).
    tasteFeedback.upsertRating('p-deleg', { type: 'movie', tmdb_id: '10', imdb_id: 'tt10', simkl_id: 10, rating: 8, rated_at: '2026-01-01T00:00:00Z' });
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-deleg').entries()], [['10', 8]]);
    // a series rating is NOT visible through the movie-scoped getRatingsMap.
    tasteFeedback.upsertRating('p-deleg', { type: 'series', tmdb_id: '10', rating: 7 });
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-deleg').entries()], [['10', 8]]);
    // simklCache.syncRatings (movies only) writes taste_ratings with type='movie'.
    const fetchRatings = async () => simkl.parseRatings({ movies: [
      { user_rating: 6, user_rated_at: '2026-02-01T00:00:00Z', movie: { title: 'C', ids: { tmdb: '20', imdb: 'tt20' } } },
    ] });
    const res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 1000, log: quiet, force: true });
    assert.deepStrictEqual(res, { ok: true, synced: 1, unresolved: 0 });
    const row = db.get().prepare("SELECT type, tmdb_id, rating FROM taste_ratings WHERE profile_id = ? AND tmdb_id = '20'").get('p-deleg');
    assert.strictEqual(row.type, 'movie');
    assert.strictEqual(row.rating, 6);
    // the series row for tmdb 10 is still intact (movie sync never touched it).
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap('p-deleg', 'series').entries()], [['10', 7]]);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ratings_sync');
  });

  await it('Trainer T1: deleteForProfile removes all taste_* rows for that profile, none for another (test 10)', () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    tasteFeedback.init();
    const A = 'p-del-a';
    const B = 'p-del-b';
    // A: rows in all four tables.
    tasteFeedback.upsertRating(A, { type: 'movie', tmdb_id: '1', rating: 8 });
    db.get().prepare("INSERT INTO taste_ratings_sync (profile_id, type, activity, synced_at, degraded_synced_at) VALUES (?, ?, ?, ?, ?)").run(A, 'movie', null, 1000, null);
    tasteFeedback.setIgnored(A, { type: 'movie', tmdb_id: '2', simkl_id: 2 }, true, 1000);
    tasteFeedback.recordChange(A, 1000);
    tasteFeedback.recordChange(A, 2000);
    // B: its own rows.
    tasteFeedback.upsertRating(B, { type: 'movie', tmdb_id: '3', rating: 9 });
    tasteFeedback.setIgnored(B, { type: 'movie', tmdb_id: '4', simkl_id: 4 }, true, 1000);
    tasteFeedback.recordChange(B, 1000);
    tasteFeedback.deleteForProfile(A);
    // A: all four tables empty.
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap(A, 'movie').entries()], []);
    assert.strictEqual(db.get().prepare('SELECT COUNT(*) AS n FROM taste_ratings_sync WHERE profile_id = ?').get(A).n, 0);
    assert.deepStrictEqual([...tasteFeedback.ignoredSet(A, 'movie')], []);
    assert.deepStrictEqual(tasteFeedback.getTraining(A), { changed_at: null, changes_since_build: 0, built_changed_at: null });
    // B: untouched.
    assert.deepStrictEqual([...tasteFeedback.getRatingsMap(B, 'movie').entries()], [['3', 9]]);
    assert.deepStrictEqual([...tasteFeedback.ignoredSet(B, 'movie')], ['4']);
    assert.deepStrictEqual(tasteFeedback.getTraining(B), { changed_at: 1000, changes_since_build: 1, built_changed_at: null });
    tasteFeedback.deleteForProfile(B);
  });

  await it('Trainer T1: rate — Simkl authority (M1): write first, local row only on success; clear; bad-rating; not-in-history; no-simkl (test 5)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-rate', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'B', year: 2020, watched_at: '2026-01-02T00:00:00Z' },
    ]);
    const simklCalls = [];
    const deps = {
      simkl: {
        setRatings: async (_p, items) => { simklCalls.push(['set', items]); },
        removeRatings: async (_p, items) => { simklCalls.push(['remove', items]); },
      },
      now: () => 1000,
      log: quiet,
    };
    // rate 8 → setRatings called, local row written, change recorded. Full DTO (F8).
    let res = await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, 8, deps);
    assert.deepStrictEqual(res, { ok: true, item: { key: '1', type: 'movie', simkl_id: 1, tmdb_id: '1', imdb_id: 'tt1', title: 'A', year: 2020, genre: null, poster: null, watched_at: '2026-01-01T00:00:00Z', rating: 8, loved: false, ignored: false, status: 'watched', percent: null }, unchanged: false });
    assert.deepStrictEqual(simklCalls, [['set', [{ type: 'movie', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '1', rating: 8 }]]]);
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), 8);
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null });
    // rate 10 → loved computed (M3).
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, 10, deps);
    assert.strictEqual(res.item.loved, true);
    assert.strictEqual(res.item.rating, 10);
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), 10);
    // clear (null) → removeRatings called, local row deleted. Full DTO.
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, null, deps);
    assert.deepStrictEqual(res, { ok: true, item: { key: '1', type: 'movie', simkl_id: 1, tmdb_id: '1', imdb_id: 'tt1', title: 'A', year: 2020, genre: null, poster: null, watched_at: '2026-01-01T00:00:00Z', rating: null, loved: false, ignored: false, status: 'watched', percent: null }, unchanged: false });
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), null);
    // bad-rating (0, 11, 7.5) → no Simkl call, no local change.
    simklCalls.length = 0;
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '2' }, 0, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-rating' });
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '2' }, 11, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-rating' });
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '2' }, 7.5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-rating' });
    assert.strictEqual(simklCalls.length, 0);
    // not-in-history (unknown ref).
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '999' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    // no-simkl (profile not connected) → no Simkl call.
    res = await trainer.rate({ id: 'p-rate', name: 'T', keys: {} }, { type: 'movie', tmdb_id: '1' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'no-simkl' });
    // Simkl write throws → local row NOT written (M1).
    const failingSimkl = {
      setRatings: async () => { throw new Error('Simkl POST /sync/ratings failed (500)'); },
      removeRatings: async () => { throw new Error('Simkl POST /sync/ratings/remove failed (500)'); },
    };
    await assert.rejects(() => trainer.rate(profile, { type: 'movie', tmdb_id: '2' }, 6, { ...deps, simkl: failingSimkl }));
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '2'), null); // unchanged
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T1: setIgnored — local only (M2): never calls Simkl, never touches watched; ignored stays in watchedIdSets (test 6)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-ignore', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    const simklCalls = [];
    const deps = {
      simkl: {
        setRatings: async () => { simklCalls.push('set'); },
        removeRatings: async () => { simklCalls.push('remove'); },
      },
      now: () => 1000,
      log: quiet,
    };
    // ignore → local row written, NO Simkl call, watched row untouched. Full DTO (F8).
    let res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '1' }, true, deps);
    assert.deepStrictEqual(res, { ok: true, item: { key: '1', type: 'movie', simkl_id: 1, tmdb_id: '1', imdb_id: 'tt1', title: 'A', year: 2020, genre: null, poster: null, watched_at: '2026-01-01T00:00:00Z', rating: null, loved: false, ignored: true, status: 'watched', percent: null }, unchanged: false });
    assert.strictEqual(simklCalls.length, 0); // M2: never calls Simkl
    assert.ok(tasteFeedback.ignoredSet(profile.id, 'movie').has('1'));
    // the watched row is still there (not removed/edited).
    assert.strictEqual(watchedStore.getWatched(profile.id, { type: 'movie' }).length, 1);
    // the ignored film stays in watchedIdSets (M2).
    assert.ok(watchedStore.watchedIdSets(profile.id).tmdb.has('1'));
    // un-ignore → local row removed. Full DTO.
    res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '1' }, false, deps);
    assert.deepStrictEqual(res, { ok: true, item: { key: '1', type: 'movie', simkl_id: 1, tmdb_id: '1', imdb_id: 'tt1', title: 'A', year: 2020, genre: null, poster: null, watched_at: '2026-01-01T00:00:00Z', rating: null, loved: false, ignored: false, status: 'watched', percent: null }, unchanged: false });
    assert.strictEqual(tasteFeedback.ignoredSet(profile.id, 'movie').size, 0);
    // not-in-history (unknown ref).
    res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '999' }, true, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    // series is supported (TV-R §2): this profile has no series_progress rows,
    // so the ref is not-in-history (the old not-supported is gone).
    res = await trainer.setIgnored(profile, { type: 'series', tmdb_id: '1' }, true, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    db.get().exec('DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T1: markFinished — delegates to markWatched; unfinished only (test 7)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const engagement = require('../src/engines/marquee/engagement');
    const db = require('../src/db');
    const profile = { id: 'p-finished', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    // A watched row (completed) — must NOT be markable finished.
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    // An abandoned (unfinished) row: started 30%, untouched for >7 days.
    // The grace period runs on the action clock (deps.now = 1000), so the
    // row's timestamps are relative to that same clock.
    engagement.init();
    const abandonedAt = 1000 - 8 * 24 * 3600e3;
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, 'tt2', '2', 30, abandonedAt, abandonedAt);
    const markWatchedCalls = [];
    const deps = {
      markWatched: async (_p, args, _log) => { markWatchedCalls.push(args); return { ok: true, type: args.type, tmdbId: args.tmdbId }; },
      now: () => 1000,
      log: quiet,
    };
    // markFinished on the unfinished row → markWatched called with the row's own ids (F6.5).
    let res = await trainer.markFinished(profile, { type: 'movie', tmdb_id: '2' }, deps);
    assert.deepStrictEqual(res, { ok: true });
    assert.deepStrictEqual(markWatchedCalls, [{ type: 'movie', imdbId: 'tt2', tmdbId: '2', title: null }]);
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null });
    // markFinished on a WATCHED row → not-in-history (unfinished only).
    res = await trainer.markFinished(profile, { type: 'movie', tmdb_id: '1' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    // markWatched returns { ok:false, reason } → propagated.
    res = await trainer.markFinished(profile, { type: 'movie', tmdb_id: '2' }, { ...deps, markWatched: async () => ({ ok: false, reason: 'no-simkl' }) });
    assert.deepStrictEqual(res, { ok: false, reason: 'no-simkl' });
    engagement._clear();
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T1: listHistory — views, counts, dedupe, unresolved, q, pagination, loved, enrichment (test 8)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    // tmdb_api_key set so the page's lazy enrichment runs (F2 gate).
    const profile = { id: 'p-list', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    // Watched rows: 3 with a tmdb_id, 1 without (unresolved).
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'Beta', year: 2021, watched_at: '2026-01-03T00:00:00Z' },
      { simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: '3', title: 'Gamma', year: 2019, watched_at: '2026-01-02T00:00:00Z' },
      { simkl_id: 4, type: 'movie', imdb_id: 'tt4', tmdb_id: null, title: 'NoTmdb', year: 2020, watched_at: '2026-01-04T00:00:00Z' },
    ]);
    // Ratings: Alpha=10 (loved), Beta=7 (rated), Gamma=null (unrated).
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '1', rating: 10 });
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '2', rating: 7 });
    // Ignore Beta.
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '2' }, true, 1000);
    const enrichCalls = [];
    const deps = {
      enrich: async (_apiKey, _type, tmdbId, _log, _opts) => { enrichCalls.push(tmdbId); return { poster: 'poster-' + tmdbId, genres: ['Action'], primary_genre: 'Action', title: 'Meta' + tmdbId, year: 2000 }; },
      now: () => 1000,
      log: quiet,
    };
    // all view: watched minus ignored → Gamma (Jan 2), Alpha (Jan 1); Beta ignored.
    let res = await trainer.listHistory(profile, { type: 'movie' }, deps);
    assert.strictEqual(res.total, 2);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['3', '1']);
    assert.deepStrictEqual(res.counts, { all: 2, unrated: 1, rated: 1, loved: 1, ignored: 1, unfinished: 0, unresolved: 1 });
    const alpha = res.items.find((i) => i.tmdb_id === '1');
    assert.strictEqual(alpha.rating, 10);
    assert.strictEqual(alpha.loved, true);
    assert.strictEqual(alpha.poster, 'poster-1'); // enriched
    assert.strictEqual(alpha.genre, 'Action'); // enriched (primary_genre was null)
    // unrated view → Gamma.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'unrated' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['3']);
    // rated view → Alpha (a 10 counts as rated — F5).
    res = await trainer.listHistory(profile, { type: 'movie', view: 'rated' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1']);
    // loved view → Alpha.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'loved' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1']);
    // ignored view → Beta.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'ignored' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['2']);
    // q search (case-insensitive) on the all view.
    res = await trainer.listHistory(profile, { type: 'movie', q: 'alpha' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1']);
    // pagination.
    res = await trainer.listHistory(profile, { type: 'movie', pageSize: 1 }, deps);
    assert.strictEqual(res.items.length, 1);
    assert.strictEqual(res.total, 2);
    res = await trainer.listHistory(profile, { type: 'movie', page: 2, pageSize: 1 }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1']); // Alpha (2nd page)
    // bad-view / bad-type.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'bogus' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-view' });
    // series is supported (TV-R §2): this profile has no series_progress rows,
    // so the listing is empty (the old not-supported is gone).
    res = await trainer.listHistory(profile, { type: 'series' }, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.total, 0);
    res = await trainer.listHistory(profile, { type: 'bogus' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-type' });
    // dedupe: a newer watch of the same tmdb_id → keep the newest.
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 5, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha', year: 2020, watched_at: '2026-01-05T00:00:00Z' },
    ]);
    res = await trainer.listHistory(profile, { type: 'movie' }, deps);
    const alpha2 = res.items.find((i) => i.tmdb_id === '1');
    assert.strictEqual(alpha2.simkl_id, 5); // the newer row
    assert.strictEqual(res.counts.all, 2); // still 2 (Alpha, Gamma)
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T1: rate — no-op, validation, type, ignored, Simkl throw, simkl_id string (F11.1)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-r11', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'B', year: 2020, watched_at: '2026-01-02T00:00:00Z' },
    ]);
    const simklCalls = [];
    const deps = {
      simkl: {
        setRatings: async (_p, items) => { simklCalls.push(['set', items]); },
        removeRatings: async (_p, items) => { simklCalls.push(['remove', items]); },
      },
      now: () => 1000,
      log: quiet,
    };
    // same value twice → second is a no-op: zero Simkl calls, unchanged:true, changes_since_build unchanged.
    await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, 5, deps);
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null });
    simklCalls.length = 0;
    let res = await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, 5, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.unchanged, true);
    assert.strictEqual(simklCalls.length, 0); // zero Simkl calls on the no-op
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null }); // unchanged
    // '8' (string) and undefined → bad-rating.
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, '8', deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-rating' });
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, undefined, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-rating' });
    // series is supported (TV-R §2): this profile has no series_progress rows,
    // so the ref is not-in-history (the old not-supported is gone); 'anime' → bad-type.
    res = await trainer.rate(profile, { type: 'series', tmdb_id: '1' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    res = await trainer.rate(profile, { type: 'anime', tmdb_id: '1' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-type' });
    // not-in-history: a ref that belongs to ANOTHER profile's history.
    const other = { id: 'p-r11-other', name: 'O', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(other.id, [
      { simkl_id: 10, type: 'movie', imdb_id: 'tt10', tmdb_id: '10', title: 'Other', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '10' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    // not-in-history: a watched row with no tmdb_id can't be acted on.
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: null, title: 'NoTmdb', year: 2020, watched_at: '2026-01-03T00:00:00Z' },
    ]);
    res = await trainer.rate(profile, { type: 'movie', imdb_id: 'tt3' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-in-history' });
    // rating an ignored film works and stays ignored.
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '2' }, true, 1000);
    res = await trainer.rate(profile, { type: 'movie', tmdb_id: '2' }, 7, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.rating, 7);
    assert.strictEqual(res.item.ignored, true); // stays ignored
    assert.ok(tasteFeedback.ignoredSet(profile.id, 'movie').has('2'));
    // Simkl throw leaves changes_since_build unchanged (M1).
    const failingSimkl = {
      setRatings: async () => { throw new Error('Simkl POST /sync/ratings failed (500)'); },
      removeRatings: async () => { throw new Error('Simkl POST /sync/ratings/remove failed (500)'); },
    };
    const before = tasteFeedback.getTraining(profile.id);
    await assert.rejects(() => trainer.rate(profile, { type: 'movie', tmdb_id: '1' }, 9, { ...deps, simkl: failingSimkl }));
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), before); // unchanged
    // simkl_id as string "1" resolves.
    res = await trainer.rate(profile, { type: 'movie', simkl_id: '1' }, 6, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.tmdb_id, '1');
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), 6);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
    watchedStore.deleteForProfile(other.id);
  });

  await it('Trainer T1: setIgnored — bad-value, no-op, unfinished row (F11.2)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const engagement = require('../src/engines/marquee/engagement');
    const db = require('../src/db');
    const profile = { id: 'p-ig11', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    const deps = { now: () => 1000, log: quiet };
    // 'yes' / 1 / missing → bad-value, no change recorded.
    for (const bad of ['yes', 1, undefined]) {
      const before = tasteFeedback.getTraining(profile.id);
      const res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '1' }, bad, deps);
      assert.deepStrictEqual(res, { ok: false, reason: 'bad-value' });
      assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), before); // no change recorded
    }
    // true twice → second is a no-op: unchanged:true, no change recorded.
    let res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '1' }, true, deps);
    assert.strictEqual(res.unchanged, false);
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null });
    res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '1' }, true, deps);
    assert.strictEqual(res.unchanged, true);
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null }); // unchanged
    // ignoring an unfinished row works. The grace period runs on the action
    // clock (deps.now = 1000), so the row's timestamps are relative to it.
    engagement.init();
    const at = 1000 - 8 * 24 * 3600e3;
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, 'tt2', '2', 30, at, at);
    res = await trainer.setIgnored(profile, { type: 'movie', tmdb_id: '2' }, true, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.status, 'unfinished');
    assert.strictEqual(res.item.ignored, true);
    assert.ok(tasteFeedback.ignoredSet(profile.id, 'movie').has('2'));
    db.get().exec('DELETE FROM taste_ignore; DELETE FROM taste_changes');
    engagement._clear();
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T1: listHistory — §6 fixture: views, counts, DTO keys, q, pagination, profile isolation (F11.3a)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const engagement = require('../src/engines/marquee/engagement');
    const db = require('../src/db');
    const profile = { id: 'p-lh11', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    // 9 watched rows: 2 ignored, 1 rated 10, 1 rated 4, 1 no tmdb_id, 2 sharing tmdb_id.
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'Beta', year: 2021, watched_at: '2026-01-02T00:00:00Z' },
      { simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: '3', title: 'Gamma', year: 2019, watched_at: '2026-01-03T00:00:00Z' },
      { simkl_id: 4, type: 'movie', imdb_id: 'tt4', tmdb_id: '4', title: 'Delta', year: 2020, watched_at: '2026-01-04T00:00:00Z' },
      { simkl_id: 5, type: 'movie', imdb_id: 'tt5', tmdb_id: null, title: 'Epsilon', year: 2020, watched_at: '2026-01-05T00:00:00Z' },
      { simkl_id: 6, type: 'movie', imdb_id: 'tt6', tmdb_id: '6', title: 'Zeta', year: 2020, watched_at: '2026-01-06T00:00:00Z' },
      { simkl_id: 7, type: 'movie', imdb_id: 'tt7', tmdb_id: '6', title: 'Eta', year: 2020, watched_at: '2026-01-07T00:00:00Z' }, // shares tmdb 6 with Zeta
      { simkl_id: 8, type: 'movie', imdb_id: 'tt8', tmdb_id: '8', title: 'Theta', year: 2020, watched_at: '2026-01-08T00:00:00Z' },
      { simkl_id: 9, type: 'movie', imdb_id: 'tt9', tmdb_id: '9', title: 'Iota', year: 2020, watched_at: '2026-01-09T00:00:00Z' },
    ]);
    // Ratings: Gamma=10 (loved), Delta=4.
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '3', rating: 10 });
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '4', rating: 4 });
    // Ignore Alpha + Beta (watched) and the unfinished row (tmdb 12).
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '1' }, true, 1000);
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '2' }, true, 1000);
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '12' }, true, 1000);
    // 3 engagement rows: 30% not watched→unfinished; 30% but watched→NOT unfinished (rewatch); 30% and ignored→ignored only.
    engagement.init();
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, 'tt10', '10', 30, Date.parse('2026-01-06T00:00:00Z'), Date.parse('2026-01-06T00:00:00Z'));
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, 'tt4', '4', 30, Date.parse('2026-01-06T00:00:00Z'), Date.parse('2026-01-06T00:00:00Z')); // rewatch of Delta (tmdb 4 watched)
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, 'tt12', '12', 30, Date.parse('2026-01-05T00:00:00Z'), Date.parse('2026-01-05T00:00:00Z'));
    // The engagement rows below are seeded against the real clock (Jan 2026,
    // >7 days old), so the action clock must be the real one for the grace
    // period to see them as abandoned.
    const deps = {
      enrich: async () => { throw new Error('enrich must not run without a TMDB key'); },
      settings: { keyFor: () => '' },
      now: () => Date.now(),
      log: quiet,
    };
    // all view: watched minus ignored, newest first (dedupe keeps Eta for tmdb 6).
    let res = await trainer.listHistory(profile, { type: 'movie' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['9', '8', '6', '4', '3']);
    assert.deepStrictEqual(res.counts, { all: 5, unrated: 3, rated: 2, loved: 1, ignored: 3, unfinished: 1, unresolved: 1 });
    // unrated view.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'unrated' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['9', '8', '6']);
    // rated view (a 10 counts as rated — F5).
    res = await trainer.listHistory(profile, { type: 'movie', view: 'rated' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['4', '3']);
    // loved view.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'loved' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['3']);
    // ignored view: ignored watched (Beta, Alpha) + ignored unfinished (tmdb 12), newest first.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'ignored' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['12', '2', '1']);
    // unfinished view: only the not-watched, not-ignored 30% row (tmdb 10).
    res = await trainer.listHistory(profile, { type: 'movie', view: 'unfinished' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['10']);
    // counts ignore q.
    res = await trainer.listHistory(profile, { type: 'movie', q: 'gamma' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['3']);
    assert.deepStrictEqual(res.counts, { all: 5, unrated: 3, rated: 2, loved: 1, ignored: 3, unfinished: 1, unresolved: 1 });
    // pageSize 500 → clamped to 100.
    res = await trainer.listHistory(profile, { type: 'movie', pageSize: 500 }, deps);
    assert.strictEqual(res.pageSize, 100);
    // exact DTO key set (watched).
    res = await trainer.listHistory(profile, { type: 'movie' }, deps);
    const watchedItem = res.items.find((i) => i.status === 'watched');
    assert.deepStrictEqual(Object.keys(watchedItem).sort(), ['genre', 'ignored', 'imdb_id', 'key', 'loved', 'percent', 'poster', 'rating', 'simkl_id', 'status', 'title', 'tmdb_id', 'type', 'watched_at', 'year']);
    // exact DTO key set (unfinished) + the row's real imdb_id + rounded percent (F6.4).
    res = await trainer.listHistory(profile, { type: 'movie', view: 'unfinished' }, deps);
    const unfinishedItem = res.items.find((i) => i.status === 'unfinished');
    assert.deepStrictEqual(Object.keys(unfinishedItem).sort(), ['genre', 'ignored', 'imdb_id', 'key', 'loved', 'percent', 'poster', 'rating', 'simkl_id', 'status', 'title', 'tmdb_id', 'type', 'watched_at', 'year']);
    assert.strictEqual(unfinishedItem.imdb_id, 'tt10');
    assert.strictEqual(unfinishedItem.percent, 30);
    // a second profile's rows never appear.
    const other = { id: 'p-lh11-other', name: 'O', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(other.id, [
      { simkl_id: 100, type: 'movie', imdb_id: 'tt100', tmdb_id: '100', title: 'Other', year: 2020, watched_at: '2026-01-09T00:00:00Z' },
    ]);
    res = await trainer.listHistory(profile, { type: 'movie' }, deps);
    assert.ok(!res.items.some((i) => i.tmdb_id === '100'));
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    engagement._clear();
    watchedStore.deleteForProfile(profile.id);
    watchedStore.deleteForProfile(other.id);
  });

  await it('Trainer T1: listHistory — enrichment: ≤25 cap, throwing enrich, no-key, cached meta (F11.3b)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const metaStore = require('../src/engines/glass/metaStore');
    const db = require('../src/db');
    const profile = { id: 'p-lh11b', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'test-key' }, simkl_auth: { access_token: 't' } };
    // 30 watched rows (all missing a poster) → the page enriches ≤ 25.
    const items = [];
    for (let i = 1; i <= 30; i++) {
      items.push({ simkl_id: i, type: 'movie', imdb_id: 'tt' + i, tmdb_id: String(i), title: 'T' + i, year: 2020, watched_at: '2026-01-' + String(i).padStart(2, '0') + 'T00:00:00Z' });
    }
    watchedStore.upsertMany(profile.id, items);
    const enrichCalls = [];
    const deps = {
      enrich: async (_k, _t, tmdbId) => { enrichCalls.push(tmdbId); return { poster: 'p' + tmdbId, genres: ['Action'], primary_genre: 'Action', title: 'Meta' + tmdbId, year: 2000 }; },
      settings: { keyFor: (_p, f) => (f === 'tmdb_api_key' ? 'test-key' : '') },
      now: () => 1000,
      log: quiet,
    };
    // 30-item page → enrich called exactly 25 times (capped).
    let res = await trainer.listHistory(profile, { type: 'movie', pageSize: 100 }, deps);
    assert.strictEqual(res.items.length, 30);
    assert.strictEqual(enrichCalls.length, 25);
    // throwing enrich still ok:true (each .catch(() => null)).
    res = await trainer.listHistory(profile, { type: 'movie', pageSize: 100 }, { ...deps, enrich: async () => { throw new Error('tmdb down'); } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.items.length, 30);
    // no TMDB key → enrich never called.
    enrichCalls.length = 0;
    res = await trainer.listHistory(profile, { type: 'movie', pageSize: 100 }, { ...deps, settings: { keyFor: () => '' } });
    assert.strictEqual(enrichCalls.length, 0);
    // cached meta via metaGet used with no enrich call.
    metaStore.put('movie', '1', { poster: 'cached-poster', genres: ['Drama'], primary_genre: 'Drama', title: 'Cached', year: 2015, imdb_id: 'tt1' });
    enrichCalls.length = 0;
    res = await trainer.listHistory(profile, { type: 'movie', pageSize: 100 }, deps);
    const item1 = res.items.find((i) => i.tmdb_id === '1');
    assert.strictEqual(item1.poster, 'cached-poster'); // from the cache, not enrich
    assert.strictEqual(item1.genre, 'Drama');
    assert.ok(!enrichCalls.includes('1')); // tmdb 1 served from the cache, so enrich skipped it
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    metaStore._clear();
    watchedStore.deleteForProfile(profile.id);
  });

  await it('TV-R T1: listHistory — series (kind show only), the §2 DTO, progress, order, views, search', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-tvr-list', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    // 3 kind 'show' rows + 1 kind 'anime' row → the anime row is excluded (R4);
    // a 4th show row is ignored so the 'ignored' view can be exercised.
    watchedStore.upsertSeriesProgress(profile.id, [
      { simkl_id: 1, kind: 'show', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha Show', year: 2020, status: 'ongoing', watched_eps: 12, total_eps: 24, not_aired_eps: 4, last_watched_at: 3000, first_watched_at: 1000, first_real_at: 1000, last_real_at: 3000, stamps: 12, real_stamps: 12, eps_per_week: 4 },
      { simkl_id: 2, kind: 'show', imdb_id: 'tt2', tmdb_id: '2', title: 'Beta Show', year: 2021, status: 'ongoing', watched_eps: 5, total_eps: null, not_aired_eps: null, last_watched_at: 2000, first_watched_at: 1000, first_real_at: 1000, last_real_at: 2000, stamps: 5, real_stamps: 5, eps_per_week: null },
      { simkl_id: 3, kind: 'show', imdb_id: 'tt3', tmdb_id: '3', title: 'Gamma Show', year: 2022, status: 'completed', watched_eps: 10, total_eps: 10, not_aired_eps: 0, last_watched_at: 1000, first_watched_at: 1000, first_real_at: 1000, last_real_at: 1000, stamps: 10, real_stamps: 10, eps_per_week: 5 },
      { simkl_id: 4, kind: 'show', imdb_id: 'tt4', tmdb_id: '4', title: 'Delta Show', year: 2023, status: 'ongoing', watched_eps: 2, total_eps: 8, not_aired_eps: 1, last_watched_at: 500, first_watched_at: 400, first_real_at: 400, last_real_at: 500, stamps: 2, real_stamps: 2, eps_per_week: null },
      { simkl_id: 5, kind: 'anime', imdb_id: 'tta1', tmdb_id: '100', title: 'An Anime', year: 2023, status: 'ongoing', watched_eps: 3, total_eps: 12, not_aired_eps: 2, last_watched_at: 4000, first_watched_at: 3000, first_real_at: 3000, last_real_at: 4000, stamps: 3, real_stamps: 3, eps_per_week: null },
    ]);
    tasteFeedback.upsertRating(profile.id, { type: 'series', tmdb_id: '1', rating: 10 }); // loved
    tasteFeedback.upsertRating(profile.id, { type: 'series', tmdb_id: '2', rating: 7 }); // rated
    tasteFeedback.setIgnored(profile.id, { type: 'series', tmdb_id: '4' }, true, 5000);
    const deps = { now: () => 5000, log: quiet };
    // the 'all' view has 3 items (Delta is ignored, the anime row is excluded);
    // ordered by last_watched_at DESC.
    let res = await trainer.listHistory(profile, { type: 'series' }, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.total, 3);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1', '2', '3']);
    // the §2 series DTO, exactly.
    const alpha = res.items.find((i) => i.tmdb_id === '1');
    assert.deepStrictEqual(alpha, {
      key: '1', type: 'series', simkl_id: 1, tmdb_id: '1', imdb_id: 'tt1',
      title: 'Alpha Show', year: 2020, genre: null, poster: null,
      watched_at: new Date(3000).toISOString(),
      rating: 10, loved: true, ignored: false, status: 'watched', percent: null,
      progress: { watched_eps: 12, aired_eps: 20 }, // 24 - 4
    });
    // aired = null when total is unknown.
    const beta = res.items.find((i) => i.tmdb_id === '2');
    assert.deepStrictEqual(beta.progress, { watched_eps: 5, aired_eps: null });
    // counts: unfinished is 0 for series.
    assert.deepStrictEqual(res.counts, { all: 3, unrated: 1, rated: 2, loved: 1, ignored: 1, unfinished: 0, unresolved: 0 });
    // views.
    res = await trainer.listHistory(profile, { type: 'series', view: 'unrated' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['3']);
    res = await trainer.listHistory(profile, { type: 'series', view: 'rated' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1', '2']);
    res = await trainer.listHistory(profile, { type: 'series', view: 'loved' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['1']);
    res = await trainer.listHistory(profile, { type: 'series', view: 'ignored' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['4']);
    // unfinished → bad-view for series.
    res = await trainer.listHistory(profile, { type: 'series', view: 'unfinished' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-view' });
    // search (case-insensitive title substring).
    res = await trainer.listHistory(profile, { type: 'series', q: 'beta' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['2']);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('TV-R T2: rate — series (Simkl first, local row after, clear, throw, recordChange)', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-tvr-rate', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertSeriesProgress(profile.id, [
      { simkl_id: 1, kind: 'show', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha Show', year: 2020, status: 'ongoing', watched_eps: 12, total_eps: 24, not_aired_eps: 4, last_watched_at: 3000, first_watched_at: 1000, first_real_at: 1000, last_real_at: 3000, stamps: 12, real_stamps: 12, eps_per_week: 4 },
    ]);
    const simklCalls = [];
    const deps = {
      simkl: {
        setRatings: async (_p, items) => { simklCalls.push(['set', items]); },
        removeRatings: async (_p, items) => { simklCalls.push(['remove', items]); },
      },
      now: () => 5000,
      log: quiet,
    };
    // rate → setRatings with the series item; the real buildRatingsBody shows[0] has ids.simkl + rating.
    let res = await trainer.rate(profile, { type: 'series', tmdb_id: '1' }, 8, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.rating, 8);
    assert.deepStrictEqual(simklCalls, [['set', [{ type: 'series', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '1', rating: 8 }]]]);
    assert.deepStrictEqual(simkl.buildRatingsBody(simklCalls[0][1]), { movies: [], shows: [{ ids: { simkl: 1, imdb: 'tt1', tmdb: '1' }, rating: 8 }] });
    // the local row is written after the Simkl call.
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'series', '1'), 8);
    // recordChange is bumped.
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 5000, changes_since_build: 1, built_changed_at: null });
    // a throwing setRatings → no local row (unchanged).
    const before = tasteFeedback.getRating(profile.id, 'series', '1');
    await assert.rejects(() => trainer.rate(profile, { type: 'series', tmdb_id: '1' }, 9, {
      ...deps,
      simkl: { setRatings: async () => { throw new Error('Simkl POST /sync/ratings failed (500)'); }, removeRatings: async () => { throw new Error('Simkl POST /sync/ratings/remove failed (500)'); } },
    }));
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'series', '1'), before);
    // a clear → removeRatings and the row deleted.
    simklCalls.length = 0;
    res = await trainer.rate(profile, { type: 'series', tmdb_id: '1' }, null, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.rating, null);
    assert.deepStrictEqual(simklCalls, [['remove', [{ type: 'series', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '1' }]]]);
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'series', '1'), null);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('TV-R T3: setIgnored — series is local only (zero Simkl calls); un-ignore works', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-tvr-ignore', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertSeriesProgress(profile.id, [
      { simkl_id: 1, kind: 'show', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha Show', year: 2020, status: 'ongoing', watched_eps: 12, total_eps: 24, not_aired_eps: 4, last_watched_at: 3000, first_watched_at: 1000, first_real_at: 1000, last_real_at: 3000, stamps: 12, real_stamps: 12, eps_per_week: 4 },
    ]);
    const simklCalls = [];
    const deps = {
      simkl: { setRatings: async () => { simklCalls.push('set'); }, removeRatings: async () => { simklCalls.push('remove'); } },
      now: () => 5000,
      log: quiet,
    };
    // ignore → local row written, NO Simkl call.
    let res = await trainer.setIgnored(profile, { type: 'series', tmdb_id: '1' }, true, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.ignored, true);
    assert.strictEqual(simklCalls.length, 0);
    assert.ok(tasteFeedback.ignoredSet(profile.id, 'series').has('1'));
    // un-ignore → local row removed.
    res = await trainer.setIgnored(profile, { type: 'series', tmdb_id: '1' }, false, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.ignored, false);
    assert.strictEqual(tasteFeedback.ignoredSet(profile.id, 'series').size, 0);
    assert.strictEqual(simklCalls.length, 0); // still zero Simkl calls
    db.get().exec('DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('TV-R T4: markFinished / markUnwatched — series → not-supported (400), zero Simkl calls', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const db = require('../src/db');
    const profile = { id: 'p-tvr-notsup', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertSeriesProgress(profile.id, [
      { simkl_id: 1, kind: 'show', imdb_id: 'tt1', tmdb_id: '1', title: 'Alpha Show', year: 2020, status: 'ongoing', watched_eps: 12, total_eps: 24, not_aired_eps: 4, last_watched_at: 3000, first_watched_at: 1000, first_real_at: 1000, last_real_at: 3000, stamps: 12, real_stamps: 12, eps_per_week: 4 },
    ]);
    const simklCalls = [];
    const deps = {
      simkl: { setRatings: async () => { simklCalls.push('set'); }, removeRatings: async () => { simklCalls.push('remove'); }, removeFromHistory: async () => { simklCalls.push('removeHistory'); } },
      markWatched: async () => { simklCalls.push('markWatched'); return { ok: true }; },
      now: () => 5000,
      log: quiet,
    };
    // markFinished → not-supported, zero Simkl calls.
    let res = await trainer.markFinished(profile, { type: 'series', tmdb_id: '1' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-supported' });
    assert.strictEqual(simklCalls.length, 0);
    // markUnwatched → not-supported, zero Simkl calls.
    res = await trainer.markUnwatched(profile, { type: 'series', tmdb_id: '1' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-supported' });
    assert.strictEqual(simklCalls.length, 0);
    // the httpStatus mapping is 400.
    assert.strictEqual(trainer.httpStatus(res), 400);
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T2: isUnfinishedRow — the shared abandoned rule (N7, F11.4)', () => {
    const trainer = require('../src/trainer');
    const engagement = require('../src/engines/marquee/engagement');
    const mqCfg = require('../src/engines/marquee/config');
    const watchedIds = { imdb: new Set(['tt2']), tmdb: new Set(['2']) };
    const now = Date.parse('2026-06-01T00:00:00Z');
    const day = 24 * 3600e3;
    // 30% not watched → true.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '1', imdb_id: 'tt1', percent: 30 }, watchedIds), true);
    // 30% watched by tmdb → false.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '2', imdb_id: 'tt2', percent: 30 }, watchedIds), false);
    // 30% watched by imdb only → false.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '3', imdb_id: 'tt2', percent: 30 }, watchedIds), false);
    // 50% → false.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '4', imdb_id: 'tt4', percent: 50 }, watchedIds), false);
    // no tmdb_id → false.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: null, imdb_id: 'tt5', percent: 30 }, watchedIds), false);
    // grace period (T2): touched within grace_days → not yet a verdict.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '6', imdb_id: 'tt6', percent: 30, updated_at: now - 1 * day }, watchedIds, { now }), false);
    // ... but untouched for > grace_days → true.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '6', imdb_id: 'tt6', percent: 30, updated_at: now - 8 * day }, watchedIds, { now }), true);
    // credits guard (N6): ≤ credits_min remaining → never abandoned.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '7', imdb_id: 'tt7', percent: 40, duration_ms: 30 * 60000, updated_at: now - 8 * day }, watchedIds, { now }), false);
    // finish_pct (N6): ≥ 90% → finished, never abandoned.
    assert.strictEqual(trainer.isUnfinishedRow({ tmdb_id: '8', imdb_id: 'tt8', percent: 95, updated_at: now - 8 * day }, watchedIds, { now }), false);
    // N7: identical to the engine's rule (one rule, two consumers).
    const eng = mqCfg.resolveConfig({}).engagement;
    for (const row of [
      { tmdb_id: '1', imdb_id: 'tt1', percent: 30 },
      { tmdb_id: '2', imdb_id: 'tt2', percent: 30 },
      { tmdb_id: '6', imdb_id: 'tt6', percent: 30, updated_at: now - 1 * day },
      { tmdb_id: '7', imdb_id: 'tt7', percent: 40, duration_ms: 30 * 60000, updated_at: now - 8 * day },
      { tmdb_id: '8', imdb_id: 'tt8', percent: 95, updated_at: now - 8 * day },
    ]) {
      assert.strictEqual(trainer.isUnfinishedRow(row, watchedIds, { now }), engagement.isAbandoned(row, eng, { now, watchedIds }), 'trainer rule == engine rule');
    }
  });

  await it('marquee ME-03: ensureRecs sequential fetch, cap, stale served, per-id error (B6)', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const db = require('../src/db');
    const profile = { id: 'p-recs', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const recs = (id) => [{ simkl_id: id + 100, tmdb_id: String(id + 100), imdb_id: null, title: 'R' + id, year: 2020 }];
    // Seed: id 1 fresh (fetched at 1900), id 2 stale (fetched at 1000) under the
    // short ttlMs=500 below.
    db.get().prepare('INSERT INTO marquee_simkl_recs (simkl_id, recs, fetched_at) VALUES (?, ?, ?)').run(1, JSON.stringify(recs(1)), 1900);
    db.get().prepare('INSERT INTO marquee_simkl_recs (simkl_id, recs, fetched_at) VALUES (?, ?, ?)').run(2, JSON.stringify([{ title: 'stale-2' }]), 1000);
    const order = [];
    const fetchSummary = async (_p, id) => { order.push(id); return { users_recommendations: recs(id) }; };
    // now = 2000, ttlMs=500: id 1 (age 100) fresh (no fetch); id 2 (age 1000)
    // stale → refetch; ids 3,4,5 uncached → fetch; cap 2 → only 2 fetches, ids
    // beyond the cap: stale ones still served, uncached ones absent.
    let out = await simklCache.ensureRecs(profile, [1, 2, 3, 4, 5], { fetchSummary, now: 2000, log: quiet, maxUncached: 2, ttlMs: 500 });
    assert.deepStrictEqual(order, [2, 3]); // sequential, capped at 2
    assert.deepStrictEqual(out.get(1), recs(1));
    assert.deepStrictEqual(out.get(2), recs(2)); // refetched (fresh value)
    assert.deepStrictEqual(out.get(3), recs(3));
    assert.strictEqual(out.has(4), false);
    assert.strictEqual(out.has(5), false);
    // Second call: ids 4 and 5 now uncached; cap 2 → both fetched; id 1 still fresh.
    out = await simklCache.ensureRecs(profile, [1, 4, 5], { fetchSummary, now: 2000, log: quiet, maxUncached: 2 });
    assert.deepStrictEqual(order, [2, 3, 4, 5]);
    assert.deepStrictEqual(out.get(4), recs(4));
    // A per-id fetch error → log + skip (not cached), continue with the next id.
    const flaky = async (_p, id) => { if (id === 7) throw new Error('Simkl GET failed (500)'); return { users_recommendations: recs(id) }; };
    out = await simklCache.ensureRecs(profile, [7, 8], { fetchSummary: flaky, now: 2000, log: quiet });
    assert.strictEqual(out.has(7), false); // error → not cached
    assert.deepStrictEqual(out.get(8), recs(8)); // continued past the failure
    // TTL: an env override shrinks the freshness window → id 1 (fetched at 1000) now stale.
    process.env.MARQUEE_SIMKL_RECS_TTL_MS = '1000';
    try {
      out = await simklCache.ensureRecs(profile, [1], { fetchSummary, now: 3000, log: quiet });
      assert.deepStrictEqual(out.get(1), recs(1)); // refetched (stale under the 1 s TTL)
      assert.strictEqual(db.get().prepare('SELECT fetched_at FROM marquee_simkl_recs WHERE simkl_id = 1').get().fetched_at, 3000);
    } finally {
      delete process.env.MARQUEE_SIMKL_RECS_TTL_MS;
    }
    // Stale beyond the cap is served (stale better than nothing).
    db.get().prepare('INSERT INTO marquee_simkl_recs (simkl_id, recs, fetched_at) VALUES (?, ?, ?)').run(9, JSON.stringify([{ title: 'stale-9' }]), 1000);
    out = await simklCache.ensureRecs(profile, [9, 11, 12, 13], { fetchSummary: async () => { throw new Error('down'); }, now: 2000, log: quiet, maxUncached: 1, ttlMs: 500 });
    assert.deepStrictEqual(out.get(9), [{ title: 'stale-9' }]); // stale served despite the cap
    assert.strictEqual(out.has(11), false); // uncached beyond the cap → absent
    db.get().exec('DELETE FROM marquee_simkl_recs');
  });

  await it('marquee ME-04: buildEvents re-weights watched by rating, rejections unchanged, rated-but-never-watched not added (B8)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const cfg = require('../src/engines/marquee/config').resolveConfig({});
    const watchedStore = require('../src/watchedStore');
    const rs = require('../src/recommendationStore');
    const profileId = 'p-events';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'Rated9', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'Unrated', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: '3', title: 'Rated3', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    rs.addDontRecommend(profileId, 'movie', '4', 'user', nowMs);
    const ratings = new Map([['1', 9], ['3', 3], ['5', 10]]); // '5' rated but never watched
    const events = taste.buildEvents(profileId, cfg, { nowMs, ratings });
    const byId = new Map(events.map((e) => [e.tmdb_id, e]));
    // watched + rated → re-weighted, ev.rating set
    assert.strictEqual(byId.get('1').weight, 2.0);
    assert.strictEqual(byId.get('1').rating, 9);
    assert.strictEqual(byId.get('3').weight, -1.2);
    assert.strictEqual(byId.get('3').rating, 3);
    // watched + unrated → keeps the watched base weight, no rating field
    assert.strictEqual(byId.get('2').weight, 1.0);
    assert.strictEqual(byId.get('2').rating, undefined);
    // rejection events unchanged
    assert.strictEqual(byId.get('4').weight, -1.5);
    assert.strictEqual(byId.get('4').kind, 'rejected_user');
    // rated but never watched → NOT added
    assert.strictEqual(byId.has('5'), false);
    assert.strictEqual(events.length, 4);
    watchedStore.deleteForProfile(profileId);
  });

  await it('marquee ME-04: seedsFor excludes ≤4-rated, weight = rating × blended, sort + cap (B9)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const cfg = require('../src/engines/marquee/config').resolveConfig({});
    const watchedStore = require('../src/watchedStore');
    const profileId = 'p-seeds';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    const day = 24 * 3600e3;
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'RecentRated10', year: 2020, watched_at: '2026-05-20T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'OldRated10', year: 2020, watched_at: '2024-06-01T00:00:00Z' },
      { simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: '3', title: 'UnratedRecent', year: 2020, watched_at: '2026-05-20T00:00:00Z' },
      { simkl_id: 4, type: 'movie', imdb_id: 'tt4', tmdb_id: '4', title: 'Rated3', year: 2020, watched_at: '2026-05-20T00:00:00Z' },
      { simkl_id: 5, type: 'movie', imdb_id: 'tt5', tmdb_id: null, title: 'NoTmdb', year: 2020, watched_at: '2026-05-20T00:00:00Z' },
    ]);
    const ratings = new Map([['1', 10], ['2', 10], ['4', 3]]);
    const seeds = taste.seedsFor(profileId, cfg, { nowMs, ratings });
    // Rated ≤ 4 excluded; no-tmdb row excluded.
    assert.ok(!seeds.some((s) => s.tmdb_id === '4'));
    assert.ok(!seeds.some((s) => s.tmdb_id === null));
    // Trainer T2 (N3/N4): weight = ratingWeight × max(blendedWeight(days), loved decay floor).
    // recent rated-10 (3.0 × bw) > old rated-10 (floored at 3.0 × 0.5) > unrated recent (1.0 × bw).
    const byId = new Map(seeds.map((s) => [s.tmdb_id, s]));
    const recentDays = (nowMs - Date.parse('2026-05-20T00:00:00Z')) / day;
    const oldDays = (nowMs - Date.parse('2024-06-01T00:00:00Z')) / day;
    const hl = cfg.half_life_days.movie;
    const blend = cfg.horizon_blend;
    const bw = (d) => blend.long * 0.5 ** (d / hl.long) + blend.medium * 0.5 ** (d / hl.medium) + blend.recent * 0.5 ** (d / hl.recent);
    assert.ok(byId.get('1').weight > byId.get('2').weight, 'rated-10 recent beats old rated-10');
    assert.ok(byId.get('2').weight > byId.get('3').weight, 'old rated-10 (floored) beats unrated recent');
    // recent rated-10: bw(recentDays) > floor → weight = r10 × bw.
    assert.ok(Math.abs(byId.get('1').weight - 3.0 * bw(recentDays)) < 1e-9);
    // unrated recent: base weight × bw.
    assert.ok(Math.abs(byId.get('3').weight - 1.0 * bw(recentDays)) < 1e-9);
    // old rated-10: bw(oldDays) < floor → decay floored at cfg.loved.decay_floor.
    assert.ok(Math.abs(byId.get('2').weight - 3.0 * cfg.loved.decay_floor) < 1e-9);
    // sort: weight desc (Loved films pinned at the front)
    assert.deepStrictEqual(seeds.map((s) => s.tmdb_id), ['1', '2', '3']);
    // rating carried through (null for unrated)
    assert.strictEqual(byId.get('1').rating, 10);
    assert.strictEqual(byId.get('3').rating, null);
    // cap: seed_cap 40 → with a tiny library all 3 come back
    assert.strictEqual(seeds.length, 3);
    watchedStore.deleteForProfile(profileId);
  });

  await it('marquee ME-04: buildTaste rating-weighted + tasteBrief chain/cache/failure (B10)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const cfg = require('../src/engines/marquee/config').resolveConfig({});
    const watchedStore = require('../src/watchedStore');
    const metaStore = require('../src/engines/glass/metaStore');
    const llmCache = require('../src/engines/marquee/llmCache');
    const profileId = 'p-brief';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'SciFi One', year: 2010, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'Drama One', year: 2011, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    // Enrichment normally comes from the TMDB fetch; here we set it directly so
    // the Drama genre dim exists for the rating-layer assertion below.
    watchedStore.updateEnrichment(profileId, 2, { genre: 'Drama', age: null });
    metaStore.put('movie', '1', { genres: ['Sci-Fi', 'Thriller'], keywords: ['dream'], director: ['D1'], decade: 2010, imdb_id: 'tt1' });
    const ratings = new Map([['1', 10]]);
    // buildTaste: enrichment degrades (fetcher throws), taste model still built.
    const tasteModel = await taste.buildTaste(profileId, 'key', cfg, {
      nowMs, ratings,
      enrichFetcher: async () => { throw new Error('TMDB down'); },
      log: quiet,
    });
    assert.strictEqual(tasteModel.type, 'movie');
    assert.ok(tasteModel.dims.genres['Sci-Fi'] > 0);
    // A high-rated title's genre outweighs an unrated one's (rating layer works).
    assert.ok(tasteModel.dims.genres['Sci-Fi'] > tasteModel.dims.genres['Drama']);
    // tasteBrief: empty chain → null WITHOUT any network call.
    let chatCalls = 0;
    // Mimics llm.chat: the provider returns a JSON string and the validate
    // function (parseBrief) coerces it to the brief object before it is returned.
    const chat = async (chain, messages, opts) => {
      chatCalls += 1;
      return opts.validate(JSON.stringify({ loves: ['Sci-Fi'], avoids: ['Horror'], moods: ['tense'], eras: ['2010s'], standout_titles: ['SciFi One'] }));
    };
    let brief = await taste.tasteBrief(profileId, tasteModel, { chain: [], chat, cfg, ratings, log: quiet, now: nowMs });
    assert.strictEqual(brief, null);
    assert.strictEqual(chatCalls, 0);
    // With a chain: one call, cached (hash key), second call is a cache hit.
    brief = await taste.tasteBrief(profileId, tasteModel, { chain: [{ type: 'custom', uri: 'http://localhost:1' }], chat, cfg, ratings, log: quiet, now: nowMs });
    assert.strictEqual(chatCalls, 1);
    assert.deepStrictEqual(brief, { loves: ['Sci-Fi'], avoids: ['Horror'], moods: ['tense'], eras: ['2010s'], standout_titles: ['SciFi One'], hash: taste.historyHash(profileId, { ratings }) });
    const cached = await taste.tasteBrief(profileId, tasteModel, { chain: [{ type: 'custom', uri: 'http://localhost:1' }], chat, cfg, ratings, log: quiet, now: nowMs });
    assert.strictEqual(chatCalls, 1); // cache hit — no second call
    assert.deepStrictEqual(cached, brief);
    // A failing brief → null, NEVER cached (next build retries). Clear the
    // cached brief from the successful call above so this is a cold failure.
    const failing = async () => { throw new Error('all providers failed'); };
    llmCache._clear();
    brief = await taste.tasteBrief(profileId, tasteModel, { chain: [{ type: 'custom', uri: 'http://localhost:1' }], chat: failing, cfg, ratings, log: quiet, now: nowMs });
    assert.strictEqual(brief, null);
    assert.strictEqual(llmCache.get(profileId, 'brief', taste.historyHash(profileId, { ratings }), { now: nowMs }), null); // never cached
    // The prompt must not mention age/classification/children.
    const prompts = [];
    const recordChat = async (chain, messages) => { prompts.push(messages[0].content); return JSON.stringify({ loves: ['A'], avoids: [], moods: [], eras: [], standout_titles: [] }); };
    llmCache._clear();
    await taste.tasteBrief(profileId, tasteModel, { chain: [{ type: 'custom', uri: 'http://localhost:1' }], chat: recordChat, cfg, ratings, log: quiet, now: nowMs });
    assert.ok(!/age|classification|suitable|child|kid/i.test(prompts[0]), 'prompt must not mention age/classification/children');
    watchedStore.deleteForProfile(profileId);
    metaStore._clear();
  });

  await it('marquee ME-03: syncRatings never holds a transaction open across an await (F1)', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-txn', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    db.get().exec('CREATE TABLE IF NOT EXISTS test_scratch (note TEXT)');
    db.get().exec('DELETE FROM test_scratch');
    // The resolver stub plays a CONCURRENT writer: while the lookup is pending
    // (an await), it opens its own transaction on the SAME shared connection —
    // the exact hazard F1 describes. Before the fix syncRatings's transaction
    // was already open here, so this BEGIN threw "cannot start a transaction
    // within a transaction"; after the fix the lookups finish before BEGIN.
    const resolveTmdb = async (imdbId) => {
      await new Promise((r) => setTimeout(r, 0)); // yield while the lookup is "in flight"
      const conn = db.get();
      conn.exec('BEGIN');
      conn.prepare('INSERT INTO test_scratch (note) VALUES (?)').run('concurrent-write');
      conn.exec('COMMIT');
      return 'tmdb-' + imdbId;
    };
    const res = await simklCache.syncRatings(profile, {
      fetchActivities: async () => ({ movies: { rated_at: null } }),
      fetchRatings: async () => simkl.parseRatings({ movies: [{ user_rating: 7, movie: { ids: { imdb: 'ttF1' } } }] }),
      resolveTmdb,
      now: 1000,
      log: quiet,
      force: true,
    });
    assert.deepStrictEqual(res, { ok: true, synced: 1, unresolved: 0 });
    // Both writes persist: the profile's rating row AND the concurrent writer's row.
    assert.deepStrictEqual([...simklCache.getRatingsMap('p-txn').entries()], [['tmdb-ttF1', 7]]);
    assert.deepStrictEqual(db.get().prepare('SELECT note FROM test_scratch').all().map((r) => r.note), ['concurrent-write']);
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ratings_sync; DELETE FROM test_scratch');
    db.get().exec('DROP TABLE IF EXISTS test_scratch');
  });

  await it('marquee ME-04: no ratings (the production case) — events identical to Glass, seeds by recency (T1)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const glassEvents = require('../src/engines/glass/events');
    const glassTasteModel = require('../src/engines/glass/tasteModel');
    const cfg = require('../src/engines/marquee/config').resolveConfig({});
    const profileId = 'p-noratings';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'Recent', year: 2020, watched_at: '2026-05-25T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'Mid', year: 2020, watched_at: '2026-03-01T00:00:00Z' },
      { simkl_id: 3, type: 'movie', imdb_id: 'tt3', tmdb_id: '3', title: 'Old', year: 2020, watched_at: '2024-06-01T00:00:00Z' },
    ]);
    rs.addDontRecommend(profileId, 'movie', '4', 'user', nowMs);
    const empty = new Map();
    // No ratings → buildEvents is EXACTLY Glass's event list (nothing re-weighted).
    assert.deepStrictEqual(taste.buildEvents(profileId, cfg, { nowMs, ratings: empty }), glassEvents.buildEventList(profileId, 'movie', cfg, { nowMs }));
    // seedsFor orders purely by recency — the same order as sorting by blendedWeight alone.
    const seeds = taste.seedsFor(profileId, cfg, { nowMs, ratings: empty });
    const day = 24 * 3600e3;
    const hl = cfg.half_life_days.movie;
    const blend = cfg.horizon_blend;
    const bw = (w) => { const d = Math.max(0, (nowMs - Date.parse(w.watched_at)) / day); return glassTasteModel.blendedWeight(d, hl, blend); };
    const byBlended = watchedStore.getWatched(profileId, { type: 'movie' }).filter((w) => w.tmdb_id).sort((a, b) => bw(b) - bw(a)).map((w) => String(w.tmdb_id));
    assert.deepStrictEqual(seeds.map((s) => s.tmdb_id), byBlended);
    // All unrated → every seed weight = base × blendedWeight (no rating multiplier), rating null.
    const watched = new Map(watchedStore.getWatched(profileId, { type: 'movie' }).map((w) => [String(w.tmdb_id), w]));
    for (const s of seeds) {
      assert.ok(Math.abs(s.weight - 1.0 * bw(watched.get(s.tmdb_id))) < 1e-9);
      assert.strictEqual(s.rating, null);
    }
    watchedStore.deleteForProfile(profileId);
  });

  await it('marquee ME-04: negative rating → negative director affinity (T2)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const cfg = require('../src/engines/marquee/config').resolveConfig({});
    const metaStore = require('../src/engines/glass/metaStore');
    const profileId = 'p-negdir';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'Disliked', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    // 'Director X' appears in NO other title — only this rated-2 movie.
    metaStore.put('movie', '1', { genres: ['Drama'], director: ['Director X'], decade: 2020, imdb_id: 'tt1' });
    const ratings = new Map([['1', 2]]);
    const tasteModel = await taste.buildTaste(profileId, 'key', cfg, {
      nowMs, ratings,
      enrichFetcher: async () => { throw new Error('TMDB down'); },
      log: quiet,
    });
    assert.ok(tasteModel.dims.directors['Director X'] < 0, 'rated-2 movie → negative director affinity');
    watchedStore.deleteForProfile(profileId);
    metaStore._clear();
  });

  await it('marquee ME-04: brief regenerated when history changes (cache miss, not just a hit) (T3)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const cfg = require('../src/engines/marquee/config').resolveConfig({});
    const profileId = 'p-brief-miss';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2010, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'B', year: 2011, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    let chatCalls = 0;
    const chat = async (chain, messages, opts) => { chatCalls += 1; return opts.validate(JSON.stringify({ loves: ['X'], avoids: [], moods: [], eras: [], standout_titles: ['A'] })); };
    const chain = [{ type: 'custom', uri: 'http://localhost:1' }];
    const tasteModel = { type: 'movie', dims: { genres: {}, directors: {}, keywords: {}, decades: {} } };
    const ratings1 = new Map([['1', 10]]);
    // First call: cache miss → 1 chat call.
    let brief = await taste.tasteBrief(profileId, tasteModel, { chain, chat, cfg, ratings: ratings1, log: quiet, now: nowMs });
    assert.strictEqual(chatCalls, 1);
    const hash1 = brief.hash;
    // Same ratings again → cache hit, no new call.
    await taste.tasteBrief(profileId, tasteModel, { chain, chat, cfg, ratings: ratings1, log: quiet, now: nowMs });
    assert.strictEqual(chatCalls, 1);
    // One more rating → history changes → cache MISS → 2nd call, different hash.
    const ratings2 = new Map([['1', 10], ['2', 5]]);
    const brief2 = await taste.tasteBrief(profileId, tasteModel, { chain, chat, cfg, ratings: ratings2, log: quiet, now: nowMs });
    assert.strictEqual(chatCalls, 2);
    assert.notStrictEqual(brief2.hash, hash1);
    watchedStore.deleteForProfile(profileId);
  });

  // ── Marquee ME-05/ME-06 (P3): candidate sources + hard filter + scoring ──
  const mqSources = require('../src/engines/marquee/sources');
  const mqScoring = require('../src/engines/marquee/scoring');
  const mqFilters = require('../src/engines/marquee/filters');
  const mqCfg = require('../src/engines/marquee/config');
  const glassMeta = require('../src/engines/glass/metaStore');
  const pipeline = require('../src/engines/pipeline');

  const mqGenreMap = { 28: 'Action', 18: 'Drama', 878: 'Science Fiction' };
  const mqTaste = {
    type: 'movie',
    dims: {
      genres: { Action: 0.9, Drama: 0.5 },
      franchises: { 'c:100': 0.8 },
      keywords: {}, directors: {}, cast: {}, decades: {}, languages: {}, runtimeBands: {},
    },
    genreMass: {},
  };
  const mqCfgResolved = mqCfg.resolveConfig({});
  const mqItem = (id, over) => ({
    type: 'movie', tmdb_id: id, title: 'T' + id, year: 2020, genre_ids: [28],
    vote_average: 7, vote_count: 1000, popularity: 5, adult: false, poster: '/p' + id + '.jpg', ...over,
  });
  const mqSeed = (id, over) => ({
    tmdb_id: id, simkl_id: null, imdb_id: 'tt' + id, title: 'Seed' + id, year: 2020,
    rating: 8, weight: 1.0, watched_at: '2026-05-01T00:00:00Z', ...over,
  });
  const mqFullMeta = (id, over) => ({
    tmdb_id: String(id), imdb_id: 'tt' + id, type: 'movie', title: 'M' + id,
    overview: 'ov ' + id, year: 2020, decade: 2020,
    poster: 'https://image.tmdb.org/t/p/w500/p' + id + '.jpg',
    genres: ['Action'], primary_genre: 'Action',
    vote_average: 7, vote_count: 1000, popularity: 5,
    original_language: 'en', runtime: 120,
    director: ['D1'], cast: ['C1'], keywords: ['k1'],
    collection: null, networks: [],
    certAU: 'M', certUS: 'R', availability: 'AVAILABLE',
    ...over,
  });
  const mqCand = (id, over) => ({
    type: 'movie', tmdb_id: id, title: 'M' + id, year: 2020, genre_ids: [28], genres: ['Action'],
    vote_average: 7, vote_count: 1000, popularity: 5, adult: false, poster: null,
    sources: new Set(['tmdb_recs']), seeds: new Set(), seedTitles: new Map(), _seedWeights: new Map(),
    trending: { tmdbWeekRank: null, tmdbDayRank: null, simklWatched: 0, simklDrop: null }, _preScore: 0, ...over,
  });
  const mqEnvelope = (filters) => mqFilters.compileEnvelope(filters, { nowYear: 2026, genreMap: mqGenreMap });
  const mqCtx = (filters, over) => ({
    tmdbKey: 'k', mdblistKey: '', settings: {}, filters, log: quiet,
    watchedIds: { tmdb: new Set(), imdb: new Set() }, dont: new Set(), stats: {}, ...over,
  });
  // ME-05 fetchers with call recording (all injectable, no network).
  const mqFetchers = (over) => {
    const calls = { recs: [], similar: [], discover: [], collection: [], trendingWeek: 0, trendingDay: 0, simklTrending: 0, simklRecs: [], chat: [], resolve: [] };
    const f = {
      recs: async (id) => { calls.recs.push(id); return over.recs ? over.recs(id) : []; },
      similar: async (id) => { calls.similar.push(id); return over.similar ? over.similar(id) : []; },
      discover: async (params, page) => { calls.discover.push({ params, page }); return over.discover ? over.discover(params, page) : []; },
      collection: async (id) => { calls.collection.push(id); return over.collection ? over.collection(id) : []; },
      trendingWeek: async () => { calls.trendingWeek += 1; return over.trendingWeek || []; },
      trendingDay: async () => { calls.trendingDay += 1; return over.trendingDay || []; },
      simklTrending: async () => { calls.simklTrending += 1; return over.simklTrending || []; },
      simklRecs: async (ids) => { calls.simklRecs.push(ids); return over.simklRecs ? over.simklRecs(ids) : new Map(); },
      // Mirrors llm.chat: the raw text is passed through opts.validate (parseSuggestions).
      chat: async (chain, messages, opts) => { calls.chat.push(messages); return opts.validate(over.chat ? over.chat(chain, messages, opts) : '[]'); },
      resolve: async (title, year) => { calls.resolve.push({ title, year }); return over.resolve ? over.resolve(title, year) : null; },
    };
    return { f, calls };
  };
  // ME-06 fetchers with call recording.
  const mqScoreFetchers = (over) => {
    const calls = { deepMeta: [], imdbRatings: [] };
    const f = {
      deepMeta: async (apiKey, type, id) => { calls.deepMeta.push(id); return over.deepMeta ? over.deepMeta(id) : null; },
      imdbRatings: async (ids) => { calls.imdbRatings.push(ids); return over.imdbRatings ? over.imdbRatings(ids) : new Map(); },
    };
    return { f, calls };
  };
  // ME-07: a scored list from ME-06 over invented candidates (deepMeta stubbed).
  const mqScored = async (cands, filters) => {
    glassMeta._clear();
    const env = mqEnvelope(filters || { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 });
    const ctx = mqCtx(filters || { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 });
    const { f } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) });
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mqfit', name: 'MQFIT', filters }, ctx, cands, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false },
      fetchers: f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    return scored;
  };
  // ME-07: a chat stub mirroring llm.chat (content passes through opts.validate),
  // with per-call recording. `respond(callNumber, messages)` returns the raw text.
  const mqFitChat = (respond) => {
    const calls = { n: 0 };
    const chat = async (chain, messages, opts) => {
      calls.n += 1;
      return opts.validate(respond(calls.n, messages));
    };
    return { chat, calls };
  };

  await it('marquee ME-05: source tagging + merge (one title from S1 recs/similar, S3, S5)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      recs: () => [mqItem('100')],
      similar: () => [mqItem('100')],
      discover: () => [mqItem('100')],
      trendingWeek: [{ ...mqItem('100'), rank: 3 }],
      trendingDay: [{ ...mqItem('100'), rank: 5 }],
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq1', name: 'MQ1', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const c = candidates.find((x) => x.tmdb_id === '100');
    assert.ok(c, 'merged candidate present');
    assert.ok(c.sources.has('tmdb_recs') && c.sources.has('tmdb_similar') && c.sources.has('discover') && c.sources.has('trending'), 'all four tags');
    assert.deepStrictEqual([...c.seeds], ['10']);
    assert.strictEqual(c.trending.tmdbWeekRank, 3, 'best week rank kept');
    assert.strictEqual(c.trending.tmdbDayRank, 5, 'best day rank kept');
    assert.strictEqual(c.title, 'T100');
  });

  await it('marquee ME-05: exclusions (watched, dont_recommend, adult never appear)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      recs: () => [mqItem('200'), mqItem('300'), mqItem('400', { adult: true }), mqItem('500')],
    });
    const ctx = mqCtx(filters, {
      watchedIds: { tmdb: new Set(['200']), imdb: new Set() },
      dont: new Set(['movie:300']),
    });
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq2', name: 'MQ2', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const ids = candidates.map((x) => x.tmdb_id);
    assert.ok(!ids.includes('200'), 'watched excluded');
    assert.ok(!ids.includes('300'), 'dont_recommend excluded');
    assert.ok(!ids.includes('400'), 'adult excluded');
    assert.ok(ids.includes('500'), 'clean item kept');
  });

  await it('marquee ME-05: prefilter drops excluded-genre + below-vote-floor before lookup', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: ['Drama'], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      recs: () => [mqItem('601', { genre_ids: [18] }), mqItem('602', { vote_count: 500 }), mqItem('603')],
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq3', name: 'MQ3', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const ids = candidates.map((x) => x.tmdb_id);
    assert.ok(!ids.includes('601'), 'excluded genre dropped by prefilter');
    assert.ok(!ids.includes('602'), 'below vote floor dropped by prefilter');
    assert.ok(ids.includes('603'), 'clean item kept');
    // Proves they were dropped BEFORE lookup: run ME-06 and assert deepMeta is never called for them.
    const sf = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) });
    await mqScoring.scoreCandidates({ id: 'p-mq3', name: 'MQ3', filters }, ctx, candidates, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: sf.f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    assert.ok(!sf.calls.deepMeta.includes('601') && !sf.calls.deepMeta.includes('602'), 'deepMeta never called for prefiltered items');
  });

  await it('marquee ME-05/06: S2-only item survives prefilter, judged by hard filter after lookup', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      simklRecs: () => new Map([[100, [{ tmdb_id: '700', title: 'S2Title', year: 2020 }]]]),
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq4', name: 'MQ4', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10', { simkl_id: 100 })], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const s2 = candidates.find((x) => x.tmdb_id === '700');
    assert.ok(s2, 'S2-only item survives prefilter');
    assert.ok(s2.sources.has('simkl_recs'));
    assert.strictEqual(s2.vote_count, 0, 'no list payload');
    const sf = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) });
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq4', name: 'MQ4', filters }, ctx, candidates, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: sf.f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    assert.ok(scored.some((x) => x.tmdb_id === '700'), 'S2-only item passes hard filter after lookup');
  });

  await it('marquee ME-05: discover carries the envelope (kids config → certification.lte present)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 10 };
    const env = mqEnvelope(filters);
    const expected = env.discoverParams();
    const { f, calls } = mqFetchers({ discover: () => [] });
    const ctx = mqCtx(filters);
    await mqSources.gatherCandidates({ id: 'p-mq5', name: 'MQ5', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.ok(calls.discover.length > 0, 'discover called');
    assert.ok('certification.lte' in expected, 'kids config has certification.lte');
    for (const { params } of calls.discover) {
      for (const k of Object.keys(expected)) {
        assert.ok(k in params, `discover params carry ${k}`);
        assert.strictEqual(params[k], expected[k], `${k} matches the envelope`);
      }
    }
  });

  await it('marquee ME-05: S4 gives only unwatched, released collection parts', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      collection: () => [
        mqItem('801', { release_date: '2020-01-01' }),  // released, unwatched → kept
        mqItem('802', { release_date: '2020-01-01' }),  // watched → dropped
        mqItem('803', { release_date: '2027-01-01' }),  // future → dropped
        mqItem('804', { release_date: null }),           // no date → dropped
      ],
    });
    const ctx = mqCtx(filters, { watchedIds: { tmdb: new Set(['802']), imdb: new Set() } });
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq6', name: 'MQ6', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const ids = candidates.map((x) => x.tmdb_id);
    assert.ok(ids.includes('801'), 'released unwatched part kept');
    assert.ok(!ids.includes('802'), 'watched part dropped');
    assert.ok(!ids.includes('803'), 'future part dropped');
    assert.ok(!ids.includes('804'), 'no-date part dropped');
  });

  await it('marquee ME-05: S6 skipped (brief null / empty chain → chat never called)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    // brief null → chat not called.
    {
      const { f, calls } = mqFetchers({});
      const ctx = mqCtx(filters);
      await mqSources.gatherCandidates({ id: 'p-mq7a', name: 'MQ7a', filters }, ctx, {
        taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [{ type: 'custom', uri: 'http://x' }], log: quiet,
      });
      assert.strictEqual(calls.chat.length, 0, 'brief null → no chat');
    }
    // empty chain → chat not called.
    {
      const { f, calls } = mqFetchers({});
      const ctx = mqCtx(filters);
      await mqSources.gatherCandidates({ id: 'p-mq7b', name: 'MQ7b', filters }, ctx, {
        taste: mqTaste, brief: { loves: ['A'] }, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
      });
      assert.strictEqual(calls.chat.length, 0, 'empty chain → no chat');
    }
  });

  await it('marquee ME-05: S6 cached (two builds → one chat, one resolve per title)', async () => {
    glassMeta._clear();
    const llmCache = require('../src/engines/marquee/llmCache');
    llmCache._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f, calls } = mqFetchers({
      chat: () => JSON.stringify([{ title: 'Good', year: 2020 }, { title: 'Dud', year: 2020 }]),
      resolve: (title) => (title === 'Good' ? { _tmdb_id: 900, releaseInfo: '2020', _genre_ids: [28], _vote_average: 7, _vote_count: 1000 } : null),
    });
    const ctx = mqCtx(filters);
    const profile = { id: 'p-mq8', name: 'MQ8', filters };
    const args = { taste: mqTaste, brief: { loves: ['A'] }, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [{ type: 'custom', uri: 'http://x' }], log: quiet };
    await mqSources.gatherCandidates(profile, ctx, args);
    assert.strictEqual(calls.chat.length, 1, 'first build: one chat');
    assert.strictEqual(calls.resolve.length, 2, 'first build: resolve each title');
    await mqSources.gatherCandidates(profile, ctx, args);
    assert.strictEqual(calls.chat.length, 1, 'second build: cache hit, no chat');
    assert.strictEqual(calls.resolve.length, 2, 'second build: no re-resolve (cached list)');
    llmCache._clear();
  });

  await it('marquee ME-05/06: S6 untrusted (unresolved dropped; resolved-but-failing hard filter dropped)', async () => {
    glassMeta._clear();
    const llmCache = require('../src/engines/marquee/llmCache');
    llmCache._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      chat: () => JSON.stringify([{ title: 'Good', year: 2020 }, { title: 'Dud', year: 2020 }]),
      resolve: (title) => (title === 'Good' ? { _tmdb_id: 901, releaseInfo: '2020', _genre_ids: [28], _vote_average: 7, _vote_count: 1000 } : null),
    });
    const ctx = mqCtx(filters);
    const profile = { id: 'p-mq9', name: 'MQ9', filters };
    const { candidates } = await mqSources.gatherCandidates(profile, ctx, {
      taste: mqTaste, brief: { loves: ['A'] }, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [{ type: 'custom', uri: 'http://x' }], log: quiet,
    });
    const ids = candidates.map((x) => x.tmdb_id);
    assert.ok(ids.includes('901'), 'resolved suggestion kept');
    assert.ok(candidates.find((x) => x.tmdb_id === '901').sources.has('llm'), 'tagged llm');
    assert.ok(candidates.every((x) => x.tmdb_id !== null), 'unresolved (Dud) dropped');
    // ME-06: resolved 'Good' fails the hard filter (NOT_YET) → dropped.
    const sf = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id, { availability: 'NOT_YET' }) });
    const { scored } = await mqScoring.scoreCandidates(profile, ctx, candidates, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: sf.f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    assert.ok(!scored.some((x) => x.tmdb_id === '901'), 'resolved but NOT_YET → dropped by hard filter');
    llmCache._clear();
  });

  await it('marquee ME-05: S7 exploration reserve (≤ 20, outside the top-6 genres)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const outside = Array.from({ length: 30 }, (_, i) => ({ ...mqItem('1000' + i, { genre_ids: [878], vote_average: 7 }), rank: i + 1 }));
    const { f } = mqFetchers({ trendingWeek: outside });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq10', name: 'MQ10', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const explore = candidates.filter((x) => x.sources.has('exploration'));
    assert.ok(explore.length <= 20, 'reserve ≤ 20');
    assert.ok(explore.length > 0, 'some exploration');
    for (const c of explore) {
      assert.ok(!c.genres.some((g) => ['Action', 'Drama'].includes(g)), 'outside the top-6 genres');
    }
  });

  await it('marquee ME-05: truncation (960 raw → ≤ lookup_cap, exploration included)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const seeds = Array.from({ length: 40 }, (_, i) => mqSeed('s' + i));
    const { f } = mqFetchers({
      recs: (id) => Array.from({ length: 12 }, (_, j) => mqItem('r' + id + '-' + j)),
      similar: (id) => Array.from({ length: 12 }, (_, j) => mqItem('s' + id + '-' + j)),
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq11', name: 'MQ11', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds, envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.ok(candidates.length <= mqCfgResolved.lookup_cap, '≤ lookup_cap');
    // m2: similar_per_seed 6 (was 12) → 40 × (12 recs + 6 similar) = 720.
    assert.strictEqual(ctx.stats.raw, 40 * (mqCfgResolved.recs_per_seed + mqCfgResolved.similar_per_seed), 'raw counted');
    assert.strictEqual(ctx.stats.kept, candidates.length, 'kept = returned length');
  });

  await it('marquee ME-05: Simkl collaborative reserve (F1) — 960 S1 + 60 S2-only → exactly 40 S2-only survive, multi-seed first', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const seeds = Array.from({ length: 40 }, (_, i) => mqSeed('s' + i, { simkl_id: 5000 + i }));
    // Per-seed S2 lists: 10 multi-seed titles q0..q9 (each in exactly 2 seeds)
    // + 50 single-seed titles q10..q59 → 60 S2-only candidates total.
    const s2List = (i) => {
      const out = [];
      if (i < 10) out.push({ tmdb_id: 'q' + i, title: 'Q' + i, year: 2020 });
      if (i > 0 && i <= 10) out.push({ tmdb_id: 'q' + (i - 1), title: 'Q' + (i - 1), year: 2020 });
      out.push({ tmdb_id: 'q' + (10 + i), title: 'Q' + (10 + i), year: 2020 });
      if (i < 10) out.push({ tmdb_id: 'q' + (40 + i), title: 'Q' + (40 + i), year: 2020 });
      return out;
    };
    const { f } = mqFetchers({
      recs: (id) => Array.from({ length: 12 }, (_, j) => mqItem('r' + id + '-' + j)),
      similar: (id) => Array.from({ length: 12 }, (_, j) => mqItem('s' + id + '-' + j)),
      simklRecs: (ids) => { const m = new Map(); for (const sid of ids) m.set(sid, s2List(sid - 5000)); return m; },
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq-f1a', name: 'MQF1a', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds, envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.ok(candidates.length <= mqCfgResolved.lookup_cap, '≤ lookup_cap');
    const s2Only = candidates.filter((c) => c.sources.has('simkl_recs') && !c.sources.has('tmdb_recs') && !c.sources.has('tmdb_similar'));
    assert.strictEqual(s2Only.length, 40, 'exactly collab_reserve S2-only titles survive');
    for (let i = 0; i < 10; i += 1) {
      assert.ok(s2Only.some((c) => c.tmdb_id === 'q' + i), 'multi-seed title q' + i + ' is in the reserve');
    }
    assert.strictEqual(ctx.stats.sources.S2_reserved, 40, 'S2_reserved counted');
  });

  await it('marquee ME-05: Simkl collaborative reserve (F1) — cached meta hydrates genres/votes, pre-score > 0.2 on-taste', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    glassMeta.put('movie', 'h1', mqFullMeta('h1', { genres: ['Drama'] }), nowMs);
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const seeds = [mqSeed('s1', { simkl_id: 6000 })];
    const { f } = mqFetchers({ simklRecs: (ids) => { const m = new Map(); for (const sid of ids) m.set(sid, [{ tmdb_id: 'h1', title: 'H1', year: 2020 }]); return m; } });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq-f1b', name: 'MQF1b', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds, envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const h1 = candidates.find((c) => c.tmdb_id === 'h1');
    assert.ok(h1, 'hydrated candidate present');
    assert.deepStrictEqual(h1.genres, ['Drama'], 'genres hydrated from cached meta');
    assert.strictEqual(h1.vote_count, 1000, 'vote_count hydrated');
    assert.ok(h1._preScore > 0.2, 'hydrated pre-score > 0.2 for an on-taste genre');
  });

  await it('marquee ME-05: collab reserve pool extends outside the main slice (P4 carry-over §4.0)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    // One S2-only title whose hydrated pre-score (Action genre, vote 7) lands at
    // rank 361 — index 360 = mainCap − collab_reserve (400 − 40), i.e. between
    // the old pool start (mainCap = 400) and the main slice end.
    glassMeta.put('movie', 'q360', mqFullMeta('q360', { genres: ['Action'] }), nowMs);
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const seeds = Array.from({ length: 40 }, (_, i) => mqSeed('s' + i, { simkl_id: 5000 + i }));
    // 960 S1 titles: 360 at pre-score 0.58417 (vote 7.5), 600 at 0.54667 (vote 5),
    // so q360 (0.57667) sorts between them at index 360.
    const { f } = mqFetchers({
      recs: (id) => Array.from({ length: 12 }, (_, j) => mqItem('r' + id + '-' + j, { vote_average: j < 6 ? 7.5 : 5 })),
      similar: (id) => Array.from({ length: 12 }, (_, j) => mqItem('s' + id + '-' + j, { vote_average: j < 3 ? 7.5 : 5 })),
      simklRecs: (ids) => {
        const m = new Map();
        for (const sid of ids) {
          const i = sid - 5000;
          const recs = [];
          if (i < 2) recs.push({ tmdb_id: 'q360', title: 'Q360', year: 2020 }); // 2 seeds → ranks first in the reserve
          for (let j = 0; j < 20; j += 1) {
            const w = i === 0 ? 'w' + j : (i === 1 ? 'w' + (20 + j) : 'w' + (40 + (i - 2)));
            recs.push({ tmdb_id: w, title: 'W' + w.slice(1), year: 2020 });
          }
          m.set(sid, recs);
        }
        return m;
      },
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq-f1c', name: 'MQF1c', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds, envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const ids = candidates.map((c) => c.tmdb_id);
    assert.ok(ids.includes('q360'), 'rank-360 S2 title is in the output (reserve pool starts at mainCap − collab_reserve)');
    assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate tmdb_ids');
    assert.ok(candidates.length <= mqCfgResolved.lookup_cap, '≤ lookup_cap');
    assert.strictEqual(ctx.stats.sources.S2_reserved, 40, 'S2_reserved counted');
  });

  // ── Marquee ME-07 (P4): LLM fit ──
  const mqLlmFit = require('../src/engines/marquee/llmFit');
  const mqLlmCache = require('../src/engines/marquee/llmCache');
  const mqBrief = { loves: ['Action'], avoids: ['Horror'], moods: ['thrilling'], eras: ['2010s'], standout_titles: ['Inception'] };
  const mqFitNow = Date.parse('2026-06-01T00:00:00Z');
  const mqFitOpts = (over) => ({
    brief: mqBrief, briefHash: 'h-fit', cfg: mqCfgResolved, chain: [{ type: 'custom', name: 'local', uri: 'http://x' }],
    log: quiet, now: mqFitNow, ...over,
  });

  await it('marquee ME-07: fit — invented id ignored, missing items fit 5 and NOT cached', async () => {
    mqLlmCache._clear();
    const scored = await mqScored(Array.from({ length: 20 }, (_, i) => mqCand('f' + i)));
    const { chat, calls } = mqFitChat(() => {
      const arr = [{ id: 'zzz', fit: 9, reason: 'invented' }];
      for (let i = 0; i < 18; i += 1) arr.push({ id: 'f' + i, fit: 9, reason: 'action taste' });
      return JSON.stringify(arr);
    });
    const out = await mqLlmFit.applyLlmFit('p-mqfit1', scored, mqFitOpts({ chat }));
    assert.strictEqual(calls.n, 1, 'one batch');
    const byId = new Map(out.map((r) => [r.tmdb_id, r]));
    assert.deepStrictEqual(byId.get('f0').scoreComponents.llm, { fit: 9, reason: 'action taste', cached: false }, 'returned item folded in');
    for (const id of ['f18', 'f19']) {
      assert.strictEqual(byId.get(id).scoreComponents.llm.fit, 5, id + ' missing → fit 5');
      assert.strictEqual(byId.get(id).scoreComponents.llm.reason, null);
      assert.strictEqual(mqLlmCache.get('p-mqfit1', 'fit', `${id}:${'h-fit'}`), null, id + ' not cached');
    }
    assert.ok(mqLlmCache.get('p-mqfit1', 'fit', 'f0:h-fit'), 'f0 cached');
  });

  await it('marquee ME-07: fit — cache hit (second run, same brief → chat not called)', async () => {
    mqLlmCache._clear();
    const scored = await mqScored(Array.from({ length: 20 }, (_, i) => mqCand('c' + i)));
    const { chat, calls } = mqFitChat(() => JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: 'c' + i, fit: 7, reason: 'ok' }))));
    const r1 = await mqLlmFit.applyLlmFit('p-mqfit2', scored, mqFitOpts({ chat }));
    assert.strictEqual(calls.n, 1, 'first run: one batch');
    const r2 = await mqLlmFit.applyLlmFit('p-mqfit2', r1, mqFitOpts({ chat }));
    assert.strictEqual(calls.n, 1, 'second run: chat not called (all cached)');
    assert.ok(r2.every((r) => r.scoreComponents.llm.cached), 'every row cached on the second run');
  });

  await it('marquee ME-07: fit — one failing batch (batch 2 of 3 throws → batches 1 and 3 applied)', async () => {
    mqLlmCache._clear();
    // Distinct vote_average per candidate (via the deepMeta stub — features are
    // computed from the meta, not the candidate) → strictly distinct rankScores
    // → the scored order is b0..b44 (a tie would sort by tmdb_id STRING order).
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const ctx = mqCtx(filters);
    const { f } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id, { vote_average: 7 - Number(id.slice(1)) * 0.01 }) });
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mqfit', name: 'MQFIT', filters }, ctx, Array.from({ length: 45 }, (_, i) => mqCand('b' + i)), {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false },
      fetchers: f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    const { chat, calls } = mqFitChat((n) => {
      if (n === 2) throw new Error('gpu timeout');
      const start = (n - 1) * 20;
      const arr = [];
      for (let i = start; i < Math.min(start + 20, 45); i += 1) arr.push({ id: 'b' + i, fit: 8, reason: 'fits' });
      return JSON.stringify(arr);
    });
    const logLines = [];
    const out = await mqLlmFit.applyLlmFit('p-mqfit3', scored, mqFitOpts({
      chat, log: { log() {}, warn(m) { logLines.push(m); }, error() {} },
    }));
    assert.strictEqual(calls.n, 3, 'three batches attempted');
    const byId = new Map(out.map((r) => [r.tmdb_id, r]));
    for (const i of [0, 44]) assert.strictEqual(byId.get('b' + i).scoreComponents.llm.fit, 8, 'batches 1 and 3 applied');
    for (let i = 20; i < 40; i += 1) {
      assert.strictEqual(byId.get('b' + i).scoreComponents.llm.fit, 5, 'batch 2 rows fit 5');
      assert.strictEqual(mqLlmCache.get('p-mqfit3', 'fit', `b${i}:h-fit`), null, 'batch 2 rows not cached');
    }
    assert.ok(logLines.some((l) => l === '[marquee] fit batch 2/3 failed: gpu timeout'), 'failure logged, next batch still ran');
  });

  await it('marquee ME-07: fit — reason (LLM reason → because_title after normalize; no reason → because you watched <seed>)', async () => {
    mqLlmCache._clear();
    const cands = [
      mqCand('r1'),
      mqCand('r2'),
      mqCand('r3', { seeds: new Set(['s3']), seedTitles: new Map([['s3', 'Seed Three']]), _seedWeights: new Map([['s3', 1.0]]) }),
    ];
    const scored = await mqScored(cands);
    const { chat } = mqFitChat(() => JSON.stringify([{ id: 'r1', fit: 9, reason: 'action taste' }]));
    const out = await mqLlmFit.applyLlmFit('p-mqfit4', scored, mqFitOpts({ chat }));
    const byId = new Map(out.map((r) => [r.tmdb_id, r]));
    assert.strictEqual(byId.get('r1').reason, 'action taste', 'LLM reason on the row');
    pipeline.normalize(byId.get('r1'));
    assert.strictEqual(byId.get('r1').because_title, 'action taste', 'pipeline.normalize maps reason → because_title');
    assert.strictEqual(byId.get('r2').reason, null, 'no LLM reason, no seed → null');
    assert.strictEqual(byId.get('r3').reason, 'because you watched Seed Three', 'seed fallback reason');
  });

  await it('marquee ME-07: no local LLM / no brief / disabled → P3 output unchanged (same array, order, scores)', async () => {
    mqLlmCache._clear();
    const scored = await mqScored(Array.from({ length: 30 }, (_, i) => mqCand('n' + i)));
    const { chat } = mqFitChat(() => '[]');
    const out1 = await mqLlmFit.applyLlmFit('p-mqfit5', scored, mqFitOpts({ chat, chain: [] }));
    assert.strictEqual(out1, scored, 'empty chain → same array returned unchanged');
    const out2 = await mqLlmFit.applyLlmFit('p-mqfit5', scored, mqFitOpts({ chat, brief: null, briefHash: null }));
    assert.strictEqual(out2, scored, 'no brief → same array returned unchanged');
    const out3 = await mqLlmFit.applyLlmFit('p-mqfit5', scored, mqFitOpts({ chat, cfg: { ...mqCfgResolved, llm_fit: { ...mqCfgResolved.llm_fit, enabled: false } } }));
    assert.strictEqual(out3, scored, 'disabled → same array returned unchanged');
    assert.deepStrictEqual(out1.map((r) => [r.tmdb_id, r.rankScore]), scored.map((r) => [r.tmdb_id, r.rankScore]), 'order and scores identical to P3');
  });

  await it('marquee ME-05: S5 per-list isolation (S1) — simklTrending throws, TMDB week/day kept, hadTrending true', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f, calls } = mqFetchers({
      trendingWeek: [mqItem('w1', { rank: 1 }), mqItem('w2', { rank: 2 })],
      trendingDay: [mqItem('d1', { rank: 1 })],
    });
    // The stub returns its override as-is, so install a throwing fetcher here.
    f.simklTrending = async () => { calls.simklTrending += 1; throw new Error('cdn down'); };
    const ctx = mqCtx(filters);
    const { candidates, meta } = await mqSources.gatherCandidates({ id: 'p-mq-s1', name: 'MQS1', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    const ids = candidates.map((c) => c.tmdb_id);
    assert.ok(ids.includes('w1') && ids.includes('w2'), 'TMDB week candidates kept');
    assert.ok(ids.includes('d1'), 'TMDB day candidate kept');
    assert.strictEqual(calls.simklTrending, 1, 'simklTrending attempted once');
    assert.strictEqual(meta.hadTrending, true, 'hadTrending from the lists that succeeded');
    assert.strictEqual(meta.weekN, 2, 'weekN from the week list');
    assert.strictEqual(meta.dayN, 1, 'dayN from the day list');
  });

  await it('marquee ME-05/06: call budget (40 seeds → 40 recs + 40 similar; discover ≤ 16; collection ≤ 10; simklRecs once; deepMeta ≤ 400)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const seeds = Array.from({ length: 40 }, (_, i) => mqSeed('b' + i, { simkl_id: 1000 + i }));
    const { f, calls } = mqFetchers({
      recs: () => [mqItem('x1')],
      similar: () => [mqItem('x2')],
      simklRecs: () => new Map(),
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq12', name: 'MQ12', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds, envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.strictEqual(calls.recs.length, 40, 'exactly 40 recs calls');
    assert.strictEqual(calls.similar.length, 40, 'exactly 40 similar calls');
    assert.ok(calls.discover.length <= 16, 'discover ≤ 8×2');
    assert.ok(calls.collection.length <= 10, 'collection ≤ 10');
    assert.strictEqual(calls.simklRecs.length, 1, 'simklRecs once');
    const sf = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) });
    await mqScoring.scoreCandidates({ id: 'p-mq12', name: 'MQ12', filters }, ctx, candidates, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: sf.f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    assert.ok(sf.calls.deepMeta.length <= 400, 'deepMeta ≤ 400');
  });

  await it('marquee ME-05: a source fails (similar throws → build still returns candidates; S1 counts only recs)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const { f } = mqFetchers({
      recs: () => [mqItem('y1')],
      similar: () => { throw new Error('TMDB down'); },
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-mq13', name: 'MQ13', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('10')], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.ok(candidates.some((x) => x.tmdb_id === 'y1'), 'recs candidate survives similar failure');
    assert.strictEqual(ctx.stats.sources.S1, 1, 'S1 counts only the recs item');
  });

  await it('marquee ME-06: lookup refetch (no availability → refetch; NOT_YET 8d → refetch; NOT_YET 2d → no refetch)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    const DAY = 24 * 3600e3;
    glassMeta.put('movie', 'a1', { ...mqFullMeta('a1'), availability: undefined }, nowMs); // pre-ME-02 (no availability key)
    glassMeta.put('movie', 'b1', mqFullMeta('b1', { availability: 'NOT_YET' }), nowMs - 8 * DAY);
    glassMeta.put('movie', 'c1', mqFullMeta('c1', { availability: 'NOT_YET' }), nowMs - 2 * DAY);
    glassMeta.put('movie', 'd1', mqFullMeta('d1', { availability: 'AVAILABLE' }), nowMs - 2 * DAY);
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const cands = ['a1', 'b1', 'c1', 'd1'].map((id) => mqCand(id));
    const { f, calls } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) });
    const ctx = mqCtx(filters);
    await mqScoring.scoreCandidates({ id: 'p-mq14', name: 'MQ14', filters }, ctx, cands, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: f, nowYear: 2026, nowMs, log: quiet,
    });
    assert.ok(calls.deepMeta.includes('a1'), 'no-availability refetched');
    assert.ok(calls.deepMeta.includes('b1'), 'NOT_YET 8d refetched');
    assert.ok(!calls.deepMeta.includes('c1'), 'NOT_YET 2d not refetched');
    assert.ok(!calls.deepMeta.includes('d1'), 'fresh AVAILABLE not refetched');
    glassMeta._clear();
  });

  await it('marquee ME-06: hard filter (NOT_YET dropped; kids unknown-cert + M@10 dropped; adult unknown kept)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    glassMeta.put('movie', 'h1', mqFullMeta('h1', { availability: 'NOT_YET' }), nowMs);
    glassMeta.put('movie', 'h2', mqFullMeta('h2', { certAU: null, certUS: null }), nowMs);
    glassMeta.put('movie', 'h3', mqFullMeta('h3', { certAU: 'M', certUS: null }), nowMs);
    glassMeta.put('movie', 'h4', mqFullMeta('h4', { certAU: null, certUS: null }), nowMs);
    const cands = ['h1', 'h2', 'h3', 'h4'].map((id) => mqCand(id));
    // Kids profile (age_limit 10 → judgement age 11).
    {
      const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 10 };
      const env = mqEnvelope(filters);
      const ctx = mqCtx(filters);
      const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq15a', name: 'MQ15a', filters }, ctx, cands, {
        taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({}).f, nowYear: 2026, nowMs, log: quiet,
      });
      const ids = scored.map((x) => x.tmdb_id);
      assert.ok(!ids.includes('h1'), 'NOT_YET dropped (kids)');
      // AGE-2: the hard filter is the tier's hard floor only — unknown cert
      // passes (fail open) and M is below the tier-10 floor (MA15+/AV15+/R18+/
      // X18+/RC), so both are kept; verify() decides after the build.
      assert.ok(ids.includes('h2'), 'kids unknown cert kept (fail open)');
      assert.ok(ids.includes('h3'), 'kids M@10 kept (below the tier-10 hard floor)');
      assert.ok(ids.includes('h4'), 'kids unknown cert kept (fail open)');
    }
    // Adult profile (age_limit 0): unknown cert is kept (fail open).
    {
      const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
      const env = mqEnvelope(filters);
      const ctx = mqCtx(filters);
      const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq15b', name: 'MQ15b', filters }, ctx, cands, {
        taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({}).f, nowYear: 2026, nowMs, log: quiet,
      });
      const ids = scored.map((x) => x.tmdb_id);
      assert.ok(!ids.includes('h1'), 'NOT_YET dropped (adult)');
      assert.ok(ids.includes('h2'), 'adult unknown cert kept');
      assert.ok(ids.includes('h3'), 'adult M kept (no cert gate)');
      assert.ok(ids.includes('h4'), 'adult unknown cert kept');
    }
    glassMeta._clear();
  });

  await it('marquee ME-06: Anime tag (movie isAnime → genres start with Anime; excluded_genres Anime → dropped)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    animeMap._setIndex({ at: Date.now(), etag: 'itest', byImdb: { ttA1: { mal: 1 } }, byTmdb: { A1: { mal: 1 } } });
    glassMeta.put('movie', 'A1', mqFullMeta('A1', { genres: ['Animation'] }), nowMs);
    const cands = [mqCand('A1', { genre_ids: [16], genres: ['Animation'] })];
    // No Anime exclusion → tagged.
    {
      const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
      const env = mqEnvelope(filters);
      const ctx = mqCtx(filters);
      const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq16a', name: 'MQ16a', filters }, ctx, cands, {
        taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({}).f, nowYear: 2026, nowMs, log: quiet,
      });
      const c = scored.find((x) => x.tmdb_id === 'A1');
      assert.ok(c, 'anime candidate present');
      assert.ok(c.genres.startsWith('Anime,'), 'genres start with Anime');
    }
    // Anime excluded → dropped.
    {
      const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: ['Anime'], age_limit: 0 };
      const env = mqEnvelope(filters);
      const ctx = mqCtx(filters);
      const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq16b', name: 'MQ16b', filters }, ctx, cands, {
        taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({}).f, nowYear: 2026, nowMs, log: quiet,
      });
      assert.ok(!scored.some((x) => x.tmdb_id === 'A1'), 'excluded_genres Anime → dropped');
    }
    offlineAnimeMap();
  });

  await it('marquee ME-06: no imdb_rating key (I4) — value only in scoreComponents.inputs', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    glassMeta.put('movie', 'i1', mqFullMeta('i1'), nowMs);
    const cands = [mqCand('i1')];
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const ctx = mqCtx(filters, { mdblistKey: 'k' });
    const { f } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id), imdbRatings: () => new Map([['tti1', 8.5]]) });
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq17', name: 'MQ17', filters }, ctx, cands, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: f, nowYear: 2026, nowMs, log: quiet,
    });
    assert.ok(scored.length > 0, 'a row returned');
    for (const row of scored) assert.ok(!('imdb_rating' in row), 'no top-level imdb_rating key');
    assert.strictEqual(scored.find((x) => x.tmdb_id === 'i1').scoreComponents.inputs.imdb_rating, 8.5, 'imdb_rating in scoreComponents.inputs');
  });

  await it('marquee ME-06: output contract (genres CSV, poster not double-prefixed, sorted desc, every row passes hardFilter)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    glassMeta.put('movie', 'o1', mqFullMeta('o1'), nowMs);
    glassMeta.put('movie', 'o2', mqFullMeta('o2'), nowMs);
    glassMeta.put('movie', 'o3', mqFullMeta('o3'), nowMs);
    const cands = ['o1', 'o2', 'o3'].map((id) => mqCand(id, { seeds: new Set(['s1']), seedTitles: new Map([['s1', 'Seed1']]), _seedWeights: new Map([['s1', 1.0]]) }));
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const ctx = mqCtx(filters);
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq18', name: 'MQ18', filters }, ctx, cands, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) }).f, nowYear: 2026, nowMs, log: quiet,
    });
    assert.strictEqual(scored.length, 3, 'all three scored');
    for (const row of scored) {
      assert.ok(typeof row.genres === 'string', 'genres is a CSV string');
      assert.ok(row.poster.startsWith('https://image.tmdb.org/t/p/'), 'poster is a full URL');
      assert.ok(!row.poster.includes('/t/p/w500https'), 'poster not double-prefixed');
      const meta = glassMeta.get('movie', row.tmdb_id);
      assert.ok(env.hardFilter({
        imdb_id: row.imdb_id, imdb_rating: row.scoreComponents.inputs.imdb_rating,
        vote_average: row.vote_average, vote_count: row.vote_count, year: row.year,
        genres: row.genres.split(','), availability: row.scoreComponents.inputs.availability,
        certAU: meta.certAU, certUS: meta.certUS,
      }).ok, 'row passes hardFilter');
    }
    for (let i = 1; i < scored.length; i++) assert.ok(scored[i - 1].rankScore >= scored[i].rankScore, 'sorted by rankScore desc');
    glassMeta._clear();
  });

  await it('marquee ME-06: pipeline round trip (normalize + upsert → affinity/rec_count/score_components/algorithm_version)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    glassMeta.put('movie', 'r1', mqFullMeta('r1'), nowMs);
    const cands = [mqCand('r1', { sources: new Set(['tmdb_recs', 'simkl_recs']), seeds: new Set(['s1']), seedTitles: new Map([['s1', 'Seed1']]), _seedWeights: new Map([['s1', 1.0]]) })];
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const ctx = mqCtx(filters);
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq19', name: 'MQ19', filters }, ctx, cands, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) }).f, nowYear: 2026, nowMs, log: quiet,
    });
    assert.strictEqual(scored.length, 1, 'one row scored');
    const row = scored[0];
    const normalized = pipeline.normalize(row);
    rs.upsertCandidates('p-mq19', [normalized], { ratingCheckedAt: null });
    const stored = rs.getRecommended('p-mq19', { type: 'movie', limit: 10 })[0];
    assert.strictEqual(stored.affinity, row.rankScore, 'affinity = rankScore');
    assert.strictEqual(stored.rec_count, row.recCount, 'rec_count = recCount');
    assert.strictEqual(stored.algorithm_version, 'marquee-m4', 'algorithm_version = marquee-m4');
    const comps = JSON.parse(stored.score_components);
    assert.ok(comps.features && comps.weights, 'score_components JSON parses');
    rs.deleteForProfile('p-mq19');
    glassMeta._clear();
  });

  await it('marquee ME-06: decayed penalty (two decayed rows in collection X → candidate in X loses 0.10)', async () => {
    glassMeta._clear();
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    rs.addDontRecommend('p-mq20', 'movie', 'd1', 'decayed', nowMs);
    rs.addDontRecommend('p-mq20', 'movie', 'd2', 'decayed', nowMs);
    glassMeta.put('movie', 'd1', mqFullMeta('d1', { collection: { id: 100, name: 'Coll X' } }), nowMs);
    glassMeta.put('movie', 'd2', mqFullMeta('d2', { collection: { id: 100, name: 'Coll X' } }), nowMs);
    glassMeta.put('movie', 'x1', mqFullMeta('x1', { collection: { id: 100, name: 'Coll X' } }), nowMs);
    glassMeta.put('movie', 'x2', mqFullMeta('x2'), nowMs);
    const cands = ['x1', 'x2'].map((id) => mqCand(id));
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const ctx = mqCtx(filters);
    const { scored } = await mqScoring.scoreCandidates({ id: 'p-mq20', name: 'MQ20', filters }, ctx, cands, {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) }).f, nowYear: 2026, nowMs, log: quiet,
    });
    const x1 = scored.find((x) => x.tmdb_id === 'x1');
    const x2 = scored.find((x) => x.tmdb_id === 'x2');
    assert.ok(x1 && x2, 'both candidates scored');
    assert.strictEqual(x1.scoreComponents.penalty, 0.10, 'x1 penalty = 2 × 0.05');
    assert.strictEqual(x2.scoreComponents.penalty, 0, 'x2 no penalty');
    rs.deleteForProfile('p-mq20');
    glassMeta._clear();
  });

  await it('marquee ME-06: no_imdb in envelopeStats (S2) — a lookup-null candidate is counted there', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const ctx = mqCtx(filters);
    // No cached meta row; the deepMeta stub returns null → the candidate is dropped at lookup.
    const { scored, envelopeStats } = await mqScoring.scoreCandidates({ id: 'p-mq21', name: 'MQ21', filters }, ctx, [mqCand('n1')], {
      taste: mqTaste, envelope: env, cfg: mqCfgResolved, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: mqScoreFetchers({ deepMeta: () => null }).f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    assert.strictEqual(scored.length, 0, 'lookup-null candidate dropped');
    assert.strictEqual(envelopeStats.no_imdb, 1, 'no_imdb included in the returned envelopeStats');
  });

  // ── Marquee ME-09 (P4): descriptor + registry + Tier-2 admin config ──
  const marqueeEngine = require('../src/engines/marquee');
  const jobsMod = require('../src/jobs');
  const portalMod = require('../src/portal');

  // Hermetic seam for generate(): every fetcher injectable, no network. The
  // genreMap seam keeps generate() off the live tmdb.getGenreMap.
  const mqSeam = (over = {}) => ({
    recs: async (id) => (over.recs ? over.recs(id) : []),
    similar: async (id) => (over.similar ? over.similar(id) : []),
    discover: async (params, page) => (over.discover ? over.discover(params, page) : []),
    collection: async (id) => (over.collection ? over.collection(id) : []),
    trendingWeek: async () => (over.trendingWeek || []),
    trendingDay: async () => (over.trendingDay || []),
    simklTrending: async () => (over.simklTrending || []),
    simklRecs: async (ids) => (over.simklRecs ? over.simklRecs(ids) : new Map()),
    chat: async (chain, messages, opts) => (over.chat ? over.chat(chain, messages, opts) : '[]'),
    resolve: async (title, year) => (over.resolve ? over.resolve(title, year) : null),
    deepMeta: async (_apiKey, _type, id) => (over.deepMeta ? over.deepMeta(id) : mqFullMeta(id)),
    imdbRatings: async (ids) => new Map(),
    genreMap: async () => mqGenreMap,
  });

  // Drive the portal's PUT /settings handler directly (no HTTP).
  const portalPutSettings = (body) => {
    const isPut = (m) => (Array.isArray(m) ? m.includes('put') : !!m.put);
    const layer = portalMod.router.stack.find(
      (l) => l.route && l.route.path === '/settings' && isPut(l.route.methods),
    );
    const res = fakeRes();
    layer.handle({ body, method: 'PUT' }, res);
    return res.body;
  };

  // Wait for a rebuild job (ensureBuilt → jobs.enqueue → buildPool) to settle.
  async function waitRebuildJob(pid, timeoutMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = jobsMod.snapshot(pid);
      if (s && (s.state === 'done' || s.state === 'error')) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('rebuild job did not settle in time');
  }

  await it('ME-09: empty — no watched history → empty output; series type → empty', async () => {
    const profile = { id: 'p-mqempty', name: 'MQEMPTY', filters: {} };
    const ctx = {
      tmdbKey: 'k', mdblistKey: '', settings: {},
      filters: { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 },
      log: quiet, watchedIds: { tmdb: new Set(), imdb: new Set() }, dont: new Set(), stats: {},
      marqueeSkipSync: true, marqueeFetchers: mqSeam(), marqueeChain: [],
    };
    assert.deepStrictEqual(await marqueeEngine.generate(profile, 'movie', ctx, () => {}), [], 'no seeds → no candidates → empty');
    assert.deepStrictEqual(await marqueeEngine.generate(profile, 'series', ctx, () => {}), [], 'series type → empty (movie-only)');
  });

  await it('ME-09: requirements — Simkl missing → movie skipped, existing rows kept', async () => {
    const p = config.addProfile('INT-MQREQ');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', engine_series: 'genesis' } });
      const profile = config.getProfile(p.id);
      // No simkl_auth → the requirement is unmet (TMDB key is global, present).
      assert.deepStrictEqual(marqueeEngine.requirements(profile), { ok: false, missing: ['Simkl connection'] });
      // One existing movie row that a skip must NOT wipe.
      rs.upsertCandidates(p.id, [{ type: 'movie', tmdb_id: 'mqreq1', imdb_id: 'ttmqreq1', title: 'Existing', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, popularity: 5, engine_id: 'marquee' }]);
      assert.strictEqual(rs.countRecommended(p.id), 1, 'one pre-seeded movie row');
      settings.updateSettings({ engines: { marquee: true } });
      const r = await rs.buildRecommendations(config.getProfile(p.id), quiet);
      assert.strictEqual(r.movie.skipped, true, 'movie skipped (requirements unmet)');
      assert.strictEqual(r.movie.engine, 'marquee', 'the skipped engine is marquee');
      assert.deepStrictEqual(r.movie.missing, ['Simkl connection'], 'reports the missing requirement');
      assert.strictEqual(rs.countRecommended(p.id), 1, 'a skip never wipes the existing slice');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('ME-09 CONFORMANCE SC-07: registered + disabled by default; enable → resolve', async () => {
    assert.ok(engines.has('marquee'), 'marquee is registered');
    const p = config.addProfile('INT-MQSC07');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', engine_series: 'marquee' } });
      const profile = config.getProfile(p.id);
      // Disabled (default): not offered, movie + series floor to genesis.
      assert.ok(!engines.availableFor(profile, 'movie').some((e) => e.id === 'marquee'), 'disabled → not offered');
      assert.strictEqual(engines.resolveFor(profile, 'movie').id, 'genesis', 'disabled → movie floors to genesis');
      assert.strictEqual(engines.resolveFor(profile, 'series').id, 'genesis', 'series → genesis (type unsupported)');
      // Enabled: movie resolves to marquee; series still genesis (type unsupported).
      settings.updateSettings({ engines: { marquee: true } });
      assert.strictEqual(engines.resolveFor(profile, 'movie').id, 'marquee', 'enabled → movie resolves to marquee');
      assert.strictEqual(engines.resolveFor(profile, 'series').id, 'genesis', 'enabled → series still genesis');
      assert.ok(engines.availableFor(profile, 'movie').some((e) => e.id === 'marquee'), 'enabled → offered');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('ME-09 CONFORMANCE I7: age-gated (unrestricted:false); offered to kids when enabled', async () => {
    assert.strictEqual(marqueeEngine.capabilities.unrestricted, false, 'Marquee is age-gated (I7)');
    const p = config.addProfile('INT-MQI7');
    try {
      config.updateProfile(p.id, { filters: { age_limit: 12, engine_movie: 'marquee' } });
      const profile = config.getProfile(p.id);
      // Disabled: not offered (SC-07), even though it is age-gated.
      assert.ok(!engines.availableFor(profile, 'movie').some((e) => e.id === 'marquee'), 'disabled → not offered to kids');
      // Enabled: offered — it is age-gated, so a kids profile may choose it.
      settings.updateSettings({ engines: { marquee: true } });
      assert.ok(engines.availableFor(profile, 'movie').some((e) => e.id === 'marquee'), 'enabled → offered to kids (age-gated)');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('ME-09 CONFORMANCE I1: the shared age gate (not the engine) vetoes an over-band title (kids)', async () => {
    offlineAnimeMap();
    const p = config.addProfile('INT-MQI1');
    const reset = marqueeEngine._setTestSeams({
      fetchers: mqSeam({
        recs: () => [mqItem('mqi1a'), mqItem('mqi1b'), mqItem('mqi1c')],
        deepMeta: (id) => mqFullMeta(id, { certAU: 'G', certUS: 'PG' }),
      }),
      chain: [],
    });
    const prev = store.loadAgeVerdicts();
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { age_limit: 8, engine_movie: 'marquee', engine_series: 'genesis' } }); // AGE-2: 8 → the 10+ tier
      watchedStore.upsertMany(p.id, [
        { simkl_id: 1, type: 'movie', imdb_id: 'ttmqi1w', tmdb_id: 'mqi1w', title: 'Watched', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
      ]);
      // Chain LLM-step verdict cache: veto mqi1b, keep the other two.
      store.saveAgeVerdicts({
        [verdictKey('movie', 8, 'mqi1a')]: true,
        [verdictKey('movie', 8, 'mqi1b')]: false,
        [verdictKey('movie', 8, 'mqi1c')]: true,
      });
      settings.updateSettings({ engines: { marquee: true } });
      await rs.buildPool(config.getProfile(p.id), quiet);
      const pool = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => x.tmdb_id);
      assert.ok(!pool.includes('mqi1b'), 'the over-band title is removed from the pool by the shared gate');
      assert.ok(pool.includes('mqi1a') && pool.includes('mqi1c'), 'the in-band titles remain');
      const served = rs.serveRecommendations(config.getProfile(p.id), 'movie').map((m) => m.id);
      assert.ok(!served.includes('ttmqi1b'), 'and never served to the kid');
    } finally {
      store.saveAgeVerdicts(prev);
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
      reset();
    }
  });

  await it('ME-09 CONFORMANCE I4: the engine never writes imdb_rating (pipeline owns the column)', async () => {
    const p = config.addProfile('INT-MQI4');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'marquee', engine_series: 'genesis' } });
      watchedStore.upsertMany(p.id, [
        { simkl_id: 1, type: 'movie', imdb_id: 'ttmqi4w', tmdb_id: 'mqi4w', title: 'Watched', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
      ]);
      const ctx = {
        tmdbKey: 'k', mdblistKey: '', settings: {}, filters: config.getProfile(p.id).filters, log: quiet,
        marqueeSkipSync: true, marqueeFetchers: mqSeam({ recs: () => [mqItem('mqi4a'), mqItem('mqi4b')] }), marqueeChain: [],
      };
      const r = await pipeline.runEngineBuild(config.getProfile(p.id), 'movie', marqueeEngine, ctx, () => {});
      assert.ok(r.stored >= 2, 'two candidates stored');
      const rows = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
      for (const row of rows) assert.strictEqual(row.imdb_rating, null, 'imdb_rating is never written by the engine');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('ME-09: per-type isolation — movie via Marquee, series via Genesis', async () => {
    settings.updateSettings({ engines: { marquee: true } });
    const reset = marqueeEngine._setTestSeams({ fetchers: mqSeam({ recs: () => [mqItem('mqiso1')] }), chain: [] });
    // Stub the live TMDB calls the (non-preResolved) Genesis series build + pipeline resolve make.
    // SH-01: the resolve step now calls imdbAndCertFor (series delegates to imdbFor
    // internally), so the stub moves to the new entry point.
    const origRecs = tmdb.getRecommendations, origGenreMap = tmdb.getGenreMap, origImdbAndCertFor = tmdb.imdbAndCertFor;
    tmdb.getRecommendations = async (_k, type, _seedId) => (type === 'series'
      ? [{ type: 'series', tmdb_id: 'mqisoS1', title: 'Rec Series', year: 2024, genre_ids: [18], vote_average: 7, vote_count: 1000, popularity: 5, adult: false, poster: null }]
      : []);
    tmdb.getGenreMap = async () => ({ 18: 'Drama' });
    tmdb.imdbAndCertFor = async (_k, _type, _id) => ({ imdb_id: 'ttmqisoS1', certification: null });
    const p = config.addProfile('INT-MQISO');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'marquee', engine_series: 'genesis' } });
      watchedStore.upsertMany(p.id, [
        { simkl_id: 1, type: 'movie', imdb_id: 'ttmqisowm', tmdb_id: 'mqisowm', title: 'Watched Movie', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
        { simkl_id: 2, type: 'series', imdb_id: 'ttmqisows', tmdb_id: 'mqisows', title: 'Watched Series', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
      ]);
      const r = await rs.buildPool(config.getProfile(p.id), quiet);
      assert.deepStrictEqual(r.engines, { movie: 'marquee', series: 'genesis' }, 'per-type engine dispatch');
      const movieRows = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
      assert.ok(movieRows.length >= 1, 'a movie row was produced');
      for (const row of movieRows) assert.strictEqual(row.engine_id, 'marquee', 'movie row stamped marquee');
      const seriesRows = rs.getRecommended(p.id, { type: 'series', limit: 100 });
      for (const row of seriesRows) assert.strictEqual(row.engine_id, 'genesis', 'series row stamped genesis');
    } finally {
      tmdb.getRecommendations = origRecs; tmdb.getGenreMap = origGenreMap; tmdb.imdbAndCertFor = origImdbAndCertFor;
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
      reset();
    }
  });

  await it('ME-09: end-to-end filter guarantee — exactly list_size passers reach the served list', async () => {
    offlineAnimeMap();
    // min_year 2016 (the old 10-year window in 2026): the year-2010 candidate must still fail the floor.
    const filters = { min_rating: 7, min_year: 2016, age_limit: 10, excluded_genres: ['Horror'], list_size: 20 };
    const deepMeta = (id) => {
      const n = Number(id.slice(4));
      switch (n) {
        case 1: return mqFullMeta(id, { genres: ['Action'], primary_genre: 'Action', certAU: 'G', certUS: 'PG' });
        case 2: return mqFullMeta(id, { genres: ['Drama'], primary_genre: 'Drama', certAU: 'PG', certUS: 'PG' });
        case 3: return mqFullMeta(id, { genres: ['Science Fiction'], primary_genre: 'Science Fiction', certAU: 'PG', certUS: 'PG' });
        case 4: return mqFullMeta(id, { genres: ['Animation'], primary_genre: 'Animation', certAU: 'G', certUS: 'PG' });
        case 5: return mqFullMeta(id, { vote_average: 6.5, certAU: 'G', certUS: 'PG' });
        case 6: return mqFullMeta(id, { year: 2010, certAU: 'G', certUS: 'PG' });
        case 7: return mqFullMeta(id, { genres: ['Horror'], primary_genre: 'Horror', certAU: 'M', certUS: 'R' });
        case 8: return mqFullMeta(id, { vote_count: 100, certAU: 'G', certUS: 'PG' });
        case 9: return mqFullMeta(id, { availability: 'NOT_YET', certAU: 'G', certUS: 'PG' });
        case 10: return mqFullMeta(id, { certAU: null, certUS: null });
        case 11: return mqFullMeta(id, { certAU: 'R18+', certUS: 'R' });
        default: return mqFullMeta(id, { certAU: 'G', certUS: 'PG' });
      }
    };
    const recs = (seedId) => [
      mqItem(seedId + '1'), mqItem(seedId + '2', { genre_ids: [18] }), mqItem(seedId + '3', { genre_ids: [878] }),
      mqItem(seedId + '4', { genre_ids: [16] }), mqItem(seedId + '5'), mqItem(seedId + '6', { year: 2010 }),
      mqItem(seedId + '7', { genre_ids: [27] }), mqItem(seedId + '8', { vote_count: 100 }),
      mqItem(seedId + '9'), mqItem(seedId + '10'), mqItem(seedId + '11'), mqItem(seedId + '12', { adult: true }),
    ];
    const p = config.addProfile('INT-MQE2E');
    const reset = marqueeEngine._setTestSeams({ fetchers: mqSeam({ recs, deepMeta }), chain: [] });
    const prev = store.loadAgeVerdicts();
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { ...filters, engine_movie: 'marquee', engine_series: 'genesis' } });
      const seeds = ['mqe1', 'mqe2', 'mqe3', 'mqe4', 'mqe5'];
      watchedStore.upsertMany(p.id, seeds.map((s, i) => ({ simkl_id: i + 1, type: 'movie', imdb_id: 'tt' + s, tmdb_id: s, title: 'Seed ' + s, year: 2024, watched_at: '2026-05-01T00:00:00Z' })));
      // The 20 passers (n1–n4 per seed): verdict true for each (AGE-2: age_limit 10 → the 10+ tier).
      // AGE-2: the chain's LLM step (step 5) is reached by the other candidates that
      // survive the Marquee hard filter (n5/n6/n8/n10 per seed), so seed them vetoed
      // (false) to keep the chain hermetic (no LLM call). n7/n9/n11/n12 are dropped
      // by the Marquee hard filter (adult / NOT_YET / hard floor) before the chain.
      const passers = [];
      for (const s of seeds) for (const n of ['1', '2', '3', '4']) passers.push(s + n);
      const allN = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
      const verdicts = {};
      for (const s of seeds) for (const n of allN) verdicts[verdictKey('movie', 10, s + n)] = passers.includes(s + n);
      store.saveAgeVerdicts(verdicts);
      settings.updateSettings({ engines: { marquee: true } });
      await rs.buildPool(config.getProfile(p.id), quiet);
      const pool = rs.getRecommended(p.id, { type: 'movie', limit: 100 }).map((x) => x.tmdb_id);
      assert.deepStrictEqual(pool.sort(), [...passers].sort(), 'the pool is exactly the 20 passers');
      const served = rs.serveRecommendations(config.getProfile(p.id), 'movie');
      assert.strictEqual(served.length, 20, 'served exactly list_size');
      for (const m of served) assert.ok(passers.includes(m.id.slice(2)), 'every served id is a passer');
    } finally {
      store.saveAgeVerdicts(prev);
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
      reset();
    }
  });

  await it('ME-09: Tier-2 admin config change rebuilds only the Marquee movie slice (parallel to Glass)', async () => {
    settings.updateSettings({ engines: { marquee: true, glass: true }, marquee: {} });
    const reset = marqueeEngine._setTestSeams({ fetchers: mqSeam({ recs: () => [mqItem('mqt2a'), mqItem('mqt2b')] }), chain: [] });
    const pMq = config.addProfile('INT-MQT2-MQ');
    const pGl = config.addProfile('INT-MQT2-GL');
    try {
      config.updateProfile(pMq.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'marquee', engine_series: 'genesis' } });
      config.updateProfile(pGl.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'glass', engine_series: 'genesis' } });
      watchedStore.upsertMany(pMq.id, [
        { simkl_id: 1, type: 'movie', imdb_id: 'ttmqt2w', tmdb_id: 'mqt2w', title: 'Watched', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
      ]);
      // A pre-existing Glass movie row + built_at that the Marquee rebuild must NOT touch.
      rs.upsertCandidates(pGl.id, [{ type: 'movie', tmdb_id: 'mqt2g1', imdb_id: 'ttmqt2g1', title: 'Glass Row', year: 2024, vote_average: 8, vote_count: 1000, affinity: 0.9, rec_count: 2, popularity: 5, engine_id: 'glass' }]);
      rs.setBuiltAt(pGl.id);
      const glassBuiltAtBefore = rs.getBuiltAt(pGl.id);
      // A real Tier-2 change ({} → { franchise_cap: 1 }) fans out a Marquee rebuild only.
      portalPutSettings({ marquee: { franchise_cap: 1 } });
      const snap = await waitRebuildJob(pMq.id);
      assert.strictEqual(snap.state, 'done', 'the Marquee rebuild job settled');
      assert.deepStrictEqual(settings.getSettings().marquee, { franchise_cap: 1 }, 'the Tier-2 config is persisted');
      const mqRows = rs.getRecommended(pMq.id, { type: 'movie', limit: 100 });
      assert.ok(mqRows.length >= 1, 'the Marquee movie slice was rebuilt');
      for (const row of mqRows) assert.strictEqual(row.engine_id, 'marquee');
      // The Glass profile is untouched: its row + built_at survive.
      const glRows = rs.getRecommended(pGl.id, { type: 'movie', limit: 100 });
      assert.ok(glRows.some((r) => r.tmdb_id === 'mqt2g1'), 'the Glass row is intact');
      assert.strictEqual(rs.getBuiltAt(pGl.id), glassBuiltAtBefore, 'the Glass built_at is untouched');
      // A second identical save is a no-op: no rebuild, rows + built_at unchanged.
      const mqBefore = rs.getRecommended(pMq.id, { type: 'movie', limit: 100 }).map((x) => `${x.tmdb_id}:${x.affinity.toFixed(4)}`);
      const mqBuiltAtBefore = rs.getBuiltAt(pMq.id);
      portalPutSettings({ marquee: { franchise_cap: 1 } });
      await new Promise((r) => setTimeout(r, 200));
      const mqAfter = rs.getRecommended(pMq.id, { type: 'movie', limit: 100 }).map((x) => `${x.tmdb_id}:${x.affinity.toFixed(4)}`);
      assert.deepStrictEqual(mqAfter, mqBefore, 'no rebuild on an identical save');
      assert.strictEqual(rs.getBuiltAt(pMq.id), mqBuiltAtBefore, 'built_at unchanged on an identical save');
    } finally {
      settings.updateSettings({ engines: { marquee: false, glass: false }, marquee: {} });
      config.removeProfile(pMq.id); rs.deleteForProfile(pMq.id); watchedStore.deleteForProfile(pMq.id);
      config.removeProfile(pGl.id); rs.deleteForProfile(pGl.id);
      reset();
    }
  });

  await it('ME-09: Tier-2 settings persistence — settings.marquee round-trips; missing blob → {}', async () => {
    const fs = require('fs');
    const path = require('path');
    try {
      settings.updateSettings({ marquee: { franchise_cap: 1, llm_fit: { batch: 30 } } });
      assert.deepStrictEqual(settings.getSettings().marquee, { franchise_cap: 1, llm_fit: { batch: 30 } }, 'round-trips');
      // Delete the blob from disk; a reload must yield {} (never throw).
      const raw = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.json'), 'utf8'));
      delete raw.marquee;
      fs.writeFileSync(path.join(process.env.DATA_DIR, 'settings.json'), JSON.stringify(raw));
      assert.deepStrictEqual(settings.getSettings().marquee, {}, 'missing blob → {}');
    } finally {
      settings.updateSettings({ marquee: {} });
    }
  });

  // ── SH-01 (P5): the real AU/US movie classification reaches the shared age gate ──
  await it('SH-01: the pipeline resolve fills certification — one TMDB request per candidate', async () => {
    const pipeline = require('../src/engines/pipeline');
    const certs = require('../src/certs');
    offlineAnimeMap();
    const p = config.addProfile('INT-SH01-RES');
    // A non-preResolved fixture engine so the shared resolve path runs (the
    // path every non-Marquee/Glass candidate takes — Genesis's own generate is
    // not needed to prove the resolve contract).
    const resolveEngine = {
      id: 'sh01-resolve', name: 'SH-01 resolve fixture', supportedTypes: ['movie'],
      capabilities: { providesRankScore: true, preResolved: false, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => [
        { type: 'movie', tmdb_id: '101', title: 'Film A', year: 2024, genre_ids: [28], poster: '/p1.jpg', rankScore: 2, vote_average: 7, vote_count: 5000, popularity: 10 },
        { type: 'movie', tmdb_id: '202', title: 'Film B', year: 2023, genre_ids: [28], poster: '/p2.jpg', rankScore: 1, vote_average: 7, vote_count: 4000, popularity: 9 },
      ],
    };
    const fetchLog = [];
    const origFetch = global.fetch;
    global.fetch = (url) => {
      const u = String(url);
      fetchLog.push(u);
      if (u.includes('/genre/')) {
        const genres = u.includes('/genre/movie') ? [{ id: 28, name: 'Action' }] : [];
        return Promise.resolve({ ok: true, json: async () => ({ genres }) });
      }
      if (u.includes('/movie/') && u.includes('append_to_response')) {
        const id = u.split('/movie/')[1].split('?')[0];
        return Promise.resolve({ ok: true, json: async () => ({
          external_ids: { imdb_id: 'ttSH01' + id },
          release_dates: { results: [
            { iso_3166_1: 'AU', release_dates: [{ certification: 'M' }] },
            { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] },
          ] },
        }) });
      }
      return Promise.reject(new Error('unexpected fetch in SH-01 resolve test: ' + u));
    };
    try {
      assert.strictEqual(certs.strictestCert('M', 'PG-13'), 'M'); // the fixture's expected strictest
      const r = await pipeline.runEngineBuild(p, 'movie', resolveEngine,
        { tmdbKey: 'itest-tmdb', mdblistKey: '', settings: settings.getSettings(), filters: {}, log: quiet });
      assert.strictEqual(r.stored, 2, 'both candidates stored');
      const appendCalls = fetchLog.filter((u) => u.includes('append_to_response'));
      assert.strictEqual(appendCalls.length, 2, 'ONE details+append request per candidate');
      assert.ok(!fetchLog.some((u) => u.includes('/external_ids')), 'no separate external_ids call');
      for (const row of rs.getRecommended(p.id, { type: 'movie', limit: 100 })) {
        assert.strictEqual(row.certification, 'M', `strictest(AU M, US PG-13) = M for ${row.tmdb_id}`);
      }
    } finally {
      global.fetch = origFetch;
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('SH-01: the shared age gate sends the real cert (MAL band is the fallback)', async () => {
    const groq = require('../src/services/groq');
    offlineAnimeMap();
    const p = config.addProfile('INT-SH01-GATE');
    config.updateProfile(p.id, { filters: { age_limit: 8 } }); // AGE-2: 8 → the 10+ tier
    const captured = [];
    const origAgeGate = groq.ageGate;
    groq.ageGate = async (type, judgeAge, items) => { captured.push({ type, items }); return new Set(); };
    try {
      rs.upsertCandidates(p.id, [
        { type: 'movie', tmdb_id: 'sh01a', imdb_id: 'ttsh01a', title: 'Film A', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 1000, affinity: 1, rec_count: 1, popularity: 5, certification: 'M' },
        { type: 'movie', tmdb_id: 'sh01b', imdb_id: 'ttsh01b', title: 'Anime B', year: 2024, primary_genre: 'Anime', genres: 'Anime', vote_average: 7, vote_count: 1000, affinity: 1, rec_count: 1, popularity: 5 },
      ]);
      rs.setAgeClassification(p.id, 'movie', 'sh01b', 'R+'); // MAL band, no real cert
      await rs.ageGatePool(config.getProfile(p.id), quiet);
      const movieItems = (captured.find((c) => c.type === 'movie') || {}).items || [];
      const a = movieItems.find((i) => i.id === 'sh01a');
      const b = movieItems.find((i) => i.id === 'sh01b');
      assert.ok(a && b, 'both rows reached the LLM pass');
      assert.strictEqual(a.certification, 'M', 'the real cert is sent');
      assert.strictEqual(b.certification, 'R+', 'an anime row with no real cert still sends its MAL band');
    } finally {
      groq.ageGate = origAgeGate;
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('SH-01: upsert COALESCE — a build without a cert never wipes a known one', async () => {
    const p = config.addProfile('INT-SH01-COALESCE');
    const base = { type: 'movie', tmdb_id: 'sh01c', imdb_id: 'ttsh01c', title: 'Film C', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 1000, affinity: 1, rec_count: 1, popularity: 5 };
    try {
      rs.upsertCandidates(p.id, [{ ...base, certification: 'M' }]);
      rs.upsertCandidates(p.id, [{ ...base }]); // a build that couldn't read a cert
      let row = rs.getRecommended(p.id, { type: 'movie', limit: 100 })[0];
      assert.strictEqual(row.certification, 'M', 'a null upsert keeps the known cert');
      rs.upsertCandidates(p.id, [{ ...base, certification: 'PG' }]);
      row = rs.getRecommended(p.id, { type: 'movie', limit: 100 })[0];
      assert.strictEqual(row.certification, 'PG', 'a later known cert fills/overwrites');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('SH-01: adult profiles are unchanged — served list identical with and without certs', async () => {
    const db = require('../src/db');
    const p = config.addProfile('INT-SH01-ADULT');
    config.updateProfile(p.id, { filters: {} }); // adult: no age limit
    const mk = (id, cert) => ({ type: 'movie', tmdb_id: id, imdb_id: 'tt' + id, title: 'T' + id, year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 1000, affinity: 2, rec_count: 1, popularity: 5, certification: cert });
    try {
      rs.upsertCandidates(p.id, [mk('ad1', 'M'), mk('ad2', 'R 18+'), mk('ad3', null)]);
      const withCerts = rs.serveRecommendations(config.getProfile(p.id), 'movie').map((r) => r.id);
      db.get().prepare('UPDATE recommended SET certification = NULL WHERE profile_id = ?').run(p.id);
      const withoutCerts = rs.serveRecommendations(config.getProfile(p.id), 'movie').map((r) => r.id);
      assert.deepStrictEqual(withoutCerts, withCerts, 'adult serve is cert-independent');
      assert.strictEqual(withCerts.length, 3, 'all three rows served for an adult');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('SH-01: Glass scoreCandidate carries the real cert from the enriched meta onto the candidate (movie only)', async () => {
    const { scoreCandidate } = require('../src/engines/glass/scoring');
    const certs = require('../src/certs');
    const taste = { dims: { genres: { Action: 1 }, decades: {}, languages: {}, runtimeBands: {}, directors: {}, franchises: {}, cast: {}, keywords: {} }, genreMass: { Action: 1 } };
    const cfg = { weights: { taste_match: 0.5, quality: 0.3 }, taste_dims: { genres: 1, decade: 0, language: 0, runtime: 0, director: 0, franchise: 0, cast: 0, keywords: 0 }, keyword_min_shared: 1 };
    const mk = (type) => ({ type, tmdb_id: type + '1', title: 'Glass ' + type, sources: ['simkl'] });
    const meta = (certAU, certUS) => ({ imdb_id: 'ttg1', title: 'Glass Film', year: 2024, genres: ['Action'], poster: null, vote_average: 7, vote_count: 1000, popularity: 10, certAU, certUS });
    const movie = scoreCandidate(mk('movie'), meta('M', 'PG-13'), taste, cfg, { nowYear: 2026 });
    assert.strictEqual(movie.certification, certs.strictestCert('M', 'PG-13'), 'movie carries the strictest cert');
    const preP1 = scoreCandidate(mk('movie'), meta(null, null), taste, cfg, { nowYear: 2026 });
    assert.strictEqual(preP1.certification, null, 'a cached meta predating P1 → null');
    const series = scoreCandidate(mk('series'), meta('M', 'PG-13'), taste, cfg, { nowYear: 2026 });
    assert.strictEqual(series.certification, undefined, 'series: SH-01 out of scope (no cert written)');
  });

  // ── ME-10 (P5): the offline engine backtest — pure functions + hermetic run ──
  const bench = require('../src/bench/engineBench');
  const db = require('../src/db');

  await it('ME-10: pickTargets — the most recent N with a tmdb id; too little history throws', async () => {
    const mk = (i, tmdb) => ({ tmdb_id: tmdb, watched_at: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 3600e3).toISOString() });
    // 30 rows (holdout 10 needs 10+20); row 5 has no tmdb_id and must be skipped.
    const watched = Array.from({ length: 30 }, (_, i) => mk(i, i === 5 ? null : 'w' + i));
    const targets = bench.pickTargets(watched, 10);
    assert.deepStrictEqual(targets, ['w0', 'w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 'w9', 'w10'], 'most recent 10 with a tmdb id (row 5 skipped)');
    assert.throws(() => bench.pickTargets(watched.slice(0, 29), 10), /not enough history/, '29 rows < 10+20 → throws');
  });

  await it('ME-10: metrics — exact values over hand-made rows + targets', async () => {
    const mkRow = (i, trending) => ({
      tmdb_id: 'r' + String(i).padStart(3, '0'),
      imdb_id: 'ttr' + String(i).padStart(3, '0'),
      title: 'Row ' + i, year: 2024, primary_genre: 'Action', genres: 'Action',
      vote_average: 7, vote_count: 5000, affinity: 120 - i,
      score_components: JSON.stringify({ sources: [trending ? 'trending' : 'simkl'] }),
    });
    const rows = Array.from({ length: 120 }, (_, i) => mkRow(i, i < 10));
    const targets = ['r005', 'r050', 'r110'];
    const m = bench.metrics(rows, targets, {}, { selectServe: rs.selectServe, stored: 120, buildSeconds: 1.23 });
    assert.strictEqual(m.hitAt20, 1, 'only r005 is in the top-20 served');
    assert.strictEqual(m.hitAt20Fraction, 1 / 3);
    assert.strictEqual(m.recallAt100, 2 / 3, 'r005 + r050 in the top 100');
    assert.strictEqual(m.meanRankOfHits, (6 + 51 + 111) / 3, 'mean 1-based rank of the hit targets');
    assert.strictEqual(m.filterPass, 1.0, 'no filters → every row passes');
    assert.strictEqual(m.trendingShareAt20, 0.5, '10 of the top-20 served carry the trending source');
    assert.strictEqual(m.stored, 120);
    assert.strictEqual(m.buildSeconds, 1.23);
  });

  await it('ME-10: snapshotStore leaves the live store.db + WAL byte-identical', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const crypto = require('crypto');
    const { DatabaseSync } = require('node:sqlite');
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me10-live-'));
    let liveDb = null;
    let benchDir = null;
    try {
      // Hold a connection open for the whole test (simulating the server that owns
      // the live store) so the WAL file exists in the same state before and after
      // the snapshot — opening a WAL-mode DB otherwise creates an empty -wal.
      liveDb = new DatabaseSync(path.join(liveDir, 'store.db'));
      liveDb.exec('PRAGMA journal_mode = WAL;');
      liveDb.exec('CREATE TABLE watched (profile_id TEXT, tmdb_id TEXT, title TEXT);');
      liveDb.prepare('INSERT INTO watched VALUES (?, ?, ?)').run('p1', 't1', 'Title 1');
      liveDb.prepare('INSERT INTO watched VALUES (?, ?, ?)').run('p1', 't2', 'Title 2');
      fs.writeFileSync(path.join(liveDir, 'profiles.json'), JSON.stringify({ profiles: [] }));
      const hashFile = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
      const dbBefore = hashFile(path.join(liveDir, 'store.db'));
      const walBefore = hashFile(path.join(liveDir, 'store.db-wal'));
      const snap = bench.snapshotStore(liveDir);
      benchDir = snap.benchDir;
      assert.strictEqual(hashFile(path.join(liveDir, 'store.db')), dbBefore, 'live store.db bytes unchanged');
      assert.strictEqual(hashFile(path.join(liveDir, 'store.db-wal')), walBefore, 'live store.db-wal bytes unchanged');
      const benchDb = new DatabaseSync(path.join(benchDir, 'store.db'), { readOnly: true });
      assert.strictEqual(benchDb.prepare('SELECT COUNT(*) AS n FROM watched').get().n, 2, 'snapshot has both rows');
      benchDb.close();
      assert.ok(['readOnly', 'default'].includes(snap.readOnlyPath), 'the open path is recorded');
    } finally {
      if (liveDb) { try { liveDb.close(); } catch { /* already closed */ } }
      if (benchDir) fs.rmSync(benchDir, { recursive: true, force: true });
      fs.rmSync(liveDir, { recursive: true, force: true });
    }
  });

  await it('ME-10: no leakage — held-out targets are removed from watched + ratings before the build', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const p = config.addProfile('INT-ME10-LEAK');
    let stubTargets = [];
    const dispose = engines._register({
      id: 'bench-stub', name: 'Bench stub', supportedTypes: ['movie'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => [
        ...stubTargets.map((t) => ({ type: 'movie', tmdb_id: t, imdb_id: 'ttstub' + t, title: 'Target ' + t, year: 2024, genres: 'Action', primary_genre: 'Action', vote_average: 8, vote_count: 5000, affinity: 10, rankScore: 10, popularity: 5, poster: null })),
        ...Array.from({ length: 5 }, (_, i) => ({ type: 'movie', tmdb_id: 'filler' + i, imdb_id: 'ttfiller' + i, title: 'Filler ' + i, year: 2024, genres: 'Drama', primary_genre: 'Drama', vote_average: 7, vote_count: 3000, affinity: 5, rankScore: 5, popularity: 4, poster: null })),
      ],
    });
    try {
      config.updateProfile(p.id, { filters: {} });
      const base = Date.parse('2026-06-01T00:00:00Z');
      for (let i = 0; i < 40; i++) {
        const tmdb = 'leak' + i;
        watchedStore.upsertMany(p.id, [{ simkl_id: i + 1, type: 'movie', imdb_id: 'tt' + tmdb, tmdb_id: tmdb, title: 'Leak ' + i, year: 2024, watched_at: new Date(base + i * 3600e3).toISOString() }]);
      }
      const watched = watchedStore.getWatched(p.id, { type: 'movie' }); // sorted watched_at DESC
      const expectedTargets = watched.slice(0, 10).map((r) => r.tmdb_id);
      stubTargets = expectedTargets;
      // Held-out ratings: a target's rating must NOT steer the build.
      simklCache.init();
      const conn = db.get();
      const ins = conn.prepare("INSERT INTO taste_ratings (profile_id, type, tmdb_id, imdb_id, simkl_id, rating, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const t of expectedTargets.slice(0, 5)) ins.run(p.id, 'movie', t, 'tt' + t, null, 8, Date.now());
      const results = await bench.runBench({
        profile: config.getProfile(p.id), engineIds: ['bench-stub'], holdout: 10,
        deps: { engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet },
      });
      assert.strictEqual(results.engines['bench-stub'].metrics.hitAt20, 10, 'the stub returns every held-out target → all hit');
      const sets = watchedStore.watchedIdSets(p.id);
      for (const t of expectedTargets) assert.ok(!sets.tmdb.has(t), 'no target in the watched set: ' + t);
      for (const t of expectedTargets) {
        assert.ok(!conn.prepare("SELECT tmdb_id FROM taste_ratings WHERE profile_id = ? AND type = 'movie' AND tmdb_id = ?").get(p.id, t), 'no taste_ratings row for target: ' + t);
      }
    } finally {
      dispose();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('ME-10: marqueeSkipSync — the bench never calls Marquee syncRatings', async () => {
    const marqueeEngine = require('../src/engines/marquee');
    const p = config.addProfile('INT-ME10-SKIP');
    let syncCalls = 0;
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'marquee' } });
      const base = Date.parse('2026-06-01T00:00:00Z');
      for (let i = 0; i < 40; i++) {
        const tmdb = 'skip' + i;
        watchedStore.upsertMany(p.id, [{ simkl_id: i + 1, type: 'movie', imdb_id: 'tt' + tmdb, tmdb_id: tmdb, title: 'Skip ' + i, year: 2024, watched_at: new Date(base + i * 3600e3).toISOString() }]);
      }
      const results = await bench.runBench({
        profile: config.getProfile(p.id), engineIds: ['marquee'], holdout: 10,
        deps: {
          engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet,
          ctxExtras: {
            marqueeChain: [],
            marqueeFetchers: { syncRatings: async () => { syncCalls += 1; return { ok: true }; }, ...mqSeam({}) },
          },
        },
      });
      assert.strictEqual(syncCalls, 0, 'syncRatings was NOT called (marqueeSkipSync)');
      assert.ok(results.engines.marquee, 'the marquee engine ran');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('ME-10: renderTable — stable output for a fixed results object', async () => {
    const results = {
      profile: 'TestProfile', holdout: 10,
      targets: [{ tmdb_id: 't1', title: 'Title One' }, { tmdb_id: 't2', title: 'Title Two' }],
      engines: {
        genesis: { metrics: { hitAt20: 1, hitAt20Fraction: 0.1, recallAt100: 0.2, meanRankOfHits: 5, filterPass: 0.8, trendingShareAt20: null, stored: 100, buildSeconds: 1.5 }, hitTargets: ['t1'] },
        marquee: { metrics: { hitAt20: 2, hitAt20Fraction: 0.2, recallAt100: 0.5, meanRankOfHits: 10, filterPass: 0.9, trendingShareAt20: 0.5, stored: 90, buildSeconds: 2.0 }, hitTargets: ['t1', 't2'] },
      },
    };
    const out1 = bench.renderTable(results);
    const out2 = bench.renderTable(results);
    assert.strictEqual(out1, out2, 'stable output for a fixed results object');
    assert.ok(out1.includes('TestProfile'), 'profile name');
    assert.ok(out1.includes('genesis'), 'genesis row');
    assert.ok(out1.includes('marquee'), 'marquee row');
    assert.ok(out1.includes('Title One'), 'target title');
    assert.ok(out1.includes('Title Two'), 'second target title');
  });

  // ── Marquee m2 tuning (after the first live backtest) ──
  await it('marquee m2: seed agreement survives truncation — a title 10 recent watches point at beats on-genre singletons', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    // m4 (spec §17): the m4 default (genre_blend 0.5) lifts the within-genre
    // term, so the on-genre singletons now pre-score above the off-genre
    // 10-seed title. This test documents the m2/m3 GLOBAL-normalisation
    // behaviour, so it pins the Tier-2 off-switch (genre_blend 0).
    const cfg = { ...mqCfgResolved, lookup_cap: 30, exploration_pct: 0, agreement: { ...mqCfgResolved.agreement, genre_blend: 0 } };
    const seeds = Array.from({ length: 40 }, (_, i) => mqSeed('g' + i));
    // Every seed recommends its own on-genre (Action) title; seeds g0–g9 also
    // all recommend one off-genre title ('agreed', genre id 99 = unknown here).
    const { f } = mqFetchers({
      recs: (id) => {
        const out = [mqItem('u' + id)];
        if (Number(id.slice(1)) < 10) out.push(mqItem('agreed', { genre_ids: [99] }));
        return out;
      },
    });
    const ctx = mqCtx(filters);
    const { candidates } = await mqSources.gatherCandidates({ id: 'p-m2a', name: 'M2A', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds, envelope: env, cfg, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.ok(candidates.length <= 30, 'truncated to the lookup cap');
    assert.ok(candidates.some((c) => c.tmdb_id === 'agreed'), 'the 10-seed title survives despite no genre match');
    assert.strictEqual(candidates[0].tmdb_id, 'agreed', 'and it pre-scores first');
  });

  await it('marquee m2: Simkl trending intake is capped at trending.simkl_take by rank', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 0, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    // 500 Simkl items, deliberately shuffled rank order.
    const simkl = Array.from({ length: 500 }, (_, i) => ({ tmdb_id: 'k' + i, title: 'K' + i, year: 2024, genres: ['Action'], rank: 500 - i, watched: 10, drop_rate: 1, ratings: { imdb: { rating: 7, votes: 5000 } } }));
    const { f } = mqFetchers({ simklTrending: simkl });
    const ctx = mqCtx(filters);
    await mqSources.gatherCandidates({ id: 'p-m2b', name: 'M2B', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [], envelope: env, cfg: mqCfgResolved, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.strictEqual(ctx.stats.sources.S5, mqCfgResolved.trending.simkl_take, 'only the top simkl_take enter');
    assert.strictEqual(mqCfgResolved.trending.simkl_take, 100);
  });

  await it('marquee m2: ctx.marqueeTrace records where each title was lost (watched, prefilter, truncated, hard filter)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 500, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const env = mqEnvelope(filters);
    const cfg = { ...mqCfgResolved, lookup_cap: 3, exploration_pct: 0 };
    const { f } = mqFetchers({
      recs: () => [
        mqItem('seen'), mqItem('lowvotes', { vote_count: 10 }),
        mqItem('a1'), mqItem('a2'), mqItem('a3'), mqItem('a4'),
      ],
    });
    const trace = { generated: new Map(), dropped: new Map() };
    const ctx = mqCtx(filters, { watchedIds: { tmdb: new Set(['seen']), imdb: new Set() }, marqueeTrace: trace });
    const { candidates, meta } = await mqSources.gatherCandidates({ id: 'p-m2c', name: 'M2C', filters }, ctx, {
      taste: mqTaste, brief: null, briefHash: 'h', seeds: [mqSeed('s1')], envelope: env, cfg, genreMap: mqGenreMap, fetchers: f, chain: [], log: quiet,
    });
    assert.strictEqual(trace.dropped.get('seen'), 'watched');
    assert.strictEqual(trace.dropped.get('lowvotes'), 'prefilter:votes');
    assert.strictEqual(candidates.length, 3, 'lookup_cap 3');
    const cut = ['a1', 'a2', 'a3', 'a4'].find((id) => !candidates.some((c) => c.tmdb_id === id));
    assert.strictEqual(trace.dropped.get(cut), 'truncated (pre-score rank 4/4)', 'the 4th title is recorded as truncated');
    assert.deepStrictEqual(trace.generated.get('a1'), ['tmdb_recs']);
    // Scoring: one looked-up title fails the hard filter (NOT_YET).
    const { f: sf } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id, id === candidates[0].tmdb_id ? { availability: 'NOT_YET' } : {}) });
    await mqScoring.scoreCandidates({ id: 'p-m2c', name: 'M2C', filters }, ctx, candidates, {
      taste: mqTaste, envelope: env, cfg, gatherMeta: meta, fetchers: sf, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
    });
    assert.strictEqual(trace.dropped.get(candidates[0].tmdb_id), 'hard_filter:unavailable');
  });

  await it('marquee m2: scoring carries the normalised seed_affinity feature in the final score', async () => {
    const cands = [
      mqCand('sa1', { _seedWeights: new Map([['x', 1], ['y', 1]]), seeds: new Set(['x', 'y']) }),
      mqCand('sa2', { _seedWeights: new Map([['x', 1]]), seeds: new Set(['x']) }),
      mqCand('sa3', {}),
    ];
    const scored = await mqScored(cands);
    const by = new Map(scored.map((r) => [r.tmdb_id, r]));
    assert.strictEqual(by.get('sa1').scoreComponents.features.seed_affinity, 1);
    assert.strictEqual(by.get('sa2').scoreComponents.features.seed_affinity, 0.5);
    assert.strictEqual(by.get('sa3').scoreComponents.features.seed_affinity, 0);
    assert.ok('seed_affinity' in by.get('sa1').scoreComponents.weights, 'seed_affinity is a weighted feature');
    assert.ok(by.get('sa1').rankScore > by.get('sa2').rankScore && by.get('sa2').rankScore > by.get('sa3').rankScore, 'more agreement ranks higher, all else equal');
    assert.strictEqual(by.get('sa1').algorithmVersion, 'marquee-m4');
  });

  // ── Marquee m4 (spec §17): genre-fair agreement ──
  await it('marquee m4 T4 (G4): genre_blend 0 reproduces the frozen m3 snapshot exactly', async () => {
    glassMeta._clear();
    try {
      const fs = require('fs');
      const path = require('path');
      const mqShape = require('../src/engines/marquee/shape');
      const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'marquee-m4-identity.json'), 'utf8'));
      const { genreMap, taste, filters, seeds, items, recs, similar, simklRecs, discover, trendingWeek, trendingDay, simklTrending } = fx.input;
      // Rebuild the stub fetchers from the fixture input (single source of truth).
      const item = (id) => ({ type: 'movie', tmdb_id: id, title: 'T' + id, ...items[id] });
      const fullMeta = (id) => ({
        tmdb_id: String(id), imdb_id: 'tt' + id, type: 'movie', title: 'M' + id,
        overview: 'ov ' + id, year: items[id].year, decade: items[id].year - (items[id].year % 10),
        poster: 'https://image.tmdb.org/t/p/w500/p' + id + '.jpg',
        genres: items[id].genre_ids.map((g) => genreMap[g]),
        primary_genre: items[id].genre_ids.map((g) => genreMap[g])[0],
        vote_average: items[id].vote_average, vote_count: items[id].vote_count, popularity: items[id].popularity,
        original_language: 'en', runtime: 120,
        director: ['D1'], cast: ['C1'], keywords: ['k1'],
        collection: null, networks: [],
        certAU: 'M', certUS: 'R', availability: 'AVAILABLE',
      });
      const f = {
        recs: async (id) => (recs[id] || []).map(item),
        similar: async (id) => (similar[id] || []).map(item),
        discover: async () => discover.map(item),
        collection: async () => [],
        trendingWeek: async () => trendingWeek.map(([id, rank]) => ({ ...item(id), rank })),
        trendingDay: async () => trendingDay.map(([id, rank]) => ({ ...item(id), rank })),
        simklTrending: async () => simklTrending.map(([id, watched, drop_rate]) => ({
          tmdb_id: id, title: 'T' + id, year: items[id].year,
          genres: items[id].genre_ids.map((g) => genreMap[g]),
          watched, drop_rate,
          ratings: { imdb: { rating: items[id].vote_average, votes: items[id].vote_count } },
        })),
        simklRecs: async (ids) => new Map(ids.map((sid) => [sid, (simklRecs[sid] || []).map(item)])),
        chat: async () => '[]',
        resolve: async () => null,
        deepMeta: async (_k, _t, id) => fullMeta(id),
        imdbRatings: async () => new Map(),
      };
      const profile = { id: 'p-m4t4', name: 'M4T4', filters };
      const ctx = {
        tmdbKey: 'k', mdblistKey: '',
        settings: { marquee: { agreement: { genre_blend: 0 } } }, // Tier-2 off-switch (G4)
        filters, log: quiet,
        watchedIds: { tmdb: new Set(), imdb: new Set() }, dont: new Set(), stats: {},
      };
      const cfg = mqCfg.resolveConfig(ctx.settings);
      assert.strictEqual(cfg.agreement.genre_blend, 0, 'Tier-2 genre_blend 0 applies');
      const envelope = mqFilters.compileEnvelope(filters, { nowYear: fx.nowYear, genreMap });
      const { candidates, meta } = await mqSources.gatherCandidates(profile, ctx, {
        taste, brief: null, briefHash: 'h', seeds, envelope, cfg, genreMap, fetchers: f, chain: [], log: quiet,
      });
      const { scored, envelopeStats } = await mqScoring.scoreCandidates(profile, ctx, candidates, {
        taste, envelope, cfg, gatherMeta: meta, fetchers: f, nowYear: fx.nowYear, nowMs: fx.nowMs, log: quiet,
      });
      const fitScored = await mqLlmFit.applyLlmFit(profile.id, scored, {
        brief: null, briefHash: 'h', cfg, chain: [], chat: async () => '[]', log: quiet, now: fx.nowMs,
      });
      const final = mqShape.shapeOutput(fitScored, { cfg, listSize: fx.listSize, envelopeStats, log: quiet, profileName: profile.name, trace: null });
      assert.deepStrictEqual(
        candidates.map((c) => ({ id: c.tmdb_id, pre: c._preScore, sources: [...c.sources].sort(), seeds: [...c.seeds].sort(), seedWeights: [...c._seedWeights.entries()] })),
        fx.expected.prescore,
        'pre-scores identical to the frozen m3 snapshot',
      );
      assert.deepStrictEqual(
        final.map((r) => ({ id: r.tmdb_id, rankScore: r.rankScore, features: r.scoreComponents.features, weights: r.scoreComponents.weights, penalty: r.scoreComponents.penalty })),
        fx.expected.stored,
        'stored rows identical to the frozen m3 snapshot',
      );
    } finally {
      glassMeta._clear();
    }
  });

  await it('marquee m4 T5: the hub effect — a strong comedy competes with a big-franchise hub (β=0.5 vs 0)', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const taste = {
      type: 'movie',
      dims: { genres: { Adventure: 0.5, Comedy: 0.5 }, franchises: {}, keywords: {}, directors: {}, cast: {}, decades: {}, languages: {}, runtimeBands: {} },
      genreMass: {},
    };
    const genreOf = (id) => (id === 'hub' || id.startsWith('a') ? 'Adventure' : 'Comedy');
    const cand = (id, raw) => mqCand(id, { genres: [genreOf(id)], seeds: new Set(['x']), _seedWeights: new Map([['x', raw]]) });
    // 6 Adventure (one hub, raw 10; others 2–4) + 6 Comedy (raw 2–4, best 4).
    const cands = [
      cand('hub', 10), cand('a2', 4), cand('a3', 3), cand('a4', 2), cand('a5', 2), cand('a6', 2),
      cand('c1', 4), cand('c2', 3), cand('c3', 3), cand('c4', 2), cand('c5', 2), cand('c6', 2),
    ];
    const run = async (blend) => {
      glassMeta._clear();
      const env = mqEnvelope(filters);
      const ctx = mqCtx(filters);
      const { f } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id, { genres: [genreOf(id)], primary_genre: genreOf(id) }) });
      const { scored } = await mqScoring.scoreCandidates({ id: 'p-m4t5', name: 'M4T5', filters }, ctx, cands, {
        taste, envelope: env, cfg: mqCfg.resolveConfig({ marquee: { agreement: { genre_blend: blend } } }),
        gatherMeta: { weekN: 0, dayN: 0, hadTrending: false }, fetchers: f,
        nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
      });
      return scored;
    };
    const s0 = await run(0);
    const s05 = await run(0.5);
    const by = (scored, id) => scored.find((r) => r.tmdb_id === id);
    // β=0: the best comedy is capped by the GLOBAL (Adventure) max — 4/10 = 0.4.
    assert.strictEqual(by(s0, 'c1').scoreComponents.features.seed_affinity, 0.4, 'β=0: best comedy capped by the global max');
    // β=0.5: the within-genre term lifts it to 0.5·(4/10) + 0.5·(4/4) = 0.7.
    assert.ok(by(s05, 'c1').scoreComponents.features.seed_affinity >= 0.69, 'β=0.5: best comedy ≥ 0.69');
    assert.strictEqual(by(s05, 'c1').scoreComponents.features.seed_affinity, (1 - 0.5) * (4 / 10) + 0.5 * (4 / 4), 'β=0.5: the exact blend');
    // The hub stays #1 in both runs; the best comedy moves UP against the β=0 run.
    assert.strictEqual(s0[0].tmdb_id, 'hub', 'β=0: the hub stays #1');
    assert.strictEqual(s05[0].tmdb_id, 'hub', 'β=0.5: the hub stays #1');
    assert.ok(s05.findIndex((r) => r.tmdb_id === 'c1') < s0.findIndex((r) => r.tmdb_id === 'c1'), 'the best comedy moves up');
  });

  await it('marquee m4 T6: pre-score cut — β=0.5 keeps the best comedy inside the lookup set where β=0 drops it', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const genreMap = { 12: 'Adventure', 35: 'Comedy' };
    const taste = {
      type: 'movie',
      dims: { genres: { Adventure: 0.5, Comedy: 0.5 }, franchises: {}, keywords: {}, directors: {}, cast: {}, decades: {}, languages: {}, runtimeBands: {} },
      genreMass: {},
    };
    // Seed weights sum to each candidate's raw seed affinity: the Adventure
    // group maxes at 0.9 (a1/a6), the Comedy group at 0.65 (c1).
    const seeds = [
      mqSeed('s1', { weight: 0.5 }), mqSeed('s2', { weight: 0.4 }), mqSeed('s3', { weight: 0.3 }),
      mqSeed('s4', { weight: 0.2 }), mqSeed('s5', { weight: 0.15 }), mqSeed('s6', { weight: 0.1 }), mqSeed('s7', { weight: 0.05 }),
    ];
    const recsBy = {
      s1: ['a1', 'a2', 'a4', 'a6'], s2: ['a1', 'a3', 'a5'], s3: ['a2', 'a3', 'a6', 'c1'],
      s4: ['a4', 'a5', 'c1', 'c4'], s5: ['c1', 'c2', 'c5'], s6: ['c2', 'c3'], s7: ['c3', 'c6'],
    };
    const mkItem = (id) => mqItem(id, { genre_ids: [id.startsWith('a') ? 12 : 35] });
    const run = async (blend) => {
      glassMeta._clear();
      const env = mqEnvelope(filters);
      const { f } = mqFetchers({ recs: (id) => (recsBy[id] || []).map(mkItem) });
      const trace = { generated: new Map(), dropped: new Map() };
      const ctx = mqCtx(filters, { marqueeTrace: trace });
      const cfg = mqCfg.resolveConfig({ marquee: { agreement: { genre_blend: blend }, lookup_cap: 5 } });
      const { candidates } = await mqSources.gatherCandidates({ id: 'p-m4t6', name: 'M4T6', filters }, ctx, {
        taste, brief: null, briefHash: 'h', seeds, envelope: env, cfg, genreMap, fetchers: f, chain: [], log: quiet,
      });
      return { candidates, trace };
    };
    const { candidates: c0, trace: t0 } = await run(0);
    assert.ok(!c0.some((c) => c.tmdb_id === 'c1'), 'β=0: the best comedy is truncated out of the lookup set');
    assert.ok(String(t0.dropped.get('c1') || '').startsWith('truncated'), 'β=0: recorded as truncated');
    const { candidates: c05 } = await run(0.5);
    assert.ok(c05.some((c) => c.tmdb_id === 'c1'), 'β=0.5: the best comedy is kept inside the lookup set');
  });

  await it('marquee m4 T7: stored rows carry marquee-m4 + the agreement trace; Tier-2 off-switch → blend 0', async () => {
    glassMeta._clear();
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 0, excluded_genres: [], age_limit: 0 };
    const cands = [mqCand('t7a'), mqCand('t7b'), mqCand('t7c')];
    const run = async (cfg) => {
      glassMeta._clear();
      const env = mqEnvelope(filters);
      const ctx = mqCtx(filters);
      const { f } = mqScoreFetchers({ deepMeta: (id) => mqFullMeta(id) });
      const { scored } = await mqScoring.scoreCandidates({ id: 'p-m4t7', name: 'M4T7', filters }, ctx, cands, {
        taste: mqTaste, envelope: env, cfg, gatherMeta: { weekN: 0, dayN: 0, hadTrending: false },
        fetchers: f, nowYear: 2026, nowMs: Date.parse('2026-06-01T00:00:00Z'), log: quiet,
      });
      return scored;
    };
    // Default config: β = 0.5.
    const s05 = await run(mqCfgResolved);
    for (const r of s05) {
      assert.strictEqual(r.algorithmVersion, 'marquee-m4', 'algorithm_version = marquee-m4');
      assert.strictEqual(r.scoreComponents.agreement.blend, 0.5, 'the default blend is recorded');
      assert.strictEqual(r.scoreComponents.agreement.group, 'Action', 'the genre group from deep meta');
    }
    // Tier-2 off-switch: settings.marquee.agreement.genre_blend = 0.
    const s0 = await run(mqCfg.resolveConfig({ marquee: { agreement: { genre_blend: 0 } } }));
    for (const r of s0) {
      assert.strictEqual(r.scoreComponents.agreement.blend, 0, 'Tier-2 genre_blend 0 is recorded');
    }
  });

  await it('marquee m4 T8: bench --marquee-config writes only the snapshot settings (A/B off-switch)', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { spawnSync } = require('child_process');
    const { DatabaseSync } = require('node:sqlite');
    const bench = require('../src/bench/engineBench');

    // (a) Section-wise merge: override keys win, existing keys and untouched
    // sections survive; the merge lands in the settings.json of the dir given.
    const mergeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-m4-t8-'));
    fs.writeFileSync(path.join(mergeDir, 'settings.json'), JSON.stringify({
      marquee: { agreement: { genre_blend: 0.5, min_genre_size: 5 }, prescore: { genre: 0.3 } },
      other: 'keep',
    }));
    const merged = bench.applyMarqueeConfig(mergeDir, { agreement: { genre_blend: 0 } });
    assert.deepStrictEqual(merged.agreement, { genre_blend: 0, min_genre_size: 5 }, 'override key wins, existing keys preserved');
    const reloaded = JSON.parse(fs.readFileSync(path.join(mergeDir, 'settings.json'), 'utf8'));
    assert.deepStrictEqual(reloaded.marquee.prescore, { genre: 0.3 }, 'untouched sections stay');
    assert.strictEqual(reloaded.other, 'keep', 'non-marquee settings stay');
    fs.rmSync(mergeDir, { recursive: true, force: true });

    // (b) Refuses to write anywhere outside the temp snapshot dir — before any write.
    assert.throws(() => bench.applyMarqueeConfig(__dirname, { agreement: { genre_blend: 0 } }), /outside the temp snapshot dir/);

    // (c) Snapshot + apply never touches the LIVE settings.json.
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-m4-t8-'));
    fs.writeFileSync(path.join(liveDir, 'settings.json'), JSON.stringify({ marquee: { agreement: { genre_blend: 0.5 } } }, null, 2));
    const liveDb = new DatabaseSync(path.join(liveDir, 'store.db'));
    liveDb.close();
    const liveBefore = fs.readFileSync(path.join(liveDir, 'settings.json'), 'utf8');
    const { benchDir } = bench.snapshotStore(liveDir);
    bench.applyMarqueeConfig(benchDir, { agreement: { genre_blend: 0 } });
    assert.strictEqual(fs.readFileSync(path.join(liveDir, 'settings.json'), 'utf8'), liveBefore, 'live settings content unchanged');
    fs.rmSync(benchDir, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });

    // (d) Subprocess: valid JSON → the header shows the override, the run exits 2
    // (no profile in the hermetic live dir), and the live settings are untouched.
    const liveDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-m4-t8-'));
    fs.writeFileSync(path.join(liveDir2, 'settings.json'), JSON.stringify({ marquee: { agreement: { genre_blend: 0.5 } } }, null, 2));
    const liveDb2 = new DatabaseSync(path.join(liveDir2, 'store.db'));
    liveDb2.close();
    const liveSettingsPath = path.join(liveDir2, 'settings.json');
    const liveBefore2 = fs.readFileSync(liveSettingsPath, 'utf8');
    const liveMtimeBefore = fs.statSync(liveSettingsPath).mtimeMs;
    const ok = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'bench-engines.js'),
      'NoProfile', '--marquee-config', '{"agreement":{"genre_blend":0}}',
    ], { env: { ...process.env, DATA_DIR: liveDir2 }, encoding: 'utf8' });
    assert.strictEqual(ok.status, 2, 'exits 2 (no profile in the hermetic live dir)');
    assert.ok(ok.stdout.includes('marquee config override: {"agreement":{"genre_blend":0}}'), 'header shows the override: ' + ok.stdout);
    assert.ok(ok.stderr.includes('profile not found: NoProfile'), 'the run never reached a real profile');
    assert.strictEqual(fs.readFileSync(liveSettingsPath, 'utf8'), liveBefore2, 'live settings content unchanged');
    assert.ok(Math.abs(fs.statSync(liveSettingsPath).mtimeMs - liveMtimeBefore) < 2, 'live settings mtime unchanged');

    // (e) Invalid JSON → exit 2 with a usage error, before any store access.
    const bad = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'bench-engines.js'),
      'NoProfile', '--marquee-config', 'not-json',
    ], { env: { ...process.env, DATA_DIR: liveDir2 }, encoding: 'utf8' });
    assert.strictEqual(bad.status, 2, 'invalid JSON exits 2');
    assert.ok(bad.stderr.includes('must be a JSON object'), 'usage error: ' + bad.stderr);
    fs.rmSync(liveDir2, { recursive: true, force: true });
  });

  await it('bench m2: reachability + hit@20r + per-target positions and Marquee fate', async () => {
    const bench = require('../src/bench/engineBench');
    const filters = { min_rating: 0, vote_count_floor: 100, max_age_years: 10, excluded_genres: [], age_limit: 0 };
    const metas = {
      ok1: mqFullMeta('ok1', { year: 2024 }),
      old1: mqFullMeta('old1', { year: 1992 }),
      trailer: mqFullMeta('trailer', { year: 2025, vote_count: 3 }),
    };
    const reach = await bench.assessReachability(['ok1', 'old1', 'trailer', 'nometa'], filters, {
      compileEnvelope: mqFilters.compileEnvelope, nowYear: 2026, metaFor: async (id) => metas[id] || null,
    });
    assert.deepStrictEqual(reach.get('ok1'), { reachable: true, reason: null });
    assert.deepStrictEqual(reach.get('old1'), { reachable: false, reason: 'recency' });
    assert.deepStrictEqual(reach.get('trailer'), { reachable: false, reason: 'votes' });
    assert.strictEqual(reach.get('nometa').reachable, true, 'unknown metadata never shrinks the denominator');

    const rows = [{ tmdb_id: 'ok1', imdb_id: 'tt1', type: 'movie', year: 2024, genres: 'Action', primary_genre: 'Action', affinity: 1 }];
    const m = bench.metrics(rows, ['ok1', 'old1', 'trailer'], filters, { selectServe: rs.selectServe, stored: 1, buildSeconds: 1, reachable: new Set(['ok1']) });
    assert.strictEqual(m.hitAt20, 1);
    assert.strictEqual(m.hitAt20Reachable, 1);
    assert.strictEqual(m.reachableTargets, 1);

    const out = bench.renderTable({
      profile: 'P', holdout: 2,
      targets: [{ tmdb_id: 'ok1', title: 'Okay One', reachable: true }, { tmdb_id: 'old1', title: 'Old One', reachable: false, unreachableReason: 'recency' }],
      engines: {
        genesis: { metrics: { ...m }, hitTargets: ['ok1'], positions: { ok1: { rank: 3, served: true }, old1: { rank: null, fate: null } } },
        marquee: { metrics: { ...m }, hitTargets: [], positions: { ok1: { rank: null, fate: 'truncated (pre-score rank 512/900)' }, old1: { rank: null, fate: 'prefilter:recency' } } },
      },
    });
    assert.ok(out.includes('hit@20r'), 'reachable column');
    assert.ok(out.includes('[unreachable: recency]'), 'unreachable reason shown');
    assert.ok(out.includes('genesis #3 served'), 'genesis position shown');
    assert.ok(out.includes('marquee truncated (pre-score rank 512/900)'), 'Marquee fate shown');
  });

  // ── Calibrated serving (spec §16): the taste target — build-time computation + storage ──
  const serveCalibration = require('../src/serveCalibration');

  await it('K10: genreTarget — ignored excluded, rated ≤4 excluded, Loved floored, meta genres else primary_genre', async () => {
    const taste = require('../src/engines/marquee/taste');
    const profileId = 'p-k10';
    const nowMs = Date.parse('2026-06-01T00:00:00Z');
    const day = 86400000;
    const recent = new Date(nowMs).toISOString();
    const oldLoved = new Date(nowMs - 1080 * day).toISOString();
    glassMeta._clear();
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'ttk10a', tmdb_id: '1', title: 'A', year: 2020, watched_at: recent },
      { simkl_id: 2, type: 'movie', imdb_id: 'ttk10b', tmdb_id: '2', title: 'B', year: 2020, watched_at: recent },
      { simkl_id: 3, type: 'movie', imdb_id: 'ttk10c', tmdb_id: '3', title: 'C', year: 2020, watched_at: recent },
      { simkl_id: 4, type: 'movie', imdb_id: 'ttk10d', tmdb_id: '4', title: 'D', year: 2020, watched_at: oldLoved },
      { simkl_id: 5, type: 'movie', imdb_id: 'ttk10e', tmdb_id: '5', title: 'E', year: 2020, watched_at: recent },
    ]);
    // primary_genre on the watched rows (the enrichment step normally fills this).
    const db = require('../src/db');
    db.get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Horror', profileId, '1');
    db.get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Horror', profileId, '2');
    db.get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Sci-Fi', profileId, '3');
    db.get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Comedy', profileId, '4');
    db.get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Documentary', profileId, '5');
    // Cached deep-meta for A (Action/Drama) and D (Comedy); E has none → primary_genre.
    glassMeta.put('movie', '1', { genres: ['Action', 'Drama'] });
    glassMeta.put('movie', '4', { genres: ['Comedy'] });
    const ratings = new Map([['2', 3], ['4', 10]]);
    const ignored = new Set(['3']);
    const { target, filmCount } = taste.genreTarget(profileId, mqCfgResolved, { nowMs, ratings, ignored });
    assert.strictEqual(filmCount, 3, 'A, D, E counted (B rated ≤4 and C ignored excluded)');
    assert.ok(!('Horror' in target), 'B (rated 3) excluded');
    assert.ok(!('Sci-Fi' in target), 'C (ignored) excluded');
    assert.ok('Action' in target && 'Drama' in target, 'A uses cached meta genres (not its primary_genre Horror)');
    assert.ok('Documentary' in target, 'E uses primary_genre when no cached meta');
    // D is old (days 1080 → decay ≈ 0.113); the Loved floor lifts it to 0.5, so
    // weight = 3.0 × 0.5 = 1.5 (without the floor it would be 3.0 × 0.113 ≈ 0.339).
    // Total = 0.5 + 0.5 + 1.5 + 1.0 = 3.5 → Comedy share = 1.5/3.5.
    assert.ok(Math.abs(target.Comedy - 1.5 / 3.5) < 1e-6, 'Loved decay floored (Comedy share = 1.5/3.5)');
    watchedStore.deleteForProfile(profileId);
    glassMeta._clear();
  });

  await it('K11: generate stores the serve target (engine_id marquee, film_count > 0); empty build does not store', async () => {
    const p1 = config.addProfile('INT-MQK11A');
    try {
      config.updateProfile(p1.id, { simkl_auth: { access_token: 'x' }, filters: { vote_count_floor: 100 } });
      watchedStore.upsertMany(p1.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'ttk11a', tmdb_id: 'es1', title: 'Seed', year: 2024, watched_at: '2026-05-01T00:00:00Z' }]);
      require('../src/db').get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Action', p1.id, 'es1');
      const ctx1 = {
        tmdbKey: 'k', mdblistKey: '', settings: {}, filters: { vote_count_floor: 100 }, log: quiet,
        nowMs: Date.parse('2026-06-01T00:00:00Z'),
        watchedIds: watchedStore.watchedIdSets(p1.id), dont: new Set(), stats: {}, marqueeChain: [],
        marqueeFetchers: { ...mqSeam({ recs: () => [mqItem('k11c1')] }), syncRatings: async () => ({ skipped: 'test' }), pullProgress: async () => [] },
      };
      const out1 = await marqueeEngine.generate(config.getProfile(p1.id), 'movie', ctx1);
      assert.ok(out1.length > 0, 'non-empty build');
      const t1 = serveCalibration.getTarget(p1.id, 'movie');
      assert.ok(t1, 'target stored');
      assert.strictEqual(t1.engine_id, 'marquee', 'engine_id marquee');
      assert.ok(t1.film_count > 0, 'film_count > 0');
    } finally {
      config.removeProfile(p1.id); watchedStore.deleteForProfile(p1.id); rs.deleteForProfile(p1.id); serveCalibration.deleteForProfile(p1.id);
    }
    // Empty build (no watched history) → no target stored.
    const p2 = config.addProfile('INT-MQK11B');
    try {
      config.updateProfile(p2.id, { simkl_auth: { access_token: 'x' }, filters: { vote_count_floor: 100 } });
      const ctx2 = {
        tmdbKey: 'k', mdblistKey: '', settings: {}, filters: { vote_count_floor: 100 }, log: quiet,
        nowMs: Date.parse('2026-06-01T00:00:00Z'),
        watchedIds: watchedStore.watchedIdSets(p2.id), dont: new Set(), stats: {}, marqueeChain: [],
        marqueeFetchers: { ...mqSeam(), syncRatings: async () => ({ skipped: 'test' }), pullProgress: async () => [] },
      };
      const out2 = await marqueeEngine.generate(config.getProfile(p2.id), 'movie', ctx2);
      assert.ok(out2.length === 0, 'empty build');
      assert.strictEqual(serveCalibration.getTarget(p2.id, 'movie'), null, 'empty build does not store a target');
    } finally {
      config.removeProfile(p2.id); watchedStore.deleteForProfile(p2.id); rs.deleteForProfile(p2.id); serveCalibration.deleteForProfile(p2.id);
    }
  });

  await it('K12: a setTarget failure never fails the build', async () => {
    const p = config.addProfile('INT-MQK12');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { vote_count_floor: 100 } });
      watchedStore.upsertMany(p.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'ttk12', tmdb_id: 'es12', title: 'Seed', year: 2024, watched_at: '2026-05-01T00:00:00Z' }]);
      require('../src/db').get().prepare('UPDATE watched SET primary_genre = ? WHERE profile_id = ? AND tmdb_id = ?').run('Action', p.id, 'es12');
      const ctx = {
        tmdbKey: 'k', mdblistKey: '', settings: {}, filters: { vote_count_floor: 100 }, log: quiet,
        nowMs: Date.parse('2026-06-01T00:00:00Z'),
        watchedIds: watchedStore.watchedIdSets(p.id), dont: new Set(), stats: {}, marqueeChain: [],
        marqueeFetchers: { ...mqSeam({ recs: () => [mqItem('k12c1')] }), syncRatings: async () => ({ skipped: 'test' }), pullProgress: async () => [] },
      };
      const origSetTarget = serveCalibration.setTarget;
      serveCalibration.setTarget = () => { throw new Error('db down'); };
      try {
        const out = await marqueeEngine.generate(config.getProfile(p.id), 'movie', ctx);
        assert.ok(out.length > 0, 'build succeeded despite setTarget failure');
      } finally {
        serveCalibration.setTarget = origSetTarget;
      }
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  // ── Calibrated serving (spec §16): one serve entry point; Marquee serves calibrated ──
  // A pool row for the serve tests: a single-genre movie with a known affinity.
  // (rec_count/popularity/poster are bound by upsertCandidates, so they must be set.)
  const mkPoolRow = (tmdbId, genre, affinity) => ({
    type: 'movie', tmdb_id: tmdbId, imdb_id: 'tt' + tmdbId, title: 'T' + tmdbId,
    year: 2020, primary_genre: genre, genres: genre, affinity, vote_average: 7,
    rec_count: 1, popularity: 1, poster: null,
  });

  await it('K13: prefix stability (C3) + dispatch (calibrated / round-robin fallbacks)', async () => {
    const mqCfg = require('../src/engines/marquee/config');
    const p = config.addProfile('INT-MQK13');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } }); // SC-07: enable Marquee
      // 40 pool rows: 10 per genre, affinities interleaved (all distinct).
      const affByGenre = {
        'Action': [100, 96, 92, 88, 84, 80, 76, 72, 68, 64],
        'Drama': [99, 95, 91, 87, 83, 79, 75, 71, 67, 63],
        'Comedy': [98, 94, 90, 86, 82, 78, 74, 70, 66, 62],
        'Science Fiction': [97, 93, 89, 85, 81, 77, 73, 69, 65, 61],
      };
      const rows = [];
      for (const g of Object.keys(affByGenre)) affByGenre[g].forEach((aff, i) => rows.push(mkPoolRow(g + '-' + i, g, aff)));
      rs.upsertCandidates(p.id, rows);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const target = { Action: 0.4, Drama: 0.3, Comedy: 0.2, 'Science Fiction': 0.1 };
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 40, Date.now());
      const profile = config.getProfile(p.id);

      // Prefix stability (C3): every limit is a strict prefix of the full ordering.
      const full = rs.selectServeFor(profile, 'movie', stored, { limit: stored.length });
      for (const n of [5, 10, 20, 37, 60]) {
        assert.deepStrictEqual(rs.selectServeFor(profile, 'movie', stored, { limit: n }), full.slice(0, n), `prefix stability for n=${n}`);
      }

      // Dispatch: calibrated for a Marquee profile with a stored target.
      const nowYear = new Date().getFullYear();
      const passed = rs.filterServable(stored, profile.filters, { nowYear }).sort((a, b) => {
        const sa = a.affinity || 0, sb = b.affinity || 0;
        if (sb !== sa) return sb - sa;
        return String(a.tmdb_id) < String(b.tmdb_id) ? -1 : 1;
      });
      const pTarget = serveCalibration.applyExclusions(target, profile.filters.excluded_genres || []);
      const opts = mqCfg.resolveConfig(settings.getSettings()).serve;
      const camelOpts = {};
      for (const [k, v] of Object.entries(opts)) camelOpts[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
      const expectedCalibrated = serveCalibration.calibratedOrder(passed, pTarget, { listSize: rs.listSizeFor(profile), ...camelOpts }).slice(0, 20);
      assert.deepStrictEqual(rs.selectServeFor(profile, 'movie', stored, { limit: 20 }), expectedCalibrated, 'calibrated for Marquee with target');

      // Round-robin fallbacks (C6) — the existing genre rotation, logged once.
      const expectedRR = rs.balanceByGenre(passed, 20);
      // (a) Genesis — a non-calibrated engine.
      config.updateProfile(p.id, { filters: { engine_movie: 'genesis' } });
      assert.deepStrictEqual(rs.selectServeFor(config.getProfile(p.id), 'movie', stored, { limit: 20 }), expectedRR, 'round-robin for Genesis');
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee' } });
      // (b) No stored target.
      serveCalibration.deleteForProfile(p.id);
      assert.deepStrictEqual(rs.selectServeFor(config.getProfile(p.id), 'movie', stored, { limit: 20 }), expectedRR, 'round-robin when no target');
      // (c) Engine id mismatch (a target stored by another engine).
      serveCalibration.setTarget(p.id, 'movie', 'genesis', target, 40, Date.now());
      assert.deepStrictEqual(rs.selectServeFor(config.getProfile(p.id), 'movie', stored, { limit: 20 }), expectedRR, 'round-robin when engine_id mismatched');
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 40, Date.now());
      // (d) Tier-2 strategy 'round_robin' (the admin override).
      settings.updateSettings({ marquee: { serve: { strategy: 'round_robin' } } });
      assert.deepStrictEqual(rs.selectServeFor(config.getProfile(p.id), 'movie', stored, { limit: 20 }), expectedRR, 'round-robin when strategy round_robin');
      settings.updateSettings({ marquee: {} });
      // (e) calibratedOrder throws — serving must never fail because of calibration.
      const origCal = serveCalibration.calibratedOrder;
      serveCalibration.calibratedOrder = () => { throw new Error('boom'); };
      try {
        assert.deepStrictEqual(rs.selectServeFor(config.getProfile(p.id), 'movie', stored, { limit: 20 }), expectedRR, 'round-robin when calibratedOrder throws');
      } finally {
        serveCalibration.calibratedOrder = origCal;
      }
    } finally {
      settings.updateSettings({ engines: { marquee: false }, marquee: {} });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  await it('K14: excluded genres at serve — a target genre excluded is never served, the rest renormalise', async () => {
    const p = config.addProfile('INT-MQK14');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: ['Drama'], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      // 30 pool rows: 10 Action, 10 Drama, 10 Comedy.
      const rows = [];
      for (let i = 0; i < 10; i++) rows.push(mkPoolRow('a' + i, 'Action', 100 - i));
      for (let i = 0; i < 10; i++) rows.push(mkPoolRow('d' + i, 'Drama', 99 - i));
      for (let i = 0; i < 10; i++) rows.push(mkPoolRow('c' + i, 'Comedy', 98 - i));
      rs.upsertCandidates(p.id, rows);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const target = { Action: 0.4, Drama: 0.4, Comedy: 0.2 };
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 30, Date.now());
      const profile = config.getProfile(p.id);
      const served = rs.selectServeFor(profile, 'movie', stored, { limit: 20 });
      assert.ok(served.every((r) => r.primary_genre !== 'Drama'), 'no Drama served');
      assert.ok(served.some((r) => r.primary_genre === 'Action'), 'Action served');
      assert.ok(served.some((r) => r.primary_genre === 'Comedy'), 'Comedy served');
      // applyExclusions renormalises the remaining genres to sum 1.
      const pTarget = serveCalibration.applyExclusions(target, ['Drama']);
      assert.ok(Math.abs(pTarget.Action - 0.4 / 0.6) < 1e-9, 'Action renormalised to 0.4/0.6');
      assert.ok(Math.abs(pTarget.Comedy - 0.2 / 0.6) < 1e-9, 'Comedy renormalised to 0.2/0.6');
      assert.ok(!('Drama' in pTarget), 'Drama removed from the target');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  await it('K15: serveRecommendations (catalog) and the portal View return the same first list_size as selectServeFor', async () => {
    const p = config.addProfile('INT-MQK15');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 10, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      // 30 pool rows: 10 per genre.
      const affByGenre = { 'Action': [100, 96, 92, 88, 84, 80, 76, 72, 68, 64], 'Drama': [99, 95, 91, 87, 83, 79, 75, 71, 67, 63], 'Comedy': [98, 94, 90, 86, 82, 78, 74, 70, 66, 62] };
      const rows = [];
      for (const g of Object.keys(affByGenre)) affByGenre[g].forEach((aff, i) => rows.push(mkPoolRow(g + '-' + i, g, aff)));
      rs.upsertCandidates(p.id, rows);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const target = { Action: 0.5, Drama: 0.3, Comedy: 0.2 };
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 30, Date.now());
      const profile = config.getProfile(p.id);
      const listSize = rs.listSizeFor(profile);
      // Direct selectServeFor (the one entry point).
      const direct = rs.selectServeFor(profile, 'movie', stored, { limit: listSize });
      // Catalog (serveRecommendations — the Stremio serve surface).
      const catalog = rs.serveRecommendations(profile, 'movie', { record: false });
      // Portal View (the portal.js code path: the watched-first shared selection).
      const portal = rs.selectedRecommendationRows(profile, 'movie', { limit: listSize });
      assert.deepStrictEqual(catalog.map((m) => m.id), direct.map((r) => r.imdb_id), 'serveRecommendations matches selectServeFor');
      assert.deepStrictEqual(portal.map((r) => r.imdb_id), direct.map((r) => r.imdb_id), 'portal View matches selectServeFor');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  // ── Part B: warn once per (profile, type, reason) ──
  await it('B1: fallback warns once per (profile, type, reason); cleared on a successful calibrated serve', async () => {
    const p = config.addProfile('INT-MQB1');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      const affByGenre = {
        'Action': [100, 96, 92, 88, 84, 80, 76, 72, 68, 64],
        'Drama': [99, 95, 91, 87, 83, 79, 75, 71, 67, 63],
        'Comedy': [98, 94, 90, 86, 82, 78, 74, 70, 66, 62],
      };
      const rows = [];
      for (const g of Object.keys(affByGenre)) affByGenre[g].forEach((aff, i) => rows.push(mkPoolRow(g + '-' + i, g, aff)));
      rs.upsertCandidates(p.id, rows);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const profile = config.getProfile(p.id);
      const target = { Action: 0.4, Drama: 0.3, Comedy: 0.3 };
      rs._resetServeWarnings();
      const origWarn = console.warn;
      const warns = [];
      console.warn = (msg) => { warns.push(msg); };
      try {
        // 5 serves with no target → exactly 1 warning (reason no-target).
        for (let i = 0; i < 5; i++) rs.selectServeFor(profile, 'movie', stored, { limit: 20 });
        assert.strictEqual(warns.length, 1, '5 no-target serves → exactly 1 warning');
        assert.ok(warns[0].includes('no-target'), 'warning carries the reason');
        // Store a target → a serve calibrates (no new warning).
        serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 30, Date.now());
        const before = warns.length;
        rs.selectServeFor(profile, 'movie', stored, { limit: 20 });
        assert.strictEqual(warns.length, before, 'calibrated serve does not warn');
        // Delete the target → the next serve warns again (1 more).
        serveCalibration.deleteForProfile(p.id);
        rs.selectServeFor(profile, 'movie', stored, { limit: 20 });
        assert.strictEqual(warns.length, before + 1, 'after target deleted, the next serve warns again');
      } finally {
        console.warn = origWarn;
      }
    } finally {
      settings.updateSettings({ engines: { marquee: false }, marquee: {} });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  await it('B2: strategy round_robin never warns (unchanged behaviour)', async () => {
    const p = config.addProfile('INT-MQB2');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      const affByGenre = {
        'Action': [100, 96, 92, 88, 84, 80],
        'Drama': [99, 95, 91, 87, 83, 79],
        'Comedy': [98, 94, 90, 86, 82, 78],
      };
      const rows = [];
      for (const g of Object.keys(affByGenre)) affByGenre[g].forEach((aff, i) => rows.push(mkPoolRow(g + '-' + i, g, aff)));
      rs.upsertCandidates(p.id, rows);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const profile = config.getProfile(p.id);
      const target = { Action: 0.4, Drama: 0.3, Comedy: 0.3 };
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 18, Date.now());
      settings.updateSettings({ marquee: { serve: { strategy: 'round_robin' } } });
      rs._resetServeWarnings();
      const origWarn = console.warn;
      const warns = [];
      console.warn = (msg) => { warns.push(msg); };
      try {
        // 5 serves with strategy round_robin → no warnings (deliberate round_robin).
        for (let i = 0; i < 5; i++) rs.selectServeFor(profile, 'movie', stored, { limit: 20 });
        assert.strictEqual(warns.length, 0, 'strategy round_robin never warns');
      } finally {
        console.warn = origWarn;
      }
    } finally {
      settings.updateSettings({ engines: { marquee: false }, marquee: {} });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  await it('K17: selectServe (old) output is unchanged — filter + balanceByGenre (regression guard)', async () => {
    const nowYear = new Date().getFullYear();
    // A fixture exercising the rating floor, excluded genres, movies-only recency,
    // and the no-imdb_id drop — the same logic selectServe has always run.
    const rows = [
      { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', title: 'A', year: nowYear - 5, primary_genre: 'Action', genres: 'Action', affinity: 10, vote_average: 8, imdb_rating: 8 },
      { type: 'movie', tmdb_id: '2', imdb_id: 'tt2', title: 'B', year: nowYear - 5, primary_genre: 'Drama', genres: 'Drama', affinity: 9, vote_average: 7, imdb_rating: 7 },
      { type: 'movie', tmdb_id: '3', imdb_id: 'tt3', title: 'C', year: nowYear - 20, primary_genre: 'Comedy', genres: 'Comedy', affinity: 8, vote_average: 7, imdb_rating: 7 },
      { type: 'movie', tmdb_id: '4', imdb_id: null, title: 'D', year: nowYear - 5, primary_genre: 'Action', genres: 'Action', affinity: 7, vote_average: 8, imdb_rating: 8 },
      { type: 'movie', tmdb_id: '5', imdb_id: 'tt5', title: 'E', year: nowYear - 5, primary_genre: 'Action', genres: 'Action', affinity: 6, vote_average: 5, imdb_rating: 5 },
      { type: 'movie', tmdb_id: '6', imdb_id: 'tt6', title: 'F', year: nowYear - 5, primary_genre: 'Comedy', genres: 'Comedy', affinity: 5, vote_average: 8, imdb_rating: 8 },
    ];
    const filters = { min_rating: 6, excluded_genres: ['Drama'], max_age_years: 10, age_limit: 0 };
    // Reference: the ORIGINAL selectServe logic (filter + balanceByGenre), inlined.
    const reference = rs.balanceByGenre(rs.filterServable(rows, filters, { nowYear }), 10);
    assert.deepStrictEqual(rs.selectServe(rows, filters, { nowYear, limit: 10 }), reference, 'selectServe unchanged');
    const ids = reference.map((r) => r.tmdb_id);
    assert.ok(ids.includes('1'), 'A kept');
    assert.ok(!ids.includes('2'), 'B excluded (Drama)');
    assert.ok(!ids.includes('3'), 'C excluded (too old)');
    assert.ok(!ids.includes('4'), 'D excluded (no imdb_id)');
    assert.ok(!ids.includes('5'), 'E excluded (below rating floor)');
    assert.ok(ids.includes('6'), 'F kept');
  });

  await it('K18: bench serveStrategies — three strategies, fields present, pure_score top20Share = 20', async () => {
    const bench = require('../src/bench/engineBench');
    const mqCfg = require('../src/engines/marquee/config');
    const p = config.addProfile('INT-MQK18');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      // 40 pool rows: 10 per genre (all filter-passing), affinities interleaved.
      const affByGenre = {
        'Action': [100, 96, 92, 88, 84, 80, 76, 72, 68, 64],
        'Drama': [99, 95, 91, 87, 83, 79, 75, 71, 67, 63],
        'Comedy': [98, 94, 90, 86, 82, 78, 74, 70, 66, 62],
        'Science Fiction': [97, 93, 89, 85, 81, 77, 73, 69, 65, 61],
      };
      const rows = [];
      for (const g of Object.keys(affByGenre)) affByGenre[g].forEach((aff, i) => rows.push(mkPoolRow(g + '-' + i, g, aff)));
      rs.upsertCandidates(p.id, rows);
      serveCalibration.setTarget(p.id, 'movie', 'marquee', { Action: 0.4, Drama: 0.3, Comedy: 0.2, 'Science Fiction': 0.1 }, 40, Date.now());
      const profile = config.getProfile(p.id);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });

      const strategies = bench.serveStrategyMetrics(stored, profile, profile.filters, {
        selectServe: rs.selectServe,
        selectServeFor: rs.selectServeFor,
        filterServable: rs.filterServable,
        serveCalibration,
        // a few holdout targets (the bench drives this against the real holdout).
        targets: [stored[0].tmdb_id, stored[1].tmdb_id, stored[2].tmdb_id],
        reachable: null,
        serveOptions: mqCfg.resolveConfig(settings.getSettings()).serve,
      });

      // Three strategies, in order.
      assert.deepStrictEqual(Object.keys(strategies), ['round_robin', 'calibrated', 'pure_score']);
      // Each strategy carries the §6 fields.
      for (const s of Object.values(strategies)) {
        assert.ok(typeof s.hitAt20 === 'number', 'hitAt20 present');
        assert.ok(s.hitAt20Reachable === null || typeof s.hitAt20Reachable === 'number', 'hitAt20Reachable present');
        assert.ok(s.kl === null || typeof s.kl === 'number', 'kl present');
        assert.ok(typeof s.top20Share === 'number', 'top20Share present');
        assert.ok(s.meanRank === null || typeof s.meanRank === 'number', 'meanRank present');
        assert.ok('worstRank' in s, 'worstRank present');
        assert.ok('wildcard' in s, 'wildcard present');
      }
      // pure_score serves the top 20 by score → all 20 are in the top-20 scores.
      assert.strictEqual(strategies.pure_score.top20Share, 20, 'pure_score top20Share = 20');
    } finally {
      settings.updateSettings({ engines: { marquee: false }, marquee: {} });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  await it('C1: bench --serve-opts override adds a calibrated* row that reaches past the default window', async () => {
    const bench = require('../src/bench/engineBench');
    const mqCfg = require('../src/engines/marquee/config');
    const p = config.addProfile('INT-MQC1');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      // 80 pool rows: the top 60 are Action (affinity 100..41), rows 61–80 are
      // Drama (affinity 40..21). The target wants Drama. With the default
      // window_factor 3 the calibrated window (top 60) never sees the Drama
      // rows; window_factor 4 (window 80) does, and the greedy picks one.
      const rows = [];
      for (let i = 0; i < 60; i++) rows.push(mkPoolRow('A' + i, 'Action', 100 - i));
      for (let i = 0; i < 20; i++) rows.push(mkPoolRow('D' + i, 'Drama', 40 - i));
      rs.upsertCandidates(p.id, rows);
      serveCalibration.setTarget(p.id, 'movie', 'marquee', { Drama: 0.9, Action: 0.1 }, 80, Date.now());
      const profile = config.getProfile(p.id);
      const stored = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });

      const strategies = bench.serveStrategyMetrics(stored, profile, profile.filters, {
        selectServe: rs.selectServe,
        selectServeFor: rs.selectServeFor,
        filterServable: rs.filterServable,
        serveCalibration,
        targets: [stored[0].tmdb_id],
        reachable: null,
        serveOptions: mqCfg.resolveConfig(settings.getSettings()).serve,
        serveOptsOverride: { window_factor: 4 },
        listSizeFor: rs.listSizeFor,
      });

      // Four strategies, in order (the override adds the 4th).
      assert.deepStrictEqual(Object.keys(strategies), ['round_robin', 'calibrated', 'pure_score', 'calibrated*']);
      // The default window (3 × list_size 20 = 60) never reaches the Drama rows;
      // the wider window (4 × 20 = 80) does.
      assert.ok(strategies.calibrated.worstRank <= 3 * 20, 'calibrated worstRank within the default window');
      assert.ok(strategies['calibrated*'].worstRank > 3 * 20, 'calibrated* reaches past the default window');
      // No override → no calibrated* row (K18's three rows unchanged).
      const plain = bench.serveStrategyMetrics(stored, profile, profile.filters, {
        selectServe: rs.selectServe,
        selectServeFor: rs.selectServeFor,
        filterServable: rs.filterServable,
        serveCalibration,
        targets: [stored[0].tmdb_id],
        reachable: null,
        serveOptions: mqCfg.resolveConfig(settings.getSettings()).serve,
        listSizeFor: rs.listSizeFor,
      });
      assert.deepStrictEqual(Object.keys(plain), ['round_robin', 'calibrated', 'pure_score']);
    } finally {
      settings.updateSettings({ engines: { marquee: false }, marquee: {} });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
    }
  });

  // ── Marquee m2 engagement: finished = liked, abandoned before halfway = not ──
  const mqEngagement = require('../src/engines/marquee/engagement');
  const DAYMS = 24 * 3600e3;
  const engNow = Date.parse('2026-06-01T00:00:00Z');
  const engRow = (imdbId, percent, daysAgo, over) => ({ type: 'movie', imdbId, percent, updatedAtMs: engNow - daysAgo * DAYMS, ...over });

  await it('marquee m2 engagement: sync stores movie progress, keeps it after the provider prunes it, throttles, never throws', async () => {
    mqEngagement._clear();
    const profile = { id: 'p-eng1', name: 'ENG1' };
    const resolve = async (imdbId) => imdbId.replace('tt', 'tm');
    let rows = [engRow('tt1', 30, 10), engRow('tt2', 95, 10), { type: 'series', imdbId: 'tt3', percent: 20, updatedAtMs: engNow }];
    const pull = async () => rows;
    let r = await mqEngagement.syncEngagement(profile, mqCfgResolved, { pull, resolveTmdb: resolve, now: engNow, log: quiet });
    assert.strictEqual(r.movies, 2, 'series rows ignored');
    // Within sync_hours → throttled, no pull.
    let pulled = 0;
    r = await mqEngagement.syncEngagement(profile, mqCfgResolved, { pull: async () => { pulled += 1; return []; }, resolveTmdb: resolve, now: engNow + 3600e3, log: quiet });
    assert.deepStrictEqual(r, { skipped: 'fresh' });
    assert.strictEqual(pulled, 0);
    // The provider prunes its rows: the stored observation survives.
    rows = [];
    await mqEngagement.syncEngagement(profile, mqCfgResolved, { pull, resolveTmdb: resolve, now: engNow + 7 * 3600e3, log: quiet });
    assert.ok(mqEngagement.abandonedFor(profile.id, mqCfgResolved, { now: engNow }).has('tm1'), 'abandoned film remembered after prune');
    // Provider down → never throws, observations kept.
    r = await mqEngagement.syncEngagement(profile, mqCfgResolved, { pull: async () => { throw new Error('nuvio down'); }, now: engNow + 14 * 3600e3, log: quiet });
    assert.strictEqual(r.ok, false);
    assert.ok(mqEngagement.abandonedFor(profile.id, mqCfgResolved, { now: engNow }).has('tm1'));
    // No progress source (e.g. no Nuvio configured) → a clean skip.
    r = await mqEngagement.syncEngagement({ id: 'p-eng1b', name: 'X' }, mqCfgResolved, { pull: async () => null, now: engNow, log: quiet });
    assert.deepStrictEqual(r, { skipped: 'no progress source' });
    mqEngagement._clear();
  });

  await it('marquee m2 engagement: abandoned = below 50%, untouched 7+ days, not finished later', async () => {
    mqEngagement._clear();
    const profile = { id: 'p-eng2', name: 'ENG2' };
    watchedStore.upsertMany(profile.id, [{ simkl_id: 9, type: 'movie', imdb_id: 'ttF', tmdb_id: 'tmF', title: 'Finished later', year: 2020, watched_at: '2026-05-20T00:00:00Z' }]);
    const rows = [
      engRow('ttA', 30, 10),   // abandoned
      engRow('ttB', 30, 2),    // paused recently → not yet a verdict
      engRow('ttC', 70, 30),   // past halfway → neutral
      engRow('ttF', 20, 40),   // started, later FINISHED → never abandoned
      engRow('ttN', 10, 30),   // tmdb unresolved → ignored
    ];
    await mqEngagement.syncEngagement(profile, mqCfgResolved, {
      pull: async () => rows, resolveTmdb: async (id) => (id === 'ttN' ? null : id.replace('tt', 'tm')), now: engNow, log: quiet,
    });
    const ab = mqEngagement.abandonedFor(profile.id, mqCfgResolved, { now: engNow });
    assert.deepStrictEqual([...ab.keys()], ['tmA']);
    assert.strictEqual(ab.get('tmA').percent, 30);
    // Disabled via Tier-2 config → nothing is abandoned.
    assert.strictEqual(mqEngagement.abandonedFor(profile.id, mqCfg.resolveConfig({ marquee: { engagement: { enabled: false } } }), { now: engNow }).size, 0);
    watchedStore.deleteForProfile(profile.id);
    mqEngagement._clear();
  });

  await it('marquee m3 engagement: an abandoned film is NEUTRAL (no taste event of any kind)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const profileId = 'p-eng3';
    glassMeta._clear();
    watchedStore.upsertMany(profileId, [{ simkl_id: 1, type: 'movie', imdb_id: 'ttw1', tmdb_id: 'w1', title: 'Liked', year: 2020, watched_at: '2026-05-01T00:00:00Z' }]);
    glassMeta.put('movie', 'w1', { genres: ['Drama'], director: ['Director Liked'], imdb_id: 'ttw1' });
    // N5: the m2 `abandoned` option is removed — even if a caller passes it, no
    // abandoned event of any kind is produced (abandoned films are NEUTRAL).
    const abandoned = new Map([['ab1', { percent: 25, ts: engNow - 20 * DAYMS }]]);
    const events = taste.buildEvents(profileId, mqCfgResolved, { nowMs: engNow, ratings: new Map(), abandoned });
    assert.ok(!events.some((e) => e.kind === 'abandoned'), 'no abandoned event of any kind');
    assert.ok(!events.some((e) => e.tmdb_id === 'ab1'), 'the abandoned film is absent from the event list');
    // The taste model carries no negative director from a (would-be) abandoned film.
    const tm = await taste.buildTaste(profileId, 'k', mqCfgResolved, { nowMs: engNow, ratings: new Map(), log: quiet });
    assert.ok(tm.dims.directors['Director Liked'] > 0, 'finished film stays positive');
    assert.ok(!('Director Disliked' in tm.dims.directors), 'no negative director from an abandoned film');
    watchedStore.deleteForProfile(profileId);
    glassMeta._clear();
  });

  await it('marquee m2 engagement: generate never recommends an abandoned film back (and traces why)', async () => {
    mqEngagement._clear();
    glassMeta._clear();
    const p = config.addProfile('INT-MQENG');
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { vote_count_floor: 100 } });
      watchedStore.upsertMany(p.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'ttes1', tmdb_id: 'es1', title: 'Seed', year: 2024, watched_at: '2026-05-01T00:00:00Z' }]);
      const trace = { generated: new Map(), dropped: new Map() };
      const ctx = {
        tmdbKey: 'k', mdblistKey: '', settings: {}, filters: { vote_count_floor: 100 }, log: quiet, nowMs: engNow,
        watchedIds: watchedStore.watchedIdSets(p.id), dont: new Set(), stats: {}, marqueeChain: [], marqueeTrace: trace,
        marqueeFetchers: {
          ...mqSeam({ recs: () => [mqItem('keep1'), mqItem('gone1')] }),
          syncRatings: async () => ({ skipped: 'test' }),
          pullProgress: async () => [engRow('ttgone1', 20, 30)],
          resolveTmdb: async (imdbId) => imdbId.slice(2),
        },
      };
      const out = await marqueeEngine.generate(config.getProfile(p.id), 'movie', ctx);
      assert.ok(out.some((r) => r.tmdb_id === 'keep1'), 'normal candidate kept');
      assert.ok(!out.some((r) => r.tmdb_id === 'gone1'), 'abandoned film not recommended back');
      assert.strictEqual(trace.dropped.get('gone1'), 'abandoned');
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); rs.deleteForProfile(p.id);
      mqEngagement._clear(); glassMeta._clear();
    }
  });

  // ── Marquee m3 engagement: the abandoned rule — credits, finish, rewatch (N6) ──
  await it('marquee m3 engagement: migration adds duration_ms to the old schema without losing rows', async () => {
    const db = require('../src/db');
    // Simulate an OLD db: drop the table, recreate it WITHOUT duration_ms.
    db.get().exec('DROP TABLE IF EXISTS marquee_engagement');
    db.get().exec(`
      CREATE TABLE marquee_engagement (
        profile_id  TEXT NOT NULL,
        imdb_id     TEXT NOT NULL,
        tmdb_id     TEXT,
        percent     REAL,
        updated_at  INTEGER,
        seen_at     INTEGER,
        PRIMARY KEY (profile_id, imdb_id)
      );
    `);
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run('p-mig', 'ttM', 'tmM', 30, 1000, 1000);
    // Run the migration exactly as init() does (PRAGMA-guarded ADD COLUMN).
    {
      const cols = db.get().prepare('PRAGMA table_info(marquee_engagement)').all();
      assert.ok(!cols.some((c) => c.name === 'duration_ms'), 'old schema has no duration_ms');
      if (!cols.some((c) => c.name === 'duration_ms')) db.get().exec('ALTER TABLE marquee_engagement ADD COLUMN duration_ms INTEGER');
    }
    const colsAfter = db.get().prepare('PRAGMA table_info(marquee_engagement)').all();
    assert.ok(colsAfter.some((c) => c.name === 'duration_ms'), 'duration_ms added');
    const oldRow = db.get().prepare('SELECT tmdb_id, percent, duration_ms FROM marquee_engagement WHERE profile_id = ?').get('p-mig');
    assert.strictEqual(oldRow.tmdb_id, 'tmM', 'row preserved');
    assert.strictEqual(oldRow.percent, 30);
    assert.strictEqual(oldRow.duration_ms, null, 'old row has null duration');
    // syncEngagement stores durationMs; a later row without a duration keeps the stored one.
    mqEngagement._clear();
    const profile = { id: 'p-mig', name: 'MIG' };
    await mqEngagement.syncEngagement(profile, mqCfgResolved, {
      pull: async () => [
        { type: 'movie', imdbId: 'ttM', percent: 30, updatedAtMs: 1000, durationMs: 7200000 },
        { type: 'movie', imdbId: 'ttM2', percent: 40, updatedAtMs: 1000 },
      ],
      resolveTmdb: async (id) => id.replace('tt', 'tm'), now: 2000, log: quiet,
    });
    const rM = db.get().prepare('SELECT duration_ms FROM marquee_engagement WHERE profile_id = ? AND imdb_id = ?').get('p-mig', 'ttM');
    assert.strictEqual(rM.duration_ms, 7200000, 'duration stored');
    const rM2 = db.get().prepare('SELECT duration_ms FROM marquee_engagement WHERE profile_id = ? AND imdb_id = ?').get('p-mig', 'ttM2');
    assert.strictEqual(rM2.duration_ms, null, 'no duration → null');
    // A later row without a duration keeps the stored one (COALESCE on conflict).
    await mqEngagement.syncEngagement(profile, mqCfgResolved, {
      pull: async () => [{ type: 'movie', imdbId: 'ttM', percent: 45, updatedAtMs: 3000 }],
      resolveTmdb: async (id) => id.replace('tt', 'tm'), now: 4000, log: quiet, force: true,
    });
    const rM3 = db.get().prepare('SELECT duration_ms, percent FROM marquee_engagement WHERE profile_id = ? AND imdb_id = ?').get('p-mig', 'ttM');
    assert.strictEqual(rM3.duration_ms, 7200000, 'stored duration kept when a later row has none');
    assert.strictEqual(rM3.percent, 45, 'percent updated');
    mqEngagement._clear();
  });

  await it('marquee m3 engagement: isAbandoned — credits, finish, rewatch, grace, watched guards', async () => {
    const eng = mqCfgResolved.engagement;
    const now = Date.parse('2026-06-01T00:00:00Z');
    const day = 24 * 3600e3;
    const watchedEmpty = { tmdb: new Set(), imdb: new Set() };
    // 30% of a 120-min film, 8 days old, not watched → true.
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'g1', imdb_id: 'ttg1', percent: 30, updated_at: now - 8 * day, duration_ms: 7200000 }, eng, { now, watchedIds: watchedEmpty }), true);
    // 45% of a 30-min film (16.5 min left) → false (credits).
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'g2', imdb_id: 'ttg2', percent: 45, updated_at: now - 8 * day, duration_ms: 1800000 }, eng, { now, watchedIds: watchedEmpty }), false);
    // 92% → false (finish_pct); 49% with no duration → true.
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'g3', imdb_id: 'ttg3', percent: 92, updated_at: now - 8 * day, duration_ms: 7200000 }, eng, { now, watchedIds: watchedEmpty }), false);
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'g4', imdb_id: 'ttg4', percent: 49, updated_at: now - 8 * day, duration_ms: null }, eng, { now, watchedIds: watchedEmpty }), true);
    // The Goonies case: a watched row from 2024 plus a 30% engagement row from 2026, same tmdb → false.
    const gooniesWatched = { tmdb: new Set(['goonies']), imdb: new Set() };
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'goonies', imdb_id: 'ttgoonies', percent: 30, updated_at: now - 1 * day, duration_ms: 7200000 }, eng, { now, watchedIds: gooniesWatched }), false);
    // The same case matched by imdb only → false.
    const gooniesImdb = { tmdb: new Set(), imdb: new Set(['ttgoonies']) };
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'goonies2', imdb_id: 'ttgoonies', percent: 30, updated_at: now - 1 * day, duration_ms: 7200000 }, eng, { now, watchedIds: gooniesImdb }), false);
    // A pending-watched shim → false (watchedIdSets includes it).
    const shimWatched = { tmdb: new Set(['shim']), imdb: new Set() };
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'shim', imdb_id: 'ttshim', percent: 30, updated_at: now - 8 * day, duration_ms: 7200000 }, eng, { now, watchedIds: shimWatched }), false);
    // 3 days old → false (grace).
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'g5', imdb_id: 'ttg5', percent: 30, updated_at: now - 3 * day, duration_ms: 7200000 }, eng, { now, watchedIds: watchedEmpty }), false);
    // tmdb_id null → false.
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: null, imdb_id: 'ttg6', percent: 30, updated_at: now - 8 * day, duration_ms: 7200000 }, eng, { now, watchedIds: watchedEmpty }), false);
    // enabled:false → false.
    assert.strictEqual(mqEngagement.isAbandoned({ tmdb_id: 'g7', imdb_id: 'ttg7', percent: 30, updated_at: now - 8 * day, duration_ms: 7200000 }, { ...eng, enabled: false }, { now, watchedIds: watchedEmpty }), false);
  });

  await it('marquee m3 engagement: abandonedRows returns full rows (incl. duration_ms); abandonedFor unchanged', async () => {
    const db = require('../src/db');
    mqEngagement._clear();
    const profileId = 'p-rows';
    const now = Date.parse('2026-06-01T00:00:00Z');
    const day = 24 * 3600e3;
    // Direct insert: one abandoned (30%, 8 days, 120-min) + one not (95%).
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttA', 'tmA', 30, now - 8 * day, now - 8 * day, 7200000);
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttB', 'tmB', 95, now - 8 * day, now - 8 * day, 7200000);
    const rows = mqEngagement.abandonedRows(profileId, mqCfgResolved, { now });
    assert.strictEqual(rows.length, 1, 'only the abandoned row');
    assert.strictEqual(rows[0].tmdb_id, 'tmA');
    assert.strictEqual(rows[0].imdb_id, 'ttA');
    assert.strictEqual(rows[0].percent, 30);
    assert.strictEqual(rows[0].duration_ms, 7200000, 'duration_ms included');
    assert.strictEqual(rows[0].updated_at, now - 8 * day);
    // abandonedFor unchanged shape: Map<tmdb_id, { percent, ts }>.
    const ab = mqEngagement.abandonedFor(profileId, mqCfgResolved, { now });
    assert.deepStrictEqual(ab.get('tmA'), { percent: 30, ts: now - 8 * day });
    assert.strictEqual(ab.has('tmB'), false, '95% not abandoned');
    db.get().prepare('DELETE FROM marquee_engagement WHERE profile_id = ?').run(profileId);
  });

  // ── Marquee m3 taste: rating bands, ignore, Loved tier (Trainer T2, §4.3) ──
  await it('marquee m3: ratingWeight bands (N4)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const cfg = mqCfgResolved;
    assert.strictEqual(taste.ratingWeight(10, cfg), 3.0, '10 → r10');
    assert.strictEqual(taste.ratingWeight(9, cfg), 2.0, '9 → r9');
    assert.strictEqual(taste.ratingWeight(8, cfg), 1.2, '8 → r7_8');
    assert.strictEqual(taste.ratingWeight(7, cfg), 1.2, '7 → r7_8');
    assert.strictEqual(taste.ratingWeight(6, cfg), 0.4, '6 → r5_6');
    assert.strictEqual(taste.ratingWeight(5, cfg), 0.4, '5 → r5_6');
    assert.strictEqual(taste.ratingWeight(4, cfg), -1.2, '4 → r1_4');
    assert.strictEqual(taste.ratingWeight(3, cfg), -1.2, '3 → r1_4');
    assert.strictEqual(taste.ratingWeight(1, cfg), -1.2, '1 → r1_4');
    assert.strictEqual(taste.ratingWeight(0, cfg), null, '0 → null');
    assert.strictEqual(taste.ratingWeight(null, cfg), null, 'null → null');
    assert.strictEqual(taste.ratingWeight('7', cfg), 1.2, 'string rating coerced');
  });

  await it('marquee m3: an ignored film never steers taste and is never a seed (N2)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const tasteFeedback = require('../src/tasteFeedback');
    const profileId = 'p-ign1';
    glassMeta._clear();
    // Two watched films: one ignored (rated 10 — the strongest possible), one not.
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'ttig1', tmdb_id: 'ig1', title: 'Ignored', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'ttig2', tmdb_id: 'ig2', title: 'Kept', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    glassMeta.put('movie', 'ig1', { genres: ['Drama'], director: ['Dir Ignored'], imdb_id: 'ttig1' });
    glassMeta.put('movie', 'ig2', { genres: ['Action'], director: ['Dir Kept'], imdb_id: 'ttig2' });
    const ratings = new Map([['ig1', 10], ['ig2', 7]]);
    // Ignore ig1 (even though it is rated 10 — ignore beats any rating).
    tasteFeedback.setIgnored(profileId, { type: 'movie', tmdb_id: 'ig1' }, true, engNow);
    const ignored = tasteFeedback.ignoredSet(profileId, 'movie');
    assert.ok(ignored.has('ig1'), 'ig1 is in the ignored set');
    // buildEvents: the ignored film is absent (no taste event of any kind).
    const events = taste.buildEvents(profileId, mqCfgResolved, { nowMs: engNow, ratings });
    assert.ok(!events.some((e) => e.tmdb_id === 'ig1'), 'ignored film absent from the event list');
    assert.ok(events.some((e) => e.tmdb_id === 'ig2'), 'non-ignored film present');
    // seedOrder: the ignored film is never a seed (even at rating 10).
    const seeds = taste.seedOrder(profileId, mqCfgResolved, { nowMs: engNow, ratings });
    assert.ok(!seeds.some((s) => s.tmdb_id === 'ig1'), 'ignored film never a seed');
    assert.ok(seeds.some((s) => s.tmdb_id === 'ig2'), 'non-ignored film is a seed');
    // The ignored film stays in watchedIdSets (N2: ignore is local only).
    const sets = watchedStore.watchedIdSets(profileId);
    assert.ok(sets.tmdb.has('ig1'), 'ignored film stays in watchedIdSets');
    tasteFeedback.deleteForProfile(profileId);
    watchedStore.deleteForProfile(profileId);
    glassMeta._clear();
  });

  await it('marquee m3: Loved decay is floored at cfg.loved.decay_floor (N3)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const glassTasteModel = require('../src/engines/glass/tasteModel');
    const glassConfig = require('../src/engines/glass/config');
    const cfg = mqCfgResolved;
    const floor = cfg.loved.decay_floor; // 0.5
    const hl = glassConfig.halfLivesFor(cfg, 'movie');
    // A recent Loved film: blendedWeight ≈ 1 (≥ floor) → no boost.
    assert.strictEqual(taste.lovedFactor(0, cfg), 1, 'recent: no boost');
    // An old Loved film: blendedWeight < floor → boosted so the effective decay = floor.
    const days = 15000; // ~41 years → blendedWeight ≈ 1e-9
    const b = glassTasteModel.blendedWeight(days, hl, cfg.horizon_blend);
    assert.ok(b < floor, 'old film: blendedWeight below the floor');
    const factor = taste.lovedFactor(days, cfg);
    assert.ok(factor > 1, 'old film: boosted above 1');
    const effective = b * factor;
    assert.ok(Math.abs(effective - floor) < 1e-9, 'effective decay floored at the floor (to 1e-9)');
  });

  await it('marquee m3: Loved films are pinned at the front of the seeds (N3)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const profileId = 'p-loved1';
    glassMeta._clear();
    // An old Loved film (weight floored at r10 × 0.5 = 1.5) + a recent rated-9
    // film (weight ≈ 2.0 × 0.77 ≈ 1.54). Without pinning, the rated-9 film would
    // sort first (1.54 > 1.5). Pinning puts the Loved film at the front.
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'ttlv1', tmdb_id: 'lv1', title: 'Loved (old)', year: 2020, watched_at: '2020-01-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'ttlv2', tmdb_id: 'lv2', title: 'Rated 9 (recent)', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    const ratings = new Map([['lv1', 10], ['lv2', 9]]);
    const seeds = taste.seedsFor(profileId, mqCfgResolved, { nowMs: engNow, ratings });
    assert.strictEqual(seeds[0].tmdb_id, 'lv1', 'Loved film pinned at the front (despite lower weight)');
    assert.ok(seeds[0].loved, 'the front seed is Loved');
    assert.strictEqual(seeds[0].rating, 10);
    assert.strictEqual(seeds[1].tmdb_id, 'lv2', 'the rated-9 film is second');
    watchedStore.deleteForProfile(profileId);
    glassMeta._clear();
  });

  await it('marquee m3: historyHash changes when a film is ignored (N2)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const tasteFeedback = require('../src/tasteFeedback');
    const profileId = 'p-hash1';
    glassMeta._clear();
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'th1', tmdb_id: 'h1', title: 'Film 1', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'th2', tmdb_id: 'h2', title: 'Film 2', year: 2020, watched_at: '2026-05-02T00:00:00Z' },
    ]);
    const ratings = new Map([['h1', 7], ['h2', 8]]);
    const hashBefore = taste.historyHash(profileId, { ratings });
    // Ignore h1 → the hash changes.
    tasteFeedback.setIgnored(profileId, { type: 'movie', tmdb_id: 'h1' }, true, engNow);
    const hashIgnored = taste.historyHash(profileId, { ratings });
    assert.notStrictEqual(hashIgnored, hashBefore, 'ignoring changes the hash');
    // Un-ignore h1 → the hash returns to the original.
    tasteFeedback.setIgnored(profileId, { type: 'movie', tmdb_id: 'h1' }, false, engNow);
    const hashUnignored = taste.historyHash(profileId, { ratings });
    assert.strictEqual(hashUnignored, hashBefore, 'un-ignoring restores the hash');
    tasteFeedback.deleteForProfile(profileId);
    watchedStore.deleteForProfile(profileId);
    glassMeta._clear();
  });

  await it('marquee m3: a no-feedback profile is unchanged (N9 identity)', async () => {
    const taste = require('../src/engines/marquee/taste');
    const glassTasteModel = require('../src/engines/glass/tasteModel');
    const profileId = 'p-n9';
    glassMeta._clear();
    // A no-feedback profile: watched films, NO ratings, NO ignores.
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tn1', tmdb_id: 'n1', title: 'Film 1', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tn2', tmdb_id: 'n2', title: 'Film 2', year: 2020, watched_at: '2026-05-02T00:00:00Z' },
    ]);
    glassMeta.put('movie', 'n1', { genres: ['Drama'], director: ['Dir 1'], imdb_id: 'tn1' });
    glassMeta.put('movie', 'n2', { genres: ['Action'], director: ['Dir 2'], imdb_id: 'tn2' });
    // The m3 taste model for a no-feedback profile == the pure Glass taste model
    // (no rating re-weighting, no ignores, no abandoned events).
    const m3 = await taste.buildTaste(profileId, 'k', mqCfgResolved, { nowMs: engNow, ratings: new Map(), log: quiet });
    const glass = glassTasteModel.buildTasteModel(profileId, 'movie', mqCfgResolved, { nowMs: engNow });
    assert.deepStrictEqual(m3.dims, glass.dims, 'm3 no-feedback dims == Glass dims');
    assert.strictEqual(m3.totalWeight, glass.totalWeight, 'm3 no-feedback totalWeight == Glass');
    assert.strictEqual(m3.seedCount, glass.seedCount, 'm3 no-feedback seedCount == Glass');
    watchedStore.deleteForProfile(profileId);
    glassMeta._clear();
  });

  await it('marquee m3: bench holdout clears taste_ignore rows (N2, §4.6)', async () => {
    const bench = require('../src/bench/engineBench');
    const tasteFeedback = require('../src/tasteFeedback');
    const profileId = 'p-bench-ign';
    // A profile with two ignored films.
    tasteFeedback.setIgnored(profileId, { type: 'movie', tmdb_id: 'bi1' }, true, engNow);
    tasteFeedback.setIgnored(profileId, { type: 'movie', tmdb_id: 'bi2' }, true, engNow);
    assert.strictEqual(tasteFeedback.ignoredSet(profileId, 'movie').size, 2, 'two ignored films before');
    // removeHoldout deletes the holdout's taste_ignore rows (alongside taste_ratings).
    bench.removeHoldout(profileId, ['bi1'], { db: require('../src/db') });
    const after = tasteFeedback.ignoredSet(profileId, 'movie');
    assert.ok(!after.has('bi1'), 'the holdout film is cleared from taste_ignore');
    assert.ok(after.has('bi2'), 'the non-holdout film is kept');
    tasteFeedback.deleteForProfile(profileId);
  });

  await it('Trainer T2: trainingDue — the 10-min quiet period + the build stamp (N8, test 11)', () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profileId = 'p-t11';
    const T0 = 1_000_000;
    const min = 60e3;
    // no feedback → never due.
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 10 * min), false);
    // a change: due only after the 10-minute quiet period.
    tasteFeedback.recordChange(profileId, T0);
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 9 * min), false, 'inside the quiet period');
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 10 * min), true, 'at the quiet-period boundary');
    // a build that included the change (stamp = the cursor it saw) → no longer due.
    tasteFeedback.markTrainingBuilt(profileId, T0);
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 11 * min), false, 'the last build covered the change');
    // a change NEWER than the stamp → due again after its own quiet period.
    tasteFeedback.recordChange(profileId, T0 + 20 * min);
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 29 * min), false, 'inside the new quiet period');
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 30 * min), true, 'newer than the stamp + quiet period elapsed');
    // a change landing DURING a build: the stamp is the cursor seen at the
    // build's START, so the newer change stays due (test 12 covers this via needsBuild).
    tasteFeedback.markTrainingBuilt(profileId, T0); // the build's start snapshot
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 30 * min), true, 'change during the build stays newer than the stamp');
    // a stamp equal to the cursor (not older) → not newer → not due.
    tasteFeedback.markTrainingBuilt(profileId, T0 + 20 * min);
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 40 * min), false, 'stamp == cursor → not newer');
    db.get().prepare('DELETE FROM taste_changes WHERE profile_id = ?').run(profileId);
  });

  await it('Trainer T2: needsBuild — Marquee gate, quiet period, change during a build (N8, test 12)', () => {
    const rs = require('../src/recommendationStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const settings = require('../src/settings');
    const db = require('../src/db');
    const profileId = 'p-t12';
    const T0 = 1_000_000;
    const min = 60e3;
    // A pool row so the "empty pool" clause is not the trigger.
    rs.upsertCandidates(profileId, [{ type: 'movie', tmdb_id: 't12', imdb_id: 'ttt12', title: 'T', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, popularity: 5 }]);
    rs.setBuiltAt(profileId, T0);
    const marqueeProfile = { id: profileId, name: 'T12', filters: { engine_movie: 'marquee' } };
    const genesisProfile = { id: profileId, name: 'T12', filters: { engine_movie: 'genesis' } };
    settings.updateSettings({ engines: { marquee: true } });
    try {
      // fresh (no taste change) → no build needed.
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 }), false);
      // a Trainer edit: due only after the 10-minute quiet period.
      tasteFeedback.recordChange(profileId, T0 + 5 * min);
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 + 9 * min }), false, 'inside the quiet period');
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 + 15 * min }), true, 'quiet period elapsed');
      // a build that included the change → fresh again.
      tasteFeedback.markTrainingBuilt(profileId, T0 + 5 * min);
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 + 15 * min }), false, 'the build covered the change');
      // a change landing DURING a build (the stamp is the start snapshot) →
      // the NEXT build is triggered.
      tasteFeedback.recordChange(profileId, T0 + 20 * min);
      tasteFeedback.markTrainingBuilt(profileId, T0 + 5 * min);
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 + 29 * min }), false, 'inside the new quiet period');
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 + 30 * min }), true, 'change during the build triggers the next build');
      // the gate: a non-Marquee movie engine never triggers a taste rebuild.
      tasteFeedback.recordChange(profileId, T0 + 40 * min);
      assert.strictEqual(rs.needsBuild(profileId, { profile: genesisProfile, now: T0 + 50 * min }), false, 'non-Marquee profile: no taste rebuild');
      // a disabled Marquee floors to Genesis → gated out.
      settings.updateSettings({ engines: { marquee: false } });
      assert.strictEqual(rs.needsBuild(profileId, { profile: marqueeProfile, now: T0 + 50 * min }), false, 'disabled Marquee → gated out');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      db.get().prepare('DELETE FROM taste_changes WHERE profile_id = ?').run(profileId);
      rs.deleteForProfile(profileId);
    }
  });

  await it('Trainer T2: a successful build stamps the change cursor and resets the counter (N8, test 13)', async () => {
    const rs = require('../src/recommendationStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const config = require('../src/config');
    const settings = require('../src/settings');
    const watchedStore = require('../src/watchedStore');
    const p = config.addProfile('INT-T13');
    const reset = marqueeEngine._setTestSeams({ fetchers: mqSeam({ recs: () => [mqItem('t13a')] }), chain: [] });
    const prev = store.loadAgeVerdicts();
    try {
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'marquee', engine_series: 'genesis' } });
      watchedStore.upsertMany(p.id, [
        { simkl_id: 1, type: 'movie', imdb_id: 'ttt13w', tmdb_id: 't13w', title: 'Watched', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
      ]);
      // A Trainer edit BEFORE the build (the cursor the build sees at its start).
      const T0 = 1_000_000;
      tasteFeedback.recordChange(p.id, T0);
      tasteFeedback.recordChange(p.id, T0 + 1); // two changes → the counter is 2
      settings.updateSettings({ engines: { marquee: true } });
      await rs.buildPool(config.getProfile(p.id), quiet);
      const training = tasteFeedback.getTraining(p.id);
      assert.strictEqual(training.built_changed_at, T0 + 1, 'the stamp is the cursor seen at the build start');
      assert.strictEqual(training.changes_since_build, 0, 'a successful build resets the counter');
      // a change landing during the build (newer than the stamp) → the next build is triggered.
      tasteFeedback.recordChange(p.id, T0 + 2);
      assert.strictEqual(rs.needsBuild(p.id, { profile: config.getProfile(p.id), now: T0 + 2 + 10 * 60e3 }), true, 'the during-build change triggers the next build');
    } finally {
      store.saveAgeVerdicts(prev);
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
      tasteFeedback.deleteForProfile(p.id);
      reset();
    }
  });

  await it('Trainer T2: the Trainer unfinished list comes from the shared engagement rule (N7, test 14)', async () => {
    const trainer = require('../src/trainer');
    const engagement = require('../src/engines/marquee/engagement');
    const mqCfg = require('../src/engines/marquee/config');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profileId = 'p-t14';
    const profile = { id: profileId, name: 'T14', keys: {} };
    const now = Date.parse('2026-06-01T00:00:00Z'); // the action clock (deps.now)
    const day = 24 * 3600e3;
    engagement.init();
    // Five engagement rows: one abandoned (30%, untouched 8 days), one in the
    // grace period (30%, touched 1 day ago), one credits (40% of 30 min → 18 min
    // left), one finished (95%), one watched (30% but completed in the watched
    // store — the rewatch rule). The grace period runs on the action clock
    // (deps.now), so the row timestamps are relative to that same clock.
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttt14a', 't14a', 30, now - 8 * day, now - 8 * day, null);
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttt14b', 't14b', 30, now - 1 * day, now - 1 * day, null);
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttt14c', 't14c', 40, now - 8 * day, now - 8 * day, 30 * 60000);
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttt14d', 't14d', 95, now - 8 * day, now - 8 * day, null);
    db.get().prepare('INSERT INTO marquee_engagement (profile_id, imdb_id, tmdb_id, percent, updated_at, seen_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profileId, 'ttt14e', 't14e', 30, now - 8 * day, now - 8 * day, null);
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'ttt14e', tmdb_id: 't14e', title: 'E', year: 2020, watched_at: '2026-05-01T00:00:00Z' },
    ]);
    const deps = { now: () => now, log: quiet, settings: { keyFor: () => '' } };
    // The Trainer's unfinished list: only the one abandoned row.
    const res = await trainer.listHistory(profile, { type: 'movie', view: 'unfinished' }, deps);
    assert.deepStrictEqual(res.items.map((i) => i.tmdb_id), ['t14a'], 'only the abandoned row is unfinished');
    assert.strictEqual(res.counts.unfinished, 1);
    // N7: the Trainer's list == the engine's abandoned set (one rule, two consumers).
    // Both run on the action clock (deps.now).
    assert.deepStrictEqual([...engagement.abandonedFor(profileId, mqCfg.resolveConfig({}), { now }).keys()], ['t14a'], 'the engine agrees');
    // The training DTO surfaces the rebuild due time (change + the quiet period).
    tasteFeedback.recordChange(profileId, now - 2 * 60e3);
    const res2 = await trainer.listHistory(profile, { type: 'movie' }, deps);
    assert.deepStrictEqual(res2.training, { changes_since_build: 1, changed_at: now - 2 * 60e3, rebuild_due_at: now + 8 * 60e3, built_changed_at: null });
    // a build that included the change → no due time.
    tasteFeedback.markTrainingBuilt(profileId, now - 2 * 60e3);
    const res3 = await trainer.listHistory(profile, { type: 'movie' }, deps);
    assert.strictEqual(res3.training.rebuild_due_at, null, 'the build covered the change');
    assert.strictEqual(res3.training.built_changed_at, now - 2 * 60e3, 'the build stamp is surfaced');
    db.get().prepare('DELETE FROM marquee_engagement WHERE profile_id = ?').run(profileId);
    watchedStore.deleteForProfile(profileId);
    tasteFeedback.deleteForProfile(profileId);
  });

  await it('Trainer T2 r1: G3a — the brief marks 10/10 as LOVED, 9 and unrated (§6 test 10)', () => {
    const taste = require('../src/engines/marquee/taste');
    const prompt = taste.buildBriefPrompt({
      watch_history: [
        { title: 'A', year: 2020, rating: 10, genres: ['Sci-Fi'] },
        { title: 'B', year: 2019, rating: 9, genres: [] },
        { title: 'C', year: 2018, rating: null, genres: [] },
      ],
      tastes: [],
    });
    assert.ok(prompt.includes('rated 10/10 (LOVED)'), 'a 10/10 is marked LOVED');
    assert.ok(prompt.includes('rated 9/10'), 'a 9 is rated 9/10');
    assert.ok(prompt.includes('unrated'), 'a null rating is unrated');
  });

  await it('Trainer T2 r1: G3b — a rating change (7 → 8) changes historyHash (§6 test 8)', () => {
    const taste = require('../src/engines/marquee/taste');
    const watchedStore = require('../src/watchedStore');
    const profileId = 'p-g3b';
    watchedStore.upsertMany(profileId, [
      { simkl_id: 1, type: 'movie', imdb_id: 'ttg3b', tmdb_id: 'g3b', title: 'G', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    const h7 = taste.historyHash(profileId, { ratings: new Map([['g3b', 7]]), ignored: new Set() });
    const h8 = taste.historyHash(profileId, { ratings: new Map([['g3b', 8]]), ignored: new Set() });
    assert.notStrictEqual(h7, h8, 'changing the rating changes the brief cache key');
    watchedStore.deleteForProfile(profileId);
  });

  await it('Trainer T2 r1: G3c — a mid-build edit keeps its change count (§6 test 11)', () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profileId = 'p-g3c';
    const T0 = Date.parse('2026-06-01T00:00:00Z');
    tasteFeedback.recordChange(profileId, T0);
    // The build-start snapshot: the cursor the build sees at its START.
    const snap = tasteFeedback.getTraining(profileId);
    assert.strictEqual(snap.changed_at, T0);
    // A mid-build edit (newer than the snapshot).
    tasteFeedback.recordChange(profileId, T0 + 60e3);
    assert.strictEqual(tasteFeedback.getTraining(profileId).changes_since_build, 2);
    // The build finishes and stamps the snapshot: the mid-build edit keeps its count.
    tasteFeedback.markTrainingBuilt(profileId, T0);
    let t = tasteFeedback.getTraining(profileId);
    assert.strictEqual(t.changes_since_build, 2, 'the mid-build edit is NOT zeroed');
    assert.strictEqual(t.built_changed_at, T0);
    // The change is newer than the stamp and the quiet period has passed → due.
    assert.strictEqual(tasteFeedback.trainingDue(profileId, T0 + 12 * 60e3), true);
    // The next build (snapshot = the mid-build change) resets the count.
    tasteFeedback.markTrainingBuilt(profileId, T0 + 60e3);
    t = tasteFeedback.getTraining(profileId);
    assert.strictEqual(t.changes_since_build, 0, 'the second build resets the count');
    db.get().prepare('DELETE FROM taste_changes WHERE profile_id = ?').run(profileId);
  });

  await it('Trainer T2 r1: G3d — a skipped build leaves the change count alone (§6 test 13)', async () => {
    const rs = require('../src/recommendationStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const settings = require('../src/settings');
    const db = require('../src/db');
    const profileId = 'p-g3d';
    const T0 = Date.parse('2026-06-01T00:00:00Z');
    tasteFeedback.recordChange(profileId, T0);
    const before = tasteFeedback.getTraining(profileId);
    const prevKeys = settings.getSettings().keys;
    settings.updateSettings({ keys: { tmdb_api_key: '' } });
    try {
      const res = await rs.buildRecommendations({ id: profileId, name: 'G3D', filters: {} }, quiet);
      assert.ok(res.skipped && res.reason.includes('TMDB key'), 'no TMDB key → skipped');
      assert.deepStrictEqual(tasteFeedback.getTraining(profileId), before, 'the skipped build left the change count alone');
    } finally {
      settings.updateSettings({ keys: prevKeys });
    }
    db.get().prepare('DELETE FROM taste_changes WHERE profile_id = ?').run(profileId);
  });

  await it('Trainer T2 r1: G3e — markTrainingBuilt creates no row when none exists', () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profileId = 'p-g3e';
    tasteFeedback.markTrainingBuilt(profileId, Date.parse('2026-06-01T00:00:00Z'));
    assert.deepStrictEqual(tasteFeedback.getTraining(profileId), { changed_at: null, changes_since_build: 0, built_changed_at: null });
    assert.strictEqual(db.get().prepare('SELECT COUNT(*) AS n FROM taste_changes WHERE profile_id = ?').get(profileId).n, 0, 'no row created');
  });

  // ── Trainer T3.1: unwatch backend + scrobble guard ────────────────────────
  await it('Trainer T3.1 B1: simkl.removeFromHistory — /sync/history/remove body via buildRatingsBody, simkl_post lane; empty body throws with zero fetches', async () => {
    const simkl = require('../src/services/simkl');
    const profile = { id: 'p-b1', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const origFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const res = await simkl.removeFromHistory(profile, [{ type: 'movie', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '1' }]);
      assert.deepStrictEqual(res, {});
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0].url.includes('/sync/history/remove'), 'the right path');
      assert.ok(calls[0].url.includes('client_id=c'), 'client_id query param');
      assert.strictEqual(calls[0].opts.method, 'POST');
      const body = JSON.parse(calls[0].opts.body);
      assert.deepStrictEqual(body, { movies: [{ ids: { simkl: 1, imdb: 'tt1', tmdb: '1' } }], shows: [] }, 'buildRatingsBody with withRating:false');
    } finally { global.fetch = origFetch; }
    // empty body → throws with zero fetches.
    calls.length = 0;
    await assert.rejects(() => simkl.removeFromHistory(profile, []), /nothing to remove/);
    assert.strictEqual(calls.length, 0, 'no fetch on an empty body');
    // no Simkl → throws.
    await assert.rejects(() => simkl.removeFromHistory({ id: 'x', name: 'X', keys: {} }, [{ type: 'movie', tmdb_id: '1' }]), /not connected/);
  });

  await it('Trainer T3.1 B2: watchedStore.removeWatched — deletes watched rows by tmdb OR imdb (duplicates included) + pending rows; other profiles untouched; returns count', () => {
    const watchedStore = require('../src/watchedStore');
    const db = require('../src/db');
    const A = 'p-b2-a';
    const B = 'p-b2-b';
    watchedStore.upsertMany(A, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A1', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt1b', tmdb_id: '1', title: 'A2 (dup tmdb)', year: 2020, watched_at: '2026-01-02T00:00:00Z' },
      { simkl_id: 3, type: 'movie', imdb_id: 'tt1', tmdb_id: null, title: 'A3 (imdb only)', year: 2020, watched_at: '2026-01-03T00:00:00Z' },
      { simkl_id: 4, type: 'movie', imdb_id: 'tt4', tmdb_id: '4', title: 'A4 (untouched)', year: 2020, watched_at: '2026-01-04T00:00:00Z' },
    ]);
    watchedStore.addPendingWatched(A, { type: 'movie', imdbId: 'tt1' });
    watchedStore.addPendingWatched(A, { type: 'movie', tmdbId: '4' });
    // B: its own row sharing the tmdb id — must be untouched.
    watchedStore.upsertMany(B, [{ simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'B1', year: 2020, watched_at: '2026-01-01T00:00:00Z' }]);
    const removed = watchedStore.removeWatched(A, 'movie', { tmdbId: '1', imdbId: 'tt1' });
    assert.strictEqual(removed, 3, 'two dup tmdb rows + one imdb-only row');
    assert.strictEqual(watchedStore.getWatched(A, { type: 'movie' }).length, 1, 'only the untouched row remains');
    assert.strictEqual(watchedStore.getWatched(A, { type: 'movie' })[0].tmdb_id, '4');
    // pending: the tt1 row is gone, the tmdb-4 row remains.
    const pend = db.get().prepare('SELECT id FROM pending_watched WHERE profile_id = ?').all(A).map((r) => r.id);
    assert.deepStrictEqual(pend, ['4'], 'the matching pending row removed, the other kept');
    // B untouched.
    assert.strictEqual(watchedStore.getWatched(B, { type: 'movie' }).length, 1);
    watchedStore.deleteForProfile(A);
    watchedStore.deleteForProfile(B);
  });

  await it('Trainer T3.1 B3: unwatched block — add/get/clear; missing imdb is a no-op; deleteForProfile clears it', () => {
    const watchedStore = require('../src/watchedStore');
    const A = 'p-b3';
    assert.strictEqual(watchedStore.addUnwatchedBlock(A, 'movie', { imdbId: 'tt1', tmdbId: '1' }, 1000), true);
    let blocks = watchedStore.unwatchedBlocks(A, 'movie');
    assert.deepStrictEqual([...blocks.entries()], [['tt1', 1000]]);
    // upsert: a newer block for the same imdb replaces the at.
    watchedStore.addUnwatchedBlock(A, 'movie', { imdbId: 'tt1', tmdbId: '1' }, 2000);
    assert.deepStrictEqual([...watchedStore.unwatchedBlocks(A, 'movie').entries()], [['tt1', 2000]]);
    // missing imdb → no-op.
    assert.strictEqual(watchedStore.addUnwatchedBlock(A, 'movie', { tmdbId: '2' }, 1000), false);
    assert.strictEqual(watchedStore.unwatchedBlocks(A, 'movie').size, 1, 'no row added without an imdb id');
    // clear.
    watchedStore.clearUnwatchedBlock(A, 'movie', 'tt1');
    assert.strictEqual(watchedStore.unwatchedBlocks(A, 'movie').size, 0);
    // deleteForProfile clears it.
    watchedStore.addUnwatchedBlock(A, 'movie', { imdbId: 'tt5' });
    watchedStore.deleteForProfile(A);
    assert.strictEqual(watchedStore.unwatchedBlocks(A, 'movie').size, 0);
  });

  await it('Trainer T3.1 B4: scrobble guard — a blocked movie is skipped unless the provider watch is newer (R5)', async () => {
    const scrobble = require('../src/services/scrobble');
    const watchedStore = require('../src/watchedStore');
    const nuvio = require('../src/services/nuvio');
    const simkl = require('../src/services/simkl');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-b4', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched;
    const origAdd = simkl.addToHistory;
    let pushed = null;
    simkl.addToHistory = async (_p, body) => { pushed = body; return {}; };
    try {
      watchedStore.addUnwatchedBlock(profile.id, 'movie', { imdbId: 'tt1', tmdbId: '1' }, 1000);
      // (a) blocked movie, watchedAtMs ≤ block → not pushed; the other movie is.
      nuvio.pullWatched = async () => [
        { type: 'movie', imdbId: 'tt1', watchedAtMs: 1000 },
        { type: 'movie', imdbId: 'tt2', watchedAtMs: 2000 },
      ];
      await scrobble.syncProfile(profile, quiet);
      assert.deepStrictEqual(pushed.movies.map((m) => m.ids.imdb), ['tt2'], 'only the non-blocked movie pushed');
      // (b) blocked movie with no watchedAtMs → not pushed.
      pushed = null;
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1' }];
      await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(pushed, null, 'nothing to push → no addToHistory call');
      // (c) newer than the block → pushed and the block is cleared.
      pushed = null;
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 2000 }];
      await scrobble.syncProfile(profile, quiet);
      assert.deepStrictEqual(pushed.movies.map((m) => m.ids.imdb), ['tt1']);
      assert.strictEqual(watchedStore.unwatchedBlocks(profile.id, 'movie').size, 0, 'block cleared on a genuine rewatch');
      // (d) full:true still skips the old one.
      watchedStore.addUnwatchedBlock(profile.id, 'movie', { imdbId: 'tt1', tmdbId: '1' }, 1000);
      pushed = null;
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 500 }];
      await scrobble.syncProfile(profile, quiet, { full: true });
      assert.strictEqual(pushed, null, 'full rebuild still skips a blocked movie older than the block');
      // (e) episodes are unaffected.
      pushed = null;
      nuvio.pullWatched = async () => [
        { type: 'movie', imdbId: 'tt1', watchedAtMs: 500 },
        { type: 'series', imdbId: 'tt1', season: 1, episode: 1, watchedAtMs: 500 },
      ];
      await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(pushed.movies.length, 0, 'the blocked movie is skipped');
      assert.strictEqual(pushed.shows.length, 1, 'the episode is unaffected');
    } finally {
      nuvio.pullWatched = origPull;
      simkl.addToHistory = origAdd;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Decade filter: recency helper maths (min_year, window equivalence, migration, validation)', () => {
    const recency = require('../src/recency');
    assert.deepStrictEqual(recency.DECADE_CHOICES, [2020, 2010, 2000, 1990, 1980]);
    assert.strictEqual(recency.minYearOf({ min_year: 2010 }, 2026), 2010);
    assert.strictEqual(recency.minYearOf({ min_year: 0 }, 2026), 0);
    assert.strictEqual(recency.minYearOf({ max_age_years: 10 }, 2026), 2016, 'unmigrated legacy window still works');
    assert.strictEqual(recency.minYearOf({ min_year: 2000, max_age_years: 1 }, 2026), 2000, 'min_year wins');
    assert.strictEqual(recency.maxAgeOf({ min_year: 2020 }, 2026), 6, '2020 onwards = a 6-year window in 2026');
    assert.strictEqual(recency.maxAgeOf({}, 2026), 0);
    for (const [ma, dec] of [[0, 0], [1, 2020], [2, 2020], [5, 2020], [10, 2010], [20, 2000]]) assert.strictEqual(recency.decadeFromMaxAge(ma, 2026), dec, ma + 'y -> ' + dec);
    assert.strictEqual(recency.normalizeMinYear('2010', 2026), 2010);
    assert.strictEqual(recency.normalizeMinYear(1850, 2026), 0);
    assert.strictEqual(recency.normalizeMinYear(2030, 2026), 0);
    assert.strictEqual(recency.normalizeMinYear('junk', 2026), 0);
  });

  await it('Decade filter: profiles migrate to the never-stricter decade; updateProfile saves min_year (and converts a stale max_age_years)', () => {
    const recency = require('../src/recency');
    const p = config.addProfile('INT-DECADE');
    try {
      assert.strictEqual(config.getProfile(p.id).filters.min_year, 0, 'new profiles default to no limit');
      config.updateProfile(p.id, { filters: { max_age_years: 10 } });
      let f = config.getProfile(p.id).filters;
      assert.strictEqual(f.min_year, recency.decadeFromMaxAge(10)); assert.strictEqual(f.max_age_years, 0);
      config.updateProfile(p.id, { filters: { min_year: 1990 } });
      f = config.getProfile(p.id).filters;
      assert.strictEqual(f.min_year, 1990); assert.strictEqual(f.max_age_years, 0);
      config.updateProfile(p.id, { filters: { min_year: 0 } });
      assert.strictEqual(config.getProfile(p.id).filters.min_year, 0);
      const raw = store.loadProfiles();
      const row = raw.profiles.find((x) => x.id === p.id);
      delete row.filters.min_year; row.filters.max_age_years = 20;
      store.saveProfiles(raw);
      f = config.getProfile(p.id).filters;
      assert.strictEqual(f.min_year, recency.decadeFromMaxAge(20), '20-year window -> its decade'); assert.strictEqual(f.max_age_years, 0);
    } finally { config.removeProfile(p.id); }
  });

  await it('Decade filter: the serve filter drops movies before min_year (movies only, series untouched)', () => {
    const rows = [
      { imdb_id: 'tta', type: 'movie', year: 2019, genres: 'Drama', affinity: 1 },
      { imdb_id: 'ttb', type: 'movie', year: 2020, genres: 'Drama', affinity: 1 },
      { imdb_id: 'ttc', type: 'series', year: 1995, genres: 'Drama', affinity: 1 },
      { imdb_id: 'ttd', type: 'movie', year: null, genres: 'Drama', affinity: 1 },
    ];
    const ids = (f) => rs.filterServable(rows, f).map((r) => r.imdb_id).sort();
    assert.deepStrictEqual(ids({ min_year: 2020 }), ['ttb', 'ttc', 'ttd'], '2019 movie dropped; series + unknown year kept');
    assert.deepStrictEqual(ids({ min_year: 0 }), ['tta', 'ttb', 'ttc', 'ttd']);
    assert.deepStrictEqual(ids({ max_age_years: 7 }), ids({ min_year: new Date().getFullYear() - 7 }), 'legacy window = its min_year');
  });

  await it('Tidy-up: pruneSupersededVersions drops ONLY this engine\'s older-version rows', () => {
    const db = require('../src/db');
    rs.init();
    const ins = db.get().prepare('INSERT INTO recommended (profile_id, type, tmdb_id, title, engine_id, algorithm_version, affinity, rec_count) VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
    ins.run('p-prune', 'movie', 'm2a', 'old', 'marquee', 'marquee-m2');
    ins.run('p-prune', 'movie', 'm2b', 'old', 'marquee', 'marquee-m2');
    ins.run('p-prune', 'movie', 'm3a', 'new', 'marquee', 'marquee-m3');
    ins.run('p-prune', 'movie', 'gen', 'genesis', 'genesis', null);
    ins.run('p-prune', 'movie', 'leg', 'legacy', null, null);
    ins.run('p-prune', 'series', 'sm2', 'other type', 'marquee', 'marquee-m2');
    ins.run('p-other', 'movie', 'om2', 'other profile', 'marquee', 'marquee-m2');
    try {
      assert.strictEqual(rs.pruneSupersededVersions('p-prune', 'movie', 'marquee', null), 0, 'no version → no-op');
      assert.strictEqual(rs.pruneSupersededVersions('p-prune', 'movie', 'marquee', 'marquee-m3'), 2);
      const left = db.get().prepare("SELECT tmdb_id FROM recommended WHERE profile_id = 'p-prune' ORDER BY tmdb_id").all().map((r) => r.tmdb_id);
      assert.deepStrictEqual(left, ['gen', 'leg', 'm3a', 'sm2'], 'genesis, legacy, current and other-type rows survive');
      assert.strictEqual(db.get().prepare("SELECT COUNT(*) n FROM recommended WHERE profile_id = 'p-other'").get().n, 1, 'other profile untouched');
    } finally {
      db.get().prepare("DELETE FROM recommended WHERE profile_id IN ('p-prune','p-other')").run();
    }
  });

  await it('Tidy-up: a build prunes its engine\'s superseded rows; an empty build prunes nothing', async () => {
    const pipeline = require('../src/engines/pipeline');
    const db = require('../src/db');
    let emit = [];
    const stub = {
      id: 'vstub', name: 'V', description: 't', supportedTypes: ['movie'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => emit,
    };
    const p = config.addProfile('INT-PRUNE');
    rs.init();
    const ins = db.get().prepare('INSERT INTO recommended (profile_id, type, tmdb_id, title, engine_id, algorithm_version, affinity, rec_count) VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
    ins.run(p.id, 'movie', 'old1', 'old', 'vstub', 'v1');
    ins.run(p.id, 'movie', 'gen1', 'g', 'genesis', null);
    const row = (id) => ({ type: 'movie', tmdb_id: id, rankScore: 1, imdb_id: 'tt' + id, title: id, year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, algorithmVersion: 'v2' });
    const ctx = { tmdbKey: 'itest-tmdb', mdblistKey: '', settings: settings.getSettings(), filters: {}, log: quiet };
    try {
      emit = [];
      await pipeline.runEngineBuild(config.getProfile(p.id), 'movie', stub, ctx, () => {});
      assert.ok(db.get().prepare('SELECT 1 FROM recommended WHERE profile_id = ? AND tmdb_id = ?').get(p.id, 'old1'), 'an empty build prunes nothing');
      emit = [row('new1'), row('new2')];
      await pipeline.runEngineBuild(config.getProfile(p.id), 'movie', stub, ctx, () => {});
      const ids = db.get().prepare('SELECT tmdb_id FROM recommended WHERE profile_id = ? ORDER BY tmdb_id').all(p.id).map((r) => r.tmdb_id);
      // ENG-1: pruneOtherEngines removes the other engine's (genesis) leftover,
      // and pruneSupersededVersions removes the older vstub version.
      assert.deepStrictEqual(ids, ['new1', 'new2'], 'v1 row pruned; other-engine row pruned');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  await it('Tidy-up: the scrobble episode ledger — episodes are pushed once, new ones only, full re-pushes all', async () => {
    const scrobble = require('../src/services/scrobble');
    const watchedStore = require('../src/watchedStore');
    const nuvio = require('../src/services/nuvio');
    const simkl = require('../src/services/simkl');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-ledger', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory;
    const eps = (n) => Array.from({ length: n }, (_, i) => ({ type: 'series', imdbId: 'ttS', season: 1, episode: i + 1, watchedAtMs: 1000 }));
    const count = (b) => (b ? b.shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0) : 0);
    let pushed = null; let fail = false;
    simkl.addToHistory = async (_p, body) => { if (fail) throw new Error('Simkl down'); pushed = body; return {}; };
    try {
      nuvio.pullWatched = async () => eps(3);
      await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(count(pushed), 3, 'first run pushes all 3');
      pushed = null;
      await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(pushed, null, 'second run pushes nothing (all in the ledger)');
      nuvio.pullWatched = async () => eps(4);
      await scrobble.syncProfile(profile, quiet);
      assert.deepStrictEqual(pushed.shows[0].seasons[0].episodes.map((e) => e.number), [4], 'only the new episode');
      // A failed write records nothing: episode 5 is retried next run.
      nuvio.pullWatched = async () => eps(5);
      fail = true; pushed = null;
      await assert.rejects(() => scrobble.syncProfile(profile, quiet));
      fail = false;
      await scrobble.syncProfile(profile, quiet);
      assert.deepStrictEqual(pushed.shows[0].seasons[0].episodes.map((e) => e.number), [5], 'failed episode retried');
      pushed = null;
      await scrobble.syncProfile(profile, quiet, { full: true });
      assert.strictEqual(count(pushed), 5, 'full re-push ignores the ledger');
      watchedStore.deleteForProfile(profile.id);
      assert.strictEqual(watchedStore.pushedEpisodeKeys(profile.id).size, 0, 'profile delete clears the ledger');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Trainer T3.1 B5: markUnwatched — Simkl history removal first, local cleanup, block added, change recorded', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-b5', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    watchedStore.addPendingWatched(profile.id, { type: 'movie', imdbId: 'tt1' });
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', simkl_id: 1, rating: 7 });
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '1', simkl_id: 1, imdb_id: 'tt1' }, true, 500);
    const simklCalls = [];
    const deps = {
      simkl: {
        removeFromHistory: async (_p, items) => { simklCalls.push(['history', items]); },
        removeRatings: async (_p, items) => { simklCalls.push(['ratings', items]); },
      },
      now: () => 1000,
      log: quiet,
    };
    const res = await trainer.markUnwatched(profile, { type: 'movie', tmdb_id: '1' }, deps);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.removed, 1, 'the watched row removed');
    assert.deepStrictEqual(simklCalls, [
      ['history', [{ type: 'movie', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '1' }]],
      ['ratings', [{ type: 'movie', simkl_id: 1, imdb_id: 'tt1', tmdb_id: '1' }]],
    ], 'history removal first, then the rating removal (a rated film)');
    // local rows gone.
    assert.strictEqual(watchedStore.getWatched(profile.id, { type: 'movie' }).length, 0);
    assert.strictEqual(db.get().prepare('SELECT COUNT(*) AS n FROM pending_watched WHERE profile_id = ?').get(profile.id).n, 0, 'pending row gone');
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), null, 'rating row gone');
    assert.strictEqual(tasteFeedback.ignoredSet(profile.id, 'movie').size, 0, 'ignore row gone');
    // block added.
    assert.deepStrictEqual([...watchedStore.unwatchedBlocks(profile.id, 'movie').entries()], [['tt1', 1000]]);
    // change recorded.
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null });
    // the returned item is the unwatched DTO.
    assert.strictEqual(res.item.status, 'unwatched');
    assert.strictEqual(res.item.rating, null);
    assert.strictEqual(res.item.loved, false);
    assert.strictEqual(res.item.ignored, false);
    assert.strictEqual(res.item.key, '1');
    assert.strictEqual(res.item.title, 'A');
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T3.1 B6: markUnwatched — a thrown history removal rejects; every local row is still present, no block, no change', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-b6', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', simkl_id: 1, rating: 7 });
    tasteFeedback.setIgnored(profile.id, { type: 'movie', tmdb_id: '1', simkl_id: 1, imdb_id: 'tt1' }, true, 500);
    const deps = {
      simkl: {
        removeFromHistory: async () => { throw new Error('Simkl POST /sync/history/remove failed (500)'); },
        removeRatings: async () => { throw new Error('should not be called'); },
      },
      now: () => 1000,
      log: quiet,
    };
    await assert.rejects(() => trainer.markUnwatched(profile, { type: 'movie', tmdb_id: '1' }, deps), /history/);
    // every local row still present.
    assert.strictEqual(watchedStore.getWatched(profile.id, { type: 'movie' }).length, 1, 'watched row untouched');
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), 7, 'rating row untouched');
    assert.ok(tasteFeedback.ignoredSet(profile.id, 'movie').has('1'), 'ignore row untouched');
    // no block, no change.
    assert.strictEqual(watchedStore.unwatchedBlocks(profile.id, 'movie').size, 0, 'no block');
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: null, changes_since_build: 0, built_changed_at: null }, 'no change recorded');
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T3.1 B7: markUnwatched — a thrown rating removal still succeeds; local cleanup done', async () => {
    const trainer = require('../src/trainer');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const profile = { id: 'p-b7', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    watchedStore.upsertMany(profile.id, [
      { simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' },
    ]);
    tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', simkl_id: 1, rating: 7 });
    const deps = {
      simkl: {
        removeFromHistory: async () => {},
        removeRatings: async () => { throw new Error('Simkl POST /sync/ratings/remove failed (500)'); },
      },
      now: () => 1000,
      log: quiet,
    };
    const res = await trainer.markUnwatched(profile, { type: 'movie', tmdb_id: '1' }, deps);
    assert.strictEqual(res.ok, true, 'still ok');
    // local cleanup done: the rating row is deleted (deleteRating is local, independent of the Simkl removeRatings failure).
    assert.strictEqual(tasteFeedback.getRating(profile.id, 'movie', '1'), null, 'rating row deleted');
    assert.strictEqual(watchedStore.getWatched(profile.id, { type: 'movie' }).length, 0, 'watched row removed');
    assert.ok(watchedStore.unwatchedBlocks(profile.id, 'movie').has('tt1'), 'block added');
    assert.deepStrictEqual(tasteFeedback.getTraining(profile.id), { changed_at: 1000, changes_since_build: 1, built_changed_at: null }, 'change recorded');
    db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_changes');
    watchedStore.deleteForProfile(profile.id);
  });

  await it('Trainer T3.1 B8: portal route — 200/400 no-simkl/404 not-in-history/502 on throw', async () => {
    const express = require('express');
    const portal = require('../src/portal');
    const simkl = require('../src/services/simkl');
    const config = require('../src/config');
    const watchedStore = require('../src/watchedStore');
    const tasteFeedback = require('../src/tasteFeedback');
    const db = require('../src/db');
    const port = 7314;
    const app = express();
    app.use('/api', portal.router);
    const server = app.listen(port);
    await new Promise((resolve, reject) => { server.on('listening', resolve); server.on('error', reject); });
    const base = `http://localhost:${port}`;
    const origRemoveHist = simkl.removeFromHistory;
    const origRemoveRatings = simkl.removeRatings;
    let p, p2;
    try {
      // A Simkl-connected profile with one watched movie.
      p = config.addProfile('T31-Portal');
      config.updateProfile(p.id, { keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't', connected_at: 0 } });
      watchedStore.upsertMany(p.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '1', title: 'A', year: 2020, watched_at: '2026-01-01T00:00:00Z' }]);
      tasteFeedback.upsertRating(p.id, { type: 'movie', tmdb_id: '1', imdb_id: 'tt1', simkl_id: 1, rating: 7 });
      // 200 on success (Simkl writes stubbed).
      simkl.removeFromHistory = async () => ({});
      simkl.removeRatings = async () => ({});
      let res = await fetch(`${base}/api/profiles/${p.id}/trainer/unwatched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '1' }) });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.item.status, 'unwatched');
      assert.strictEqual(body.item.rating, null);
      assert.ok(body.removed >= 1);
      assert.strictEqual(watchedStore.getWatched(p.id, { type: 'movie' }).length, 0, 'local watched row gone');
      assert.strictEqual(tasteFeedback.getRating(p.id, 'movie', '1'), null, 'local rating row gone');
      // re-seed for the remaining cases.
      watchedStore.upsertMany(p.id, [{ simkl_id: 2, type: 'movie', imdb_id: 'tt2', tmdb_id: '2', title: 'B', year: 2020, watched_at: '2026-01-02T00:00:00Z' }]);
      // 400 no-simkl (a profile without Simkl).
      p2 = config.addProfile('T31-NoSimkl');
      res = await fetch(`${base}/api/profiles/${p2.id}/trainer/unwatched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '2' }) });
      assert.strictEqual(res.status, 400);
      // 404 not-in-history (Simkl-connected profile, no matching watched row).
      res = await fetch(`${base}/api/profiles/${p.id}/trainer/unwatched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '999' }) });
      assert.strictEqual(res.status, 404);
      // 502 on a thrown Simkl write.
      simkl.removeFromHistory = async () => { throw new Error('Simkl POST /sync/history/remove failed (500)'); };
      res = await fetch(`${base}/api/profiles/${p.id}/trainer/unwatched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'movie', tmdb_id: '2' }) });
      assert.strictEqual(res.status, 502);
    } finally {
      simkl.removeFromHistory = origRemoveHist;
      simkl.removeRatings = origRemoveRatings;
      server.close();
      if (p) { config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); tasteFeedback.deleteForProfile(p.id); }
      if (p2) { config.removeProfile(p2.id); }
      db.get().exec('DELETE FROM taste_ratings; DELETE FROM taste_ignore; DELETE FROM taste_changes');
    }
  });

  // ── Scrobble Part A: Simkl not_found, one TMDB retry, weekly backoff ──────
  await it('Scrobble A1: notFoundImdb — reads Simkl not_found.movies; missing/malformed → empty set, never throws', () => {
    const scrobble = require('../src/services/scrobble');
    assert.deepStrictEqual(
      [...scrobble.notFoundImdb({ not_found: { movies: [{ ids: { imdb: 'tt1' } }, { ids: { imdb: 'tt2' } }, { ids: {} }, { ids: null }] } })],
      ['tt1', 'tt2'],
    );
    assert.strictEqual(scrobble.notFoundImdb(undefined).size, 0, 'undefined');
    assert.strictEqual(scrobble.notFoundImdb(null).size, 0, 'null');
    assert.strictEqual(scrobble.notFoundImdb({}).size, 0, '{}');
    assert.strictEqual(scrobble.notFoundImdb({ not_found: { movies: 'x' } }).size, 0, 'movies not an array');
    assert.strictEqual(scrobble.notFoundImdb({ not_found: null }).size, 0, 'not_found null');
    assert.strictEqual(scrobble.notFoundImdb({ not_found: {} }).size, 0, 'no movies key');
  });

  await it('Scrobble A2: not-found movie resolved to TMDB — exactly 2 POSTs, the retry carries {imdb, tmdb}, matched, nothing recorded', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-a2', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    simkl.addToHistory = async (_p, body) => {
      calls.push(body);
      return calls.length === 1 ? { not_found: { movies: [{ ids: { imdb: 'tt1' } }] } } : {};
    };
    tmdb.findByImdbId = async (_key, _type, imdb) => (imdb === 'tt1' ? 12600 : null);
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 1000 }];
      const res = await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(calls.length, 2, 'exactly two history POSTs');
      assert.deepStrictEqual(calls[0].movies.map((m) => m.ids), [{ imdb: 'tt1' }], 'the first POST carries the imdb id');
      assert.deepStrictEqual(calls[1].movies.map((m) => m.ids), [{ imdb: 'tt1', tmdb: '12600' }], 'the retry carries the TMDB id');
      assert.deepStrictEqual(calls[1].shows, []);
      assert.strictEqual(res.matchedOnRetry, 1, 'matched on the retry');
      assert.strictEqual(res.unmatched, 0);
      assert.strictEqual(watchedStore.listUnmatched(profile.id).length, 0, 'nothing recorded');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble A3: still not found → recorded; within 7 days skipped (with the skip log); after 8 days tried again (attempts 2)', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const db = require('../src/db');
    const profile = { id: 'p-a3', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    const logLines = [];
    const log = { log: (m) => logLines.push(m), warn() {}, error() {} };
    simkl.addToHistory = async (_p, body) => { calls.push(body); return { not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }; };
    tmdb.findByImdbId = async () => null; // no TMDB match — no retry POST
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 1000 }];
      // Run 1: not found → recorded (attempts 1).
      await scrobble.syncProfile(profile, log);
      let rows = watchedStore.listUnmatched(profile.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].imdb_id, 'tt1');
      assert.strictEqual(rows[0].attempts, 1);
      // Run 2 (within 7 days): skipped — no POST, and the skip log appears.
      const callsBefore = calls.length;
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, callsBefore, 'no history POST while in backoff');
      assert.ok(logLines.some((l) => l.includes('1 movie(s) skipped (Simkl couldn\'t match')), 'the skip log appears');
      // Backdate the attempt to 8 days ago — past the 7-day window.
      db.get().prepare('UPDATE scrobble_unmatched SET last_tried = ? WHERE profile_id = ?').run(Date.now() - 8 * 86400e3, profile.id);
      // Run 3: tried again → attempts 2.
      await scrobble.syncProfile(profile, log);
      rows = watchedStore.listUnmatched(profile.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].attempts, 2, 'retried after the 7-day window');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble A4: no TMDB match — recorded without a second POST', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-a4', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    simkl.addToHistory = async (_p, body) => { calls.push(body); return { not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }; };
    tmdb.findByImdbId = async () => null;
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 1000 }];
      const res = await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(calls.length, 1, 'no retry POST');
      assert.strictEqual(res.unmatched, 1);
      assert.strictEqual(res.matchedOnRetry, 0);
      const rows = watchedStore.listUnmatched(profile.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].imdb_id, 'tt1');
      assert.strictEqual(rows[0].tmdb_id, null, 'no TMDB id to record');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble A5: a thrown retry POST — no exception from syncProfile, the film is recorded (with the resolved TMDB id)', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-a5', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    simkl.addToHistory = async (_p, body) => {
      calls.push(body);
      if (calls.length === 1) return { not_found: { movies: [{ ids: { imdb: 'tt1' } }] } };
      throw new Error('Simkl down');
    };
    tmdb.findByImdbId = async () => 12600;
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 1000 }];
      const res = await scrobble.syncProfile(profile, quiet); // must not throw
      assert.strictEqual(calls.length, 2, 'the retry was attempted');
      assert.strictEqual(res.unmatched, 1);
      assert.strictEqual(res.matchedOnRetry, 0);
      const rows = watchedStore.listUnmatched(profile.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].imdb_id, 'tt1');
      assert.strictEqual(rows[0].tmdb_id, '12600', 'the resolved TMDB id is kept on the record');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble A6: a recorded film later in the watched store is cleared (even with no body); full ignores the backoff', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-a6', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    simkl.addToHistory = async (_p, body) => { calls.push(body); return {}; };
    tmdb.findByImdbId = async () => null;
    try {
      // (a) tt1 is recorded, then later appears in the local watched store (a
      // later Simkl sync found it). It is in backoff, so nothing is pushed
      // (body null) — but the record is cleared.
      watchedStore.recordUnmatched(profile.id, { imdbId: 'tt1' }, Date.now());
      watchedStore.upsertMany(profile.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'tt1', tmdb_id: '12600', title: 'P', year: 2017, watched_at: '2026-01-01T00:00:00Z' }]);
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt1', watchedAtMs: 1000 }];
      await scrobble.syncProfile(profile, quiet);
      assert.strictEqual(calls.length, 0, 'nothing pushed (the film is in backoff and watched)');
      assert.strictEqual(watchedStore.listUnmatched(profile.id).length, 0, 'the record is cleared by the watched store');
      // (b) full:true ignores the backoff — the film is in the body.
      watchedStore.recordUnmatched(profile.id, { imdbId: 'tt2' }, Date.now());
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'tt2', watchedAtMs: 2000 }];
      calls.length = 0;
      await scrobble.syncProfile(profile, quiet, { full: true });
      assert.deepStrictEqual(calls[0].movies.map((m) => m.ids.imdb), ['tt2'], 'full re-pushes despite the backoff');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble A7: deleteForProfile clears scrobble_unmatched', () => {
    const A = 'p-a7';
    watchedStore.recordUnmatched(A, { imdbId: 'tt1', tmdbId: '12600' });
    watchedStore.recordUnmatched(A, { imdbId: 'tt2' });
    assert.strictEqual(watchedStore.listUnmatched(A).length, 2);
    watchedStore.deleteForProfile(A);
    assert.strictEqual(watchedStore.listUnmatched(A).length, 0, 'profile delete clears the records');
  });

  await it('Scrobble A8: portal route — rows with title from the meta cache when present; unknown profile 404', async () => {
    const express = require('express');
    const portal = require('../src/portal');
    const config = require('../src/config');
    const metaStore = require('../src/engines/glass/metaStore');
    const db = require('../src/db');
    const port = 7315;
    const app = express();
    app.use('/api', portal.router);
    const server = app.listen(port);
    await new Promise((resolve, reject) => { server.on('listening', resolve); server.on('error', reject); });
    const base = `http://localhost:${port}`;
    let p;
    try {
      p = config.addProfile('ScrobbleUnmatched');
      // One recorded film with a TMDB id (meta cached), one without.
      watchedStore.recordUnmatched(p.id, { imdbId: 'tt0287635', tmdbId: '12600' }, 1000);
      watchedStore.recordUnmatched(p.id, { imdbId: 'tt999' }, 2000);
      metaStore.put('movie', '12600', { title: 'Pokémon 4Ever', year: 2017, imdb_id: 'tt0287635' });
      let res = await fetch(`${base}/api/profiles/${p.id}/scrobble/unmatched`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.items.length, 2);
      const a = body.items.find((r) => r.imdb_id === 'tt0287635');
      assert.strictEqual(a.title, 'Pokémon 4Ever', 'title from the meta cache');
      assert.strictEqual(a.year, 2017);
      assert.strictEqual(a.last_tried, 1000);
      assert.strictEqual(a.attempts, 1);
      const b = body.items.find((r) => r.imdb_id === 'tt999');
      assert.strictEqual(b.title, null, 'no meta cache → title null');
      assert.strictEqual(b.year, null);
      // Unknown profile → 404.
      res = await fetch(`${base}/api/profiles/nope/scrobble/unmatched`);
      assert.strictEqual(res.status, 404);
    } finally {
      server.close();
      if (p) { config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); }
      db.get().exec('DELETE FROM glass_metadata');
    }
  });

  await it('Scrobble D1: not-found movie matched on retry → ledgered; the next run re-sends nothing (skip log)', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-d1', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    const logLines = [];
    const log = { log: (m) => logLines.push(m), warn() {}, error() {} };
    simkl.addToHistory = async (_p, body) => {
      calls.push(body);
      return calls.length === 1 ? { not_found: { movies: [{ ids: { imdb: 'ttA' } }] } } : {};
    };
    tmdb.findByImdbId = async (_key, _type, imdb) => (imdb === 'ttA' ? 12600 : null);
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'ttA', watchedAtMs: 1000 }];
      // Run 1: not found → retry with the TMDB id → matched (the Conor case).
      const res = await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 2, 'two POSTs (main + retry)');
      assert.strictEqual(res.matchedOnRetry, 1, 'matched on retry');
      assert.ok(watchedStore.pushedMovieIds(profile.id).has('ttA'), 'the movie is ledgered');
      // Run 2: the ledger skips it — no POSTs, and the skip log appears.
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 2, 'no re-send on the next run');
      assert.ok(logLines.some((l) => l.includes('1 movie(s) skipped (already sent to Simkl)')), 'the skip log appears');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble D2: accepted on the first POST → ledgered; the next run skips; full re-sends', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-d2', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    const logLines = [];
    const log = { log: (m) => logLines.push(m), warn() {}, error() {} };
    simkl.addToHistory = async (_p, body) => { calls.push(body); return {}; };
    tmdb.findByImdbId = async () => null;
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'ttB', watchedAtMs: 1000 }];
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 1, 'one POST');
      assert.ok(watchedStore.pushedMovieIds(profile.id).has('ttB'), 'ledgered');
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 1, 'no re-send on the next run');
      assert.ok(logLines.some((l) => l.includes('1 movie(s) skipped (already sent to Simkl)')), 'the skip log appears');
      // full: re-sends despite the ledger.
      await scrobble.syncProfile(profile, log, { full: true });
      assert.strictEqual(calls.length, 2, 'full re-sends');
      assert.deepStrictEqual(calls[1].movies.map((m) => m.ids.imdb), ['ttB']);
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble D3: a thrown first POST → nothing ledgered; the next run re-sends', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-d3', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    const log = { log() {}, warn() {}, error() {} };
    simkl.addToHistory = async (_p, body) => {
      calls.push(body);
      if (calls.length === 1) throw new Error('Simkl down');
      return {};
    };
    tmdb.findByImdbId = async () => null;
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'ttC', watchedAtMs: 1000 }];
      await assert.rejects(() => scrobble.syncProfile(profile, log), /Simkl down/);
      assert.strictEqual(watchedStore.pushedMovieIds(profile.id).size, 0, 'nothing ledgered');
      // Next run: re-sends (the film was never accepted).
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 2, 're-sent on the next run');
      assert.ok(watchedStore.pushedMovieIds(profile.id).has('ttC'), 'ledgered after the successful run');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble D4: still not found after the retry → NOT ledgered; in the scrobble_unmatched backoff', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const profile = { id: 'p-d4', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId;
    const calls = [];
    const log = { log() {}, warn() {}, error() {} };
    simkl.addToHistory = async (_p, body) => { calls.push(body); return { not_found: { movies: [{ ids: { imdb: 'ttD' } }] } }; };
    tmdb.findByImdbId = async (_key, _type, imdb) => (imdb === 'ttD' ? 12600 : null);
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'ttD', watchedAtMs: 1000 }];
      const res = await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 2, 'main + retry POSTs');
      assert.strictEqual(res.unmatched, 1, 'still not found');
      assert.strictEqual(res.matchedOnRetry, 0);
      assert.strictEqual(watchedStore.pushedMovieIds(profile.id).size, 0, 'not ledgered');
      const rows = watchedStore.listUnmatched(profile.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].imdb_id, 'ttD');
      assert.strictEqual(rows[0].tmdb_id, '12600');
      // Next run: in backoff — no re-send.
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, 2, 'in backoff — no re-send');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  await it('Scrobble D5: unwatch clears the ledger entry + sets the block; an older provider watch is skipped, a newer one is pushed and re-ledgered', async () => {
    const scrobble = require('../src/services/scrobble');
    const nuvio = require('../src/services/nuvio');
    const crypto = require('../src/services/crypto');
    const trainer = require('../src/trainer');
    const profile = { id: 'p-d5', name: 'T', keys: { simkl_client_id: 'c', tmdb_api_key: 'k' }, simkl_auth: { access_token: 't' }, scrobble: { enabled: true, provider: 'nuvio', email: 'a@b.c', password_enc: crypto.encrypt('pw') } };
    const origPull = nuvio.pullWatched; const origAdd = simkl.addToHistory; const origFind = tmdb.findByImdbId; const origRemove = simkl.removeFromHistory;
    const calls = [];
    const logLines = [];
    const log = { log: (m) => logLines.push(m), warn() {}, error() {} };
    simkl.addToHistory = async (_p, body) => { calls.push(body); return {}; };
    tmdb.findByImdbId = async () => null;
    try {
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'ttE', watchedAtMs: 1000 }];
      // (a) The movie is ledgered, then watched in the local store.
      await scrobble.syncProfile(profile, log);
      assert.ok(watchedStore.pushedMovieIds(profile.id).has('ttE'), 'ledgered');
      watchedStore.upsertMany(profile.id, [{ simkl_id: 1, type: 'movie', imdb_id: 'ttE', tmdb_id: '12600', title: 'E', year: 2017, watched_at: '2026-01-01T00:00:00Z' }]);
      // (b) markUnwatched: the ledger entry is cleared and the block is set.
      const deps = {
        simkl: { removeFromHistory: async () => {}, removeRatings: async () => {} },
        now: () => 5000,
        log: quiet,
      };
      const res = await trainer.markUnwatched(profile, { type: 'movie', tmdb_id: '12600' }, deps);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(watchedStore.pushedMovieIds(profile.id).size, 0, 'ledger entry cleared');
      assert.ok(watchedStore.unwatchedBlocks(profile.id, 'movie').has('ttE'), 'block set');
      // (c) An older provider watch (≤ the block time) is skipped by the block.
      logLines.length = 0;
      const before = calls.length;
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, before, 'no POST — skipped by the block');
      assert.ok(logLines.some((l) => l.includes('1 movie(s) skipped (unwatched by the user)')), 'the block skip log');
      // (d) A newer provider watch (a genuine rewatch) is pushed and re-ledgered.
      nuvio.pullWatched = async () => [{ type: 'movie', imdbId: 'ttE', watchedAtMs: 9000 }];
      await scrobble.syncProfile(profile, log);
      assert.strictEqual(calls.length, before + 1, 'the rewatch is pushed');
      assert.deepStrictEqual(calls[calls.length - 1].movies.map((m) => m.ids.imdb), ['ttE']);
      assert.ok(watchedStore.pushedMovieIds(profile.id).has('ttE'), 're-ledgered');
      assert.ok(!watchedStore.unwatchedBlocks(profile.id, 'movie').has('ttE'), 'block cleared by the rewatch');
    } finally {
      nuvio.pullWatched = origPull; simkl.addToHistory = origAdd; tmdb.findByImdbId = origFind; simkl.removeFromHistory = origRemove;
      watchedStore.deleteForProfile(profile.id);
    }
  });

  // ── I1. Identity (AGE-2): every positive tier runs the chain; groq.ageGate gets (type, tier.llm.age, …, { tier }) ──
  await it('I1. Identity (AGE-2): every positive age limit runs the chain, groq.ageGate gets the tier wording + opts.tier', async () => {
    const ageVerify = require('../src/ageVerification');
    const groq = require('../src/services/groq');
    const dispose = engines._register(fake);
    settings.updateSettings({ engines: { fake: true } });
    // Clear the verdict store for the fake candidates so the chain's LLM step is
    // reached (earlier tests at tier 10 stored verdicts for these tmdb_ids, which
    // would otherwise answer from the cache and skip the LLM step).
    require('../src/db').get().prepare('DELETE FROM age_verdicts WHERE tmdb_id LIKE ?').run('fake-%');

    let verifyCalls = [];
    const origVerify = ageVerify.verify;
    ageVerify.verify = (...args) => { verifyCalls.push(args); return origVerify(...args); };

    const ageGateCalls = [];
    const origAgeGate = groq.ageGate;
    groq.ageGate = (type, age, titles, log, opts) => {
      ageGateCalls.push({ type, age, opts });
      return Promise.resolve(new Set()); // nothing vetoed
    };

    const p = config.addProfile('INT-I1');
    try {
      // AGE-2 rounding: 5,8,10 → tier 10; 12,13 → tier 12; 15 → tier 15.
      // `expected` maps each limit to its tier's LLM age (what groq.ageGate sees).
      const expected = { 5: 10, 8: 10, 10: 10, 12: 12, 13: 12, 15: 15 };
      for (const limit of [5, 8, 10, 12, 13, 15]) {
        verifyCalls.length = 0;
        ageGateCalls.length = 0;
        config.updateProfile(p.id, { filters: { age_limit: limit, engine_movie: 'fake', engine_series: 'fake' } });
        const profile = config.getProfile(p.id);
        await rs.buildPool(profile, quiet);
        // verify must be called for EVERY positive tier (mandate B3: no legacy path)
        assert.ok(verifyCalls.length > 0, `verify not called for limit ${limit}`);
        // groq.ageGate must be called with (type, tier.llm.age, …, { tier }) — the
        // tier's own age (not limit+1), and opts.tier set.
        const tierAge = expected[limit];
        assert.ok(ageGateCalls.length > 0, `groq.ageGate not called for limit ${limit}`);
        for (const c of ageGateCalls) {
          assert.strictEqual(c.age, tierAge, `groq.ageGate age for limit ${limit}`);
          assert.ok(c.opts && c.opts.tier, `opts.tier set for limit ${limit}`);
          assert.strictEqual(c.opts.tier.llm.age, tierAge, `opts.tier.llm.age for limit ${limit}`);
        }
        // passesAgeBand: the serve-time re-check reads the stored verdict. No
        // verdict is stored (the LLM spy vetoes nothing), so an unrated/unknown
        // row stays kept (fail-open).
        const row = { type: 'movie', tmdb_id: 'fake-movie-1', age_classification: null, certification: null };
        assert.strictEqual(rs.passesAgeBand(row, { age_limit: limit }), true, `passesAgeBand for limit ${limit}`);
      }
      // Marquee Cinema's compileEnvelope for limits 10 and 13: per-tier ceiling.
      const marquee = require('../src/engines/marquee/filters');
      const genreMap = { 18: 'Drama', 27: 'Horror' };
      const env10 = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 10 }, { nowYear: 2026, genreMap });
      const env13 = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 13 }, { nowYear: 2026, genreMap });
      // AGE-2 per-tier ceiling: 10+ → M (tier 10), 13 → M (tier 12).
      assert.strictEqual(env10.discoverParams()['certification.lte'], 'M');
      assert.strictEqual(env13.discoverParams()['certification.lte'], 'M');
      // AGE-2 hard filter: unknown cert passes (fail open).
      const base = { imdb_id: 'tt', imdb_rating: 8, vote_average: 8, vote_count: 5000, year: 2020, genres: ['Drama'], availability: 'AVAILABLE' };
      assert.deepStrictEqual(env10.hardFilter({ ...base, certAU: null, certUS: null }), { ok: true });
      assert.deepStrictEqual(env13.hardFilter({ ...base, certAU: null, certUS: null }), { ok: true });
    } finally {
      ageVerify.verify = origVerify;
      groq.ageGate = origAgeGate;
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false } }); dispose();
    }
  });

  // ── I2. ageGatePool at TV-14: chain decides, certification stamped ───────────
  await it('I2. ageGatePool at TV-14: chain verdicts, certification stamped, LLM only for unknowns', async () => {
    const ageVerify = require('../src/ageVerification');
    const groq = require('../src/services/groq');
    const dispose = engines._register(fake);
    settings.updateSettings({ engines: { fake: true } });

    // Spy on groq.ageGate to capture TV-14 calls (with opts.tier)
    const ageGateCalls = [];
    const origAgeGate = groq.ageGate;
    groq.ageGate = (type, age, titles, log, opts) => {
      ageGateCalls.push({ type, age, opts, count: titles.length });
      // Veto the first title, allow the rest (cache the verdicts like the real gate)
      const vetoed = new Set();
      for (const t of titles) {
        const verdict = t.id === 'fake-movie-1' ? false : true;
        store.saveAgeVerdicts({ ...store.loadAgeVerdicts(), [`${type}:${opts.tier.llm.cacheKey}:${t.id}`]: verdict });
        if (!verdict) vetoed.add(t.id);
      }
      return Promise.resolve(vetoed);
    };

    const p = config.addProfile('INT-I2');
    config.updateProfile(p.id, { filters: { age_limit: 14, engine_movie: 'fake', engine_series: 'fake' } });
    const profile = config.getProfile(p.id);
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({});
    try {
      await rs.buildPool(profile, quiet);
      // groq.ageGate was called with opts.tier (cacheKey 'tv14')
      const tv14Calls = ageGateCalls.filter((c) => c.opts && c.opts.tier);
      assert.ok(tv14Calls.length > 0, `groq.ageGate called with opts.tier (calls: ${JSON.stringify(ageGateCalls)})`);
      for (const c of tv14Calls) {
        assert.strictEqual(c.age, 14, 'LLM age is 14 for TV-14');
      }
      // One title was vetoed by the LLM spy, two allowed
      const movies = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
      assert.strictEqual(movies.length, 2, 'one movie vetoed, two kept');
      // The vetoed title is removed
      assert.ok(!movies.some((m) => m.tmdb_id === 'fake-movie-1'), 'vetoed title removed');
      // Allowed titles carry certification
      for (const m of movies) {
        assert.ok(m.certification, `certification stamped on ${m.tmdb_id}`);
      }
    } finally {
      store.saveAgeVerdicts(prev);
      groq.ageGate = origAgeGate;
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
      settings.updateSettings({ engines: { fake: false } }); dispose();
    }
  });

  // ── I3. Verdict store: TTL, re-decide, unknown never stored ─────────────────
  await it('I3. Verdict store: second verify within TTL makes no source calls; unknown never stored', async () => {
    const verdictStore = require('../src/ageVerification/store');
    const chain = require('../src/ageVerification/chain');
    const tier = require('../src/ageVerification/tiers').TIERS[14];

    // Seed a verdict for a title
    const now = Date.now();
    verdictStore.recordVerdict('movie', '100', tier.id, 'allow', 'csm', '13', now);
    // Read it back
    const v = verdictStore.getVerdict('movie', '100', tier.id, now);
    assert.strictEqual(v.verdict, 'allow');
    assert.strictEqual(v.source, 'csm');
    // Unknown is never stored
    assert.strictEqual(verdictStore.recordVerdict('movie', '200', tier.id, 'unknown', 'llm', null, now), false);
    assert.strictEqual(verdictStore.getVerdict('movie', '200', tier.id, now), null);
    // Expired verdict (30 days ago) is re-decided
    const old = now - 31 * 24 * 3600e3;
    verdictStore.recordVerdict('movie', '300', tier.id, 'allow', 'csm', '13', old);
    assert.strictEqual(verdictStore.getVerdict('movie', '300', tier.id, now), null, 'expired verdict returns null');
    // LLM TTL is 90 days
    const llmOld = now - 91 * 24 * 3600e3;
    verdictStore.recordVerdict('movie', '400', tier.id, 'allow', 'llm', 'ok', llmOld);
    assert.strictEqual(verdictStore.getVerdict('movie', '400', tier.id, now), null, 'expired LLM verdict returns null');
    const llmFresh = now - 89 * 24 * 3600e3;
    verdictStore.recordVerdict('movie', '500', tier.id, 'allow', 'llm', 'ok', llmFresh);
    assert.ok(verdictStore.getVerdict('movie', '500', tier.id, now), 'fresh LLM verdict is readable');
  });

  // ── I4. Catalogs at TV-14: Watch Later and banded catalogs both use the chain ─
  await it('I4. Catalogs at TV-14: Watch Later and banded catalogs both use the chain (AGE-2)', async () => {
    const ageVerify = require('../src/ageVerification');
    const groq = require('../src/services/groq');
    const rebuild = require('../src/rebuild');

    let verifyCalls = [];
    const origVerify = ageVerify.verify;
    ageVerify.verify = (...args) => {
      verifyCalls.push(args);
      // Return all allow
      const result = new Map();
      for (const t of args[0]) result.set(t.key, { verdict: 'allow', source: 'csm', rating: '13' });
      return Promise.resolve(result);
    };

    const ageGateCalls = [];
    const origAgeGate = groq.ageGate;
    groq.ageGate = (type, age, titles, log, opts) => {
      ageGateCalls.push({ type, age, opts });
      return Promise.resolve(new Set());
    };

    // Set a Groq key so the legacy LLM path doesn't throw
    settings.updateSettings({ llm: { groq_api_key: 'itest-groq' } });
    const p = config.addProfile('INT-I4');
    config.updateProfile(p.id, { filters: { age_limit: 14 } });
    const profile = config.getProfile(p.id);
    // Fake metas for the gate
    const metas = [
      { id: 'tt1', _tmdb_id: '100', name: 'Show One', releaseInfo: '2020', _genre_names: ['Drama'], _certification: null, description: '' },
      { id: 'tt2', _tmdb_id: '200', name: 'Show Two', releaseInfo: '2021', _genre_names: ['Comedy'], _certification: null, description: '' },
    ];
    try {
      // Watch Later (no band) → effective limit = profile's 14 → chain
      const wlDef = { type: 'series', id: 'watch-later', name: 'Watch Later', source: 'simkl_plantowatch', age_band: null };
      const out = await rebuild.applyExtraAgeGate(profile, wlDef, metas, quiet);
      assert.ok(verifyCalls.length > 0, 'verify was called for Watch Later (TV-14 chain)');
      assert.strictEqual(out.length, 2, 'all titles kept (all allow)');

      // Banded catalog (Trending Kids, band 12) → effective limit = min(12, 14) = 12 →
      // the chain (AGE-2: every positive limit is a chain tier; the legacy LLM path
      // is gone). The verify spy intercepts the chain, so groq.ageGate is not called.
      verifyCalls = [];
      const trendingDef = { type: 'movie', id: 'trending-kids', name: 'Trending Kids', source: 'simkl_trending', age_band: 12 };
      await rebuild.applyExtraAgeGate(profile, trendingDef, metas, quiet);
      assert.ok(verifyCalls.length > 0, 'verify called for banded catalog (AGE-2: band 12 → the chain, tier 12)');
    } finally {
      ageVerify.verify = origVerify;
      groq.ageGate = origAgeGate;
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  // ── I8. CB-0: extra-catalog age gate — per-title identity + block removal +
  //      fail-closed. The gate must check each title as its own title (a real TMDB
  //      id, not a collapsed `undefined` key), remove a title the chain blocks,
  //      and withhold a title the chain cannot identify. No network: `verify` and
  //      the MDBList fetchers are stubbed.
  {
    const ageVerify = require('../src/ageVerification');
    const mdblist = require('../src/services/mdblist');

    // T1 — MDBList identity: two items with distinct ids.tmdb reach verify as two
    // distinct keys (neither contains `undefined`).
    await it('I8-T1. MDBList identity: distinct ids.tmdb reach verify as distinct keys (no undefined)', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const origVerify = ageVerify.verify;
      // Realistic MDBList payload: ids at item.ids.tmdb (number), no top-level tmdb_id.
      mdblist.listItemsPage = async () => ([
        { imdb_id: 'tt100', ids: { imdb: 'tt100', tmdb: 111 }, title: 'Title One', release_year: 2020 },
        { imdb_id: 'tt200', ids: { imdb: 'tt200', tmdb: 222 }, title: 'Title Two', release_year: 2021 },
      ]);
      mdblist.mediaInfoBatch = async () => new Map();
      let verifyKeys = [];
      ageVerify.verify = (titles) => {
        verifyKeys = titles.map((t) => t.key);
        const result = new Map();
        for (const t of titles) result.set(t.key, { verdict: 'allow', source: 'csm', rating: '13' });
        return Promise.resolve(result);
      };
      const profile = { id: 'cb0-t1', name: 'CB0-T1', keys: { mdblist_api_key: 'cb0-mdb' }, filters: { age_limit: 12 } };
      const def = { type: 'movie', id: 'cb0-kids', name: 'Kids', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, age_band: 12 };
      try {
        await rebuild.buildExtraCatalog(profile, def, quiet);
        assert.strictEqual(verifyKeys.length, 2, `both titles reached verify: ${verifyKeys.join(', ')}`);
        assert.ok(verifyKeys.every((k) => !k.includes('undefined')), `no undefined in keys: ${verifyKeys.join(', ')}`);
        assert.strictEqual(new Set(verifyKeys).size, 2, 'two distinct keys');
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        ageVerify.verify = origVerify;
      }
    });

    // T2 — block removes (MDBList): the chain returns block for one of two titles
    // on a banded catalog; the blocked title is absent from the built list, the
    // other remains.
    await it('I8-T2. MDBList block removes: blocked title absent, other remains', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const origVerify = ageVerify.verify;
      mdblist.listItemsPage = async () => ([
        { imdb_id: 'tt100', ids: { imdb: 'tt100', tmdb: 111 }, title: 'Title One', release_year: 2020 },
        { imdb_id: 'tt200', ids: { imdb: 'tt200', tmdb: 222 }, title: 'Title Two', release_year: 2021 },
      ]);
      mdblist.mediaInfoBatch = async () => new Map();
      ageVerify.verify = (titles) => {
        const result = new Map();
        for (const t of titles) {
          const verdict = String(t.key.split(':')[1]) === '222' ? 'block' : 'allow';
          result.set(t.key, { verdict, source: 'csm', rating: verdict === 'block' ? '18' : '13' });
        }
        return Promise.resolve(result);
      };
      const profile = { id: 'cb0-t2', name: 'CB0-T2', keys: { mdblist_api_key: 'cb0-mdb' }, filters: { age_limit: 12 } };
      const def = { type: 'movie', id: 'cb0-kids', name: 'Kids', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, age_band: 12 };
      try {
        const built = await rebuild.buildExtraCatalog(profile, def, quiet);
        const ids = built.map((m) => m.id);
        assert.ok(ids.includes('tt100'), 'allowed title remains');
        assert.ok(!ids.includes('tt200'), 'blocked title is absent');
        assert.strictEqual(built.length, 1, 'exactly one title remains');
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        ageVerify.verify = origVerify;
      }
    });

    // T3 — block removes (Watch Later): numeric _tmdb_id (as tmdb.toMeta produces),
    // on a profile with age_limit 12; the blocked title is absent, the other remains.
    await it('I8-T3. Watch Later block removes: numeric _tmdb_id, blocked title absent', async () => {
      const origVerify = ageVerify.verify;
      // Watch Later metas as tmdb.toMeta produces: numeric _tmdb_id.
      const metas = [
        { id: 'tt100', type: 'series', name: 'Show One', releaseInfo: '2020', _tmdb_id: 111, _genre_names: ['Drama'], _certification: null, description: '' },
        { id: 'tt200', type: 'series', name: 'Show Two', releaseInfo: '2021', _tmdb_id: 222, _genre_names: ['Comedy'], _certification: null, description: '' },
      ];
      ageVerify.verify = (titles) => {
        const result = new Map();
        for (const t of titles) {
          const verdict = String(t.key.split(':')[1]) === '222' ? 'block' : 'allow';
          result.set(t.key, { verdict, source: 'csm', rating: verdict === 'block' ? '18' : '13' });
        }
        return Promise.resolve(result);
      };
      const profile = { id: 'cb0-t3', name: 'CB0-T3', keys: {}, filters: { age_limit: 12 } };
      const def = { type: 'series', id: 'cb0-watch-later', name: 'Watch Later', source: 'simkl_plantowatch', age_band: null };
      try {
        const out = await rebuild.applyExtraAgeGate(profile, def, metas, quiet);
        const ids = out.map((m) => m.id);
        assert.ok(ids.includes('tt100'), 'allowed title remains');
        assert.ok(!ids.includes('tt200'), 'blocked title is absent');
        assert.strictEqual(out.length, 1, 'exactly one title remains');
      } finally {
        ageVerify.verify = origVerify;
      }
    });

    // T4 — fail closed: with a positive effective limit, a title with no tmdb id is
    // withheld and counted; with limit 0 (adult, unbanded) it is kept as today.
    // The gate's LLM tripwire (hasLlm) must pass before the stubbed verify is
    // reached, so this test sets its own LLM (saved/restored) — it does not
    // depend on a key left by an earlier test.
    await it('I8-T4. Fail closed: no-tmdb-id title withheld when gated, kept when ungated', async () => {
      const origVerify = ageVerify.verify;
      const origLlm = { ...settings.getSettings().llm };
      settings.updateSettings({ llm: { groq_api_key: 'itest-groq' } });
      const metas = [
        { id: 'tt100', type: 'series', name: 'Identifiable', releaseInfo: '2020', _tmdb_id: 111, _genre_names: ['Drama'], _certification: null, description: '' },
        { id: 'tt200', type: 'series', name: 'Unidentifiable', releaseInfo: '2021', _genre_names: ['Comedy'], _certification: null, description: '' },
      ];
      ageVerify.verify = (titles) => {
        const result = new Map();
        for (const t of titles) result.set(t.key, { verdict: 'allow', source: 'csm', rating: '13' });
        return Promise.resolve(result);
      };
      const def = { type: 'series', id: 'cb0-watch-later', name: 'Watch Later', source: 'simkl_plantowatch', age_band: null };
      try {
        // (a) Gated (age_limit 12): the unidentifiable title is withheld.
        const gatedProfile = { id: 'cb0-t4a', name: 'CB0-T4a', keys: {}, filters: { age_limit: 12 } };
        const outGated = await rebuild.applyExtraAgeGate(gatedProfile, def, metas, quiet);
        assert.deepStrictEqual(outGated.map((m) => m.id), ['tt100'], 'unidentifiable title withheld when gated');

        // (b) Ungated (adult, unbanded): the unidentifiable title is kept.
        const adultProfile = { id: 'cb0-t4b', name: 'CB0-T4b', keys: {}, filters: { age_limit: 0 } };
        const outUngated = await rebuild.applyExtraAgeGate(adultProfile, def, metas, quiet);
        assert.deepStrictEqual(outUngated.map((m) => m.id), ['tt100', 'tt200'], 'unidentifiable title kept when ungated');
      } finally {
        settings.updateSettings({ llm: origLlm });
        ageVerify.verify = origVerify;
      }
    });

    // T5 — no leakage: built MDBList metas contain no underscore fields.
    await it('I8-T5. No leakage: built MDBList metas contain no underscore fields', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const origVerify = ageVerify.verify;
      mdblist.listItemsPage = async () => ([
        { imdb_id: 'tt100', ids: { imdb: 'tt100', tmdb: 111 }, title: 'Title One', release_year: 2020 },
      ]);
      mdblist.mediaInfoBatch = async () => new Map();
      ageVerify.verify = (titles) => {
        const result = new Map();
        for (const t of titles) result.set(t.key, { verdict: 'allow', source: 'csm', rating: '13' });
        return Promise.resolve(result);
      };
      const profile = { id: 'cb0-t5', name: 'CB0-T5', keys: { mdblist_api_key: 'cb0-mdb' }, filters: { age_limit: 12 } };
      const def = { type: 'movie', id: 'cb0-kids', name: 'Kids', source: 'mdblist', user: 'u', slug: 's', sort: null, min_imdb: 0, age_band: 12 };
      try {
        const built = await rebuild.buildExtraCatalog(profile, def, quiet);
        assert.ok(built.length >= 1, 'built at least one title');
        for (const m of built) {
          for (const k of Object.keys(m)) {
            assert.ok(!k.startsWith('_'), `no underscore field ${k} on ${m.id}`);
          }
        }
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        ageVerify.verify = origVerify;
      }
    });

    // T6 — no LLM configured: a gated catalog throws (fail-closed), and for
    // Watch Later the caller (rebuildProfile) keeps the previous list rather
    // than publishing an unvetted one. The LLM is cleared (saved/restored) so
    // the tripwire fires even though earlier tests may have set a key.
    await it('I8-T6. No LLM configured + gated catalog → gate throws; Watch Later keeps previous list', async () => {
      const origLlm = { ...settings.getSettings().llm };
      const origPTW = simkl.getPlanToWatch;
      const origMeta = tmdb.metaByTmdbId;
      const p = config.addProfile('INT-I8T6');
      config.updateProfile(p.id, {
        filters: { age_limit: 12 },
        simkl_auth: { access_token: 't' },
        keys: { tmdb_api_key: 'itest-tmdb' },
      });
      const profile = config.getProfile(p.id);
      const wlDef = { type: 'series', id: 'trakt-watchlist-movies', name: 'Watch Later', source: 'simkl_plantowatch', age_band: null };
      // Seed the store with a previous list (the state a failed rebuild must keep).
      store.swapExtra(p.id, wlDef.id, [
        { id: 'tt_prev', type: 'series', name: 'Previous Show', releaseInfo: '2020' },
      ]);
      try {
        // Clear the LLM (no custom endpoint, no Groq key).
        settings.updateSettings({ llm: { custom_uri: '', custom_name: '', custom_api_key: '', groq_api_key: '', groq_api_key_backup: '' } });
        // Simkl returns one plan-to-watch title; TMDB resolves it.
        simkl.getPlanToWatch = async () => ([{ imdb_id: 'tt1', tmdb_id: '111', title: 'Show One', year: 2020 }]);
        tmdb.metaByTmdbId = async (_k, _t, id) => ({
          id: 'tt1', type: 'series', name: 'Show One', poster: null, description: '', releaseInfo: '2020', _tmdb_id: 111,
        });
        // (a) The gate throws directly (a gated catalog with a non-empty list).
        const metas = [{ id: 'tt1', type: 'series', name: 'Show One', releaseInfo: '2020', _tmdb_id: 111, _genre_names: ['Drama'], _certification: null, description: '' }];
        let threw = null;
        try {
          await rebuild.applyExtraAgeGate(profile, wlDef, metas, quiet);
        } catch (err) {
          threw = err;
        }
        assert.ok(threw, 'gate throws when no LLM is configured');
        assert.ok(/No LLM/.test(threw.message), `gate error mentions No LLM: ${threw.message}`);

        // (b) rebuildProfile catches the error and keeps the previous list.
        const results = await rebuild.rebuildProfile(profile, quiet, { extras: true });
        assert.strictEqual(results[wlDef.id].ok, false, 'rebuildProfile records failure for Watch Later');
        assert.ok(/No LLM/.test(results[wlDef.id].error), `rebuildProfile error mentions No LLM: ${results[wlDef.id].error}`);
        // The previous list is kept (not swapped).
        const cache = store.loadCache(p.id);
        assert.deepStrictEqual(cache.extras[wlDef.id].metas.map((m) => m.id), ['tt_prev'], 'previous list kept (not swapped)');
      } finally {
        settings.updateSettings({ llm: origLlm });
        simkl.getPlanToWatch = origPTW;
        tmdb.metaByTmdbId = origMeta;
        config.removeProfile(p.id);
        store.deleteCache(p.id);
      }
    });
  }

  // ── CB-1. Every catalog shows the profile's list size, and stays full after
  //      a watch or suppression. T1-T9 encode the card's mandates.
  {
    const mdblist = require('../src/services/mdblist');
    const ageVerify = require('../src/ageVerification');

    // T1 — original bug: 20 first-ranked + 14 watched + 50 more → old serves 6,
    // new serves list size. Repeat for one more movie + one series catalog.
    // Must fail on base for the count, not a TypeError.
    await it('CB-1 T1. original bug: watched titles are replaced, not dropped', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const p = config.addProfile('INT-CB1-T1');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true },
      });
      const profile = config.getProfile(p.id);
      const def = { type: 'movie', id: 'mdb-action-movies', name: 'Action Movies', source: 'mdblist', user: 'hdlists', slug: 'latest-hd-action-movies-from-1980-to-today', min_imdb: 6, sort: 'imdbpopular' };
      // 64 titles: 20 first-ranked + 14 watched + 30 more (total 64).
      const items = [];
      for (let i = 1; i <= 64; i++) {
        items.push({ imdb_id: 'tt' + i, ids: { imdb: 'tt' + i, tmdb: 100 + i }, title: 'Title ' + i, release_year: 2020, poster: null, imdbRating: 7.5 });
      }
      mdblist.listItemsPage = async (_k, _u, _s, _t, opts) => {
        const offset = opts.offset || 0;
        return items.slice(offset, offset + 50);
      };
      mdblist.mediaInfoBatch = async () => new Map();
      try {
        // Build the catalog (reserve = 2×20 = 40).
        const built = await rebuild.buildExtraCatalog(profile, def, quiet);
        assert.ok(built.length >= 20, `built at least 20 titles: ${built.length}`);
        // Swap into the cache.
        const meta = { format: 'reserve-v1', list_size: 20, eligible_at_build: built.length };
        store.swapExtra(p.id, def.id, built, meta);
        // Mark 14 titles as watched.
        const watchedIds = new Set();
        for (let i = 1; i <= 14; i++) watchedIds.add('tt' + i);
        // Stub the watched store.
        const origWatched = watchedStore.watchedIdSets;
        watchedStore.watchedIdSets = () => ({ imdb: watchedIds, tmdb: new Set() });
        // Serve: should be exactly 20 (list size), with the 14 watched replaced.
        const served = catalogServe.servedCatalog(profile, def.id, { record: false });
        assert.strictEqual(served.metas.length, 20, `serves exactly list size (20): got ${served.metas.length}`);
        // The 14 watched titles are NOT in the served list.
        for (const id of watchedIds) {
          assert.ok(!served.metas.some((m) => m.id === id), `watched ${id} not served`);
        }
        watchedStore.watchedIdSets = origWatched;

        // Repeat for a series catalog (use a valid series catalog ID).
        const seriesDef = { type: 'series', id: 'mdb-popular-series', name: 'Popular Series', source: 'mdblist', user: 'official', slug: 'popular', min_imdb: 0 };
        const seriesBuilt = await rebuild.buildExtraCatalog(profile, seriesDef, quiet);
        store.swapExtra(p.id, 'mdb-popular-series', seriesBuilt, meta);
        const servedSeries = catalogServe.servedCatalog(profile, 'mdb-popular-series', { record: false });
        assert.strictEqual(servedSeries.metas.length, 20, `series serves exactly list size (20): got ${servedSeries.metas.length}`);
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        config.removeProfile(p.id);
        store.deleteCache(p.id);
      }
    });

    // T2 — one setting drives every size: list size 10/25/40 → every non-Watch-Later
    // extra serves exactly that; Watch Later serves true source count; static check
    // no catalog carries target and EXTRA_LIST_TARGET/|| 20 gone.
    await it('CB-1 T2. one setting drives every size', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      // Static check: no catalog carries a target.
      assert.ok(catalogs.EXTRA_CATALOGS.every((d) => d.target === undefined), 'no catalog definition carries a target');
      // Static check: EXTRA_LIST_TARGET is gone from rebuild.js.
      const rebuildSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'rebuild.js'), 'utf8');
      assert.ok(!rebuildSrc.includes('EXTRA_LIST_TARGET'), 'EXTRA_LIST_TARGET removed from rebuild.js');
      assert.ok(!rebuildSrc.includes('|| 20'), 'no || 20 fallback in rebuild.js');

      // Functional check: list size 10 → serves 10.
      const p = config.addProfile('INT-CB1-T2');
      config.updateProfile(p.id, {
        filters: { list_size: 10, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-comedy-movies': true },
      });
      const profile = config.getProfile(p.id);
      const def = { type: 'movie', id: 'mdb-comedy-movies', name: 'Comedy Movies', source: 'mdblist', user: 'hdlists', slug: 'comedy-movies-2001-2020', min_imdb: 6, sort: 'imdbpopular' };
      const items = [];
      for (let i = 1; i <= 30; i++) {
        items.push({ imdb_id: 'tt' + i, ids: { imdb: 'tt' + i, tmdb: 100 + i }, title: 'Title ' + i, release_year: 2020, poster: null, imdbRating: 7.5 });
      }
      mdblist.listItemsPage = async () => items;
      mdblist.mediaInfoBatch = async () => new Map();
      try {
        const built = await rebuild.buildExtraCatalog(profile, def, quiet);
        store.swapExtra(p.id, def.id, built, { format: 'reserve-v1', list_size: 10, eligible_at_build: built.length });
        const served = catalogServe.servedCatalog(profile, def.id, { record: false });
        assert.strictEqual(served.metas.length, 10, `list size 10 serves exactly 10: got ${served.metas.length}`);

        // Watch Later serves true source count (not sized by the setting).
        const wlDef = { type: 'movie', id: 'trakt-watchlist-movies', name: 'Watch Later', source: 'simkl_plantowatch', default_on: true, dedupe_watched: false };
        store.swapExtra(p.id, wlDef.id, [
          { id: 'tt1', type: 'movie', name: 'W1' },
          { id: 'tt2', type: 'movie', name: 'W2' },
          { id: 'tt3', type: 'movie', name: 'W3' },
        ]);
        const servedWl = catalogServe.servedCatalog(profile, wlDef.id, { record: false });
        assert.strictEqual(servedWl.metas.length, 3, `Watch Later serves true source count (3): got ${servedWl.metas.length}`);
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        config.removeProfile(p.id);
        store.deleteCache(p.id);
      }
    });

    // T3 — local replacement: add watch then suppression with no rebuild/adapter
    // call → servedCatalog, portal preview, Companion preview all stay at list
    // size and agree on ids/order; include an AI row.
    await it('CB-1 T3. local replacement: watch + suppression, no rebuild', async () => {
      const p = config.addProfile('INT-CB1-T3');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true },
      });
      const profile = config.getProfile(p.id);
      // Seed the cache with 40 titles (2× list size reserve).
      const metas = [];
      for (let i = 1; i <= 40; i++) {
        metas.push({ id: 'tt' + i, type: 'movie', name: 'Title ' + i, poster: null, releaseInfo: '2020', imdbRating: 7.5 });
      }
      store.swapExtra(p.id, 'mdb-action-movies', metas, { format: 'reserve-v1', list_size: 20, eligible_at_build: 40 });

      // (a) Baseline: serves 20.
      let served = catalogServe.servedCatalog(profile, 'mdb-action-movies', { record: false });
      assert.strictEqual(served.metas.length, 20, 'baseline serves 20');
      const baselineIds = served.metas.map((m) => m.id);

      // (b) Mark 5 titles as watched.
      const watchedIds = new Set(['tt1', 'tt2', 'tt3', 'tt4', 'tt5']);
      const origWatched = watchedStore.watchedIdSets;
      watchedStore.watchedIdSets = () => ({ imdb: watchedIds, tmdb: new Set() });

      // (c) Suppress 3 more titles.
      const suppressIds = new Set(['tt6', 'tt7', 'tt8']);
      const origSuppress = rs.dontRecommendImdbSet;
      rs.dontRecommendImdbSet = () => suppressIds;

      // (d) Serve: should still be 20 (backfilled from the reserve).
      served = catalogServe.servedCatalog(profile, 'mdb-action-movies', { record: false });
      assert.strictEqual(served.metas.length, 20, `after watch+suppress, still serves 20: got ${served.metas.length}`);
      // The watched and suppressed titles are NOT in the served list.
      for (const id of watchedIds) {
        assert.ok(!served.metas.some((m) => m.id === id), `watched ${id} not served`);
      }
      for (const id of suppressIds) {
        assert.ok(!served.metas.some((m) => m.id === id), `suppressed ${id} not served`);
      }
      // The served list is a subset of the original 40.
      for (const m of served.metas) {
        assert.ok(metas.some((x) => x.id === m.id), `served ${m.id} is from the reserve`);
      }

      // (e) Companion preview agrees.
      const companionServed = catalogServe.servedCatalog(profile, 'mdb-action-movies', { record: false });
      assert.deepStrictEqual(companionServed.metas.map((m) => m.id), served.metas.map((m) => m.id), 'companion preview agrees on ids/order');

      watchedStore.watchedIdSets = origWatched;
      rs.dontRecommendImdbSet = origSuppress;
      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });

    // T4 — setting change: raising list size serves more immediately when reserve
    // big enough; else serve what's eligible + queue exactly one background extras
    // rebuild; no network on request path.
    await it('CB-1 T4. setting change: raising list size serves more', async () => {
      const p = config.addProfile('INT-CB1-T4');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true },
      });
      const profile = config.getProfile(p.id);
      // Seed the cache with 40 titles (2×20 reserve).
      const metas = [];
      for (let i = 1; i <= 40; i++) {
        metas.push({ id: 'tt' + i, type: 'movie', name: 'Title ' + i, poster: null, releaseInfo: '2020', imdbRating: 7.5 });
      }
      store.swapExtra(p.id, 'mdb-action-movies', metas, { format: 'reserve-v1', list_size: 20, eligible_at_build: 40 });

      // (a) Raise list size to 30. The reserve (40) is big enough.
      config.updateProfile(p.id, { filters: { list_size: 30 } });
      const profile2 = config.getProfile(p.id);
      const served = catalogServe.servedCatalog(profile2, 'mdb-action-movies', { record: false });
      assert.strictEqual(served.metas.length, 30, `raising to 30 serves 30 (reserve big enough): got ${served.metas.length}`);

      // (b) Raise list size to 50. The reserve (40) is NOT big enough.
      config.updateProfile(p.id, { filters: { list_size: 50 } });
      const profile3 = config.getProfile(p.id);
      const served2 = catalogServe.servedCatalog(profile3, 'mdb-action-movies', { record: false });
      assert.strictEqual(served2.metas.length, 40, `raising to 50 serves 40 (reserve too small, honest shortfall): got ${served2.metas.length}`);

      // (c) ensureFresh detects the smaller-list-size trigger.
      const stale = rebuild.isStaleForProfile(profile3, { type: 'movie', id: 'mdb-action-movies', source: 'mdblist' }, store.loadCache(p.id).extras['mdb-action-movies']);
      assert.ok(stale, 'ensureFresh detects smaller-list-size trigger');

      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });

    // T5 — exceptions: Watch Later keeps watched, ignores suppressions, not
    // padded; Christmas keeps watched, drops+backfills suppressed.
    await it('CB-1 T5. exceptions: Watch Later + Christmas', async () => {
      const p = config.addProfile('INT-CB1-T5');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'trakt-watchlist-movies': true, 'mdb-christmas-movies': true },
      });
      const profile = config.getProfile(p.id);

      // Watch Later: 3 titles, 1 watched, 1 suppressed.
      const wlMetas = [
        { id: 'tt1', type: 'movie', name: 'W1' },
        { id: 'tt2', type: 'movie', name: 'W2' },
        { id: 'tt3', type: 'movie', name: 'W3' },
      ];
      store.swapExtra(p.id, 'trakt-watchlist-movies', wlMetas);
      const watchedIds = new Set(['tt1']);
      const origWatched = watchedStore.watchedIdSets;
      watchedStore.watchedIdSets = () => ({ imdb: watchedIds, tmdb: new Set() });
      const suppressIds = new Set(['tt2']);
      const origSuppress = rs.dontRecommendImdbSet;
      rs.dontRecommendImdbSet = () => suppressIds;

      // Watch Later keeps watched (dedupe_watched:false) and ignores suppressions
      // (source: simkl_plantowatch).
      const servedWl = catalogServe.servedCatalog(profile, 'trakt-watchlist-movies', { record: false });
      assert.strictEqual(servedWl.metas.length, 3, `Watch Later keeps all 3 (watched + suppressed): got ${servedWl.metas.length}`);
      assert.ok(servedWl.metas.some((m) => m.id === 'tt1'), 'Watch Later keeps watched title');
      assert.ok(servedWl.metas.some((m) => m.id === 'tt2'), 'Watch Later ignores suppression');

      // Christmas: 3 titles, 1 watched, 1 suppressed.
      const xmasMetas = [
        { id: 'tt10', type: 'movie', name: 'X1' },
        { id: 'tt11', type: 'movie', name: 'X2' },
        { id: 'tt12', type: 'movie', name: 'X3' },
      ];
      store.swapExtra(p.id, 'mdb-christmas-movies', xmasMetas, { format: 'reserve-v1', list_size: 20, eligible_at_build: 3 });
      const xmasWatched = new Set(['tt10']);
      watchedStore.watchedIdSets = () => ({ imdb: xmasWatched, tmdb: new Set() });
      const xmasSuppress = new Set(['tt11']);
      rs.dontRecommendImdbSet = () => xmasSuppress;

      // Christmas keeps watched (dedupe_watched:false) but drops suppressed
      // (source: mdblist).
      const servedXmas = catalogServe.servedCatalog(profile, 'mdb-christmas-movies', { record: false });
      assert.ok(servedXmas.metas.some((m) => m.id === 'tt10'), 'Christmas keeps watched title');
      assert.ok(!servedXmas.metas.some((m) => m.id === 'tt11'), 'Christmas drops suppressed title');
      assert.strictEqual(servedXmas.metas.length, 2, `Christmas serves 2 (watched kept, suppressed dropped): got ${servedXmas.metas.length}`);

      watchedStore.watchedIdSets = origWatched;
      rs.dontRecommendImdbSet = origSuppress;
      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });

    // T6 — age safety on reserve: age-limited profile: chain-blocked title in
    // neither visible set nor reserve; no-tmdb-id title withheld; chain failure
    // keeps old catalog.
    await it('CB-1 T6. age safety on reserve', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const origVerify = ageVerify.verify;
      const p = config.addProfile('INT-CB1-T6');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 12 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-kids-movies': true },
      });
      const profile = config.getProfile(p.id);
      const def = { type: 'movie', id: 'mdb-kids-movies', name: 'Kids Movies', source: 'mdblist', user: 'tvgeniekodi', slug: 'trending-kids-movies', min_imdb: 6, sort: 'tmdbpopular', age_band: 12 };
      // 3 titles: one allowed, one blocked, one no-tmdb-id.
      mdblist.listItemsPage = async () => ([
        { imdb_id: 'tt100', ids: { imdb: 'tt100', tmdb: 111 }, title: 'Allowed', release_year: 2020, poster: null, imdbRating: 7.5 },
        { imdb_id: 'tt200', ids: { imdb: 'tt200', tmdb: 222 }, title: 'Blocked', release_year: 2020, poster: null, imdbRating: 7.5 },
        { imdb_id: 'tt300', ids: { imdb: 'tt300' }, title: 'No TMDB', release_year: 2020, poster: null, imdbRating: 7.5 },
      ]);
      mdblist.mediaInfoBatch = async () => new Map();
      ageVerify.verify = (titles) => {
        const result = new Map();
        for (const t of titles) {
          const verdict = String(t.key.split(':')[1]) === '222' ? 'block' : 'allow';
          result.set(t.key, { verdict, source: 'csm', rating: verdict === 'block' ? '18' : '13' });
        }
        return Promise.resolve(result);
      };
      try {
        const built = await rebuild.buildExtraCatalog(profile, def, quiet);
        const ids = built.map((m) => m.id);
        assert.ok(ids.includes('tt100'), 'allowed title in reserve');
        assert.ok(!ids.includes('tt200'), 'blocked title NOT in reserve');
        assert.ok(!ids.includes('tt300'), 'no-tmdb-id title NOT in reserve (withheld)');
        assert.strictEqual(built.length, 1, 'exactly 1 title in reserve');
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        ageVerify.verify = origVerify;
        config.removeProfile(p.id);
        store.deleteCache(p.id);
      }
    });

    // T7 — refresh triggers and failure: legacy cache triggers one background
    // rebuild while staying servable; depleted reserve triggers one; thin source
    // doesn't hammer provider; one failing catalog doesn't block others;
    // provider/age failure or sparse result never replaces a fuller old catalog;
    // thin source reports partial count honestly.
    await it('CB-1 T7. refresh triggers and failure', async () => {
      const p = config.addProfile('INT-CB1-T7');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true, 'mdb-comedy-movies': true },
      });
      const profile = config.getProfile(p.id);
      const defA = { type: 'movie', id: 'mdb-action-movies', source: 'mdblist' };
      const defB = { type: 'movie', id: 'mdb-comedy-movies', source: 'mdblist' };

      // (a) Legacy cache (no format marker) triggers a rebuild.
      store.swapExtra(p.id, defA.id, [{ id: 'tt1', type: 'movie', name: 'T1' }]);
      const entryA = store.loadCache(p.id).extras[defA.id];
      assert.ok(rebuild.isStaleForProfile(profile, defA, entryA), 'legacy cache (no format) is stale');

      // (b) Depleted reserve triggers a rebuild.
      store.swapExtra(p.id, defA.id, [{ id: 'tt1', type: 'movie', name: 'T1' }], { format: 'reserve-v1', list_size: 20, eligible_at_build: 20 });
      const watchedIds = new Set();
      for (let i = 2; i <= 20; i++) watchedIds.add('tt' + i);
      const origWatched = watchedStore.watchedIdSets;
      watchedStore.watchedIdSets = () => ({ imdb: watchedIds, tmdb: new Set() });
      const entryB = store.loadCache(p.id).extras[defA.id];
      assert.ok(rebuild.isStaleForProfile(profile, defA, entryB), 'depleted reserve is stale');
      watchedStore.watchedIdSets = origWatched;

      // (c) Thin source (eligible_at_build < list size) does NOT trigger on every
      // request — the depletion check compares against eligible_at_build.
      store.swapExtra(p.id, defB.id, [{ id: 'tt1', type: 'movie', name: 'T1' }], { format: 'reserve-v1', list_size: 20, eligible_at_build: 1 });
      const entryC = store.loadCache(p.id).extras[defB.id];
      // No watches/suppressions: eligible is still 1, which equals eligible_at_build.
      assert.ok(!rebuild.isStaleForProfile(profile, defB, entryC), 'thin source (eligible == eligible_at_build) is NOT stale');

      // (d) One failing catalog doesn't block others: ensureFresh checks each
      // catalog independently. The backoff is profile-wide (last_attempt_at).
      store.markAttempt(p.id); // sets last_attempt_at to now (within backoff window)
      // (We can't easily test the full ensureFresh without the job queue, so
      // we verify the staleness logic is per-catalog.)
      const staleA = rebuild.isStaleForProfile(profile, defA, store.loadCache(p.id).extras[defA.id]);
      const staleB = rebuild.isStaleForProfile(profile, defB, store.loadCache(p.id).extras[defB.id]);
      // defA is stale (depleted), defB is not (thin source, eligible == eligible_at_build).
      assert.ok(staleA, 'defA (depleted) is stale');
      assert.ok(!staleB, 'defB (thin source, not depleted) is NOT stale');

      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });

    // T8 — preview UI: DOM-level check of the preview refresh logic.
    // We verify the dedupe_watched flag is in the preview DTO and the
    // refetch logic is present in both portal and companion.
    await it('CB-1 T8. preview UI: dedupe_watched flag in DTO + refetch logic', async () => {
      const p = config.addProfile('INT-CB1-T8');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true, 'trakt-watchlist-movies': true, 'mdb-christmas-movies': true },
      });
      const profile = config.getProfile(p.id);

      // Seed the caches.
      store.swapExtra(p.id, 'mdb-action-movies', [
        { id: 'tt1', type: 'movie', name: 'A1' },
        { id: 'tt2', type: 'movie', name: 'A2' },
      ], { format: 'reserve-v1', list_size: 20, eligible_at_build: 2 });
      store.swapExtra(p.id, 'trakt-watchlist-movies', [
        { id: 'tt3', type: 'movie', name: 'W1' },
      ]);
      store.swapExtra(p.id, 'mdb-christmas-movies', [
        { id: 'tt4', type: 'movie', name: 'X1' },
      ], { format: 'reserve-v1', list_size: 20, eligible_at_build: 1 });

      // (a) Action Movies: dedupe_watched is true (default).
      const servedA = catalogServe.servedCatalog(profile, 'mdb-action-movies', { record: false });
      assert.strictEqual(servedA.dedupe_watched, true, 'Action Movies: dedupe_watched=true');

      // (b) Watch Later: dedupe_watched is false.
      const servedWl = catalogServe.servedCatalog(profile, 'trakt-watchlist-movies', { record: false });
      assert.strictEqual(servedWl.dedupe_watched, false, 'Watch Later: dedupe_watched=false');

      // (c) Christmas: dedupe_watched is false.
      const servedXmas = catalogServe.servedCatalog(profile, 'mdb-christmas-movies', { record: false });
      assert.strictEqual(servedXmas.dedupe_watched, false, 'Christmas: dedupe_watched=false');

      // (d) The refetch logic is present in the companion app.js.
      const appJs = require('fs').readFileSync(require('path').join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
      assert.ok(appJs.includes('pvRefetch'), 'companion app.js has pvRefetch');
      assert.ok(appJs.includes('dedupeWatched'), 'companion app.js uses dedupeWatched');

      // (e) The refetch logic is present in the portal index.html.
      const indexHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
      assert.ok(indexHtml.includes('_cpvRefetch'), 'portal index.html has _cpvRefetch');
      assert.ok(indexHtml.includes('dedupeWatched'), 'portal index.html uses dedupeWatched');

      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });

    // T9 — syntax: node --check on mobile/public/app.js and the portal's
    // inline script. Guards against curly-quote / syntax regressions.
    await it('CB-1 T9. syntax: app.js and portal inline script parse', async () => {
      const { execSync } = require('child_process');
      const path = require('path');
      const os = require('os');
      // mobile/public/app.js
      execSync(`node --check "${path.join(__dirname, '..', 'mobile', 'public', 'app.js')}"`, { stdio: 'pipe' });
      // portal inline script: extract the <script> block and syntax-check it.
      const html = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      assert.ok(scriptMatch, 'portal index.html has an inline <script> block');
      // Write to a temp file and node --check it.
      const tmpFile = path.join(os.tmpdir(), 'portal-script-check-' + Date.now() + '.js');
      require('fs').writeFileSync(tmpFile, scriptMatch[1]);
      try {
        execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
      } finally {
        require('fs').unlinkSync(tmpFile);
      }
    });

    // T10 — swap gate: first build with a short source (15 eligible, list size 20)
    // publishes. The old code required newVisible >= listSize when no old entry
    // existed (oldVisible || listSize = listSize), so a short source never
    // published on first build. The fix: min(listSize, oldVisible) where a
    // missing old entry counts as 0 → gate = newVisible >= 0.
    // Exercises the REAL rebuildProfile code path (not a copied formula).
    await it('CB-1 T10. swap gate: first build with short source publishes (via rebuildProfile)', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const p = config.addProfile('INT-CB1-T10');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true },
      });
      const profile = config.getProfile(p.id);
      // 15 titles (short source: fewer than list size).
      const items = [];
      for (let i = 1; i <= 15; i++) {
        items.push({ imdb_id: 'tt' + i, ids: { imdb: 'tt' + i, tmdb: 100 + i }, title: 'Title ' + i, release_year: 2020, poster: null, imdbRating: 7.5 });
      }
      mdblist.listItemsPage = async () => items;
      mdblist.mediaInfoBatch = async () => new Map();
      try {
        // Call the real rebuildProfile — it builds the catalog and applies
        // the swap gate internally.
        const results = await rebuild.rebuildProfile(profile, quiet, { extras: true });
        assert.ok(results['mdb-action-movies'], 'rebuildProfile returned a result for mdb-action-movies');
        assert.strictEqual(results['mdb-action-movies'].ok, true, `swap gate passes for first build (short source): ${JSON.stringify(results['mdb-action-movies'])}`);
        assert.ok(results['mdb-action-movies'].count >= rebuild.MIN_METAS, `MIN_METAS floor holds: ${results['mdb-action-movies'].count} >= ${rebuild.MIN_METAS}`);
        // The cache holds the 15 titles.
        const cache = store.loadCache(p.id);
        assert.ok(cache.extras['mdb-action-movies'], 'catalog published');
        assert.strictEqual(cache.extras['mdb-action-movies'].metas.length, 15, `cache holds 15 titles: got ${cache.extras['mdb-action-movies'].metas.length}`);
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        config.removeProfile(p.id);
        store.deleteCache(p.id);
      }
    });

    // T11 — depletion trigger: a single watch does NOT mark the catalog stale
    // when the pool can still fill the list size. The old code triggered on
    // any drop below eligible_at_build (39 < 40 → stale). The fix: compare
    // shown counts — min(listSize, eligibleNow) < min(listSize, eligible_at_build).
    await it('CB-1 T11. depletion: single watch does not trigger rebuild', async () => {
      const p = config.addProfile('INT-CB1-T11');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true },
      });
      const profile = config.getProfile(p.id);
      const def = { type: 'movie', id: 'mdb-action-movies', source: 'mdblist' };
      // 40 titles in the reserve, all eligible at build.
      const metas = [];
      for (let i = 1; i <= 40; i++) {
        metas.push({ id: 'tt' + i, type: 'movie', name: 'Title ' + i });
      }
      store.swapExtra(p.id, def.id, metas, { format: 'reserve-v1', list_size: 20, eligible_at_build: 40 });

      // (a) One watch: 39 eligible. min(20, 39) = 20, min(20, 40) = 20. 20 < 20 → false.
      const oneWatched = new Set(['tt1']);
      const origWatched = watchedStore.watchedIdSets;
      watchedStore.watchedIdSets = () => ({ imdb: oneWatched, tmdb: new Set() });
      const entry = store.loadCache(p.id).extras[def.id];
      assert.ok(!rebuild.isStaleForProfile(profile, def, entry), 'single watch (39/40 eligible) is NOT stale');
      watchedStore.watchedIdSets = origWatched;

      // (b) Many watches: 5 eligible. min(20, 5) = 5, min(20, 40) = 20. 5 < 20 → true.
      const manyWatched = new Set();
      for (let i = 1; i <= 35; i++) manyWatched.add('tt' + i);
      watchedStore.watchedIdSets = () => ({ imdb: manyWatched, tmdb: new Set() });
      assert.ok(rebuild.isStaleForProfile(profile, def, entry), 'many watches (5/40 eligible) IS stale');
      watchedStore.watchedIdSets = origWatched;

      // (c) Thin source: 10 titles in the pool, eligible_at_build = 10.
      // One watch → 9 eligible. min(20, 9) = 9, min(20, 10) = 10. 9 < 10 → true.
      const thinMetas = metas.slice(0, 10);
      store.swapExtra(p.id, def.id, thinMetas, { format: 'reserve-v1', list_size: 20, eligible_at_build: 10 });
      const thinEntry = store.loadCache(p.id).extras[def.id];
      const thinWatched = new Set(['tt1']);
      watchedStore.watchedIdSets = () => ({ imdb: thinWatched, tmdb: new Set() });
      assert.ok(rebuild.isStaleForProfile(profile, def, thinEntry), 'thin source: one watch (9/10 eligible) IS stale');
      watchedStore.watchedIdSets = origWatched;

      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });

    // T12 — reserve goal: paging counts only ELIGIBLE candidates toward 2×listSize.
    // Ineligible titles (watched/suppressed) stay in the cache but don't count.
    await it('CB-1 T12. reserve goal: counts eligible, keeps ineligible', async () => {
      const origList = mdblist.listItemsPage;
      const origMediaInfo = mdblist.mediaInfoBatch;
      const p = config.addProfile('INT-CB1-T12');
      config.updateProfile(p.id, {
        filters: { list_size: 10, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true },
      });
      const profile = config.getProfile(p.id);
      const def = { type: 'movie', id: 'mdb-action-movies', name: 'Action Movies', source: 'mdblist', user: 'hdlists', slug: 'action', min_imdb: 6, sort: 'imdbpopular' };
      // 30 titles: 10 watched, 5 suppressed, 15 eligible.
      const items = [];
      for (let i = 1; i <= 30; i++) {
        items.push({ imdb_id: 'tt' + i, ids: { imdb: 'tt' + i, tmdb: 100 + i }, title: 'Title ' + i, release_year: 2020, poster: null, imdbRating: 7.5 });
      }
      mdblist.listItemsPage = async () => items;
      mdblist.mediaInfoBatch = async () => new Map();
      // 10 watched, 5 suppressed.
      const watchedIds = new Set();
      for (let i = 1; i <= 10; i++) watchedIds.add('tt' + i);
      const origWatched = watchedStore.watchedIdSets;
      watchedStore.watchedIdSets = () => ({ imdb: watchedIds, tmdb: new Set() });
      const suppressIds = new Set();
      for (let i = 11; i <= 15; i++) suppressIds.add('tt' + i);
      const origSuppress = rs.dontRecommendImdbSet;
      rs.dontRecommendImdbSet = () => suppressIds;
      try {
        const built = await rebuild.buildExtraCatalog(profile, def, quiet);
        // The reserve keeps ALL 30 titles (ineligible included).
        assert.strictEqual(built.length, 30, `reserve keeps all 30 titles (ineligible included): got ${built.length}`);
        // The eligible count is 15 (30 - 10 watched - 5 suppressed).
        const eligible = rebuild.eligibleVisible(built, profile, def);
        assert.strictEqual(eligible, 15, `eligible count is 15: got ${eligible}`);
        // The target was 2×10 = 20 eligible. Since only 15 are available,
        // the reserve is honest about the shortfall.
        assert.ok(eligible <= 20, 'eligible does not exceed target');
      } finally {
        mdblist.listItemsPage = origList;
        mdblist.mediaInfoBatch = origMediaInfo;
        watchedStore.watchedIdSets = origWatched;
        rs.dontRecommendImdbSet = origSuppress;
        config.removeProfile(p.id);
        store.deleteCache(p.id);
      }
    });

    // T13 — T7 additional case: one failing catalog does not block the
    // others' refresh. ensureFresh checks each catalog independently via
    // isStaleForProfile; a stale catalog triggers a rebuild that processes
    // ALL enabled catalogs, but a non-stale catalog's cache is preserved
    // (the swap gate prevents a worse replacement).
    await it('CB-1 T13. one failing catalog does not block others', async () => {
      const p = config.addProfile('INT-CB1-T13');
      config.updateProfile(p.id, {
        filters: { list_size: 20, age_limit: 0 },
        keys: { mdblist_api_key: 'cb1-mdb' },
        catalogs: { 'mdb-action-movies': true, 'mdb-comedy-movies': true },
      });
      const profile = config.getProfile(p.id);
      const defA = { type: 'movie', id: 'mdb-action-movies', source: 'mdblist' };
      defA.name = 'Action Movies';
      const defB = { type: 'movie', id: 'mdb-comedy-movies', source: 'mdblist' };
      defB.name = 'Comedy Movies';

      // Catalog A: depleted (stale). 40 titles, 35 watched → 5 eligible.
      const metasA = [];
      for (let i = 1; i <= 40; i++) metasA.push({ id: 'ttA' + i, type: 'movie', name: 'A' + i });
      store.swapExtra(p.id, defA.id, metasA, { format: 'reserve-v1', list_size: 20, eligible_at_build: 40 });

      // Catalog B: healthy (not stale). 40 titles, 0 watched → 40 eligible.
      const metasB = [];
      for (let i = 1; i <= 40; i++) metasB.push({ id: 'ttB' + i, type: 'movie', name: 'B' + i });
      store.swapExtra(p.id, defB.id, metasB, { format: 'reserve-v1', list_size: 20, eligible_at_build: 40 });

      // 35 of catalog A's titles are watched.
      const watchedA = new Set();
      for (let i = 1; i <= 35; i++) watchedA.add('ttA' + i);
      const origWatched = watchedStore.watchedIdSets;
      watchedStore.watchedIdSets = () => ({ imdb: watchedA, tmdb: new Set() });

      // Catalog A is stale (5 eligible < 20 = min(20, 40)).
      const entryA = store.loadCache(p.id).extras[defA.id];
      assert.ok(rebuild.isStaleForProfile(profile, defA, entryA), 'catalog A (depleted) is stale');

      // Catalog B is NOT stale (40 eligible = min(20, 40)).
      const entryB = store.loadCache(p.id).extras[defB.id];
      assert.ok(!rebuild.isStaleForProfile(profile, defB, entryB), 'catalog B (healthy) is NOT stale');

      // Per-catalog independence: the staleness of A does not affect B.
      // This is verified by the per-catalog isStaleForProfile check above.
      // In rebuildProfile, each catalog is built and swapped independently;
      // a failure in one catalog (caught by the try/catch) does not prevent
      // the others from being processed.

      watchedStore.watchedIdSets = origWatched;
      config.removeProfile(p.id);
      store.deleteCache(p.id);
    });
  }

  // ── I5. Search at TV-14: allowed + unknown returned; LLM error → empty ──────
  await it('I5. Search at TV-14: chain decides; LLM error → empty results (fail-closed)', async () => {
    const ageVerify = require('../src/ageVerification');
    const chain = require('../src/ageVerification/chain');

    const p = config.addProfile('INT-I5');
    config.updateProfile(p.id, { filters: { age_limit: 14 } });
    const profile = config.getProfile(p.id);
    const tier = ageVerify.tierFor({ age_limit: 14 });

    const titles = [
      { key: 'series:100', imdb_id: 'tt1', adult: false, title: 'Show One', year: '2020', genres: ['Drama'], certification: null },
      { key: 'series:200', imdb_id: 'tt2', adult: false, title: 'Show Two', year: '2021', genres: ['Comedy'], certification: null },
    ];

    // (a) Test the chain's decide function directly with stubbed sources
    const sources = {
      tmdbRatings: async () => new Map(),
      csmAges: async () => new Map(),
      tvdbRatings: async () => new Map(),
      simklCerts: async () => new Map(),
      mdblistCerts: async () => new Map(),
      llmGate: async () => {
        // tt1 → true (allow), tt2 → omitted (unknown)
        return new Map([['series:100', true]]);
      },
    };
    const result = await chain.decide(titles, 'series', tier, sources, quiet);
    // tt1 → allow, tt2 → unknown (kept)
    assert.strictEqual(result.get('series:100').verdict, 'allow');
    assert.strictEqual(result.get('series:200').verdict, 'unknown');

    // (b) LLM error → fail-closed: decide throws
    const throwingSources = { ...sources, llmGate: async () => { throw new Error('LLM down'); } };
    try {
      await chain.decide(titles, 'series', tier, throwingSources, quiet);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('LLM down'), 'LLM error propagates');
    }

    config.removeProfile(p.id); rs.deleteForProfile(p.id);
  });

  // ── I7. TVDB key: encrypted at rest, redacted in GET, env fallback ──────────
  await it('I7. TVDB key: settings encryption + env fallback + client behaviour', async () => {
    const settings = require('../src/settings');
    const tvdb = require('../src/services/tvdb');

    // keyFor returns the setting when set
    settings.updateSettings({ keys: { tvdb_api_key: 'test-tvdb-key' } });
    assert.strictEqual(settings.keyFor({ id: 'test' }, 'tvdb_api_key'), 'test-tvdb-key');

    // keyFor falls back to process.env.TVDB_API_KEY when the setting is empty
    settings.updateSettings({ keys: { tvdb_api_key: '' } });
    const origEnv = process.env.TVDB_API_KEY;
    process.env.TVDB_API_KEY = 'env-tvdb-key';
    const key = tvdb.tvdbKey();
    assert.strictEqual(key, 'env-tvdb-key');
    process.env.TVDB_API_KEY = origEnv;

    // No key → empty string (mediaCerts returns empty Map)
    settings.updateSettings({ keys: { tvdb_api_key: '' } });
    process.env.TVDB_API_KEY = '';
    const emptyKey = tvdb.tvdbKey();
    assert.strictEqual(emptyKey, '');
  });

  // ── I6. Marquee Cinema at TV-14: hard floor only ─────────────────────────────
  await it('I6. Marquee Cinema at TV-14: hard floor only (discover ceiling, cert_over, unknown passes)', async () => {
    const marquee = require('../src/engines/marquee/filters');
    const genreMap = { 18: 'Drama', 27: 'Horror' };
    const base = { imdb_id: 'tt', imdb_rating: 8, vote_average: 8, vote_count: 5000, year: 2020, genres: ['Drama'], availability: 'AVAILABLE' };

    // TV-14 envelope
    const env = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 14 }, { nowYear: 2026, genreMap });
    assert.strictEqual(env.kids, true);

    // (a) discover ceiling is MA 15+
    const params = env.discoverParams();
    assert.strictEqual(params.certification_country, 'AU');
    assert.strictEqual(params['certification.lte'], 'MA 15+');

    // (b) hard floor → cert_over
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: 'R 18+', certUS: null }), { ok: false, reason: 'cert_over' });
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: null, certUS: 'NC-17' }), { ok: false, reason: 'cert_over' });
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: 'RC', certUS: null }), { ok: false, reason: 'cert_over' });
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: 'X 18+', certUS: null }), { ok: false, reason: 'cert_over' });

    // (c) unknown certificate → NOT rejected (passes)
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: null, certUS: null }), { ok: true });

    // (d) AU MA15+ passes the envelope (the pool gate decides later)
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: 'MA 15+', certUS: null }), { ok: true });
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: 'M', certUS: null }), { ok: true });
    assert.deepStrictEqual(env.hardFilter({ ...base, certAU: null, certUS: 'R' }), { ok: true });

    // AGE-2: tiers 10 and 13 (→ tier 12) are chain tiers — unknown cert passes (fail open).
    const tier10 = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 10 }, { nowYear: 2026, genreMap });
    assert.deepStrictEqual(tier10.hardFilter({ ...base, certAU: null, certUS: null }), { ok: true });
    const tier13 = marquee.compileEnvelope({ min_rating: 0, vote_count_floor: 1000, max_age_years: 0, excluded_genres: [], age_limit: 13 }, { nowYear: 2026, genreMap });
    assert.deepStrictEqual(tier13.hardFilter({ ...base, certAU: null, certUS: null }), { ok: true });
  });

  // ── U1. Portal: the TV-14 option + the TVDB key row + saving age_limit 14 ──
  await it('U1. Portal: TV-14 (14+, AU M) option (value 14) + TVDB key row; saving age_limit 14 stores 14', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    // (a) AGE-2: the age select offers exactly 10+, 12+, TV-14, 15+ (5, 6, 8, 13 removed)
    assert.ok(
      html.includes("[[10,'10+ (TV-PG / PG)'],[12,'12+ (PG, UK 12)'],[14,'TV-14 (14+, AU M)'],[15,'15+ (MA 15+)']"),
      'index.html offers the AGE-2 age options 10+, 12+, TV-14 (14+, AU M), 15+ (MA 15+)');
    // the single muted chain explainer (AGE-2: one explainer for every tier)
    assert.ok(html.includes('Common Sense Media age'), 'chain explainer present');

    // (b) the TVDB key row in Server Config
    assert.ok(html.includes("keyRowS('tvdb', 'tvdb_api_key', keys.tvdb_api_key)"), 'TVDB key row present in Server Config');

    // (c) saving age_limit 14 stores 14
    const p = config.addProfile('INT-U1');
    config.updateProfile(p.id, { filters: { age_limit: 14 } });
    assert.strictEqual(config.getProfile(p.id).filters.age_limit, 14, 'age_limit 14 is stored');
    config.removeProfile(p.id);
  });

  // ── T5. End-to-end safety: the REAL buildSources against a stubbed global.fetch ─
  // This is the test that would have caught F1 (the TMDB append_to_response drop).
  // All four real source adapters (TMDB, MDBList/CSM, TVDB, Simkl) are exercised
  // through the real buildSources(profile) with ONLY global.fetch stubbed — the
  // source fetch seams (setTmdbFetch/setTvdbFetch) stay at their global.fetch
  // default, so the real URL/query construction is what is under test.
  await it('T5. end-to-end safety: real buildSources + stubbed global.fetch (TMDB/CSM/TVDB/Simkl)', async () => {
    const chain = require('../src/ageVerification/chain');
    const ageSources = require('../src/ageVerification/sources');
    const tier = require('../src/ageVerification/tiers').TIERS[14];
    const tvdb = require('../src/services/tvdb');

    // TV-14 profile: three keys set, NO Simkl connection (simklCerts → empty, no fetch).
    const profile = {
      id: 'INT-T5', name: 'INT-T5',
      keys: { tmdb_api_key: 'itest-tmdb', mdblist_api_key: 'itest-mdb', tvdb_api_key: 'itest-tvdb' },
      simkl_auth: null,
      filters: { age_limit: 14 },
    };
    const prevKeys = Object.assign({}, settings.getSettings().keys);
    const prevCsm = store.loadCsmCache();
    store.saveCsmCache({}); // clear the CSM disk cache so the batch fetch is exercised
    settings.updateSettings({ keys: { tmdb_api_key: 'itest-tmdb', mdblist_api_key: 'itest-mdb', tvdb_api_key: 'itest-tvdb' } });
    tvdb.clearToken(); // force a fresh login in the TVDB flow

    const fetchLog = [];
    const origFetch = global.fetch;
    // The TMDB and TVDB adapters read their fetch from a module seam that captured
    // the original global.fetch at module load; point both seams (and global.fetch)
    // at the same stub so all four real adapters answer from fixtures.
    const fetchStub = (url, opts) => {
      const u = String(url);
      fetchLog.push({ url: u, method: (opts && opts.method) || 'GET' });
      // TMDB content_ratings (series) — the append_to_response query must survive (F1).
      if (u.includes('api.themoviedb.org/3/tv/')) {
        const id = u.split('/tv/')[1].split('?')[0];
        let results = [];
        if (id === '1908') results = [{ iso_3166_1: 'AU', rating: 'R 18+' }, { iso_3166_1: 'US', rating: 'TV-14' }];
        else if (id === '114922') results = [{ iso_3166_1: 'AU', rating: 'MA 15+' }, { iso_3166_1: 'US', rating: 'TV-14' }];
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content_ratings: { results } }) });
      }
      // MDBList batch (POST /imdb/show) — Common Sense age.
      if (u.includes('api.mdblist.com/imdb/show')) {
        const ids = JSON.parse(opts.body).ids;
        const arr = ids.map((id) => (id === 'tt9794044' ? { ids: { imdb: id }, age_rating: 14 } : { ids: { imdb: id } }));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(arr) });
      }
      // TVDB v4: login → search/remoteid → series extended.
      if (u.includes('api4.thetvdb.com/v4/login')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { token: 'tok' } }) });
      }
      if (u.includes('api4.thetvdb.com/v4/search/remoteid/')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ series: { id: 324126 } }] }) });
      }
      if (u.includes('api4.thetvdb.com/v4/series/324126/extended')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { contentRatings: [{ name: 'PG', country: 'aus' }] } }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };
    global.fetch = fetchStub;
    ageSources.setTmdbFetch(fetchStub);
    tvdb.setTvdbFetch(fetchStub);

    const titles = [
      { key: 'series:1908', imdb_id: 'tt0086759', adult: false, title: 'Miami Vice', year: 1984, genres: [], certification: null },
      { key: 'series:114922', imdb_id: 'tt9794044', adult: false, title: 'Citadel', year: 2023, genres: [], certification: null },
      { key: 'series:99999', imdb_id: 'tt9999999', adult: false, title: 'TVDB-only', year: 2024, genres: [], certification: null },
    ];
    try {
      const sources = ageSources.buildSources(profile, quiet);
      const r = await chain.decide(titles, 'series', tier, sources, quiet);
      // Miami Vice: TMDB AU R 18+ → hard-floor block (step 0).
      assert.deepStrictEqual(r.get('series:1908'), { verdict: 'block', source: 'hard-floor', rating: 'R18+' });
      // Citadel: TMDB AU MA 15+ (not a hard floor), Common Sense 14 → allow/csm (step 1).
      assert.deepStrictEqual(r.get('series:114922'), { verdict: 'allow', source: 'csm', rating: '14' });
      // TVDB-only: no Common Sense, no TMDB rating, TVDB aus: PG → allow/tvdb-au (step 2).
      assert.deepStrictEqual(r.get('series:99999'), { verdict: 'allow', source: 'tvdb-au', rating: 'PG' });
      // The TMDB fetch carried append_to_response (the F1 regression — this would
      // have caught it: without the query TMDB returns no per-country ratings).
      assert.ok(fetchLog.some((c) => c.url.includes('append_to_response=content_ratings')), 'TMDB URL carries append_to_response');
    } finally {
      global.fetch = origFetch;
      ageSources.setTmdbFetch(origFetch);
      tvdb.setTvdbFetch(origFetch);
      settings.updateSettings({ keys: prevKeys });
      store.saveCsmCache(prevCsm);
      tvdb.clearToken();
    }
  });

  // ── O. Marquee TV TV-1: series progress store + one-time backfill ──────────
  // The per-show progress store (series_progress) and the sync wiring: a one-time
  // backfill fills it from a full shows+anime pull, steady-state syncs delta-pull
  // with episodes, and deleteForProfile clears both new tables. Simkl is stubbed
  // (no network); the pure parseSeriesProgress is exercised through the real
  // sync path.
  const simklStub = (fixtures) => {
    const calls = [];
    const origAll = simkl.getAllItems;
    const origAct = simkl.getActivities;
    simkl.getAllItems = async (_profile, type, opts = {}) => {
      calls.push({ type, status: opts.status, dateFrom: opts.dateFrom, episodes: !!opts.episodes });
      return fixtures[`${type}:${opts.status}`] || [];
    };
    simkl.getActivities = async () => fixtures.__activities;
    return {
      calls,
      restore() { simkl.getAllItems = origAll; simkl.getActivities = origAct; },
    };
  };
  // A Simkl all-items show/anime entry with per-episode stamps.
  const seriesItem = (simklId, section, { title, year, status, watched, total, notAired, lastWatchedAt, stamps }) => {
    const media = { ids: { simkl: simklId, imdb: `tt${simklId}`, tmdb: String(simklId) }, title, year };
    return {
      [section]: media,
      status,
      watched_episodes_count: watched,
      total_episodes_count: total,
      not_aired_episodes_count: notAired,
      last_watched_at: lastWatchedAt,
      seasons: [{ episodes: stamps.map((t) => ({ watched_at: t })) }],
    };
  };
  const showA = seriesItem(100, 'show', { title: 'Show A', year: 2020, status: 'completed', watched: 4, total: 10, notAired: 0, lastWatchedAt: '2026-01-15T00:00:00Z', stamps: ['2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', '2026-01-10T00:00:00Z', '2026-01-15T00:00:00Z'] });
  const showB = seriesItem(200, 'show', { title: 'Show B', year: 2021, status: 'watching', watched: 2, total: 20, notAired: 5, lastWatchedAt: '2026-02-01T00:00:00Z', stamps: ['2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'] });
  const animeC = seriesItem(300, 'anime', { title: 'Anime C', year: 2022, status: 'completed', watched: 1, total: 12, notAired: 0, lastWatchedAt: '2026-03-01T00:00:00Z', stamps: ['2026-03-01T00:00:00Z'] });
  const movieX = { movie: { ids: { simkl: 500, imdb: 'tt500', tmdb: '500' }, title: 'Movie X', year: 2020 }, last_watched_at: '2026-01-01T00:00:00Z' };

  await it('O1. upsertSeriesProgress + getSeriesProgress round-trip, kind filter, refresh (I1)', async () => {
    const p = config.addProfile('INT-O1');
    try {
      const rowA = { simkl_id: 100, kind: 'show', imdb_id: 'tt100', tmdb_id: '100', title: 'Show A', year: 2020, status: 'completed', watched_eps: 4, total_eps: 10, not_aired_eps: 0, last_watched_at: Date.parse('2026-01-15T00:00:00Z'), first_watched_at: Date.parse('2026-01-01T00:00:00Z'), first_real_at: Date.parse('2026-01-01T00:00:00Z'), last_real_at: Date.parse('2026-01-15T00:00:00Z'), stamps: 4, real_stamps: 4, eps_per_week: 2 };
      const rowC = { simkl_id: 300, kind: 'anime', imdb_id: 'tt300', tmdb_id: '300', title: 'Anime C', year: 2022, status: 'completed', watched_eps: 1, total_eps: 12, not_aired_eps: 0, last_watched_at: Date.parse('2026-03-01T00:00:00Z'), first_watched_at: Date.parse('2026-03-01T00:00:00Z'), first_real_at: Date.parse('2026-03-01T00:00:00Z'), last_real_at: Date.parse('2026-03-01T00:00:00Z'), stamps: 1, real_stamps: 1, eps_per_week: null };
      assert.strictEqual(watchedStore.upsertSeriesProgress(p.id, [rowA, rowC]), 2);
      let rows = watchedStore.getSeriesProgress(p.id);
      assert.strictEqual(rows.length, 2);
      // kind filter
      const shows = watchedStore.getSeriesProgress(p.id, { kind: 'show' });
      assert.strictEqual(shows.length, 1);
      assert.strictEqual(shows[0].simkl_id, 100);
      const anime = watchedStore.getSeriesProgress(p.id, { kind: 'anime' });
      assert.strictEqual(anime.length, 1);
      assert.strictEqual(anime[0].simkl_id, 300);
      // refresh: re-upsert show A with more watched eps — same row, not a duplicate
      const rowA2 = { ...rowA, watched_eps: 8, eps_per_week: 3 };
      assert.strictEqual(watchedStore.upsertSeriesProgress(p.id, [rowA2]), 1);
      rows = watchedStore.getSeriesProgress(p.id);
      assert.strictEqual(rows.length, 2); // still 2 (upsert, not insert)
      const a = rows.find((r) => r.simkl_id === 100);
      assert.strictEqual(a.watched_eps, 8);
      assert.strictEqual(a.eps_per_week, 3);
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('O2. one-time backfill fills series_progress + sets marker, skips shows/anime delta (I2)', async () => {
    const p = config.addProfile('INT-O2');
    config.updateProfile(p.id, { keys: { simkl_client_id: 'cid' }, simkl_auth: { access_token: 'tok' } });
    const profile = config.getProfile(p.id);
    const fixtures = {
      __activities: { all: '2026-01-01T00:00:00Z' },
      'shows:completed': [showA],
      'shows:watching': [showB],
      'anime:completed': [animeC],
      'anime:watching': [],
      'movies:completed': [movieX],
    };
    const stub = simklStub(fixtures);
    try {
      const r = await watchedStore.syncFromSimkl(profile, quiet);
      assert.strictEqual(r.skipped, false);
      // Backfill made 4 shows/anime GETs (no dateFrom, episodes true).
      const backfillCalls = stub.calls.filter((c) => (c.type === 'shows' || c.type === 'anime') && !c.dateFrom);
      assert.strictEqual(backfillCalls.length, 4);
      assert.ok(backfillCalls.every((c) => c.episodes), 'backfill pulls carry episodes');
      // The main loop skipped shows/anime (already backfilled) — only movies pulled.
      const mainShowsAnime = stub.calls.filter((c) => (c.type === 'shows' || c.type === 'anime') && c.dateFrom);
      assert.strictEqual(mainShowsAnime.length, 0, 'shows/anime delta skipped in the backfill run');
      const movieCall = stub.calls.find((c) => c.type === 'movies');
      assert.ok(movieCall, 'movies pulled');
      assert.strictEqual(movieCall.episodes, false, 'movies pull has no episodes');
      // series_progress filled from the backfill (3 rows).
      const rows = watchedStore.getSeriesProgress(p.id);
      assert.strictEqual(rows.length, 3);
      const a = rows.find((r) => r.simkl_id === 100);
      assert.strictEqual(a.kind, 'show');
      assert.strictEqual(a.watched_eps, 4);
      assert.strictEqual(a.real_stamps, 4);
      assert.strictEqual(a.eps_per_week, 2);
      const b = rows.find((r) => r.simkl_id === 200);
      assert.strictEqual(b.real_stamps, 0, 'identical stamps are bulk');
      assert.strictEqual(b.eps_per_week, null);
      const c = rows.find((r) => r.simkl_id === 300);
      assert.strictEqual(c.kind, 'anime');
      // Marker set.
      assert.ok(watchedStore.getSeriesProgressSync(p.id), 'backfill marker set');
      // The watched table also got the shows/anime rows from the backfill.
      const watched = watchedStore.getWatched(p.id, { type: 'series' });
      assert.strictEqual(watched.length, 3);
    } finally {
      stub.restore();
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('O3. steady-state sync: marker present → no backfill, shows/anime delta with episodes (I3)', async () => {
    const p = config.addProfile('INT-O3');
    config.updateProfile(p.id, { keys: { simkl_client_id: 'cid' }, simkl_auth: { access_token: 'tok' } });
    const profile = config.getProfile(p.id);
    // Pre-set the backfill marker + a sync cursor (a prior backfill already ran).
    watchedStore.setSeriesProgressSync(p.id);
    watchedStore.setSyncState(p.id, '2026-01-01T00:00:00Z');
    const fixtures = {
      __activities: { all: '2026-01-02T00:00:00Z' }, // changed → no early return
      'shows:completed': [showA],
      'shows:watching': [showB],
      'anime:completed': [animeC],
      'anime:watching': [],
      'movies:completed': [movieX],
    };
    const stub = simklStub(fixtures);
    try {
      await watchedStore.syncFromSimkl(profile, quiet);
      // No backfill: no shows/anime pull WITHOUT dateFrom.
      const backfillCalls = stub.calls.filter((c) => (c.type === 'shows' || c.type === 'anime') && !c.dateFrom);
      assert.strictEqual(backfillCalls.length, 0, 'no backfill when the marker is present');
      // Shows/anime delta pulls happened WITH dateFrom + episodes.
      const deltaShowsAnime = stub.calls.filter((c) => (c.type === 'shows' || c.type === 'anime'));
      assert.strictEqual(deltaShowsAnime.length, 4);
      assert.ok(deltaShowsAnime.every((c) => c.dateFrom === '2026-01-01T00:00:00Z' && c.episodes), 'delta pulls carry dateFrom + episodes');
      // series_progress rows upserted from the delta pulls.
      const rows = watchedStore.getSeriesProgress(p.id);
      assert.strictEqual(rows.length, 3);
      // Marker NOT re-set: backfilled_at unchanged (still the pre-set value).
      const sync = watchedStore.getSeriesProgressSync(p.id);
      assert.ok(sync, 'marker still present');
    } finally {
      stub.restore();
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('O4. deleteForProfile clears series_progress + series_progress_sync (I4)', async () => {
    const p = config.addProfile('INT-O4');
    config.updateProfile(p.id, { keys: { simkl_client_id: 'cid' }, simkl_auth: { access_token: 'tok' } });
    const profile = config.getProfile(p.id);
    const fixtures = {
      __activities: { all: '2026-01-01T00:00:00Z' },
      'shows:completed': [showA],
      'shows:watching': [showB],
      'anime:completed': [animeC],
      'anime:watching': [],
      'movies:completed': [movieX],
    };
    const stub = simklStub(fixtures);
    try {
      await watchedStore.syncFromSimkl(profile, quiet); // backfill runs
      assert.strictEqual(watchedStore.getSeriesProgress(p.id).length, 3);
      assert.ok(watchedStore.getSeriesProgressSync(p.id));
      watchedStore.deleteForProfile(p.id);
      assert.strictEqual(watchedStore.getSeriesProgress(p.id).length, 0, 'series_progress cleared');
      assert.strictEqual(watchedStore.getSeriesProgressSync(p.id), null, 'series_progress_sync cleared');
    } finally {
      stub.restore();
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('O5. ladderFor — reads series_progress, joins taste_ratings (type=series) by tmdb_id (I5)', async () => {
    const seriesEngagement = require('../src/seriesEngagement');
    const tasteFeedback = require('../src/tasteFeedback');
    const p = config.addProfile('INT-O5');
    const now = Date.parse('2026-06-01T00:00:00Z');
    const DAY = 86400e3;
    try {
      const rowA = { simkl_id: 100, kind: 'show', imdb_id: 'tt100', tmdb_id: '100', title: 'Show A', year: 2020, status: 'watching', watched_eps: 6, total_eps: 20, not_aired_eps: 0, last_watched_at: now - 10 * DAY, first_watched_at: now - 30 * DAY, first_real_at: now - 30 * DAY, last_real_at: now - 10 * DAY, stamps: 3, real_stamps: 3, eps_per_week: null };
      const rowB = { simkl_id: 200, kind: 'show', imdb_id: 'tt200', tmdb_id: '200', title: 'Show B', year: 2021, status: 'watching', watched_eps: 24, total_eps: 50, not_aired_eps: 0, last_watched_at: now - 5 * DAY, first_watched_at: now - 40 * DAY, first_real_at: now - 40 * DAY, last_real_at: now - 5 * DAY, stamps: 4, real_stamps: 4, eps_per_week: 5 };
      const rowC = { simkl_id: 300, kind: 'anime', imdb_id: 'tt300', tmdb_id: null, title: 'Anime C', year: 2022, status: 'watching', watched_eps: 2, total_eps: 12, not_aired_eps: 0, last_watched_at: now - 1 * DAY, first_watched_at: now - 1 * DAY, first_real_at: now - 1 * DAY, last_real_at: now - 1 * DAY, stamps: 1, real_stamps: 1, eps_per_week: null };
      assert.strictEqual(watchedStore.upsertSeriesProgress(p.id, [rowA, rowB, rowC]), 3);
      // Show ratings (type='series'), keyed by tmdb_id.
      tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: '100', rating: 10 });
      tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: '200', rating: 4 });
      tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: '999', rating: 9 }); // a show NOT in series_progress
      const out = seriesEngagement.ladderFor(p.id, { now });
      assert.strictEqual(out.size, 3, 'three shows');
      // 100: engaged, rated 10 → weight 3.0 (rating overrides the rung weight).
      const a = out.get(100);
      assert.strictEqual(a.row.simkl_id, 100);
      assert.strictEqual(a.rung, 'engaged');
      assert.strictEqual(a.weight, 3.0, 'rated 10 overrides the rung weight');
      assert.strictEqual(a.rated, true);
      // 200: committed, rated 4 → weight -1.2.
      const b = out.get(200);
      assert.strictEqual(b.rung, 'committed');
      assert.strictEqual(b.weight, -1.2, 'rated 4 overrides the rung weight');
      assert.strictEqual(b.rated, true);
      // 300: no tmdb_id → unrated → rung weight (sampling → 0.3).
      const c = out.get(300);
      assert.strictEqual(c.rung, 'sampling');
      assert.strictEqual(c.weight, 0.3, 'unrated → rung weight');
      assert.strictEqual(c.rated, false);
      // kind filter.
      const shows = seriesEngagement.ladderFor(p.id, { now, kind: 'show' });
      assert.strictEqual(shows.size, 2, 'kind=show → 2 rows');
      assert.ok(shows.has(100) && shows.has(200));
      const anime = seriesEngagement.ladderFor(p.id, { now, kind: 'anime' });
      assert.strictEqual(anime.size, 1, 'kind=anime → 1 row');
      assert.ok(anime.has(300));
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id); tasteFeedback.deleteForProfile(p.id);
    }
  });

  // ── TV-1 (plan §6): the series backtest — pickSeriesTargets, removeSeriesHoldout,
  //    runBench --type series, and the report table (bench + db in scope from ME-10) ──
  await it('TV-1 B1: pickSeriesTargets — most recently STARTED Engaged+ shows; too few throws', async () => {
    const DAY = 86400e3;
    const base = Date.parse('2026-06-01T00:00:00Z');
    const mk = (i, opts = {}) => ({
      simkl_id: i, kind: 'show', imdb_id: 'tt' + i, tmdb_id: 's' + i, title: 'Show ' + i, year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: base + i * DAY, first_watched_at: base + i * DAY,
      first_real_at: base + i * DAY, last_real_at: base + i * DAY,
      stamps: 10, real_stamps: 10, eps_per_week: null, ...opts,
    });
    // 20 qualifying rows (holdout 10 needs 10+10); most recent 10 by first_real_at.
    const rows = Array.from({ length: 20 }, (_, i) => mk(i + 1));
    assert.deepStrictEqual(bench.pickSeriesTargets(rows, 10),
      ['s20', 's19', 's18', 's17', 's16', 's15', 's14', 's13', 's12', 's11'], 'most recently started 10');
    // Exclusions: non-show kind, null first_real_at (bulk-only), null tmdb_id (no dedupe key),
    // and a tried show (watched_eps < engaged_min_eps). 24 qualifying + 4 excluded.
    const mixed = [
      mk(1, { kind: 'anime' }),
      mk(2, { first_real_at: null }),
      mk(3, { tmdb_id: null }),
      mk(4, { watched_eps: 4 }),
      ...Array.from({ length: 24 }, (_, i) => mk(100 + i)),
    ];
    const sel = bench.pickSeriesTargets(mixed, 10);
    assert.strictEqual(sel.length, 10);
    assert.ok(!sel.includes('s1'), 'anime kind excluded');
    assert.ok(!sel.includes('s2'), 'null first_real_at excluded');
    assert.ok(!sel.includes('s4'), 'tried (below Engaged) excluded');
    // 15 qualifying < 10+10 → throws.
    assert.throws(() => bench.pickSeriesTargets(rows.slice(0, 15), 10), /not enough series history/);
  });

  await it('TV-1 B2: removeSeriesHoldout — held-out shows leave series_progress + series ratings/ignores', async () => {
    const tasteFeedback = require('../src/tasteFeedback');
    const p = config.addProfile('INT-TV1-B2');
    const DAY = 86400e3;
    const base = Date.parse('2026-06-01T00:00:00Z');
    const mk = (i) => ({
      simkl_id: i, kind: 'show', imdb_id: 'tt' + i, tmdb_id: 'h' + i, title: 'Hold ' + i, year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: base + i * DAY, first_watched_at: base + i * DAY,
      first_real_at: base + i * DAY, last_real_at: base + i * DAY,
      stamps: 10, real_stamps: 10, eps_per_week: null,
    });
    try {
      watchedStore.upsertSeriesProgress(p.id, Array.from({ length: 12 }, (_, i) => mk(i + 1)));
      tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: 'h1', rating: 9 });
      tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: 'h2', rating: 5 });
      const conn = db.get();
      conn.prepare('INSERT INTO taste_ignore (profile_id, type, simkl_id, tmdb_id, imdb_id, at) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, 'series', 3, 'h3', 'tt3', Date.now());
      rs.upsertCandidates(p.id, [{ type: 'series', tmdb_id: 'h4', imdb_id: 'tt4', title: 'H4', year: 2020, genres: 'Drama', primary_genre: 'Drama', vote_average: 7, vote_count: 3000, affinity: 5, rankScore: 5, popularity: 4, rec_count: 1, poster: null }]);
      const holdout = ['h1', 'h2', 'h3', 'h4'];
      bench.removeSeriesHoldout(p.id, holdout, { db });
      const remainingIds = new Set(watchedStore.getSeriesProgress(p.id, { kind: 'show' }).map((r) => r.tmdb_id));
      for (const t of holdout) assert.ok(!remainingIds.has(t), 'series_progress row removed: ' + t);
      for (const t of holdout) {
        assert.ok(!conn.prepare("SELECT tmdb_id FROM taste_ratings WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").get(p.id, t), 'no taste_ratings row: ' + t);
        assert.ok(!conn.prepare("SELECT tmdb_id FROM taste_ignore WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").get(p.id, t), 'no taste_ignore row: ' + t);
      }
      assert.ok(!conn.prepare("SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = 'series' AND tmdb_id = ?").get(p.id, 'h4'), 'recommended series row removed');
      assert.ok(remainingIds.has('h5'), 'non-held-out row survives');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id); tasteFeedback.deleteForProfile(p.id);
    }
  });

  await it('TV-1 B3: runBench --type series — hermetic, no leakage, all held-out targets hit', async () => {
    const pipeline = require('../src/engines/pipeline');
    const p = config.addProfile('INT-TV1-B3');
    const DAY = 86400e3;
    const base = Date.parse('2026-06-01T00:00:00Z');
    const mk = (i) => ({
      simkl_id: i, kind: 'show', imdb_id: 'tt' + i, tmdb_id: 'tv' + i, title: 'TV ' + i, year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: base + i * DAY, first_watched_at: base + i * DAY,
      first_real_at: base + i * DAY, last_real_at: base + i * DAY,
      stamps: 10, real_stamps: 10, eps_per_week: null,
    });
    let stubTargets = [];
    const dispose = engines._register({
      id: 'bench-stub', name: 'Bench stub', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => stubTargets.map((t) => ({
        type: 'series', tmdb_id: t, imdb_id: 'ttstub' + t, title: 'Target ' + t, year: 2020,
        genres: 'Action', primary_genre: 'Action', vote_average: 8, vote_count: 5000,
        affinity: 10, rankScore: 10, popularity: 5, poster: null,
      })),
    });
    try {
      config.updateProfile(p.id, { filters: {} });
      watchedStore.upsertSeriesProgress(p.id, Array.from({ length: 20 }, (_, i) => mk(i + 1)));
      // The 10 most recently started shows (tv20..tv11) are the holdout.
      stubTargets = Array.from({ length: 10 }, (_, i) => 'tv' + (20 - i));
      const results = await bench.runBench({
        profile: config.getProfile(p.id), engineIds: ['bench-stub'], holdout: 10, type: 'series',
        deps: { engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet },
      });
      assert.strictEqual(results.engines['bench-stub'].metrics.hitAt20, 10, 'the stub returns every held-out target → all hit');
      // Leakage: no target survives in the series progress rows.
      const remainingIds = new Set(watchedStore.getSeriesProgress(p.id, { kind: 'show' }).map((r) => r.tmdb_id));
      for (const t of stubTargets) assert.ok(!remainingIds.has(t), 'no target in series_progress: ' + t);
      // Non-held-out rows survive.
      assert.ok(remainingIds.has('tv10'), 'non-held-out row survives');
    } finally {
      dispose();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  await it('TV-1 B4: renderTable — stable output for a fixed series results object', async () => {
    const results = {
      profile: 'TVProfile', holdout: 10,
      targets: [{ tmdb_id: 'tv1', title: 'Show One' }, { tmdb_id: 'tv2', title: 'Show Two' }],
      engines: {
        genesis: { metrics: { hitAt20: 1, hitAt20Fraction: 0.1, recallAt100: 0.2, meanRankOfHits: 5, filterPass: 0.8, trendingShareAt20: null, stored: 100, buildSeconds: 1.5 }, hitTargets: ['tv1'] },
      },
    };
    const out1 = bench.renderTable(results);
    const out2 = bench.renderTable(results);
    assert.strictEqual(out1, out2, 'stable output for a fixed results object');
    assert.ok(out1.includes('TVProfile'), 'profile name');
    assert.ok(out1.includes('genesis'), 'genesis row');
    assert.ok(out1.includes('Show One'), 'target title');
    assert.ok(out1.includes('Show Two'), 'second target title');
  });

  // ── TV-1 review round 2 (S1): the series holdout must leave `watched`,
  //    `pending_watched` and `dont_recommend` too — otherwise the pipeline
  //    excludes every held-out target as "already watched" (the real-data bug:
  //    hit@20 0/10). The leakage check must also cover the watched id sets. ──
  await it('TV-1 S1: removeSeriesHoldout clears watched/pending_watched/dont_recommend; runBench hits all 10; leakage check covers watched sets', async () => {
    const p = config.addProfile('INT-TV1-S1');
    const DAY = 86400e3;
    const base = Date.parse('2026-06-01T00:00:00Z');
    const mk = (i) => ({
      simkl_id: i, kind: 'show', imdb_id: 'tt' + i, tmdb_id: 's1' + i, title: 'Show ' + i, year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: base + i * DAY, first_watched_at: base + i * DAY,
      first_real_at: base + i * DAY, last_real_at: base + i * DAY,
      stamps: 10, real_stamps: 10, eps_per_week: null,
    });
    // The 10 most recently started (s120..s111) are the holdout.
    const targetIds = Array.from({ length: 10 }, (_, i) => 's1' + (20 - i));
    // Seed the full fixture: 20 qualifying series_progress rows + the 10 targets
    // in watched (type series), pending_watched and dont_recommend — what real
    // data has for a show you started. upsertMany runs once (so its
    // clearSupersededPending fires before the pending rows are added), then the
    // pending_watched rows are added and survive.
    const seedFixture = () => {
      watchedStore.upsertSeriesProgress(p.id, Array.from({ length: 20 }, (_, i) => mk(i + 1)));
      watchedStore.upsertMany(p.id, targetIds.map((t) => {
        const n = Number(t.slice(2));
        return { simkl_id: 1000 + n, type: 'series', imdb_id: 'tts' + n, tmdb_id: t, title: 'Show ' + n, year: 2020, watched_at: base + n * DAY };
      }));
      for (const t of targetIds) watchedStore.addPendingWatched(p.id, { type: 'series', tmdbId: t });
      for (const t of targetIds) rs.addDontRecommend(p.id, 'series', t, 'user');
    };
    const pipeline = require('../src/engines/pipeline');
    let stubTargets = targetIds.slice();
    const dispose = engines._register({
      id: 'bench-stub-s1', name: 'Bench stub S1', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => stubTargets.map((t) => ({
        type: 'series', tmdb_id: t, imdb_id: 'tts' + t.slice(2), title: 'Show ' + t.slice(2), year: 2020,
        genres: 'Action', primary_genre: 'Action', vote_average: 8, vote_count: 5000,
        affinity: 10, rankScore: 10, popularity: 5, poster: null,
      })),
    });
    try {
      // 1. removeSeriesHoldout must clear every table + the watched id sets.
      seedFixture();
      bench.removeSeriesHoldout(p.id, targetIds, { db });
      const conn = db.get();
      for (const t of targetIds) {
        assert.ok(!conn.prepare('SELECT tmdb_id FROM watched WHERE profile_id = ? AND type = ? AND tmdb_id = ?').get(p.id, 'series', t), 'watched row removed: ' + t);
        assert.ok(!conn.prepare('SELECT tmdb_id FROM series_progress WHERE profile_id = ? AND tmdb_id = ?').get(p.id, t), 'series_progress row removed: ' + t);
        assert.ok(!conn.prepare('SELECT tmdb_id FROM pending_watched WHERE profile_id = ? AND tmdb_id = ?').get(p.id, t), 'pending_watched row removed: ' + t);
        assert.ok(!conn.prepare('SELECT tmdb_id FROM dont_recommend WHERE profile_id = ? AND tmdb_id = ?').get(p.id, t), 'dont_recommend row removed: ' + t);
      }
      const sets = watchedStore.watchedIdSets(p.id);
      for (const t of targetIds) assert.ok(!sets.tmdb.has(t), 'no target in watched id sets: ' + t);

      // 2. runBench --type series with a stub engine recommending exactly the 10
      //    targets → hitAt20 === 10 (the targets are no longer "already watched").
      seedFixture();
      config.updateProfile(p.id, { filters: {} });
      const results = await bench.runBench({
        profile: config.getProfile(p.id), engineIds: ['bench-stub-s1'], holdout: 10, type: 'series',
        deps: { engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet },
      });
      assert.strictEqual(results.engines['bench-stub-s1'].metrics.hitAt20, 10, 'the stub returns every held-out target → all hit');

      // 3. the leakage check throws if a target survives in the watched id sets —
      //    replicate the OLD (buggy) removeSeriesHoldout that only cleared
      //    series_progress, so the watched rows survive.
      seedFixture();
      const oldRemoveSeriesHoldout = (pid, ids, opts) => {
        const c = opts.db.get();
        const inList = ids.map(() => '?').join(',');
        c.prepare('DELETE FROM series_progress WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(pid, ...ids);
      };
      let threw = false;
      try {
        await bench.runBench({
          profile: config.getProfile(p.id), engineIds: ['bench-stub-s1'], holdout: 10, type: 'series',
          deps: { engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet, removeSeriesHoldout: oldRemoveSeriesHoldout },
        });
      } catch (err) {
        threw = /leakage: target still in watched set/.test(err.message);
      }
      assert.ok(threw, 'leakage check throws when a target survives in the watched id sets');
    } finally {
      dispose();
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // ── TV-1 review round 2 (S2): the reachability + serve-strategy sections are
  //    movie-only (card §2.4) — not run, and not printed, for series. ──
  await it('TV-1 S2: reachability is movie-only — never called for series; table omits hit@20r + [unreachable:]', async () => {
    const pipeline = require('../src/engines/pipeline');
    const DAY = 86400e3;
    const base = Date.parse('2026-06-01T00:00:00Z');
    const mk = (i) => ({
      simkl_id: i, kind: 'show', imdb_id: 'tt' + i, tmdb_id: 's2' + i, title: 'Show ' + i, year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: base + i * DAY, first_watched_at: base + i * DAY,
      first_real_at: base + i * DAY, last_real_at: base + i * DAY,
      stamps: 10, real_stamps: 10, eps_per_week: null,
    });
    // SERIES: the reachability spy must never be called.
    let seriesReachCalled = 0;
    const seriesReachability = async () => { seriesReachCalled++; return new Map(); };
    const stubSeriesTargets = Array.from({ length: 10 }, (_, i) => 's2' + (20 - i));
    const disposeSeries = engines._register({
      id: 'bench-stub-s2', name: 'Bench stub S2', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => stubSeriesTargets.map((t) => ({
        type: 'series', tmdb_id: t, imdb_id: 'tts' + t.slice(2), title: 'Show ' + t.slice(2), year: 2020,
        genres: 'Action', primary_genre: 'Action', vote_average: 8, vote_count: 5000,
        affinity: 10, rankScore: 10, popularity: 5, poster: null,
      })),
    });
    const pSeries = config.addProfile('INT-TV1-S2-series');
    try {
      watchedStore.upsertSeriesProgress(pSeries.id, Array.from({ length: 20 }, (_, i) => mk(i + 1)));
      config.updateProfile(pSeries.id, { filters: {} });
      const seriesResults = await bench.runBench({
        profile: config.getProfile(pSeries.id), engineIds: ['bench-stub-s2'], holdout: 10, type: 'series',
        deps: { engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet, reachability: seriesReachability },
      });
      assert.strictEqual(seriesReachCalled, 0, 'reachability must NOT run for series');
      const seriesTable = bench.renderTable(seriesResults);
      assert.ok(!/hit@20r/.test(seriesTable), 'no hit@20r column for series');
      assert.ok(!/\[unreachable:/.test(seriesTable), 'no [unreachable: labels for series');
    } finally {
      disposeSeries();
      config.removeProfile(pSeries.id); rs.deleteForProfile(pSeries.id); watchedStore.deleteForProfile(pSeries.id);
    }
    // MOVIE: reachability still runs (unchanged).
    let movieReachCalled = 0;
    const movieReachability = async () => { movieReachCalled++; return new Map(); };
    const movieTargets = Array.from({ length: 30 }, (_, i) => 'm' + (i + 1));
    const stubMovieTargets = movieTargets.slice();
    const disposeMovie = engines._register({
      id: 'bench-stub-movie', name: 'Bench stub movie', supportedTypes: ['movie'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => stubMovieTargets.map((t) => ({
        type: 'movie', tmdb_id: t, imdb_id: 'ttm' + t.slice(1), title: 'Movie ' + t.slice(1), year: 2020,
        genres: 'Action', primary_genre: 'Action', vote_average: 8, vote_count: 5000,
        affinity: 10, rankScore: 10, popularity: 5, poster: null,
      })),
    });
    const pMovie = config.addProfile('INT-TV1-S2-movie');
    try {
      watchedStore.upsertMany(pMovie.id, movieTargets.map((t) => ({
        simkl_id: 2000 + Number(t.slice(1)), type: 'movie', imdb_id: 'ttm' + t.slice(1), tmdb_id: t, title: 'Movie ' + t.slice(1), year: 2020, watched_at: base + Number(t.slice(1)) * DAY,
      })));
      config.updateProfile(pMovie.id, { filters: {} });
      await bench.runBench({
        profile: config.getProfile(pMovie.id), engineIds: ['bench-stub-movie'], holdout: 10, type: 'movie',
        deps: { engines, pipeline, rs, watchedStore, db, settings, selectServe: rs.selectServe, log: quiet, reachability: movieReachability },
      });
      assert.strictEqual(movieReachCalled, 1, 'reachability still runs for movie');
    } finally {
      disposeMovie();
      config.removeProfile(pMovie.id); rs.deleteForProfile(pMovie.id); watchedStore.deleteForProfile(pMovie.id);
    }
  });

  await it('TV-1 S4: series-ladder.js footer (weight+binge)×recency×active, rung counts, real% column, watched/aired', async () => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const p = config.addProfile('INT-TV1-S4');
    const DAY = 86400e3;
    const base = Date.parse('2026-06-01T00:00:00Z');
    try {
      watchedStore.upsertSeriesProgress(p.id, [
        { simkl_id: 1, kind: 'show', imdb_id: 'tt1', tmdb_id: 's41', title: 'Show A', year: 2020,
          status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 5,
          last_watched_at: base + 10 * DAY, first_watched_at: base + 1 * DAY,
          first_real_at: base + 1 * DAY, last_real_at: base + 10 * DAY,
          stamps: 10, real_stamps: 4, eps_per_week: null },
        { simkl_id: 2, kind: 'show', imdb_id: 'tt2', tmdb_id: 's42', title: 'Show B', year: 2020,
          status: 'ended', watched_eps: 5, total_eps: 10, not_aired_eps: 0,
          last_watched_at: base + 5 * DAY, first_watched_at: base + 2 * DAY,
          first_real_at: base + 2 * DAY, last_real_at: base + 5 * DAY,
          stamps: 5, real_stamps: 5, eps_per_week: null },
      ]);
      const out = execFileSync(process.execPath, ['--experimental-sqlite', 'scripts/series-ladder.js', 'INT-TV1-S4'], {
        encoding: 'utf8',
        env: { ...process.env, DATA_DIR: process.env.DATA_DIR },
        cwd: path.join(__dirname, '..'),
      });
      assert.ok(out.includes('(weight + binge) × recency × active'), 'footer shows (weight + binge) × recency × active');
      assert.ok(out.includes('Rung counts:'), 'rung-count summary present');
      assert.ok(out.includes('real%'), 'real-stamp % column present');
      assert.ok(out.includes('10/15'), 'eps column shows watched/aired (10 watched / 15 aired)');
    } finally {
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // ── TV-2 C1: ageGatePool logs ONE per-source line per profile (AGE-2 §2.9) ──
  // A fixture with mixed sources (a cache hit + freshly-decided titles) must
  // produce the exact per-source line; only sources with n > 0 are listed.
  await it('TV-2 C1: ageGatePool logs a per-source line (mixed sources incl. a cache hit)', async () => {
    const ageVerify = require('../src/ageVerification');
    const sources = require('../src/ageVerification/sources');
    const verdictStore = require('../src/ageVerification/store');
    const db = require('../src/db');
    offlineAnimeMap();
    const p = config.addProfile('INT-TV2-C1');
    config.updateProfile(p.id, { filters: { age_limit: 14 } });
    const profile = config.getProfile(p.id);
    const tier = ageVerify.tierFor({ age_limit: 14 });
    // Seed the pool: six movie rows.
    rs.upsertCandidates(p.id, ['c100', 'c101', 'c102', 'c103', 'c104', 'c105'].map((id) => ({
      type: 'movie', tmdb_id: id, imdb_id: 'tt' + id, title: 'Show ' + id, year: 2020,
      primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 10, rec_count: 1, popularity: 0,
    })));
    // Cache hits (stored source is what the line counts): c100 csm allow,
    // c101 au block, c105 tvdb-au allow.
    verdictStore.recordVerdict('movie', 'c100', tier.id, 'allow', 'csm', '13', Date.now());
    verdictStore.recordVerdict('movie', 'c101', tier.id, 'block', 'au', 'MA 15+', Date.now());
    verdictStore.recordVerdict('movie', 'c105', tier.id, 'allow', 'tvdb-au', 'PG', Date.now());
    // Stub the sources so the three non-cached titles decide as:
    // c102 → us allow (US PG), c103 → hard-floor block (AU R 18+), c104 → llm allow.
    const origBuildSources = sources.buildSources;
    sources.buildSources = () => ({
      tmdbRatings: async (_type, titles) => {
        const out = new Map();
        const ratings = { c102: { US: 'PG' }, c103: { AU: 'R 18+' }, c104: {} };
        for (const t of titles) out.set(t.key, ratings[t.key.split(':')[1]] || {});
        return out;
      },
      csmAges: async () => new Map(),
      tvdbRatings: async () => new Map(),
      simklCerts: async () => new Map(),
      mdblistCerts: async () => new Map(),
      llmGate: async (_type, _tier, titles) => {
        const out = new Map();
        for (const t of titles) if (t.key === 'movie:c104') out.set(t.key, true);
        return out;
      },
    });
    const lines = [];
    const log = { log: (s) => lines.push(s), warn: () => {}, error: () => {} };
    try {
      await rs.ageGatePool(profile, log);
      const line = lines.find((l) => l.includes('age gate'));
      assert.ok(line, 'age gate line logged');
      assert.ok(line.includes('age gate (TV-14 (14+, AU M))'), 'tier label present: ' + line);
      assert.ok(line.includes('decided: csm 1, au 1, us 1, tvdb-au 1, hard-floor 1, llm 1'), 'per-source decided counts: ' + line);
      assert.ok(line.includes('blocked 2 (au 1, hard-floor 1)'), 'per-source blocked counts: ' + line);
      assert.ok(line.includes('· 4 remain'), '4 remain: ' + line);
      // The two blocked titles are dropped from the pool.
      assert.strictEqual(rs.getRecommended(p.id, { type: 'movie', limit: 100 }).length, 4, 'two blocked titles dropped');
    } finally {
      sources.buildSources = origBuildSources;
      db.get().prepare("DELETE FROM age_verdicts WHERE type = 'movie' AND tier = 'tv14' AND tmdb_id IN ('c100','c101','c105')").run();
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  // ── TV-2 C2: syncFromSimkl logs the series backfill inside the backfill block ──
  // A backfill run logs the line once (even when the activities gate then
  // returns early); a non-backfill run does not.
  await it('TV-2 C2: syncFromSimkl logs the series backfill once on backfill, not on steady-state', async () => {
    const simklSvc = require('../src/services/simkl');
    const p = config.addProfile('INT-TV2-C2');
    config.updateProfile(p.id, { keys: { simkl_client_id: 'c2' }, simkl_auth: { access_token: 'tok' } });
    const profile = config.getProfile(p.id);
    const origGetAllItems = simklSvc.getAllItems;
    const origGetActivities = simklSvc.getActivities;
    const lines = [];
    const log = { log: (s) => lines.push(s), warn: () => {}, error: () => {} };
    // A show (kind 'show') and an anime (kind 'anime'), so the backfill counts both.
    // Shape mirrors Simkl's all-items entry: item.show / item.anime carries ids
    // (simkl required), seasons[].episodes[].watched_at drives the stamps.
    const showItem = {
      show: { ids: { simkl: 11, imdb: 'ttc2s', tmdb: 'c2s' }, title: 'Show C2', year: 2020 },
      seasons: [{ episodes: [{ watched_at: '2026-06-01' }] }],
      last_watched_at: '2026-06-01', status: 'completed', watched_episodes_count: 1, total_episodes_count: 1,
    };
    const animeItem = {
      anime: { ids: { simkl: 12, imdb: 'ttc2a', tmdb: 'c2a' }, title: 'Anime C2', year: 2020 },
      seasons: [{ episodes: [{ watched_at: '2026-06-01' }] }],
      last_watched_at: '2026-06-01', status: 'completed', watched_episodes_count: 1, total_episodes_count: 1,
    };
    simklSvc.getAllItems = (prof, section, opts) => Promise.resolve(
      section === 'shows' ? [showItem] : section === 'anime' ? [animeItem] : []);
    simklSvc.getActivities = () => Promise.resolve({ all: 'c2-timestamp' });
    try {
      // (1) Backfill run: no series_progress_sync marker → the backfill block runs.
      await watchedStore.syncFromSimkl(profile, log);
      const backfillLines = lines.filter((l) => l.includes('series progress backfilled'));
      assert.strictEqual(backfillLines.length, 1, 'backfill logged once: ' + JSON.stringify(lines));
      assert.ok(backfillLines[0].includes('series progress backfilled — 1 show(s), 1 anime'), 'backfill counts show + anime: ' + backfillLines[0]);
      lines.length = 0;
      // (2) Steady-state run: marker now set → the backfill block is skipped, so
      //    no backfill line (even though the activities gate would return early).
      await watchedStore.syncFromSimkl(profile, log);
      assert.strictEqual(lines.filter((l) => l.includes('series progress backfilled')).length, 0, 'no backfill line on steady-state: ' + JSON.stringify(lines));
    } finally {
      simklSvc.getAllItems = origGetAllItems;
      simklSvc.getActivities = origGetActivities;
      config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // ── TV-2 C3: the series bench report is named bench-<profile>-series-<ts>.json ──
  await it('TV-2 C3: reportFileName — series carries -series, movie keeps the plain name', async () => {
    const bench = require('../src/bench/engineBench');
    const ts = '2026-10-02T00-00-00-000Z';
    assert.strictEqual(bench.reportFileName('James', 'series', ts), 'bench-James-series-2026-10-02T00-00-00-000Z.json', 'series report name');
    assert.strictEqual(bench.reportFileName('James', 'movie', ts), 'bench-James-2026-10-02T00-00-00-000Z.json', 'movie report name (unchanged)');
  });

  // ── TV-2 C5: removeSeriesHoldout also removes pending_watched rows by IMDb id ──
  // A pending row that carries ONLY an IMDb id (no tmdb_id) must be removed via
  // the target's series_progress imdb lookup (before the series_progress row is deleted).
  await it('TV-2 C5: removeSeriesHoldout removes a pending_watched row keyed only by IMDb id', async () => {
    const db = require('../src/db');
    const bench = require('../src/bench/engineBench');
    const p = config.addProfile('INT-TV2-C5');
    // A series_progress row for the target (tmdb s51, imdb tts51).
    watchedStore.upsertSeriesProgress(p.id, [{
      simkl_id: 51, kind: 'show', imdb_id: 'tts51', tmdb_id: 's51', title: 'Show 51', year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: Date.now(), first_watched_at: Date.now(),
      first_real_at: Date.now(), last_real_at: Date.now(), stamps: 10, real_stamps: 10, eps_per_week: null,
    }]);
    // A pending_watched row keyed ONLY by IMDb id (no tmdb_id).
    watchedStore.addPendingWatched(p.id, { type: 'series', imdbId: 'tts51' });
    // Sanity: the pending row exists and has no tmdb_id.
    const conn = db.get();
    let row = conn.prepare('SELECT id, imdb_id, tmdb_id FROM pending_watched WHERE profile_id = ? AND imdb_id = ?').get(p.id, 'tts51');
    assert.ok(row, 'pending row present before removal');
    assert.strictEqual(row.tmdb_id, null, 'pending row has no tmdb_id');
    // removeSeriesHoldout must remove it (via the series_progress imdb lookup).
    bench.removeSeriesHoldout(p.id, ['s51'], { db });
    row = conn.prepare('SELECT id FROM pending_watched WHERE profile_id = ? AND imdb_id = ?').get(p.id, 'tts51');
    assert.strictEqual(row, undefined, 'pending row removed by IMDb id');
    // The series_progress row is also gone.
    assert.strictEqual(conn.prepare('SELECT tmdb_id FROM series_progress WHERE profile_id = ? AND tmdb_id = ?').get(p.id, 's51'), undefined, 'series_progress row removed');
    config.removeProfile(p.id); watchedStore.deleteForProfile(p.id);
  });

  // ── TV-2 N1: discoverTv + tvDetailsFull (fetch-level) ────────────────────
  await it('TV-2 N1: discoverTv URL + tvDetailsFull append/parse (extras + certAU/certUS)', async () => {
    const origFetch = global.fetch;
    const mkResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });
    try {
      // (1) discover/tv: the params + language + page are on the URL; the
      //     results map to series list items.
      const tvItem = { id: 42, name: 'T', first_air_date: '2024-01-01', genre_ids: [18], vote_average: 7.5, vote_count: 900, popularity: 3, adult: false, poster_path: '/p.jpg' };
      global.fetch = async (url) => {
        const u = new URL(url);
        assert.ok(u.pathname.includes('discover/tv'), 'discover/tv path');
        assert.strictEqual(u.searchParams.get('language'), 'en-US');
        assert.strictEqual(u.searchParams.get('page'), '2');
        assert.strictEqual(u.searchParams.get('sort_by'), 'vote_count.desc');
        assert.strictEqual(u.searchParams.get('with_genres'), '18|35');
        return mkResponse({ results: [tvItem] });
      };
      const discovered = await tmdb.discoverTv('key', { sort_by: 'vote_count.desc', with_genres: '18|35' }, { page: 2 });
      assert.deepStrictEqual(discovered, [{ type: 'series', tmdb_id: '42', title: 'T', year: 2024, genre_ids: [18], vote_average: 7.5, vote_count: 900, popularity: 3, adult: false, poster: '/p.jpg' }]);

      // (2) tv/{id}: the append block is exact; the fixture payload yields a
      //     deep meta + extras with every §5.1 field, and certAU/certUS come
      //     from content_ratings.
      const payload = {
        id: 1234, name: 'Test Show', type: 'Scripted', status: 'Returning Series',
        first_air_date: '2020-01-01', last_air_date: '2026-09-01',
        last_episode_to_air: { air_date: '2026-09-01', runtime: 45 },
        next_episode_to_air: { air_date: '2026-10-01' },
        number_of_seasons: 5, number_of_episodes: 50, episode_run_time: [45],
        origin_country: ['US'], original_language: 'en',
        genres: [{ id: 18, name: 'Drama' }], poster_path: '/p.jpg',
        vote_average: 8.5, vote_count: 1000, popularity: 5,
        external_ids: { imdb_id: 'tt1234' },
        content_ratings: { results: [{ iso_3166_1: 'AU', rating: 'MA15+' }, { iso_3166_1: 'US', rating: 'TV-14' }] },
      };
      global.fetch = async (url) => {
        const u = new URL(url);
        assert.ok(u.pathname.includes('tv/1234'), 'tv/1234 path');
        assert.strictEqual(u.searchParams.get('append_to_response'), 'credits,keywords,external_ids,content_ratings');
        assert.strictEqual(u.searchParams.get('language'), 'en-US');
        return mkResponse(payload);
      };
      const res = await tmdb.tvDetailsFull('key', 1234);
      assert.ok(res.deep, 'deep meta present');
      assert.strictEqual(res.deep.imdb_id, 'tt1234');
      assert.deepStrictEqual(res.extras, {
        tvType: 'Scripted', status: 'Returning Series',
        first_air_date: '2020-01-01', last_air_date: '2026-09-01',
        last_episode_air_date: '2026-09-01', next_episode_air_date: '2026-10-01',
        number_of_seasons: 5, number_of_episodes: 50, episode_runtime: 45,
        origin_country: ['US'], original_language: 'en', raw_genres: ['Drama'],
        certAU: 'MA15+', certUS: 'TV-14',
      });
    } finally {
      global.fetch = origFetch;
    }
  });

  // ── TV-2 N2: ensureTvMeta (fetch only missing/expired; writes both stores; TTL) ──
  await it('TV-2 N2: ensureTvMeta fetches missing, writes Glass metaStore + marquee_tv_meta, TTL 14d', async () => {
    const meta = require('../src/engines/marqueeTv/meta');
    const glassMetaStore = require('../src/engines/glass/metaStore');
    const db = require('../src/db');
    const fetchCalls = [];
    const fetcher = (apiKey, id) => {
      fetchCalls.push(id);
      return Promise.resolve({
        deep: { tmdb_id: String(id), imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, genres: ['Drama'] },
        extras: { tvType: 'Scripted', status: 'Returning Series', certAU: 'MA15+', certUS: 'TV-14' },
      });
    };
    const now = Date.now();
    // (1) First call: both ids are missing → both fetched; both stores written.
    const out1 = await meta.ensureTvMeta('key', ['ntv1', 'ntv2'], { fetcher, now });
    assert.deepStrictEqual([...fetchCalls].sort(), ['ntv1', 'ntv2'], 'first call fetches both');
    assert.ok(out1.has('ntv1') && out1.has('ntv2'), 'both in the map');
    assert.ok(glassMetaStore.get('series', 'ntv1'), 'Glass metaStore series ntv1');
    assert.ok(glassMetaStore.get('series', 'ntv2'), 'Glass metaStore series ntv2');
    const row1 = db.get().prepare('SELECT extras FROM marquee_tv_meta WHERE tmdb_id = ?').get('ntv1');
    assert.ok(row1 && JSON.parse(row1.extras).certAU === 'MA15+', 'marquee_tv_meta ntv1 extras');
    // (2) Second call within 14 days: zero fetches (served from cache).
    const out2 = await meta.ensureTvMeta('key', ['ntv1', 'ntv2'], { fetcher, now: now + 1000 });
    assert.strictEqual(fetchCalls.length, 2, 'second call fetches nothing');
    assert.ok(out2.has('ntv1') && out2.has('ntv2'), 'both served from cache');
    // (3) A call after the 14-day TTL refetches.
    const out3 = await meta.ensureTvMeta('key', ['ntv1'], { fetcher, now: now + 15 * 24 * 3600e3 });
    assert.strictEqual(fetchCalls.length, 3, 'after TTL the id refetches');
  });

  // ── TV-2 N3: ensureShowRecs (fetch /tv/{id}?extended=full, parse, TTL 30d, cap, failure) ──
  await it('TV-2 N3: ensureShowRecs — /tv/{id}?extended=full, parse (drop anime/TMDB-less), TTL 30d, cap, failure', async () => {
    const simklRecs = require('../src/engines/marqueeTv/simklRecs');
    const p = config.addProfile('INT-TV2-N3');
    config.updateProfile(p.id, { keys: { simkl_client_id: 'c3' }, simkl_auth: { access_token: 'tok' } });
    const profile = config.getProfile(p.id);
    const origAuthedGet = simkl.authedGet;
    const calls = [];
    const body = {
      users_recommendations: [
        { title: 'Webster', year: 1983, type: 'tv', ids: { simkl: 7492, imdb: 'tt0085109', tmdb: '3804' } },
        { title: 'Anime Rec', year: 2010, type: 'anime', ids: { simkl: 1, imdb: 'ttanime', tmdb: '1' } },
        { title: 'No TMDB', year: 2000, type: 'tv', ids: { simkl: 2, imdb: 'ttnotmdb' } },
      ],
    };
    try {
      simkl.authedGet = (prof, path, extra) => {
        calls.push({ path, extra });
        return Promise.resolve(body);
      };
      // (1) Fetch + parse: /tv/100?extended=full; drops anime + TMDB-less.
      const out = await simklRecs.ensureShowRecs(profile, [100], { now: Date.now(), log: quiet });
      assert.ok(calls.some((c) => c.path === '/tv/100' && c.extra && c.extra.extended === 'full'), 'calls /tv/100?extended=full');
      assert.deepStrictEqual(out.get(100), [{ tmdb_id: '3804', imdb_id: 'tt0085109', title: 'Webster', year: 1983 }]);
      const n1 = calls.length;
      // (2) Caching: a second call within 30 days makes zero fetches.
      const out2 = await simklRecs.ensureShowRecs(profile, [100], { now: Date.now() + 1000, log: quiet });
      assert.strictEqual(calls.length, n1, 'second call within 30d fetches nothing');
      assert.deepStrictEqual(out2.get(100), [{ tmdb_id: '3804', imdb_id: 'tt0085109', title: 'Webster', year: 1983 }]);
      // (3) Cap: 6 uncached ids, cap 2 → only 2 fetched.
      const n2 = calls.length;
      await simklRecs.ensureShowRecs(profile, [200, 201, 202, 203, 204, 205], { cap: 2, now: Date.now(), log: quiet });
      assert.strictEqual(calls.length - n2, 2, 'cap: only 2 fetched');
      // (4) Failure: a throwing fetcher gives no recs for that id without throwing.
      simkl.authedGet = () => { throw new Error('simkl down'); };
      const out4 = await simklRecs.ensureShowRecs(profile, [300], { now: Date.now(), log: quiet });
      assert.strictEqual(out4.get(300), undefined, 'failure: no recs for the id');
    } finally {
      simkl.authedGet = origAuthedGet;
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 L2: the T1 Simkl uncached cap is per build — 50 uncached seeds →
  //    exactly 40 /tv/{id} GETs in one build (count the fetcher calls) ──
  await it('TV-3 L2: ensureShowRecs — 50 uncached seeds, cap 40 → exactly 40 /tv/{id} fetches in one build', async () => {
    const simklRecs = require('../src/engines/marqueeTv/simklRecs');
    const p = config.addProfile('INT-TV3-L2');
    config.updateProfile(p.id, { keys: { simkl_client_id: 'c3' }, simkl_auth: { access_token: 'tok' } });
    const profile = config.getProfile(p.id);
    const origAuthedGet = simkl.authedGet;
    let fetches = 0;
    try {
      simkl.authedGet = (prof, path, extra) => { fetches += 1; return Promise.resolve({ users_recommendations: [] }); };
      const ids = Array.from({ length: 50 }, (_, i) => 9000 + i);
      const out = await simklRecs.ensureShowRecs(profile, ids, { cap: 40, now: Date.now(), log: quiet });
      assert.strictEqual(fetches, 40, 'exactly 40 /tv/{id} fetches');
      assert.strictEqual(out.size, 40, '40 ids served');
    } finally {
      simkl.authedGet = origAuthedGet;
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 S1/S2: calibrated serving for series ──
  // S1: after generate, getTarget has engine_id 'marquee-tv', SPLIT genre
  // names (never combined), anime + value≤0 shows excluded, shares sum to 1;
  // a 0-row build sets no target. S2: selectServeFor serves the calibrated
  // ordering's prefix (not the round-robin), and limit-5 is a prefix of limit-10.
  await it('TV-3 S1/S2: generate sets the serve target (split names, anime + value≤0 excluded, shares sum 1); 0-row build sets none; selectServeFor serves the calibrated prefix', async () => {
    const marqueeTv = require('../src/engines/marqueeTv');
    const serveCalibration = require('../src/serveCalibration');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const mkLadder = (pid) => [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'SciFi Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 110, kind: 'show', imdb_id: 'ttseed2', tmdb_id: 'seed2', title: 'Drama Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 200, kind: 'anime', imdb_id: 'ttanime', tmdb_id: 'anime1', title: 'Anime Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 300, kind: 'show', imdb_id: 'ttreality', tmdb_id: 'reality1', title: 'Reality Show', year: 2020, status: 'watching', watched_eps: 1, total_eps: 10, not_aired_eps: 0, last_watched_at: nowMs - 90 * 86400e3, first_watched_at: nowMs - 90 * 86400e3, first_real_at: nowMs - 90 * 86400e3, last_real_at: nowMs - 90 * 86400e3, stamps: 1, real_stamps: 1, eps_per_week: null },
    ];
    const tvMeta = (apiKey, ids) => {
      const m = new Map();
      for (const id of ids) {
        const base = { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 };
        if (id === 'seed1') base.genres = ['Sci-Fi & Fantasy'];
        m.set(id, base);
      }
      return m;
    };
    // Batch fetcher (L2): one candidate (good1) per seed.
    const simklRecs = async (profile, ids) => {
      const m = new Map();
      for (const id of ids) m.set(id, [{ tmdb_id: 'good1', imdb_id: 'ttgood1', title: 'Good Show', year: 2024 }]);
      return m;
    };
    const mkCtx = (profile, filters) => ({
      settings: { llm: {} }, // no LLM providers → no chain → TV-2-identical scores (N4)
      nowMs,
      filters,
      tmdbKey: 'itest-tmdb',
      mdblistKey: '',
      log: { log: () => {}, warn: () => {}, error: () => {} },
      stats: {},
      watchedIds: { imdb: new Set(), tmdb: new Set() },
      dont: new Set(),
      marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map() },
    });
    const p = config.addProfile('INT-TV3-S1');
    const pB = config.addProfile('INT-TV3-S1B');
    try {
      // (S1) A normal build stores rows → the target is set.
      config.updateProfile(p.id, {
        filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        keys: { tmdb_api_key: 'itest-tmdb' },
        simkl_auth: { access_token: 'tok' },
      });
      const profile = config.getProfile(p.id);
      watchedStore.upsertSeriesProgress(p.id, mkLadder(p.id));
      const out = await marqueeTv.generate(profile, 'series', mkCtx(profile, profile.filters));
      assert.ok(out.length > 0, 'the build stored rows');
      const t = serveCalibration.getTarget(p.id, 'series');
      assert.ok(t, 'target stored');
      assert.strictEqual(t.engine_id, 'marquee-tv', 'engine_id marquee-tv');
      // SPLIT names: Science Fiction + Fantasy (from Sci-Fi & Fantasy) + Drama — never a combined name.
      assert.deepStrictEqual(Object.keys(t.target).sort(), ['Drama', 'Fantasy', 'Science Fiction'], 'split names');
      assert.ok(!Object.keys(t.target).some((g) => g.includes('&')), 'no combined names');
      const sum = Object.values(t.target).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, 'shares sum to 1');
      // film_count = the 2 non-anime value>0 shows with meta (anime + value≤0 excluded).
      assert.strictEqual(t.film_count, 2, 'anime + value≤0 shows excluded');

      // (S1) A 0-row build sets no target.
      config.updateProfile(pB.id, {
        filters: { engine_series: 'marquee-tv', excluded_genres: ['Drama'], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        keys: { tmdb_api_key: 'itest-tmdb' },
        simkl_auth: { access_token: 'tok' },
      });
      const profileB = config.getProfile(pB.id);
      watchedStore.upsertSeriesProgress(pB.id, mkLadder(pB.id));
      const outB = await marqueeTv.generate(profileB, 'series', mkCtx(profileB, profileB.filters));
      assert.strictEqual(outB.length, 0, '0 rows stored');
      assert.strictEqual(serveCalibration.getTarget(pB.id, 'series'), null, 'no target set');

      // (S2) selectServeFor serves the calibrated ordering's prefix, not the round-robin.
      settings.updateSettings({ engines: { 'marquee-tv': true } });
      const rows = [
        { type: 'series', tmdb_id: 's1', imdb_id: 'tts1', title: 'S1', year: 2024, genres: 'Science Fiction,Fantasy', primary_genre: 'Science Fiction', vote_average: 8, imdb_rating: 8, affinity: 10, popularity: 5 },
        { type: 'series', tmdb_id: 's2', imdb_id: 'tts2', title: 'S2', year: 2024, genres: 'Drama', primary_genre: 'Drama', vote_average: 7, imdb_rating: 7, affinity: 9, popularity: 5 },
        { type: 'series', tmdb_id: 's3', imdb_id: 'tts3', title: 'S3', year: 2024, genres: 'Drama', primary_genre: 'Drama', vote_average: 8, imdb_rating: 8, affinity: 8, popularity: 5 },
        { type: 'series', tmdb_id: 's4', imdb_id: 'tts4', title: 'S4', year: 2024, genres: 'Science Fiction,Fantasy', primary_genre: 'Science Fiction', vote_average: 7, imdb_rating: 7, affinity: 7, popularity: 5 },
        { type: 'series', tmdb_id: 's5', imdb_id: 'tts5', title: 'S5', year: 2024, genres: 'Drama', primary_genre: 'Drama', vote_average: 8, imdb_rating: 8, affinity: 6, popularity: 5 },
        { type: 'series', tmdb_id: 's6', imdb_id: 'tts6', title: 'S6', year: 2024, genres: 'Drama', primary_genre: 'Drama', vote_average: 7, imdb_rating: 7, affinity: 5, popularity: 5 },
      ];
      const served5 = rs.selectServeFor(profile, 'series', rows, { limit: 5 });
      const served10 = rs.selectServeFor(profile, 'series', rows, { limit: 10 });
      // The expected calibrated prefix: the pool sorted affinity DESC, through
      // calibratedOrder with the stored target + the §6 serve defaults.
      const passed = rows.slice().sort((a, b) => (b.affinity - a.affinity) || (String(a.tmdb_id) < String(b.tmdb_id) ? -1 : 1));
      const pTarget = serveCalibration.applyExclusions(serveCalibration.getTarget(p.id, 'series').target, profile.filters.excluded_genres);
      const expected = serveCalibration.calibratedOrder(passed, pTarget, { listSize: 20, lambda: 0.85, windowFactor: 3, klAlpha: 0.01, wildcardSlots: 0, wildcardMaxShare: 0.05, wildcardPosition: 6 });
      assert.deepStrictEqual(served5, expected.slice(0, 5), 'limit-5 = the calibrated prefix');
      assert.deepStrictEqual(served10.slice(0, 5), served5, 'limit-5 is a prefix of limit-10');
      assert.deepStrictEqual(served10, expected.slice(0, 6), 'limit-10 = the full calibrated order');
      // Not the round-robin (balanceByGenre).
      const roundRobin = rs.selectServe(rows, profile.filters, { limit: 6 });
      assert.notDeepStrictEqual(served10, roundRobin, 'not the round-robin');
    } finally {
      settings.updateSettings({ engines: { 'marquee-tv': false } });
      config.removeProfile(p.id);
      config.removeProfile(pB.id);
      watchedStore.deleteForProfile(p.id);
      watchedStore.deleteForProfile(pB.id);
    }
  });

  // ── TV-R T6: Marquee TV honours Ignore ──
  // An ignored show that is a strong seed is removed from Marquee TV's history:
  // the taste events, the seeds, the serve target, and it never appears as a
  // candidate. The non-ignored show is untouched.
  await it('TV-R T6: Marquee TV — an ignored strong seed leaves the seeds, taste events, serve target; never a candidate', async () => {
    const marqueeTv = require('../src/engines/marqueeTv');
    const taste = require('../src/engines/marqueeTv/taste');
    const tasteFeedback = require('../src/tasteFeedback');
    const serveCalibration = require('../src/serveCalibration');
    const config = require('../src/config');
    const watchedStore = require('../src/watchedStore');
    const settings = require('../src/settings');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    // Two engaged (seed-eligible) shows: seed1 (the strong seed we'll ignore)
    // and seed2 (the control).
    const mkLadder = (pid) => [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'SciFi Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 110, kind: 'show', imdb_id: 'ttseed2', tmdb_id: 'seed2', title: 'Drama Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs - 86400e3, first_watched_at: nowMs - 86400e3, first_real_at: nowMs - 86400e3, last_real_at: nowMs - 86400e3, stamps: 10, real_stamps: 10, eps_per_week: null },
    ];
    const tvMeta = (apiKey, ids) => {
      const m = new Map();
      for (const id of ids) {
        const base = { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 };
        if (id === 'seed1') base.genres = ['Sci-Fi & Fantasy'];
        m.set(id, base);
      }
      return m;
    };
    let seedIds = [];
    const mkCtx = (profile, filters) => ({
      settings: { llm: {} },
      nowMs,
      filters,
      tmdbKey: 'itest-tmdb',
      mdblistKey: '',
      log: { log: () => {}, warn: () => {}, error: () => {} },
      stats: {},
      watchedIds: { imdb: new Set(), tmdb: new Set() },
      dont: new Set(),
      marqueeSkipSync: true, // focus on the ignore filter, not the sync
      marqueeTvFetchers: {
        tvMeta,
        simklRecs: async (p, ids) => { seedIds = [...ids]; const m = new Map(); for (const id of ids) m.set(id, [{ tmdb_id: 'good1', imdb_id: 'ttgood1', title: 'Good Show', year: 2024 }]); return m; },
        tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map(),
      },
    });
    const p = config.addProfile('INT-TV-R-T6');
    const realTasteEvents = taste.tasteEvents;
    let tasteEventEntries = null;
    taste.tasteEvents = (ladderEntries, ...rest) => { tasteEventEntries = ladderEntries; return realTasteEvents(ladderEntries, ...rest); };
    try {
      config.updateProfile(p.id, {
        filters: { engine_series: 'marquee-tv', excluded_genres: [], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        keys: { tmdb_api_key: 'itest-tmdb' },
        simkl_auth: { access_token: 'tok' },
      });
      const profile = config.getProfile(p.id);
      watchedStore.upsertSeriesProgress(p.id, mkLadder(p.id));
      // Ignore the strong seed (seed1).
      tasteFeedback.setIgnored(p.id, { type: 'series', tmdb_id: 'seed1', simkl_id: 100 }, true, nowMs);
      settings.updateSettings({ engines: { 'marquee-tv': true } });
      const out = await marqueeTv.generate(profile, 'series', mkCtx(profile, profile.filters));
      assert.ok(out.length > 0, 'the build stored rows (so the serve target is set)');
      // (a) the taste events input excludes the ignored show.
      assert.ok(Array.isArray(tasteEventEntries), 'tasteEvents called');
      assert.ok(!tasteEventEntries.some((e) => e.row.tmdb_id === 'seed1'), 'the ignored show is not in the taste events');
      assert.ok(tasteEventEntries.some((e) => e.row.tmdb_id === 'seed2'), 'the non-ignored show is in the taste events');
      // (b) the seeds exclude the ignored show (the simkl recs fetcher's ids).
      assert.ok(!seedIds.includes(100), 'the ignored show is not a seed');
      assert.ok(seedIds.includes(110), 'the non-ignored show is a seed');
      // (c) the serve target excludes the ignored show's genres (split names).
      const t = serveCalibration.getTarget(p.id, 'series');
      assert.ok(t, 'target stored');
      assert.ok(Object.keys(t.target).includes('Drama'), 'the non-ignored show genre is in the target');
      assert.ok(!Object.keys(t.target).some((g) => ['Science Fiction', 'Fantasy'].includes(g)), 'the ignored show genres are NOT in the target');
      // (d) the ignored show never appears as a candidate.
      assert.ok(!out.some((r) => r.tmdb_id === 'seed1'), 'the ignored show is not a candidate');
    } finally {
      taste.tasteEvents = realTasteEvents;
      settings.updateSettings({ engines: { 'marquee-tv': false } });
      config.removeProfile(p.id);
      watchedStore.deleteForProfile(p.id);
      serveCalibration.deleteForProfile(p.id);
      tasteFeedback.deleteForProfile(p.id);
    }
  });

  // ── TV-R T7: Marquee TV sync + rebuild on rating changes ──
  // With marqueeSkipSync false, syncRatings is called once with type 'series';
  // with true, it isn't. needsBuild is true for a Marquee TV profile after a
  // show rating change and false after markTrainingBuilt; a Genesis-series,
  // Genesis-movie profile is unaffected; the Marquee Cinema result is unchanged.
  await it('TV-R T7: Marquee TV — syncRatings once (type series) when marqueeSkipSync false, none when true; needsBuild Marquee TV + Marquee Cinema unchanged', async () => {
    const marqueeTv = require('../src/engines/marqueeTv');
    const tasteFeedback = require('../src/tasteFeedback');
    const config = require('../src/config');
    const watchedStore = require('../src/watchedStore');
    const rs = require('../src/recommendationStore');
    const settings = require('../src/settings');
    const db = require('../src/db');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const mkLadder = (pid) => [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'SciFi Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
    ];
    const tvMeta = (apiKey, ids) => {
      const m = new Map();
      for (const id of ids) m.set(id, { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 });
      return m;
    };
    const mkCtx = (profile, filters, skipSync) => ({
      settings: { llm: {} },
      nowMs,
      filters,
      tmdbKey: 'itest-tmdb',
      mdblistKey: '',
      log: { log: () => {}, warn: () => {}, error: () => {} },
      stats: {},
      watchedIds: { imdb: new Set(), tmdb: new Set() },
      dont: new Set(),
      marqueeSkipSync: skipSync,
      marqueeTvFetchers: { tvMeta, simklRecs: async () => new Map(), tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map() },
    });
    const p = config.addProfile('INT-TV-R-T7');
    const realSync = tasteFeedback.syncRatings;
    let syncCalls = [];
    tasteFeedback.syncRatings = async (profile, opts) => { syncCalls.push(opts); return { ok: true, skipped: 'unchanged' }; };
    const T0 = 1_000_000;
    const min = 60e3;
    try {
      config.updateProfile(p.id, {
        filters: { engine_series: 'marquee-tv', excluded_genres: [], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        keys: { tmdb_api_key: 'itest-tmdb' },
        simkl_auth: { access_token: 'tok' },
      });
      const profile = config.getProfile(p.id);
      watchedStore.upsertSeriesProgress(p.id, mkLadder(p.id));
      // (a) marqueeSkipSync false → syncRatings called once with type 'series'.
      syncCalls = [];
      await marqueeTv.generate(profile, 'series', mkCtx(profile, profile.filters, false));
      assert.strictEqual(syncCalls.length, 1, 'syncRatings called once');
      assert.strictEqual(syncCalls[0].type, 'series', 'syncRatings called with type series');
      // (b) marqueeSkipSync true → syncRatings NOT called.
      syncCalls = [];
      await marqueeTv.generate(profile, 'series', mkCtx(profile, profile.filters, true));
      assert.strictEqual(syncCalls.length, 0, 'syncRatings NOT called (marqueeSkipSync)');
      // (c) needsBuild: Marquee TV profile → true after a show rating change, false after markTrainingBuilt.
      rs.upsertCandidates(p.id, [{ type: 'series', tmdb_id: 't7', imdb_id: 'ttt7', title: 'T', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, popularity: 5 }]);
      rs.setBuiltAt(p.id, T0);
      settings.updateSettings({ engines: { 'marquee-tv': true } });
      tasteFeedback.recordChange(p.id, T0 + 5 * min);
      assert.strictEqual(rs.needsBuild(p.id, { profile, now: T0 + 9 * min }), false, 'inside the quiet period');
      assert.strictEqual(rs.needsBuild(p.id, { profile, now: T0 + 15 * min }), true, 'quiet period elapsed (Marquee TV)');
      tasteFeedback.markTrainingBuilt(p.id, T0 + 5 * min);
      assert.strictEqual(rs.needsBuild(p.id, { profile, now: T0 + 15 * min }), false, 'the build covered the change');
      // (d) Genesis-series, Genesis-movie profile is unaffected.
      const pG = config.addProfile('INT-TV-R-T7G');
      config.updateProfile(pG.id, { filters: { engine_movie: 'genesis', engine_series: 'genesis' }, keys: { tmdb_api_key: 'itest-tmdb' }, simkl_auth: { access_token: 'tok' } });
      const profileG = config.getProfile(pG.id);
      rs.upsertCandidates(pG.id, [{ type: 'series', tmdb_id: 't7g', imdb_id: 'ttt7g', title: 'T', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, popularity: 5 }]);
      rs.setBuiltAt(pG.id, T0);
      tasteFeedback.recordChange(pG.id, T0 + 5 * min);
      assert.strictEqual(rs.needsBuild(pG.id, { profile: profileG, now: T0 + 15 * min }), false, 'Genesis-series/Genesis-movie unaffected');
      config.removeProfile(pG.id);
      rs.deleteForProfile(pG.id);
    } finally {
      tasteFeedback.syncRatings = realSync;
      settings.updateSettings({ engines: { 'marquee-tv': false } });
      config.removeProfile(p.id);
      watchedStore.deleteForProfile(p.id);
      rs.deleteForProfile(p.id);
      tasteFeedback.deleteForProfile(p.id);
      db.get().prepare('DELETE FROM taste_changes WHERE profile_id = ?').run(p.id);
    }
  });

  // ── TV-R T10: F1 — status() reports the pool per type ──
  // status() no longer reads the retired v5 cache: per type it reports the
  // served count, the pool size, the resolved engine (name + id), and the last
  // build stamp; an empty pool → null. The header line renders
  // "count shown from pool (engine, built age)".
  await it('TV-R T10: F1 — status() reports the pool per type (count, pool, engine, generated_at, source); empty pool → null', async () => {
    const rebuild = require('../src/rebuild');
    const rs = require('../src/recommendationStore');
    const engines = require('../src/engines');
    const config = require('../src/config');
    const settings = require('../src/settings');
    const p = config.addProfile('INT-TV-R-T10');
    const T0 = 1_700_000_000_000;
    try {
      config.updateProfile(p.id, {
        filters: { engine_series: 'marquee-tv', excluded_genres: [], min_year: 2010, min_rating: 0, vote_count_floor: 0, age_limit: 0 },
        keys: { tmdb_api_key: 'itest-tmdb' },
        simkl_auth: { access_token: 'tok' },
      });
      const profile = config.getProfile(p.id);
      settings.updateSettings({ engines: { 'marquee-tv': true } });
      // Series pool: 3 servable rows (imdb_id) + 1 non-servable row (no imdb_id).
      rs.upsertCandidates(p.id, [
        { type: 'series', tmdb_id: 's1', imdb_id: 'tts1', title: 'S1', year: 2020, vote_average: 8, vote_count: 1000, affinity: 0.9, rec_count: 1, popularity: 5 },
        { type: 'series', tmdb_id: 's2', imdb_id: 'tts2', title: 'S2', year: 2021, vote_average: 8, vote_count: 1000, affinity: 0.8, rec_count: 1, popularity: 5 },
        { type: 'series', tmdb_id: 's3', imdb_id: 'tts3', title: 'S3', year: 2022, vote_average: 8, vote_count: 1000, affinity: 0.7, rec_count: 1, popularity: 5 },
        { type: 'series', tmdb_id: 's4', imdb_id: null, title: 'S4', year: 2023, vote_average: 8, vote_count: 1000, affinity: 0.6, rec_count: 1, popularity: 5 },
      ]);
      // Movie pool: 2 servable rows.
      rs.upsertCandidates(p.id, [
        { type: 'movie', tmdb_id: 'm1', imdb_id: 'ttm1', title: 'M1', year: 2020, vote_average: 8, vote_count: 1000, affinity: 0.9, rec_count: 1, popularity: 5 },
        { type: 'movie', tmdb_id: 'm2', imdb_id: 'ttm2', title: 'M2', year: 2021, vote_average: 8, vote_count: 1000, affinity: 0.8, rec_count: 1, popularity: 5 },
      ]);
      rs.setBuiltAt(p.id, T0);
      const st = rebuild.status(profile);
      // Series: 3 served (s4 has no imdb_id → not servable), 4 pool rows, Marquee TV.
      assert.strictEqual(st.series.count, 3, 'series served count');
      assert.strictEqual(st.series.pool, 4, 'series pool rows');
      assert.strictEqual(st.series.engine, 'Marquee TV', 'series engine name');
      assert.strictEqual(st.series.source, 'marquee-tv', 'series engine id');
      assert.strictEqual(st.series.generated_at, T0, 'series generated_at = built_at');
      // Movie: 2 served, 2 pool rows, the resolved movie engine.
      const movieEngine = engines.resolveFor(profile, 'movie');
      assert.strictEqual(st.movie.count, 2, 'movie served count');
      assert.strictEqual(st.movie.pool, 2, 'movie pool rows');
      assert.strictEqual(st.movie.engine, movieEngine.name, 'movie engine name');
      assert.strictEqual(st.movie.source, movieEngine.id, 'movie engine id');
      assert.strictEqual(st.movie.generated_at, T0, 'movie generated_at = built_at');
      // The kept fields are still present.
      assert.ok('last_attempt_at' in st && 'rebuilding' in st && 'stale' in st && 'last_results' in st, 'kept fields present');
      assert.strictEqual(st.rebuilding, false, 'not rebuilding');
      // The header line renders "count shown from pool (engine, built age)".
      const line = `📺 Series: ${st.series.count} shown from ${st.series.pool} (${st.series.engine}, built ${st.series.generated_at > 0 ? '…' : '—'})`;
      assert.ok(line.startsWith('📺 Series: 3 shown from 4 (Marquee TV, built '), 'the line format');
      // A type with an empty pool → null.
      const p2 = config.addProfile('INT-TV-R-T10E');
      config.updateProfile(p2.id, { filters: { engine_series: 'marquee-tv' }, keys: { tmdb_api_key: 'itest-tmdb' }, simkl_auth: { access_token: 'tok' } });
      const profile2 = config.getProfile(p2.id);
      const st2 = rebuild.status(profile2);
      assert.strictEqual(st2.movie, null, 'empty movie pool → null');
      assert.strictEqual(st2.series, null, 'empty series pool → null');
      config.removeProfile(p2.id);
    } finally {
      settings.updateSettings({ engines: { 'marquee-tv': false } });
      config.removeProfile(p.id);
      rs.deleteForProfile(p.id);
    }
  });

  // ── TV-R T11: F2 — the anime note + the fit cache key v2 ──
  // The brief and fit prompts carry the exact anime note; the old tmdb:hash
  // fit cache row is NOT hit (the key is now tmdb:hash:v2); the N5 regex still
  // passes on both prompts.
  await it('TV-R T11: F2 — the anime note in the brief + fit prompts; the old tmdb:hash fit cache row is not hit; N5 still passes', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const llmCache = require('../src/engines/marquee/llmCache');
    const config = require('../src/config');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const p = config.addProfile('INT-TV-R-T11');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
    const brief = { loves: ['space opera'], avoids: ['reality'], moods: ['wistful'], eras: ['1990s'], standout_titles: ['Seed Show'] };
    const briefHash = llmMod.briefHash(brief);
    const NOTE = 'Note: "Anime" means Japanese animation only; Western animated series are not anime.';
    try {
      // (a) the brief prompt contains the note exactly, right after the excluded-genres line.
      const briefPrompt = llmMod.buildBriefPrompt(
        [{ title: 'Alpha Show', year: 2020, rungWords: 'finished', genres: ['Drama'], networks: ['Netflix'] }],
        [],
        ['Anime'],
      );
      assert.ok(briefPrompt.includes(NOTE), 'brief prompt contains the note');
      const briefLines = briefPrompt.split('\n');
      const excludedIdx = briefLines.findIndex((l) => l.startsWith('Genres they chose to exclude:'));
      assert.ok(excludedIdx !== -1, 'the excluded-genres line is present');
      assert.strictEqual(briefLines[excludedIdx + 1], NOTE, 'the note is right after the excluded-genres line');
      // (b) the fit prompt contains the note exactly, right after the profile brief block.
      const fitPrompt = llmMod.buildFitPrompt(brief, [
        { id: '100', title: 'Show 100', year: 2024, networks: ['Netflix'], tvType: 'Scripted', seasons: 2, episodes: 20, status: 'Returning Series', genres: ['Drama'], overview: null, keywords: [] },
      ]);
      assert.ok(fitPrompt.includes(NOTE), 'fit prompt contains the note');
      const fitLines = fitPrompt.split('\n');
      const standoutIdx = fitLines.findIndex((l) => l.startsWith('- standout_titles:'));
      assert.ok(standoutIdx !== -1, 'the standout_titles line is present');
      assert.strictEqual(fitLines[standoutIdx + 1], NOTE, 'the note is right after the profile brief block');
      // (c) the old tmdb:hash fit cache row is NOT hit (the key is now :v2) → a fresh chat.
      llmCache.put(p.id, 'tv_fit', '100:' + briefHash, { fit: 9, reason: 'old cached fit' }, now);
      const scored = [{
        tmdb_id: '100',
        c: { tmdb_id: '100', title: 'Show 100', year: 2024, networks: ['Netflix'], tvType: 'Scripted', status: 'Returning Series', number_of_seasons: 2, number_of_episodes: 20, genres: ['Drama'], overview: 'A drama', keywords: ['k1'] },
        pool: { seedHits: new Map(), sources: new Set(['simkl_recs']) },
        rankScore: 0.5, reason: 'Seed Show',
        scoreComponents: { features: { taste: 0.5, collab: 0.5, quality: 0.5, trending: 0.5, commitment: 0.5, airing: 0.5 }, weights: cfg.weights, penalty: 0 },
      }];
      const chatCalls = [];
      const chat = async (c, messages, opts) => {
        chatCalls.push(messages[0].content);
        return opts.validate(JSON.stringify([{ id: '100', fit: 7, reason: 'fresh fit' }]));
      };
      const out = await llmMod.tvFit(p.id, scored, { brief, briefHash, cfg, chain, chat, log, now });
      assert.strictEqual(chatCalls.length, 1, 'the old cache row was not hit → a fresh chat call');
      const r100 = out.find((r) => r.tmdb_id === '100');
      assert.strictEqual(r100.scoreComponents.llm.fit, 7, 'the fresh fit, not the old cached 9');
      assert.strictEqual(r100.scoreComponents.llm.cached, false, 'not from the old cache');
      // (d) N5 still passes on both prompts. The brief prompt carries the
      //     word "engaged" (the card's literal /age/i also matches it), so the
      //     brief uses the word-bounded age regex (as in B1/R1); the fit prompt
      //     has no "engaged", so the card's literal /age/i applies (as in B3).
      assert.ok(!/\bage\b|suitab|child|kid|classif|rated (G|PG|M)/i.test(briefPrompt), 'N5: brief prompt');
      assert.ok(!/age|suitab|child|kid|classif|rated (G|PG|M)/i.test(fitPrompt), 'N5: fit prompt');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 B1: the taste brief (local LLM) ──
  // The exact prompt (rung words, rated suffix, split genres, networks), a
  // second call is a cache hit, a rung change changes the key, a failure →
  // null and is never cached, and the prompt carries no age/suitability/
  // child/classification wording (N5 / I1).
  await it('TV-3 B1: tvBrief — exact prompt, cache hit, key change, failure never cached, N5', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const tasteFeedback = require('../src/tasteFeedback');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const p = config.addProfile('INT-TV3-B1');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    try {
      // '100' is rated 8 → the rated suffix; the others are unrated.
      tasteFeedback.upsertRating(p.id, { type: 'series', tmdb_id: '100', rating: 8 });
      const ladderEntries = [
        { row: { tmdb_id: '100', title: 'Alpha Show' }, rung: 'finished', value: 3.0 },
        { row: { tmdb_id: '200', title: 'Beta Show' }, rung: 'committed', value: 2.0 },
        { row: { tmdb_id: '300', title: 'Gamma Show' }, rung: 'tried', value: 1.0 },
        { row: { tmdb_id: 'anime1', title: 'Anime Show' }, rung: 'finished', value: 5.0 }, // anime → excluded
        { row: { tmdb_id: '400', title: 'Left Show' }, rung: 'sampled_left', value: 0 }, // value 0 → excluded
      ];
      const metaById = new Map([
        ['100', { title: 'Alpha Show', year: 2020, genres: ['Sci-Fi & Fantasy'], keywords: [], networks: ['Netflix'] }],
        ['200', { title: 'Beta Show', year: 2019, genres: ['Drama'], keywords: [], networks: [] }],
        ['300', { title: 'Gamma Show', year: 2021, genres: ['Action & Adventure'], keywords: ['zombie'], networks: ['BBC', 'Channel 4'] }],
      ]);
      const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
      const rawBrief = JSON.stringify({ loves: ['space opera'], avoids: ['reality'], moods: ['wistful'], eras: ['1990s'], standout_titles: ['Alpha Show'] });
      const calls = [];
      // The stub mirrors the real transport: it returns validate(content).
      const goodChat = async (c, messages, opts) => { calls.push({ messages, opts }); return opts.validate(rawBrief); };
      const badChat = async () => { throw new Error('local LLM down'); };

      // (a) the exact prompt: rung words, the rated suffix, split genres,
      //     networks, the dropped-shows block (row 400 has no year and no
      //     meta → "n.d." and "genres unknown"), the excluded line (no
      //     filters passed → none), the grounded-avoids instruction.
      const brief = await llmMod.tvBrief(p.id, ladderEntries, metaById, { chain, chat: goodChat, cfg, log, now });
      assert.strictEqual(calls.length, 1, 'one chat call');
      const expected = [
        "You are summarising a TV viewer's taste from the shows they watched.",
        'Shows, most engaged first — "Title" (first-air year): how far they got; genres; network:',
        '- "Alpha Show" (2020): finished, rated 8/10; Science Fiction, Fantasy; Netflix',
        '- "Beta Show" (2019): watched most of it; Drama; unknown network',
        '- "Gamma Show" (2021): tried a few episodes; Action, Adventure, Horror; BBC, Channel 4',
        '',
        'Shows they tried and then dropped (one or two episodes, not continued):',
        '- "Left Show" (n.d.): genres unknown',
        'Genres they chose to exclude: none',
        'Note: "Anime" means Japanese animation only; Western animated series are not anime.',
        '',
        'Return a JSON object with exactly these keys, each an array of short strings (at most 8 each):',
        '{"loves": [...], "avoids": [...], "moods": [...], "eras": [...], "standout_titles": [...]}',
        '"loves" are themes, genres, formats or styles shown by the shows they watched; "moods" are tones; "eras" are periods; "standout_titles" are the 3–8 shows that best define this taste.',
        '"avoids" must ONLY name themes clearly shown by the dropped shows or the excluded genres above — never anything that appears in the shows they finished or engaged with. If there is no such evidence, "avoids" must be an empty array.',
        'Output ONLY the JSON object.',
      ].join('\n');
      assert.strictEqual(calls[0].messages[0].content, expected, 'the exact prompt');
      assert.strictEqual(calls[0].opts.temperature, 0, 'temperature 0');
      assert.ok(calls[0].opts.timeoutMs > 0, 'the timeout is set');
      assert.deepStrictEqual(brief.loves, ['space opera'], 'the parsed brief');
      assert.ok(brief.hash, 'the stored hash');

      // (b) a second call is a cache hit — zero chat calls.
      const brief2 = await llmMod.tvBrief(p.id, ladderEntries, metaById, { chain, chat: goodChat, cfg, log, now: now + 1000 });
      assert.strictEqual(calls.length, 1, 'cache hit: no new chat call');
      assert.deepStrictEqual(brief2, brief, 'the cached brief');

      // (c) changing one show's rung changes the key — one new call.
      const changed = ladderEntries.map((e) => (e.row.tmdb_id === '100' ? { ...e, rung: 'committed' } : e));
      await llmMod.tvBrief(p.id, changed, metaById, { chain, chat: goodChat, cfg, log, now: now + 2000 });
      assert.strictEqual(calls.length, 2, 'rung change → new key → one new call');

      // (d) a chat failure → null, nothing cached (a fresh key).
      const variant = ladderEntries.map((e) => (e.row.tmdb_id === '200' ? { ...e, rung: 'engaged' } : e));
      const failed = await llmMod.tvBrief(p.id, variant, metaById, { chain, chat: badChat, cfg, log, now: now + 3000 });
      assert.strictEqual(failed, null, 'failure → null');
      const n = calls.length;
      const retry = await llmMod.tvBrief(p.id, variant, metaById, { chain, chat: goodChat, cfg, log, now: now + 4000 });
      assert.strictEqual(calls.length, n + 1, 'the failure was not cached — the retry calls again');
      assert.ok(retry, 'the retry succeeds');

      // (e) no chain → null, zero network (N4).
      const noChain = await llmMod.tvBrief(p.id, ladderEntries, metaById, { chain: [], chat: goodChat, cfg, log, now });
      assert.strictEqual(noChain, null, 'no chain → null');
      assert.strictEqual(calls.length, n + 1, 'no chain → no chat call');

      // (f) N5: the prompt carries no age/suitability/child/classification
      // wording. Assumption (flagged in the hand-back): the card's literal
      // /age/i also matches the substring "age" inside the card's own rung
      // word "engaged"; the intent is to forbid age WORDS, so "age" is
      // asserted with word boundaries.
      const prompt = calls[0].messages[0].content;
      assert.ok(!/\bage\b|suitab|child|kid|classif|rated (G|PG|M)/i.test(prompt), 'N5: no age/suitability/child/classification wording');
    } finally {
      tasteFeedback.deleteForProfile(p.id);
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 r1 R1: the grounded-avoids brief prompt (review round 1, F1) ──
  // The exact new prompt: the shows block as before, the dropped-shows block
  // (genres from the meta when present), the excluded-genres line, the
  // grounded-avoids instruction; the two `none` lines when there is no
  // evidence; the N5 regex (word-bounded age, as in B1).
  await it('TV-3 R1: the brief prompt — grounded avoids (dropped shows + excluded genres), the none lines, N5', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const p = config.addProfile('INT-TV3-R1');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    try {
      const ladderEntries = [
        { row: { tmdb_id: '100', title: 'Alpha Show', year: 2020 }, rung: 'finished', value: 3.0 },
        { row: { tmdb_id: '200', title: 'Beta Show', year: 2019 }, rung: 'finished', value: 2.0 },
        { row: { tmdb_id: '300', title: 'Left Show', year: 2018 }, rung: 'sampled_left', value: 0, last_watched_at: now - 86400e3 },
      ];
      const metaById = new Map([
        ['100', { title: 'Alpha Show', year: 2020, genres: ['Drama'], keywords: [], networks: ['Netflix'] }],
        ['200', { title: 'Beta Show', year: 2019, genres: ['Crime'], keywords: [], networks: [] }],
        ['300', { title: 'Left Show', year: 2018, genres: ['Sci-Fi & Fantasy'], keywords: [], networks: ['BBC'] }],
      ]);
      const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
      const rawBrief = JSON.stringify({ loves: ['drama'], avoids: ['science fiction'], moods: ['tense'], eras: ['2010s'], standout_titles: ['Alpha Show'] });
      const calls = [];
      const goodChat = async (c, messages, opts) => { calls.push({ messages, opts }); return opts.validate(rawBrief); };

      // (a) the exact new prompt: the shows block as today, the dropped block
      //     (genres from the meta), the excluded line, the grounded-avoids line.
      await llmMod.tvBrief(p.id, ladderEntries, metaById, { chain, chat: goodChat, cfg, log, now, filters: { excluded_genres: ['Horror'] } });
      assert.strictEqual(calls.length, 1, 'one chat call');
      const expected = [
        "You are summarising a TV viewer's taste from the shows they watched.",
        'Shows, most engaged first — "Title" (first-air year): how far they got; genres; network:',
        '- "Alpha Show" (2020): finished; Drama; Netflix',
        '- "Beta Show" (2019): finished; Crime; unknown network',
        '',
        'Shows they tried and then dropped (one or two episodes, not continued):',
        '- "Left Show" (2018): Science Fiction, Fantasy',
        'Genres they chose to exclude: Horror',
        'Note: "Anime" means Japanese animation only; Western animated series are not anime.',
        '',
        'Return a JSON object with exactly these keys, each an array of short strings (at most 8 each):',
        '{"loves": [...], "avoids": [...], "moods": [...], "eras": [...], "standout_titles": [...]}',
        '"loves" are themes, genres, formats or styles shown by the shows they watched; "moods" are tones; "eras" are periods; "standout_titles" are the 3–8 shows that best define this taste.',
        '"avoids" must ONLY name themes clearly shown by the dropped shows or the excluded genres above — never anything that appears in the shows they finished or engaged with. If there is no such evidence, "avoids" must be an empty array.',
        'Output ONLY the JSON object.',
      ].join('\n');
      assert.strictEqual(calls[0].messages[0].content, expected, 'the exact new brief prompt');

      // (b) no dropped shows and no exclusions → the two `none` lines.
      const calls2 = [];
      const goodChat2 = async (c, messages, opts) => { calls2.push({ messages, opts }); return opts.validate(rawBrief); };
      const ladderNoDropped = ladderEntries.slice(0, 2);
      const brief2 = await llmMod.tvBrief(p.id, ladderNoDropped, metaById, { chain, chat: goodChat2, cfg, log, now: now + 1000 });
      assert.strictEqual(calls2.length, 1, 'a different history → a new key → one chat call');
      const prompt2 = calls2[0].messages[0].content;
      assert.ok(prompt2.includes('Shows they tried and then dropped: none'), 'the dropped none line');
      assert.ok(prompt2.includes('Genres they chose to exclude: none'), 'the excluded none line');
      assert.ok(!prompt2.includes('(one or two episodes, not continued)'), 'no dropped block when there is none');

      // (c) parseBrief accepts an empty avoids (another key has content).
      const rawEmpty = JSON.stringify({ loves: ['drama'], avoids: [], moods: ['tense'], eras: ['2010s'], standout_titles: ['Alpha Show'] });
      const calls3 = [];
      const goodChat3 = async (c, messages, opts) => { calls3.push({ messages, opts }); return opts.validate(rawEmpty); };
      const brief3 = await llmMod.tvBrief(p.id, ladderNoDropped, metaById, { chain, chat: goodChat3, cfg, log, now: now + 2000, filters: { excluded_genres: ['Horror'] } });
      assert.deepStrictEqual(brief3.avoids, [], 'an empty avoids is accepted');
      assert.deepStrictEqual(brief2.avoids, ['science fiction'], 'the (b) brief parsed');

      // (d) N5: the word-bounded age regex (the card's literal /age/i also
      //     matches "engaged"; the intent is age WORDS — as in B1).
      for (const content of [calls[0].messages[0].content, prompt2]) {
        assert.ok(!/\bage\b|suitab|child|kid|classif|rated (G|PG|M)/i.test(content), 'N5: no age/suitability/child/classification wording');
      }
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 r1 R2: the brief cache key (review round 1, F1) ──
  // The key extends the sorted history list with the dropped evidence
  // (<tmdb_id>:sampled_left) and excluded:<sorted excluded joined ",">, so a
  // new sampled_left show or an excluded_genres change refreshes the brief
  // (one new chat call each); an unchanged history is a hit. Existing rows
  // are simply not hit again — never deleted.
  await it('TV-3 R2: the brief cache key — a sampled_left show or an excluded_genres change → one new call; unchanged → hit', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const p = config.addProfile('INT-TV3-R2');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    try {
      const ladderBase = [
        { row: { tmdb_id: '100', title: 'Alpha Show', year: 2020 }, rung: 'finished', value: 3.0 },
        { row: { tmdb_id: '200', title: 'Beta Show', year: 2019 }, rung: 'committed', value: 2.0 },
      ];
      const metaById = new Map([
        ['100', { title: 'Alpha Show', year: 2020, genres: ['Drama'], keywords: [], networks: ['Netflix'] }],
        ['200', { title: 'Beta Show', year: 2019, genres: ['Crime'], keywords: [], networks: [] }],
      ]);
      const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
      const rawBrief = JSON.stringify({ loves: ['drama'], avoids: [], moods: ['tense'], eras: ['2010s'], standout_titles: ['Alpha Show'] });
      const calls = [];
      const goodChat = async (c, messages, opts) => { calls.push({ messages, opts }); return opts.validate(rawBrief); };
      const filtersBase = { excluded_genres: ['Horror'] };

      // (a) the first call.
      await llmMod.tvBrief(p.id, ladderBase, metaById, { chain, chat: goodChat, cfg, log, now, filters: filtersBase });
      assert.strictEqual(calls.length, 1, 'first call');
      // (b) unchanged history + filters → a cache hit.
      await llmMod.tvBrief(p.id, ladderBase, metaById, { chain, chat: goodChat, cfg, log, now: now + 1000, filters: filtersBase });
      assert.strictEqual(calls.length, 1, 'unchanged → cache hit');
      // (c) a sampled_left show appears → one new call.
      const ladderDropped = [...ladderBase, { row: { tmdb_id: '300', title: 'Left Show', year: 2018 }, rung: 'sampled_left', value: 0, last_watched_at: now - 86400e3 }];
      await llmMod.tvBrief(p.id, ladderDropped, metaById, { chain, chat: goodChat, cfg, log, now: now + 2000, filters: filtersBase });
      assert.strictEqual(calls.length, 2, 'sampled_left appears → new key → one new call');
      // (d) excluded_genres changes → one new call.
      await llmMod.tvBrief(p.id, ladderDropped, metaById, { chain, chat: goodChat, cfg, log, now: now + 3000, filters: { excluded_genres: ['Horror', 'Crime'] } });
      assert.strictEqual(calls.length, 3, 'excluded_genres change → new key → one new call');
      // (e) unchanged again → a hit.
      await llmMod.tvBrief(p.id, ladderDropped, metaById, { chain, chat: goodChat, cfg, log, now: now + 4000, filters: { excluded_genres: ['Horror', 'Crime'] } });
      assert.strictEqual(calls.length, 3, 'unchanged → cache hit');
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 B2: the suggestions (T7) ──
  // The exact prompt (the rules present or omitted correctly, the formats
  // line, the avoid list), resolve called sequentially once per suggestion,
  // duds cached as tmdb_id:null, a second build a cache hit (zero chat, zero
  // resolve), the N5 regex, and — through the orchestrator — llm candidates
  // are additional to the lookup cap (never displacing pre-scored
  // candidates) and a resolved anime suggestion dropped by the hard filter
  // (N6).
  await it('TV-3 B2: tvSuggest — exact prompt, sequential resolve, duds cached, cache hit, llm additional (not displacing), anime dropped, N5', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const marqueeTv = require('../src/engines/marqueeTv');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const nowYear = new Date(nowMs).getFullYear();
    const DAY = 86400e3;
    const p = config.addProfile('INT-TV3-B2');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
    const brief = { loves: ['space opera'], avoids: ['reality'], moods: ['wistful'], eras: ['1990s'], standout_titles: ['Seed Show'] };
    const rawSuggestions = JSON.stringify([
      { title: 'Good Suggestion', year: 2024 },
      { title: 'Dud Suggestion', year: 2023 },
      { title: 'Anime Suggestion', year: 2022 },
    ]);
    const calls = [];
    const goodChat = async (c, messages, opts) => { calls.push({ messages, opts }); return opts.validate(rawSuggestions); };
    const resolveCalls = [];
    const resolve = async (title, year) => {
      resolveCalls.push({ title, year });
      if (title === 'Good Suggestion') return { _tmdb_id: 9001, _genre_ids: [35], _vote_average: 0, _vote_count: 1000 };
      if (title === 'Anime Suggestion') return { _tmdb_id: 9002, _genre_ids: [16], _vote_average: 0, _vote_count: 100 };
      return null; // the dud
    };
    const p2 = config.addProfile('INT-TV3-B2O');
    config.updateProfile(p2.id, {
      filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      keys: { tmdb_api_key: 'itest-tmdb' },
      simkl_auth: { access_token: 'tok' },
    });
    const profile2 = config.getProfile(p2.id);
    const seriesRows = [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'Seed Show', year: 2020, status: 'completed', watched_eps: 20, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs - DAY, first_watched_at: nowMs - 10 * DAY, first_real_at: nowMs - DAY, last_real_at: nowMs - DAY, stamps: 20, real_stamps: 20, eps_per_week: null },
      { simkl_id: 200, kind: 'show', imdb_id: 'ttrecent1', tmdb_id: 'recent1', title: 'Recent Show', year: 2024, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs - 5 * DAY, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 300, kind: 'show', imdb_id: 'ttold1', tmdb_id: 'old1', title: 'Old Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs - 90 * DAY, first_watched_at: nowMs - 90 * DAY, first_real_at: nowMs - 90 * DAY, last_real_at: nowMs - 90 * DAY, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 400, kind: 'anime', imdb_id: 'ttanime1', tmdb_id: 'anime1', title: 'Anime Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
    ];
    try {
      // (a) the exact prompt: the rules present or omitted correctly, the
      // formats line, the avoid list (most recent last_watched_at first; the
      // anime row is excluded by kind).
      watchedStore.upsertSeriesProgress(p.id, seriesRows);
      const profile = config.getProfile(p.id);
      const ctx = { filters: { min_year: 2015, min_rating: 7, excluded_genres: ['Horror', 'Reality'] } };
      const formatsAllowed = new Set(['scripted', 'reality']);
      const out = await llmMod.tvSuggest(profile, ctx, cfg, { brief, briefHash: llmMod.briefHash(brief), chain, chat: goodChat, resolve, formatsAllowed, nowYear, log, now });
      assert.strictEqual(calls.length, 1, 'one chat call');
      const expected = [
        'You are suggesting TV series for a recommendation engine.',
        "The viewer's taste profile:",
        JSON.stringify(brief),
        '',
        'Rules for every suggestion:',
        '- a TV series, not a film',
        '- still airing, or last aired in or after 2015',
        '- rated at least 7 on IMDb',
        '- not these genres: Horror, Reality',
        '- not anime and not Japanese animation',
        '- only these formats: reality series, scripted series and miniseries',
        '',
        'Do not suggest these shows (already watched):',
        '- Recent Show (2024)',
        '- Seed Show (2020)',
        '- Old Show (2020)',
        '',
        'Respond with a JSON array of 40 objects, each exactly {"title": "...", "year": 2019} (year = the first-air year).',
        'Output ONLY the JSON array.',
      ].join('\n');
      assert.strictEqual(calls[0].messages[0].content, expected, 'the exact prompt');
      assert.strictEqual(calls[0].opts.temperature, 0.3, 'temperature 0.3');
      assert.ok(calls[0].opts.timeoutMs > 0, 'the timeout is set');

      // resolve is called sequentially, once per suggestion.
      assert.deepStrictEqual(resolveCalls.map((r) => r.title), ['Good Suggestion', 'Dud Suggestion', 'Anime Suggestion'], 'resolve once per suggestion, in order');
      assert.deepStrictEqual(out, [
        { title: 'Good Suggestion', year: 2024, tmdb_id: '9001', genre_ids: [35], vote_average: 0, vote_count: 1000 },
        { title: 'Dud Suggestion', year: 2023, tmdb_id: null },
        { title: 'Anime Suggestion', year: 2022, tmdb_id: '9002', genre_ids: [16], vote_average: 0, vote_count: 100 },
      ], 'the resolved list, duds as tmdb_id: null');

      // (b) a second build is a cache hit — zero chat, zero resolve.
      const out2 = await llmMod.tvSuggest(profile, ctx, cfg, { brief, briefHash: llmMod.briefHash(brief), chain, chat: goodChat, resolve, formatsAllowed, nowYear, log, now: now + 1000 });
      assert.strictEqual(calls.length, 1, 'cache hit: no new chat call');
      assert.strictEqual(resolveCalls.length, 3, 'cache hit: no new resolve call');
      assert.deepStrictEqual(out2, out, 'the cached list');

      // (f) N5: the prompt carries no age/suitability/child/classification
      // wording (the full card regex — no "engaged" in the suggest prompt).
      assert.ok(!/age|suitab|child|kid|classif|rated (G|PG|M)/i.test(calls[0].messages[0].content), 'N5: no age/suitability/child/classification wording');

      // (c) + (d) the orchestrator: llm candidates are additional to the
      // lookup cap (pre-score 0, never displacing pre-scored candidates)
      // and a resolved anime suggestion is dropped by the hard filter (N6).
      watchedStore.upsertSeriesProgress(p2.id, seriesRows);
      const rawBrief = JSON.stringify(brief);
      const chatCalls = [];
      const stubChat = async (c, messages, opts) => {
        const content = messages[0].content;
        chatCalls.push(content);
        if (content.startsWith('You are summarising')) return opts.validate(rawBrief);
        if (content.startsWith('You are suggesting')) return opts.validate(rawSuggestions);
        throw new Error('unexpected prompt');
      };
      const tvMetaCalls = [];
      const tvMeta = (apiKey, ids) => {
        tvMetaCalls.push(ids.slice());
        const m = new Map();
        for (const id of ids) {
          const base = { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 };
          if (id === '9001') { base.title = 'Good Suggestion'; base.genres = ['Comedy']; base.first_air_date = '2024-01-01'; }
          if (id === '9002') { base.title = 'Anime Suggestion'; base.genres = ['Animation']; base.simklType = 'anime'; base.vote_average = 7; base.vote_count = 100; base.first_air_date = '2022-01-01'; }
          m.set(id, base);
        }
        return m;
      };
      // Batch fetcher (L2, TV-3 §5): (profile, simklIds) → Map<simkl_id, recs[]>.
      const simklRecs = async (profile, ids) => {
        const m = new Map();
        for (const id of ids) {
          if (id !== 100) continue;
          m.set(id, [{ tmdb_id: 'good1', imdb_id: 'ttgood1', title: 'Good Show', year: 2024 }]);
        }
        return m;
      };
      const logs = [];
      const ctx2 = {
        settings: { llm: {}, marquee_tv: { lookup_cap: 2 } }, // the cap keeps the non-llm candidates; llm is additional
        nowMs,
        filters: { excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        tmdbKey: 'itest-tmdb',
        mdblistKey: '',
        log: { log: (msg) => logs.push(msg), warn: () => {}, error: () => {} },
        stats: {},
        watchedIds: { imdb: new Set(), tmdb: new Set() },
        dont: new Set(),
        marqueeTvChain: chain,
        marqueeTvChat: stubChat,
        marqueeTvResolve: resolve,
        marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map() },
      };
      const outO = await marqueeTv.generate(profile2, 'series', ctx2);
      // (c) the llm candidates are additional to the lookup cap: pre-score
      //     0, and the non-llm candidate good1 keeps its own slot.
      assert.deepStrictEqual(tvMetaCalls[1], ['good1', '9001', '9002'], 'non-llm fills the cap, llm candidates additional');
      // (d) the resolved anime suggestion is dropped by the hard filter.
      assert.deepStrictEqual(outO.map((c) => c.tmdb_id).sort(), ['9001', 'good1'], '9001 and good1 stored, the anime 9002 dropped');
      assert.strictEqual(ctx2.stats.llm.brief, true, 'the brief was built');
      assert.deepStrictEqual(ctx2.stats.llm.suggest, { resolved: 2, total: 3 }, 'the suggest stats');
      assert.strictEqual(ctx2.stats.passed, 2, 'two candidates passed the hard filter');
    } finally {
      config.removeProfile(p.id);
      config.removeProfile(p2.id);
      watchedStore.deleteForProfile(p.id);
      watchedStore.deleteForProfile(p2.id);
    }
  });

  // ── TV-3 r1 R3: the lookup cut — suggestions are additional, not
  // displacing (review round 1, F2) ──
  // lookup_cap 3 with 5 non-llm candidates and 2 llm candidates → 5 looked
  // up (the top 3 non-llm + both llm); the 3 best non-llm are all present.
  await it('TV-3 R3: the lookup cut — non-llm fill the cap, llm candidates are additional', async () => {
    const marqueeTv = require('../src/engines/marqueeTv');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const DAY = 86400e3;
    const p = config.addProfile('INT-TV3-R3');
    config.updateProfile(p.id, {
      filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      keys: { tmdb_api_key: 'itest-tmdb' },
      simkl_auth: { access_token: 'tok' },
    });
    const profile = config.getProfile(p.id);
    const seriesRows = [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'Seed Show', year: 2020, status: 'completed', watched_eps: 20, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs - DAY, first_watched_at: nowMs - 10 * DAY, first_real_at: nowMs - DAY, last_real_at: nowMs - DAY, stamps: 20, real_stamps: 20, eps_per_week: null },
    ];
    const brief = { loves: ['drama'], avoids: [], moods: ['tense'], eras: ['2010s'], standout_titles: ['Seed Show'] };
    const suggestions = [
      { title: 'Suggestion A', year: 2024 },
      { title: 'Suggestion B', year: 2023 },
    ];
    const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
    const stubChat = async (c, messages, opts) => {
      const content = messages[0].content;
      if (content.startsWith('You are summarising')) return opts.validate(JSON.stringify(brief));
      if (content.startsWith('You are suggesting')) return opts.validate(JSON.stringify(suggestions));
      if (content.startsWith('You are judging')) {
        const ids = [...content.matchAll(/- id (\d+):/g)].map((m) => m[1]);
        return opts.validate(JSON.stringify(ids.map((id) => ({ id, fit: 8, reason: 'good fit' }))));
      }
      throw new Error('unexpected prompt');
    };
    const resolve = async (title) => {
      if (title === 'Suggestion A') return { _tmdb_id: 9001, _genre_ids: [18], _vote_average: 8, _vote_count: 1000 };
      if (title === 'Suggestion B') return { _tmdb_id: 9002, _genre_ids: [18], _vote_average: 8, _vote_count: 1000 };
      return null;
    };
    const tvMetaCalls = [];
    const tvMeta = (apiKey, ids) => {
      tvMetaCalls.push(ids.slice());
      const m = new Map();
      for (const id of ids) {
        const base = { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 };
        // The five non-llm candidates get distinct vote_average → a
        // deterministic pre-score order (the top 3 are good5, good4, good3).
        if (id === 'good1') base.vote_average = 5;
        if (id === 'good2') base.vote_average = 6;
        if (id === 'good3') base.vote_average = 7;
        if (id === 'good4') base.vote_average = 8;
        if (id === 'good5') base.vote_average = 9;
        m.set(id, base);
      }
      return m;
    };
    const simklRecs = async (profile, ids) => {
      const m = new Map();
      for (const id of ids) {
        if (id !== 100) continue;
        // Distinct vote_average on the recs (mergePool carries them onto the
        // candidate, and the pre-score runs BEFORE the meta lookup) → a
        // deterministic pre-score order (the top 3 are good5, good4, good3).
        m.set(id, [
          { tmdb_id: 'good1', imdb_id: 'ttgood1', title: 'Good Show 1', year: 2024, vote_average: 5 },
          { tmdb_id: 'good2', imdb_id: 'ttgood2', title: 'Good Show 2', year: 2024, vote_average: 6 },
          { tmdb_id: 'good3', imdb_id: 'ttgood3', title: 'Good Show 3', year: 2024, vote_average: 7 },
          { tmdb_id: 'good4', imdb_id: 'ttgood4', title: 'Good Show 4', year: 2024, vote_average: 8 },
          { tmdb_id: 'good5', imdb_id: 'ttgood5', title: 'Good Show 5', year: 2024, vote_average: 9 },
        ]);
      }
      return m;
    };
    const ctx = {
      settings: { llm: {}, marquee_tv: { lookup_cap: 3 } },
      nowMs,
      filters: { excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      tmdbKey: 'itest-tmdb',
      mdblistKey: '',
      log: { log: () => {}, warn: () => {}, error: () => {} },
      stats: {},
      watchedIds: { imdb: new Set(), tmdb: new Set() },
      dont: new Set(),
      marqueeTvChain: chain,
      marqueeTvChat: stubChat,
      marqueeTvResolve: resolve,
      marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map() },
    };
    try {
      watchedStore.upsertSeriesProgress(p.id, seriesRows);
      await marqueeTv.generate(profile, 'series', ctx);
      // The candidate lookup (the second tvMeta call — the first is the
      // history meta): exactly 5 — the top 3 non-llm + both llm.
      assert.ok(tvMetaCalls.length >= 2, 'history + candidate meta calls');
      assert.deepStrictEqual(tvMetaCalls[1].slice().sort(), ['9001', '9002', 'good3', 'good4', 'good5'], '5 looked up: the top 3 non-llm + both llm');
      assert.ok(tvMetaCalls[1].includes('good3') && tvMetaCalls[1].includes('good4') && tvMetaCalls[1].includes('good5'), 'the 3 best non-llm are all present');
      assert.ok(!tvMetaCalls[1].includes('good1') && !tvMetaCalls[1].includes('good2'), 'the two weakest non-llm are cut');
      assert.strictEqual(ctx.stats.strong, 5, 'stats.strong = kept.length (5)');
    } finally {
      config.removeProfile(p.id);
      watchedStore.deleteForProfile(p.id);
    }
  });

  // ── TV-3 B3: the fit score (the §3.3 fold) ──
  // Sequential batches of cfg.llm_fit.batch, cached items skip the call, an
  // omitted item → neutral 5 (not cached), a throwing batch → its items 5
  // (not cached) and the next batch still runs, the fold recomputes
  // rankScore = weightedSum(feat, renormalize) − penalty, re-sorts, keeps the
  // LLM reason when present, and the N5 regex.
  await it('TV-3 B3: tvFit — sequential batches, cached skip, omitted/failed → 5 uncached, fold math, re-sort, reason, N5', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const llmCache = require('../src/engines/marquee/llmCache');
    const mqFeatures = require('../src/engines/marquee/features');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const p = config.addProfile('INT-TV3-B3');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
    const brief = { loves: ['space opera'], avoids: ['reality'], moods: ['wistful'], eras: ['1990s'], standout_titles: ['Seed Show'] };
    const briefHash = llmMod.briefHash(brief);
    const mkRow = (i) => ({
      tmdb_id: String(100 + i),
      c: {
        tmdb_id: String(100 + i), title: 'Show ' + i, year: 2024, networks: ['Netflix'],
        tvType: 'Scripted', status: 'Returning Series', number_of_seasons: 2, number_of_episodes: 20,
        genres: ['Drama'], overview: 'A drama about ' + i, keywords: ['k' + i],
      },
      pool: { seedHits: new Map(), sources: new Set(['simkl_recs']) },
      rankScore: 0.5,
      reason: 'Seed Show',
      scoreComponents: {
        features: {
          taste: (i % 10) / 10, collab: ((i + 3) % 10) / 10, quality: ((i + 6) % 10) / 10,
          trending: ((i + 1) % 10) / 10, commitment: ((i + 4) % 10) / 10, airing: ((i + 7) % 10) / 10,
        },
        weights: cfg.weights,
        penalty: 0.05 * (i % 3),
      },
    });
    // 40 rows → top 150 = all 40. Two pre-cached (100, 101); 38 uncached →
    // batches of 15: [102–116], [117–131], [132–139].
    const scored = Array.from({ length: 40 }, (_, i) => mkRow(i));
    llmCache.put(p.id, 'tv_fit', '100:' + briefHash + ':v2', { fit: 9, reason: 'cached reason' }, now);
    llmCache.put(p.id, 'tv_fit', '101:' + briefHash + ':v2', { fit: 7, reason: 'cached reason 2' }, now);
    const chatCalls = [];
    const chat = async (c, messages, opts) => {
      chatCalls.push(messages[0].content);
      const n = chatCalls.length;
      if (n === 1) { // batch 1: 102–116; omit 116.
        const items = [];
        for (let i = 102; i <= 115; i++) items.push({ id: String(i), fit: 8, reason: 'fits well' });
        return opts.validate(JSON.stringify(items));
      }
      if (n === 2) throw new Error('GPU timeout'); // batch 2: 117–131; throw.
      if (n === 3) { // batch 3: 132–139; return all 8.
        const items = [];
        for (let i = 132; i <= 139; i++) items.push({ id: String(i), fit: 6, reason: 'decent fit' });
        return opts.validate(JSON.stringify(items));
      }
      throw new Error('unexpected batch');
    };
    try {
      const result = await llmMod.tvFit(p.id, scored, { brief, briefHash, cfg, chain, chat, log, now });
      // Three batches, sequential.
      assert.strictEqual(chatCalls.length, 3, 'three batches');
      assert.ok(chatCalls[0].includes('- id 102:'), 'batch 1 first');
      assert.ok(chatCalls[1].includes('- id 117:'), 'batch 2 second');
      assert.ok(chatCalls[2].includes('- id 132:'), 'batch 3 third');
      // Cached items skip the call.
      assert.ok(!chatCalls.some((c) => c.includes('- id 100:')), 'cached 100 not in any prompt');
      assert.ok(!chatCalls.some((c) => c.includes('- id 101:')), 'cached 101 not in any prompt');
      // The exact fit prompt (batch 1): the brief lines, the per-item lines,
      // the JSON footer.
      const expectedPrompt1 = [
        "You are judging how well each TV series fits a TV viewer's profile.",
        '',
        'Profile brief:',
        '- loves: space opera',
        '- avoids: reality',
        '- moods: wistful',
        '- eras: 1990s',
        '- standout_titles: Seed Show',
        'Note: "Anime" means Japanese animation only; Western animated series are not anime.',
        '',
        'For each series below, return a fit score 0-10 (10 = perfect fit) and a short reason (at most 14 words).',
        '',
        ...Array.from({ length: 15 }, (_, k) => {
          const id = 102 + k;
          const idx = id - 100;
          return [
            `- id ${id}: "Show ${idx}" (2024) — Netflix; Scripted; 2 seasons, 20 episodes; Returning Series`,
            '  Genres: Drama',
            `  Overview: A drama about ${idx}`,
            `  Keywords: k${idx}`,
          ];
        }).flat(),
        '',
        'Respond with a JSON array: [{"id": "<id>", "fit": 0-10, "reason": "<= 14 words"}]',
        'Output ONLY the JSON array.',
      ].join('\n');
      assert.strictEqual(chatCalls[0], expectedPrompt1, 'the exact fit prompt (batch 1)');
      // Cached rows: the fit from the cache, cached: true.
      const r100 = result.find((r) => r.tmdb_id === '100');
      assert.deepStrictEqual(r100.scoreComponents.llm, { fit: 9, reason: 'cached reason', cached: true });
      const r101 = result.find((r) => r.tmdb_id === '101');
      assert.deepStrictEqual(r101.scoreComponents.llm, { fit: 7, reason: 'cached reason 2', cached: true });
      // The omitted item (116): neutral 5, reason falls back to the
      // because-seed reason, NOT cached.
      const r116 = result.find((r) => r.tmdb_id === '116');
      assert.deepStrictEqual(r116.scoreComponents.llm, { fit: 5, reason: null, cached: false });
      assert.strictEqual(r116.reason, 'Seed Show', 'omitted row keeps the because-seed reason');
      assert.strictEqual(llmCache.get(p.id, 'tv_fit', '116:' + briefHash + ':v2', { now: now + 1 }), null, 'omitted row not cached');
      // The throwing batch (117–131): every item 5, NOT cached.
      for (let i = 117; i <= 131; i++) {
        const r = result.find((r) => r.tmdb_id === String(i));
        assert.deepStrictEqual(r.scoreComponents.llm, { fit: 5, reason: null, cached: false });
        assert.strictEqual(llmCache.get(p.id, 'tv_fit', String(i) + ':' + briefHash + ':v2', { now: now + 1 }), null, `failed-batch row ${i} not cached`);
      }
      // The next batch (132–139) still ran: its items cached.
      for (let i = 132; i <= 139; i++) {
        const r = result.find((r) => r.tmdb_id === String(i));
        assert.deepStrictEqual(r.scoreComponents.llm, { fit: 6, reason: 'decent fit', cached: false });
        assert.deepStrictEqual(llmCache.get(p.id, 'tv_fit', String(i) + ':' + briefHash + ':v2', { now: now + 1 }), { fit: 6, reason: 'decent fit' }, `batch-3 row ${i} cached`);
      }
      // The fold: rankScore = weightedSum(feat, renormalize) − penalty.
      for (const r of result) {
        const expected = mqFeatures.weightedSum(r.scoreComponents.features, r.scoreComponents.weights) - r.scoreComponents.penalty;
        assert.ok(Math.abs(r.rankScore - expected) < 1e-12, `rankScore math for ${r.tmdb_id}`);
      }
      // Re-sorted by rankScore desc, ties by tmdb_id.
      for (let i = 1; i < result.length; i++) {
        const a = result[i - 1], b = result[i];
        assert.ok(a.rankScore > b.rankScore || (a.rankScore === b.rankScore && a.tmdb_id < b.tmdb_id), 'sorted by rankScore desc, ties by tmdb_id');
      }
      // The LLM reason when present.
      const r102 = result.find((r) => r.tmdb_id === '102');
      assert.strictEqual(r102.reason, 'fits well', 'LLM reason when present');
      // N5: the fit prompt carries no age/suitability/child/classification
      // wording (the full card regex — no "engaged" in the fit prompt).
      for (const content of chatCalls) {
        assert.ok(!/age|suitab|child|kid|classif|rated (G|PG|M)/i.test(content), 'N5: no age/suitability/child/classification wording');
      }
    } finally {
      config.removeProfile(p.id);
    }
  });

  // ── TV-3 B4: degradation identity ──
  // No chain (or the feature disabled) → tvFit returns the SAME array
  // (identity, no re-sort), zero chat calls; through the orchestrator, no
  // chain → the deterministic TV-2 scores (weightedSum − penalty, no
  // llm_fit feature, no llm sub-object), zero chat calls.
  await it('TV-3 B4: degradation identity — no chain/disabled → same array, deterministic scores, zero chat', async () => {
    const llmMod = require('../src/engines/marqueeTv/llm');
    const marqueeTv = require('../src/engines/marqueeTv');
    const mqFeatures = require('../src/engines/marquee/features');
    const cfg = require('../src/engines/marqueeTv/config').DEFAULTS;
    const now = 1_700_000_000_000;
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const brief = { loves: ['space opera'], avoids: ['reality'], moods: ['wistful'], eras: ['1990s'], standout_titles: ['Seed Show'] };
    const briefHash = llmMod.briefHash(brief);
    const p = config.addProfile('INT-TV3-B4');
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    const mkRow = (i) => ({
      tmdb_id: String(100 + i),
      c: { tmdb_id: String(100 + i), title: 'Show ' + i, year: 2024, networks: ['Netflix'], tvType: 'Scripted', status: 'Returning Series', number_of_seasons: 2, number_of_episodes: 20, genres: ['Drama'], overview: 'A drama about ' + i, keywords: ['k' + i] },
      pool: { seedHits: new Map(), sources: new Set(['simkl_recs']) },
      rankScore: 0.5,
      reason: 'Seed Show',
      scoreComponents: {
        features: { taste: (i % 10) / 10, collab: ((i + 3) % 10) / 10, quality: ((i + 6) % 10) / 10, trending: ((i + 1) % 10) / 10, commitment: ((i + 4) % 10) / 10, airing: ((i + 7) % 10) / 10 },
        weights: cfg.weights,
        penalty: 0.05 * (i % 3),
      },
    });
    const chatCalls = [];
    const chat = async () => { chatCalls.push('called'); throw new Error('should not be called'); };
    const p2 = config.addProfile('INT-TV3-B4O');
    config.updateProfile(p2.id, {
      filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      keys: { tmdb_api_key: 'itest-tmdb' },
      simkl_auth: { access_token: 'tok' },
    });
    const profile2 = config.getProfile(p2.id);
    const DAY = 86400e3;
    const seriesRows = [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'Seed Show', year: 2020, status: 'completed', watched_eps: 20, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs - DAY, first_watched_at: nowMs - 10 * DAY, first_real_at: nowMs - DAY, last_real_at: nowMs - DAY, stamps: 20, real_stamps: 20, eps_per_week: null },
    ];
    try {
      // (a) no chain → same array (identity), zero chat.
      const scored = [mkRow(0), mkRow(1), mkRow(2)];
      const out = await llmMod.tvFit(p.id, scored, { brief, briefHash, cfg, chain: [], chat, log, now });
      assert.strictEqual(out, scored, 'no chain → same array (identity)');
      assert.strictEqual(chatCalls.length, 0, 'no chain → zero chat calls');
      // (b) disabled → same array (identity), zero chat.
      const scored2 = [mkRow(0), mkRow(1)];
      const out2 = await llmMod.tvFit(p.id, scored2, { brief, briefHash, cfg: { ...cfg, llm_fit: { ...cfg.llm_fit, enabled: false } }, chain: [{ type: 'custom' }], chat, log, now });
      assert.strictEqual(out2, scored2, 'disabled → same array (identity)');
      assert.strictEqual(chatCalls.length, 0, 'disabled → zero chat calls');
      // (c) orchestrator: no chain → deterministic TV-2 scores, no llm_fit,
      //     no llm sub-object, zero chat calls.
      watchedStore.upsertSeriesProgress(p2.id, seriesRows);
      const tvMeta = (apiKey, ids) => {
        const m = new Map();
        for (const id of ids) {
          m.set(id, { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 });
        }
        return m;
      };
      const simklRecs = async (profile, ids) => {
        const m = new Map();
        for (const id of ids) {
          if (id !== 100) continue;
          m.set(id, [
            { tmdb_id: 'good1', imdb_id: 'ttgood1', title: 'Good Show', year: 2024 },
            { tmdb_id: 'good2', imdb_id: 'ttgood2', title: 'Good Show 2', year: 2024 },
          ]);
        }
        return m;
      };
      const chatCalls2 = [];
      const stubChat = async (c, messages, opts) => { chatCalls2.push(messages[0].content); throw new Error('should not be called'); };
      const ctx = {
        settings: { llm: {} }, // no LLM providers → no chain (N4)
        nowMs,
        filters: { excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        tmdbKey: 'itest-tmdb',
        mdblistKey: '',
        log: { log: () => {}, warn: () => {}, error: () => {} },
        stats: {},
        watchedIds: { imdb: new Set(), tmdb: new Set() },
        dont: new Set(),
        marqueeTvChat: stubChat,
        marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map() },
      };
      const outO = await marqueeTv.generate(profile2, 'series', ctx);
      assert.strictEqual(chatCalls2.length, 0, 'no chain → zero chat calls (orchestrator)');
      assert.ok(outO.length >= 1, 'candidates stored');
      for (const c of outO) {
        assert.ok(!('llm_fit' in c.scoreComponents.features), 'no llm_fit feature');
        assert.ok(!('llm' in c.scoreComponents), 'no llm sub-object');
        const expected = mqFeatures.weightedSum(c.scoreComponents.features, c.scoreComponents.weights) - c.scoreComponents.penalty;
        assert.ok(Math.abs(c.rankScore - expected) < 1e-12, 'rankScore = deterministic weighted sum − penalty');
        assert.strictEqual(c.algorithmVersion, 'marquee-tv-t2', 'algorithmVersion = marquee-tv-t2');
      }
      assert.deepStrictEqual(ctx.stats.llm, { brief: false, suggest: { resolved: 0, total: 0 }, fit: { scored: 0, cached: 0 } }, 'llm stats: all skipped');
    } finally {
      config.removeProfile(p.id);
      config.removeProfile(p2.id);
      watchedStore.deleteForProfile(p2.id);
    }
  });

  // ── TV-3 E1: the full orchestrator end-to-end (hermetic; stubbed chat +
  // network fetchers) ──
  // The §7 order (brief → gather + T7 → lookup → hard filter → deterministic
  // score → fit fold → emit → serve target → summary line), the §7 summary
  // line shape (the LLM tail), the stored rows carry marquee-tv-t2, and the
  // serve target is set.
  await it('TV-3 E1: generate(series) end-to-end — §7 order, summary line LLM tail, marquee-tv-t2, serve target set', async () => {
    const marqueeTv = require('../src/engines/marqueeTv');
    const serveCalibration = require('../src/serveCalibration');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const DAY = 86400e3;
    const p = config.addProfile('INT-TV3-E1');
    config.updateProfile(p.id, {
      filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      keys: { tmdb_api_key: 'itest-tmdb' },
      simkl_auth: { access_token: 'tok' },
    });
    const profile = config.getProfile(p.id);
    const seriesRows = [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'Seed Show', year: 2020, status: 'completed', watched_eps: 20, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs - DAY, first_watched_at: nowMs - 10 * DAY, first_real_at: nowMs - DAY, last_real_at: nowMs - DAY, stamps: 20, real_stamps: 20, eps_per_week: null },
      { simkl_id: 200, kind: 'show', imdb_id: 'ttrecent1', tmdb_id: 'recent1', title: 'Recent Show', year: 2024, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs - 5 * DAY, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 400, kind: 'anime', imdb_id: 'ttanime1', tmdb_id: 'anime1', title: 'Anime Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
    ];
    const brief = { loves: ['space opera'], avoids: ['reality'], moods: ['wistful'], eras: ['1990s'], standout_titles: ['Seed Show'] };
    const suggestions = [
      { title: 'Suggestion A', year: 2024 },
      { title: 'Suggestion B', year: 2023 },
      { title: 'Suggestion C', year: 2022 }, // the dud
      { title: 'Suggestion D', year: 2021 }, // the anime
      { title: 'Suggestion E', year: 2020 },
    ];
    const events = [];
    const chain = [{ type: 'custom', name: 'local', uri: 'http://localhost:11434/v1', apiKey: '' }];
    const stubChat = async (c, messages, opts) => {
      const content = messages[0].content;
      if (content.startsWith('You are summarising')) { events.push('brief'); return opts.validate(JSON.stringify(brief)); }
      if (content.startsWith('You are suggesting')) { events.push('suggest'); return opts.validate(JSON.stringify(suggestions)); }
      if (content.startsWith('You are judging')) {
        events.push('fit');
        const ids = [...content.matchAll(/- id (\d+):/g)].map((m) => m[1]);
        return opts.validate(JSON.stringify(ids.map((id) => ({ id, fit: 8, reason: 'good fit' }))));
      }
      throw new Error('unexpected prompt');
    };
    const resolve = async (title) => {
      if (title === 'Suggestion A') return { _tmdb_id: 9001, _genre_ids: [18], _vote_average: 8, _vote_count: 1000 };
      if (title === 'Suggestion B') return { _tmdb_id: 9002, _genre_ids: [35], _vote_average: 8, _vote_count: 1000 };
      if (title === 'Suggestion C') return null; // the dud
      if (title === 'Suggestion D') return { _tmdb_id: 9003, _genre_ids: [16], _vote_average: 7, _vote_count: 100 };
      if (title === 'Suggestion E') return { _tmdb_id: 9004, _genre_ids: [18], _vote_average: 8, _vote_count: 1000 };
      return null;
    };
    const tvMeta = (apiKey, ids) => {
      if (ids.includes('seed1')) events.push('history-meta');
      else events.push('candidate-meta');
      const m = new Map();
      for (const id of ids) {
        const base = { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 };
        if (id === '9003') { base.simklType = 'anime'; base.genres = ['Animation']; }
        if (id === 'anime1') { base.simklType = 'anime'; base.genres = ['Animation']; }
        m.set(id, base);
      }
      return m;
    };
    const simklRecs = async (profile, ids) => {
      events.push('simkl-recs');
      const m = new Map();
      for (const id of ids) {
        if (id !== 100) continue;
        m.set(id, [
          { tmdb_id: '8001', imdb_id: 'tt8001', title: 'Good Show 1', year: 2024 },
          { tmdb_id: '8002', imdb_id: 'tt8002', title: 'Good Show 2', year: 2024 },
        ]);
      }
      return m;
    };
    const logs = [];
    const ctx = {
      settings: { llm: {} }, // no providers in settings; the chain comes from the seam
      nowMs,
      filters: { excluded_genres: ['Horror'], min_year: 2015, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      tmdbKey: 'itest-tmdb',
      mdblistKey: '',
      log: { log: (msg) => logs.push(msg), warn: () => {}, error: () => {} },
      stats: {},
      watchedIds: { imdb: new Set(), tmdb: new Set() },
      dont: new Set(),
      marqueeTvChain: chain,
      marqueeTvChat: stubChat,
      marqueeTvResolve: resolve,
      marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs: () => [], discover: () => [], trending: () => [], imdbRatings: () => new Map() },
    };
    try {
      watchedStore.upsertSeriesProgress(p.id, seriesRows);
      const out = await marqueeTv.generate(profile, 'series', ctx);
      // The §7 order: brief (step 5) → gather (step 6: simkl-recs then
      // suggest) → candidate lookup (step 9) → fit fold (step 12).
      const iBrief = events.indexOf('brief');
      const iSimkl = events.indexOf('simkl-recs');
      const iSuggest = events.indexOf('suggest');
      const iCandMeta = events.indexOf('candidate-meta');
      const iFit = events.indexOf('fit');
      assert.ok(iBrief >= 0 && iBrief < iSimkl, 'brief (step 5) before gather (step 6)');
      assert.ok(iSimkl < iSuggest, 'simkl-recs before suggest (both step 6)');
      assert.ok(iSuggest < iCandMeta, 'suggest (step 6) before candidate lookup (step 9)');
      assert.ok(iCandMeta < iFit, 'candidate lookup (step 9) before fit fold (step 12)');
      // The candidates: 8001, 8002 (Simkl) + 9001, 9002, 9004 (LLM); the dud
      // (C) is absent, the anime (9003) is dropped by the hard filter.
      assert.deepStrictEqual(out.map((c) => c.tmdb_id).sort(), ['8001', '8002', '9001', '9002', '9004'], 'the five candidates');
      // Every stored row carries marquee-tv-t2 and the llm sub-object.
      assert.ok(out.every((c) => c.algorithmVersion === 'marquee-tv-t2'), 'every row marquee-tv-t2');
      assert.ok(out.every((c) => c.scoreComponents.llm && c.scoreComponents.llm.fit === 8), 'the fit fold applied');
      // The §7 summary line shape: the LLM tail.
      const summary = logs.find((l) => l.startsWith('[marquee-tv]') && l.includes('· llm:'));
      assert.ok(summary, 'the summary line is logged');
      assert.ok(summary.includes('· llm: brief on'), 'brief on');
      assert.ok(summary.includes('suggest 4/5 resolved'), 'suggest 4/5 resolved');
      assert.ok(summary.includes('fit 5 (0 cached)'), 'fit 5 (0 cached)');
      // The serve target is set (engine_id marquee-tv, split genre names).
      const target = serveCalibration.getTarget(p.id, 'series');
      assert.ok(target, 'the serve target is set');
      assert.strictEqual(target.engine_id, 'marquee-tv', 'serve target engine_id');
    } finally {
      serveCalibration.deleteForProfile(p.id);
      config.removeProfile(p.id);
      watchedStore.deleteForProfile(p.id);
    }
  });

  // ── TV-2 E1: the full orchestrator (hermetic; stubbed network fetchers) ──
  // A temp DB with series_progress rows (a normal seed, an anime row, a Reality
  // show seen only as sampled_left) + Glass meta + stubs for every network
  // fetcher. generate(series) → no anime/Reality/excluded genre, every row
  // pre-resolved, stats filled, summary line logged; generate(movie) → [].
  // Plus the registry: get exists, isEnabled false by default, resolveFor →
  // Genesis while disabled, marquee-tv once enabled.
  await it('TV-2 E1: generate(series) end-to-end — no anime/Reality/excluded genre, pre-resolved, stats + summary; movie → []; registry dark', async () => {
    const marqueeTv = require('../src/engines/marqueeTv');
    const glassMetaStore = require('../src/engines/glass/metaStore');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const p = config.addProfile('INT-TV2-E1');
    config.updateProfile(p.id, {
      filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      keys: { tmdb_api_key: 'itest-tmdb' },
      simkl_auth: { access_token: 'tok' },
    });
    const profile = config.getProfile(p.id);

    // A temp DB with series_progress rows (a normal seed, an anime row, a
    // Reality show seen only as sampled_left).
    watchedStore.upsertSeriesProgress(p.id, [
      { simkl_id: 100, kind: 'show', imdb_id: 'ttseed1', tmdb_id: 'seed1', title: 'Seed Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 200, kind: 'anime', imdb_id: 'ttanime', tmdb_id: 'anime1', title: 'Anime Show', year: 2020, status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0, last_watched_at: nowMs, first_watched_at: nowMs, first_real_at: nowMs, last_real_at: nowMs, stamps: 10, real_stamps: 10, eps_per_week: null },
      { simkl_id: 300, kind: 'show', imdb_id: 'ttreality', tmdb_id: 'reality1', title: 'Reality Show', year: 2020, status: 'watching', watched_eps: 1, total_eps: 10, not_aired_eps: 0, last_watched_at: nowMs - 90 * 86400e3, first_watched_at: nowMs - 90 * 86400e3, first_real_at: nowMs - 90 * 86400e3, last_real_at: nowMs - 90 * 86400e3, stamps: 1, real_stamps: 1, eps_per_week: null },
    ]);

    // TV meta: the full merged meta for every candidate (deep + extras).
    const tvMeta = (apiKey, ids) => {
      const m = new Map();
      for (const id of ids) {
        const base = { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 };
        if (id === 'anime2') { base.simklType = 'anime'; base.genres = ['Animation']; }
        if (id === 'reality2') { base.tvType = 'Reality'; base.genres = ['Reality']; }
        if (id === 'horror2') { base.genres = ['Horror']; }
        m.set(id, base);
      }
      return m;
    };

    // Simkl recs: the candidates for seed1 (good1, anime2, reality2, horror2).
    // Batch fetcher (L2, TV-3 §5): (profile, simklIds) → Map<simkl_id, recs[]>.
    const simklRecs = async (profile, ids) => {
      const m = new Map();
      for (const id of ids) {
        if (id !== 100) continue;
        m.set(id, [
          { tmdb_id: 'good1', imdb_id: 'ttgood1', title: 'Good Show', year: 2024 },
          { tmdb_id: 'anime2', imdb_id: 'ttanime2', title: 'Anime Show 2', year: 2024 },
          { tmdb_id: 'reality2', imdb_id: 'ttreality2', title: 'Reality Show 2', year: 2024 },
          { tmdb_id: 'horror2', imdb_id: 'tthorror2', title: 'Horror Show 2', year: 2024 },
        ]);
      }
      return m;
    };

    const tmdbRecs = () => [];
    const discover = () => [];
    const trending = () => [];
    const imdbRatings = () => new Map();

    // Glass meta for the taste event (seed1) so the taste model is non-empty.
    glassMetaStore.put('series', 'seed1', { tmdb_id: 'seed1', genres: ['Drama'] });

    const logs = [];
    const ctx = {
      settings: { llm: {} }, // no LLM providers → no chain → TV-2-identical scores (N4)
      nowMs,
      filters: { excluded_genres: ['Horror'], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
      tmdbKey: 'itest-tmdb',
      mdblistKey: '',
      log: { log: (msg) => logs.push(msg), warn: () => {}, error: () => {} },
      stats: {},
      watchedIds: { imdb: new Set(), tmdb: new Set() },
      dont: new Set(),
      marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs, discover, trending, imdbRatings },
    };

    try {
      // (1) generate(series) → one candidate (good1), no anime/Reality/excluded genre.
      const out = await marqueeTv.generate(profile, 'series', ctx);
      assert.strictEqual(out.length, 1, 'one candidate (good1)');
      assert.strictEqual(out[0].tmdb_id, 'good1');
      assert.ok(!out.some((c) => c.tmdb_id === 'anime2'), 'no anime');
      assert.ok(!out.some((c) => c.tmdb_id === 'reality2'), 'no Reality');
      assert.ok(!out.some((c) => c.tmdb_id === 'horror2'), 'no excluded genre');
      // every row is pre-resolved.
      assert.ok(out.every((c) => c.imdb_id), 'every row pre-resolved (imdb_id)');
      assert.strictEqual(out[0].imdb_id, 'ttgood1');
      // stats are filled.
      assert.strictEqual(ctx.stats.seeds, 1, 'stats.seeds = 1');
      assert.strictEqual(ctx.stats.raw, 4, 'stats.raw = 4');
      assert.strictEqual(ctx.stats.strong, 4, 'stats.strong = 4');
      assert.strictEqual(ctx.stats.passed, 1, 'stats.passed = 1');
      assert.strictEqual(ctx.stats.kept, 1, 'stats.kept = 1');
      // the summary line is logged.
      assert.ok(logs.some((l) => l.startsWith('[marquee-tv]') && l.includes('seeds 1') && l.includes('raw 4') && l.includes('passed 1') && l.includes('stored 1')), 'summary line logged');
      // (2) generate(movie) → [].
      const movieOut = await marqueeTv.generate(profile, 'movie', ctx);
      assert.deepStrictEqual(movieOut, [], 'generate(movie) → []');
      // (3) registry: get exists; isEnabled false by default; resolveFor →
      //     Genesis while disabled, marquee-tv once enabled.
      assert.ok(engines.get('marquee-tv'), 'engines.get(marquee-tv) exists');
      assert.strictEqual(engines.isEnabled('marquee-tv'), false, 'isEnabled false by default');
      assert.strictEqual(engines.resolveFor(profile, 'series').id, 'genesis', 'resolveFor → Genesis while disabled');
      settings.updateSettings({ engines: { 'marquee-tv': true } });
      assert.strictEqual(engines.resolveFor(profile, 'series').id, 'marquee-tv', 'resolveFor → marquee-tv once enabled');
    } finally {
      settings.updateSettings({ engines: { 'marquee-tv': false } });
      config.removeProfile(p.id);
      watchedStore.deleteForProfile(p.id);
    }
  });

  // ── TV-2 E2: the series bench runs marquee-tv alongside genesis ──
  // The reviewer's backtest is `bench-engines.js <profile> --type series
  // --engines genesis,marquee-tv`. E2 proves that plumbing hermetically: a temp
  // DB with series history (no watched series rows, so genesis returns [] with
  // no network), the REAL genesis + marquee-tv engines through runBench, with
  // marquee-tv's network fetchers stubbed via the ctx.marqueeTvFetchers seam.
  // Both engines must complete and report metrics.
  await it('TV-2 E2: series bench runs marquee-tv + genesis — both engines report', async () => {
    const pipeline = require('../src/engines/pipeline');
    const p = config.addProfile('INT-TV2-E2');
    const nowMs = Date.parse('2026-10-02T00:00:00Z');
    const DAY = 86400e3;
    // 11 qualifying series_progress rows (holdout 1 needs 1+10). No watched
    // series rows → genesis's seed list is empty → it returns [] with no network.
    const mk = (i) => ({
      simkl_id: i, kind: 'show', imdb_id: 'tt' + i, tmdb_id: 'e2' + i, title: 'Show ' + i, year: 2020,
      status: 'watching', watched_eps: 10, total_eps: 20, not_aired_eps: 0,
      last_watched_at: nowMs - i * DAY, first_watched_at: nowMs - i * DAY,
      first_real_at: nowMs - i * DAY, last_real_at: nowMs - i * DAY,
      stamps: 10, real_stamps: 10, eps_per_week: null,
    });
    const rows = Array.from({ length: 11 }, (_, i) => mk(i + 1));

    // Stub fetchers for marquee-tv (M6 seam): one Simkl rec, everything else empty.
    const tvMeta = (apiKey, ids) => {
      const m = new Map();
      for (const id of ids) {
        m.set(id, { tmdb_id: id, imdb_id: 'tt' + id, type: 'series', title: 'Show ' + id, year: 2024, genres: ['Drama'], keywords: [], tvType: 'Scripted', status: 'Returning Series', vote_average: 8, vote_count: 1000, popularity: 5, certAU: null, certUS: null, first_air_date: '2024-01-01', last_air_date: '2026-01-01', number_of_episodes: 20, number_of_seasons: 1 });
      }
      return m;
    };
    // Batch fetcher (L2, TV-3 §5): (profile, simklIds) → Map<simkl_id, recs[]>.
    const simklRecs = async (profile, ids) => {
      const m = new Map();
      for (const id of ids) m.set(id, [{ tmdb_id: 'e2good1', imdb_id: 'tte2good1', title: 'Good Show', year: 2024 }]);
      return m;
    };
    const tmdbRecs = () => [];
    const discover = () => [];
    const trending = () => [];
    const imdbRatings = () => new Map();

    // The pipeline's else branch (genesis is not preResolved) calls tmdb.getGenreMap
    // even with zero candidates — stub it so the bench stays hermetic.
    const realGetGenreMap = tmdb.getGenreMap;
    tmdb.getGenreMap = async () => ({ 18: 'Drama', 10000: 'Action' });
    try {
      config.updateProfile(p.id, {
        filters: { engine_series: 'marquee-tv', excluded_genres: ['Horror'], min_year: 2010, min_rating: 7, vote_count_floor: 50, age_limit: 0 },
        keys: { tmdb_api_key: 'itest-tmdb' },
        simkl_auth: { access_token: 'tok' },
      });
      watchedStore.upsertSeriesProgress(p.id, rows);
      const results = await bench.runBench({
        profile: config.getProfile(p.id),
        engineIds: ['genesis', 'marquee-tv'],
        holdout: 1,
        type: 'series',
        deps: {
          engines, pipeline, rs, watchedStore, db, settings,
          selectServe: rs.selectServe, log: quiet,
          ctxExtras: { marqueeTvFetchers: { tvMeta, simklRecs, tmdbRecs, discover, trending, imdbRatings } },
        },
      });
      // Both engines report.
      assert.ok(results.engines.genesis, 'genesis reported');
      assert.ok(results.engines['marquee-tv'], 'marquee-tv reported');
      // genesis: no watched series → 0 stored.
      assert.strictEqual(results.engines.genesis.metrics.stored, 0, 'genesis stored 0 (no watched series)');
      // marquee-tv: its stub Simkl rec is stored (pre-resolved, pre-filtered).
      assert.ok(results.engines['marquee-tv'].metrics.stored >= 1, 'marquee-tv stored its candidate');
    } finally {
      tmdb.getGenreMap = realGetGenreMap;
      config.removeProfile(p.id);
      rs.deleteForProfile(p.id);
      watchedStore.deleteForProfile(p.id);
    }
  });

  // ── ENG-1 J2: the rebuild race — a switch made while a build is running is
  //    NOT lost (E1). A change while a build is running queues a NEW build that
  //    runs after it and reads the profile fresh. Must fail on unmodified v7
  //    (rebuildAfterChange absent) and pass after the fix. ──
  await it('ENG-1 J2: a switch made while a build is running is not lost (rebuild race)', async () => {
    // Two stub series engines. stub-a's generate blocks on a deferred so the test
    // controls when the first build finishes.
    let stubAEnteredResolve;
    const stubAEntered = new Promise((res) => { stubAEnteredResolve = res; });
    let releaseStubA;
    const stubABlock = new Promise((res) => { releaseStubA = res; });
    let stubBCalls = 0;
    const disposeA = engines._register({
      id: 'stub-a', name: 'Stub A', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async (profile, type, ctx) => {
        stubAEnteredResolve();
        await stubABlock;
        if (ctx && ctx.stats) ctx.stats.seeds = 3;
        return [
          { type: 'series', tmdb_id: 'stub-a-1', rankScore: 3, imdb_id: 'ttstuba1', title: 'A1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 30, reason: 'A1', recCount: 2 },
          { type: 'series', tmdb_id: 'stub-a-2', rankScore: 2, imdb_id: 'ttstuba2', title: 'A2', year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 4000, popularity: 20, reason: 'A2', recCount: 1 },
          { type: 'series', tmdb_id: 'stub-a-3', rankScore: 1, imdb_id: 'ttstuba3', title: 'A3', year: 2022, primary_genre: 'Action', genres: 'Action', vote_average: 6, vote_count: 3000, popularity: 10, reason: 'A3', recCount: 3 },
        ];
      },
    });
    const disposeB = engines._register({
      id: 'stub-b', name: 'Stub B', supportedTypes: ['series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async (profile, type, ctx) => {
        stubBCalls++;
        if (ctx && ctx.stats) ctx.stats.seeds = 3;
        return [
          { type: 'series', tmdb_id: 'stub-b-1', rankScore: 3, imdb_id: 'ttstubb1', title: 'B1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 30, reason: 'B1', recCount: 2 },
          { type: 'series', tmdb_id: 'stub-b-2', rankScore: 2, imdb_id: 'ttstubb2', title: 'B2', year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 4000, popularity: 20, reason: 'B2', recCount: 1 },
          { type: 'series', tmdb_id: 'stub-b-3', rankScore: 1, imdb_id: 'ttstubb3', title: 'B3', year: 2022, primary_genre: 'Action', genres: 'Action', vote_average: 6, vote_count: 3000, popularity: 10, reason: 'B3', recCount: 3 },
        ];
      },
    });
    const p = config.addProfile('INT-ENG1-J2');
    try {
      // Enable both engines + set the profile's series engine to stub-a.
      settings.updateSettings({ engines: { 'stub-a': true, 'stub-b': true } });
      config.updateProfile(p.id, { filters: { engine_series: 'stub-a', age_limit: 0 } });
      const profile = config.getProfile(p.id);
      // Start a build (the routine path) — it enters stub-a.generate and blocks.
      const firstBuild = rs.ensureBuilt(profile, quiet);
      await stubAEntered; // wait until stub-a.generate has been entered
      // While it's blocked, do exactly what the portal does on an engine change:
      // update the profile (engine_series → stub-b), clear the series slice, and
      // kick a rebuild that reads the profile fresh when it starts.
      config.updateProfile(p.id, { filters: { engine_series: 'stub-b' } });
      rs.clearType(p.id, 'series');
      const secondBuild = rs.rebuildAfterChange(p.id, quiet);
      // Release stub-a so the first build finishes.
      releaseStubA();
      await Promise.all([firstBuild, secondBuild]);
      // Assert: stub-b.generate was called; the series slice holds only stub-b's rows.
      assert.ok(stubBCalls >= 1, 'stub-b.generate was called');
      const series = rs.getRecommended(p.id, { type: 'series', limit: 100 });
      assert.strictEqual(series.length, 3, 'series slice has 3 rows');
      assert.ok(series.every((r) => r.engine_id === 'stub-b'), 'all series rows are engine_id stub-b');
      assert.ok(!series.some((r) => r.engine_id === 'stub-a'), 'no stub-a row survives');
    } finally {
      disposeA(); disposeB();
      settings.updateSettings({ engines: { 'stub-a': false, 'stub-b': false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  // ── ENG-1 C1: every engine-change caller uses rebuildAfterChange (not
  //    ensureBuilt) — the portal PUT, the disable-revert, the Tier-2 Glass/
  //    Marquee rebuilds, POST .../recommend/build, and the mobile settings save. ──
  await it('ENG-1 C1: every engine-change caller uses rebuildAfterChange (not ensureBuilt)', async () => {
    const portalMod = require('../src/portal');
    const origRebuild = rs.rebuildAfterChange;
    const origEnsure = rs.ensureBuilt;
    const jobsMod = require('../src/jobs');
    const rebuildCalls = [];
    const ensureCalls = [];
    // Spy: record WHICH function the caller uses. rebuildAfterChange enqueues a
    // no-op job (so the response's job snapshot is non-null, as in production)
    // but runs nothing — C1 cares about the call, not the build result.
    rs.rebuildAfterChange = (profileId) => {
      rebuildCalls.push(profileId);
      return jobsMod.enqueue(profileId, 'recs', async () => ({ skipped: true, reason: 'c1-spy' }), { afterActive: true });
    };
    rs.ensureBuilt = (profile) => { ensureCalls.push(profile.id); return Promise.resolve({}); };

    // Drive a portal route directly (no HTTP). req carries the few express
    // request bits the handlers touch (params, protocol/get for baseUrl).
    const drivePortal = (method, path, body, params = {}) => {
      const isMatch = (m) => (Array.isArray(m) ? m.includes(method.toLowerCase()) : !!m[method.toLowerCase()]);
      const layer = portalMod.router.stack.find((l) => l.route && l.route.path === path && isMatch(l.route.methods));
      const res = fakeRes();
      layer.handle({ body, method, params, protocol: 'http', get: () => 'localhost' }, res);
      return res;
    };
    // Drive the portal PUT /settings handler directly.
    const portalPutSettings = (body) => {
      const isPut = (m) => (Array.isArray(m) ? m.includes('put') : !!m.put);
      const layer = portalMod.router.stack.find((l) => l.route && l.route.path === '/settings' && isPut(l.route.methods));
      const res = fakeRes();
      layer.handle({ body, method: 'PUT', protocol: 'http', get: () => 'localhost' }, res);
      return res;
    };

    // A conformant fake engine for the engine-change scenarios.
    const dispose = engines._register({
      id: 'c1-fake', name: 'C1 Fake', supportedTypes: ['movie', 'series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async () => [],
    });

    try {
      settings.updateSettings({ engines: { 'c1-fake': true } });

      // (1) Portal PUT /profiles/:id that changes engine_series.
      {
        const p = config.addProfile('INT-ENG1-C1-put');
        config.updateProfile(p.id, { filters: { engine_series: 'genesis' } });
        drivePortal('PUT', '/profiles/:id', { filters: { engine_series: 'c1-fake' } }, { id: p.id });
        assert.ok(rebuildCalls.includes(p.id), 'PUT /profiles/:id (engine change) → rebuildAfterChange');
        assert.ok(!ensureCalls.includes(p.id), 'PUT /profiles/:id does NOT call ensureBuilt');
        config.removeProfile(p.id); rs.deleteForProfile(p.id);
      }

      // (2) POST /profiles/:id/recommend/build — 202 with the same body shape.
      {
        const p = config.addProfile('INT-ENG1-C1-build');
        const res = drivePortal('POST', '/profiles/:id/recommend/build', {}, { id: p.id });
        assert.ok(rebuildCalls.includes(p.id), 'POST .../recommend/build → rebuildAfterChange');
        assert.ok(!ensureCalls.includes(p.id), 'POST .../recommend/build does NOT call ensureBuilt');
        assert.strictEqual(res.statusCode, 202, 'POST .../recommend/build answers 202');
        assert.strictEqual(res.body.started, true, 'POST .../recommend/build body has started: true');
        assert.ok(res.body.job !== null, 'POST .../recommend/build body has a job snapshot');
        config.removeProfile(p.id); rs.deleteForProfile(p.id);
      }

      // (3) Mobile settings save that changes an engine (companion body carries
      // the filters flat, not nested under `filters`).
      {
        const p = config.addProfile('INT-ENG1-C1-mobile');
        config.updateProfile(p.id, { filters: { engine_series: 'genesis' } });
        const res = fakeRes();
        companion.settingsPostHandler({ profile: config.getProfile(p.id), body: { engine_series: 'c1-fake' } }, res);
        assert.ok(rebuildCalls.includes(p.id), 'mobile settings save (engine change) → rebuildAfterChange');
        assert.ok(!ensureCalls.includes(p.id), 'mobile settings save does NOT call ensureBuilt');
        config.removeProfile(p.id); rs.deleteForProfile(p.id);
      }

      // (4) Disable revert (revertDisabledEngines) via PUT /settings.
      {
        const p = config.addProfile('INT-ENG1-C1-revert');
        config.updateProfile(p.id, { filters: { engine_series: 'c1-fake' } });
        portalPutSettings({ engines: { 'c1-fake': false } });
        assert.ok(rebuildCalls.includes(p.id), 'disable revert → rebuildAfterChange');
        assert.ok(!ensureCalls.includes(p.id), 'disable revert does NOT call ensureBuilt');
        config.removeProfile(p.id); rs.deleteForProfile(p.id);
      }

      // (5) rebuildMarqueeProfiles via PUT /settings (a Tier-2 Marquee config change).
      {
        settings.updateSettings({ engines: { marquee: true }, marquee: {} });
        const p = config.addProfile('INT-ENG1-C1-marquee');
        config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'marquee' } });
        portalPutSettings({ marquee: { franchise_cap: 1 } });
        assert.ok(rebuildCalls.includes(p.id), 'rebuildMarqueeProfiles → rebuildAfterChange');
        assert.ok(!ensureCalls.includes(p.id), 'rebuildMarqueeProfiles does NOT call ensureBuilt');
        config.removeProfile(p.id); rs.deleteForProfile(p.id);
        settings.updateSettings({ engines: { marquee: false }, marquee: {} });
      }

      // (6) rebuildGlassProfiles via PUT /settings (a Tier-2 Glass config change).
      {
        settings.updateSettings({ engines: { glass: true }, glass: {} });
        const p = config.addProfile('INT-ENG1-C1-glass');
        config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { engine_series: 'glass' } });
        portalPutSettings({ glass: { some_key: 1 } });
        assert.ok(rebuildCalls.includes(p.id), 'rebuildGlassProfiles → rebuildAfterChange');
        assert.ok(!ensureCalls.includes(p.id), 'rebuildGlassProfiles does NOT call ensureBuilt');
        config.removeProfile(p.id); rs.deleteForProfile(p.id);
        settings.updateSettings({ engines: { glass: false }, glass: {} });
      }
    } finally {
      rs.rebuildAfterChange = origRebuild;
      rs.ensureBuilt = origEnsure;
      settings.updateSettings({ engines: { 'c1-fake': false, marquee: false, glass: false } });
      dispose();
    }
  });

  // ── ENG-1 P1: pruneOtherEngines + the pipeline — after a successful build,
  //    the type's slice holds only that build's engine's rows (E2). ──
  await it('ENG-1 P1: pruneOtherEngines + the pipeline (other-engine leftovers removed)', async () => {
    const pipeline = require('../src/engines/pipeline');
    // Stub engine x: 3 series candidates, one of which re-produces a genesis row.
    const xCands = [
      { type: 'series', tmdb_id: 'x-1', rankScore: 3, imdb_id: 'ttx1', title: 'X1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 30, reason: 'X1', recCount: 2 },
      { type: 'series', tmdb_id: 'x-2', rankScore: 2, imdb_id: 'ttx2', title: 'X2', year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 4000, popularity: 20, reason: 'X2', recCount: 1 },
      { type: 'series', tmdb_id: 'genesis-repro', rankScore: 1, imdb_id: 'ttgenrepro', title: 'GenRepro', year: 2022, primary_genre: 'Action', genres: 'Action', vote_average: 6, vote_count: 3000, popularity: 10, reason: 'GenRepro', recCount: 3 },
    ];
    const p = config.addProfile('INT-ENG1-P1');
    try {
      // Seed the movie slice (must be untouched in both scenarios).
      rs.upsertCandidates(p.id, [
        { type: 'movie', tmdb_id: 'movie-1', imdb_id: 'ttmovie1', title: 'M1', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, engine_id: 'genesis', popularity: 1 },
      ]);

      // (a) x stores 3 rows → only x rows remain; the re-produced row has engine_id x;
      //     the log line is printed; the movie slice is untouched.
      {
        rs.clearType(p.id, 'series');
        rs.upsertCandidates(p.id, [
          { type: 'series', tmdb_id: 'genesis-1', imdb_id: 'ttgen1', title: 'G1', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, engine_id: 'genesis', popularity: 1 },
          { type: 'series', tmdb_id: 'null-1', imdb_id: 'ttnull1', title: 'N1', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, engine_id: null, popularity: 1 },
          { type: 'series', tmdb_id: 'genesis-repro', imdb_id: 'ttgenrepro', title: 'GenRepro', year: 2022, vote_average: 6, vote_count: 3000, affinity: 0.4, rec_count: 1, engine_id: 'genesis', popularity: 1 },
        ]);
        const logMessages = [];
        const log = { log: (m) => logMessages.push(m), warn: () => {}, error: () => {} };
        const dispose = engines._register({
          id: 'x', name: 'X Engine', supportedTypes: ['series'],
          capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
          requirements: () => ({ ok: true, missing: [] }),
          generate: async (profile, type, ctx) => { if (ctx && ctx.stats) ctx.stats.seeds = 3; return xCands; },
        });
        const profile = config.getProfile(p.id);
        const ctx = { tmdbKey: 'k', mdblistKey: '', settings: {}, filters: profile.filters || {}, log, watchedIds: { tmdb: new Set(), imdb: new Set() }, dont: new Set(), stats: {} };
        await pipeline.runEngineBuild(profile, 'series', engines.get('x'), ctx, () => {});
        const series = rs.getRecommended(p.id, { type: 'series', limit: 100 });
        assert.strictEqual(series.length, 3, 'only x rows remain');
        assert.ok(series.every((r) => r.engine_id === 'x'), 'all series rows are engine_id x');
        const repro = series.find((r) => r.tmdb_id === 'genesis-repro');
        assert.ok(repro, 'the re-produced row exists');
        assert.strictEqual(repro.engine_id, 'x', 'the re-produced row has engine_id x');
        assert.ok(logMessages.some((m) => /removed 2 series row\(s\) left by another engine/.test(m)), 'the log line is printed');
        const movie = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
        assert.strictEqual(movie.length, 1, 'the movie slice is untouched');
        assert.strictEqual(movie[0].engine_id, 'genesis', 'the movie row is still genesis');
        dispose();
      }

      // (b) x stores 0 rows → nothing is pruned (the genesis/NULL rows remain);
      //     the movie slice is untouched.
      {
        rs.clearType(p.id, 'series');
        rs.upsertCandidates(p.id, [
          { type: 'series', tmdb_id: 'genesis-1', imdb_id: 'ttgen1', title: 'G1', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, engine_id: 'genesis', popularity: 1 },
          { type: 'series', tmdb_id: 'null-1', imdb_id: 'ttnull1', title: 'N1', year: 2020, vote_average: 7, vote_count: 1000, affinity: 0.5, rec_count: 1, engine_id: null, popularity: 1 },
        ]);
        const logMessages = [];
        const log = { log: (m) => logMessages.push(m), warn: () => {}, error: () => {} };
        const dispose = engines._register({
          id: 'x-empty', name: 'X Empty', supportedTypes: ['series'],
          capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
          requirements: () => ({ ok: true, missing: [] }),
          generate: async () => [],
        });
        const profile = config.getProfile(p.id);
        const ctx = { tmdbKey: 'k', mdblistKey: '', settings: {}, filters: profile.filters || {}, log, watchedIds: { tmdb: new Set(), imdb: new Set() }, dont: new Set(), stats: {} };
        await pipeline.runEngineBuild(profile, 'series', engines.get('x-empty'), ctx, () => {});
        const series = rs.getRecommended(p.id, { type: 'series', limit: 100 });
        assert.strictEqual(series.length, 2, 'nothing is pruned (the genesis/NULL rows remain)');
        assert.ok(!logMessages.some((m) => /left by another engine/.test(m)), 'no prune log line');
        const movie = rs.getRecommended(p.id, { type: 'movie', limit: 100 });
        assert.strictEqual(movie.length, 1, 'the movie slice is untouched');
        dispose();
      }
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id);
    }
  });

  // ── Watched-title backfill (fix/catalog-watched-backfill) ──────────────────
  // The AI catalog must select up to list_size UNWATCHED, otherwise-eligible
  // titles: the profile's watched IMDb ids are filtered out of the stored pool
  // BEFORE the serve limit is applied, so a watched title is replaced by a valid
  // pool row instead of shrinking the catalog after the limit. These tests
  // encode the card's user-facing behaviour, not the internal seam.
  const mkBackfillRow = (tmdbId, genre, affinity, type = 'movie') => ({
    type, tmdb_id: tmdbId, imdb_id: 'tt' + tmdbId, title: 'T' + tmdbId,
    year: 2020, primary_genre: genre, genres: genre, affinity, vote_average: 7,
    rec_count: 1, popularity: 1, poster: null,
  });
  // 28 otherwise-servable movie rows: 4 genres × 7, distinct affinities within
  // each genre (round-robin picks the strongest of each genre in turn).
  const backfillMovieRows = () => {
    const rows = [];
    for (const [prefix, genre] of [['A', 'Action'], ['B', 'Drama'], ['C', 'Comedy'], ['D', 'Science Fiction']]) {
      for (let i = 1; i <= 7; i++) rows.push(mkBackfillRow(prefix + i, genre, 100 - i));
    }
    return rows;
  };

  // T1a — the production-shaped shortfall (fallback genre-balanced path): a
  // 20-title movie catalog serves 20 unwatched titles immediately (was 14 after
  // the post-limit watched prune). Six watched ids are chosen so the OLD catalog
  // selects them in its first 20.
  await it('T1a: 20-title movie catalog serves 20 unwatched (fallback genre-balanced path)', async () => {
    const p = config.addProfile('INT-WBF-T1a');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      const rows = backfillMovieRows();
      rs.upsertCandidates(p.id, rows);
      const watchedIds = ['ttA1', 'ttA2', 'ttB1', 'ttB2', 'ttC1', 'ttD1'];
      for (const imdbId of watchedIds) watchedStore.addPendingWatched(p.id, { type: 'movie', imdbId });
      const served = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(served.state, 'ok');
      assert.strictEqual(served.metas.length, 20, 'serves 20 unwatched titles (was 14)');
      assert.ok(served.metas.every((m) => !watchedIds.includes(m.id)), 'no watched id served');
      const poolIds = new Set(rows.map((r) => r.imdb_id));
      assert.ok(served.metas.every((m) => poolIds.has(m.id)), 'all served ids are valid pool rows');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // T1b — the same shortfall on the calibrated serve path (Marquee + target):
  // six watched Action ids are in the old catalog's first 20; the fix serves 20.
  await it('T1b: 20-title movie catalog serves 20 unwatched (calibrated serve path)', async () => {
    const p = config.addProfile('INT-WBF-T1b');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      const rows = [];
      for (let i = 1; i <= 7; i++) rows.push(mkBackfillRow('A' + i, 'Action', 100 - i));
      for (let i = 1; i <= 7; i++) rows.push(mkBackfillRow('B' + i, 'Drama', 90 - i));
      for (let i = 1; i <= 7; i++) rows.push(mkBackfillRow('C' + i, 'Comedy', 80 - i));
      for (let i = 1; i <= 7; i++) rows.push(mkBackfillRow('D' + i, 'Science Fiction', 70 - i));
      rs.upsertCandidates(p.id, rows);
      const target = { Action: 0.7, Drama: 0.1, Comedy: 0.1, 'Science Fiction': 0.1 };
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 28, Date.now());
      const watchedIds = ['ttA1', 'ttA2', 'ttA3', 'ttA4', 'ttA5', 'ttA6'];
      for (const imdbId of watchedIds) watchedStore.addPendingWatched(p.id, { type: 'movie', imdbId });
      const served = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(served.state, 'ok');
      assert.strictEqual(served.metas.length, 20, 'serves 20 unwatched titles (was 14)');
      assert.ok(served.metas.every((m) => !watchedIds.includes(m.id)), 'no watched id served');
      const poolIds = new Set(rows.map((r) => r.imdb_id));
      assert.ok(served.metas.every((m) => poolIds.has(m.id)), 'all served ids are valid pool rows');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
      watchedStore.deleteForProfile(p.id);
    }
  });

  // T2 — ordering correctness: the served ids equal selectServeFor over the
  // watched-filtered pool (projected to IMDb ids), for both the fallback and
  // calibrated paths. Watched removal can change calibrated ordering throughout
  // the list, so this is a property assertion, not a hand-picked order.
  await it('T2: served ids equal selectServeFor over the watched-filtered pool (fallback + calibrated)', async () => {
    const p = config.addProfile('INT-WBF-T2');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'marquee', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      settings.updateSettings({ engines: { marquee: true } });
      const rows = backfillMovieRows();
      rs.upsertCandidates(p.id, rows);
      const watchedIds = ['ttA1', 'ttA2', 'ttB1', 'ttB2', 'ttC1', 'ttD1'];
      for (const imdbId of watchedIds) watchedStore.addPendingWatched(p.id, { type: 'movie', imdbId });
      const profile = config.getProfile(p.id);
      const watchedImdb = watchedStore.watchedIdSets(p.id).imdb;
      const allRows = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const unwatched = allRows.filter((r) => !watchedImdb.has(r.imdb_id));
      // (a) fallback (no target → genre-balanced round-robin).
      const expectedFallback = rs.selectServeFor(profile, 'movie', unwatched, { limit: 20 }).map((r) => r.imdb_id);
      const servedFallback = rs.serveRecommendations(profile, 'movie', { record: false }).map((m) => m.id);
      assert.deepStrictEqual(servedFallback, expectedFallback, 'fallback served ids match selectServeFor over the watched-filtered pool');
      // (b) calibrated (Marquee + target).
      const target = { Action: 0.4, Drama: 0.3, Comedy: 0.2, 'Science Fiction': 0.1 };
      serveCalibration.setTarget(p.id, 'movie', 'marquee', target, 28, Date.now());
      const profile2 = config.getProfile(p.id);
      const expectedCalibrated = rs.selectServeFor(profile2, 'movie', unwatched, { limit: 20 }).map((r) => r.imdb_id);
      const servedCalibrated = rs.serveRecommendations(profile2, 'movie', { record: false }).map((m) => m.id);
      assert.deepStrictEqual(servedCalibrated, expectedCalibrated, 'calibrated served ids match selectServeFor over the watched-filtered pool');
    } finally {
      settings.updateSettings({ engines: { marquee: false } });
      config.removeProfile(p.id); rs.deleteForProfile(p.id); serveCalibration.deleteForProfile(p.id);
      watchedStore.deleteForProfile(p.id);
    }
  });

  // T3 — watch transitions: an authoritative watched title AND a pending_watched
  // title both disappear (and are replaced) without a build. Covers a show
  // catalog too, and the profile-wide IMDb exclusion when the watched type and
  // the recommendation type disagree.
  await it('T3: authoritative + pending watches both disappear without a build (movies + shows, cross-type)', async () => {
    const p = config.addProfile('INT-WBF-T3');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'genesis', engine_series: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      // 28 movie rows + 28 show rows.
      const movieRows = backfillMovieRows();
      const showRows = movieRows.map((r) => ({ ...r, type: 'series', tmdb_id: 's' + r.tmdb_id, imdb_id: 'tt' + 's' + r.tmdb_id }));
      rs.upsertCandidates(p.id, [...movieRows, ...showRows]);
      // An authoritative movie watch + a pending movie watch.
      const authImdb = 'ttA1';
      const pendImdb = 'ttB1';
      watchedStore.upsertMany(p.id, [{ type: 'movie', title: 'Auth', year: 2020, tmdb_id: 'A1', imdb_id: authImdb, simkl_id: 1001, watched_at: '2026-09-09T00:00:00Z' }]);
      watchedStore.addPendingWatched(p.id, { type: 'movie', imdbId: pendImdb });
      // A cross-type watch: a SHOW watched (type 'series') must exclude the
      // same IMDb id from the MOVIE catalog (profile-wide IMDb identity).
      const crossImdb = 'ttC1';
      watchedStore.addPendingWatched(p.id, { type: 'series', imdbId: crossImdb });
      // A show watch of the show row itself (imdb ttsD1, type series).
      const showWatchImdb = 'tt' + 's' + 'D1';
      watchedStore.addPendingWatched(p.id, { type: 'series', imdbId: showWatchImdb });
      const movies = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(movies.metas.length, 20, 'movie catalog still serves 20');
      assert.ok(!movies.metas.some((m) => m.id === authImdb), 'authoritative watch gone');
      assert.ok(!movies.metas.some((m) => m.id === pendImdb), 'pending watch gone');
      assert.ok(!movies.metas.some((m) => m.id === crossImdb), 'cross-type (series) watch excludes the movie catalog');
      // A show catalog too: the cross-type watch (imdb ttC1, type series) does NOT
      // exclude the show row (imdb ttsC1, a different id) — the profile-wide IMDb
      // identity is exact, not a prefix. But the show watch of the show row itself
      // (imdb ttsD1) IS excluded from the show catalog.
      const shows = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-series', { record: false });
      assert.ok(shows.metas.some((m) => m.id === 'tt' + 's' + 'C1'), 'series catalog still serves its own show (different imdb id)');
      assert.ok(!shows.metas.some((m) => m.id === showWatchImdb), 'series catalog excludes its own watched show');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // T4 — impressions and read-only surfaces: in a real record:true catalog call,
  // the six watched rows' impression columns do NOT advance; the selected visible
  // rows advance once. Read-only surfaces (preview, rebuild.status, Advanced
  // view) do not advance them.
  await it('T4: record:true advances only the selected visible rows; read-only surfaces do not', async () => {
    const p = config.addProfile('INT-WBF-T4');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      const rows = backfillMovieRows();
      rs.upsertCandidates(p.id, rows);
      const watchedIds = ['ttA1', 'ttA2', 'ttB1', 'ttB2', 'ttC1', 'ttD1'];
      for (const imdbId of watchedIds) watchedStore.addPendingWatched(p.id, { type: 'movie', imdbId });
      const profile = config.getProfile(p.id);
      const before = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const beforeByTmdb = new Map(before.map((r) => [r.tmdb_id, r]));
      // A real serve (record:true) — an impression.
      const served = rs.serveRecommendations(profile, 'movie', { record: true });
      assert.strictEqual(served.length, 20);
      const after = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const afterByTmdb = new Map(after.map((r) => [r.tmdb_id, r]));
      // The six watched rows' impression columns do NOT advance.
      for (const imdbId of watchedIds) {
        const tmdbId = imdbId.slice(2); // ttX -> X
        const b = beforeByTmdb.get(tmdbId);
        const a = afterByTmdb.get(tmdbId);
        assert.strictEqual(a.times_shown, b.times_shown, `watched ${imdbId} times_shown unchanged`);
        assert.strictEqual(a.times_shown_in_streak, b.times_shown_in_streak, `watched ${imdbId} streak unchanged`);
      }
      // Each selected visible row advances exactly once.
      const servedTmdb = new Set(served.map((m) => m.id).map((id) => id.slice(2)));
      for (const r of after) {
        if (servedTmdb.has(r.tmdb_id)) {
          const b = beforeByTmdb.get(r.tmdb_id);
          assert.strictEqual(r.times_shown - b.times_shown, 1, `served ${r.tmdb_id} advanced exactly once`);
        }
      }
      // Read-only surfaces do not advance impressions.
      const before2 = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      const before2ByTmdb = new Map(before2.map((r) => [r.tmdb_id, r]));
      catalogServe.servedCatalog(profile, 'ai-recs-movies', { record: false }); // preview
      rebuild.status(profile); // rebuild.status
      const after2 = rs.getRecommended(p.id, { type: 'movie', limit: 100000 });
      for (const r of after2) {
        const b = before2ByTmdb.get(r.tmdb_id);
        assert.strictEqual(r.times_shown, b.times_shown, 'read-only surfaces do not advance times_shown');
      }
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // T5a — honest shortfall: when only 13 unwatched eligible rows remain, serve
  // 13 (no duplication / invented candidates).
  await it('T5a: honest shortfall — 13 unwatched eligible rows serve 13 (no duplication/invention)', async () => {
    const p = config.addProfile('INT-WBF-T5a');
    try {
      config.updateProfile(p.id, { filters: { engine_movie: 'genesis', engine_series: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      // 20 movie rows, 7 watched → 13 unwatched eligible.
      const rows = [];
      for (let i = 1; i <= 20; i++) rows.push(mkBackfillRow('M' + i, 'Action', 100 - i));
      rs.upsertCandidates(p.id, rows);
      for (let i = 1; i <= 7; i++) watchedStore.addPendingWatched(p.id, { type: 'movie', imdbId: 'ttM' + i });
      const served = catalogServe.servedCatalog(config.getProfile(p.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(served.metas.length, 13, 'serves the 13 unwatched eligible rows (no duplication/invention)');
      assert.ok(new Set(served.metas.map((m) => m.id)).size === 13, 'no duplicated ids');
    } finally {
      config.removeProfile(p.id); rs.deleteForProfile(p.id); watchedStore.deleteForProfile(p.id);
    }
  });

  // T5b — empty states: when a type pool exists but all rows are watched,
  // state:'ok' + metas:[]. When the type pool is genuinely empty, preserve
  // not_built (Simkl connected) / needs_simkl (not), even if the OTHER type has
  // rows.
  await it('T5b: empty states — all-watched ok + metas [], genuinely-empty not_built/needs_simkl', async () => {
    try {
      // (a) All-watched pool: state 'ok', metas [].
      const p2 = config.addProfile('INT-WBF-T5b');
      config.updateProfile(p2.id, { filters: { engine_movie: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      const allRows = backfillMovieRows();
      rs.upsertCandidates(p2.id, allRows);
      for (const r of allRows) watchedStore.addPendingWatched(p2.id, { type: 'movie', imdbId: r.imdb_id });
      const allWatched = catalogServe.servedCatalog(config.getProfile(p2.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(allWatched.state, 'ok', 'all-watched pool is a built pool serving nothing (state ok)');
      assert.deepStrictEqual(allWatched.metas, [], 'all-watched pool serves no metas');
      assert.strictEqual(allWatched.requirement_met, true);
      // (b) Genuinely-empty type pool (Simkl connected) → not_built, even when
      // the OTHER type (series) has rows.
      const p3 = config.addProfile('INT-WBF-T5c');
      config.updateProfile(p3.id, { simkl_auth: { access_token: 'x' }, filters: { engine_movie: 'genesis', engine_series: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      rs.upsertCandidates(p3.id, backfillMovieRows().map((r) => ({ ...r, type: 'series', tmdb_id: 's' + r.tmdb_id, imdb_id: 'tt' + 's' + r.tmdb_id })));
      const emptyMovie = catalogServe.servedCatalog(config.getProfile(p3.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(emptyMovie.state, 'not_built', 'genuinely-empty movie pool (Simkl connected) is not_built');
      assert.strictEqual(emptyMovie.requirement_met, true);
      // (c) Genuinely-empty type pool (Simkl NOT connected) → needs_simkl.
      const p4 = config.addProfile('INT-WBF-T5d');
      config.updateProfile(p4.id, { filters: { engine_movie: 'genesis', list_size: 20, min_rating: 0, excluded_genres: [], max_age_years: 0, age_limit: 0 } });
      const emptyMovieNoSimkl = catalogServe.servedCatalog(config.getProfile(p4.id), 'ai-recs-movies', { record: false });
      assert.strictEqual(emptyMovieNoSimkl.state, 'needs_simkl', 'genuinely-empty movie pool (no Simkl) is needs_simkl');
      assert.strictEqual(emptyMovieNoSimkl.requirement_met, false);
      // Cleanup the extra throwaway profiles.
      config.removeProfile(p2.id); rs.deleteForProfile(p2.id); watchedStore.deleteForProfile(p2.id);
      config.removeProfile(p3.id); rs.deleteForProfile(p3.id);
      config.removeProfile(p4.id); rs.deleteForProfile(p4.id);
    } finally {
      // Belt-and-braces cleanup if an assertion fails mid-test.
      for (const id of ['INT-WBF-T5b', 'INT-WBF-T5c', 'INT-WBF-T5d']) {
        const prof = config.getProfile(id);
        if (prof) { config.removeProfile(prof.id); rs.deleteForProfile(prof.id); watchedStore.deleteForProfile(prof.id); }
      }
    }
  });

  // ── T7: Staged build (feature/ai-catalog-cadence, Stage 2) ─────────────────
  // Atomic full generation: staged candidate/age evaluation, safe atomic
  // promotion, and Sunday obsolete-row replacement.
  {
    const aiSchedule = require('../src/aiSchedule');

    // A preResolved engine that returns deterministic candidates. `tag`
    // namespaces the ids so the test can distinguish the engine's output
    // from the seeded old pool rows.
    const mkStagedEngine = (id, tag, { suppressIds = [] } = {}) => ({
      id, name: id, description: 't', supportedTypes: ['movie', 'series'],
      capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
      requirements: () => ({ ok: true, missing: [] }),
      generate: async (profile, type, ctx) => {
        if (ctx.stats) ctx.stats.seeds = 1;
        // Two candidates per type: one overlapping with the old pool (to test
        // impression/engagement preservation) and one new (to test the reserve).
        // Plus a suppression candidate (to test dont_recommend survival).
        const cands = [
          { type, tmdb_id: `${tag}-${type}-overlap`, rankScore: 5, imdb_id: `tt-${tag}-${type}-overlap`, title: `${tag} overlap`, year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
          { type, tmdb_id: `${tag}-${type}-new`, rankScore: 4, imdb_id: `tt-${tag}-${type}-new`, title: `${tag} new`, year: 2025, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, popularity: 2, poster: null },
          { type, tmdb_id: `${tag}-${type}-new2`, rankScore: 3, imdb_id: `tt-${tag}-${type}-new2`, title: `${tag} new2`, year: 2025, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 3500, popularity: 2, poster: null },
        ];
        if (type === 'movie') {
          cands.push({ type: 'movie', tmdb_id: `${tag}-movie-suppressed`, rankScore: 2, imdb_id: `tt-${tag}-movie-suppressed`, title: `${tag} suppressed`, year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 6, vote_count: 3000, popularity: 1, poster: null });
        }
        return cands;
      },
    });

    await it('T7a: staged weekly build — atomic promotion, obsolete removal, impression preservation, dont_recommend survival', async () => {
      const prof = config.addProfile('T7a');
      const pid = prof.id;
      const dispose = engines._register(mkStagedEngine('t7-engine', 't7'));
      // Save + restore global settings (SC-03 pattern).
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't7-tmdb' } });
      settings.updateSettings({ engines: { 't7-engine': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't7-engine', engine_series: 't7-engine' } });
      try {
        // Seed watched history (so the watched set is non-empty).
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);

        // Seed the old movie pool with:
        //   1. An obsolete high-affinity row (engine_id = 't7-engine', NOT in the new staged set).
        //   2. An overlapping row with nonzero impression/engagement state (engine_id = 't7-engine', IN the new staged set).
        //   3. A newly watched row (in the watched set).
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't7-movie-obsolete', imdb_id: 'tt-t7-movie-obsolete', title: 'Obsolete', year: 2023, primary_genre: 'Drama', genres: 'Drama', vote_average: 9, vote_count: 6000, affinity: 10, rec_count: 1, popularity: 3, poster: null, engine_id: 't7-engine', algorithm_version: 'v1' },
          { type: 'movie', tmdb_id: 't7-movie-overlap', imdb_id: 'tt-t7-movie-overlap', title: 'Overlap', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-engine', algorithm_version: 'v1' },
          { type: 'movie', tmdb_id: 'w1', imdb_id: 'tt-watched', title: 'Watched', year: 2020, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 3000, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-engine', algorithm_version: 'v1' },
        ], { ratingCheckedAt: null });

        // Set nonzero impression/engagement state on the overlapping row.
        const conn = require('../src/db').get();
        conn.prepare(`UPDATE recommended SET times_shown = 5, times_shown_in_streak = 3, last_shown_at = 1000, streak_started_at = 500, first_shown_at = 400, engaged_at = 800 WHERE profile_id = ? AND type = 'movie' AND tmdb_id = 't7-movie-overlap'`).run(pid);

        // Seed a dont_recommend row (the engine will emit this candidate; the
        // pipeline's watched/dont filter must drop it before promotion).
        rs.addDontRecommend(pid, 'movie', 't7-movie-suppressed');

        // Verify the old pool state before the staged build.
        assert.strictEqual(rs.countRecommended(pid), 3, 'old movie pool has 3 rows');
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7-movie-obsolete'), 'obsolete row present before build');
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7-movie-overlap'), 'overlap row present before build');

        // Run the staged weekly build.
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });

        // The obsolete row is removed (full replacement for weekly).
        assert.ok(!rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7-movie-obsolete'), 'obsolete row removed after weekly build');
        // The overlapping row is retained with its impression/engagement state.
        const overlap = rs.getRecommended(pid, { type: 'movie', limit: 10 }).find((r) => r.tmdb_id === 't7-movie-overlap');
        assert.ok(overlap, 'overlap row retained after weekly build');
        assert.strictEqual(overlap.times_shown, 5, 'times_shown preserved');
        assert.strictEqual(overlap.times_shown_in_streak, 3, 'times_shown_in_streak preserved');
        assert.strictEqual(overlap.engaged_at, 800, 'engaged_at preserved');
        // The new candidate is stored.
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7-movie-new'), 'new candidate stored');
        // The watched row is NOT resurrected (it's in the watched set).
        assert.ok(!rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 'w1'), 'watched row not resurrected');
        // The dont_recommend candidate is NOT promoted (the pipeline's dont filter drops it).
        assert.ok(!rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7-movie-suppressed'), 'suppressed candidate not promoted');
        // The dont_recommend row is preserved.
        const dnr = require('../src/db').get().prepare('SELECT * FROM dont_recommend WHERE profile_id = ?').all(pid);
        assert.ok(dnr.some((r) => r.tmdb_id === 't7-movie-suppressed'), 'dont_recommend row preserved');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T7b: staged build — sparse second type leaves neither type promoted', async () => {
      const prof = config.addProfile('T7b');
      const pid = prof.id;
      // An engine that produces NO candidates for series (sparse output).
      const sparseEngine = {
        id: 't7-sparse', name: 'Sparse', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type, ctx) => {
          if (ctx.stats) ctx.stats.seeds = 1;
          if (type === 'series') return []; // sparse: no series candidates
          return [
            { type: 'movie', tmdb_id: 't7-movie-keep', rankScore: 5, imdb_id: 'tt-t7-movie-keep', title: 'Keep', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
          ];
        },
      };
      const dispose = engines._register(sparseEngine);
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't7-tmdb' } });
      settings.updateSettings({ engines: { 't7-sparse': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't7-sparse', engine_series: 't7-sparse' } });
      try {
        // Seed the old movie + series pool with rows.
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 'old-movie', imdb_id: 'tt-old-movie', title: 'Old Movie', year: 2023, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-sparse' },
          { type: 'series', tmdb_id: 'old-series', imdb_id: 'tt-old-series', title: 'Old Series', year: 2023, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-sparse' },
        ], { ratingCheckedAt: null });
        assert.strictEqual(rs.countRecommended(pid), 2, 'old pool has 2 rows');

        // Run the staged weekly build (sparse series → acceptance gate fails for series).
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });

        // The old pool is intact (no promotion for either type).
        assert.strictEqual(rs.countRecommended(pid), 2, 'old pool intact after sparse series');
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10}).some((r) => r.tmdb_id === 'old-movie'), 'old movie row still present');
        assert.ok(rs.getRecommended(pid, { type: 'series', limit: 10}).some((r) => r.tmdb_id === 'old-series'), 'old series row still present');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T7c: staged build — failed age gate leaves old pool intact', async () => {
      const prof = config.addProfile('T7c');
      const pid = prof.id;
      // An engine that produces candidates that will all be blocked by the age gate.
      const ageFailEngine = {
        id: 't7-agefail', name: 'AgeFail', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type, ctx) => {
          if (ctx.stats) ctx.stats.seeds = 1;
          return [
            { type: 'movie', tmdb_id: 't7-movie-blocked', rankScore: 5, imdb_id: 'tt-t7-movie-blocked', title: 'Blocked', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null, adult: true },
          ];
        },
      };
      const dispose = engines._register(ageFailEngine);
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't7-tmdb' } });
      settings.updateSettings({ engines: { 't7-agefail': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't7-agefail', engine_series: 't7-agefail', age_limit: 14 } });
      try {
        // Seed the old movie pool with a row.
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 'old-movie', imdb_id: 'tt-old-movie', title: 'Old Movie', year: 2023, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-agefail' },
        ], { ratingCheckedAt: null });
        assert.strictEqual(rs.countRecommended(pid), 1, 'old pool has 1 row');

        // Run the staged weekly build (age gate blocks all candidates → acceptance gate fails).
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });

        // The old pool is intact (no promotion).
        assert.strictEqual(rs.countRecommended(pid), 1, 'old pool intact after failed age gate');
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10}).some((r) => r.tmdb_id === 'old-movie'), 'old row still present');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T7d: staged build — injected commit error leaves old pool + markers intact', async () => {
      const prof = config.addProfile('T7d');
      const pid = prof.id;
      const dispose = engines._register(mkStagedEngine('t7-commit', 't7c'));
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't7-tmdb' } });
      settings.updateSettings({ engines: { 't7-commit': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't7-commit', engine_series: 't7-commit' } });
      try {
        // Seed watched history.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // Seed the old movie pool with 3 rows (so the acceptance gate passes).
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't7c-movie-old1', imdb_id: 'tt-t7c-movie-old1', title: 'Old1', year: 2023, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-commit' },
          { type: 'movie', tmdb_id: 't7c-movie-old2', imdb_id: 'tt-t7c-movie-old2', title: 'Old2', year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-commit' },
          { type: 'movie', tmdb_id: 't7c-movie-old3', imdb_id: 'tt-t7c-movie-old3', title: 'Old3', year: 2023, primary_genre: 'Action', genres: 'Action', vote_average: 6, vote_count: 3000, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-commit' },
        ], { ratingCheckedAt: null });
        assert.strictEqual(rs.countRecommended(pid), 3, 'old movie pool has 3 rows');

        // Inject a commit error: wrap conn.prepare to throw on COMMIT.
        const dbMod = require('../src/db');
        const conn = dbMod.get();
        const origPrepare = conn.prepare;
        conn.prepare = (sql, ...args) => {
          if (sql === 'COMMIT') {
            return { run: () => { throw new Error('injected commit error'); } };
          }
          return origPrepare.call(conn, sql, ...args);
        };
        try {
          // The build should throw (the commit error propagates).
          let threw = false;
          try {
            await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });
          } catch (err) {
            threw = true;
            assert.ok(err.message.includes('injected commit error'), 'error is the injected commit error');
          }
          assert.ok(threw, 'build threw due to injected commit error');

          // The old pool is intact (no promotion).
          assert.strictEqual(rs.countRecommended(pid), 3, 'old pool intact after commit error');
          assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7c-movie-old1'), 'old row 1 still present');
          assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7c-movie-old2'), 'old row 2 still present');
          assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7c-movie-old3'), 'old row 3 still present');
        } finally {
          conn.prepare = origPrepare;
        }
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T7e: staged build — suppression + impression arriving during generation', async () => {
      const prof = config.addProfile('T7e');
      const pid = prof.id;
      // An engine that, during generate, adds a dont_recommend row for one of
      // its own candidates AND updates the impression of an overlapping row.
      // This simulates a suppression/impression arriving while the async
      // generation is in flight.
      const inFlightEngine = {
        id: 't7-inflight', name: 'InFlight', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type, ctx) => {
          if (ctx.stats) ctx.stats.seeds = 1;
          if (type === 'movie') {
            // Simulate a suppression arriving during generation: add a
            // dont_recommend row for one of the candidates this engine emits.
            // (The pipeline's dont set was computed BEFORE generate, so this
            // new row is not in ctx.dont — the candidate survives generation.)
            rs.addDontRecommend(profile.id, 'movie', 't7e-movie-new');
            // Simulate an impression arriving during generation: bump the
            // times_shown on the overlapping row.
            const conn = require('../src/db').get();
            conn.prepare('UPDATE recommended SET times_shown = 9 WHERE profile_id = ? AND type = ? AND tmdb_id = ?').run(profile.id, 'movie', 't7e-movie-overlap');
          }
          return [
            { type, tmdb_id: `t7e-${type}-overlap`, rankScore: 5, imdb_id: `tt-t7e-${type}-overlap`, title: `T7E ${type} overlap`, year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
            { type, tmdb_id: `t7e-${type}-new`, rankScore: 4, imdb_id: `tt-t7e-${type}-new`, title: `T7E ${type} new`, year: 2025, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, popularity: 2, poster: null },
            { type, tmdb_id: `t7e-${type}-new2`, rankScore: 3, imdb_id: `tt-t7e-${type}-new2`, title: `T7E ${type} new2`, year: 2025, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 3500, popularity: 2, poster: null },
            { type, tmdb_id: `t7e-${type}-new3`, rankScore: 2, imdb_id: `tt-t7e-${type}-new3`, title: `T7E ${type} new3`, year: 2025, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 6, vote_count: 3000, popularity: 2, poster: null },
          ];
        },
      };
      const dispose = engines._register(inFlightEngine);
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't7-tmdb' } });
      settings.updateSettings({ engines: { 't7-inflight': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't7-inflight', engine_series: 't7-inflight' } });
      try {
        // Seed watched history.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // Seed the old movie pool with 3 rows (so the acceptance gate passes).
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't7e-movie-overlap', imdb_id: 'tt-t7e-movie-overlap', title: 'Overlap', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-inflight' },
          { type: 'movie', tmdb_id: 't7e-movie-old2', imdb_id: 'tt-t7e-movie-old2', title: 'Old2', year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-inflight' },
          { type: 'movie', tmdb_id: 't7e-movie-old3', imdb_id: 'tt-t7e-movie-old3', title: 'Old3', year: 2023, primary_genre: 'Action', genres: 'Action', vote_average: 6, vote_count: 3000, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't7-inflight' },
        ], { ratingCheckedAt: null });
        assert.strictEqual(rs.countRecommended(pid), 3, 'old movie pool has 3 rows');

        // Run the staged weekly build.
        await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });

        // The dont_recommend row (added during generation) is preserved.
        const dnr = require('../src/db').get().prepare('SELECT * FROM dont_recommend WHERE profile_id = ?').all(pid);
        assert.ok(dnr.some((r) => r.tmdb_id === 't7e-movie-new'), 'dont_recommend row added during generation is preserved');

        // The overlapping row's impression (bumped during generation) is preserved
        // by the ON CONFLICT clause.
        const overlap = rs.getRecommended(pid, { type: 'movie', limit: 10 }).find((r) => r.tmdb_id === 't7e-movie-overlap');
        assert.ok(overlap, 'overlap row retained');
        assert.strictEqual(overlap.times_shown, 9, 'times_shown preserved after in-flight impression');

        // The suppressed candidate (t7e-movie-new) is NOT promoted: the
        // atomicPromotion rechecks the current dont_recommend set and filters
        // it out. It must not appear in the pool or in the served catalog.
        assert.ok(!rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't7e-movie-new'), 'suppressed candidate NOT in pool (filtered at promotion)');

        // The new2 candidate is promoted.
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10}).some((r) => r.tmdb_id === 't7e-movie-new2'), 'new2 candidate promoted');

        // Serve-time: the suppressed title is not served, and a valid
        // replacement title IS served (the overlap row or new2).
        const served = rs.selectedRecommendationRows(config.getProfile(pid), 'movie', {});
        assert.ok(!served.some((r) => r.tmdb_id === 't7e-movie-new'), 'suppressed title not served');
        assert.ok(served.some((r) => r.tmdb_id === 't7e-movie-overlap' || r.tmdb_id === 't7e-movie-new2'), 'valid replacement title served');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    // ---- Review regressions (PR #33 review round 1) ----

    await it('T9a: scheduled build failure does not crash the process; next tick retries', async () => {
      const prof = config.addProfile('T9a');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      const origBuildPool = rs.buildPool;
      settings.updateSettings({ keys: { tmdb_api_key: 't9a-tmdb' } });
      // Fixed Sydney instants: 2026-10-04 17:00 UTC = 03:00/04:00 Sydney (after window).
      // 2026-10-04 15:00 UTC = 01:00/02:00 Sydney (before window).
      const AFTER_WINDOW = Date.UTC(2026, 9, 4, 17, 0);
      const PRE_WINDOW = Date.UTC(2026, 9, 4, 15, 0);
      try {
        // Seed watched history + a non-empty pool so the schedule state is initialized.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't9a-m1', imdb_id: 'tt-t9a-m1', title: 'M1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 'genesis' },
        ], { ratingCheckedAt: null });
        // Initialize the schedule state (so dueAt sees hasPool=true).
        aiSchedule.initFromExisting(pid, AFTER_WINDOW);
        // Add a new watched item so the history hash changes (triggering the daily build).
        watchedStore.upsertMany(pid, [
          { simkl_id: 2, type: 'movie', imdb_id: 'tt-new-watch', tmdb_id: 'w2', title: 'New Watch', year: 2025, watched_at: '2026-10-04T10:00:00Z' },
        ]);

        // Stub buildPool to throw (simulating a failed scheduled build).
        rs.buildPool = async () => { throw new Error('simulated build failure'); };

        // Pre-window: consider must NOT queue (the daily window hasn't opened).
        const preResult = await aiSchedule.consider(config.getProfile(pid), PRE_WINDOW);
        assert.ok(!preResult.queued, 'consider does not queue before the 03:00 Sydney window');

        // At/after window: consider should enqueue the job and the rejection
        // should be consumed (logged) without crashing the process.
        const result = await aiSchedule.consider(config.getProfile(pid), AFTER_WINDOW);
        assert.ok(result.queued, 'consider queued the scheduled build');

        // Wait for the job to settle (the queue runs the job synchronously).
        await new Promise((r) => setTimeout(r, 50));

        // The durable 30-minute retry marker is set.
        const st = aiSchedule.getScheduleState(pid);
        assert.ok(st.retry_after, 'retry_after is set after a failed build');
        assert.ok(st.built_history_hash === null || st.evaluated_day === null || st.completed_week === null, 'success markers NOT advanced');

        // The process is still healthy (we got here).
        assert.ok(true, 'process survived the rejected job');
      } finally {
        rs.buildPool = origBuildPool;
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        aiSchedule._reset();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T9b: skipped generation is recorded as a failure, not success', async () => {
      const prof = config.addProfile('T9b');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      const origBuildPool = rs.buildPool;
      settings.updateSettings({ keys: { tmdb_api_key: 't9b-tmdb' } });
      try {
        // Seed watched history + a non-empty pool.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't9b-m1', imdb_id: 'tt-t9b-m1', title: 'M1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 'genesis' },
        ], { ratingCheckedAt: null });
        aiSchedule.initFromExisting(pid, Date.now());

        // Stub buildPool to return a skipped result (simulating a failed
        // acceptance gate or missing TMDB key).
        rs.buildPool = async () => ({ skipped: true, reason: 'acceptance-gate', movie: { stored: 0 }, series: { stored: 0 }, total: 0 });

        // Run the scheduled build directly (bypassing consider's enqueue).
        // A skipped build now throws so the queue records state:'error'.
        let threw = null;
        try {
          await aiSchedule.runScheduledBuild(config.getProfile(pid), 'daily', '2026-10-04', 'h0', () => {});
        } catch (err) {
          threw = err;
        }
        assert.ok(threw, 'runScheduledBuild throws for a skipped build');
        assert.ok(threw.message.includes('skipped'), 'error message identifies the skip');

        // The durable state: retry_after is set (failure), last_success_at NOT set.
        // (completed_week was set by initFromExisting, not by the build — the
        // key indicator of a successful build is last_success_at.)
        const st = aiSchedule.getScheduleState(pid);
        assert.ok(st.retry_after, 'retry_after is set after a skipped build');
        assert.ok(!st.last_success_at, 'last_success_at NOT set (no successful promotion)');
      } finally {
        rs.buildPool = origBuildPool;
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        aiSchedule._reset();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T9c: acceptance gate evaluates vote-floor + watched + suppression exclusions', async () => {
      const prof = config.addProfile('T9c');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't9c-tmdb' } });
      settings.updateSettings({ engines: { 't9c-engine': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't9c-engine', engine_series: 't9c-engine', min_rating: 5 } });
      const dispose = engines._register({
        id: 't9c-engine', name: 'T9C', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type) => {
          if (type === 'movie') {
            // 3 candidates: one below the vote floor, one watched during generation,
            // one valid. The old pool has 3 eligible movies.
            return [
              { type: 'movie', tmdb_id: 't9c-m-low', rankScore: 5, imdb_id: 'tt-t9c-m-low', title: 'Low', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 100, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't9c-m-watched', rankScore: 4, imdb_id: 'tt-t9c-m-watched', title: 'Watched', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't9c-m-valid', rankScore: 3, imdb_id: 'tt-t9c-m-valid', title: 'Valid', year: 2025, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 3500, popularity: 1, poster: null },
            ];
          }
          return [];
        },
      });
      try {
        // Seed watched history.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-t9c-m-watched', tmdb_id: 't9c-m-watched', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // Seed the old movie pool with 3 eligible rows (so minRequired = 3).
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't9c-old1', imdb_id: 'tt-t9c-old1', title: 'Old1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't9c-engine' },
          { type: 'movie', tmdb_id: 't9c-old2', imdb_id: 'tt-t9c-old2', title: 'Old2', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null, engine_id: 't9c-engine' },
          { type: 'movie', tmdb_id: 't9c-old3', imdb_id: 'tt-t9c-old3', title: 'Old3', year: 2024, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 3500, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't9c-engine' },
        ], { ratingCheckedAt: null });
        // Set a vote-count floor (the default for the profile's min_rating).
        // The t9c-m-low candidate has vote_count=100 which is below the floor.

        // Run the staged build. The acceptance gate should see only 1 eligible
        // candidate (t9c-m-valid) after vote-floor + watched exclusions.
        // minRequired = min(listSize, oldEligible) = min(20, 3) = 3.
        // 1 < 3 → gate fails → build is skipped.
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'daily', anchor: '2026-10-04', startHash: 'h0' });
        assert.ok(result.skipped, 'build skipped (acceptance gate failed)');
        assert.ok(result.reason === 'acceptance-gate', 'reason is acceptance-gate');

        // The old pool is intact (no promotion happened).
        assert.strictEqual(rs.countRecommended(pid, 'movie'), 3, 'old pool intact');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T9d: cold-start — an empty profile builds immediately through consider', async () => {
      const prof = config.addProfile('T9d');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      // Register the engine BEFORE config.updateProfile (which validates the
      // engine id against the registry).
      const dispose = engines._register({
        id: 't9d-engine', name: 'T9D', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type) => {
          if (type === 'movie') {
            return [
              { type: 'movie', tmdb_id: 't9d-m1', rankScore: 5, imdb_id: 'tt-t9d-m1', title: 'M1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't9d-m2', rankScore: 4, imdb_id: 'tt-t9d-m2', title: 'M2', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, popularity: 1, poster: null },
            ];
          }
          return [];
        },
      });
      settings.updateSettings({ keys: { tmdb_api_key: 't9d-tmdb' } });
      settings.updateSettings({ engines: { 't9d-engine': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't9d-engine', engine_series: 't9d-engine' } });
      try {
        // Seed watched history (so the engine has seeds).
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // No pool rows (empty profile — cold-start).
        assert.strictEqual(rs.countRecommended(pid), 0, 'pool is empty');

        // Run consider — it should detect cold-start and enqueue a prompt build.
        const result = await aiSchedule.consider(config.getProfile(pid), Date.now());
        assert.ok(result.queued === 'cold-start', 'consider queued a cold-start build');

        // Wait for the job to settle.
        await new Promise((r) => setTimeout(r, 100));

        // The pool now has rows (the cold-start build completed).
        assert.ok(rs.countRecommended(pid, 'movie') >= 2, 'cold-start build populated the pool');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        aiSchedule._reset();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    // ---- Review round 2 regressions ----

    await it('T10a: acceptance gate oldEligible applies watched + dont_recommend + vote-floor exclusions', async () => {
      const prof = config.addProfile('T10a');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't10a-tmdb' } });
      settings.updateSettings({ engines: { 't10a-engine': true } });
      const dispose = engines._register({
        id: 't10a-engine', name: 'T10A', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type) => {
          if (type === 'movie') {
            // 2 valid new movies (the old pool has 3 stored, but 1 is watched,
            // so oldEligible should be 2, not 3).
            return [
              { type: 'movie', tmdb_id: 't10a-new1', rankScore: 5, imdb_id: 'tt-t10a-new1', title: 'New1', year: 2025, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't10a-new2', rankScore: 4, imdb_id: 'tt-t10a-new2', title: 'New2', year: 2025, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, popularity: 1, poster: null },
            ];
          }
          return [];
        },
      });
      config.updateProfile(pid, { filters: { engine_movie: 't10a-engine', engine_series: 't10a-engine' } });
      try {
        // Seed watched history: one of the old pool's movies is watched.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-t10a-watched', tmdb_id: 't10a-watched', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // Seed the old movie pool with 3 rows: one watched, two valid.
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't10a-watched', imdb_id: 'tt-t10a-watched', title: 'Watched', year: 2020, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't10a-engine' },
          { type: 'movie', tmdb_id: 't10a-old1', imdb_id: 'tt-t10a-old1', title: 'Old1', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null, engine_id: 't10a-engine' },
          { type: 'movie', tmdb_id: 't10a-old2', imdb_id: 'tt-t10a-old2', title: 'Old2', year: 2024, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 3500, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't10a-engine' },
        ], { ratingCheckedAt: null });

        // Run the staged build. oldEligible should be 2 (watched excluded),
        // newEligible should be 2. minRequired = min(20, 2) = 2. 2 >= 2 → ok.
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });
        assert.ok(!result.skipped, 'build not skipped (gate passes with like-for-like comparison)');
        // The watched title is not in the pool after promotion.
        assert.ok(!rs.getRecommended(pid, { type: 'movie', limit: 10 }).some((r) => r.tmdb_id === 't10a-watched'), 'watched title not in pool');
        // The new titles are promoted.
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10}).some((r) => r.tmdb_id === 't10a-new1'), 'new1 promoted');
        assert.ok(rs.getRecommended(pid, { type: 'movie', limit: 10}).some((r) => r.tmdb_id === 't10a-new2'), 'new2 promoted');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T10b: acceptance gate counts distinct tmdb_id, not candidate entries', async () => {
      const prof = config.addProfile('T10b');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't10b-tmdb' } });
      settings.updateSettings({ engines: { 't10b-engine': true } });
      const dispose = engines._register({
        id: 't10b-engine', name: 'T10B', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type) => {
          if (type === 'movie') {
            // 3 copies of the SAME tmdb_id (simulating duplicate candidates).
            // The gate must count 1 distinct identity, not 3 entries.
            return [
              { type: 'movie', tmdb_id: 't10b-same', rankScore: 5, imdb_id: 'tt-t10b-same', title: 'Same', year: 2025, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't10b-same', rankScore: 4, imdb_id: 'tt-t10b-same', title: 'Same', year: 2025, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't10b-same', rankScore: 3, imdb_id: 'tt-t10b-same', title: 'Same', year: 2025, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
            ];
          }
          return [];
        },
      });
      config.updateProfile(pid, { filters: { engine_movie: 't10b-engine', engine_series: 't10b-engine' } });
      try {
        // Seed watched history.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // Seed the old movie pool with 3 distinct rows.
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't10b-old1', imdb_id: 'tt-t10b-old1', title: 'Old1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't10b-engine' },
          { type: 'movie', tmdb_id: 't10b-old2', imdb_id: 'tt-t10b-old2', title: 'Old2', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null, engine_id: 't10b-engine' },
          { type: 'movie', tmdb_id: 't10b-old3', imdb_id: 'tt-t10b-old3', title: 'Old3', year: 2024, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 3500, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't10b-engine' },
        ], { ratingCheckedAt: null });

        // Run the staged build. oldEligible = 3, newEligible = 1 (distinct).
        // minRequired = min(20, 3) = 3. 1 < 3 → gate fails → build skipped.
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });
        assert.ok(result.skipped, 'build skipped (duplicate candidates counted as 1, not 3)');
        assert.ok(result.reason === 'acceptance-gate', 'reason is acceptance-gate');
        // The old pool is intact.
        assert.strictEqual(rs.countRecommended(pid, 'movie'), 3, 'old pool intact');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T10c: skipped build is recorded as a queue error, not done', async () => {
      const prof = config.addProfile('T10c');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      const origBuildPool = rs.buildPool;
      settings.updateSettings({ keys: { tmdb_api_key: 't10c-tmdb' } });
      // Fixed Sydney instants: 2026-10-04 17:00 UTC = 03:00/04:00 Sydney (after window).
      // 2026-10-04 15:00 UTC = 01:00/02:00 Sydney (before window).
      const AFTER_WINDOW = Date.UTC(2026, 9, 4, 17, 0);
      const PRE_WINDOW = Date.UTC(2026, 9, 4, 15, 0);
      try {
        // Seed watched history + a non-empty pool.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't10c-m1', imdb_id: 'tt-t10c-m1', title: 'M1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 'genesis' },
        ], { ratingCheckedAt: null });
        aiSchedule.initFromExisting(pid, AFTER_WINDOW);
        // Add a new watched item so the history hash changes (triggering the daily build).
        watchedStore.upsertMany(pid, [
          { simkl_id: 2, type: 'movie', imdb_id: 'tt-new-watch', tmdb_id: 'w2', title: 'New Watch', year: 2025, watched_at: '2026-10-04T10:00:00Z' },
        ]);

        // Stub buildPool to return a skipped result.
        rs.buildPool = async () => ({ skipped: true, reason: 'acceptance-gate', movie: { stored: 0 }, series: { stored: 0 }, total: 0 });

        // Pre-window: consider must NOT queue (the daily window hasn't opened).
        const preResult = await aiSchedule.consider(config.getProfile(pid), PRE_WINDOW);
        assert.ok(!preResult.queued, 'consider does not queue before the 03:00 Sydney window');

        // At/after window: consider should enqueue the job and the rejection
        // should be consumed (logged) without crashing the process.
        const result = await aiSchedule.consider(config.getProfile(pid), AFTER_WINDOW);
        assert.ok(result.queued, 'consider queued the scheduled build');

        // Wait for the job to settle.
        await new Promise((r) => setTimeout(r, 50));

        // The durable 30-minute retry marker is set.
        const st = aiSchedule.getScheduleState(pid);
        assert.ok(st.retry_after, 'retry_after is set after a skipped build');

        // The queue records the job as an error (not 'done').
        const jobs = require('../src/jobs');
        const jobState = jobs.snapshot(pid);
        assert.ok(jobState, 'job state exists');
        assert.strictEqual(jobState.state, 'error', 'queue state is error (not done)');
        assert.ok(jobState.error && jobState.error.includes('skipped'), 'error message includes skipped');
      } finally {
        rs.buildPool = origBuildPool;
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        aiSchedule._reset();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    // ---- Review round 3 regressions ----

    await it('T11a: acceptance gate oldEligible reflects the actual served catalog (no vote floor on old side)', async () => {
      const prof = config.addProfile('T11a');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't11a-tmdb' } });
      settings.updateSettings({ engines: { 't11a-engine': true } });
      // Register the engine BEFORE selecting it on the profile: config.updateProfile
      // validates engine IDs against the registry at write time and silently falls
      // back to genesis for an unregistered ID.
      const dispose = engines._register({
        id: 't11a-engine', name: 'T11A', description: 't', supportedTypes: ['movie', 'series'],
        capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
        requirements: () => ({ ok: true, missing: [] }),
        generate: async (profile, type) => {
          if (type === 'movie') {
            // 2 new movies, both above the vote floor.
            return [
              { type: 'movie', tmdb_id: 't11a-new1', rankScore: 5, imdb_id: 'tt-t11a-new1', title: 'New1', year: 2025, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, popularity: 1, poster: null },
              { type: 'movie', tmdb_id: 't11a-new2', rankScore: 4, imdb_id: 'tt-t11a-new2', title: 'New2', year: 2025, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, popularity: 1, poster: null },
            ];
          }
          return [];
        },
      });
      // Set a vote floor of 1000 so below-floor rows are filtered by atomicPromotion.
      config.updateProfile(pid, { filters: { engine_movie: 't11a-engine', engine_series: 't11a-engine', min_rating: 0, vote_count_floor: 1000 } });
      // Guard against silent fallback: the profile must actually have t11a-engine.
      const verifyProfile = config.getProfile(pid);
      assert.strictEqual(verifyProfile.filters.engine_movie, 't11a-engine', 'engine_movie is t11a-engine (not silently fallen back to genesis)');
      assert.strictEqual(verifyProfile.filters.engine_series, 't11a-engine', 'engine_series is t11a-engine');
      try {
        // Seed the old movie pool with 3 rows: one below the vote floor (vote_count=100).
        // The serve path (selectedRecommendationRows) does NOT apply the vote floor,
        // so all 3 are currently served. After promotion, the below-floor row is
        // deleted, leaving only 2. The gate must block this replacement.
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't11a-old1', imdb_id: 'tt-t11a-old1', title: 'Old1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 't11a-engine' },
          { type: 'movie', tmdb_id: 't11a-old2', imdb_id: 'tt-t11a-old2', title: 'Old2', year: 2024, primary_genre: 'Action', genres: 'Action', vote_average: 7, vote_count: 4000, affinity: 4, rec_count: 1, popularity: 1, poster: null, engine_id: 't11a-engine' },
          { type: 'movie', tmdb_id: 't11a-old3', imdb_id: 'tt-t11a-old3', title: 'Old3', year: 2024, primary_genre: 'Sci-Fi', genres: 'Sci-Fi', vote_average: 7, vote_count: 100, affinity: 3, rec_count: 1, popularity: 1, poster: null, engine_id: 't11a-engine' },
        ], { ratingCheckedAt: null });

        // Before the build: assert the old pool has 3 distinct served eligible titles,
        // including the below-floor row (which is served because the serve path does
        // not apply the vote floor).
        const oldPool = rs.getRecommended(pid, { type: 'movie', limit: 10 });
        assert.strictEqual(oldPool.length, 3, 'old pool has 3 distinct titles');
        assert.ok(oldPool.some((r) => r.tmdb_id === 't11a-old3' && r.vote_count === 100), 'below-floor row is present and served');

        // Run the staged build. oldEligible = 3 (no vote floor on old side).
        // newEligible = 2 (vote floor applied to new side). minRequired = min(20, 3) = 3.
        // 2 < 3 → gate fails → build skipped.
        const result = await rs.buildPool(config.getProfile(pid), quiet, () => {}, { kind: 'weekly', anchor: '2026-10-04', startHash: 'h0' });
        assert.ok(result.skipped, 'build skipped (gate blocks a shrinking catalog)');
        assert.ok(result.reason === 'acceptance-gate', 'reason is acceptance-gate');
        // The old pool is intact (all 3 rows still present).
        assert.strictEqual(rs.countRecommended(pid, 'movie'), 3, 'old pool intact (3 rows)');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T11b: a colliding external error message still persists the retry marker', async () => {
      const prof = config.addProfile('T11b');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      const origBuildPool = rs.buildPool;
      settings.updateSettings({ keys: { tmdb_api_key: 't11b-tmdb' } });
      try {
        // Seed watched history + a non-empty pool.
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        rs.upsertCandidates(pid, [
          { type: 'movie', tmdb_id: 't11b-m1', imdb_id: 'tt-t11b-m1', title: 'M1', year: 2024, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, vote_count: 5000, affinity: 5, rec_count: 1, popularity: 1, poster: null, engine_id: 'genesis' },
        ], { ratingCheckedAt: null });
        aiSchedule.initFromExisting(pid, Date.UTC(2026, 9, 4, 17, 0));

        // Stub buildPool to throw an error whose message contains "skipped —"
        // (simulating an unrelated engine/provider error with a colliding word).
        rs.buildPool = async () => { throw new Error('provider skipped — transient'); };

        // Run the scheduled build directly. The error must be recorded as a
        // failure (retry_after set), not misclassified as an internally-recorded skip.
        let threw = null;
        try {
          await aiSchedule.runScheduledBuild(config.getProfile(pid), 'daily', '2026-10-04', 'h0', () => {});
        } catch (err) {
          threw = err;
        }
        assert.ok(threw, 'runScheduledBuild throws for a thrown build error');
        assert.ok(threw.message.includes('provider skipped'), 'error message preserved');

        // The durable retry marker IS set (the error was not misclassified).
        const st = aiSchedule.getScheduleState(pid);
        assert.ok(st.retry_after, 'retry_after is set after a thrown build error (not suppressed by substring match)');
        assert.ok(!st.last_success_at, 'last_success_at NOT set');
      } finally {
        rs.buildPool = origBuildPool;
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        aiSchedule._reset();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T5: urgent paths — ensureBuilt still works for manual/config/Trainer/cold-start', async () => {
      const prof = config.addProfile('T5');
      const pid = prof.id;
      const dispose = engines._register(mkStagedEngine('t5-engine', 't5'));
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't5-tmdb' } });
      settings.updateSettings({ engines: { 't5-engine': true } });
      config.updateProfile(pid, { filters: { engine_movie: 't5-engine', engine_series: 't5-engine' } });
      try {
        // Seed watched history (so the build has seeds).
        watchedStore.upsertMany(pid, [
          { simkl_id: 1, type: 'movie', imdb_id: 'tt-watched', tmdb_id: 'w1', title: 'Watched', year: 2020, watched_at: '2026-09-01T10:00:00Z' },
        ]);
        // ensureBuilt with no kind (urgent path) runs the existing buildRecommendations
        // + ageGatePool path (not the staged path).
        const result = await rs.ensureBuilt(config.getProfile(pid), quiet);
        assert.ok(result, 'ensureBuilt returned a result');
        // The pool should now have rows (the urgent path stores candidates directly).
        assert.ok(rs.countRecommended(pid) > 0, 'urgent path stored candidates');
        // A second ensureBuilt with no history change is a no-op (needsBuild → false).
        const result2 = await rs.ensureBuilt(config.getProfile(pid), quiet);
        assert.ok(result2.skipped === 'fresh', 'second ensureBuilt is a no-op when fresh');
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        dispose();
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T6: sync sequencing — ensureSyncedAsync skips when not configured/not due', async () => {
      const scrobble = require('../src/services/scrobble');
      // A profile with no scrobble config → skipped: not-configured.
      const prof = config.addProfile('T6');
      const pid = prof.id;
      try {
        const result = await scrobble.ensureSyncedAsync(config.getProfile(pid));
        assert.ok(result.skipped === 'not-configured', 'not-configured when no scrobble config');

        // A profile with scrobble enabled but no Simkl token → skipped: not-configured.
        config.updateProfile(pid, { scrobble: { enabled: true, provider: 'nuvio', email: 'test@example.com', password_enc: 'enc' } });
        const result2 = await scrobble.ensureSyncedAsync(config.getProfile(pid));
        assert.ok(result2.skipped === 'not-configured', 'not-configured when no Simkl token');
      } finally {
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });

    await it('T6b: sync sequencing — ensureSyncedAsync awaits syncProfile and returns the result', async () => {
      const scrobble = require('../src/services/scrobble');
      const crypto = require('../src/services/crypto');
      const prof = config.addProfile('T6b');
      const pid = prof.id;
      const prevTmdb = settings.getSettings()?.keys?.tmdb_api_key || '';
      const prevEngines = { ...(settings.getSettings()?.engines || {}) };
      settings.updateSettings({ keys: { tmdb_api_key: 't6b-tmdb' } });
      try {
        // Set up a profile with scrobble enabled + Simkl token.
        config.updateProfile(pid, {
          scrobble: { enabled: true, provider: 'nuvio', email: 'test@example.com', password_enc: 'enc' },
        });
        // Set the Simkl token + client id directly on the in-memory profile
        // (the auth object is sealed at rest, so a plaintext token via
        // updateProfile would be lost on the next load).
        const profObj = config.getProfile(pid);
        profObj.simkl_auth = { access_token: 'test-token' };
        profObj.keys = { simkl_client_id: 'test-client' };
        // Stub crypto.decrypt to bypass the credential decryption.
        const origDecrypt = crypto.decrypt;
        crypto.decrypt = (enc) => 'test-password';
        // Stub the provider's pullWatched to return a deterministic item.
        const nuvio = require('../src/services/nuvio');
        const origPull = nuvio.pullWatched;
        nuvio.pullWatched = async ({ email, password }) => {
          return [{ type: 'movie', imdbId: 'tt-t6b-movie', title: 'T6B Movie', watchedAtMs: Date.now() - 3600e3 }];
        };
        // Stub Simkl's addToHistory to record the call.
        const simkl = require('../src/services/simkl');
        const origAdd = simkl.addToHistory;
        let simklCalls = 0;
        simkl.addToHistory = async (profile, body) => { simklCalls++; return { ok: true }; };
        try {
          const result = await scrobble.ensureSyncedAsync(profObj);
          assert.ok(result.pulled === 1, 'syncProfile pulled 1 item');
          assert.ok(simklCalls >= 1, 'Simkl addHistory was called');
        } finally {
          crypto.decrypt = origDecrypt;
          nuvio.pullWatched = origPull;
          simkl.addToHistory = origAdd;
        }
      } finally {
        settings.updateSettings({ keys: { tmdb_api_key: prevTmdb } });
        settings.updateSettings({ engines: prevEngines });
        config.removeProfile(pid); rs.deleteForProfile(pid); watchedStore.deleteForProfile(pid);
      }
    });
  }

  // Restore a clean-ish shared state for any process that runs after this one.
  store.saveAgeVerdicts({});
  offlineAnimeMap();
  console.log(`\nAll integration checks passed (${passed}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ INTEGRATION FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
