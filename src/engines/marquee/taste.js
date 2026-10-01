// Marquee ME-04 (spec §4.3/§4.4/§6.1) — the rating-weighted taste model on
// top of Glass's: Simkl ratings re-weight the watched events, the seeds pick
// the strongest watched titles, and a cached local-LLM taste brief summarizes
// the profile.
//
// MD-4: Glass's taste model / event list / metadata store are REUSED unchanged
// (glass/tasteModel, glass/events, glass/metaStore) — this module only adds
// the rating layer on top. MD-1: the brief uses the LOCAL LLM only (the
// custom chain, never Groq) and degrades to null when absent (MI-3).
// §12 L3: no ratings is the NORMAL case — every rating-dependent feature
// degrades to "watched = +1" cleanly.
const crypto = require('crypto');
const watchedStore = require('../../watchedStore');
const glassEvents = require('../glass/events');
const glassTasteModel = require('../glass/tasteModel');
const glassConfig = require('../glass/config');
const watchedEnrichment = require('../glass/watchedEnrichment');
const metaStore = require('../glass/metaStore');
const tasteFeedback = require('../../tasteFeedback');
const simklCache = require('./simklCache');
const llmCache = require('./llmCache');
const llm = require('../../services/llm');

const DAY_MS = 24 * 3600e3;

// Rating → event weight (Trainer T2, N4): 10 → +3.0 (Loved), 9 → +2.0,
// 7–8 → +1.2, 5–6 → +0.4, 1–4 → −1.2. Pure; null for an unrated title (it
// keeps the watched base).
function ratingWeight(rating, cfg) {
  const rw = cfg?.rating_weights;
  if (!rw) return null;
  if (rating == null || !Number.isFinite(Number(rating))) return null;
  const r = Number(rating);
  if (r === 10) return rw.r10;
  if (r === 9) return rw.r9;
  if (r >= 7) return rw.r7_8;
  if (r >= 5) return rw.r5_6;
  if (r >= 1) return rw.r1_4;
  return null;
}

// Trainer T2 (N3): the Loved tier's recency factor. A 10/10's decay is FLOORED
// at cfg.loved.decay_floor (0.5): a blendedWeight below the floor is scaled up
// by floor/b so the effective decay never drops below the floor. `b` is the same
// blended recency weight buildTasteModel applies (same days, half-lives,
// horizon blend), so the floor is applied identically.
function lovedFactor(days, cfg) {
  const b = glassTasteModel.blendedWeight(days, glassConfig.halfLivesFor(cfg, 'movie'), cfg.horizon_blend);
  const floor = cfg.loved?.decay_floor ?? 0.5;
  if (b <= 0) return 1;
  return b >= floor ? 1 : floor / b;
}

// The rating-weighted event list (spec §4.3 + Trainer T2): Glass's weighted
// event list with each WATCHED event re-weighted by its Simkl rating
// (ev.rating set); rejection events unchanged; a title rated but never watched
// is NOT added (only existing watched events are re-weighted). `ratings` is a
// Map<tmdb_id, rating> (defaults to simklCache.getRatingsMap). `ignored`
// (Set<tmdb_id>, defaults to tasteFeedback.ignoredSet) removes the profile's
// IGNORED films from the list entirely (N2: weight 0 — no taste event of any
// kind; they stay in watchedIdSets, they just never steer taste). A film rated
// 10 (Loved) additionally gets its recency decay floored at
// cfg.loved.decay_floor (N3). Abandoned films are NEUTRAL (N5): no event of any
// kind — the m2 negative 'abandoned' event is gone.
function buildEvents(profileId, cfg, { nowMs = Date.now(), ratings, ignored } = {}) {
  const ratingsMap = ratings || simklCache.getRatingsMap(profileId);
  const ignoredSet = ignored || tasteFeedback.ignoredSet(profileId, 'movie');
  const events = glassEvents.buildEventList(profileId, 'movie', cfg, { nowMs });
  const kept = [];
  for (const ev of events) {
    if (ev.kind === 'watched' && ignoredSet.has(String(ev.tmdb_id))) continue; // N2: ignored films never steer taste
    kept.push(ev);
  }
  for (const ev of kept) {
    if (ev.kind !== 'watched') continue;
    const r = ratingsMap.get(ev.tmdb_id);
    if (r == null) continue;
    const w = ratingWeight(r, cfg);
    if (w != null) {
      ev.weight = w;
      ev.rating = r;
      if (r === 10) {
        const days = Number.isNaN(ev.ts) ? 0 : Math.max(0, (nowMs - ev.ts) / DAY_MS);
        ev.weight *= lovedFactor(days, cfg); // N3: Loved decay floored at cfg.loved.decay_floor
        ev.loved = true;
      }
    }
  }
  return kept;
}

