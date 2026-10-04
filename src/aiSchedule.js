// AI catalog cadence (feature/ai-catalog-cadence) — the ONE owner of Sydney
// calendar math, local watch-history fingerprinting, and the durable per-profile
// schedule state.
//
// What it does:
//   • A pure `dueAt` decides, for a given instant and durable state, whether a
//     heavy AI pool build is due — and whether it is a *daily* (watch-changed)
//     or *weekly* (forced Sunday) build. The decision is Sydney-calendar-based
//     (built-in Intl), so a UTC container and both DST transitions produce the
//     same answer.
//   • A stable SHA-256 `historyHash` fingerprints the local watch history
//     (watched ids + timestamps, pending-watched identity, series episode
//     progress). It excludes volatile fields (updated_at, sync-at,
//     title/poster/enrichment) so a byte-identical re-sync is unchanged, while
//     a backdated import, an unwatch, a pending watch, or a new episode changes
//     it.
//   • `consider` (called by the hourly tick AFTER a successful watched ingest)
//     runs the local due test and enqueues at most one heavy `recs` job per
//     profile through the existing global queue. It never calls an external API.
//   • `recordSuccess` / `recordFailure` persist the completion markers only
//     AFTER the staged build + age gate + promotion succeed (or set a bounded
//     backoff on failure). They never set the success fields when merely
//     enqueuing a job.
//
// This module reads the existing SQLite connection and local tables only; it
// makes no external API call. It reuses `jobs.enqueue` for heavy work and does
// not alter `jobs.js`.
const crypto = require('crypto');
const db = require('./db');

let ready = false;

