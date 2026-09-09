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
const { fake, fakeOpen, makeEngine } = require('./fixtures/fake-engine');

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
