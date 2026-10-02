// AGE-1: the TV-14 decision chain (pure; all data comes from injected sources).
//
// `decide` walks the fixed source chain (mandate A2), first step that answers wins:
//   (0) hard floor → (1) Common Sense age → (2) AU rating → (3) US rating →
//   (4) Simkl → MDBList → GB/IE/NZ/CA → (5) LLM.
// Each step runs ONLY on the titles still undecided and calls its source ONCE per
// step with the whole set (batched). A failing source gives no answer from that
// step (logged, chain continues); the LLM step is the exception — its error
// propagates (A5). Returns Map<key, { verdict: 'allow'|'block'|'unknown', source,
// rating }>.
//
// PURE: no network, no DB, no Date.now() — every source is an injected seam.

const { classify, classifyForeign, classifyLoose, isHardFloor, normalizeRating } = require('./ratings');

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
  const result = new Map(); // key -> { verdict, source, rating }
  let undecided = titles.slice();

  // Step 0: hard floor. The TMDB ratings are fetched ONCE for the whole set and
  // reused in steps 2, 3 and 4c.
  const tmdbRatings = await safe(sources.tmdbRatings, type, undecided, log, 'tmdb');

  // TVDB is fetched lazily, at most once per title (steps 2, 3 and 4c share the
  // result). `fetchTvdb` only requests the titles not yet cached.
  const tvdbCache = new Map(); // imdb -> { aus, usa, gbr, irl, nzl, can, ... }
  const fetchTvdb = async (imdbIds) => {
    const missing = imdbIds.filter((id) => !tvdbCache.has(id));
    if (!missing.length) return;
    const fetched = await safe(sources.tvdbRatings, type, missing, log, 'tvdb');
    // Cache the outcome for EVERY requested id (a missing entry = "no data"), so a
    // title is fetched at most once across steps 2, 3 and 4c — including when the
    // source fails (A5: no answer from this step, no retry).
    for (const id of missing) tvdbCache.set(id, fetched.get(id) || {});
  };

  // Step 0: hard floor (adult flag OR TMDB AU/US).
  {
    const next = [];
    for (const t of undecided) {
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
    const csm = await safe(sources.csmAges, type, undecided.map((t) => t.imdb_id), log, 'csm');
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

  // Step 2: AU rating — TMDB (step 0) first, missing → TVDB `aus`.
  if (undecided.length) {
    await fetchTvdb(undecided.filter((t) => !(tmdbRatings.get(t.key) || {}).AU).map((t) => t.imdb_id));
    const next = [];
    for (const t of undecided) {
      const tmdbAu = (tmdbRatings.get(t.key) || {}).AU;
      if (tmdbAu) {
        const c = classify(tmdbAu, type, tier);
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
        const c = classify(tvdb.aus, type, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'tvdb-au', rating: tvdb.aus }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 3: US rating — TMDB (step 0) first, missing → TVDB `usa`.
  if (undecided.length) {
    await fetchTvdb(undecided.filter((t) => !(tmdbRatings.get(t.key) || {}).US).map((t) => t.imdb_id));
    const next = [];
    for (const t of undecided) {
      const tmdbUs = (tmdbRatings.get(t.key) || {}).US;
      if (tmdbUs) {
        const c = classify(tmdbUs, type, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'us', rating: tmdbUs }); continue; }
        next.push(t);
        continue;
      }
      const tvdbUs = (tvdbCache.get(t.imdb_id) || {}).usa;
      if (tvdbUs) {
        const c = classify(tvdbUs, type, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'tvdb-us', rating: tvdbUs }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 4a: Simkl certification.
  if (undecided.length) {
    const simkl = await safe(sources.simklCerts, type, undecided.map((t) => t.imdb_id), log, 'simkl');
    const next = [];
    for (const t of undecided) {
      const cert = simkl.get(t.imdb_id);
      if (cert) {
        const c = classify(cert, type, tier);
        if (c) { result.set(t.key, { verdict: c, source: 'simkl', rating: cert }); continue; }
      }
      next.push(t);
    }
    undecided = next;
  }

  // Step 4b: MDBList certification (loose — country-less).
  if (undecided.length) {
    const mdb = await safe(sources.mdblistCerts, type, undecided.map((t) => t.imdb_id), log, 'mdblist');
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

  // Step 4c: TMDB GB/IE/NZ/CA, then TVDB gbr/irl/nzl/can (first that classifies).
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

  // Step 5: LLM. Only called when titles remain; its error propagates (A5).
  // true → allow, false → block, omitted → unknown (kept).
  if (undecided.length) {
    const llm = await sources.llmGate(type, tier, undecided); // Map<key, true|false>
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
