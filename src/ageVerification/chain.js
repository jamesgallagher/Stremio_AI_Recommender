// AGE-1: the TV-14 decision chain (pure; all data comes from injected sources).
//
// `decide` walks the fixed source chain (mandate A2), first step that answers wins:
//   (0) hard floor → (1) Common Sense age → (2) AU rating → (3) US rating →
//   (4) Simkl → MDBList → GB/IE/NZ/CA → (5) LLM.
// Each step runs ONLY on the titles still undecided and calls its source ONCE per
// step with the whole set (batched). A failing source gives no answer from that
// step (logged, chain continues); the LLM step is the exception — its error
// propagates (A5). Returns Map<key, { verdict: 'allow'|'block'|'unknown', source,
// rating, reason? }>.
//
// AGE-3a: the anime lane has its own chain (plan A9):
//   (0) hard floor (+ MAL adult/adultish, Hentai genre) → (1) Common Sense →
//   (2) MAL band (allow AND block) → (3) AU → (4) US → (5) Kitsu →
//   (6) Simkl / MDBList / GB·IE·NZ·CA / TVDB → (7) LLM last resort.
// The existing steps run on the lookup type ('series'); the new anime steps set
// a `reason` on their results. movie/series results carry no `reason`.
//
// PURE: no network, no DB, no Date.now() — every source is an injected seam.

const { classify, classifyForeign, classifyLoose, isHardFloor, normalizeRating } = require('./ratings');
const mal = require('../services/mal');

// A failing source gives no answer from that step: the chain continues. Returns an
// empty Map on error and logs it (A5). The LLM step is the one exception — it is
// NOT routed through this helper, so its error propagates.
async function safe(fn, type, arg, log, label) {
  try {
    return await fn(type, arg);
  } catch (err) {
    log.warn?.(`[age-verify] ${label} source failed (${err.message}) — no answer from this step`);
    return new Map();
  }
}