function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS ai_schedule (
      profile_id          TEXT PRIMARY KEY,
      built_history_hash  TEXT,
      evaluated_day       TEXT,
      completed_week      TEXT,
      last_success_at     INTEGER,
      retry_after         INTEGER
    );
  `);
  ready = true;
}

// ---- Sydney calendar math (pure; built-in Intl only) ----

// Howard Hinnant's days-from-civil: days since 1970-01-01 (a Thursday) for a
// Gregorian civil date. Used for DST-independent weekday computation.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;                       // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

// Weekday of a civil date: 0 = Sunday … 6 = Saturday.
function weekdayOf(y, m, d) {
  return (daysFromCivil(y, m, d) + 4) % 7;
}

// The Sydney calendar date + time-of-day for an epoch-ms instant, via built-in
// Intl (independent of the container's TZ).
function sydneyParts(nowMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: parseInt(get('year'), 10),
    m: parseInt(get('month'), 10),
    d: parseInt(get('day'), 10),
    h: parseInt(get('hour'), 10),
    min: parseInt(get('minute'), 10),
  };
}

const fmtDate = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// The Sydney calendar date ('YYYY-MM-DD') of an instant.
function sydneyDay(nowMs) {
  const p = sydneyParts(nowMs);
  return fmtDate({ y: p.y, m: p.m, d: p.d });
}

// Subtract n days from a civil date (DST-independent). We compute a UTC
// midnight instant for the given date, subtract n days, and read the Sydney
// date of the result (the Sydney date of a UTC instant is well-defined).
function dateMinusDays(y, m, d, n) {
  const utcMidnight = Date.UTC(y, m - 1, d);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: 'numeric', day: 'numeric',
  });
  const parts = dtf.formatToParts(new Date(utcMidnight - n * 86400e3));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: parseInt(get('year'), 10),
    m: parseInt(get('month'), 10),
    d: parseInt(get('day'), 10),
  };
}

// The most recent Sunday (Sydney) whose 03:00 window has already passed at
// nowMs. On a Sunday at/after 03:00 that is today; otherwise the previous
// Sunday (a Sunday before 03:00 is not yet due for its own week).
function sydneySundayAnchor(nowMs) {
  const p = sydneyParts(nowMs);
  const today = { y: p.y, m: p.m, d: p.d };
  const weekday = weekdayOf(p.y, p.m, p.d);
  const hm = p.h * 60 + p.min;
  if (weekday === 0 && hm >= 180) return fmtDate(today); // Sunday, window open
  const back = weekday === 0 ? 7 : weekday; // Sunday before 03:00 → previous Sunday
  return fmtDate(dateMinusDays(p.y, p.m, p.d, back));
}

// ---- durable schedule state ----

function getScheduleState(profileId) {
  init();
  const row = db.get().prepare('SELECT * FROM ai_schedule WHERE profile_id = ?').get(profileId);
  return row || {
    profile_id: profileId,
    built_history_hash: null,
    evaluated_day: null,
    completed_week: null,
    last_success_at: null,
    retry_after: null,
  };
}

// ---- local watch-history fingerprint ----

// A stable SHA-256 fingerprint of the canonical, sorted local watch history for
// one profile. Includes the meaningful watched movie/show identifiers + watch
// timestamps, pending-watched identity, and series episode progress
// (watched_eps, real-stamp bounds, real-stamp count, status). Excludes volatile
// fields (updated_at, sync-at, title/poster/enrichment) so a byte-identical
// re-sync is unchanged, while a backdated import, an unwatch, a pending watch,
// or a newly watched episode changes it. Never logs the input or ids.
function historyHash(profileId) {
  init();
  const conn = db.get();
  const watched = conn.prepare(
    'SELECT type, imdb_id, tmdb_id, watched_at FROM watched WHERE profile_id = ?',
  ).all(profileId);
  const pending = conn.prepare(
    'SELECT type, id, imdb_id, tmdb_id FROM pending_watched WHERE profile_id = ?',
  ).all(profileId);
  const series = conn.prepare(
    'SELECT kind, imdb_id, tmdb_id, watched_eps, first_real_at, last_real_at, real_stamps, status FROM series_progress WHERE profile_id = ?',
  ).all(profileId);
  const canonical = JSON.stringify({
    watched: watched.map((r) => [r.type, r.imdb_id || r.tmdb_id, r.watched_at]).sort(),
    pending: pending.map((r) => [r.type, r.id || r.imdb_id || r.tmdb_id]).sort(),
    series: series.map((r) => [r.kind, r.imdb_id || r.tmdb_id, r.watched_eps, r.first_real_at, r.last_real_at, r.real_stamps, r.status]).sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---- the pure due decision ----

// PURE: given an instant and the durable state, decide whether a heavy AI pool
// build is due, and whether it is daily (watch-changed) or weekly (forced
// Sunday). Shape is documented so tests can rely on it:
//   { due: false, reason: 'cold-start' }        empty pool (immediate cold start)
//   { due: false, reason: 'backoff' }           inside a failed-build backoff
//   { due: false, reason: 'before-window' }     before today's 03:00 window
//   { due: false, reason: 'unchanged', markEvaluated: true, anchor }  skip + mark
//   { due: false, reason: 'not-due' }           window already consumed
//   { due: true, kind: 'weekly'|'daily', anchor }
function dueAt({ nowMs, evaluatedDay, completedWeek, builtHash, currentHash, retryAfter, hasPool }) {
  // 1. Empty AI pool: the cold-start path is immediate, outside this window.
  if (!hasPool) return { due: false, reason: 'cold-start' };

  const p = sydneyParts(nowMs);
  const today = fmtDate({ y: p.y, m: p.m, d: p.d });
  const weekday = weekdayOf(p.y, p.m, p.d);
  const windowOpen = (p.h * 60 + p.min) >= 180; // 03:00 Sydney

  // A failed scheduled build backs off 30 min; the window is NOT consumed, so
  // once the backoff passes we re-evaluate (the due reason persists across restart).
  if (retryAfter && nowMs < retryAfter) return { due: false, reason: 'backoff' };

  // 2. Weekly (forced Sunday): the most recent Sunday whose 03:00 window has
  //    passed and is not yet completed. Takes precedence over the daily window.
  const sunday = sydneySundayAnchor(nowMs);
  if (sunday && (!completedWeek || completedWeek < sunday)) {
    return { due: true, kind: 'weekly', anchor: sunday };
  }

  // 3. Daily window: today's 03:00 window not yet evaluated.
  if (evaluatedDay !== today) {
    if (!windowOpen) return { due: false, reason: 'before-window' };
    if (currentHash === builtHash) {
      return { due: false, reason: 'unchanged', markEvaluated: true, anchor: today };
    }
    return { due: true, kind: 'daily', anchor: today };
  }

  // 4. Skip: the window is already consumed.
  return { due: false, reason: 'not-due' };
}

// ---- persistence of the completion markers ----

// Persist the success markers ONLY after a staged build + age gate + promotion
// has fully succeeded. `kind` is 'daily' | 'weekly'; `anchor` is the Sydney
// date of the window (today for daily, the Sunday for weekly). A weekly success
// also consumes that day's daily window (evaluated_day = anchor) and records the
// completed week. `built_history_hash` is the snapshot taken at build start.
function recordSuccess(profileId, kind, anchor, startHash, counts) {
  init();
  const conn = db.get();
  conn.prepare('BEGIN').run();
  try {
    conn.prepare(`
      INSERT INTO ai_schedule (profile_id, built_history_hash, evaluated_day, completed_week, last_success_at, retry_after)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(profile_id) DO UPDATE SET
        built_history_hash = excluded.built_history_hash,
        evaluated_day = excluded.evaluated_day,
        completed_week = COALESCE(excluded.completed_week, ai_schedule.completed_week),
        last_success_at = excluded.last_success_at,
        retry_after = NULL
    `).run(profileId, startHash, anchor, kind === 'weekly' ? anchor : null, Date.now());
    conn.prepare('COMMIT').run();
  } catch (err) { conn.prepare('ROLLBACK').run(); throw err; }
}

// Persist a bounded backoff after a failed scheduled build. Does NOT set
// evaluated_day, completed_week, or built_history_hash — the window stays due
// and the due reason persists across restart.
function recordFailure(profileId, kind, anchor, reason) {
  init();
  const retryAfter = Date.now() + 30 * 60e3; // 30-minute backoff
  db.get().prepare(`
    INSERT INTO ai_schedule (profile_id, retry_after)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET retry_after = excluded.retry_after
  `).run(profileId, retryAfter);
  return retryAfter;
}

// Mark today's daily window evaluated (an unchanged-history skip). Does not
// touch built_history_hash, completed_week, or retry_after.
function markEvaluated(profileId, day) {
  init();
  db.get().prepare(`
    INSERT INTO ai_schedule (profile_id, evaluated_day)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET evaluated_day = excluded.evaluated_day
  `).run(profileId, day);
}

// ---- first-deployment initialization ----

// On first deployment (no ai_schedule row), initialize the markers from the
// existing pool state WITHOUT blindly queuing a forced migration build:
//   • empty pool → leave the row absent (the immediate cold-start path owns it).
//   • nonempty pool → set built_history_hash from local history and
//     completed_week to the current weekly anchor. If the existing
//     newestWatchedMs > built_at already proves a watch is due, keep it due for
//     the next daily window (leave evaluated_day null); otherwise mark today's
//     window evaluated (no heavy work needed).
function initFromExisting(profileId, nowMs) {
  init();
  const rs = require('./recommendationStore');
  const watchedStore = require('./watchedStore');
  const state = getScheduleState(profileId);
  if (state.built_history_hash) return; // already initialized
  const hasPool = rs.countRecommended(profileId) > 0;
  if (!hasPool) return; // empty pool → cold-start path
  const currentHash = historyHash(profileId);
  const sunday = sydneySundayAnchor(nowMs);
  const watchDue = watchedStore.newestWatchedMs(profileId) > rs.getBuiltAt(profileId);
  db.get().prepare(`
    INSERT INTO ai_schedule (profile_id, built_history_hash, completed_week)
    VALUES (?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      built_history_hash = excluded.built_history_hash,
      completed_week = COALESCE(excluded.completed_week, ai_schedule.completed_week)
  `).run(profileId, currentHash, sunday);
  if (!watchDue) markEvaluated(profileId, sydneyDay(nowMs));
}

// ---- the scheduler entry point (called by the tick after watched ingest) ----

// In-memory single-flight for a profile's sync/schedule check.
const considering = new Set();

// Run the local due test for a profile and enqueue at most one heavy `recs`
// job (daily or weekly) through the existing global queue. Never calls an
// external API. A queued/running job or a backoff does not consume the window.
async function consider(profile, nowMs) {
  init();
  const profileId = profile.id;
  if (considering.has(profileId)) return { skipped: 'in-flight' };
  considering.add(profileId);
  try {
    // First deployment: initialize the markers from the existing pool state.
    const state = getScheduleState(profileId);
    if (!state.built_history_hash) initFromExisting(profileId, nowMs);
    const st = getScheduleState(profileId);
    const currentHash = historyHash(profileId);
    const hasPool = require('./recommendationStore').countRecommended(profileId) > 0;
    const decision = dueAt({
      nowMs,
      evaluatedDay: st.evaluated_day,
      completedWeek: st.completed_week,
      builtHash: st.built_history_hash,
      currentHash,
      retryAfter: st.retry_after,
      hasPool,
    });
    if (!decision.due) {
      if (decision.reason === 'unchanged' && decision.markEvaluated) {
        markEvaluated(profileId, decision.anchor);
        console.log(`[ai-schedule] ${profile.name}: daily ${decision.anchor} skipped — history unchanged`);
      }
      // Cold-start: a new or empty AI pool builds immediately (prompt), outside
      // the daily/weekly window. This restores the boot/request cold-start flow
      // that was replaced by consider in server.js and addon.js.
      if (decision.reason === 'cold-start') {
        const jobs = require('./jobs');
        if (jobs.isBusy(profileId)) return { skipped: 'busy' };
        console.log(`[ai-schedule] ${profile.name}: cold-start queued`);
        const rs = require('./recommendationStore');
        jobs.enqueue(profileId, 'recs', (progress) => rs.buildPool(profile, console, progress))
          .catch((err) => console.warn(`[ai-schedule] ${profile.name}: cold-start job rejected — ${err.message}`));
        return { queued: 'cold-start' };
      }
      return { skipped: decision.reason };
    }
    const kind = decision.kind;
    const anchor = decision.anchor;
    const jobs = require('./jobs');
    if (jobs.isBusy(profileId)) return { skipped: 'busy' };
    const startHash = currentHash;
    console.log(`[ai-schedule] ${profile.name}: ${kind} ${anchor} queued — ${kind === 'weekly' ? 'forced' : 'history changed'}`);
    // Fire-and-forget through the global queue (the job serializes + reports
    // progress); the tick does not wait for the heavy build. The promise is
    // consumed (logged) so an unhandled rejection never exits the process.
    // The queue's error state and the durable 30-minute retry marker (set by
    // recordFailure inside runScheduledBuild) are preserved — this catch only
    // prevents the rejection from propagating as an unhandled promise.
    jobs.enqueue(profileId, 'recs', (progress) => runScheduledBuild(profile, kind, anchor, startHash, progress))
      .catch((err) => console.warn(`[ai-schedule] ${profile.name}: ${kind} ${anchor} job rejected — ${err.message}`));
    return { queued: kind, anchor };
  } finally {
    considering.delete(profileId);
  }
}

// The heavy build a scheduled job runs: the staged generation + age gate +
// atomic promotion (Stage 2), then the completion markers. `kind` is 'daily' |
// 'weekly'; `anchor` is the Sydney date of the window; `startHash` is the
// history snapshot at build start.
//
// A skipped build (missing TMDB key, failed acceptance gate, sparse output)
// is a retryable failure: it does NOT advance built_history_hash,
// evaluated_day, or completed_week. The 30-minute backoff applies so the
// next eligible tick can retry. Only a successful promotion records success.
async function runScheduledBuild(profile, kind, anchor, startHash, progress) {
  const rs = require('./recommendationStore');
  let result;
  try {
    result = await rs.buildPool(profile, console, progress, { kind, anchor, startHash });
  } catch (err) {
    // A thrown build error (engine failure, network, etc.): persist exactly
    // one retry marker and rethrow so the queue records state:'error'.
    const retryAfter = recordFailure(profile.id, kind, anchor, err.message);
    console.warn(`[ai-schedule] ${profile.name}: ${kind} ${anchor} failed — retry after ${new Date(retryAfter).toISOString()}: ${err.message}`);
    throw err;
  }
  if (result.skipped) {
    // A skipped result (missing TMDB key, failed acceptance gate, sparse
    // output): persist exactly one retry marker and throw so the queue
    // records state:'error'. The .catch() in consider consumes the rejection
    // to prevent process exit.
    const retryAfter = recordFailure(profile.id, kind, anchor, result.reason || 'skipped');
    const err = new Error(`${kind} ${anchor} skipped — ${result.reason || 'unknown'}`);
    console.warn(`[ai-schedule] ${profile.name}: ${err.message}; retry after ${new Date(retryAfter).toISOString()}`);
    throw err;
  }
  // Success: persist the completion markers.
  const counts = {
    movies: result.movie?.stored || 0,
    shows: result.series?.stored || 0,
    pool: result.total || 0,
  };
  recordSuccess(profile.id, kind, anchor, startHash, counts);
  console.log(`[ai-schedule] ${profile.name}: ${kind} ${anchor} completed — movies ${counts.movies}, shows ${counts.shows}, pool ${counts.pool}`);
  return result;
}

// Test/maintenance helper: clear all schedule rows + the single-flight set.
function _reset() {
  init();
  db.get().prepare('DELETE FROM ai_schedule').run();
  considering.clear();
}

module.exports = {
  init,
  dueAt,
  historyHash,
  sydneyDay,
  sydneyParts,
  sydneySundayAnchor,
  weekdayOf,
  daysFromCivil,
  getScheduleState,
  recordSuccess,
  recordFailure,
  markEvaluated,
  initFromExisting,
  consider,
  runScheduledBuild,
  _reset,
};