// Full seed ordering (spec §4.3 + Trainer T2): watched movies with a tmdb_id,
// excluding IGNORED films (N2 — never a seed) and titles rated ≤ 4 (a low
// rating is a negative signal — never a seed), weight = (ratingWeight ??
// feedback.watched) × blendedWeight(days, half-lives, horizon blend). A film
// rated 10 (Loved) has its decay floored at cfg.loved.decay_floor (N3) and is
// flagged `loved` so seedsFor can pin it. Sorted by weight desc, ties by newer
// watched_at, then tmdb_id.
function seedOrder(profileId, cfg, { nowMs = Date.now(), ratings, ignored } = {}) {
  const ratingsMap = ratings || simklCache.getRatingsMap(profileId);
  const ignoredSet = ignored || tasteFeedback.ignoredSet(profileId, 'movie');
  const hl = cfg.half_life_days.movie;
  const blend = cfg.horizon_blend;
  const base = cfg.feedback?.watched ?? 1;
  const rows = watchedStore.getWatched(profileId, { type: 'movie' }).filter((w) => w.tmdb_id);
  const out = [];
  for (const w of rows) {
    const id = String(w.tmdb_id);
    if (ignoredSet.has(id)) continue; // N2: ignored films are never seeds
    const r = ratingsMap.get(id);
    if (r != null && r <= 4) continue; // rated ≤ 4 → excluded (spec §4.3)
    const rw = ratingWeight(r, cfg);
    const ts = w.watched_at ? Date.parse(w.watched_at) : NaN;
    const days = Number.isNaN(ts) ? 0 : Math.max(0, (nowMs - ts) / DAY_MS);
    let weight = (rw != null ? rw : base) * glassTasteModel.blendedWeight(days, hl, blend);
    let loved = false;
    if (r === 10) {
      // N3: Loved decay floored at cfg.loved.decay_floor.
      const b = glassTasteModel.blendedWeight(days, hl, blend);
      const floor = cfg.loved?.decay_floor ?? 0.5;
      weight = (rw != null ? rw : base) * Math.max(b, floor);
      loved = true;
    }
    out.push({
      tmdb_id: id, simkl_id: w.simkl_id, imdb_id: w.imdb_id,
      title: w.title, year: w.year, rating: r == null ? null : r, weight, watched_at: w.watched_at, loved,
    });
  }
  out.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const ta = a.watched_at ? Date.parse(a.watched_at) : 0;
    const tb = b.watched_at ? Date.parse(b.watched_at) : 0;
    if (tb !== ta) return tb - ta; // newer watch first on a weight tie
    return a.tmdb_id < b.tmdb_id ? -1 : 1;
  });
  return out;
}

// The seeds (spec §4.3 + Trainer T2): Loved films (rated 10) are PINNED at the
// front of the seed list (at most cfg.loved.pinned_seed_cap), then the rest of
// the seed ordering, capped at cfg.seed_cap (N3: always seeded).
function seedsFor(profileId, cfg, { nowMs, ratings, ignored } = {}) {
  const order = seedOrder(profileId, cfg, { nowMs, ratings, ignored });
  const pinned = order.filter((s) => s.loved).slice(0, cfg.loved?.pinned_seed_cap ?? 15);
  const pinnedSet = new Set(pinned.map((s) => s.tmdb_id));
  const rest = order.filter((s) => !pinnedSet.has(s.tmdb_id));
  return [...pinned, ...rest].slice(0, cfg.seed_cap ?? 40);
}

