// ME-10 (P5) — the offline engine backtest, as pure / seam-injected functions.
//
// The whole point of ME-10 is to answer "which engine actually picks the
// movies this family will next watch?" on a profile's REAL history, without
// touching the live data or any live API. The script (scripts/bench-engines.js)
// snapshots the live store into a throwaway copy, deletes the holdout titles so
// they CANNOT leak into the build, then calls runBench below. Everything here
// is pure or takes its dependencies (engines, pipeline, rs, watchedStore, db,
// settings, selectServe, now, log) as explicit arguments — so the integration
// suite can drive it hermetically against a temp DB with a stub engine.
//
// Metrics are EXACT (spec §5.5) — the same definitions the report's table uses:
//   hit@20          targets present in the top-20 served (selectServe limit 20)
//   recall@100      targets present in the top 100 of the ranked pool / |targets|
//   meanRankOfHits  mean 1-based position (in the ranked pool) of the hit targets
//   filterPass      selectServe(limit=rows.length).length / rows.length
//   trending@20     share of the top-20 served whose score_components.sources
//                    includes 'trending' (null when the engine emits no
//                    score_components — e.g. Genesis)
const pickTargets = (watched, holdout) => {
  // Spec §5.3: need holdout + 20 watched movies, else "not enough history".
  if (!Array.isArray(watched) || watched.length < holdout + 20) {
    throw new Error('not enough history');
  }
  // watched arrives sorted watched_at DESC (watchedStore.getWatched); take the
  // first `holdout` rows that carry a tmdb_id (the dedupe key the pool is
  // keyed on). Fewer than holdout usable targets → same "not enough history".
  const targets = [];
  for (const row of watched) {
    if (row.tmdb_id && targets.length < holdout) targets.push(row.tmdb_id);
  }
  if (targets.length < holdout) throw new Error('not enough history');
  return targets;
};

// TV-1 (plan §6): the series holdout — the most recently STARTED shows that
// reached at least Engaged, using REAL (non-bulk) first-episode timestamps only
// (first_real_at). Bulk-imported shows carry their import time, so ordering them
// by time is meaningless. `seriesRows` is watchedStore.getSeriesProgress
// (kind='show'); returns tmdb_ids (the pool's dedupe key). Fewer than
// holdout + 10 qualifying shows → "not enough series history".
const pickSeriesTargets = (seriesRows, holdout) => {
  const { rungOf, DEFAULTS } = require('../seriesEngagement');
  const eligible = (row) => {
    if (row.kind !== 'show') return false;
    if (row.first_real_at == null) return false; // bulk-only → no real start
    if (row.tmdb_id == null) return false; // no dedupe key
    const rung = rungOf(row, DEFAULTS);
    return rung === 'engaged' || rung === 'committed' || rung === 'finished';
  };
  const qualifying = (seriesRows || []).filter(eligible);
  if (qualifying.length < holdout + 10) {
    throw new Error('not enough series history (' + qualifying.length + ' qualifying shows, need ' + (holdout + 10) + ')');
  }
  // Most recently started (first_real_at DESC), take holdout.
  return qualifying
    .sort((a, b) => (b.first_real_at - a.first_real_at))
    .slice(0, holdout)
    .map((r) => r.tmdb_id);
};

// Parse a pool row's score_components (stored as a JSON string by upsertCandidates,
// or a plain object when a test passes one) into an object, or null.
function parseComps(sc) {
  if (sc == null) return null;
  if (typeof sc === 'object') return sc;
  try { return JSON.parse(sc); } catch { return null; }
}

