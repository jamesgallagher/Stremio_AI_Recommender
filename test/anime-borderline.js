// AGE-3b: the anime borderline LLM review + the Anime catalog preview heading fix.
// Run: node --experimental-sqlite test/anime-borderline.js
// Browser checks: node --experimental-sqlite test/anime-borderline.js --browser
'use strict';
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = os.tmpdir() + '/ai-rec-age3b-' + Date.now();
process.env.PORT = '7319'; // distinct from the other suites (7311-7318 are taken)
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key';

const tiers = require('../src/ageVerification/tiers');
const store = require('../src/ageVerification/store');
const evidence = require('../src/anime/evidence');
const borderlineReview = require('../src/anime/borderlineReview');
const groq = require('../src/services/groq');
const llm = require('../src/services/llm');
const anilist = require('../src/services/anilist');
const decisionLog = require('../src/anime/decisionLog');
const rebuild = require('../src/rebuild');
const ageVerify = require('../src/ageVerification');
const rec = require('../src/recommendationStore');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const log = { log: () => {}, warn: () => {}, error: () => {} };
const profile = { id: 'test', name: 'Test', filters: { age_limit: 14 } };

// A title in the review's shape.
const title = (id, genres = []) => ({ key: `anime:${id}`, tmdb_id: String(id), imdb_id: `tt${id}`, title: `Anime ${id}`, year: 2020, genres });

