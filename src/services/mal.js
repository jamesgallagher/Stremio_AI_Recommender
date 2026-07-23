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
const store = require('../store');

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

async function fetchRating(malId, retryOn429 = true) {
  const res = await fetch(`${API}/anime/${encodeURIComponent(malId)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (res.status === 404) return { code: null, minAge: null, adult: false, adultish: false };
  if (res.status === 429 && retryOn429) {
    // One backoff, then give up and let the title go to the LLM unrated. A
    // rate limit must never turn into a wrong verdict in either direction.
    await sleep(3000);
    return fetchRating(malId, false);
  }
  if (!res.ok) {
    const err = new Error(`Jikan anime/${malId} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return parseAnime((await res.json())?.data);
}

// Ratings for many MAL ids. Returns Map<malId, verdict|null>. null means
// "unknown", which callers MUST treat as "fall through to the LLM", never as
// a reason to drop. A Jikan outage therefore degrades to today's behaviour.
async function ratings(malIds, log = console) {
  const out = new Map();
  const now = Date.now();
  const cache = store.loadAnimeRatings();
  const misses = [];
  for (const id of new Set(malIds)) {
    const hit = cache[`mal:${id}`];
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.verdict);
    else misses.push(id);
  }
  if (!misses.length) return out;

  const queue = misses.slice(0, LOOKUP_CAP);
  if (misses.length > LOOKUP_CAP) {
    log.warn(`[mal] ${misses.length} uncached titles — looking up ${LOOKUP_CAP} this run, the rest next time`);
  }
  const fetched = new Map();
  for (const id of queue) {
    try {
      fetched.set(id, await fetchRating(id));
    } catch (err) {
      // Unknown, not blocked. The LLM still reviews it.
      log.warn(`[mal] lookup ${id} failed (${err.message}) — treated as unrated`);
      fetched.set(id, null);
    }
    await sleep(RATE_DELAY_MS);
  }

  const merged = store.loadAnimeRatings();
  for (const [key, entry] of Object.entries(merged)) {
    if (now - entry.at >= TTL_MS) delete merged[key];
  }
  for (const [id, verdict] of fetched) {
    if (verdict !== null) merged[`mal:${id}`] = { verdict, at: now };
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