// Pure: compute the exact metrics (spec §5.5) for one engine's ranked pool rows
// against the holdout targets. `selectServe` is injected so the definition of
// "served" stays the SAME serve-time selection the addon uses (nothing here
// touches the network).
const metrics = (rows, targets, filters, { selectServe, stored, buildSeconds, reachable = null }) => {
  const targetSet = new Set(targets);
  const served20 = selectServe(rows, filters, { limit: 20 });
  const served20Ids = new Set(served20.map((r) => r.tmdb_id));
  let hit20 = 0;
  for (const t of targets) if (served20Ids.has(t)) hit20 += 1;

  const top100 = new Set(rows.slice(0, 100).map((r) => r.tmdb_id));
  let recall100 = 0;
  for (const t of targets) if (top100.has(t)) recall100 += 1;

  // Mean 1-based position in the RANKED pool of the hit targets (targets that
  // are in the pool at all). null when none of the targets are in the pool.
  const rankOf = new Map(rows.map((r, i) => [r.tmdb_id, i + 1]));
  let rankSum = 0; let rankN = 0;
  for (const t of targets) {
    const pos = rankOf.get(t);
    if (pos) { rankSum += pos; rankN += 1; }
  }
  const meanRank = rankN ? rankSum / rankN : null;

  const fullServed = selectServe(rows, filters, { limit: rows.length });
  const filterPass = rows.length ? fullServed.length / rows.length : 0;

  // trending@20: share of the top-20 served whose score_components.sources
  // includes 'trending'. null (n/a) when the engine emits no score_components
  // at all (Genesis today) — 0 would be a false "no trending" signal.
  let trending = null;
  let hasComps = false;
  if (served20.length) {
    let n = 0;
    for (const r of served20) {
      const comps = parseComps(r.score_components);
      if (comps) {
        hasComps = true;
        if (Array.isArray(comps.sources) && comps.sources.includes('trending')) n += 1;
      }
    }
    trending = hasComps ? n / served20.length : null;
  }

  // m2: hit@20 counted only against targets the profile's own filters allow —
  // a trailer, a 1992 film under a 10-year window or a cinema-only release can
  // never be served by ANY filter-respecting engine, so it only adds noise.
  let hitReach = null;
  let reachN = null;
  if (reachable) {
    reachN = targets.filter((t) => reachable.has(t)).length;
    hitReach = targets.filter((t) => reachable.has(t) && served20Ids.has(t)).length;
  }

  return {
    hitAt20: hit20,
    hitAt20Reachable: hitReach,
    reachableTargets: reachN,
    hitAt20Fraction: targets.length ? hit20 / targets.length : 0,
    recallAt100: targets.length ? recall100 / targets.length : 0,
    meanRankOfHits: meanRank,
    filterPass,
    trendingShareAt20: trending,
    stored: stored,
    buildSeconds: buildSeconds,
  };
};

