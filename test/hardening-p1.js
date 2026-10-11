// Hardening phase 1 — child safety + typed ids (no network). Run via `npm test`.
//   F3 unjudged titles dropped (re-ask once)   F4 fail-closed serve   F5 Companion search gate
//   F6 admin-managed filters on age-limited profiles   F10 typed TMDB ids
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-hard1-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
const assert = require('assert');

let n = 0;
async function ok(name, fn) { await fn(); n++; console.log(`  ✓ ${name}`); }
const quiet = { log() {}, warn() {} };

(async () => {
  console.log('hardening phase 1:');
  const config = require('../src/config');
  const rs = require('../src/recommendationStore');
  const ageVerify = require('../src/ageVerification');
  const verdictStore = require('../src/ageVerification/store');
  const groq = require('../src/services/groq');
  const llm = require('../src/services/llm');
  const settings = require('../src/settings');
  const watchedStore = require('../src/watchedStore');
  const tier = ageVerify.tierFor({ age_limit: 14 });
  assert.ok(tier, 'age_limit 14 has a tier');

  // A chain source set where nothing is rated, so every title reaches the LLM step.
  const emptySources = (llmGate) => {
    const none = async () => new Map();
    return { tmdbRatings: none, csmAges: none, csmAgesReviewed: none, simklCerts: none, mdblistCerts: none, tvdbRatings: none, llmGate };
  };

  await ok('F3: a title the LLM never answers is DROPPED by verify() (fail-closed) and NOT recorded', async () => {
    const stamp = Date.now();
    const titles = ['a', 'b'].map((x) => ({ key: `series:${x}${stamp}`, imdb_id: `tt${x}${stamp}`, title: x, year: 2020, genres: [] }));
    // The model answers only 'a' (allow); 'b' is omitted.
    const sources = emptySources(async () => new Map([[titles[0].key, true]]));
    const res = await ageVerify.verify(titles, 'series', tier, sources, quiet);
    assert.strictEqual(res.get(titles[0].key).verdict, 'allow');
    assert.strictEqual(res.get(titles[1].key).verdict, 'block');
    assert.strictEqual(res.get(titles[1].key).source, 'unjudged');
    assert.strictEqual(verdictStore.getVerdict('series', `b${stamp}`, tier.id), null, 'an unjudged title must not be cached');
    assert.ok(verdictStore.getVerdict('series', `a${stamp}`, tier.id), 'a real verdict is cached');
  });

  await ok('F3: groq.ageGate re-asks omitted titles ONCE, then leaves them unanswered (uncached)', async () => {
    const origChat = llm.chat; const origChain = settings.llmChain;
    settings.llmChain = () => [{ type: 'custom' }];
    let calls = 0;
    llm.chat = async (chain, msgs, opts) => {
      calls++;
      if (calls > 1) throw new Error('model refused'); // the re-ask fails
      return opts.validate(JSON.stringify([{ id: 'a', ok: true }, { id: 'b', ok: true }, { id: 'c', ok: false }, { id: 'd', ok: true }]));
    };
    try {
      const stamp = Date.now();
      const titles = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, cacheId: `${id}-${stamp}`, title: id, year: 2020 }));
      const veto = await groq.ageGate('movie', 15, titles, quiet, { tier });
      assert.deepStrictEqual([...veto].sort(), ['c']);   // e is simply unanswered (verify() drops it)
      assert.strictEqual(calls, 2, 're-asked exactly once');
      const cache = require('../src/store').loadAgeVerdicts();
      assert.ok(!Object.keys(cache).some((k) => k.endsWith(`e-${stamp}`)), 'the unanswered title is not cached');
    } finally { llm.chat = origChat; settings.llmChain = origChain; }
  });

  await ok('F4: age-limited profiles never SERVE a row nothing has vetted; adults are unaffected', async () => {
    const f = { age_limit: 14 };
    const stamp = Date.now();
    const mk = (id, extra) => ({ type: 'movie', tmdb_id: id, imdb_id: 'tt' + id, title: id, year: 2020, primary_genre: 'Drama', genres: 'Drama', vote_average: 8, affinity: 1, ...extra });
    // unvetted: no verdict, no classification
    assert.strictEqual(rs.passesAgeBand(mk('h1' + stamp), f), false);
    // a stored ALLOW verdict
    verdictStore.recordVerdict('movie', 'h2' + stamp, tier.id, 'allow', 'au', 'PG');
    assert.strictEqual(rs.passesAgeBand(mk('h2' + stamp), f), true);
    // a stored BLOCK verdict
    verdictStore.recordVerdict('movie', 'h3' + stamp, tier.id, 'block', 'au', 'R 18+');
    assert.strictEqual(rs.passesAgeBand(mk('h3' + stamp), f), false);
    // positive stored classification (Marquee rows carry a raw certificate)
    assert.strictEqual(rs.passesAgeBand(mk('h4' + stamp, { certification: 'PG' }), f), true);
    assert.strictEqual(rs.passesAgeBand(mk('h5' + stamp, { certification: 'R 18+' }), f), false);
    // adults: never held back
    assert.strictEqual(rs.passesAgeBand(mk('h6' + stamp), {}), true);
    // and through selectServe
    const rows = [mk('s1' + stamp), mk('s2' + stamp, { certification: 'PG' })];
    assert.deepStrictEqual(rs.selectServe(rows, f, { nowYear: 2026 }).map((r) => r.tmdb_id), ['s2' + stamp]);
    assert.strictEqual(rs.selectServe(rows, {}, { nowYear: 2026 }).length, 2);
  });

  await ok('F5: Companion search — adults skip the age chain/LLM; age-limited are filtered; a gate failure returns NO results', async () => {
    const handlers = require('../mobile/server/handlers');
    const tmdb = require('../src/services/tmdb');
    const rebuildMod = require('../src/rebuild');
    const srcMod = require('../src/ageVerification/sources');
    const o = { s: tmdb.searchTitles, a: rebuildMod.applyAnimeGate, b: srcMod.buildSources };
    const mkMetas = () => [
      { id: 'tt1', name: 'Kid Film', _tmdb_id: 1, releaseInfo: '2020', description: 'ok' },
      { id: 'tt2', name: 'Grim Film', _tmdb_id: 2, releaseInfo: '2019', description: 'dark' },
    ];
    let chainCalls = 0;
    tmdb.searchTitles = async () => mkMetas();
    rebuildMod.applyAnimeGate = async (m) => m;
    srcMod.buildSources = () => emptySources(async (type, t, list) => {
      chainCalls++;
      return new Map(list.map((x) => [x.key, !/Grim/.test(x.title)]));
    });
    const fakeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
    try {
      const keys = { tmdb_api_key: 'k' };
      let res = fakeRes();
      await handlers.searchHandler({ query: { q: 'film', type: 'movie' }, profile: { name: 'A', keys, filters: { age_limit: 0 } } }, res);
      assert.deepStrictEqual(res.body.results.map((r) => r.id), ['tt1', 'tt2']);
      assert.strictEqual(chainCalls, 0, 'an unrestricted profile must not reach the age chain or the LLM');

      res = fakeRes();
      await handlers.searchHandler({ query: { q: 'film', type: 'movie' }, profile: { name: 'K', keys, filters: { age_limit: 14 } } }, res);
      assert.deepStrictEqual(res.body.results.map((r) => r.id), ['tt1']);

      // gate failure → fail-closed (the chain's LLM step throws)
      srcMod.buildSources = () => emptySources(async () => { throw new Error('LLM down'); });
      tmdb.searchTitles = async () => [{ id: 'tt9', name: 'New Film', _tmdb_id: 9, releaseInfo: '2024', description: 'x' }];
      res = fakeRes();
      await handlers.searchHandler({ query: { q: 'film', type: 'movie' }, profile: { name: 'K', keys, filters: { age_limit: 14 } } }, res);
      assert.deepStrictEqual(res.body.results, []);
    } finally { tmdb.searchTitles = o.s; rebuildMod.applyAnimeGate = o.a; srcMod.buildSources = o.b; }
  });

  await ok('F6: age-limited profiles cannot change min_rating / min_year / excluded_genres / engine_anime from the phone', async () => {
    const handlers = require('../mobile/server/handlers');
    const p = config.addProfile('Kid'); config.updateProfile(p.id, { filters: { age_limit: 10 } });
    const a = config.addProfile('Adult');
    const fakeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
    const body = { min_rating: 8, min_year: 2015, excluded_genres: ['Horror'], engine_anime: 'marquee-anime', list_size: 30 };

    let res = fakeRes();
    handlers.settingsPostHandler({ profile: config.getProfile(p.id), body: { ...body } }, res);
    const k = config.getProfile(p.id);
    assert.strictEqual(k.filters.min_rating, 6, 'min_rating untouched');
    assert.deepStrictEqual(k.filters.excluded_genres, [], 'excluded_genres untouched');
    assert.ok(k.filters.engine_anime !== 'marquee-anime', 'anime lane untouched');
    assert.strictEqual(k.filters.list_size, 30, 'a non-managed setting still saves');
    assert.deepStrictEqual([...res.body.managed].sort(), ['engine_anime', 'excluded_genres', 'min_rating', 'min_year']);
    assert.ok(!JSON.stringify(res.body).includes('age_limit'), 'the age limit is never exposed');

    res = fakeRes();
    handlers.settingsPostHandler({ profile: config.getProfile(a.id), body: { ...body } }, res);
    const ad = config.getProfile(a.id);
    assert.strictEqual(ad.filters.min_rating, 8, 'an adult profile may still change them');
    assert.deepStrictEqual(ad.filters.excluded_genres, ['Horror']);
    assert.deepStrictEqual(res.body.managed, []);
  });

  await ok('F10: watched TMDB ids are typed — a watched show does not exclude a movie with the same id', async () => {
    const pid = 'typed-' + Date.now();
    watchedStore.upsertMany(pid, [
      { simkl_id: 1, type: 'series', imdb_id: 'tt1111111', tmdb_id: '1399', title: 'A Show', year: 2011, watched_at: new Date().toISOString() },
      { simkl_id: 2, type: 'movie', imdb_id: 'tt2222222', tmdb_id: '603', title: 'A Film', year: 1999, watched_at: new Date().toISOString() },
    ]);
    const sets = watchedStore.watchedIdSets(pid);
    assert.ok(watchedStore.watchedTmdbFor(sets, 'series').has('1399'));
    assert.ok(!watchedStore.watchedTmdbFor(sets, 'movie').has('1399'), 'movie 1399 is a different title from show 1399');
    assert.ok(watchedStore.watchedTmdbFor(sets, 'movie').has('603'));
    assert.ok(!watchedStore.watchedTmdbFor(sets, 'series').has('603'));
    assert.ok(watchedStore.watchedTmdbFor(sets, 'anime').has('1399'), 'anime ids live in the TV namespace');
    // a bare legacy set still works as a fallback
    assert.ok(watchedStore.watchedTmdbFor({ tmdb: new Set(['9']) }, 'movie').has('9'));
    watchedStore.deleteForProfile(pid);
  });

  console.log(`All hardening phase 1 checks passed (${n}).`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
