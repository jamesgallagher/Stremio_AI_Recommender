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
// The persistent LLM verdict cache key ageGatePool's ACB pass reads:
//   `${type}:${judgementAge}:${tmdb_id}`   (judgementAge = age_limit + 1)
const verdictKey = (type, judgeAge, tmdbId) => `${type}:${judgeAge}:${tmdbId}`;

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
    config.updateProfile(p.id, { filters: { age_limit: 8, engine_movie: 'fake', engine_series: 'fake' } }); // judged at 9
    // Seed the ACB verdict cache so the LLM pass is offline: *-1 unsuitable, rest OK.
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({
      [verdictKey('movie', 9, 'fake-movie-1')]: false,
      [verdictKey('movie', 9, 'fake-movie-2')]: true,
      [verdictKey('movie', 9, 'fake-movie-3')]: true,
      [verdictKey('series', 9, 'fake-series-1')]: false,
      [verdictKey('series', 9, 'fake-series-2')]: true,
      [verdictKey('series', 9, 'fake-series-3')]: true,
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
    config.updateProfile(p.id, { filters: { age_limit: 8, engine_movie: 'nohist', engine_series: 'nohist' } }); // judged at 9
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({ [verdictKey('movie', 9, 'nh-movie-1')]: false, [verdictKey('series', 9, 'nh-series-1')]: false });
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
    config.updateProfile(p.id, { filters: { age_limit: 8, engine_movie: 'fake', engine_series: 'fake' } }); // judged at 9
    const prev = store.loadAgeVerdicts();
    store.saveAgeVerdicts({
      [verdictKey('movie', 9, 'fake-movie-1')]: false, // over-band -> gated out of the pool
      [verdictKey('movie', 9, 'fake-movie-2')]: true,
      [verdictKey('movie', 9, 'fake-movie-3')]: true,
      // Series build also runs (engine_series: fake) — seed its verdicts too so the
      // ACB pass stays offline; all pass (this test only asserts on the movie list).
      [verdictKey('series', 9, 'fake-series-1')]: true,
      [verdictKey('series', 9, 'fake-series-2')]: true,
      [verdictKey('series', 9, 'fake-series-3')]: true,
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
    config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { age_limit: 8, engine_movie: 'glass', engine_series: 'glass' } }); // judged at 9
    const prev = store.loadAgeVerdicts();
    try {
      seedGlassFixtures(p.id);
      // ACB verdict cache: veto tmdb 401 for a 9-year-old; everything else OK. The
      // age gate — NOT the engine — is the authority (I1), proven over a Glass pool.
      store.saveAgeVerdicts({
        [verdictKey('movie', 9, '301')]: true, [verdictKey('movie', 9, '302')]: true,
        [verdictKey('movie', 9, '401')]: false, [verdictKey('movie', 9, '402')]: true,
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
    // First sync: no marquee_sync row → pull once; null rated_at stored as SQL NULL (§12 L2).
    let res = await simklCache.syncRatings(profile, { fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 1000, log: quiet });
    assert.deepStrictEqual(res, { ok: true, synced: 1, unresolved: 0 });
    assert.strictEqual(ratingsCalls, 1);
    const row = db.get().prepare('SELECT ratings_activity, synced_at FROM marquee_sync WHERE profile_id = ?').get('p-simkl');
    assert.strictEqual(row.ratings_activity, null);
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
    db.get().exec('DELETE FROM marquee_ratings; DELETE FROM marquee_sync');
  });

  await it('marquee ME-03: syncRatings replace semantics + zero rated + resolve cap 50 (B4)', async () => {
    const simklCache = require('../src/engines/marquee/simklCache');
    const simkl = require('../src/services/simkl');
    const db = require('../src/db');
    const profile = { id: 'p-replace', name: 'T', keys: { simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } };
    const activities = async () => ({ movies: { rated_at: null } });
    // Seed another profile's row — must survive this profile's replace.
    db.get().prepare('INSERT INTO marquee_ratings (profile_id, tmdb_id, rating) VALUES (?, ?, ?)').run('p-other', '99', 5);
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
    db.get().exec('DELETE FROM marquee_ratings; DELETE FROM marquee_sync');
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
    // weight = ratingWeight × blendedWeight(days): recent rated-10 > unrated recent > old rated-10
    const byId = new Map(seeds.map((s) => [s.tmdb_id, s]));
    const recentDays = (nowMs - Date.parse('2026-05-20T00:00:00Z')) / day;
    const oldDays = (nowMs - Date.parse('2024-06-01T00:00:00Z')) / day;
    const hl = cfg.half_life_days.movie;
    const blend = cfg.horizon_blend;
    const bw = (d) => blend.long * 0.5 ** (d / hl.long) + blend.medium * 0.5 ** (d / hl.medium) + blend.recent * 0.5 ** (d / hl.recent);
    assert.ok(byId.get('1').weight > byId.get('3').weight, 'rated-10 recent beats unrated recent');
    assert.ok(byId.get('3').weight > byId.get('2').weight, 'unrated recent beats old rated-10');
    assert.ok(Math.abs(byId.get('1').weight - 2.0 * bw(recentDays)) < 1e-9);
    assert.ok(Math.abs(byId.get('3').weight - 1.0 * bw(recentDays)) < 1e-9);
    assert.ok(Math.abs(byId.get('2').weight - 2.0 * bw(oldDays)) < 1e-9);
    // sort: weight desc
    assert.deepStrictEqual(seeds.map((s) => s.tmdb_id), ['1', '3', '2']);
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
    db.get().exec('DELETE FROM marquee_ratings; DELETE FROM marquee_sync; DELETE FROM test_scratch');
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
    assert.strictEqual(ctx.stats.raw, 960, 'raw counted');
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
      assert.ok(!ids.includes('h2'), 'kids unknown cert dropped');
      assert.ok(!ids.includes('h3'), 'kids M@10 dropped');
      assert.ok(!ids.includes('h4'), 'kids unknown cert dropped');
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
    assert.strictEqual(stored.algorithm_version, 'marquee-m1', 'algorithm_version = marquee-m1');
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
      config.updateProfile(p.id, { simkl_auth: { access_token: 'x' }, filters: { age_limit: 8, engine_movie: 'marquee', engine_series: 'genesis' } });
      watchedStore.upsertMany(p.id, [
        { simkl_id: 1, type: 'movie', imdb_id: 'ttmqi1w', tmdb_id: 'mqi1w', title: 'Watched', year: 2024, watched_at: '2026-05-01T00:00:00Z' },
      ]);
      // Verdict cache (judgementAge = 8 + 1 = 9): veto mqi1b, keep the other two.
      store.saveAgeVerdicts({
        [verdictKey('movie', 9, 'mqi1a')]: true,
        [verdictKey('movie', 9, 'mqi1b')]: false,
        [verdictKey('movie', 9, 'mqi1c')]: true,
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
    const filters = { min_rating: 7, max_age_years: 10, age_limit: 10, excluded_genres: ['Horror'], list_size: 20 };
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
      // The 20 passers (n1–n4 per seed): verdict true for each (judgementAge = 10 + 1 = 11).
      const passers = [];
      for (const s of seeds) for (const n of ['1', '2', '3', '4']) passers.push(s + n);
      const verdicts = {};
      for (const id of passers) verdicts[verdictKey('movie', 11, id)] = true;
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
    config.updateProfile(p.id, { filters: { age_limit: 8 } }); // judged at 9
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
