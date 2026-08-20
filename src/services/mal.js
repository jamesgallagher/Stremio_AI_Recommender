// MyAnimeList age classification, via Jikan (free, keyless, community-run).
//
// MAL's `rating` field is the thing Common Sense Media never was for anime: a
// graduated age classification with essentially total coverage, because MAL is
// the anime database. That is why this exists.
//
// TWO RULES, POINTING IN OPPOSITE DIRECTIONS — do not collapse them:
//   * NSFW: ANY positive adult signal blocks, permanently, on every profile
//     including adults. Presence is a positive assertion, so it is terminal.
//   * AGE: only a KNOWN rating ABOVE the limit drops a title. A missing rating
//     falls through to the LLM, NEVER to deletion. "No rating" is not "too
//     old" — conflating those is what emptied the kids catalogs under CSM.
//
// SOURCE CHAIN (v6.26): Jikan is community-run and genuinely flaky. Per id the
// lookup falls Jikan -> AniList (same MAL id; NSFW blacklist only, no age band)
// -> stale cache -> unrated. So an outage degrades to, at worst, "LLM decides".
const store = require('../store');
const governor = require('./governor');
const anilist = require('./anilist');

const API = 'https://api.jikan.moe/v4';
const USER_AGENT = 'AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)';
const TTL_MS = 180 * 24 * 3600e3; // classifications are static; cache hard
// Jikan publishes 3/s AND 60/min. 400ms satisfies the per-second limit but is
// 150/min, which earns a 429 — caught in live testing. The per-MINUTE budget
// is the binding one, so pace to ~54/min. Ratings cache for six months, so
// this is a one-time cost per title, not a per-rebuild one.
const RATE_DELAY_MS = 1100;
const LOOKUP_CAP = 60;            // per batch, so one rebuild can't stall on a long list

// MAL rating -> minimum age. The bands are coarse and there is deliberately
// nothing between 13 and 17; that gap is MAL's, not ours.
//   G     All Ages
//   PG    Children            -> 6 (errs young; "children" is below our 8 tier)
//   PG-13 Teens 13 or older   -> 13
//   R     17+ (violence & profanity)
//   R+    Mild Nudity         -> 17, and never for an age-limited profile
//   Rx    Hentai              -> permanent blacklist, all profiles
const BANDS = [
  { test: /^rx\b|hentai/i, code: 'Rx', minAge: 99, adult: true },
  { test: /^r\+|mild nudity/i, code: 'R+', minAge: 17, adultish: true },
  { test: /^r\b|17\+/i, code: 'R', minAge: 17 },
  { test: /^pg-?13|teens 13/i, code: 'PG-13', minAge: 13 },
  { test: /^pg\b|children/i, code: 'PG', minAge: 6 },
  { test: /^g\b|all ages/i, code: 'G', minAge: 0 },
];

// Genres are a second adult signal from the SAME call — no extra request.
const ADULT_GENRES = /^(hentai|erotica)$/i;

function classify(rating) {
  if (!rating || typeof rating !== 'string') return null;
  const s = rating.trim();
  for (const b of BANDS) {
    if (b.test.test(s)) return { code: b.code, minAge: b.minAge, adult: !!b.adult, adultish: !!b.adultish };
  }
  return null;
}

