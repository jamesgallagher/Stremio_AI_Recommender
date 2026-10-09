// AGE-3b: the anime borderline LLM review. After the anime age chain has
// allowed a title, a second look happens for the *risky* ones: an LLM sees the
// title's content evidence and can only block it, with a one-line reason.
//
// The LLM can only turn an allow into a block, never the reverse. Hard-floor
// signals (AniList isAdult, AniDB restricted, Kitsu R18) block outright with
// no LLM. AniDB data is read from cache only (AGE-3c fills that cache in the
// background); a missing AniDB entry simply means the AniDB triggers don't fire.
const db = require('../db');
const evidence = require('./evidence');
const groq = require('../services/groq');

// Titles reviewed per build (chunks of 20). For a 14+ profile nearly every teen anime is MAL PG-13,
// which triggers the review, so the cap must cover a whole pool (results are cached for 90 days).
const REVIEW_CAP = 120;

const DEFAULT_DEPS = { evidence, groq: { animeAgeReview: groq.animeAgeReview } };

// Cache version and TTL. A fresh row answers without the LLM.
let VER = 'v1';
const TTL_MS = 90 * 86400e3; // 90 days
function _setVer(v) { VER = v; }

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS anime_review (
      tmdb_id TEXT NOT NULL,
      tier    TEXT NOT NULL,
      ver     TEXT NOT NULL,
      ok      INTEGER NOT NULL,
      reason  TEXT,
      trigger TEXT,
      at      INTEGER NOT NULL,
      PRIMARY KEY (tmdb_id, tier, ver)
    );
  `);
  ready = true;
}

// Read a cache row (null when absent or past its TTL).
function cacheGet(tmdbId, tierId) {
  init();
  const row = db.get().prepare('SELECT ok, reason, trigger, at FROM anime_review WHERE tmdb_id = ? AND tier = ? AND ver = ?').get(String(tmdbId), tierId, VER);
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) return null;
  return { ok: row.ok, reason: row.reason, trigger: row.trigger };
}

// Write a cache row.
function cacheSet(tmdbId, tierId, ok, reason, trigger) {
  init();
  db.get().prepare(`
    INSERT INTO anime_review (tmdb_id, tier, ver, ok, reason, trigger, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tmdb_id, tier, ver) DO UPDATE SET
      ok = excluded.ok, reason = excluded.reason, trigger = excluded.trigger, at = excluded.at
  `).run(String(tmdbId), tierId, VER, ok, reason, trigger, Date.now());
}

// The failure rule: a triggered title that could not be reviewed (the LLM call
// threw, it was beyond the 40 cap, or the model omitted it). For a strict tier
// (csmMaxAge <= 12, i.e. 10+/12+) it is blocked; for 14+/15+ it is kept.
// Not cached.
function failureResult(tier, trigger) {
  const strict = tier.csmMaxAge <= 12;
  if (strict) {
    return { action: 'block', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Could not be reviewed — held back for a young profile', trigger };
  }
  return { action: 'ok', source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: 'Review unavailable — kept', trigger };
}

// Review the borderline titles. `titles` is an array of
// { key, tmdb_id, imdb_id, title, year, genres: [string] }. Returns
// Map<key, result> where result is { action: 'block' | 'ok' | 'skip', source,
// stage, rating, reason, trigger }.
//
//   1. evidence.gather(...)
//   2. Floor: floorReason(ev) → block (hard-floor).
//   3. Trigger: triggerFor(ev, tier). No trigger → skip.
//   4. Cache: a fresh row answers without the LLM.
//   5. LLM: the remaining triggered titles, at most 40 per call (chunks of 20
//      to groq.animeAgeReview); verdicts are cached (ok and not-ok both; an
//      omitted id is not cached).
//   6. Failure and the cap: a triggered title the LLM could not review
//      (call threw, beyond the 40 cap, or omitted) follows the failure rule.
//      One warn line per call on failure.
async function review(profile, tier, titles, log = console, deps = DEFAULT_DEPS) {
  const { evidence: evMod, groq: groqMod } = deps;

  // 1. Gather the evidence.
  const evMap = await evMod.gather(titles, log);

  const out = new Map();
  const triggered = []; // { t, ev, trigger } for titles that need the LLM

  for (const t of titles) {
    const ev = evMap.get(t.key);
    if (!ev) continue;

    // 2. Floor.
    const floor = evMod.floorReason(ev);
    if (floor) {
      out.set(t.key, { action: 'block', source: 'hard-floor', stage: 'hard-floor', rating: floor.rating, reason: floor.reason, trigger: null });
      continue;
    }

    // 3. Trigger.
    const trigger = evMod.triggerFor(ev, tier);
    if (!trigger) {
      out.set(t.key, { action: 'skip' });
      continue;
    }

    // 4. Cache.
    const cached = cacheGet(t.tmdb_id, tier.id);
    if (cached) {
      const action = cached.ok ? 'ok' : 'block';
      out.set(t.key, { action, source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: cached.reason, trigger });
      continue;
    }

    // 5. LLM (collected, chunked).
    triggered.push({ t, ev, trigger });
  }

  // 5. LLM — at most 40 per call (chunks of 20).
  const CAP = REVIEW_CAP;
  if (triggered.length) {
    const toReview = triggered.slice(0, CAP);
    const beyondCap = triggered.slice(CAP);

    // Chunk into 20s.
    const chunks = [];
    for (let i = 0; i < toReview.length; i += 20) {
      chunks.push(toReview.slice(i, i + 20));
    }

    for (const chunk of chunks) {
      try {
        const items = chunk.map(({ t, ev, trigger }) => ({
          id: t.tmdb_id,
          title: t.title,
          year: t.year,
          genres: ev.genres,
          mal: ev.mal,
          kitsu: ev.kitsu,
          tags: (ev.anilist && ev.anilist.tags) || [],
          anidb: ev.anidb,
          trigger,
        }));
        const results = await groqMod.animeAgeReview(tier, items, log);
        for (const { t, ev, trigger } of chunk) {
          const r = results.get(t.tmdb_id);
          if (r) {
            // Cache the verdict (ok and not-ok both; an omitted id is not cached).
            cacheSet(t.tmdb_id, tier.id, r.ok ? 1 : 0, r.reason, trigger);
            const action = r.ok ? 'ok' : 'block';
            out.set(t.key, { action, source: 'llm-review', stage: 'llm-borderline', rating: 'llm', reason: r.reason, trigger });
          } else {
            // Omitted by the model → failure rule (not cached).
            out.set(t.key, failureResult(tier, trigger));
          }
        }
      } catch (err) {
        // One warn line per call on failure; all titles in this chunk follow
        // the failure rule (not cached).
        log.warn(`[anime] borderline review LLM call failed (${err.message})`);
        for (const { t, trigger } of chunk) {
          out.set(t.key, failureResult(tier, trigger));
        }
      }
    }

    // Beyond the cap → failure rule (not cached).
    for (const { t, trigger } of beyondCap) {
      out.set(t.key, failureResult(tier, trigger));
    }
  }

  return out;
}

module.exports = { review, REVIEW_CAP, VER, TTL_MS, DEFAULT_DEPS, cacheGet, cacheSet, _setVer };