// Convert a snake_case serve config (config.js DEFAULTS.serve or a bench
// --serve-opts JSON) to the camelCase opts calibratedOrder expects — the same
// conversion selectServeFor applies to the stored serve config.
const camelServeOpts = (o) => {
  if (!o || typeof o !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};

// §6: serve-strategy comparison for Marquee (round-robin vs calibrated vs pure
// score), on the SAME stored rows + SAME stored target. Pure / seam-injected so
// the integration suite can drive it hermetically. Each strategy serves 20; the
// metrics are the main table's hit@20 / hit@20r plus the calibrated-serving
// specifics — KL of the served mix vs the stored target (exclusions applied),
// top20Share (how many served films sit in the top-20 scores), rank stats, and
// the wildcard title (the discovery slot, when one is on).
//
// `serveOptsOverride` (bench --serve-opts) adds a 4th row, `calibrated*`: the
// same calibrated order but with the override merged over the stored serve
// config — so a window_factor change can be compared without editing settings.
// Bench-only: the live serve path never sees it.
function serveStrategyMetrics(rows, profile, filters, {
  selectServe, selectServeFor, filterServable, serveCalibration,
  targets, reachable = null, serveOptions = null, nowYear = new Date().getFullYear(),
  serveOptsOverride = null, listSizeFor = null,
}) {
  const rankOf = new Map(rows.map((r, i) => [r.tmdb_id, i + 1]));
  const top20Pool = new Set(rows.slice(0, 20).map((r) => r.tmdb_id));

  // The stored target (with the profile's excluded genres removed) — the
  // reference mix the calibrated strategy is measured against.
  const stored = serveCalibration.getTarget(profile.id, 'movie');
  const p = stored ? serveCalibration.applyExclusions(stored.target, (filters || {}).excluded_genres || []) : null;

  const strategies = {};
  const add = (name, served) => {
    const ids = served.map((r) => r.tmdb_id);
    const idSet = new Set(ids);
    let hit20 = 0;
    for (const t of targets) if (idSet.has(t)) hit20 += 1;
    let hitReach = null; let reachN = null;
    if (reachable) {
      reachN = targets.filter((t) => reachable.has(t)).length;
      hitReach = targets.filter((t) => reachable.has(t) && idSet.has(t)).length;
    }
    const kl = p ? serveCalibration.klDivergence(p, serveCalibration.genreMix(served), 0.01) : null;
    let top20Share = 0;
    for (const id of ids) if (top20Pool.has(id)) top20Share += 1;
    let rankSum = 0; let rankN = 0; let worst = null;
    for (const id of ids) {
      const pos = rankOf.get(id);
      if (pos) { rankSum += pos; rankN += 1; if (worst == null || pos > worst) worst = pos; }
    }
    strategies[name] = {
      hitAt20: hit20,
      hitAt20Reachable: hitReach,
      reachableTargets: reachN,
      kl,
      top20Share,
      meanRank: rankN ? rankSum / rankN : null,
      worstRank: worst,
      wildcard: null,
    };
  };

  // round-robin: the existing strict genre rotation.
  add('round_robin', selectServe(rows, filters, { limit: 20 }));

  // calibrated: the one serve entry point (uses the stored target).
  const cal = selectServeFor(profile, 'movie', rows, { limit: 20 });
  add('calibrated', cal);

  // pure score: the top 20 of the filter-passing pool by score (ties by tmdb_id).
  const passed = filterServable(rows, filters || {}, { nowYear })
    .slice()
    .sort((a, b) => {
      const sa = a.affinity || 0, sb = b.affinity || 0;
      if (sb !== sa) return sb - sa;
      return String(a.tmdb_id) < String(b.tmdb_id) ? -1 : 1;
    });
  add('pure_score', passed.slice(0, 20));

  // calibrated*: the same calibrated order with the --serve-opts override
  // merged over the stored serve config (camel-cased like selectServeFor).
  // Needs a stored target (p); bench-only — the live serve path ignores it.
  if (serveOptsOverride && p) {
    const n = listSizeFor ? listSizeFor(profile) : (() => {
      const m = parseInt(profile?.filters?.list_size, 10);
      return Number.isFinite(m) ? Math.min(50, Math.max(5, m)) : 20;
    })();
    const merged = { ...(serveOptions ? camelServeOpts(serveOptions) : {}), ...camelServeOpts(serveOptsOverride) };
    add('calibrated*', serveCalibration.calibratedOrder(passed, p, { listSize: n, ...merged }).slice(0, 20));
  }

  // wildcard: the film placed at the wildcard position (index 5) of the
  // calibrated list, when a discovery slot is on (wildcard_slots >= 1).
  if (serveOptions && (serveOptions.wildcard_slots || 0) >= 1) {
    const pos = (serveOptions.wildcard_position || 6) - 1;
    const w = cal[pos];
    if (w) strategies.calibrated.wildcard = w.title;
  }

  return strategies;
}

// §6: the second table under the main one — Marquee's serve strategies on the
// same pool. Pure string over the structured result.
function renderServeTable(results) {
  const pad = (s, n) => String(s).padEnd(n);
  const head = [
    pad('strategy', 12), pad('hit@20', 8), pad('hit@20r', 9), pad('KL', 8),
    pad('top20', 8), pad('meanRank', 10), pad('worstRank', 10), 'wildcard',
  ].join(' ');
  const lines = ['Marquee serve strategies (same pool):', head, '─'.repeat(head.length)];
  for (const [name, s] of Object.entries(results)) {
    lines.push([
      pad(name, 12),
      pad(String(s.hitAt20), 8),
      pad(s.hitAt20Reachable == null ? 'n/a' : `${s.hitAt20Reachable}/${s.reachableTargets}`, 9),
      pad(s.kl == null ? 'n/a' : s.kl.toFixed(3), 8),
      pad(String(s.top20Share), 8),
      pad(s.meanRank == null ? '—' : s.meanRank.toFixed(1), 10),
      pad(s.worstRank == null ? '—' : '#' + s.worstRank, 10),
      s.wildcard || '-',
    ].join(' '));
  }
  return lines.join('\n');
}

// Delete the holdout titles from the BENCH copy of the store so they cannot leak
// into the build (spec §5.3): watched, pending_watched, dont_recommend, the
// profile's whole recommended pool, and (if present) marquee_ratings — a held-out
// rating would otherwise steer Marquee's taste. `noCache` also clears the
// Marquee LLM cache (brief/fit/suggest) so a cached brief/fit can't carry the
// holdout forward. Pure SQL on the injected db handle.
function removeHoldout(profileId, targetIds, { db, noCache = false }) {
  const conn = db.get();
  const inList = targetIds.map(() => '?').join(',');
  conn.prepare('DELETE FROM watched WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  conn.prepare('DELETE FROM pending_watched WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  conn.prepare('DELETE FROM dont_recommend WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  conn.prepare('DELETE FROM recommended WHERE profile_id = ?').run(profileId);
  if (tableExists(conn, 'taste_ratings')) {
    conn.prepare("DELETE FROM taste_ratings WHERE profile_id = ? AND type = 'movie' AND tmdb_id IN (" + inList + ")").run(profileId, ...targetIds);
  }
  // Trainer T2 (§4.6): a held-out film the profile IGNORED would otherwise stay
  // in taste_ignore and steer Marquee's taste (N2) — clear it alongside the
  // ratings so the holdout cannot leak.
  if (tableExists(conn, 'taste_ignore')) {
    conn.prepare("DELETE FROM taste_ignore WHERE profile_id = ? AND type = 'movie' AND tmdb_id IN (" + inList + ")").run(profileId, ...targetIds);
  }
  // m2 engagement: a held-out film the profile FINISHED may still carry an old
  // mid-watch progress row. With the film removed from `watched`, that row would
  // read as "abandoned" and Marquee would exclude it — an unfair miss. Clear it.
  if (tableExists(conn, 'marquee_engagement')) {
    conn.prepare('DELETE FROM marquee_engagement WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  }
  if (noCache && tableExists(conn, 'marquee_llm_cache')) {
    conn.prepare("DELETE FROM marquee_llm_cache WHERE profile_id = ? AND kind IN ('brief','fit','suggest')").run(profileId);
  }
}

// TV-1 (plan §6): delete the SERIES holdout from the BENCH copy so it cannot
// leak into the build. The series history lives in series_progress (the
// ladder's input) — removing a held-out show's row means the build never sees
// its episodes. Alongside: the profile's whole series recommended pool, and
// the series taste ratings + ignores (a held-out show rating would otherwise
// steer Marquee TV's taste). `noCache` also clears the Marquee LLM cache.
//
// Card §2.4: the held-out shows must ALSO leave `watched` (type series),
// `pending_watched` and `dont_recommend` — the pipeline subtracts
// watchedIdSets (watched + pending_watched) and dont_recommend, so a
// surviving watched row would exclude every held-out target as "already
// watched" (the real-data bug: hit@20 0/10).
// Pure SQL on the injected db handle.
function removeSeriesHoldout(profileId, targetIds, { db, noCache = false }) {
  const conn = db.get();
  const inList = targetIds.map(() => '?').join(',');
  conn.prepare('DELETE FROM watched WHERE profile_id = ? AND type = ? AND tmdb_id IN (' + inList + ')').run(profileId, 'series', ...targetIds);
  conn.prepare('DELETE FROM pending_watched WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  conn.prepare('DELETE FROM dont_recommend WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  conn.prepare('DELETE FROM series_progress WHERE profile_id = ? AND tmdb_id IN (' + inList + ')').run(profileId, ...targetIds);
  conn.prepare('DELETE FROM recommended WHERE profile_id = ? AND type = ?').run(profileId, 'series');
  if (tableExists(conn, 'taste_ratings')) {
    conn.prepare("DELETE FROM taste_ratings WHERE profile_id = ? AND type = 'series' AND tmdb_id IN (" + inList + ")").run(profileId, ...targetIds);
  }
  if (tableExists(conn, 'taste_ignore')) {
    conn.prepare("DELETE FROM taste_ignore WHERE profile_id = ? AND type = 'series' AND tmdb_id IN (" + inList + ")").run(profileId, ...targetIds);
  }
  if (noCache && tableExists(conn, 'marquee_llm_cache')) {
    conn.prepare("DELETE FROM marquee_llm_cache WHERE profile_id = ? AND kind IN ('brief','fit','suggest')").run(profileId);
  }
}

function tableExists(conn, name) {
  const row = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return !!row;
}

// Snapshot the live store into a throwaway copy (spec §5.2). Copies everything
// EXCEPT the DB files (re-snapshotted below via VACUUM INTO) and the bench/
// report dir. VACUUM INTO from a READ-ONLY open of the live DB guarantees the
// live store.db is never written (a plain fs.copyFileSync of store.db can miss
// the WAL — uncommitted frames live in store.db-wal). Returns
// { benchDir, readOnlyPath } — readOnlyPath records which open the running
// Node's node:sqlite took ('readOnly' or 'default') so the report can say which
// path was exercised.
function snapshotStore(liveDir) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-bench-'));
  const SKIP = new Set(['store.db', 'store.db-wal', 'store.db-shm', 'bench']);
  fs.cpSync(liveDir, benchDir, {
    recursive: true,
    filter: (src) => !SKIP.has(path.basename(src)),
  });
  const liveDbPath = path.join(liveDir, 'store.db');
  if (!fs.existsSync(liveDbPath)) {
    throw new Error('live store.db not found at ' + liveDbPath + ' — is DATA_DIR set correctly?');
  }
  const { DatabaseSync } = require('node:sqlite');
  const benchDbPath = path.join(benchDir, 'store.db');
  const intoPath = benchDbPath.replace(/\\/g, '/'); // SQLite prefers forward slashes
  let liveDb;
  let readOnlyPath = 'readOnly';
  try {
    liveDb = new DatabaseSync(liveDbPath, { readOnly: true });
  } catch {
    liveDb = new DatabaseSync(liveDbPath);
    readOnlyPath = 'default';
  }
  try {
    liveDb.exec(`VACUUM INTO '${intoPath}'`);
  } finally {
    try { liveDb.close(); } catch { /* already closed */ }
  }
  return { benchDir, readOnlyPath };
}

// m4 (spec §17): merge a --marquee-config JSON into the SNAPSHOT's
// settings.json, section-wise: settings.marquee[section] =
// { ...existing[section], ...override[section] }. Lets the reviewer A/B the
// genre-fair agreement (β=0 vs β=0.5) on a real profile without touching the
// live settings. Refuses to write anywhere outside the temp snapshot dir —
// the live settings file must never be written by the bench.
function applyMarqueeConfig(benchDir, override) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('--marquee-config must be a JSON object');
  }
  const root = path.resolve(benchDir);
  if (!root.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error('refusing to write settings outside the temp snapshot dir: ' + root);
  }
  const settingsPath = path.join(root, 'settings.json');
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  const marquee = settings.marquee && typeof settings.marquee === 'object' ? settings.marquee : {};
  for (const section of Object.keys(override)) {
    const base = marquee[section] && typeof marquee[section] === 'object' ? marquee[section] : {};
    marquee[section] = { ...base, ...override[section] };
  }
  settings.marquee = marquee;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return marquee;
}

// m2: can a held-out film be recommended AT ALL under this profile's filters?
// Runs Marquee's hard filter (the serve rules + vote floor + home availability
// + kids cert) on the film's own metadata. Seams: `metaFor(tmdbId)` → the
// normalized deep meta or null; `imdbRatingFor(imdbId)` → number|null;
// `isAnime(imdbId, tmdbId)` → bool. Returns Map<tmdbId, { reachable, reason }>.
// A film whose metadata can't be read is reported as reachable (unknown) so it
// never silently shrinks the denominator.
async function assessReachability(targetIds, filters, { metaFor, imdbRatingFor = async () => null, isAnime = () => false, nowYear = new Date().getFullYear(), compileEnvelope }) {
  const env = compileEnvelope(filters || {}, { nowYear, genreMap: {} });
  const out = new Map();
  for (const id of targetIds) {
    let meta = null;
    try { meta = await metaFor(id); } catch { meta = null; }
    if (!meta) { out.set(id, { reachable: true, reason: 'no metadata (assumed reachable)' }); continue; }
    let genres = (meta.genres || []).slice();
    if (isAnime(meta.imdb_id, id) && !genres.includes('Anime')) genres = ['Anime', ...genres];
    let imdbRating = null;
    try { imdbRating = meta.imdb_id ? await imdbRatingFor(meta.imdb_id) : null; } catch { imdbRating = null; }
    const v = env.hardFilter({
      imdb_id: meta.imdb_id, imdb_rating: imdbRating, vote_average: meta.vote_average, vote_count: meta.vote_count,
      year: meta.year, genres, availability: meta.availability, certAU: meta.certAU, certUS: meta.certUS,
    });
    out.set(id, v.ok ? { reachable: true, reason: null } : { reachable: false, reason: v.reason });
  }
  return out;
}

// Orchestrator (spec §5.4/§5.5): for each requested engine, clear the movie
// slice, run the shared pipeline build (age gate deliberately NOT run — the bench
// measures RANKING quality, not age safety), time the build, and compute the
// exact metrics against the holdout. Returns the structured result object that
// renderTable / the --json writer consume.
async function runBench({ profile, engineIds, holdout, type = 'movie', serveOptsOverride = null, deps }) {
  const {
    engines, pipeline, rs, watchedStore, db, settings, selectServe,
    selectServeFor, filterServable, serveCalibration, listSizeFor = null,
    log = console, now = Date.now, noCache = false, ctxExtras = {}, reachability = null,
  } = deps;
  // The holdout deletors are injectable so the suite can spy on them (e.g. to
  // prove the leakage check throws when a delete is skipped).
  const removeSeriesHoldoutFn = deps.removeSeriesHoldout || removeSeriesHoldout;
  const removeHoldoutFn = deps.removeHoldout || removeHoldout;

  let targetIds, targets;
  if (type === 'series') {
    // TV-1 (plan §6): the series holdout is the most recently STARTED shows that
    // reached at least Engaged (real first-episode timestamps only). Build from
    // history minus those shows.
    const seriesRows = watchedStore.getSeriesProgress(profile.id, { kind: 'show' });
    targetIds = pickSeriesTargets(seriesRows, holdout);
    targets = targetIds.map((id) => {
      const row = seriesRows.find((r) => r.tmdb_id === id);
      return { tmdb_id: id, title: row ? row.title : id };
    });
    removeSeriesHoldoutFn(profile.id, targetIds, { db, noCache });
    // Leakage check (card §2.4): no target may survive in the series progress
    // rows OR in the watched id sets (watched + pending_watched) — the pipeline
    // subtracts watchedIdSets, so a surviving watched row would exclude the target.
    const remainingIds = new Set(watchedStore.getSeriesProgress(profile.id, { kind: 'show' }).map((r) => r.tmdb_id));
    for (const t of targetIds) {
      if (remainingIds.has(t)) throw new Error('leakage: target still in series_progress: ' + t);
    }
    const sets = watchedStore.watchedIdSets(profile.id);
    for (const t of targetIds) {
      if (sets.tmdb.has(t)) throw new Error('leakage: target still in watched set: ' + t);
    }
  } else {
    const watched = watchedStore.getWatched(profile.id, { type: 'movie' });
    targetIds = pickTargets(watched, holdout);
    targets = targetIds.map((id) => {
      const row = watched.find((r) => r.tmdb_id === id);
      return { tmdb_id: id, title: row ? row.title : id };
    });
    // Delete the holdout from the bench copy so it cannot leak into the build.
    removeHoldoutFn(profile.id, targetIds, { db, noCache });
    // Leakage check (spec §5.3): no target may survive in the watched id sets.
    const sets = watchedStore.watchedIdSets(profile.id);
    for (const t of targetIds) {
      if (sets.tmdb.has(t)) throw new Error('leakage: target still in watched set: ' + t);
    }
  }

  // m2: which targets could be served at all (null when no seam is given).
  // Card §2.4: the reachability section is movie-only — not run for series.
  let reach = null;
  if (type === 'movie' && typeof reachability === 'function') {
    try { reach = await reachability(targetIds, profile.filters || {}); } catch (err) { log.warn(`[bench] reachability failed: ${err.message}`); }
  }
  if (reach) for (const t of targets) { const r = reach.get(t.tmdb_id); if (r) { t.reachable = r.reachable; t.unreachableReason = r.reason; } }
  const reachableSet = reach ? new Set([...reach].filter(([, r]) => r.reachable).map(([id]) => id)) : null;

  const results = { profile: profile.name, holdout, targets, engines: {}, type };
  let marqueeRows = null;   // §6: the Marquee stored rows for the serve-strategy comparison
  let marqueeEngine = null;
  for (const id of engineIds) {
    const engine = engines.get(id);
    if (!engine) {
      log.warn(`[bench] engine '${id}' not found — skipping`);
      continue;
    }
    const req = engine.requirements(profile);
    if (!req.ok) {
      log.warn(`[bench] engine '${id}' requirements not met (${req.missing.join(', ')}) — skipping`);
      continue;
    }

    rs.clearType(profile.id, type);
    const ctx = {
      tmdbKey: settings.keyFor(profile, 'tmdb_api_key'),
      mdblistKey: settings.keyFor(profile, 'mdblist_api_key'),
      settings: settings.getSettings(),
      filters: profile.filters || {},
      log,
      marqueeSkipSync: true, // ME-10: never pull live Simkl ratings in the bench
      // m2: Marquee records where every title is lost; other engines ignore it.
      marqueeTrace: { generated: new Map(), dropped: new Map() },
      ...ctxExtras,
    };
    const t0 = now();
    await pipeline.runEngineBuild(profile, type, engine, ctx, () => {});
    const buildSeconds = (now() - t0) / 1000;

    const rows = rs.getRecommended(profile.id, { type, limit: 100000 });
    if (id === 'marquee') { marqueeRows = rows; marqueeEngine = engine; }
    const m = metrics(rows, targetIds, profile.filters || {}, { selectServe, stored: rows.length, buildSeconds, reachable: reachableSet });
    // Which targets did this engine actually hit in the top-20 served?
    const served20 = selectServe(rows, profile.filters || {}, { limit: 20 });
    const served20Ids = new Set(served20.map((r) => r.tmdb_id));
    const hitTargets = targetIds.filter((t) => served20Ids.has(t));
    // m2: per-target position in this engine's pool (1-based, affinity order)
    // and, for Marquee, the stage that lost it when it never reached the pool.
    const rankOf = new Map(rows.map((r, i) => [r.tmdb_id, i + 1]));
    const positions = {};
    for (const t of targetIds) {
      const rank = rankOf.get(t) || null;
      let fate = null;
      if (!rank && ctx.marqueeTrace && ctx.marqueeTrace.generated.size) {
        if (ctx.marqueeTrace.dropped.has(t)) fate = ctx.marqueeTrace.dropped.get(t);
        else if (!ctx.marqueeTrace.generated.has(t)) fate = 'not generated';
        else fate = 'dropped after scoring';
      }
      positions[t] = { rank, served: served20Ids.has(t), fate, sources: ctx.marqueeTrace?.generated.get(t) || null };
    }
    results.engines[id] = { metrics: m, hitTargets, positions };
  }

  // §6: Marquee serve-strategy comparison (round-robin vs calibrated vs pure
  // score) on the SAME stored rows + SAME stored target. Marquee only, movie
  // only (the calibrated serving target is a movie concept), and only when the
  // serve-strategy deps are injected (the bench script provides them; hermetic
  // callers that don't need the comparison pass only `selectServe`).
  if (type === 'movie' && marqueeRows && marqueeEngine && serveCalibration && selectServeFor && filterServable) {
    const serveOptions = marqueeEngine.serveOptions ? marqueeEngine.serveOptions(settings.getSettings()) : null;
    results.engines.marquee.serveStrategies = serveStrategyMetrics(marqueeRows, profile, profile.filters || {}, {
      selectServe, selectServeFor, filterServable, serveCalibration,
      targets: targetIds, reachable: reachableSet, serveOptions,
      serveOptsOverride, listSizeFor,
    });
    if (serveOptsOverride) results.engines.marquee.serveOptsOverride = serveOptsOverride;
  }
  return results;
}

// Fixed-width table (spec §5.5): one row per engine + the target titles and
// which engines hit each (top-20). Pure string over the structured result.
function renderTable(results) {
  const pad = (s, n) => String(s).padEnd(n);
  const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
  // Card §2.4: the reachability + serve-strategy sections are movie-only — not
  // run, and not printed, for series.
  const isSeries = results.type === 'series';
  const headCells = [pad('engine', 10), pad('hit@20', 8)];
  if (!isSeries) headCells.push(pad('hit@20r', 9));
  headCells.push(pad('recall@100', 12), pad('meanRank', 10), pad('filterPass', 12), pad('trending@20', 13), pad('stored', 8), 'build(s)');
  const head = headCells.join(' ');
  const lines = [
    `Profile: ${results.profile}   holdout: ${results.holdout}`,
    head,
    '─'.repeat(head.length),
  ];
  for (const [id, e] of Object.entries(results.engines)) {
    const m = e.metrics;
    const cells = [pad(id, 10), pad(`${m.hitAt20}/${results.holdout}`, 8)];
    if (!isSeries) cells.push(pad(m.hitAt20Reachable == null ? 'n/a' : `${m.hitAt20Reachable}/${m.reachableTargets}`, 9));
    cells.push(
      pad(pct(m.recallAt100), 12),
      pad(m.meanRankOfHits == null ? '—' : m.meanRankOfHits.toFixed(1), 10),
      pad(pct(m.filterPass), 12),
      pad(pct(m.trendingShareAt20), 13),
      pad(String(m.stored), 8),
      m.buildSeconds.toFixed(1),
    );
    lines.push(cells.join(' '));
  }
  lines.push('');
  lines.push('Targets (which engines hit each, top-20):');
  for (const t of results.targets) {
    const hitters = Object.entries(results.engines)
      .filter(([, e]) => e.hitTargets.includes(t.tmdb_id))
      .map(([id]) => id);
    const reach = !isSeries && t.reachable === false ? `  [unreachable: ${t.unreachableReason}]` : '';
    lines.push(`  ${t.title} (${t.tmdb_id}) — ${hitters.length ? hitters.join(', ') : 'none'}${reach}`);
    // m2: where each engine placed it — "#7 served", "#57", or why it was lost.
    const per = Object.entries(results.engines).map(([id, e]) => {
      const p = e.positions && e.positions[t.tmdb_id];
      if (!p) return null;
      if (p.rank) return `${id} #${p.rank}${p.served ? ' served' : ''}`;
      return `${id} ${p.fate || 'not in pool'}`;
    }).filter(Boolean);
    if (per.length) lines.push(`      ${per.join(' · ')}`);
  }
  lines.push('');
  if (!isSeries) lines.push("hit@20r = hits among the targets this profile's filters allow at all (n/a when not assessed).");
  return lines.join('\n');
}

module.exports = { pickTargets, pickSeriesTargets, metrics, renderTable, runBench, removeHoldout, removeSeriesHoldout, snapshotStore, applyMarqueeConfig, parseComps, assessReachability, serveStrategyMetrics, renderServeTable };