(async () => {
  console.log('anime-borderline:');

  // ---- BR1: triggerFor ----
  await ok('BR1: triggerFor — mal-pg13, anidb, anilist, order, env override', async () => {
    const tier14 = tiers.TIERS[14];
    const tier12 = tiers.TIERS[12];

    // tier 14 + MAL PG-13 → mal-pg13
    const ev1 = { mal: { code: 'PG-13', minAge: 13, adult: false, adultish: false }, kitsu: null, anilist: null, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev1, tier14), 'mal-pg13');

    // tier 12 + PG-13 → null (at 10+/12+ a PG-13 was already blocked upstream)
    assert.strictEqual(evidence.triggerFor(ev1, tier12), null);

    // AniDB {nudity: 300} → anidb:nudity
    const ev2 = { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev2, tier14), 'anidb:nudity');

    // AniDB {nudity: 299} → null
    const ev3 = { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 299 } }, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev3, tier14), null);

    // AniList tag Nudity rank 60 → anilist:Nudity
    const ev4 = { mal: null, kitsu: null, anilist: { isAdult: false, genres: [], tags: [{ name: 'Nudity', rank: 60 }] }, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev4, tier14), 'anilist:Nudity');

    // AniList tag Nudity rank 59 → null
    const ev5 = { mal: null, kitsu: null, anilist: { isAdult: false, genres: [], tags: [{ name: 'Nudity', rank: 59 }] }, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev5, tier14), null);

    // genre Ecchi → anilist:Ecchi
    const ev6 = { mal: null, kitsu: null, anilist: { isAdult: false, genres: ['Ecchi'], tags: [] }, anidb: null, genres: ['Ecchi'] };
    assert.strictEqual(evidence.triggerFor(ev6, tier14), 'anilist:Ecchi');

    // a tag not in WATCH_TAGS → null
    const ev7 = { mal: null, kitsu: null, anilist: { isAdult: false, genres: [], tags: [{ name: 'Adventure', rank: 90 }] }, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev7, tier14), null);

    // order: a title with both PG-13 and a tag returns mal-pg13
    const ev8 = { mal: { code: 'PG-13', minAge: 13, adult: false, adultish: false }, kitsu: null, anilist: { isAdult: false, genres: [], tags: [{ name: 'Nudity', rank: 70 }] }, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev8, tier14), 'mal-pg13');

    // env override (ANIME_REVIEW_ANILIST_RANK=80) changes the threshold
    process.env.ANIME_REVIEW_ANILIST_RANK = '80';
    const ev9 = { mal: null, kitsu: null, anilist: { isAdult: false, genres: [], tags: [{ name: 'Nudity', rank: 70 }] }, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev9, tier14), null);
    delete process.env.ANIME_REVIEW_ANILIST_RANK;

    // a non-numeric env value falls back to the default
    process.env.ANIME_REVIEW_ANILIST_RANK = 'abc';
    const ev10 = { mal: null, kitsu: null, anilist: { isAdult: false, genres: [], tags: [{ name: 'Nudity', rank: 60 }] }, anidb: null, genres: [] };
    assert.strictEqual(evidence.triggerFor(ev10, tier14), 'anilist:Nudity');
    delete process.env.ANIME_REVIEW_ANILIST_RANK;
  });

  // ---- BR2: floorReason ----
  await ok('BR2: floorReason — each of the three signals; none → null', async () => {
    // AniList isAdult
    const ev1 = { anilist: { isAdult: true }, anidb: null, kitsu: null };
    assert.deepStrictEqual(evidence.floorReason(ev1), { rating: 'anilist:isAdult', reason: 'AniList marks it adult' });

    // AniDB restricted
    const ev2 = { anilist: null, anidb: { restricted: true }, kitsu: null };
    assert.deepStrictEqual(evidence.floorReason(ev2), { rating: 'anidb:restricted', reason: 'AniDB marks it restricted (18+)' });

    // Kitsu R18
    const ev3 = { anilist: null, anidb: null, kitsu: { rating: 'R18' } };
    assert.deepStrictEqual(evidence.floorReason(ev3), { rating: 'kitsu:R18', reason: 'Kitsu rates it R18' });

    // none → null
    const ev4 = { anilist: { isAdult: false }, anidb: { restricted: false }, kitsu: { rating: 'PG' } };
    assert.strictEqual(evidence.floorReason(ev4), null);
  });

  // ---- BR3: evidence.gather with fake deps ----
  await ok('BR3: evidence.gather — assembles all four sources, one tagsFor call, throwing tagsFor → null + warn', async () => {
    const fakeAnimeMap = {
      ensureLoaded: async () => {},
      lookup: (imdbId, tmdbId) => {
        if (imdbId === 'tt1') return { mal: 1, kitsu: 1, anilist: 100, anidb: 1000 };
        if (imdbId === 'tt2') return { mal: 2, kitsu: 2, anilist: 200, anidb: 2000 };
        return null;
      },
    };
    const fakeMal = {
      cachedVerdict: (malId) => {
        if (malId === 1) return { code: 'PG-13', minAge: 13, adult: false, adultish: false };
        return null;
      },
    };
    const fakeKitsu = {
      cached: (malIds) => {
        const out = new Map();
        for (const id of malIds) {
          if (id === 1) out.set(String(id), { rating: 'PG', guide: 'Teens 13 or older' });
        }
        return out;
      },
    };
    const fakeAnidb = {
      cachedAnime: (aid) => {
        if (aid === 1000) return { restricted: false, content: { nudity: 300 } };
        return null;
      },
    };
    const tagsForCalls = [];
    const fakeAnilist = {
      tagsFor: async (ids) => {
        tagsForCalls.push(ids);
        const out = new Map();
        for (const id of ids) {
          if (id === 100) out.set(id, { isAdult: false, genres: ['Ecchi'], tags: [{ name: 'Nudity', rank: 70 }] });
          if (id === 200) out.set(id, { isAdult: true, genres: [], tags: [] });
        }
        return out;
      },
    };

    const titles = [
      { key: 'anime:1', tmdb_id: '1', imdb_id: 'tt1', title: 'Anime 1', year: 2020, genres: ['Action'] },
      { key: 'anime:2', tmdb_id: '2', imdb_id: 'tt2', title: 'Anime 2', year: 2020, genres: [] },
    ];

    const evMap = await evidence.gather(titles, log, { animeMap: fakeAnimeMap, mal: fakeMal, kitsu: fakeKitsu, anidb: fakeAnidb, anilist: fakeAnilist });

    // One tagsFor call for both titles.
    assert.strictEqual(tagsForCalls.length, 1, 'one tagsFor call');
    assert.deepStrictEqual(tagsForCalls[0], [100, 200], 'both anilist ids in one call');

    // Title 1: mal PG-13, kitsu PG, anilist Ecchi + Nudity 70, anidb nudity 300.
    const ev1 = evMap.get('anime:1');
    assert.strictEqual(ev1.mal.code, 'PG-13');
    assert.strictEqual(ev1.kitsu.rating, 'PG');
    assert.strictEqual(ev1.anilist.genres[0], 'Ecchi');
    assert.strictEqual(ev1.anilist.tags[0].name, 'Nudity');
    assert.strictEqual(ev1.anilist.tags[0].rank, 70);
    assert.strictEqual(ev1.anidb.content.nudity, 300);
    // genres: title's own genres + AniList's, de-duplicated.
    assert.ok(ev1.genres.includes('Action'));
    assert.ok(ev1.genres.includes('Ecchi'));

    // Title 2: no mal, no kitsu, anilist isAdult, no anidb.
    const ev2 = evMap.get('anime:2');
    assert.strictEqual(ev2.mal, null);
    assert.strictEqual(ev2.kitsu, null);
    assert.strictEqual(ev2.anilist.isAdult, true);
    assert.strictEqual(ev2.anidb, null);

    // A throwing tagsFor yields anilist: null with a warn, no throw.
    const fakeAnilistThrow = {
      tagsFor: async () => { throw new Error('AniList down'); },
    };
    const warns = [];
    const testLog = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };
    const evMap2 = await evidence.gather(titles, testLog, { animeMap: fakeAnimeMap, mal: fakeMal, kitsu: fakeKitsu, anidb: fakeAnidb, anilist: fakeAnilistThrow });
    const ev1b = evMap2.get('anime:1');
    assert.strictEqual(ev1b.anilist, null, 'anilist null after throw');
    assert.ok(warns.some((m) => m.includes('AniList tagsFor failed')), 'warn logged');
  });

  // ---- BR4: floor → block with zero LLM calls ----
  await ok('BR4: floor → block with zero LLM calls', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1)];

    const fakeEvidence = {
      gather: async (ts) => {
        const out = new Map();
        for (const t of ts) out.set(t.key, { mal: null, kitsu: null, anilist: { isAdult: true, genres: [], tags: [] }, anidb: null, genres: [] });
        return out;
      },
      floorReason: (ev) => {
        if (ev.anilist && ev.anilist.isAdult) return { rating: 'anilist:isAdult', reason: 'AniList marks it adult' };
        return null;
      },
      triggerFor: () => null,
    };
    let llmCalled = false;
    const fakeGroq = {
      animeAgeReview: async () => { llmCalled = true; return new Map(); },
    };

    const result = await borderlineReview.review(profile, tier, titles, log, { evidence: fakeEvidence, groq: fakeGroq });
    const r = result.get('anime:1');
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(r.source, 'hard-floor');
    assert.strictEqual(r.stage, 'hard-floor');
    assert.strictEqual(r.rating, 'anilist:isAdult');
    assert.ok(!llmCalled, 'LLM not called');
  });

  // ---- BR5: only triggered titles reach the LLM ----
  await ok('BR5: only triggered titles reach the LLM, in one call for ≤ 20; ok:false → block; ok:true → ok', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(1), title(2), title(3)];

    const fakeEvidence = {
      gather: async (ts) => {
        const out = new Map();
        for (const t of ts) {
          if (t.key === 'anime:1') out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] });
          else if (t.key === 'anime:2') out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: null, genres: [] });
          else if (t.key === 'anime:3') out.set(t.key, { mal: null, kitsu: null, anilist: { isAdult: true, genres: [], tags: [] }, anidb: null, genres: [] });
        }
        return out;
      },
      floorReason: (ev) => {
        if (ev.anilist && ev.anilist.isAdult) return { rating: 'anilist:isAdult', reason: 'AniList marks it adult' };
        return null;
      },
      triggerFor: (ev) => {
        if (ev.anidb && ev.anidb.content && ev.anidb.content.nudity >= 300) return 'anidb:nudity';
        return null;
      },
    };
    const llmCalls = [];
    const fakeGroq = {
      animeAgeReview: async (_tier, items) => {
        llmCalls.push(items);
        const out = new Map();
        for (const it of items) out.set(it.id, { ok: false, reason: 'Too much nudity for this age' });
        return out;
      },
    };

    const result = await borderlineReview.review(profile, tier, titles, log, { evidence: fakeEvidence, groq: fakeGroq });

    // Title 1: triggered, LLM says ok:false → block.
    const r1 = result.get('anime:1');
    assert.strictEqual(r1.action, 'block');
    assert.strictEqual(r1.source, 'llm-review');
    assert.strictEqual(r1.stage, 'llm-borderline');
    assert.strictEqual(r1.rating, 'llm');
    assert.ok(r1.reason.length > 0, 'reason present');

    // Title 2: no trigger → skip.
    const r2 = result.get('anime:2');
    assert.strictEqual(r2.action, 'skip');

    // Title 3: floor → block (hard-floor).
    const r3 = result.get('anime:3');
    assert.strictEqual(r3.action, 'block');
    assert.strictEqual(r3.source, 'hard-floor');

    // The LLM is called once with only the triggered title.
    assert.strictEqual(llmCalls.length, 1, 'one LLM call');
    assert.strictEqual(llmCalls[0].length, 1, 'one title in the LLM call');
    assert.strictEqual(llmCalls[0][0].id, '1');
  });

  // ---- BR6: cache ----
  await ok('BR6: cache — second review → zero LLM calls; changing VER re-judges', async () => {
    const tier = tiers.TIERS[14];
    const titles = [title(100)];

    const fakeEvidence = {
      gather: async (ts) => {
        const out = new Map();
        for (const t of ts) out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] });
        return out;
      },
      floorReason: () => null,
      triggerFor: () => 'anidb:nudity',
    };
    let llmCalls = 0;
    const fakeGroq = {
      animeAgeReview: async (_tier, items) => {
        llmCalls++;
        const out = new Map();
        for (const it of items) out.set(it.id, { ok: false, reason: 'Too much nudity' });
        return out;
      },
    };
    const deps = { evidence: fakeEvidence, groq: fakeGroq };

    // First review: LLM is called.
    const result1 = await borderlineReview.review(profile, tier, titles, log, deps);
    assert.strictEqual(llmCalls, 1, 'first review calls the LLM');
    assert.strictEqual(result1.get('anime:100').action, 'block');

    // Second review: zero LLM calls, same results.
    const result2 = await borderlineReview.review(profile, tier, titles, log, deps);
    assert.strictEqual(llmCalls, 1, 'second review does not call the LLM');
    assert.strictEqual(result2.get('anime:100').action, 'block');
    assert.strictEqual(result2.get('anime:100').reason, 'Too much nudity');

    // Changing VER re-judges.
    borderlineReview._setVer('v2');
    const result3 = await borderlineReview.review(profile, tier, titles, log, deps);
    assert.strictEqual(llmCalls, 2, 'changing VER re-judges');
    assert.strictEqual(result3.get('anime:100').action, 'block');
    borderlineReview._setVer('v1');
  });

  // ---- BR7: failure rules ----
  await ok('BR7: failure rules — LLM throws, tier 14 → ok/kept; tier 10 → blocked; omitted id same', async () => {
    // tier 14 → ok/kept
    {
      const tier = tiers.TIERS[14];
      const titles = [title(101)];
      const fakeEvidence = {
        gather: async (ts) => {
          const out = new Map();
          for (const t of ts) out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] });
          return out;
        },
        floorReason: () => null,
        triggerFor: () => 'anidb:nudity',
      };
      const fakeGroq = {
        animeAgeReview: async () => { throw new Error('LLM down'); },
      };
      const warns = [];
      const testLog = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };
      const result = await borderlineReview.review(profile, tier, titles, testLog, { evidence: fakeEvidence, groq: fakeGroq });
      const r = result.get('anime:101');
      assert.strictEqual(r.action, 'ok', 'tier 14 → kept');
      assert.strictEqual(r.reason, 'Review unavailable — kept');
      assert.ok(warns.some((m) => m.includes('borderline review LLM call failed')), 'warn logged');
    }
    // tier 10 → blocked
    {
      const tier = tiers.TIERS[10];
      const titles = [title(102)];
      const fakeEvidence = {
        gather: async (ts) => {
          const out = new Map();
          for (const t of ts) out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] });
          return out;
        },
        floorReason: () => null,
        triggerFor: () => 'anidb:nudity',
      };
      const fakeGroq = {
        animeAgeReview: async () => { throw new Error('LLM down'); },
      };
      const result = await borderlineReview.review(profile, tier, titles, log, { evidence: fakeEvidence, groq: fakeGroq });
      const r = result.get('anime:102');
      assert.strictEqual(r.action, 'block', 'tier 10 → blocked');
      assert.strictEqual(r.reason, 'Could not be reviewed — held back for a young profile');
    }
    // omitted id behaves the same way
    {
      const tier = tiers.TIERS[14];
      const titles = [title(103)];
      const fakeEvidence = {
        gather: async (ts) => {
          const out = new Map();
          for (const t of ts) out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] });
          return out;
        },
        floorReason: () => null,
        triggerFor: () => 'anidb:nudity',
      };
      const fakeGroq = {
        animeAgeReview: async () => new Map(), // omits the id
      };
      const result = await borderlineReview.review(profile, tier, titles, log, { evidence: fakeEvidence, groq: fakeGroq });
      const r = result.get('anime:103');
      assert.strictEqual(r.action, 'ok', 'omitted id → kept (tier 14)');
      assert.strictEqual(r.reason, 'Review unavailable — kept');
    }
  });

  // ---- BR8: cap ----
  await ok('BR8: cap — 150 triggered titles → LLM sees 120 (six chunks of 20), the other 30 follow the failure rule', async () => {
    const tier = tiers.TIERS[14];
    const titles = Array.from({ length: 150 }, (_, i) => title(i + 200));

    const fakeEvidence = {
      gather: async (ts) => {
        const out = new Map();
        for (const t of ts) out.set(t.key, { mal: null, kitsu: null, anilist: null, anidb: { restricted: false, content: { nudity: 300 } }, genres: [] });
        return out;
      },
      floorReason: () => null,
      triggerFor: () => 'anidb:nudity',
    };
    const llmCalls = [];
    const fakeGroq = {
      animeAgeReview: async (_tier, items) => {
        llmCalls.push(items);
        const out = new Map();
        for (const it of items) out.set(it.id, { ok: true, reason: 'ok' });
        return out;
      },
    };

    const result = await borderlineReview.review(profile, tier, titles, log, { evidence: fakeEvidence, groq: fakeGroq });

    // Six chunks of 20 (the cap is 120).
    assert.strictEqual(borderlineReview.REVIEW_CAP, 120, 'cap is 120');
    assert.strictEqual(llmCalls.length, 6, 'six LLM calls');
    for (const c of llmCalls) assert.strictEqual(c.length, 20, 'each chunk 20');

    // The first 120 are ok.
    for (let i = 200; i <= 319; i++) {
      const r = result.get(`anime:${i}`);
      assert.strictEqual(r.action, 'ok', `title ${i} ok`);
    }
    // The other 30 follow the failure rule (tier 14 → kept).
    for (let i = 320; i <= 349; i++) {
      const r = result.get(`anime:${i}`);
      assert.strictEqual(r.action, 'ok', `title ${i} kept (failure rule)`);
      assert.strictEqual(r.reason, 'Review unavailable — kept');
    }
  });

  // ---- BR9: groq.animeAgeReview with llm.chat stubbed ----
  await ok('BR9: groq.animeAgeReview — prompt, fenced JSON, prose-wrapped, unknown ids, <60% throws, 30-word reason cut', async () => {
    const tier = tiers.TIERS[14];
    const items = [
      { id: '1', title: 'Anime A', year: 2020, genres: ['Action'], mal: { code: 'PG-13', minAge: 13 }, kitsu: { rating: 'PG', guide: 'Teens 13 or older' }, tags: [{ name: 'Nudity', rank: 70 }], anidb: { restricted: false, content: { nudity: 300 } }, trigger: 'anilist:Nudity' },
      { id: '2', title: 'Anime B', year: 2021, genres: [], mal: null, kitsu: null, tags: [], anidb: null, trigger: 'mal-pg13' },
    ];

    const originalChat = llm.chat;
    try {
      // Prompt: starts with the tier wording with anime, contains tags with ranks, Flagged because line, omits missing lines.
      llm.chat = async (chain, messages, opts) => {
        const prompt = messages[0].content;
        assert.ok(prompt.startsWith('You are reviewing anime'), 'prompt starts with the tier wording with anime');
        assert.ok(prompt.includes('Nudity 70%'), 'prompt contains the tags with ranks');
        assert.ok(prompt.includes('Flagged because: anilist:Nudity'), 'prompt contains the Flagged because line');
        assert.ok(prompt.includes('Flagged because: mal-pg13'), 'prompt contains the second Flagged because line');
        assert.ok(!prompt.includes('MAL null'), 'MAL line omitted when missing');
        assert.ok(!prompt.includes('Kitsu null'), 'Kitsu line omitted when missing');
        return opts.validate(JSON.stringify([
          { id: '1', ok: false, reason: 'Too much nudity for this age' },
          { id: '2', ok: true, reason: 'Within the standard' },
        ]));
      };
      const result = await groq.animeAgeReview(tier, items, log);
      assert.strictEqual(result.get('1').ok, false);
      assert.strictEqual(result.get('1').reason, 'Too much nudity for this age');
      assert.strictEqual(result.get('2').ok, true);
      assert.strictEqual(result.get('2').reason, 'Within the standard');

      // Fenced JSON parses.
      llm.chat = async (chain, messages, opts) => opts.validate('```json\n[{"id":"1","ok":false,"reason":"Too much nudity"},{"id":"2","ok":true,"reason":"ok"}]\n```');
      const result2 = await groq.animeAgeReview(tier, items, log);
      assert.strictEqual(result2.get('1').ok, false);
      assert.strictEqual(result2.get('2').ok, true);

      // Prose-wrapped array parses.
      llm.chat = async (chain, messages, opts) => opts.validate('Here is the result: [{"id":"1","ok":false,"reason":"Too much nudity"},{"id":"2","ok":true,"reason":"ok"}]');
      const result3 = await groq.animeAgeReview(tier, items, log);
      assert.strictEqual(result3.get('1').ok, false);
      assert.strictEqual(result3.get('2').ok, true);

      // Unknown ids are dropped.
      llm.chat = async (chain, messages, opts) => opts.validate(JSON.stringify([
        { id: '1', ok: false, reason: 'Too much nudity' },
        { id: '999', ok: true, reason: 'Unknown id' },
        { id: '2', ok: true, reason: 'ok' },
      ]));
      const result4 = await groq.animeAgeReview(tier, items, log);
      assert.ok(!result4.has('999'), 'unknown id dropped');
      assert.strictEqual(result4.get('1').ok, false);

      // Fewer than 60% verdicts throws.
      llm.chat = async (chain, messages, opts) => opts.validate(JSON.stringify([
        { id: '1', ok: false, reason: 'Too much nudity' },
      ]));
      let threw = false;
      try {
        await groq.animeAgeReview(tier, items, log);
      } catch (e) {
        threw = true;
        assert.ok(e.message.includes('verdicts'), 'throws with verdicts error');
      }
      assert.ok(threw, 'fewer than 60% verdicts throws');

      // A 30-word reason is cut to 20 words.
      const longReason = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
      llm.chat = async (chain, messages, opts) => opts.validate(JSON.stringify([
        { id: '1', ok: false, reason: longReason },
        { id: '2', ok: true, reason: 'ok' },
      ]));
      const result5 = await groq.animeAgeReview(tier, items, log);
      const words = result5.get('1').reason.split(' ');
      assert.strictEqual(words.length, 20, 'reason cut to 20 words');
    } finally {
      llm.chat = originalChat;
    }
  });

  // ---- BR10: anilist.tagsFor with global.fetch stubbed ----
  await ok('BR10: anilist.tagsFor — 120 ids → 3 requests (50/50/20), shape, spoiler tags dropped, missing id absent, 429 throws', async () => {
    const fetches = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      fetches.push(JSON.parse(opts.body));
      const ids = opts.body && JSON.parse(opts.body).variables.ids;
      const media = (ids || []).map((id) => ({
        id,
        isAdult: id === 5,
        genres: id === 5 ? ['Hentai'] : ['Action'],
        tags: [
          { name: 'Nudity', rank: 70, isMediaSpoiler: false },
          { name: 'Spoiler', rank: 80, isMediaSpoiler: true },
        ],
      }));
      return { ok: true, status: 200, json: async () => ({ data: { Page: { media } } }) };
    };

    try {
      const ids = Array.from({ length: 120 }, (_, i) => i + 1);
      const result = await anilist.tagsFor(ids);

      // 3 requests (50/50/20).
      assert.strictEqual(fetches.length, 3, '3 requests');
      assert.strictEqual(fetches[0].variables.ids.length, 50, 'first request 50 ids');
      assert.strictEqual(fetches[1].variables.ids.length, 50, 'second request 50 ids');
      assert.strictEqual(fetches[2].variables.ids.length, 20, 'third request 20 ids');

      // Shape.
      const ev1 = result.get(1);
      assert.strictEqual(ev1.isAdult, false);
      assert.deepStrictEqual(ev1.genres, ['Action']);
      assert.deepStrictEqual(ev1.tags, [{ name: 'Nudity', rank: 70 }], 'spoiler tag dropped');

      // Missing id is absent.
      assert.ok(!result.has(999), 'missing id absent');

      // 429 throws with .status === 429.
      global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
      let threw = false;
      try {
        await anilist.tagsFor([1]);
      } catch (e) {
        threw = true;
        assert.strictEqual(e.status, 429, '429 throws with .status === 429');
      }
      assert.ok(threw, '429 throws');
    } finally {
      global.fetch = originalFetch;
    }
  });

  // ---- Integration helpers (BR11-BR14) ----
  const seedPoolAnime = (profileId, tmdbId, title) => {
    rec.upsertCandidates(profileId, [
      { type: 'anime', tmdb_id: String(tmdbId), imdb_id: 'tt' + tmdbId, title, year: 2020, primary_genre: 'Action', genres: 'Action,Anime', vote_average: 7.5, affinity: 0.9, rec_count: 1, because_title: 'W', poster: '/p1.jpg', imdb_rating: 7.5, popularity: 0 },
    ], { ratingCheckedAt: Date.now() });
  };
  const seedDecisionRow = (profileId, buildId, tmdbId, title) => {
    decisionLog.record(profileId, 'anime', buildId, [{ item_key: String(tmdbId), stage: 'engine', outcome: 'selected', title }]);
  };
  const getRow = (profileId, buildId, tmdbId) => {
    const { rows } = decisionLog.list(profileId, 'anime', { build: buildId });
    return rows.find((r) => r.item_key === String(tmdbId));
  };
  const stubApplyAnimeGate = (dropMap) => {
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
  };
  const stubVerify = (verdictMap) => {
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
  };

  // ---- BR11: staged, tier 14 ----
  await ok('BR11: staged tier 14 — LLM ok:false → dropped, row rejected_llm, age_verdicts block, passesAgeBand false; ok:true → stays', async () => {
    const profileId = 'BR11';
    const buildId = decisionLog.newBuildId();
    const prof = { id: profileId, name: 'BR11', filters: { age_limit: 14 } };

    seedDecisionRow(profileId, buildId, 1001, 'Anime A');
    seedDecisionRow(profileId, buildId, 1002, 'Anime B');

    const unstub1 = stubApplyAnimeGate(new Map());
    const unstub2 = stubVerify(new Map([
      ['anime:1001', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
      ['anime:1002', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
    ]));

    const originalReview = borderlineReview.review;
    borderlineReview.review = async (_profile, _tier, titles) => {
      const out = new Map();
      for (const t of titles) {
        if (t.tmdb_id === '1001') {
          out.set(t.key, { action: 'block', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Too much nudity for this age', trigger: 'anilist:Nudity' });
        } else if (t.tmdb_id === '1002') {
          out.set(t.key, { action: 'ok', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Within the standard', trigger: 'anilist:Nudity' });
        }
      }
      return out;
    };

    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [
          { tmdb_id: '1001', imdb_id: 'tt1001', title: 'Anime A', year: 2020, genres: 'Action' },
          { tmdb_id: '1002', imdb_id: 'tt1002', title: 'Anime B', year: 2020, genres: 'Action' },
        ],
      };
      const result = await rec.stagedAgeGate(prof, stagedByType, log, () => {}, { animeBuildId: buildId });

      // Title A is dropped.
      assert.strictEqual(result.anime.length, 1, 'one anime candidate');
      assert.strictEqual(result.anime[0].tmdb_id, '1002', 'title B stays');

      // Decision row for title A.
      const rowA = getRow(profileId, buildId, 1001);
      assert.strictEqual(rowA.outcome, 'rejected_llm');
      assert.strictEqual(rowA.stage, 'llm-borderline');
      assert.ok(rowA.reason && rowA.reason.includes('Too much nudity'), 'reason contains the model reason');

      // Decision row for title B.
      const rowB = getRow(profileId, buildId, 1002);
      assert.ok(rowB.reason && rowB.reason.startsWith('Borderline (anilist:Nudity): reviewed OK'), 'reason starts with Borderline');

      // age_verdicts has type=anime, verdict=block, source=llm-review.
      const db = require('../src/db');
      const verdictRow = db.get().prepare("SELECT type, verdict, source FROM age_verdicts WHERE tmdb_id = '1001' AND type = 'anime'").get();
      assert.strictEqual(verdictRow.verdict, 'block');
      assert.strictEqual(verdictRow.source, 'llm-review');

      // passesAgeBand for that row is false.
      const row = { type: 'anime', tmdb_id: '1001' };
      assert.strictEqual(rec.passesAgeBand(row, { age_limit: 14 }), false, 'passesAgeBand false');
    } finally {
      borderlineReview.review = originalReview;
      unstub1();
      unstub2();
    }
  });

  // ---- BR12: floor in the integration ----
  await ok('BR12: floor in the integration — AniList isAdult → dropped, row rejected_age, stage hard-floor, rating anilist:isAdult', async () => {
    const profileId = 'BR12';
    const buildId = decisionLog.newBuildId();
    const prof = { id: profileId, name: 'BR12', filters: { age_limit: 14 } };

    seedDecisionRow(profileId, buildId, 2001, 'Anime C');

    const unstub1 = stubApplyAnimeGate(new Map());
    const unstub2 = stubVerify(new Map([
      ['anime:2001', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
    ]));

    const originalReview = borderlineReview.review;
    borderlineReview.review = async (_profile, _tier, titles) => {
      const out = new Map();
      for (const t of titles) {
        out.set(t.key, { action: 'block', source: 'hard-floor', stage: 'hard-floor', rating: 'anilist:isAdult', reason: 'AniList marks it adult', trigger: null });
      }
      return out;
    };

    try {
      const stagedByType = {
        movie: [],
        series: [],
        anime: [
          { tmdb_id: '2001', imdb_id: 'tt2001', title: 'Anime C', year: 2020, genres: 'Action' },
        ],
      };
      const result = await rec.stagedAgeGate(prof, stagedByType, log, () => {}, { animeBuildId: buildId });

      assert.strictEqual(result.anime.length, 0, 'title dropped');

      const row = getRow(profileId, buildId, 2001);
      assert.strictEqual(row.outcome, 'rejected_age');
      assert.strictEqual(row.stage, 'hard-floor');
      assert.strictEqual(row.rating, 'anilist:isAdult');
    } finally {
      borderlineReview.review = originalReview;
      unstub1();
      unstub2();
    }
  });

  // ---- BR13: urgent path ----
  await ok('BR13: urgent path — the same as BR11 through ageGatePool: pool row gone, decision row updated', async () => {
    const profileId = 'BR13';
    const buildId = decisionLog.newBuildId();
    const prof = { id: profileId, name: 'BR13', filters: { age_limit: 14 } };

    seedPoolAnime(profileId, 3001, 'Anime D');
    seedPoolAnime(profileId, 3002, 'Anime E');
    seedDecisionRow(profileId, buildId, 3001, 'Anime D');
    seedDecisionRow(profileId, buildId, 3002, 'Anime E');

    const unstub1 = stubApplyAnimeGate(new Map());
    const unstub2 = stubVerify(new Map([
      ['anime:3001', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
      ['anime:3002', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
    ]));

    const originalReview = borderlineReview.review;
    borderlineReview.review = async (_profile, _tier, titles) => {
      const out = new Map();
      for (const t of titles) {
        if (t.tmdb_id === '3001') {
          out.set(t.key, { action: 'block', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Too much nudity for this age', trigger: 'anilist:Nudity' });
        } else if (t.tmdb_id === '3002') {
          out.set(t.key, { action: 'ok', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Within the standard', trigger: 'anilist:Nudity' });
        }
      }
      return out;
    };

    try {
      await rec.ageGatePool(prof, log, () => {}, { animeBuildId: buildId });

      // The pool row for 3001 is gone.
      const db = require('../src/db');
      const poolRow = db.get().prepare("SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = 'anime' AND tmdb_id = '3001'").get(profileId);
      assert.strictEqual(poolRow, undefined, 'pool row gone');

      // The decision row for 3001 is updated.
      const rowA = getRow(profileId, buildId, 3001);
      assert.strictEqual(rowA.outcome, 'rejected_llm');
      assert.strictEqual(rowA.stage, 'llm-borderline');
      assert.ok(rowA.reason && rowA.reason.includes('Too much nudity'), 'reason contains the model reason');

      // The decision row for 3002 is updated.
      const rowB = getRow(profileId, buildId, 3002);
      assert.ok(rowB.reason && rowB.reason.startsWith('Borderline (anilist:Nudity): reviewed OK'), 'reason starts with Borderline');
    } finally {
      borderlineReview.review = originalReview;
      unstub1();
      unstub2();
    }
  });

  // ---- BR13b: the urgent-path review runs even with NO decision-log build id ----
  await ok('BR13b: urgent path — no animeBuildId: the review still drops the title, no decision rows touched', async () => {
    const profileId = 'BR13b';
    const buildId = decisionLog.newBuildId();
    const prof = { id: profileId, name: 'BR13b', filters: { age_limit: 14 } };

    seedPoolAnime(profileId, 3101, 'Anime X');
    seedDecisionRow(profileId, buildId, 3101, 'Anime X');
    const before = getRow(profileId, buildId, 3101);

    const unstub1 = stubApplyAnimeGate(new Map());
    const unstub2 = stubVerify(new Map([
      ['anime:3101', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
    ]));
    const originalReview = borderlineReview.review;
    let reviewCalls = 0;
    borderlineReview.review = async (_profile, _tier, titles) => {
      reviewCalls++;
      const out = new Map();
      for (const t of titles) out.set(t.key, { action: 'block', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Too much nudity for this age', trigger: 'anilist:Nudity' });
      return out;
    };
    try {
      await rec.ageGatePool(prof, log, () => {}); // no opts at all
      assert.strictEqual(reviewCalls, 1, 'review ran without a build id');
      const db = require('../src/db');
      const poolRow = db.get().prepare("SELECT tmdb_id FROM recommended WHERE profile_id = ? AND type = 'anime' AND tmdb_id = '3101'").get(profileId);
      assert.strictEqual(poolRow, undefined, 'pool row dropped by the review');
      const verdict = db.get().prepare("SELECT verdict, source FROM age_verdicts WHERE type = 'anime' AND tmdb_id = '3101'").get();
      assert.deepStrictEqual({ v: verdict.verdict, s: verdict.source }, { v: 'block', s: 'llm-review' }, 'verdict stored for serve time');
      assert.deepStrictEqual(getRow(profileId, buildId, 3101), before, 'decision row untouched (no build id)');
    } finally {
      borderlineReview.review = originalReview;
      unstub1();
      unstub2();
    }
  });

  // ---- BR14: untouched lanes and failures ----
  await ok('BR14: untouched lanes and failures — movie/series never reach review; review throws → lane unchanged, warn logged', async () => {
    // Movie and series never reach review.
    {
      const profileId = 'BR14a';
      const buildId = decisionLog.newBuildId();
      const prof = { id: profileId, name: 'BR14a', filters: { age_limit: 14 } };

      seedDecisionRow(profileId, buildId, 4001, 'Anime F');

      const unstub1 = stubApplyAnimeGate(new Map());
      const unstub2 = stubVerify(new Map([
        ['anime:4001', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
      ]));

      let reviewCalledFor = [];
      const originalReview = borderlineReview.review;
      borderlineReview.review = async (_profile, _tier, titles) => {
        reviewCalledFor.push(titles.map((t) => t.key));
        return new Map();
      };

      try {
        const stagedByType = {
          movie: [{ tmdb_id: '4002', imdb_id: 'tt4002', title: 'Movie G', year: 2020 }],
          series: [{ tmdb_id: '4003', imdb_id: 'tt4003', title: 'Series H', year: 2020 }],
          anime: [{ tmdb_id: '4001', imdb_id: 'tt4001', title: 'Anime F', year: 2020, genres: 'Action' }],
        };
        await rec.stagedAgeGate(prof, stagedByType, log, () => {}, { animeBuildId: buildId });

        // review is called only for the anime lane.
        assert.strictEqual(reviewCalledFor.length, 1, 'review called once');
        assert.deepStrictEqual(reviewCalledFor[0], ['anime:4001'], 'review called only for the anime title');
      } finally {
        borderlineReview.review = originalReview;
        unstub1();
        unstub2();
      }
    }
    // review throws → lane unchanged, warn logged.
    {
      const profileId = 'BR14b';
      const buildId = decisionLog.newBuildId();
      const prof = { id: profileId, name: 'BR14b', filters: { age_limit: 14 } };

      seedDecisionRow(profileId, buildId, 5001, 'Anime I');

      const unstub1 = stubApplyAnimeGate(new Map());
      const unstub2 = stubVerify(new Map([
        ['anime:5001', { verdict: 'allow', source: 'mal', rating: 'PG-13', reason: 'MAL PG-13 (13+) is within the band' }],
      ]));

      const originalReview = borderlineReview.review;
      borderlineReview.review = async () => { throw new Error('review boom'); };

      const warns = [];
      const testLog = { log: () => {}, warn: (m) => warns.push(m), error: () => {} };
      try {
        const stagedByType = {
          movie: [],
          series: [],
          anime: [{ tmdb_id: '5001', imdb_id: 'tt5001', title: 'Anime I', year: 2020, genres: 'Action' }],
        };
        const result = await rec.stagedAgeGate(prof, stagedByType, testLog, () => {}, { animeBuildId: buildId });

        // The lane is exactly what the chain returned (the title is kept).
        assert.strictEqual(result.anime.length, 1, 'lane unchanged');
        assert.strictEqual(result.anime[0].tmdb_id, '5001', 'title kept');
        assert.ok(warns.some((m) => m.includes('borderline review failed')), 'warn logged');
      } finally {
        borderlineReview.review = originalReview;
        unstub1();
        unstub2();
      }
    }
  });

  // ---- BG1: browser (only with --browser) ----
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const screenshotDir = path.join(process.env.DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
    const pageErrors = [];
    const config = require('../src/config');
    const settings = require('../src/settings');

    // Start the server + admin session.
    require('../src/server');
    const { provisionAdmin, cookieHeader, attachCookie } = require('./helpers/admin-session');
    const { token } = provisionAdmin();
    const restore = attachCookie(`http://localhost:${process.env.PORT}`, cookieHeader(token));
    await new Promise((r) => setTimeout(r, 200));

    // A profile with the anime engine on.
    const p = config.addProfile('AGE3B-bg1');
    config.updateProfile(p.id, { filters: { engine_anime: 'marquee-anime', age_limit: 14 } });

    // Set TMDB + Groq keys so the portal leaves setup mode.
    settings.updateSettings({ keys: { tmdb_api_key: 'x'.repeat(32) }, llm: { groq_api_key: 'gsk_test' } });

    const adminCookie = { name: 'air_sid', value: token, url: `http://localhost:${process.env.PORT}` };

    await ok('BG1: Anime catalog preview heading — "Recommended for you — Anime"', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
      await context.addCookies([adminCookie]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`http://localhost:${process.env.PORT}/configure/`);
      await page.waitForSelector('#userSelect');
      await page.selectOption('#userSelect', p.id);
      await page.waitForSelector('.card[data-id]');

      // Open the Filters/Catalogs tab.
      await page.locator('.tab-btn[data-tab="catalogs"]').click();
      await page.waitForTimeout(500);

      // Click the preview button on the Anime row (the AI catalog, not the trakt one).
      const animeRow = page.locator('.cat-item', { hasText: 'Recommended for you — Anime' });
      await animeRow.locator('.cat-preview').click();

      // Wait until #cpvCount has text.
      await page.waitForFunction(() => {
        const el = document.getElementById('cpvCount');
        return el && el.textContent.trim().length > 0;
      }, { timeout: 10000 });

      // Assert the heading.
      const title = await page.locator('#cpvTitle').textContent();
      assert.strictEqual(title, 'Recommended for you — Anime', 'heading is "Recommended for you — Anime"');

      // Assert catTypeLabel via page.evaluate.
      const catTypeLabelAnime = await page.evaluate(() => catTypeLabel('anime'));
      const catTypeLabelSeries = await page.evaluate(() => catTypeLabel('series'));
      const catTypeLabelMovie = await page.evaluate(() => catTypeLabel('movie'));
      assert.strictEqual(catTypeLabelAnime, 'Anime', 'catTypeLabel(anime) === Anime');
      assert.strictEqual(catTypeLabelSeries, 'Series', 'catTypeLabel(series) === Series');
      assert.strictEqual(catTypeLabelMovie, 'Movies', 'catTypeLabel(movie) === Movies');

      // Screenshot the open dialog.
      await page.locator('#cpvDialog').screenshot({ path: path.join(screenshotDir, 'age3b-bg1-anime-preview.png') });
      await context.close();
    });

    // No page errors.
    await ok('BG2: no page errors', async () => {
      assert.deepStrictEqual(pageErrors, [], 'no page errors');
    });

    await browser.close();
    restore();
  }

  console.log(`\nAll anime borderline review checks passed (${passed}).${failed ? ` FAILED: ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
