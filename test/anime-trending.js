// AN-1b card 1: the Marquee Anime trending engine — Simkl + AniList + kids list.
// Run: node --experimental-sqlite test/anime-trending.js
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-an1b1-' + Date.now();
process.env.PORT = '7317'; // distinct from anime-lane (7316)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';
process.env.MOBILE_INSECURE_COOKIE = '1';

const animeMap = require('../src/services/animeMap');
const anilist = require('../src/services/anilist');
const store = require('../src/store');
const config = require('../src/config');
const settings = require('../src/settings');
const rec = require('../src/recommendationStore');

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

(async () => {
  console.log('anime-trending:');

  // ---- T1: animeMap.buildIndex reverse lookups + v:2 staleness ----
  await ok('T1: animeMap.buildIndex reverse lookups + v:2 staleness', async () => {
    const fixture = [
      { mal_id: 1, anilist_id: 100, themoviedb_id: { tv: 30991 }, imdb_id: ['tt0213338'], type: 'TV' }, // Cowboy Bebop
      { mal_id: 2, anilist_id: 200, themoviedb_id: { tv: 94664 }, imdb_id: ['tt0000001'], type: 'TV' }, // Mushoku S1
      { mal_id: 3, anilist_id: 300, themoviedb_id: { tv: 94664 }, imdb_id: ['tt0000001'], type: 'TV' }, // Mushoku S2
      { mal_id: 4, anilist_id: 400, themoviedb_id: { movie: 500 }, imdb_id: ['tt0000002'], type: 'MOVIE' }, // MOVIE
      { mal_id: 5, anilist_id: 500, themoviedb_id: { tv: 600 }, type: 'TV' }, // TV without imdb
    ];
    const idx = animeMap.buildIndex(fixture);
    // Bebop
    assert.deepStrictEqual(idx.byAnilist[100], { tv: '30991', imdb: 'tt0213338', type: 'TV' });
    assert.deepStrictEqual(idx.byMal[1], { tv: '30991', imdb: 'tt0213338', type: 'TV' });
    // Mushoku S1 + S2 → same tv
    assert.strictEqual(idx.byAnilist[200].tv, '94664');
    assert.strictEqual(idx.byAnilist[300].tv, '94664');
    assert.strictEqual(idx.byMal[2].tv, '94664');
    assert.strictEqual(idx.byMal[3].tv, '94664');
    // MOVIE absent
    assert.strictEqual(idx.byAnilist[400], undefined);
    assert.strictEqual(idx.byMal[4], undefined);
    // TV without imdb absent
    assert.strictEqual(idx.byAnilist[500], undefined);
    assert.strictEqual(idx.byMal[5], undefined);

    // A cached v:2 index is treated as stale (a download is attempted).
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, headers: { get: () => '' }, json: async () => [] };
    };
    try {
      store.saveAnimeIndex({ at: Date.now(), v: 2, byImdb: {}, byTmdb: {}, byAnilist: {}, byMal: {} });
      animeMap._setIndex(null);
      await animeMap.refresh(console);
      assert.strictEqual(fetchCalls, 1, 'v:2 index triggers a download');
    } finally {
      global.fetch = realFetch;
      animeMap._setIndex(null);
    }
  });

  // ---- T2: anilist.trendingAnime query + 429 ----
  await ok('T2: anilist.trendingAnime query + 429', async () => {
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ data: { Page: { media: [] } } }) };
    };
    try {
      // trending
      await anilist.trendingAnime({ list: 'trending', page: 1 });
      assert.deepStrictEqual(captured.variables.sort, ['TRENDING_DESC']);
      assert.strictEqual(captured.variables.tagIn, undefined, 'trending sends no tagIn');
      assert.ok(captured.query.includes('isAdult:false'), 'query has isAdult:false');
      assert.ok(captured.query.includes('format_in:[TV,ONA,TV_SHORT]'), 'query has format_in');
      // kids
      await anilist.trendingAnime({ list: 'kids', page: 1 });
      assert.deepStrictEqual(captured.variables.tagIn, ['Kids']);
      assert.strictEqual(captured.variables.genreIn, undefined, 'no genreIn variable');
      assert.deepStrictEqual(captured.variables.genreNotIn, ['Ecchi', 'Hentai', 'Horror', 'Psychological', 'Thriller']);
      assert.deepStrictEqual(captured.variables.tagNotIn, ['Nudity', 'Gore', 'Suicide', 'Torture']);
      assert.ok(captured.query.includes('tag_in:$tagIn'), 'query has tag_in');
      assert.ok(!captured.query.includes('genre_in'), 'query has no genre_in');
    } finally {
      global.fetch = realFetch;
    }
    // 429 → throws with .status === 429
    global.fetch = async () => ({ ok: false, status: 429 });
    try {
      await anilist.trendingAnime({ list: 'trending', page: 1 });
      assert.fail('should have thrown');
    } catch (e) {
      assert.strictEqual(e.status, 429);
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---- T3: build — merge by show.tv, drop MOVIE + unmapped, candidate shape ----
  await ok('T3: build — merge + drop + candidate shape', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const mushokuS2Simkl = { mal: 3, tmdb_id: '94664', imdb_id: 'tt0000001', title: 'Mushoku S2', year: 2021, ratings: { mal: { rating: 8, votes: 100 } }, rank: 1 };
    const movieSimkl = { mal: 4, tmdb_id: '500', imdb_id: 'tt0000002', title: 'Movie', year: 2020, ratings: { mal: { rating: 7, votes: 50 } }, rank: 2 };
    const mushokuS2Ani = { id: 300, idMal: 3, format: 'TV', genres: ['Action'], averageScore: 75, popularity: 100, startDate: { year: 2021 }, title: { romaji: 'Mushoku S2', english: 'Mushoku S2' } };
    const mushokuS1Ani = { id: 200, idMal: 2, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 200, startDate: { year: 2020 }, title: { romaji: 'Mushoku S1', english: 'Mushoku S1' } };
    const unmappedAni = { id: 999, idMal: 999, format: 'TV', genres: ['Action'], averageScore: 70, popularity: 50, startDate: { year: 2020 }, title: { romaji: 'Unmapped', english: 'Unmapped' } };
    const deps = {
      simklList: () => [mushokuS2Simkl, movieSimkl],
      anilistList: (list, page) => {
        if (list === 'trending' && page === 1) return [mushokuS2Ani, mushokuS1Ani, unmappedAni];
        if (list === 'trending' && page === 2) return [];
        return [];
      },
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => {
          if (id === 3) return { tv: '94664', imdb: 'tt0000001', type: 'TV' };
          if (id === 2) return { tv: '94664', imdb: 'tt0000001', type: 'TV' };
          if (id === 4) return { tv: '500', imdb: 'tt0000002', type: 'MOVIE' };
          return null;
        },
        byAnilist: (id) => {
          if (id === 300) return { tv: '94664', imdb: 'tt0000001', type: 'TV' };
          if (id === 200) return { tv: '94664', imdb: 'tt0000001', type: 'TV' };
          return null;
        },
      },
      listSize: () => 20,
      tier: () => null,
      tvMeta: async () => new Map(),
    };
    const ctx = { log: console };
    const cands = await trending.build({ name: 'T3', id: 'T3' }, ctx, deps);
    // One candidate, tv '94664'
    assert.strictEqual(cands.length, 1, 'one candidate');
    assert.strictEqual(cands[0].tmdb_id, '94664');
    // Every candidate has type 'anime', string tmdb_id, tt… imdb_id, algorithmVersion
    for (const c of cands) {
      assert.strictEqual(c.type, 'anime');
      assert.strictEqual(typeof c.tmdb_id, 'string');
      assert.ok(c.imdb_id.startsWith('tt'), 'imdb_id starts with tt');
      assert.strictEqual(c.algorithmVersion, 'marquee-anime-a1');
    }
  });

  // ---- T4: kids list gating + reason + ranking ----
  await ok('T4: kids list gating + reason + ranking', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const kidsShow = { id: 100, idMal: 100, format: 'TV', genres: ['Comedy'], averageScore: 80, popularity: 100, startDate: { year: 2020 }, title: { romaji: 'Kids Show', english: 'Kids Show' } };
    const trendingShow = { id: 200, idMal: 200, format: 'TV', genres: ['Action'], averageScore: 80, popularity: 100, startDate: { year: 2020 }, title: { romaji: 'Trending Show', english: 'Trending Show' } };
    const makeDeps = (ageLimit) => {
      let kidsCalls = 0;
      return {
        kidsCalls: () => kidsCalls,
        simklList: () => [],
        anilistList: (list, page) => {
          if (list === 'kids') { kidsCalls++; return [kidsShow]; }
          if (list === 'trending' && page === 1) return [trendingShow];
          return [];
        },
        animeMap: {
          ensureLoaded: async () => {},
          byMal: (id) => {
            if (id === 100) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
            if (id === 200) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
            return null;
          },
          byAnilist: (id) => {
            if (id === 100) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
            if (id === 200) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
            return null;
          },
        },
        listSize: () => 20,
        tier: (p) => {
          const n = p?.filters?.age_limit || 0;
          if (n <= 0) return null;
          if (n >= 15) return { csmMaxAge: 15, label: '15+' };
          if (n >= 14) return { csmMaxAge: 14, label: 'TV-14' };
          if (n >= 12) return { csmMaxAge: 12, label: '12+' };
          return { csmMaxAge: 10, label: '10+' };
        },
        tvMeta: async () => new Map(),
      };
    };
    // age_limit 10 → kids called 4 times (pages 1,2,3,4)
    let d = makeDeps(10);
    let ctx = { log: console };
    await trending.build({ name: 'T4', id: 'T4', filters: { age_limit: 10 } }, ctx, d);
    assert.strictEqual(d.kidsCalls(), 4, 'age_limit 10 → kids called 4 times');
    // age_limit 14 → never called
    d = makeDeps(14);
    ctx = { log: console };
    await trending.build({ name: 'T4', id: 'T4', filters: { age_limit: 14 } }, ctx, d);
    assert.strictEqual(d.kidsCalls(), 0, 'age_limit 14 → kids never called');
    // age_limit 0 → never called
    d = makeDeps(0);
    ctx = { log: console };
    await trending.build({ name: 'T4', id: 'T4', filters: { age_limit: 0 } }, ctx, d);
    assert.strictEqual(d.kidsCalls(), 0, 'age_limit 0 → kids never called');
    // age_limit 10, page 3 throws → pages 1–2's kids items are still used (assign-as-you-go).
    let kidsCalls = 0;
    const throwingDeps = {
      simklList: () => [],
      anilistList: (list, page) => {
        if (list === 'kids') {
          kidsCalls++;
          if (page === 3) { const e = new Error('AniList kids page 3 failed'); e.status = 429; throw e; }
          return [kidsShow];
        }
        if (list === 'trending' && page === 1) return [trendingShow];
        return [];
      },
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => {
          if (id === 100) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
          if (id === 200) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
          return null;
        },
        byAnilist: (id) => {
          if (id === 100) return { tv: '1000', imdb: 'tt1000', type: 'TV' };
          if (id === 200) return { tv: '2000', imdb: 'tt2000', type: 'TV' };
          return null;
        },
      },
      listSize: () => 20,
      tier: (p) => {
        const n = p?.filters?.age_limit || 0;
        if (n <= 0) return null;
        if (n >= 15) return { csmMaxAge: 15, label: '15+' };
        if (n >= 14) return { csmMaxAge: 14, label: 'TV-14' };
        if (n >= 12) return { csmMaxAge: 12, label: '12+' };
        return { csmMaxAge: 10, label: '10+' };
      },
      tvMeta: async () => new Map(),
    };
    ctx = { log: console };
    const candsThrow = await trending.build({ name: 'T4', id: 'T4', filters: { age_limit: 10 } }, ctx, throwingDeps);
    assert.strictEqual(kidsCalls, 3, 'kids called for pages 1,2,3 (page 3 threw)');
    const kidsCandThrow = candsThrow.find((c) => c.tmdb_id === '1000');
    assert.ok(kidsCandThrow, 'pages 1–2 kids item still used');
    assert.strictEqual(kidsCandThrow.reason, 'Popular with younger viewers');
    // A show found only by kids has reason 'Popular with younger viewers' and ranks above an otherwise-equal trending-only show.
    d = makeDeps(10);
    ctx = { log: console };
    const cands = await trending.build({ name: 'T4', id: 'T4', filters: { age_limit: 10 } }, ctx, d);
    const kidsCand = cands.find((c) => c.tmdb_id === '1000');
    const trendingCand = cands.find((c) => c.tmdb_id === '2000');
    assert.ok(kidsCand, 'kids candidate present');
    assert.strictEqual(kidsCand.reason, 'Popular with younger viewers');
    assert.ok(trendingCand, 'trending candidate present');
    assert.strictEqual(trendingCand.reason, 'Trending anime');
    // Kids ranks above an otherwise-equal trending-only show.
    assert.ok(cands.indexOf(kidsCand) < cands.indexOf(trendingCand), 'kids ranks above trending');
  });

  // ---- T5: pool size = 4 × list_size ----
  await ok('T5: pool size = 4 × list_size', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const makeDeps = (size) => ({
      simklList: () => Array.from({ length: 120 }, (_, i) => ({
        mal: i + 1, tmdb_id: String(1000 + i), imdb_id: `tt${1000 + i}`, title: `Show ${i}`, year: 2020, ratings: { mal: { rating: 7, votes: 10 } }, rank: i,
      })),
      anilistList: () => [],
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => ({ tv: String(1000 + (id - 1)), imdb: `tt${1000 + (id - 1)}`, type: 'TV' }),
        byAnilist: () => null,
      },
      listSize: () => size,
      tier: () => null,
      tvMeta: async () => new Map(),
    });
    let ctx = { log: console };
    let cands = await trending.build({ name: 'T5', id: 'T5' }, ctx, makeDeps(20));
    assert.strictEqual(cands.length, 80, 'list_size 20 → 80 candidates');
    ctx = { log: console };
    cands = await trending.build({ name: 'T5', id: 'T5' }, ctx, makeDeps(5));
    assert.strictEqual(cands.length, 20, 'list_size 5 → 20 candidates');
  });

  // ---- T6: failures — one source fails, all sources fail ----
  await ok('T6: failures — one source fails, all sources fail', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const simklShow = { mal: 1, tmdb_id: '1000', imdb_id: 'tt1000', title: 'Simkl Show', year: 2020, ratings: { mal: { rating: 8, votes: 100 } }, rank: 1 };
    // AniList throws (429) → Simkl candidates still returned, failure logged once.
    const logs = [];
    const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    let d = {
      simklList: () => [simklShow],
      anilistList: () => { const e = new Error('AniList failed'); e.status = 429; throw e; },
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => (id === 1 ? { tv: '1000', imdb: 'tt1000', type: 'TV' } : null),
        byAnilist: () => null,
      },
      listSize: () => 20,
      tier: () => null,
      tvMeta: async () => new Map(),
    };
    let cands = await trending.build({ name: 'T6', id: 'T6' }, { log }, d);
    assert.strictEqual(cands.length, 1, 'Simkl candidate still returned');
    assert.strictEqual(cands[0].tmdb_id, '1000');
    const warnCount = logs.filter((m) => m.includes('AniList')).length;
    assert.strictEqual(warnCount, 1, 'failure logged once');
    // Every source throws → [], no exception.
    logs.length = 0;
    d = {
      simklList: () => { const e = new Error('Simkl failed'); e.status = 429; throw e; },
      anilistList: () => { const e = new Error('AniList failed'); e.status = 429; throw e; },
      animeMap: {
        ensureLoaded: async () => {},
        byMal: () => null,
        byAnilist: () => null,
      },
      listSize: () => 20,
      tier: () => null,
      tvMeta: async () => new Map(),
    };
    cands = await trending.build({ name: 'T6', id: 'T6' }, { log }, d);
    assert.deepStrictEqual(cands, [], 'all sources fail → []');
  });

  // ---- T7: end to end — buildRecommendations + serveRecommendations ----
  await ok('T7: end to end — buildRecommendations + serveRecommendations', async () => {
    require('../src/server');
    const trending = require('../src/engines/marqueeAnime/trending');
    const realBuild = trending.build;
    const simklShow = { mal: 1, tmdb_id: '94664', imdb_id: 'tt0000001', title: 'Mushoku', year: 2021, ratings: { mal: { rating: 8, votes: 100 } }, rank: 1 };
    const aniShow = { id: 300, idMal: 3, format: 'TV', genres: ['Action'], averageScore: 75, popularity: 100, startDate: { year: 2021 }, title: { romaji: 'Mushoku', english: 'Mushoku' } };
    const stubDeps = {
      simklList: () => [simklShow],
      anilistList: (list, page) => (list === 'trending' && page === 1 ? [aniShow] : []),
      animeMap: {
        ensureLoaded: async () => {},
        byMal: (id) => (id === 1 ? { tv: '94664', imdb: 'tt0000001', type: 'TV' } : null),
        byAnilist: (id) => (id === 300 ? { tv: '94664', imdb: 'tt0000001', type: 'TV' } : null),
      },
      listSize: () => 20,
      tier: () => null,
      tvMeta: async () => new Map(),
    };
    // The movie/series engines also run in this build; with a fake TMDB key they would make hundreds of
    // REAL TMDB calls (each a 401). Answer TMDB instantly instead (everything else is untouched).
    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).includes('api.themoviedb.org')
      ? Promise.resolve({ ok: false, status: 401, json: async () => ({}), text: async () => '' })
      : realFetch(url, opts));
    try {
      settings.updateSettings({ keys: { tmdb_api_key: 'test-tmdb-key' } });
      const p = config.addProfile('AN1B-T7');
      config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime', list_size: 20 } });
      const prof = config.getProfile(p.id);
      prof.simkl_auth = { access_token: 't' };
      prof.keys = { anidb_client: 't', anidb_clientver: 1 };
      // Exact injection: generate looks up trending.build at call time.
      trending.build = (pp, ctx) => realBuild(pp, ctx, stubDeps);
      const r = await rec.buildRecommendations(prof, console);
      assert.ok(r.anime, 'anime result present');
      // Rows with type 'anime' stored.
      const rows = rec.getRecommended(p.id, { type: 'anime' });
      assert.ok(rows.length > 0, 'anime rows stored');
      assert.ok(rows.every((row) => row.type === 'anime'), 'all rows type=anime');
      // serveRecommendations returns items with type 'series'.
      const served = rec.serveRecommendations(prof, 'anime');
      assert.ok(served.length > 0, 'served items present');
      assert.ok(served.every((s) => s.type === 'series'), 'served items type=series');
      config.removeProfile(p.id);
    } finally {
      trending.build = realBuild;
      global.fetch = realFetch;
    }
  });

  // ---- T8: TMDB naming — show title/year/poster from TMDB, fallback + throw ----
  await ok('T8: TMDB naming — show names from TMDB, fallback + throw', async () => {
    const trending = require('../src/engines/marqueeAnime/trending');
    const makeSimkl = () => [
      { mal: 3, tmdb_id: '94664', imdb_id: 'tt0000001', title: 'Mushoku S2', year: 2021, ratings: { mal: { rating: 8, votes: 100 } }, rank: 1 },
      { mal: 5, tmdb_id: '5000', imdb_id: 'tt5000', title: 'Other Show', year: 2020, ratings: { mal: { rating: 7, votes: 50 } }, rank: 2 },
    ];
    const makeAniMap = () => ({
      ensureLoaded: async () => {},
      byMal: (id) => (id === 3 ? { tv: '94664', imdb: 'tt0000001', type: 'TV' } : (id === 5 ? { tv: '5000', imdb: 'tt5000', type: 'TV' } : null)),
      byAnilist: () => null,
    });
    // (a) TMDB naming applied to the present id; a missing id keeps its source title.
    const tmdbMeta = new Map([['94664', { title: 'Mushoku Tensei: Jobless Reincarnation', year: 2021, poster: 'https://image.tmdb.org/x.jpg' }]]);
    let d = { simklList: makeSimkl, anilistList: () => [], animeMap: makeAniMap(), listSize: () => 20, tier: () => null, tvMeta: async () => tmdbMeta };
    let ctx = { log: console };
    let cands = await trending.build({ name: 'T8', id: 'T8' }, ctx, d);
    assert.strictEqual(cands.length, 2, 'two candidates');
    const mushoku = cands.find((c) => c.tmdb_id === '94664');
    assert.strictEqual(mushoku.title, 'Mushoku Tensei: Jobless Reincarnation', 'TMDB title');
    assert.strictEqual(mushoku.year, 2021, 'TMDB year');
    assert.strictEqual(mushoku.poster, 'https://image.tmdb.org/x.jpg', 'TMDB poster');
    const other = cands.find((c) => c.tmdb_id === '5000');
    assert.strictEqual(other.title, 'Other Show', 'missing id keeps source title');
    // (b) tvMeta throws → candidates still returned with source names, one warning logged.
    const warns = [];
    const log = { log: () => {}, warn: (m) => warns.push(m) };
    d = { simklList: makeSimkl, anilistList: () => [], animeMap: makeAniMap(), listSize: () => 20, tier: () => null, tvMeta: () => { throw new Error('TMDB down'); } };
    ctx = { log };
    cands = await trending.build({ name: 'T8', id: 'T8' }, ctx, d);
    assert.strictEqual(cands.length, 2, 'candidates still returned');
    assert.strictEqual(cands.find((c) => c.tmdb_id === '94664').title, 'Mushoku S2', 'source name kept on throw');
    assert.strictEqual(cands.find((c) => c.tmdb_id === '5000').title, 'Other Show', 'source name kept on throw');
    assert.strictEqual(warns.filter((m) => m.includes('TMDB naming failed')).length, 1, 'one warning logged');
  });

  console.log(`\nAll anime-trending checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
