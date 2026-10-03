// Marquee TV (TV-3 §3) — the local-LLM layer: the taste brief, the suggestions
// (T7) and the fit score. Mirrors Marquee Cinema's flow (cache-first,
// sequential batches, never-cache-a-failure, a neutral 5 for missing items)
// with the TV prompts.
//
// N2: parseBrief is a VERBATIM copy of Cinema's (marquee/taste.js) — copied,
// not imported, so no Marquee Cinema file changes. The cache kinds are
// tv_brief / tv_suggest / tv_fit so nothing collides with Cinema's
// brief / suggest / fit.
// N3: local LLM only — the caller filters the chain to custom providers.
// N4 (MI-3): no chain, a failed brief or a failed batch never fails the build;
// a failure is never cached.
// N5 (I1): the prompts mention nothing about age, suitability, children,
// classification or ratings boards — age stays with the shared gate.
const crypto = require('crypto');
const llmCache = require('../marquee/llmCache');
const llm = require('../../services/llm');
const tasteFeedback = require('../../tasteFeedback');
const watchedStore = require('../../watchedStore');
const recency = require('../../recency');
const filters = require('./filters');
const mqFeatures = require('../marquee/features');
const llmFit = require('../marquee/llmFit');

// VERBATIM copy of Cinema's parseBrief (marquee/taste.js): extract the first
// JSON object (tolerating code fences / leading prose), keep only the five
// keys, coerce each to an array of trimmed non-empty strings ≤ 60 chars, and
// throw if all five are empty — the throw makes llm.chat try the next
// model/provider.
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

// Hash of a brief's JSON (spec §4.3): the suggest/fit cache keys use it.
function briefHash(brief) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(brief));
  return hash.digest('hex');
}

// §3.1 rung words: how far the viewer got, in the prompt's words.
// sampled_left has weight 0 → value ≤ 0 → excluded by the value > 0 filter.
const RUNG_WORDS = {
  finished: 'finished',
  committed: 'watched most of it',
  engaged: 'engaged',
  tried: 'tried a few episodes',
  sampling: 'just started',
};

// The rung word, with the rating suffix when the show is rated.
function rungWords(rung, rating) {
  let w = RUNG_WORDS[rung] || rung;
  if (rating != null && Number.isFinite(Number(rating))) w += `, rated ${Number(rating)}/10`;
  return w;
}

// F2: Anime ≠ all animation — the exact note appended to the brief and fit
// prompts so the LLM never marks Western animation down as "Anime is avoided".
const ANIME_NOTE = 'Note: "Anime" means Japanese animation only; Western animated series are not anime.';

// §3.1 the prompt, exactly: the shows most-engaged first (rung words, genres,
// networks), the dropped shows (the "avoids" evidence), the excluded genres,
// and the grounded-avoids instruction. Says nothing about age, suitability,
// children, classification or ratings boards (N5 / I1).
function buildBriefPrompt(shows, dropped, excludedGenres) {
  const lines = [
    "You are summarising a TV viewer's taste from the shows they watched.",
    'Shows, most engaged first — "Title" (first-air year): how far they got; genres; network:',
  ];
  for (const s of shows) {
    lines.push(`- "${s.title}" (${s.year ?? 'n.d.'}): ${s.rungWords}; ${s.genres.join(', ')}; ${s.networks.length ? s.networks.join(', ') : 'unknown network'}`);
  }
  lines.push('');
  if (dropped.length) {
    lines.push('Shows they tried and then dropped (one or two episodes, not continued):');
    for (const d of dropped) lines.push(`- "${d.title}" (${d.year ?? 'n.d.'}): ${d.genres.length ? d.genres.join(', ') : 'genres unknown'}`);
  } else {
    lines.push('Shows they tried and then dropped: none');
  }
  lines.push(`Genres they chose to exclude: ${excludedGenres.length ? excludedGenres.join(', ') : 'none'}`);
  lines.push(ANIME_NOTE);
  lines.push('');
  lines.push('Return a JSON object with exactly these keys, each an array of short strings (at most 8 each):');
  lines.push('{"loves": [...], "avoids": [...], "moods": [...], "eras": [...], "standout_titles": [...]}');
  lines.push('"loves" are themes, genres, formats or styles shown by the shows they watched; "moods" are tones; "eras" are periods; "standout_titles" are the 3–8 shows that best define this taste.');
  lines.push('"avoids" must ONLY name themes clearly shown by the dropped shows or the excluded genres above — never anything that appears in the shows they finished or engaged with. If there is no such evidence, "avoids" must be an empty array.');
  lines.push('Output ONLY the JSON object.');
  return lines.join('\n');
}