async function decide(titles, type, tier, sources, log = console) {
  const result = new Map(); // key -> { verdict, source, rating, reason? }
  let undecided = titles.slice();

  // Anime has its own chain (plan A9): the existing steps plus MAL and Kitsu.
  // Every existing source/classify call takes the lookup type ('series'); for
  // movie/series base === type, so those paths are unchanged.
  const base = type === 'anime' ? 'series' : type;
  const isAnime = type === 'anime';

  // Step 0: hard floor. The TMDB ratings are fetched ONCE for the whole set and
  // reused in steps 3, 4 and 6.
  const tmdbRatings = await safe(sources.tmdbRatings, base, undecided, log, 'tmdb');

  // Anime only: MAL bands are fetched ONCE (cheap — cached MAL verdicts) and
  // reused in step 0 (hard floor) and step 2. A missing seam is skipped.
  let malBands = null;
  if (isAnime && sources.malBands) {
    malBands = await safe(sources.malBands, base, undecided, log, 'mal');
  }

  // TVDB is fetched lazily, at most once per title (steps 3, 4 and 6 share the
  // result). `fetchTvdb` only requests the titles not yet cached.
  const tvdbCache = new Map(); // imdb -> { aus, usa, gbr, irl, nzl, can, ... }
  const fetchTvdb = async (imdbIds) => {
    const missing = imdbIds.filter((id) => !tvdbCache.has(id));
    if (!missing.length) return;
    const fetched = await safe(sources.tvdbRatings, base, missing, log, 'tvdb');
    // Cache the outcome for EVERY requested id (a missing entry = "no data"), so a
    // title is fetched at most once across steps 3, 4 and 6 — including when the
    // source fails (A5: no answer from this step, no retry).
    for (const id of missing) tvdbCache.set(id, fetched.get(id) || {});
  };

  // Step 0: hard floor (adult flag OR TMDB AU/US).
  {
    const next = [];
    for (const t of undecided) {
      // Anime hard-floor additions (checked before the existing floor logic).
      if (isAnime) {
        const band = malBands ? malBands.get(t.key) : null;
        if (band && (mal.isBlacklisted(band) || band.adultish)) {
          result.set(t.key, { verdict: 'block', source: 'hard-floor', rating: 'mal:' + band.code });
          continue;
        }
        if ((t.genres || []).some((g) => /hentai/i.test(g))) {
          result.set(t.key, { verdict: 'block', source: 'hard-floor', rating: 'genre:Hentai' });
          continue;
        }
      }
      if (t.adult) { result.set(t.key, { verdict: 'block', source: 'hard-floor', rating: 'adult' }); continue; }
      const r = tmdbRatings.get(t.key) || {};
      if (isHardFloor(r.AU, r.US, tier)) {
        result.set(t.key, { verdict: 'block', source: 'hard-floor', rating: normalizeRating(r.AU) || normalizeRating(r.US) });
        continue;
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 1: Common Sense age (≤ csmMaxAge allow, ≥ csmMaxAge+1 block).
  if (undecided.length) {
    const csm = await safe(sources.csmAges, base, undecided.map((t) => t.imdb_id), log, 'csm');
    const next = [];
    for (const t of undecided) {
      const age = csm.get(t.imdb_id);
      if (age != null) {
        result.set(t.key, { verdict: age <= tier.csmMaxAge ? 'allow' : 'block', source: 'csm', rating: String(age) });
      } else {
        next.push(t);
      }
    }
    undecided = next;
  }

  // Step 2: MAL band (anime only) — allow AND block, with a reason. A band with
  // no code or minAge is "no answer" (the chain continues). The block test reuses
  // mal.blockedForAge so it can't drift from applyAnimeGate.
  if (isAnime && undecided.length) {
    const next = [];
    for (const t of undecided) {
      const band = malBands ? malBands.get(t.key) : null;
      if (band && band.code != null && band.minAge != null) {
        if (mal.blockedForAge(band, tier.malMaxAge)) {
          result.set(t.key, { verdict: 'block', source: 'mal', rating: band.code, reason: `MAL ${band.code} (${band.minAge}+) is above the ${tier.label} band` });
        } else {
          result.set(t.key, { verdict: 'allow', source: 'mal', rating: band.code, reason: `MAL ${band.code} (${band.minAge}+) is within the ${tier.label} band` });
        }
        continue;
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 3: AU rating — TMDB (step 0) first, missing → TVDB `aus`.
  if (undecided.length) {
    await fetchTvdb(undecided.filter((t) => !(tmdbRatings.get(t.key) || {}).AU).map((t) => t.imdb_id));
    const next = [];
    for (const t of undecided) {
      const tmdbAu = (tmdbRatings.get(t.key) || {}).AU;
      if (tmdbAu) {
        const c = classify(tmdbAu, base, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'au', rating: tmdbAu }); continue; }
        next.push(t);
        continue;
      }
      const tvdb = tvdbCache.get(t.imdb_id) || {};
      if (tvdb.aus) {
        // TVDB AU/US already known and hits the floor → block (only when TVDB was
        // fetched for this title; never fetch TVDB just for the floor).
        if (isHardFloor(tvdb.aus, tvdb.usa, tier)) {
          result.set(t.key, { verdict: 'block', source: 'hard-floor', rating: normalizeRating(tvdb.aus) || normalizeRating(tvdb.usa) });
          continue;
        }
        const c = classify(tvdb.aus, base, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'tvdb-au', rating: tvdb.aus }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 4: US rating — TMDB (step 0) first, missing → TVDB `usa`.
  if (undecided.length) {
    await fetchTvdb(undecided.filter((t) => !(tmdbRatings.get(t.key) || {}).US).map((t) => t.imdb_id));
    const next = [];
    for (const t of undecided) {
      const tmdbUs = (tmdbRatings.get(t.key) || {}).US;
      if (tmdbUs) {
        const c = classify(tmdbUs, base, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'us', rating: tmdbUs }); continue; }
        next.push(t);
        continue;
      }
      const tvdbUs = (tvdbCache.get(t.imdb_id) || {}).usa;
      if (tvdbUs) {
        const c = classify(tvdbUs, base, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'tvdb-us', rating: tvdbUs }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 5: Kitsu rating (anime only). R18 is a hard-floor block; G/PG/R map to
  // a minimum age (PG is 13 — Kitsu's PG means "teens 13 or older"). Unknown
  // ratings are "no answer" (the chain continues).
  if (isAnime && undecided.length && sources.kitsuRatings) {
    const kitsu = await safe(sources.kitsuRatings, base, undecided, log, 'kitsu');
    const KITSU_MIN_AGE = { G: 0, PG: 13, R: 17 };
    const next = [];
    for (const t of undecided) {
      const k = kitsu.get(t.key);
      if (k && k.rating) {
        if (k.rating === 'R18') {
          result.set(t.key, { verdict: 'block', source: 'hard-floor', rating: 'kitsu:R18', reason: 'Kitsu rates it R18' });
          continue;
        }
        const minAge = KITSU_MIN_AGE[k.rating];
        if (minAge != null) {
          const verdict = minAge <= tier.malMaxAge ? 'allow' : 'block';
          result.set(t.key, { verdict, source: 'kitsu', rating: k.rating, reason: `Kitsu ${k.rating} (${k.guide})` });
          continue;
        }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 6a: Simkl certification.
  if (undecided.length) {
    const simkl = await safe(sources.simklCerts, base, undecided.map((t) => t.imdb_id), log, 'simkl');
    const next = [];
    for (const t of undecided) {
      const cert = simkl.get(t.imdb_id);
      if (cert) {
        const c = classify(cert, base, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'simkl', rating: cert }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 6b: MDBList certification (loose — country-less).
  if (undecided.length) {
    const mdb = await safe(sources.mdblistCerts, base, undecided.map((t) => t.imdb_id), log, 'mdblist');
    const next = [];
    for (const t of undecided) {
      const cert = mdb.get(t.imdb_id);
      if (cert) {
        const c = classifyLoose(cert, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'mdblist', rating: cert }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 6c: TMDB GB/IE/NZ/CA, then TVDB gbr/irl/nzl/can (first that classifies).
  if (undecided.length) {
    await fetchTvdb(undecided.map((t) => t.imdb_id));
    const next = [];
    for (const t of undecided) {
      const tmdb = tmdbRatings.get(t.key) || {};
      const tvdb = tvdbCache.get(t.imdb_id) || {};
      let decided = null;
      for (const [cc, label] of [['GB', 'tmdb-gb'], ['IE', 'tmdb-ie'], ['NZ', 'tmdb-nz'], ['CA', 'tmdb-ca']]) {
        const c = classifyForeign(cc, tmdb[cc], tier);
        if (c) { decided = { verdict: c, source: label, rating: tmdb[cc] }; break; }
      }
      if (!decided) {
        for (const [cc, label] of [['gbr', 'tvdb-gbr'], ['irl', 'tvdb-irl'], ['nzl', 'tvdb-nzl'], ['can', 'tvdb-can']]) {
          const c = classifyForeign(cc, tvdb[cc], tier);
          if (c) { decided = { verdict: c, source: label, rating: tvdb[cc] }; break; }
        }
      }
      if (decided) { result.set(t.key, decided); continue; }
      next.push(t);
    }
    undecided = next;
  }

  // Step 7: LLM. Only called when titles remain; its error propagates (A5).
  // true → allow, false → block, omitted → unknown (kept).
  if (undecided.length) {
    const llm = await sources.llmGate(base, tier, undecided); // Map<key, true|false>
    for (const t of undecided) {
      const v = llm.get(t.key);
      if (v === true) result.set(t.key, { verdict: 'allow', source: 'llm', rating: 'ok' });
      else if (v === false) result.set(t.key, { verdict: 'block', source: 'llm', rating: 'no' });
      else result.set(t.key, { verdict: 'unknown', source: 'llm', rating: null });
    }
  }

  return result;
}

module.exports = { decide };