// The rating-weighted taste model (spec §4.3 + Trainer T2): top up watched
// enrichment first (degrades, never throws — MI-3), then build Glass's taste
// model from the rating-weighted events. Returns the taste model unchanged.
async function buildTaste(profileId, apiKey, cfg, { nowMs = Date.now(), ratings, ignored, enrichFetcher, log = console } = {}) {
  try {
    await watchedEnrichment.enrichWatchedBatch(profileId, 'movie', apiKey, { cap: cfg.enrich_cap, fetcher: enrichFetcher, log });
  } catch (err) {
    log.warn(`[marquee] watched enrichment failed: ${err.message} — building taste without it`);
  }
  return glassTasteModel.buildTasteModel(profileId, 'movie', cfg, {
    nowMs,
    events: buildEvents(profileId, cfg, { nowMs, ratings, ignored }),
  });
}

// Stable hash of the profile's movie watch history + ratings + ignores
// (spec §4.3 + Trainer T2): SHA-256 over the sorted (tmdb_id, rating ?? '',
// watched_at, ignored ? 'I' : '') quadruples. Stable across calls; changes when
// a watch, a rating, or an ignore changes.
function historyHash(profileId, { ratings, ignored } = {}) {
  const ratingsMap = ratings || simklCache.getRatingsMap(profileId);
  const ignoredSet = ignored || tasteFeedback.ignoredSet(profileId, 'movie');
  const rows = watchedStore.getWatched(profileId, { type: 'movie' }).filter((w) => w.tmdb_id);
  const parts = rows.map((w) => [String(w.tmdb_id), String(ratingsMap.get(String(w.tmdb_id)) ?? ''), w.watched_at || '', ignoredSet.has(String(w.tmdb_id)) ? 'I' : '']);
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const p of parts) hash.update(p.join('|') + '\n');
  return hash.digest('hex');
}

// The taste brief prompt (spec §6.1): watch history + taste dims. Deliberately
// says NOTHING about age, suitability, classification or children — age
// belongs to the shared gate (I1), not the brief. Exported so a test can
// assert the exact prompt shape.
function buildBriefPrompt(input) {
  const lines = [
    'You are describing a movie-watching profile for a recommendation engine.',
    "Below is the profile's recent watch history and the taste dimensions the engine derived from it.",
    '',
    'Watch history (title, year, rating):',
  ];
  for (const h of input.watch_history) {
    const rated = h.rating == null ? 'unrated' : (h.rating === 10 ? 'rated 10/10 (LOVED)' : `rated ${h.rating}/10`);
    lines.push(`- ${h.title} (${h.year ?? 'n.d.'}) — ${rated} — ${h.genres.length ? h.genres.join(', ') : 'genre unknown'}`);
  }
  lines.push('', 'Taste dimensions (strongest first):');
  for (const d of input.tastes) lines.push(`- ${d.dim}: ${d.values.join(', ')}`);
  lines.push('', 'Respond with a JSON object with exactly these keys, each an array of at most 8 short strings:');
  lines.push('  loves: genres/styles the profile clearly loves');
  lines.push('  avoids: genres/styles the profile clearly avoids');
  lines.push('  moods: emotional moods the profile gravitates to');
  lines.push('  eras: eras the profile gravitates to');
  lines.push('  standout_titles: the most characteristic titles');
  lines.push('', 'Output ONLY the JSON object.');
  return lines.join('\n');
}

// PURE (spec §6.1): parse the brief JSON. Extracts the first JSON object
// (tolerating code fences / leading prose), keeps only the five keys, coerces
// each to an array of trimmed non-empty strings ≤ 60 chars, and throws if all
// five are empty — the throw makes llm.chat try the next model/provider.
function parseBrief(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); } catch {
    const a = cleaned.indexOf('{'); const b = cleaned.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('no JSON object found');
    obj = JSON.parse(cleaned.slice(a, b + 1));
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('response was not a JSON object');
  const brief = {};
  let total = 0;
  for (const key of ['loves', 'avoids', 'moods', 'eras', 'standout_titles']) {
    let v = obj[key];
    if (v == null) v = [];
    if (!Array.isArray(v)) v = [v];
    brief[key] = v.map((s) => String(s).trim()).filter(Boolean).slice(0, 8).map((s) => s.slice(0, 60));
    total += brief[key].length;
  }
  if (total === 0) throw new Error('brief had no content');
  return brief;
}

