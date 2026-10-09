// AGE-3a: the anime age chain (MAL + Kitsu steps, anime verdicts, reasons).
// Run: node --experimental-sqlite test/age-anime-chain.js
'use strict';
const assert = require('assert');
const os = require('os');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-age3a-' + Date.now();
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const chain = require('../src/ageVerification/chain');
const tiers = require('../src/ageVerification/tiers');
const store = require('../src/ageVerification/store');
const ageVerify = require('../src/ageVerification');
const lanes = require('../src/lanes');
const kitsu = require('../src/services/kitsu');
// The Kitsu lane paces real requests 1 s apart; the tests stub fetch, so do not wait for it.
require('../src/services/governor').LIMITS.kitsu.minIntervalMs = 0;
const decisionLog = require('../src/anime/decisionLog');
const rebuild = require('../src/rebuild');
const rec = require('../src/recommendationStore');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const log = { log: () => {}, warn: () => {}, error: () => {} };

// A title in the chain's shape (anime lane).
const title = (id, genres = []) => ({ key: `anime:${id}`, imdb_id: `tt${id}`, adult: false, title: `Anime ${id}`, year: 2020, genres });

// Fake sources: plain async functions returning Maps, with call tracking.
// `tmdb`/`csm`/`tvdb`/`simkl`/`mdblist`/`llm`/`malBands`/`kitsu` are lookup
// tables keyed by the chain's key (or imdb_id for csm/tvdb/simkl/mdblist).
function makeSources({ tmdb = {}, csm = {}, tvdb = {}, simkl = {}, mdblist = {}, llm = {}, malBands = {}, kitsu = {}, throwMalBands = false, throwKitsu = false } = {}) {
  const calls = { tmdb: 0, csm: 0, tvdb: 0, simkl: 0, mdblist: 0, llm: 0, malBands: 0, kitsu: 0 };
  const callTitles = { malBands: [], kitsu: [] };
  const sources = {
    tmdbRatings: async (_type, titles) => {
      calls.tmdb++;
      const out = new Map();
      for (const t of titles) out.set(t.key, tmdb[t.key] || {});
      return out;
    },
    csmAges: async (_type, imdbIds) => {
      calls.csm++;
      const out = new Map();
      for (const id of imdbIds) if (csm[id] != null) out.set(id, csm[id]);
      return out;
    },
    tvdbRatings: async (_type, imdbIds) => {
      calls.tvdb++;
      const out = new Map();
      for (const id of imdbIds) if (tvdb[id]) out.set(id, tvdb[id]);
      return out;
    },
    simklCerts: async (_type, imdbIds) => {
      calls.simkl++;
      const out = new Map();
      for (const id of imdbIds) if (simkl[id] != null) out.set(id, simkl[id]);
      return out;
    },
    mdblistCerts: async (_type, imdbIds) => {
      calls.mdblist++;
      const out = new Map();
      for (const id of imdbIds) if (mdblist[id] != null) out.set(id, mdblist[id]);
      return out;
    },
    llmGate: async (_type, _tier, titles) => {
      calls.llm++;
      const out = new Map();
      for (const t of titles) {
        const v = llm[t.key];
        if (v === true || v === false) out.set(t.key, v);
      }
      return out;
    },
    malBands: async (_type, titles) => {
      calls.malBands++;
      if (throwMalBands) throw new Error('malBands boom');
      callTitles.malBands.push(titles.map((t) => t.key));
      const out = new Map();
      for (const t of titles) if (malBands[t.key]) out.set(t.key, malBands[t.key]);
      return out;
    },
    kitsuRatings: async (_type, titles) => {
      calls.kitsu++;
      if (throwKitsu) throw new Error('kitsu boom');
      callTitles.kitsu.push(titles.map((t) => t.key));
      const out = new Map();
      for (const t of titles) if (kitsu[t.key]) out.set(t.key, kitsu[t.key]);
      return out;
    },
  };
  return { sources, calls, callTitles };
}

// Stub rebuild.applyAnimeGate: dropMap is Map<tmdb_id, info> — titles in the
// map are dropped (onDrop called), the rest are returned.
function stubApplyAnimeGate(dropMap) {
  const original = rebuild.applyAnimeGate;
  rebuild.applyAnimeGate = async (metas, _profile, _log, onDrop) => {
    const out = [];
    for (const m of metas) {
      const info = dropMap.get(String(m._tmdb_id));
      if (info) { if (onDrop) onDrop(m, info); } else { out.push(m); }
    }
    return out;
  };
  return () => { rebuild.applyAnimeGate = original; };
}

// Stub ageVerification.verify: verdictMap is Map<key, verdict> where key is
// `${type}:${tmdb_id}`.
function stubVerify(verdictMap) {
  const original = ageVerify.verify;
  ageVerify.verify = async (titles, _type, _tier, _sources, _log) => {
    const result = new Map();
    for (const t of titles) {
      const v = verdictMap.get(t.key);
      if (v) result.set(t.key, v);
    }
    return result;
  };
  return () => { ageVerify.verify = original; };
}

const getRow = (profileId, buildId, tmdbId) => {
  const { rows } = decisionLog.list(profileId, 'anime', { build: buildId });
  return rows.find((r) => r.item_key === String(tmdbId));
};