// §3.1 the cached taste brief. LOCAL LLM only — if `chain` is empty (no local
// LLM) return null WITHOUT any network call (N4). The cache key is a SHA-256
// over the sorted list of "<tmdb_id>:<rung>:<rating or ''>" over ALL
// non-anime value > 0 ladder entries (not just the top 40), extended with
// "<tmdb_id>:sampled_left" for each dropped show and one
// "excluded:<sorted excluded genres>" part — so any change to the "avoids"
// evidence refreshes the brief. Cached in marquee_llm_cache (kind
// 'tv_brief'), no TTL (the key changes when the history or the evidence
// changes). A failed brief is NEVER cached (the next build retries).
async function tvBrief(profileId, ladderEntries, metaById, { chain = [], chat = llm.chat, cfg, log = console, now = Date.now(), isAnimeRow = () => false, filters: profileFilters = {} } = {}) {
  if (!chain || !chain.length) return null; // no local LLM → no brief, no network (N4)
  const ratings = tasteFeedback.getRatingsMap(profileId, 'series');
  const keyParts = [];
  for (const e of ladderEntries) {
    if (!e.row.tmdb_id || isAnimeRow(e.row)) continue;
    if (e.value > 0) {
      keyParts.push(`${e.row.tmdb_id}:${e.rung}:${String(ratings.get(String(e.row.tmdb_id)) ?? '')}`);
    } else if (e.rung === 'sampled_left') {
      keyParts.push(`${e.row.tmdb_id}:sampled_left`);
    }
  }
  keyParts.push(`excluded:${[...(profileFilters.excluded_genres || [])].sort().join(', ')}`);
  keyParts.sort();
  const keyHash = crypto.createHash('sha256');
  for (const p of keyParts) keyHash.update(p + '\n');
  const key = keyHash.digest('hex');
  const cached = llmCache.get(profileId, 'tv_brief', key, { now });
  if (cached) return cached;
  // The "avoids" evidence: the shows they tried and then dropped (non-anime
  // sampled_left, most recently watched first, capped at cfg.brief.dropped_cap).
  const dropped = ladderEntries
    .filter((e) => e.rung === 'sampled_left' && e.row.tmdb_id && !isAnimeRow(e.row))
    .sort((a, b) => (b.row.last_watched_at ?? 0) - (a.row.last_watched_at ?? 0))
    .slice(0, cfg.brief.dropped_cap)
    .map((e) => {
      const m = metaById.get(String(e.row.tmdb_id));
      return {
        title: m ? (m.title || e.row.title) : e.row.title,
        year: m && m.year != null ? m.year : e.row.year,
        genres: m ? filters.tvGenres(m) : [],
      };
    });
  const excludedGenres = [...(profileFilters.excluded_genres || [])];
  const top = ladderEntries
    .filter((e) => e.value > 0 && e.row.tmdb_id && !isAnimeRow(e.row) && metaById.has(String(e.row.tmdb_id)))
    .sort((a, b) => b.value - a.value)
    .slice(0, cfg.brief.top_shows)
    .map((e) => {
      const m = metaById.get(String(e.row.tmdb_id));
      const rating = ratings.get(String(e.row.tmdb_id));
      return {
        title: m.title || e.row.title,
        year: m.year != null ? m.year : e.row.year,
        rungWords: rungWords(e.rung, rating),
        genres: filters.tvGenres(m),
        networks: m.networks || [],
      };
    });
  const timeoutMs = Number(process.env.MARQUEE_LLM_TIMEOUT_MS) || cfg.llm_timeout_ms;
  try {
    const brief = await chat(chain, [{ role: 'user', content: buildBriefPrompt(top, dropped, excludedGenres) }], { temperature: 0, timeoutMs, validate: parseBrief }, log);
    const stored = { ...brief, hash: key };
    llmCache.put(profileId, 'tv_brief', key, stored, now);
    return stored;
  } catch (err) {
    log.warn(`[marquee-tv] taste brief failed: ${err.message} — no brief this build (never cached)`);
    return null;
  }
}

// ── §3.2 Suggestions (T7) ──