// Parse a Jikan anime payload into our verdict shape.
function parseAnime(data) {
  if (!data) return null;
  const genres = [...(data.genres || []), ...(data.explicit_genres || [])]
    .map((g) => g?.name).filter(Boolean);
  const verdict = classify(data.rating) || { code: null, minAge: null, adult: false, adultish: false };
  if (genres.some((g) => ADULT_GENRES.test(g))) verdict.adult = true;
  return verdict;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jikan sits behind Cloudflare and is genuinely flaky: 429s (rate) plus 5xx
// gateway errors (502/503/504) come in bursts, and a torn keep-alive socket
// surfaces as a network-level "fetch failed". All three are TRANSIENT, so we
// retry a couple of times before giving up. Giving up still means "unrated ->
// LLM decides", never a wrong verdict — retry just stops a Jikan hiccup from
// dumping a whole seed batch to the LLM unclassified.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000; // fail a hung socket fast so the retry can fire

async function fetchRating(malId) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await governor.schedule('jikan', () => fetch(`${API}/anime/${encodeURIComponent(malId)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }));
      if (res.status === 404) return { code: null, minAge: null, adult: false, adultish: false };
      // 429 (rate) and 5xx (gateway) are transient — back off and retry.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Jikan anime/${malId} failed (${res.status})`);
        lastErr.status = res.status;
        if (attempt < MAX_ATTEMPTS) { await sleep(RETRY_BACKOFF_MS); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const err = new Error(`Jikan anime/${malId} failed (${res.status})`);
        err.status = res.status;
        throw err; // 4xx (not 404/429) is not transient — don't retry
      }
      return parseAnime((await res.json())?.data);
    } catch (err) {
      // Network-level failure (fetch failed / timeout / socket reset): transient.
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) { await sleep(RETRY_BACKOFF_MS); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

// A cache entry is a definitive HIT — no live lookup needed — when it is a
// fresh MAL verdict, OR any adult verdict (terminal for every profile, so it
// never needs refreshing regardless of source or age). An AniList non-adult
// verdict is deliberately NOT a hit: we re-attempt MAL each run to upgrade it
// to a real age band, but keep it as a fallback if MAL is still down.
// (Legacy entries have no `source` — treated as MAL, so old caches still hit.)
function isDefinitiveHit(entry, now) {
  if (!entry) return false;
  if (entry.verdict && entry.verdict.adult) return true;
  return entry.source !== 'anilist' && now - entry.at < TTL_MS;
}

// Ratings for many MAL ids. Returns Map<malId, verdict|null>. null means
// "unknown", which callers MUST treat as "fall through to the LLM", never as
// a reason to drop. Lookup order per miss: Jikan -> AniList (same MAL id) ->
// stale cache -> unrated. A rating source outage therefore degrades to, at
// worst, today's behaviour, and usually not even that.
async function ratings(malIds, log = console) {
  const out = new Map();
  const now = Date.now();
  const cache = store.loadAnimeRatings();
  const misses = [];
  const fallback = new Map(); // id -> stale/soft verdict, used only if live lookups fail
  for (const id of new Set(malIds)) {
    const hit = cache[`mal:${id}`];
    if (isDefinitiveHit(hit, now)) { out.set(id, hit.verdict); continue; }
    // An expired or AniList-sourced entry is still worth keeping: age
    // classifications are static, so a stale band beats no band if MAL and
    // AniList are both down this run.
    if (hit && hit.verdict) fallback.set(id, hit.verdict);
    misses.push(id);
  }
  if (!misses.length) return out;

  const queue = misses.slice(0, LOOKUP_CAP);
  if (misses.length > LOOKUP_CAP) {
    log.warn(`[mal] ${misses.length} uncached titles — looking up ${LOOKUP_CAP} this run, the rest next time`);
  }
  const fetched = new Map(); // id -> { verdict, source } to persist
  for (const id of queue) {
    try {
      fetched.set(id, { verdict: await fetchRating(id), source: 'mal' });
    } catch (malErr) {
      // Jikan is down/flaky. Second pass: AniList, by the same MAL id. It can
      // still enforce the NSFW blacklist even when Jikan can't answer.
      try {
        const verdict = await anilist.fetchRating(id);
        fetched.set(id, { verdict, source: 'anilist' });
        log.log(`[mal] ${id}: Jikan failed (${malErr.message}) — AniList answered${verdict.adult ? ' (adult-blocked)' : ''}`);
      } catch (aniErr) {
        // Both sources down. Prefer a stale cached verdict over nothing — an
        // expired band is almost certainly still correct. Else unrated -> LLM.
        if (fallback.has(id)) {
          out.set(id, fallback.get(id));
          log.warn(`[mal] ${id}: Jikan+AniList failed — using stale cached verdict`);
        } else {
          out.set(id, null);
          log.warn(`[mal] lookup ${id} failed (Jikan: ${malErr.message}; AniList: ${aniErr.message}) — treated as unrated`);
        }
      }
    }
    await sleep(RATE_DELAY_MS);
  }

  // Persist what we fetched. Do NOT blanket-prune expired entries: an expired
  // entry we couldn't refresh is our fallback, and dropping it is exactly how a
  // source outage used to throw away good ratings. A successful lookup here
  // overwrites its own entry; the rest are left to serve as fallback.
  const merged = store.loadAnimeRatings();
  for (const [id, { verdict, source }] of fetched) {
    if (verdict !== null) merged[`mal:${id}`] = { verdict, at: now, source };
    out.set(id, verdict);
  }
  store.saveAnimeRatings(merged);
  return out;
}

// Cache-only verdict — no network. For the request path (meta), where an
// outbound call per title open is exactly the latency we refused to accept.
// Memoized briefly so a burst of title opens doesn't re-read the file each
// time. Returns null for "not cached", which callers treat as "don't block".
let ratingsMemo = null;
let ratingsMemoAt = 0;
const MEMO_MS = 60e3;

function cachedVerdict(malId) {
  if (!ratingsMemo || Date.now() - ratingsMemoAt > MEMO_MS) {
    ratingsMemo = store.loadAnimeRatings();
    ratingsMemoAt = Date.now();
  }
  const rec = ratingsMemo[`mal:${malId}`];
  if (!rec || Date.now() - rec.at >= TTL_MS) return null;
  return rec.verdict;
}

// Permanently blocked for EVERY profile, adults included.
const isBlacklisted = (v) => !!v?.adult;

// Blocked for this profile's age. `limit` 0 (adult) blocks nothing here —
// pornography is already gone via isBlacklisted.
function blockedForAge(verdict, limit) {
  if (!verdict || limit <= 0) return false;
  if (verdict.adultish) return true;            // R+ (nudity): never for a minor
  if (verdict.minAge === null) return false;    // unrated -> LLM decides
  return verdict.minAge > limit;
}

module.exports = { ratings, classify, parseAnime, cachedVerdict, isBlacklisted, blockedForAge, BANDS, LOOKUP_CAP };
