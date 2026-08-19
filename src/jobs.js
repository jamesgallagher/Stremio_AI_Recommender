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

// Enqueue a job. `run(progress)` does the work; call progress(pct, label) to
// report. Returns a promise that settles when the job finishes. A duplicate
// (same profile+kind, already queued/running) returns the in-flight promise.
function enqueue(profileId, kind, run) {
  const existing = queue.find((j) => j.profileId === profileId && j.kind === kind);
  if (existing) return existing.promise;
  if (active && active.profileId === profileId && active.kind === kind) return active.promise;

  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const job = { profileId, kind, run, resolve, reject, promise };
  queue.push(job);
  setProgress(profileId, { kind, state: 'queued', pct: 0, label: 'Queued…', queued_at: Date.now(), error: null });
  pump();
  return promise;
}

async function pump() {
  if (active || !queue.length) return;
  const job = queue.shift();
  active = job;
  setProgress(job.profileId, { kind: job.kind, state: 'running', pct: 0, label: 'Starting…', started_at: Date.now() });
  const progress = (pct, label) => setProgress(job.profileId, {
    pct: Math.max(0, Math.min(100, Math.round(pct))),
    ...(label ? { label } : {}),
  });
  try {
    const result = await job.run(progress);
    setProgress(job.profileId, { state: 'done', pct: 100, label: 'Done', finished_at: Date.now(), result: result || null });
    job.resolve(result);
  } catch (err) {
    setProgress(job.profileId, { state: 'error', label: `Failed: ${err.message}`, error: err.message, finished_at: Date.now() });
    job.reject(err);
  } finally {
    active = null;
    pump(); // run the next queued job
  }
}

function _reset() { queue.length = 0; active = null; state.clear(); }

module.exports = { enqueue, snapshot, isBusy, queuePosition, setProgress, _reset };