// Brief input (spec §6.1): top cfg.brief.input_cap (60) watched movies in the
// SEED ordering (not only the 40 seeds), each with title/year/rating + genres
// (top 2 from the Glass meta cache, else the watched primary_genre), plus the
// top 8 POSITIVE entries of each taste dim (genres, directors, keywords,
// decades).
function buildBriefInput(profileId, taste, cfg, { nowMs, ratings, ignored } = {}) {
  const ratingsMap = ratings || simklCache.getRatingsMap(profileId);
  const order = seedOrder(profileId, cfg, { nowMs, ratings, ignored });
  const cap = cfg.brief?.input_cap ?? 60;
  const metas = metaStore.getMany('movie', order.map((s) => s.tmdb_id));
  const primaryGenre = new Map(watchedStore.getWatched(profileId, { type: 'movie' }).map((w) => [String(w.tmdb_id), w.primary_genre]));
  const watchHistory = order.slice(0, cap).map((s) => {
    const meta = metas.get(s.tmdb_id);
    let genres = meta?.genres?.slice(0, 2) || [];
    if (!genres.length) {
      const pg = primaryGenre.get(s.tmdb_id);
      genres = pg ? [pg] : [];
    }
    return { title: s.title, year: s.year, rating: s.rating, genres };
  });
  const topPositive = (dim, n = 8) => Object.entries(taste?.dims?.[dim] || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
  const tastes = [
    { dim: 'genres', values: topPositive('genres') },
    { dim: 'directors', values: topPositive('directors') },
    { dim: 'keywords', values: topPositive('keywords') },
    { dim: 'decades', values: topPositive('decades') },
  ].filter((t) => t.values.length);
  return { watch_history: watchHistory, tastes };
}

// The cached taste brief (spec §6.1/§4.4). MD-1: LOCAL LLM only — if `chain`
// is empty (no local LLM) return null WITHOUT any network call. Cached in
// marquee_llm_cache (kind 'brief') keyed by historyHash — on a hit the LLM is
// not called. A failed brief is NEVER cached (the next build retries).
async function tasteBrief(profileId, taste, { chain = [], chat = llm.chat, cfg, ratings, ignored, log = console, now = Date.now() } = {}) {
  if (!chain || !chain.length) return null; // no local LLM → no brief, no network (MD-1)
  const key = historyHash(profileId, { ratings, ignored });
  const cached = llmCache.get(profileId, 'brief', key, { now });
  if (cached) return cached;
  const input = buildBriefInput(profileId, taste, cfg, { nowMs: now, ratings, ignored });
  const timeoutMs = Number(process.env.MARQUEE_LLM_TIMEOUT_MS) || cfg.llm_timeout_ms;
  try {
    const brief = await chat(chain, [{ role: 'user', content: buildBriefPrompt(input) }], { temperature: 0, timeoutMs, validate: parseBrief }, log);
    const stored = { ...brief, hash: key };
    llmCache.put(profileId, 'brief', key, stored, now);
    return stored;
  } catch (err) {
    log.warn(`[marquee] taste brief failed: ${err.message} — no brief this build (never cached)`);
    return null;
  }
}

// Hash of a brief's JSON (spec §4.3): P3/P4 use it as their cache key.
function briefHash(brief) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(brief));
  return hash.digest('hex');
}

module.exports = {
  ratingWeight,
  lovedFactor,
  buildEvents,
  seedOrder,
  seedsFor,
  buildTaste,
  historyHash,
  buildBriefPrompt,
  parseBrief,
  tasteBrief,
  briefHash,
};
