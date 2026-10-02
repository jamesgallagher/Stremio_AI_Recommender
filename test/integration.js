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

  await it('Trainer T1: tasteFeedback.syncRatings — type-scoped, series throws not-supported, movie never touches series rows (test 3)', async () => {
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
    // series → not-supported (the ONLY throw in the store).
    await assert.rejects(() => tasteFeedback.syncRatings(profile, { type: 'series', fetchActivities: async () => ({ movies: { rated_at: null } }), fetchRatings, now: 3000, log: quiet }), /not-supported/);
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
    // bad-type (series → not-supported).
    res = await trainer.setIgnored(profile, { type: 'series', tmdb_id: '1' }, true, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-supported' });
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
    // bad-view / bad-type / not-supported.
    res = await trainer.listHistory(profile, { type: 'movie', view: 'bogus' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'bad-view' });
    res = await trainer.listHistory(profile, { type: 'series' }, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-supported' });
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
    // 'series' → not-supported; 'anime' → bad-type.
    res = await trainer.rate(profile, { type: 'series', tmdb_id: '1' }, 5, deps);
    assert.deepStrictEqual(res, { ok: false, reason: 'not-supported' });
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
    assert.strictEqual(stored.algorithm_version, 'marquee-m3', 'algorithm_version = marquee-m3');
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
    const cfg = { ...mqCfgResolved, lookup_cap: 30, exploration_pct: 0 };
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
    assert.strictEqual(by.get('sa1').algorithmVersion, 'marquee-m3');
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
      // Portal View (the portal.js code path: selectServeFor over getRecommended).
      const portal = rs.selectServeFor(profile, 'movie', rs.getRecommended(p.id, { type: 'movie', limit: 100000 }), { limit: listSize });
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
      assert.deepStrictEqual(ids, ['gen1', 'new1', 'new2'], 'v1 row pruned; genesis row kept');
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