(async () => {
  console.log('age-anime-chain:');

  // ---- AC1: hard floor — MAL Rx and R+ (adultish) block ----
  await ok('AC1: hard floor — MAL Rx and R+ (adultish) block', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1), title(2)];
    const { sources } = makeSources({
      malBands: {
        'anime:1': { code: 'Rx', minAge: 99, adult: true, adultish: false },
        'anime:2': { code: 'R+', minAge: 17, adult: false, adultish: true },
      },
    });
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    assert.strictEqual(result.get('anime:1').verdict, 'block');
    assert.strictEqual(result.get('anime:1').source, 'hard-floor');
    assert.strictEqual(result.get('anime:1').rating, 'mal:Rx');
    assert.strictEqual(result.get('anime:2').verdict, 'block');
    assert.strictEqual(result.get('anime:2').source, 'hard-floor');
    assert.strictEqual(result.get('anime:2').rating, 'mal:R+');
  });

  // ---- AC2: hard floor — Hentai genre (any case) blocks ----
  await ok('AC2: hard floor — Hentai genre (any case) blocks', async () => {
    const tier = tiers.TIERS[14];
    const titles = [
      { ...title(1), genres: ['Hentai'] },
      { ...title(2), genres: ['hentai'] },
    ];
    const { sources } = makeSources({});
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    assert.strictEqual(result.get('anime:1').source, 'hard-floor');
    assert.strictEqual(result.get('anime:1').rating, 'genre:Hentai');
    assert.strictEqual(result.get('anime:2').source, 'hard-floor');
    assert.strictEqual(result.get('anime:2').rating, 'genre:Hentai');
  });

  // ---- AC3: MAL allow — tier 14, PG-13; AU/US/Kitsu/LLM not called ----
  await ok('AC3: MAL allow — tier 14, PG-13; AU/US/Kitsu/LLM not called', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1)];
    const { sources, calls } = makeSources({
      malBands: { 'anime:1': { code: 'PG-13', minAge: 13, adult: false, adultish: false } },
    });
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    const r = result.get('anime:1');
    assert.strictEqual(r.verdict, 'allow');
    assert.strictEqual(r.source, 'mal');
    assert.strictEqual(r.rating, 'PG-13');
    assert.ok(r.reason && r.reason.length > 0, 'non-empty reason');
    assert.strictEqual(calls.tvdb, 0, 'tvdb (AU/US) not called');
    assert.strictEqual(calls.kitsu, 0, 'kitsu not called');
    assert.strictEqual(calls.llm, 0, 'llm not called');
  });

  // ---- AC4: MAL block/allow — tier 10, PG-13 block, PG allow ----
  await ok('AC4: MAL block/allow — tier 10, PG-13 block, PG allow', async () => {
    const tier = tiers.TIERS[10];
    const titles = [title(1), title(2)];
    const { sources } = makeSources({
      malBands: {
        'anime:1': { code: 'PG-13', minAge: 13, adult: false, adultish: false },
        'anime:2': { code: 'PG', minAge: 6, adult: false, adultish: false },
      },
    });
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    assert.strictEqual(result.get('anime:1').verdict, 'block');
    assert.strictEqual(result.get('anime:1').source, 'mal');
    assert.strictEqual(result.get('anime:2').verdict, 'allow');
    assert.strictEqual(result.get('anime:2').source, 'mal');
  });

  // ---- AC5: MAL unrated falls through to AU — TV-14 at tier 14 allow ----
  await ok('AC5: MAL unrated falls through to AU — TV-14 at tier 14 allow', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1)];
    const { sources } = makeSources({
      malBands: { 'anime:1': { code: null, minAge: null, adult: false, adultish: false } },
      tmdb: { 'anime:1': { AU: 'TV-14' } },
    });
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    const r = result.get('anime:1');
    assert.strictEqual(r.verdict, 'allow');
    assert.strictEqual(r.source, 'au');
    assert.strictEqual(r.rating, 'TV-14');
  });

  // ---- AC6: CSM wins over MAL — CSM 12 at tier 10 block ----
  await ok('AC6: CSM wins over MAL — CSM 12 at tier 10 block', async () => {
    const tier = tiers.TIERS[10];
    const titles = [title(1)];
    const { sources } = makeSources({
      csm: { tt1: 12 },
      malBands: { 'anime:1': { code: 'PG', minAge: 6, adult: false, adultish: false } },
    });
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    const r = result.get('anime:1');
    assert.strictEqual(r.verdict, 'block');
    assert.strictEqual(r.source, 'csm');
  });

  // ---- AC7: Kitsu — PG/allow@14, PG/block@10, R/block@14, R18/hard-floor, G/allow@10 ----
  await ok('AC7: Kitsu — PG/allow@14, PG/block@10, R/block@14, R18/hard-floor, G/allow@10', async () => {
    // PG at tier 14 → allow
    {
      const tier = tiers.TIERS[14];
      const titles = [title(1)];
      const { sources } = makeSources({ kitsu: { 'anime:1': { rating: 'PG', guide: 'Teens 13 or older' } } });
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      const r = result.get('anime:1');
      assert.strictEqual(r.verdict, 'allow');
      assert.strictEqual(r.source, 'kitsu');
      assert.strictEqual(r.rating, 'PG');
      assert.ok(r.reason && r.reason.length > 0, 'reason present');
    }
    // PG at tier 10 → block
    {
      const tier = tiers.TIERS[10];
      const titles = [title(1)];
      const { sources } = makeSources({ kitsu: { 'anime:1': { rating: 'PG', guide: 'Teens 13 or older' } } });
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      assert.strictEqual(result.get('anime:1').verdict, 'block');
      assert.strictEqual(result.get('anime:1').source, 'kitsu');
    }
    // R at tier 14 → block
    {
      const tier = tiers.TIERS[14];
      const titles = [title(1)];
      const { sources } = makeSources({ kitsu: { 'anime:1': { rating: 'R', guide: '17+ (violence & profanity)' } } });
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      assert.strictEqual(result.get('anime:1').verdict, 'block');
      assert.strictEqual(result.get('anime:1').source, 'kitsu');
    }
    // R18 at any tier → block hard-floor
    for (const tierNum of [10, 14]) {
      const tier = tiers.TIERS[tierNum];
      const titles = [title(1)];
      const { sources } = makeSources({ kitsu: { 'anime:1': { rating: 'R18', guide: '18+' } } });
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      const r = result.get('anime:1');
      assert.strictEqual(r.verdict, 'block');
      assert.strictEqual(r.source, 'hard-floor');
      assert.strictEqual(r.rating, 'kitsu:R18');
    }
    // G at tier 10 → allow
    {
      const tier = tiers.TIERS[10];
      const titles = [title(1)];
      const { sources } = makeSources({ kitsu: { 'anime:1': { rating: 'G', guide: 'All Ages' } } });
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      const r = result.get('anime:1');
      assert.strictEqual(r.verdict, 'allow');
      assert.strictEqual(r.source, 'kitsu');
      assert.strictEqual(r.rating, 'G');
    }
  });

  // ---- AC8: order — MAL-decided and AU-decided titles never reach Kitsu ----
  await ok('AC8: order — MAL-decided and AU-decided titles never reach Kitsu', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1), title(2), title(3)];
    const { sources, calls, callTitles } = makeSources({
      malBands: { 'anime:1': { code: 'PG-13', minAge: 13, adult: false, adultish: false } },
      tmdb: { 'anime:2': { AU: 'TV-14' } },
      kitsu: { 'anime:3': { rating: 'PG', guide: 'Teens 13 or older' } },
    });
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    assert.strictEqual(result.get('anime:1').source, 'mal');
    assert.strictEqual(result.get('anime:2').source, 'au');
    assert.strictEqual(result.get('anime:3').source, 'kitsu');
    // The Kitsu source is called once (for the whole undecided set at step 5),
    // but only anime:3 reaches it (anime:1 and anime:2 are already decided).
    assert.strictEqual(calls.kitsu, 1, 'kitsu called once');
    assert.deepStrictEqual(callTitles.kitsu.flat(), ['anime:3'], 'kitsu called only for anime:3');
  });

  // ---- AC9: missing seams — no malBands/kitsuRatings; malBands throws ----
  await ok('AC9: missing seams — no malBands/kitsuRatings; malBands throws', async () => {
    const tier = tiers.TIERS[14];
    // No malBands/kitsuRatings → chain completes (falls to LLM).
    {
      const titles = [title(1)];
      const sources = {
        tmdbRatings: async () => new Map(),
        csmAges: async () => new Map(),
        tvdbRatings: async () => new Map(),
        simklCerts: async () => new Map(),
        mdblistCerts: async () => new Map(),
        llmGate: async (_type, _tier, titles) => {
          const out = new Map();
          for (const t of titles) out.set(t.key, false);
          return out;
        },
      };
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      const r = result.get('anime:1');
      assert.strictEqual(r.verdict, 'block');
      assert.strictEqual(r.source, 'llm');
    }
    // malBands throws → logged, chain continues.
    {
      const titles = [title(1)];
      const { sources } = makeSources({ throwMalBands: true, llm: { 'anime:1': false } });
      const warns = [];
      const testLog = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };
      const result = await chain.decide(titles, 'anime', tier, sources, testLog);
      const r = result.get('anime:1');
      assert.strictEqual(r.verdict, 'block');
      assert.strictEqual(r.source, 'llm');
      assert.ok(warns.some((m) => m.includes('mal')), 'mal warn logged');
    }
  });

  // ---- AC10: LLM last resort — receives type series, false → block llm ----
  await ok('AC10: LLM last resort — receives type series, false → block llm', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1)];
    let llmType = null;
    const sources = {
      tmdbRatings: async () => new Map(),
      csmAges: async () => new Map(),
      tvdbRatings: async () => new Map(),
      simklCerts: async () => new Map(),
      mdblistCerts: async () => new Map(),
      llmGate: async (type, _tier, titles) => {
        llmType = type;
        const out = new Map();
        for (const t of titles) out.set(t.key, false);
        return out;
      },
    };
    const result = await chain.decide(titles, 'anime', tier, sources, log);
    assert.strictEqual(llmType, 'series', 'llmGate receives type series');
    const r = result.get('anime:1');
    assert.strictEqual(r.verdict, 'block');
    assert.strictEqual(r.source, 'llm');
  });

  // ---- AC11: regression identity — series and movie unchanged ----
  // The same fixed set of 12 titles with fake TMDB/CSM/AU/US/Simkl/MDBList
  // data through decide, deepStrictEqual against the literal produced by the
  // current code's behaviour on origin/v7. No reason keys may appear.
  await ok('AC11: regression identity — series and movie unchanged', async () => {
    const ac11Titles = (type) => [
      { key: `${type}:1001`, imdb_id: 'tt1001', adult: true, title: 'Adult', year: 2020, genres: [] },
      { key: `${type}:1002`, imdb_id: 'tt1002', adult: false, title: 'AU Hard', year: 2020, genres: [] },
      { key: `${type}:1003`, imdb_id: 'tt1003', adult: false, title: 'US Hard', year: 2020, genres: [] },
      { key: `${type}:1004`, imdb_id: 'tt1004', adult: false, title: 'CSM', year: 2020, genres: [] },
      { key: `${type}:1005`, imdb_id: 'tt1005', adult: false, title: 'AU M', year: 2020, genres: [] },
      { key: `${type}:1006`, imdb_id: 'tt1006', adult: false, title: 'TVDB AU', year: 2020, genres: [] },
      { key: `${type}:1007`, imdb_id: 'tt1007', adult: false, title: 'US TV-14', year: 2020, genres: [] },
      { key: `${type}:1008`, imdb_id: 'tt1008', adult: false, title: 'TVDB US', year: 2020, genres: [] },
      { key: `${type}:1009`, imdb_id: 'tt1009', adult: false, title: 'Simkl', year: 2020, genres: [] },
      { key: `${type}:1010`, imdb_id: 'tt1010', adult: false, title: 'MDBList', year: 2020, genres: [] },
      { key: `${type}:1011`, imdb_id: 'tt1011', adult: false, title: 'GB', year: 2020, genres: [] },
      { key: `${type}:1012`, imdb_id: 'tt1012', adult: false, title: 'LLM', year: 2020, genres: [] },
    ];
    const ac11Data = (type) => ({
      tmdb: {
        [`${type}:1002`]: { AU: 'R' },
        [`${type}:1003`]: { US: 'R' },
        [`${type}:1005`]: { AU: 'M' },
        [`${type}:1007`]: { US: 'TV-14' },
        [`${type}:1011`]: { GB: '15' },
      },
      csm: { tt1004: 12 },
      tvdb: { tt1006: { aus: 'M' }, tt1008: { usa: 'TV-14' } },
      simkl: { tt1009: 'M' },
      mdblist: { tt1010: 'M' },
      llm: { [`${type}:1012`]: false },
    });
    const tier = tiers.TIERS[14];
    // Expected literal generated mechanically from origin/v7 (see the scratch
    // script that runs this exact 12-title fixture through origin/v7's decide()).
    // AU 'R' -> source 'au' (not hard-floor; 'R' is not in the AU hardFloor set);
    // US 'R' -> source 'us' (not hard-floor; 'R' is not in the US hardFloor set);
    // CSM 12 -> allow (csmMaxAge is 14 at tier 14).
    const expected = {
      series: {
        'series:1001': { verdict: 'block', source: 'hard-floor', rating: 'adult' },
        'series:1002': { verdict: 'block', source: 'au', rating: 'R' },
        'series:1003': { verdict: 'block', source: 'us', rating: 'R' },
        'series:1004': { verdict: 'allow', source: 'csm', rating: '12' },
        'series:1005': { verdict: 'allow', source: 'au', rating: 'M' },
        'series:1006': { verdict: 'allow', source: 'tvdb-au', rating: 'M' },
        'series:1007': { verdict: 'allow', source: 'us', rating: 'TV-14' },
        'series:1008': { verdict: 'allow', source: 'tvdb-us', rating: 'TV-14' },
        'series:1009': { verdict: 'allow', source: 'simkl', rating: 'M' },
        'series:1010': { verdict: 'allow', source: 'mdblist', rating: 'M' },
        'series:1011': { verdict: 'block', source: 'tmdb-gb', rating: '15' },
        'series:1012': { verdict: 'block', source: 'llm', rating: 'no' },
      },
      movie: {
        'movie:1001': { verdict: 'block', source: 'hard-floor', rating: 'adult' },
        'movie:1002': { verdict: 'block', source: 'au', rating: 'R' },
        'movie:1003': { verdict: 'block', source: 'us', rating: 'R' },
        'movie:1004': { verdict: 'allow', source: 'csm', rating: '12' },
        'movie:1005': { verdict: 'allow', source: 'au', rating: 'M' },
        'movie:1006': { verdict: 'allow', source: 'tvdb-au', rating: 'M' },
        'movie:1007': { verdict: 'allow', source: 'us', rating: 'TV-14' },
        'movie:1008': { verdict: 'allow', source: 'tvdb-us', rating: 'TV-14' },
        'movie:1009': { verdict: 'allow', source: 'simkl', rating: 'M' },
        'movie:1010': { verdict: 'allow', source: 'mdblist', rating: 'M' },
        'movie:1011': { verdict: 'block', source: 'tmdb-gb', rating: '15' },
        'movie:1012': { verdict: 'block', source: 'llm', rating: 'no' },
      },
    };
    for (const type of ['series', 'movie']) {
      const { sources } = makeSources(ac11Data(type));
      const result = await chain.decide(ac11Titles(type), type, tier, sources, log);
      const actual = {};
      for (const [k, v] of result) actual[k] = v;
      // No reason keys may appear.
      for (const v of Object.values(actual)) assert.ok(!('reason' in v), 'no reason key');
      assert.deepStrictEqual(actual, expected[type], `type ${type} matches origin/v7 behaviour`);
    }
  });

  // ---- AC12: malBands/kitsuRatings not called for series/movie ----
  await ok('AC12: malBands/kitsuRatings not called for series/movie', async () => {
    const tier = tiers.TIERS[14];
    for (const type of ['series', 'movie']) {
      const titles = [{ key: `${type}:1001`, imdb_id: 'tt1001', adult: false, title: 'X', year: 2020, genres: [] }];
      const { sources, calls } = makeSources({ llm: { [`${type}:1001`]: false } });
      await chain.decide(titles, type, tier, sources, log);
      assert.strictEqual(calls.malBands, 0, `malBands not called for ${type}`);
      assert.strictEqual(calls.kitsu, 0, `kitsuRatings not called for ${type}`);
    }
  });

  // ---- AS1: age_verdicts migration — old shape → new columns ----
  await ok('AS1: age_verdicts migration — old shape → new columns', async () => {
    const db = require('../src/db');
    // Create the table in the old shape (no reason/title) with one row.
    db.get().exec(`
      CREATE TABLE age_verdicts (
        type TEXT NOT NULL,
        tmdb_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        verdict TEXT NOT NULL,
        source TEXT NOT NULL,
        rating TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (type, tmdb_id, tier)
      );
    `);
    db.get().prepare('INSERT INTO age_verdicts (type, tmdb_id, tier, verdict, source, rating, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('series', '9999', 'tv14', 'allow', 'au', 'M', Date.now());
    // Run store.init() to add the new columns.
    store.init();
    // Assert the columns now exist.
    const cols = db.get().prepare('PRAGMA table_info(age_verdicts)').all().map((c) => c.name);
    assert.ok(cols.includes('reason'), 'reason column exists');
    assert.ok(cols.includes('title'), 'title column exists');
    // Assert the old row is intact and readable.
    const row = store.getVerdict('series', '9999', 'tv14');
    assert.ok(row, 'old row readable');
    assert.strictEqual(row.verdict, 'allow');
    assert.strictEqual(row.source, 'au');
    assert.strictEqual(row.rating, 'M');
    // Series carries no reason (anime-only field).
    assert.strictEqual(row.reason, undefined, 'reason absent for series');
    // The raw DB column is null (migration default).
    const rawRow = db.get().prepare('SELECT reason FROM age_verdicts WHERE type = ? AND tmdb_id = ? AND tier = ?').get('series', '9999', 'tv14');
    assert.strictEqual(rawRow.reason, null, 'reason column is null for old row');
  });

  // ---- AS2: recordVerdict round-trip — anime and series don't overwrite ----
  await ok('AS2: recordVerdict round-trip — anime and series do not overwrite', async () => {
    const tier = tiers.TIERS[14];
    // Record an anime verdict with reason and title.
    store.recordVerdict('anime', '1001', tier.id, 'allow', 'mal', 'PG-13', Date.now(), { reason: 'MAL PG-13 (13+) is within the band', title: 'Anime A' });
    // Read it back with getVerdict.
    const v1 = store.getVerdict('anime', '1001', tier.id);
    assert.strictEqual(v1.verdict, 'allow');
    assert.strictEqual(v1.source, 'mal');
    assert.strictEqual(v1.rating, 'PG-13');
    assert.strictEqual(v1.reason, 'MAL PG-13 (13+) is within the band');
    // Read it back with getVerdicts.
    const v2 = store.getVerdicts('anime', tier.id, ['1001']);
    assert.strictEqual(v2.get('1001').verdict, 'allow');
    assert.strictEqual(v2.get('1001').reason, 'MAL PG-13 (13+) is within the band');
    // Record a series verdict for the same tmdb id and tier.
    store.recordVerdict('series', '1001', tier.id, 'block', 'au', 'M', Date.now());
    // Assert the anime and series verdicts don't overwrite each other.
    const v3 = store.getVerdict('anime', '1001', tier.id);
    assert.strictEqual(v3.verdict, 'allow', 'anime verdict intact');
    const v4 = store.getVerdict('series', '1001', tier.id);
    assert.strictEqual(v4.verdict, 'block', 'series verdict intact');
  });

  // ---- AS3: verify for anime — first call records reason, second from cache ----
  await ok('AS3: verify for anime — first call records reason, second from cache', async () => {
    const tier = tiers.TIERS[14];
    const titles = [{ key: 'anime:1001', imdb_id: 'tt1001', adult: false, title: 'Anime A', year: 2020, genres: [] }];
    let sourceCalls = 0;
    const sources = {
      tmdbRatings: async () => { sourceCalls++; return new Map(); },
      csmAges: async () => { sourceCalls++; return new Map(); },
      tvdbRatings: async () => { sourceCalls++; return new Map(); },
      simklCerts: async () => { sourceCalls++; return new Map(); },
      mdblistCerts: async () => { sourceCalls++; return new Map(); },
      llmGate: async () => { sourceCalls++; return new Map(); },
      malBands: async () => { sourceCalls++; return new Map([['anime:1001', { code: 'PG-13', minAge: 13, adult: false, adultish: false }]]); },
      kitsuRatings: async () => { sourceCalls++; return new Map(); },
    };
    // First call: decides via the chain and records the reason.
    const result1 = await ageVerify.verify(titles, 'anime', tier, sources, log);
    const r1 = result1.get('anime:1001');
    assert.strictEqual(r1.verdict, 'allow');
    assert.strictEqual(r1.source, 'mal');
    assert.ok(r1.reason && r1.reason.length > 0, 'reason recorded');
    const callsAfterFirst = sourceCalls;
    // Second call: answered from the cache with the same reason and no source call.
    const result2 = await ageVerify.verify(titles, 'anime', tier, sources, log);
    const r2 = result2.get('anime:1001');
    assert.strictEqual(r2.verdict, 'allow');
    assert.strictEqual(r2.source, 'mal');
    assert.strictEqual(r2.reason, r1.reason, 'same reason from cache');
    assert.strictEqual(sourceCalls, callsAfterFirst, 'no source call on second call');
  });

  // ---- AS4: Kitsu service — fixtures, cache, 429, cap, URL ----
  await ok('AS4: Kitsu service — fixtures, cache, 429, cap, URL', async () => {
    const bebop = { data: [{ id: '64108', type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '1' }, relationships: { item: { data: { type: 'anime', id: '1' } } } }], included: [{ id: '1', type: 'anime', attributes: { ageRating: 'R', ageRatingGuide: '17+ (violence & profanity)', canonicalTitle: 'Cowboy Bebop' } }], meta: { count: 1 } };
    const naruto = { data: [{ id: '2938', type: 'mappings', attributes: { externalSite: 'myanimelist/anime', externalId: '20' }, relationships: { item: { data: { type: 'anime', id: '11' } } } }], included: [{ id: '11', type: 'anime', attributes: { ageRating: 'PG', ageRatingGuide: 'Teens 13 or older', canonicalTitle: 'Naruto' } }], meta: { count: 1 } };
    const empty = { data: [], meta: { count: 0 } };
    const bodyFor = (id) => (id === '1' ? bebop : id === '20' ? naruto : empty);
    const fetches = [];
    kitsu._setFetch(async (url) => {
      fetches.push(url);
      const m = url.match(/filter%5BexternalId%5D=(\d+)/);
      const id = m ? m[1] : null;
      const body = bodyFor(id);
      return { ok: true, status: 200, json: async () => body };
    });
    kitsu._reset();
    // Fixtures: Bebop R, Naruto PG, empty absent.
    const result = await kitsu.ageRatings([1, 20, 30], log);
    assert.deepStrictEqual(result.get('1'), { rating: 'R', guide: '17+ (violence & profanity)' });
    assert.deepStrictEqual(result.get('20'), { rating: 'PG', guide: 'Teens 13 or older' });
    assert.ok(!result.has('30'), 'empty → absent');
    // Cache: second call for the same ids makes zero fetches.
    const fetchesBefore = fetches.length;
    await kitsu.ageRatings([1, 20, 30], log);
    assert.strictEqual(fetches.length, fetchesBefore, 'no fetches on second call');
    // 429 → returns the partial map, no throw, the 429'd id is not cached.
    kitsu._reset();
    const fetches2 = [];
    kitsu._setFetch(async (url) => {
      fetches2.push(url);
      const m = url.match(/filter%5BexternalId%5D=(\d+)/);
      const id = m ? m[1] : null;
      if (id === '100') return { ok: false, status: 429, json: async () => ({}) };
      const body = bodyFor(id);
      return { ok: true, status: 200, json: async () => body };
    });
    const result3 = await kitsu.ageRatings([1, 100], log);
    assert.deepStrictEqual(result3.get('1'), { rating: 'R', guide: '17+ (violence & profanity)' });
    assert.ok(!result3.has('100'), "429'd id not in result");
    const fetches3 = fetches2.length;
    await kitsu.ageRatings([100], log);
    assert.ok(fetches2.length > fetches3, 'id 100 fetched again (not cached)');
    // Cap: the 41st uncached id in one call is not fetched.
    kitsu._reset();
    const fetches4 = [];
    kitsu._setFetch(async (url) => {
      fetches4.push(url);
      return { ok: true, status: 200, json: async () => ({ data: [], meta: { count: 0 } }) };
    });
    const ids = Array.from({ length: 41 }, (_, i) => 200 + i);
    await kitsu.ageRatings(ids, log);
    assert.strictEqual(fetches4.length, 40, 'cap 40');
    // URL: the request URL contains the site and the id.
    kitsu._reset();
    const fetches5 = [];
    kitsu._setFetch(async (url) => {
      fetches5.push(url);
      return { ok: true, status: 200, json: async () => ({ data: [], meta: { count: 0 } }) };
    });
    await kitsu.ageRatings([1], log);
    assert.ok(fetches5[0].includes('myanimelist'), 'site in URL');
    assert.ok(fetches5[0].includes('filter%5BexternalId%5D=1'), 'id in URL');
  });

  // ---- AS5: lanes.verdictType ----
  await ok('AS5: lanes.verdictType — anime/movie/series; lookupType unchanged', async () => {
    assert.strictEqual(lanes.verdictType('anime'), 'anime');
    assert.strictEqual(lanes.verdictType('movie'), 'movie');
    assert.strictEqual(lanes.verdictType('series'), 'series');
    assert.strictEqual(lanes.lookupType('anime'), 'series', 'lookupType(anime) still series');
  });

  // ---- AR1: MDBList age_rating is only a Common Sense age when a real review exists ----
  await ok('AR1: commonSenseAges reviewedOnly — real review kept, TV-certification restatement dropped, cache learns it', async () => {
    const mdblist = require('../src/services/mdblist');
    const mdbStore = require('../src/store');
    const realFetch = global.fetch;
    let posts = 0;
    // Shapes taken from the live MDBList response for Monogatari (tt1480925): commonsense false, age_rating 14, certification TV-14.
    const batch = [
      { ids: { imdb: 'tt9001' }, commonsense: true, age_rating: 13, certification: 'TV-14', commonsense_media: { common_sense: 13, parental_source: 1 } },
      { ids: { imdb: 'tt9002' }, commonsense: false, age_rating: 14, certification: 'TV-14', commonsense_media: { common_sense: 14, parental_source: 2 } },
      { ids: { imdb: 'tt9003' }, commonsense: true, age_rating: 10, certification: 'TV-PG' },
    ];
    global.fetch = async (url, opts) => {
      if (String(url).includes('api.mdblist.com/imdb/show') && opts && opts.method === 'POST') {
        posts++;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => batch };
      }
      throw new Error('unexpected fetch ' + url);
    };
    try {
      assert.strictEqual(mdblist.hasCommonSenseReview(batch[0]), true);
      assert.strictEqual(mdblist.hasCommonSenseReview(batch[1]), false, 'commonsense:false is not a review');
      assert.strictEqual(mdblist.hasCommonSenseReview({ commonsense: 12 }), true, 'a numeric value (older responses) counts');
      assert.strictEqual(mdblist.hasCommonSenseReview(null), false);
      const ids = ['tt9001', 'tt9002', 'tt9003'];
      // reviewedOnly: only the real reviews.
      const only = await mdblist.commonSenseAges('k'.repeat(32), 'series', ids, log, { reviewedOnly: true });
      assert.deepStrictEqual([...only].sort(), [['tt9001', 13], ['tt9003', 10]], 'tt9002 (no real review) is absent');
      assert.strictEqual(posts, 1, 'one batch request');
      // The cache now knows which entries are real: a second reviewedOnly call makes no request.
      const again = await mdblist.commonSenseAges('k'.repeat(32), 'series', ids, log, { reviewedOnly: true });
      assert.deepStrictEqual([...again].sort(), [['tt9001', 13], ['tt9003', 10]]);
      assert.strictEqual(posts, 1, 'served from the cache');
      const cached = mdbStore.loadCsmCache();
      assert.strictEqual(cached['show:tt9002'].real, false);
      assert.strictEqual(cached['show:tt9001'].real, true);
      // Default mode (movies, series, kids catalogs) is unchanged: it still returns all three ages.
      const all = await mdblist.commonSenseAges('k'.repeat(32), 'series', ids, log);
      assert.deepStrictEqual([...all].sort(), [['tt9001', 13], ['tt9002', 14], ['tt9003', 10]], 'default mode keeps the age_rating for every title');
      assert.strictEqual(posts, 1, 'default mode also served from the cache');
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---- AR2: a cache entry from before this change (no `real` flag) is re-fetched once in reviewedOnly mode ----
  await ok('AR2: legacy cache entry without a real flag — reviewedOnly refetches, default mode does not', async () => {
    const mdblist = require('../src/services/mdblist');
    const mdbStore = require('../src/store');
    const realFetch = global.fetch;
    let posts = 0;
    global.fetch = async (url, opts) => {
      posts++;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ ids: { imdb: 'tt9101' }, commonsense: false, age_rating: 14, certification: 'TV-14' }] };
    };
    try {
      const c = mdbStore.loadCsmCache();
      c['show:tt9101'] = { age: 14, at: Date.now() }; // the old shape
      mdbStore.saveCsmCache(c);
      const def = await mdblist.commonSenseAges('k'.repeat(32), 'series', ['tt9101'], log);
      assert.strictEqual(def.get('tt9101'), 14, 'default mode serves the old entry');
      assert.strictEqual(posts, 0, 'no request in default mode');
      const rev = await mdblist.commonSenseAges('k'.repeat(32), 'series', ['tt9101'], log, { reviewedOnly: true });
      assert.strictEqual(rev.has('tt9101'), false, 'refetched, found not to be a real review');
      assert.strictEqual(posts, 1, 'one request to learn it');
      assert.strictEqual(mdbStore.loadCsmCache()['show:tt9101'].real, false, 'now remembered');
    } finally {
      global.fetch = realFetch;
    }
  });

  // ---- AR3: the Monogatari case through the anime chain ----
  await ok('AR3: anime chain — no real Common Sense review → MAL R blocks (it used to be allowed by a restated TV-14)', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1), title(2)];
    // Generic csmAges would say 14 for both (the TV-14 restatement); only title 2 has a real review.
    const csmGeneric = { tt1: 14, tt2: 13 };
    const csmReviewed = { tt2: 13 };
    const mk = (withReviewedSeam) => {
      const { sources, calls } = makeSources({
        csm: csmGeneric,
        malBands: {
          'anime:1': { code: 'R', minAge: 17, adult: false, adultish: false },
          'anime:2': { code: 'PG-13', minAge: 13, adult: false, adultish: false },
        },
      });
      if (withReviewedSeam) {
        sources.csmAgesReviewed = async (_type, imdbIds) => {
          calls.csmReviewed = (calls.csmReviewed || 0) + 1;
          const out = new Map();
          for (const id of imdbIds) if (csmReviewed[id] != null) out.set(id, csmReviewed[id]);
          return out;
        };
      }
      return { sources, calls };
    };
    // With the reviewed-only seam (production): title 1 is decided by MAL (R, 17+ > 14) -> block; title 2 by its real CSM review.
    {
      const { sources, calls } = mk(true);
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      const r1 = result.get('anime:1');
      assert.deepStrictEqual({ v: r1.verdict, s: r1.source, g: r1.rating }, { v: 'block', s: 'mal', g: 'R' });
      const r2 = result.get('anime:2');
      assert.deepStrictEqual({ v: r2.verdict, s: r2.source, g: r2.rating }, { v: 'allow', s: 'csm', g: '13' });
      assert.strictEqual(calls.csmReviewed, 1);
      assert.strictEqual(calls.csm, 0, 'the generic seam is not used for anime when the reviewed one exists');
    }
    // Without the seam (compat for sources that lack it): the old behaviour, CSM 14 allows title 1.
    {
      const { sources } = mk(false);
      const result = await chain.decide(titles, 'anime', tier, sources, log);
      assert.strictEqual(result.get('anime:1').source, 'csm');
      assert.strictEqual(result.get('anime:1').verdict, 'allow');
    }
  });

  // ---- AR4: movies/series never use the reviewed-only seam; real sources expose it ----
  await ok('AR4: series/movie unchanged (generic csmAges); buildSources exposes csmAgesReviewed', async () => {
    const tier = tiers.TIERS[14];
    for (const type of ['series', 'movie']) {
      const t = [{ key: `${type}:1`, imdb_id: 'tt1', adult: false, title: 'X', year: 2020, genres: [] }];
      const { sources, calls } = makeSources({ csm: { tt1: 13 } });
      sources.csmAgesReviewed = async () => { calls.csmReviewed = (calls.csmReviewed || 0) + 1; return new Map(); };
      const result = await chain.decide(t, type, tier, sources, log);
      assert.strictEqual(result.get(`${type}:1`).source, 'csm');
      assert.strictEqual(calls.csmReviewed || 0, 0, `${type} never calls the reviewed-only seam`);
    }
    const built = require('../src/ageVerification/sources').buildSources({ id: 'x', name: 'x', filters: {}, keys: {} }, log);
    assert.strictEqual(typeof built.csmAgesReviewed, 'function');
    assert.strictEqual(typeof built.csmAges, 'function');
  });

  // ---- AR5: the one-time purge of restated 'csm' anime verdicts ----
  await ok('AR5: purgeRestatedCsmVerdicts — drops anime csm verdicts once; movie/series/other sources untouched; idempotent', async () => {
    const migration = require('../src/anime/migration');
    const db = require('../src/db');
    store.init();
    const c = db.get();
    const now = Date.now();
    store.recordVerdict('anime', '9501', 'tv14', 'allow', 'csm', '14', now);
    store.recordVerdict('anime', '9502', 'tv14', 'block', 'csm', '15', now);
    store.recordVerdict('anime', '9503', 'tv14', 'allow', 'mal', 'PG-13', now);
    store.recordVerdict('anime', '9504', 'tv14', 'block', 'llm-review', 'llm', now);
    store.recordVerdict('series', '9501', 'tv14', 'allow', 'csm', '14', now);
    store.recordVerdict('movie', '9505', 'tv14', 'allow', 'csm', '12', now);
    const r1 = migration.purgeRestatedCsmVerdicts(log);
    assert.deepStrictEqual({ skipped: r1.skipped, removed: r1.removed }, { skipped: false, removed: 2 });
    const left = c.prepare('SELECT type, tmdb_id, source FROM age_verdicts WHERE tmdb_id IN (\'9501\',\'9502\',\'9503\',\'9504\',\'9505\') ORDER BY type, tmdb_id').all().map((x) => x.type + ':' + x.tmdb_id + ':' + x.source);
    assert.deepStrictEqual(left, ['anime:9503:mal', 'anime:9504:llm-review', 'movie:9505:csm', 'series:9501:csm']);
    // A new anime csm verdict recorded after the purge is kept: the purge runs once.
    store.recordVerdict('anime', '9506', 'tv14', 'allow', 'csm', '13', now);
    const r2 = migration.purgeRestatedCsmVerdicts(log);
    assert.deepStrictEqual({ skipped: r2.skipped, removed: r2.removed }, { skipped: true, removed: 0 });
    assert.ok(c.prepare("SELECT 1 FROM age_verdicts WHERE type = 'anime' AND tmdb_id = '9506'").get(), 'a later verdict survives');
  });

  // ---- AI1: anime profile tier 14 — three candidates ----
  await ok('AI1: anime profile tier 14 — three candidates', async () => {
    const profileId = 'AI1';
    const buildId = decisionLog.newBuildId();
    const profile = { id: profileId, name: 'AI1', filters: { age_limit: 14 } };
    // Pre-seed the decision log rows.
    decisionLog.record(profileId, 'anime', buildId, [
      { item_key: '1001', stage: 'engine', outcome: 'selected', title: 'Anime A' },
      { item_key: '1002', stage: 'engine', outcome: 'selected', title: 'Anime B' },
      { item_key: '1003', stage: 'engine', outcome: 'selected', title: 'Anime C' },
    ]);
    // Stub applyAnimeGate to drop the MAL R candidate.
    const unstub1 = stubApplyAnimeGate(new Map([
      ['1002', { outcome: 'rejected_age', stage: 'mal', rating: 'mal:R', reason: 'MAL R (17+) is above the TV-14 (14+, AU M) band' }],
    ]));
    // Stub verify to return the verdicts.
    const unstub2 = stubVerify(new Map([
      ['anime:1001', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the TV-14 (14+, AU M) band' }],
      ['anime:1003', { verdict: 'block', source: 'kitsu', rating: 'R', reason: 'Kitsu R (17+ (violence & profanity))' }],
    ]));
    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [
          { tmdb_id: '1001', imdb_id: 'tt1001', title: 'Anime A' },
          { tmdb_id: '1002', imdb_id: 'tt1002', title: 'Anime B' },
          { tmdb_id: '1003', imdb_id: 'tt1003', title: 'Anime C' },
        ],
      };
      const result = await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });
      // The returned anime array has 1 candidate: 1001 (MAL PG-13, allow).
      // 1002 is dropped by applyAnimeGate (MAL R) and 1003 is blocked (Kitsu R).
      assert.strictEqual(result.anime.length, 1, 'one anime candidate');
      // The decision log rows.
      const row1 = getRow(profileId, buildId, 1001);
      assert.strictEqual(row1.outcome, 'selected');
      assert.strictEqual(row1.stage, 'mal');
      assert.strictEqual(row1.rating, 'mal:PG-13');
      assert.ok(row1.reason && row1.reason.length > 0, 'non-empty reason');
      const row2 = getRow(profileId, buildId, 1002);
      assert.strictEqual(row2.outcome, 'rejected_age');
      assert.strictEqual(row2.stage, 'mal');
      assert.strictEqual(row2.rating, 'mal:R');
      assert.ok(row2.reason && row2.reason.length > 0, 'non-empty reason');
      const row3 = getRow(profileId, buildId, 1003);
      assert.strictEqual(row3.outcome, 'rejected_age');
      assert.strictEqual(row3.stage, 'kitsu');
      assert.strictEqual(row3.rating, 'kitsu:R');
      assert.ok(row3.reason && row3.reason.includes('Kitsu R'), 'reason contains Kitsu R');
    } finally {
      unstub1();
      unstub2();
    }
  });

  // ---- AI2: verdicts stored as type=anime, none as series ----
  await ok('AI2: verdicts stored as type=anime, none as series', async () => {
    const tier = tiers.TIERS[14];
    // AI2 uses its own tmdb ids (2101-2102) so it does not depend on rows
    // written by any other test.
    const titles = [
      { key: 'anime:2101', imdb_id: 'tt2101', adult: false, title: 'Anime A', year: 2020, genres: [] },
      { key: 'anime:2102', imdb_id: 'tt2102', adult: false, title: 'Anime B', year: 2020, genres: [] },
    ];
    const { sources } = makeSources({
      malBands: {
        'anime:2101': { code: 'PG-13', minAge: 13, adult: false, adultish: false },
        'anime:2102': { code: 'R', minAge: 17, adult: false, adultish: false },
      },
    });
    await ageVerify.verify(titles, 'anime', tier, sources, log);
    const db = require('../src/db');
    const rows = db.get().prepare("SELECT type, tmdb_id FROM age_verdicts WHERE tmdb_id IN ('2101', '2102') AND type='anime'").all();
    assert.strictEqual(rows.length, 2, 'two anime verdicts stored');
    const seriesRows = db.get().prepare("SELECT type, tmdb_id FROM age_verdicts WHERE tmdb_id IN ('2101', '2102') AND type='series'").all();
    assert.strictEqual(seriesRows.length, 0, 'no series verdicts for these ids');
  });

  // ---- AI3: movie and series candidate — unchanged results, no kitsu_ratings / no malBands ----
  await ok('AI3: movie and series candidate — unchanged results, no kitsu_ratings / no malBands', async () => {
    const profileId = 'AI3';
    const buildId = decisionLog.newBuildId();
    const profile = { id: profileId, name: 'AI3', filters: { age_limit: 14 } };
    // AI3 uses its own tmdb ids (2201-2202) so it does not depend on rows
    // written by any other test.
    const sourcesModule = require('../src/ageVerification/sources');
    const originalBuildSources = sourcesModule.buildSources;
    let malBandsCalled = false;
    sourcesModule.buildSources = (_profile, _log) => ({
      tmdbRatings: async () => new Map(),
      csmAges: async () => new Map(),
      tvdbRatings: async () => new Map(),
      simklCerts: async () => new Map(),
      mdblistCerts: async () => new Map(),
      llmGate: async (_type, _tier, titles) => {
        const out = new Map();
        for (const t of titles) out.set(t.key, false);
        return out;
      },
      malBands: async () => { malBandsCalled = true; return new Map(); },
      kitsuRatings: async () => new Map(),
    });
    const unstub1 = stubApplyAnimeGate(new Map());
    const db = require('../src/db');
    // Reset the kitsu cache (AS4 may have left rows) and count kitsu_ratings
    // rows before and after — AI3 must not add any.
    kitsu._reset();
    const kitsuRowsBefore = db.get().prepare('SELECT * FROM kitsu_ratings').all().length;
    try {
      const stagedByType = {
        movie: [{ tmdb_id: '2201', imdb_id: 'tt2201', title: 'Movie A' }],
        series: [{ tmdb_id: '2202', imdb_id: 'tt2202', title: 'Series B' }],
        anime: [],
      };
      const result = await rec.stagedAgeGate(profile, stagedByType, log, () => {}, { animeBuildId: buildId });
      // The movie and series candidates are blocked by the LLM.
      assert.strictEqual(result.movie.length, 0, 'movie blocked');
      assert.strictEqual(result.series.length, 0, 'series blocked');
      // The malBands seam is not called.
      assert.ok(!malBandsCalled, 'malBands not called');
      // No new kitsu_ratings rows.
      const kitsuRowsAfter = db.get().prepare('SELECT * FROM kitsu_ratings').all().length;
      assert.strictEqual(kitsuRowsAfter, kitsuRowsBefore, 'no new kitsu_ratings rows');
    } finally {
      sourcesModule.buildSources = originalBuildSources;
      unstub1();
    }
  });

  // ---- AI4: passesAgeBand — anime block → false; series-only verdict → falls through ----
  await ok('AI4: passesAgeBand — anime block → false; series-only verdict → falls through', async () => {
    const tier = tiers.TIERS[14];
    // AI4 uses its own tmdb ids (2301-2303) so it does not depend on rows
    // written by any other test.
    // Store an anime verdict block.
    store.recordVerdict('anime', '2301', tier.id, 'block', 'kitsu', 'R', Date.now(), { reason: 'Kitsu R (17+ (violence & profanity))', title: 'Anime A' });
    // Store a series verdict allow for a different tmdb_id.
    store.recordVerdict('series', '2302', tier.id, 'allow', 'au', 'M', Date.now());
    // Store a series verdict allow for the series-only id (no anime verdict for this id).
    store.recordVerdict('series', '2303', tier.id, 'allow', 'au', 'M', Date.now());
    // Anime pool row with a stored anime verdict block → false.
    const row1 = { type: 'anime', tmdb_id: '2301' };
    assert.strictEqual(rec.passesAgeBand(row1, { age_limit: 14 }), false, 'anime block → false');
    // Series pool row with a stored series verdict allow → true.
    const row2 = { type: 'series', tmdb_id: '2302' };
    assert.strictEqual(rec.passesAgeBand(row2, { age_limit: 14 }), true, 'series allow → true');
    // Anime pool row with the verdict stored only as series → falls through to the old rules.
    const row3 = { type: 'anime', tmdb_id: '2303' };
    assert.strictEqual(rec.passesAgeBand(row3, { age_limit: 14 }), true, 'anime row with series verdict → falls through (true)');
  });

  console.log(`\nAll anime age chain checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
