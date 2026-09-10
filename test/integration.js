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