// VERBATIM copy of Cinema's parseSuggestions (marquee/sources.js): llm.extractArray,
// then keep only items with a non-empty string title (≤ 120 chars) and an
// optional integer year in 1900..nowYear+1, dedupe by lowercased title + year.
// Throw if no valid items remain (makes chat try the next model/provider).
function parseSuggestions(text, { nowYear = new Date().getFullYear() } = {}) {
  const arr = llm.extractArray(text);
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    if (!title || title.length > 120) continue;
    let year = null;
    if (it.year != null) {
      const y = Number(it.year);
      if (!Number.isInteger(y) || y < 1900 || y > nowYear + 1) continue; // invalid year → dropped
      year = y;
    }
    const key = title.toLowerCase() + '|' + (year == null ? '' : year);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, year });
  }
  if (!out.length) throw new Error('no valid suggestions');
  return out;
}

// §3.2 format words: the allowed format families, in the prompt's words.
const FORMAT_WORDS = {
  scripted: 'scripted series and miniseries',
  reality: 'reality series',
  documentary: 'documentary series',
  talk: 'talk shows',
  news: 'news shows',
  video: 'web video series',
};
function formatWords(families) {
  return [...(families || [])].sort().map((f) => FORMAT_WORDS[f] || f).join(', ');
}

// §3.2 the prompt, exactly: the taste profile, the filter rules in words
// (a rule line is omitted when its value is empty or 0), the format words,
// and the already-watched shows to avoid. Says nothing about age,
// suitability, children, classification or ratings boards (N5 / I1).
function buildSuggestPrompt({ brief, minYear, minRating, excludedGenres, formatWords: fw, avoidList, count }) {
  const lines = [];
  lines.push('You are suggesting TV series for a recommendation engine.');
  lines.push("The viewer's taste profile:");
  lines.push(brief ? JSON.stringify(brief) : '(no profile)');
  lines.push('');
  lines.push('Rules for every suggestion:');
  lines.push('- a TV series, not a film');
  if (minYear) lines.push(`- still airing, or last aired in or after ${minYear}`);
  if (minRating > 0) lines.push(`- rated at least ${minRating} on IMDb`);
  if (excludedGenres && excludedGenres.length) lines.push(`- not these genres: ${excludedGenres.join(', ')}`);
  lines.push('- not anime and not Japanese animation');
  if (fw) lines.push(`- only these formats: ${fw}`);
  lines.push('');
  if (avoidList && avoidList.length) {
    lines.push('Do not suggest these shows (already watched):');
    for (const t of avoidList) lines.push(`- ${t.title} (${t.year == null ? 'n.d.' : t.year})`);
  }
  lines.push('');
  lines.push(`Respond with a JSON array of ${count} objects, each exactly {"title": "...", "year": 2019} (year = the first-air year).`);
  lines.push('Output ONLY the JSON array.');
  return lines.join('\n');
}

