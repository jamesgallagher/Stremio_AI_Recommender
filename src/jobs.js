// Global rebuild queue + progress (v6). Two jobs must never run at once — a
// heavy pool scan plus a full scrobble re-push would double the API load and
// race each other — so every rebuild-style action routes through here and runs
// ONE AT A TIME, in FIFO order. Each job reports progress (0–100 + a label) so
// the portal can show "rebuilding X%" for the long, otherwise-invisible scan.
//
// Dedup: a second request for the SAME (profile, kind) while one is queued or
// running joins the in-flight job instead of stacking a duplicate — opening two
// tabs and hitting Build twice does not queue two scans. Different kinds (a
// pool build vs a scrobble re-push) DO queue separately and run in turn.
//
// afterActive (ENG-1): a SETTINGS/ENGINE change must always take effect, even
// while a build for the same (profile, kind) is running. With afterActive the
// change does NOT join the in-flight job — it queues a NEW build that runs
// AFTER it (the running build holds the profile captured when it started, so
// joining it would silently drop the change). For an already-queued duplicate it
// replaces the queued job's run with the newer one (still one job, never a
// third). Routine builds (ensureBuilt, the addon's background build, the
// scheduled tick) omit the option and keep the join behaviour.

const queue = [];          // [{ profileId, kind, run, resolve, reject }]
let active = null;         // the running job, or null
const state = new Map();   // profileId -> progress snapshot

function snapshot(profileId) {
  return state.get(profileId) || null;
}

function setProgress(profileId, patch) {
  const cur = state.get(profileId) || {};
  state.set(profileId, { ...cur, ...patch, updated_at: Date.now() });
}

// Is a job for this profile queued or running?
function isBusy(profileId) {
  const s = state.get(profileId);
  return !!s && (s.state === 'queued' || s.state === 'running');
}

function queuePosition(profileId) {
  const i = queue.findIndex((j) => j.profileId === profileId);
  return i < 0 ? 0 : i + 1; // 1-based; 0 = not waiting (running or absent)
}

// Safe active/preceding job metadata: the currently running job's profile ID
// and kind (for the portal to resolve a profile name and display as the
// named blocker). Never exposes another profile's secrets or fingerprints.
function activeJobInfo() {
  if (!active) return null;
  return { profileId: active.profileId, kind: active.kind };
}

// The queue's first (next-to-run) job, for naming the blocker when a job
// is waiting. Returns null if the queue is empty.
function nextJobInfo() {
  if (!queue.length) return null;
  const j = queue[0];
  return { profileId: j.profileId, kind: j.kind };
}

// Enqueue a job. `run(progress)` does the work; call progress(pct, label) to
// report. Returns a promise that settles when the job finishes. A duplicate
// (same profile+kind, already queued/running) returns the in-flight promise.
// With `afterActive` a settings/engine change never joins the in-flight job —
// it queues a NEW build behind it (see the file-top dedup note).
function enqueue(profileId, kind, run, { afterActive = false } = {}) {
  const existing = queue.find((j) => j.profileId === profileId && j.kind === kind);
  if (existing) {
    if (afterActive) existing.run = run;
    return existing.promise;
  }
  const runningSame = !!active && active.profileId === profileId && active.kind === kind;
  if (runningSame && !afterActive) return active.promise;

  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const job = { profileId, kind, run, resolve, reject, promise };
  queue.push(job);
  if (!runningSame) setProgress(profileId, { kind, state: 'queued', pct: 0, label: 'Queued…', queued_at: Date.now(), error: null });
  pump();
  return promise;
}

async function pump() {
  if (active || !queue.length) return;
  const job = queue.shift();
  active = job;
  // Reset stale deferred/circuit/result flags from a previous job so a new
  // job starts with a clean state.
  setProgress(job.profileId, { kind: job.kind, state: 'running', pct: 0, label: 'Starting…', started_at: Date.now(), deferred: null, circuit_open: null, retry_after_ms: null, result: null });
  const progress = (pct, label) => setProgress(job.profileId, {
    pct: Math.max(0, Math.min(100, Math.round(pct))),
    ...(label ? { label } : {}),
  });
  try {
    const result = await job.run(progress);
    // Carry structured per-catalog outcomes (deferred/partial) in the job result
    setProgress(job.profileId, { state: 'done', pct: 100, label: 'Done', finished_at: Date.now(), result: result || null });
    job.resolve(result);
  } catch (err) {
    // Preserve structured defer/circuit metadata so the portal can show
    // actionable retry information (retry_after_ms, provider, deferred flag).
    const patch = { state: 'error', label: `Failed: ${err.message}`, error: err.message, finished_at: Date.now() };
    if (err.defer) {
      patch.deferred = true;
      patch.retry_after_ms = err.retryAfterMs || 0;
      patch.provider = 'mdblist';
    }
    if (err.circuitOpen) {
      patch.circuit_open = true;
      patch.provider = 'mdblist';
    }
    setProgress(job.profileId, patch);
    job.reject(err);
  } finally {
    active = null;
    pump(); // run the next queued job
  }
}

function _reset() { queue.length = 0; active = null; state.clear(); }

module.exports = { enqueue, snapshot, isBusy, queuePosition, activeJobInfo, nextJobInfo, setProgress, _reset };