// §3.2 the cached LLM suggestions. Only when a brief exists, the chain is
// non-empty and cfg.suggest.enabled. The cache key is sha256(briefHash + '|'
// + filterKey) (kind 'tv_suggest', TTL cfg.suggest.ttl_days); the cached
// value is the RESOLVED list, including tmdb_id:null duds, so a dud is not
// re-searched. On a miss: build the prompt, call chat, then resolve each
// suggestion SEQUENTIALLY through TMDB (N6: untrusted LLM output — only
// title + year are taken). A failed suggestion call is NEVER cached.
async function tvSuggest(profile, ctx, cfg, { brief, briefHash, chain = [], chat = llm.chat, resolve, formatsAllowed, nowYear, log = console, now = Date.now() } = {}) {
  if (!brief || !chain || !chain.length || !cfg.suggest.enabled) return [];
  const filters = (ctx && ctx.filters) || profile.filters || {};
  const filterKey = JSON.stringify({
    min_rating: filters.min_rating || 0,
    min_year: recency.minYearOf(filters, nowYear),
    excluded_genres: (filters.excluded_genres || []).slice().sort(),
    formats: [...(formatsAllowed || new Set())].sort(),
  });
  const key = crypto.createHash('sha256').update(briefHash + '|' + filterKey).digest('hex');
  const cached = llmCache.get(profile.id, 'tv_suggest', key, { ttlMs: cfg.suggest.ttl_days * 86400e3, now });
  if (cached) return cached;
  // The avoid list: the profile's series_progress shows (non-anime), most
  // recent last_watched_at first, the first cfg.suggest.avoid_recent.
  const avoidList = watchedStore.getSeriesProgress(profile.id, { kind: 'show' })
    .sort((a, b) => String(b.last_watched_at || '').localeCompare(String(a.last_watched_at || '')))
    .slice(0, cfg.suggest.avoid_recent)
    .map((w) => ({ title: w.title, year: w.year }));
  const prompt = buildSuggestPrompt({
    brief,
    minYear: recency.minYearOf(filters, nowYear),
    minRating: filters.min_rating || 0,
    excludedGenres: filters.excluded_genres || [],
    formatWords: formatWords(formatsAllowed),
    avoidList,
    count: cfg.suggest.count,
  });
  const timeoutMs = Number(process.env.MARQUEE_LLM_TIMEOUT_MS) || cfg.llm_timeout_ms;
  let suggestions;
  try {
    suggestions = await chat(chain, [{ role: 'user', content: prompt }], {
      temperature: 0.3, timeoutMs, validate: (t) => parseSuggestions(t, { nowYear }),
    }, log);
  } catch (err) {
    log.warn(`[marquee-tv] suggestions failed: ${err.message} — no suggestions this build (never cached)`);
    return [];
  }
  // Resolve sequentially (N6): only title + year from the LLM, resolved
  // through TMDB; a miss is kept as tmdb_id:null (cached, not re-searched).
  const resolved = [];
  for (const s of suggestions) {
    let meta = null;
    try { meta = await resolve(s.title, s.year); } catch { meta = null; }
    if (meta && meta._tmdb_id != null) {
      resolved.push({ title: s.title, year: s.year, tmdb_id: String(meta._tmdb_id), genre_ids: meta._genre_ids || [], vote_average: meta._vote_average || 0, vote_count: meta._vote_count || 0 });
    } else {
      resolved.push({ title: s.title, year: s.year, tmdb_id: null });
    }
  }
  llmCache.put(profile.id, 'tv_suggest', key, resolved, now);
  return resolved;
}

// ── §3.3 The fit score ──

// §3.3 the fit prompt, exactly: the profile brief (one line per non-empty
// key), the per-item lines, the JSON array footer. Omits any brief line whose
// array is empty, and the Overview / Keywords lines when they're empty.
// Says nothing about age, suitability, children, classification or ratings
// boards (N5 / I1).
function buildFitPrompt(brief, items) {
  const lines = [
    "You are judging how well each TV series fits a TV viewer's profile.",
    '',
  ];
  lines.push('Profile brief:');
  for (const key of ['loves', 'avoids', 'moods', 'eras', 'standout_titles']) {
    const v = brief[key];
    if (v && v.length) lines.push(`- ${key}: ${v.join(', ')}`);
  }
  lines.push(ANIME_NOTE);
  lines.push('');
  lines.push('For each series below, return a fit score 0-10 (10 = perfect fit) and a short reason (at most 14 words).');
  lines.push('');
  for (const it of items) {
    lines.push(`- id ${it.id}: "${it.title}" (${it.year == null ? 'n.d.' : it.year}) — ${it.networks && it.networks.length ? it.networks.join(', ') : 'unknown network'}; ${it.tvType}; ${it.seasons} seasons, ${it.episodes} episodes; ${it.status}`);
    lines.push(`  Genres: ${it.genres.join(', ')}`);
    if (it.overview) lines.push(`  Overview: ${it.overview}`);
    if (it.keywords && it.keywords.length) lines.push(`  Keywords: ${it.keywords.join(', ')}`);
  }
  lines.push('');
  lines.push('Respond with a JSON array: [{"id": "<id>", "fit": 0-10, "reason": "<= 14 words"}]');
  lines.push('Output ONLY the JSON array.');
  return lines.join('\n');
}

// §3.3 the cached LLM fit score, folded into the deterministic score as the
// llm_fit feature. LOCAL LLM only — if `chain` is empty (no local LLM), no
// brief, or the feature is disabled, return `scored` UNCHANGED (same array,
// order, scores — NOT a re-sort; N4 / MI-3). The top `candidate_cap` rows are
// scored; the fold applies to EVERY row (a neutral 5 for rows below the cap
// and for items the LLM omitted — never cached). Cache kind 'tv_fit', key
// `${tmdb_id}:${briefHash}`, TTL cfg.llm_fit.ttl_days.
async function tvFit(profileId, scored, { brief, briefHash, cfg, chain = [], chat = llm.chat, log = console, onProgress = () => {}, now = Date.now() } = {}) {
  if (!brief || !chain || !chain.length || cfg.llm_fit.enabled === false) return scored;

  const top = scored.slice(0, cfg.llm_fit.candidate_cap);

  // One cache lookup for the whole top set (kind 'tv_fit', keyed tmdb_id:briefHash:v2 —
  // the :v2 suffix (F2) bypasses the old cached fits after the anime note landed).
  const cached = llmCache.getMany(profileId, 'tv_fit', top.map((r) => `${r.tmdb_id}:${briefHash}:v2`), {
    ttlMs: cfg.llm_fit.ttl_days * 86400e3, now,
  });
  const fitOf = new Map(); // tmdb_id → { fit, reason, cached }
  const uncached = [];
  for (const r of top) {
    const c = cached.get(`${r.tmdb_id}:${briefHash}:v2`);
    if (c && typeof c === 'object' && typeof c.fit === 'number') {
      fitOf.set(r.tmdb_id, { fit: c.fit, reason: c.reason ?? null, cached: true });
    } else {
      uncached.push(r);
    }
  }

  // Batches of cfg.llm_fit.batch, SEQUENTIAL (single GPU — parallel just
  // times out). A batch that throws/times out → every item in it fit 5,
  // uncached; the next batch still runs.
  const batches = [];
  for (let i = 0; i < uncached.length; i += cfg.llm_fit.batch) batches.push(uncached.slice(i, i + cfg.llm_fit.batch));
  const timeoutMs = Number(process.env.MARQUEE_LLM_TIMEOUT_MS) || cfg.llm_timeout_ms;
  let done = 0;
  for (const b of batches) {
    const items = b.map((r) => {
      const m = r.c || {};
      return {
        id: r.tmdb_id,
        title: m.title ?? r.title,
        year: m.year ?? r.year,
        networks: m.networks,
        tvType: m.tvType,
        seasons: m.number_of_seasons,
        episodes: m.number_of_episodes,
        status: m.status,
        genres: filters.tvGenres(m),
        overview: m.overview ? String(m.overview).slice(0, 200) : null,
        keywords: (m.keywords || []).slice(0, 5),
      };
    });
    try {
      const arr = await chat(chain, [{ role: 'user', content: buildFitPrompt(brief, items) }], {
        temperature: 0, timeoutMs, validate: llm.extractArray,
      }, log);
      const parsed = llmFit.parseFit(arr, b.map((r) => r.tmdb_id));
      for (const r of b) {
        const p = parsed.get(r.tmdb_id);
        if (p) {
          fitOf.set(r.tmdb_id, { fit: p.fit, reason: p.reason, cached: false });
          llmCache.put(profileId, 'tv_fit', `${r.tmdb_id}:${briefHash}:v2`, { fit: p.fit, reason: p.reason }, now);
        }
        // missing item → fit 5, reason null, NOT cached (the next build retries)
      }
    } catch (err) {
      log.warn(`[marquee-tv] fit batch ${done + 1}/${batches.length} failed: ${err.message}`);
    }
    done += 1;
    onProgress(Math.round((done / batches.length) * 100), `LLM fit ${done}/${batches.length} batch(es)`);
  }

  // Fold in: llm_fit = fit/10 for EVERY row (neutral 5 below the cap and for
  // missing items — the feature set stays uniform), weights renormalized over
  // the existing weight keys ∪ llm_fit, rankScore recomputed.
  const result = scored.map((r) => {
    const f = fitOf.get(r.tmdb_id);
    const fit = f ? f.fit : 5;
    const reason = f ? f.reason : null;
    const feat = { ...r.scoreComponents.features, llm_fit: fit / 10 };
    const w = mqFeatures.renormalize({ ...cfg.weights, llm_fit: cfg.llm_fit.weight }, [...Object.keys(cfg.weights), 'llm_fit']);
    const rankScore = mqFeatures.weightedSum(feat, w) - r.scoreComponents.penalty;
    return {
      ...r,
      rankScore,
      reason: reason ?? r.reason,
      scoreComponents: { ...r.scoreComponents, features: feat, weights: w, llm: { fit, reason, cached: f ? f.cached : false } },
    };
  });
  result.sort((a, b) => (b.rankScore - a.rankScore) || (a.tmdb_id < b.tmdb_id ? -1 : 1));
  return result;
}

module.exports = { parseBrief, briefHash, rungWords, buildBriefPrompt, tvBrief, parseSuggestions, formatWords, buildSuggestPrompt, tvSuggest, buildFitPrompt, tvFit };
