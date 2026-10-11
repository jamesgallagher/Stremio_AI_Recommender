// WD-2 — Repair "watched today" dates left by mark-as-viewed before WD-1.
//
// Before v7.55.1 a UI "mark viewed" let Simkl stamp "now", which the taste
// engines read as a fresh watch. Nothing in the data separates those from real
// watches, so this is an ADMIN-DRIVEN repair: list recently-dated movies whose
// release date is much older, let the admin tick the ones that were really UI
// marks, then re-date them to the release date.
//
// Live findings (2026-10-12, Siobhan, throwaway titles):
//   - Simkl IGNORES a re-post that carries a different watched_at.
//   - Removing a title from history ALSO deletes its Simkl rating, and a dated
//     re-add does not restore it.
// So each title is repaired as: read rating → remove from history → re-add with
// the release date → set the rating again → verify. Every step is recorded in
// `watched_repairs` BEFORE anything changes, so a batch can be undone.
//
// Movies only. Series carry per-episode data we haven't proven we can preserve.
const db = require('./db');
const simkl = require('./services/simkl');
const tmdb = require('./services/tmdb');
const settings = require('./settings');
const watchedStore = require('./watchedStore');
const tasteFeedback = require('./tasteFeedback');

const DAY_MS = 86400000;
const MIN_GAP_DAYS = 7;          // release must be at least this much older than the stored date
const MAX_SCAN = 150;            // rows examined per preview (one TMDB call each)
const MAX_ROWS = 100;            // rows returned to the UI
const MAX_APPLY = 10;            // titles per apply request (each costs ~4 Simkl writes at 1/s)
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

let ready = false;
function init() {
  if (ready) return;
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS watched_repairs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id     TEXT    NOT NULL,
      batch          TEXT    NOT NULL,
      imdb_id        TEXT,
      tmdb_id        TEXT,
      simkl_id       INTEGER,
      title          TEXT,
      old_watched_at TEXT,
      new_watched_at TEXT,
      rating         INTEGER,              -- rating read before the repair (null = unrated)
      status         TEXT    NOT NULL,     -- started|done|rating_lost|date_mismatch|failed|undone
      detail         TEXT,
      at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_watched_repairs_profile ON watched_repairs (profile_id, batch);
  `);
  ready = true;
}

const busy = new Set();   // profile ids with a repair in flight (one at a time)

function realDeps() {
  return {
    simkl,
    fetchDate: tmdb.releaseDateFor,
    now: Date.now,
    log: console,
  };
}

// Release date for a candidate as an ISO midnight-UTC string, or null.
async function releaseIso(profile, row, deps) {
  const apiKey = settings.keyFor(profile, 'tmdb_api_key');
  if (!apiKey) return null;
  try {
    const r = await deps.fetchDate(apiKey, 'movie', { imdbId: row.imdb_id, tmdbId: row.tmdb_id }, deps.log);
    return r && r.date ? `${r.date}T00:00:00.000Z` : null;
  } catch { return null; }
}

const sameInstant = (a, b) => Date.parse(a) === Date.parse(b);

// Preview: movies whose stored watched date is recent but whose release is much
// older. Excludes titles this app scrobbled from Nuvio/Stremio (their dates are
// real) and titles already dated to their release. Read-only.
async function findCandidates(profile, { days = DEFAULT_DAYS, limit = MAX_ROWS } = {}, deps = realDeps()) {
  init();
  const d = Math.min(Math.max(parseInt(days, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
  const nowMs = deps.now();
  const cutoff = nowMs - d * DAY_MS;
  const scrobbled = watchedStore.pushedMovieIds(profile.id);
  const ratings = tasteFeedback.getRatingsMap(profile.id, 'movie');
  const recent = watchedStore.getWatched(profile.id, { type: 'movie' })
    .filter((r) => { const t = Date.parse(r.watched_at); return Number.isFinite(t) && t >= cutoff; });
  const rows = [];
  let scanned = 0;
  let skippedScrobbled = 0;
  for (const r of recent) {
    if (rows.length >= limit || scanned >= MAX_SCAN) break;
    if (r.imdb_id && scrobbled.has(r.imdb_id)) { skippedScrobbled++; continue; }
    scanned++;
    const rel = await releaseIso(profile, r, deps);
    if (!rel) continue;
    const relMs = Date.parse(rel);
    const wMs = Date.parse(r.watched_at);
    if (relMs > nowMs) continue;                              // unreleased: nothing to correct
    if (sameInstant(rel, r.watched_at)) continue;             // already dated to release
    if (wMs - relMs < MIN_GAP_DAYS * DAY_MS) continue;        // watched about when it released: plausible
    rows.push({
      simkl_id: r.simkl_id, imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, title: r.title, year: r.year,
      watched_at: r.watched_at, proposed: rel,
      rating: r.tmdb_id != null ? (ratings.get(String(r.tmdb_id)) ?? null) : null,
    });
  }
  return { days: d, scanned, skipped_scrobbled: skippedScrobbled, rows };
}

const insertRepair = (profileId, batch, row, oldAt, newAt, rating, status, detail, at) =>
  Number(db.get().prepare(`
    INSERT INTO watched_repairs (profile_id, batch, imdb_id, tmdb_id, simkl_id, title, old_watched_at, new_watched_at, rating, status, detail, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    profileId, batch, row.imdb_id ?? null, row.tmdb_id != null ? String(row.tmdb_id) : null, row.simkl_id ?? null,
    row.title ?? null, oldAt, newAt, rating, status, detail, at).lastInsertRowid);

const setStatus = (id, status, detail = null) =>
  db.get().prepare('UPDATE watched_repairs SET status = ?, detail = ? WHERE id = ?').run(status, detail, id);

function ratingOf(list, row) {
  const hit = list.find((x) => (row.imdb_id && x.imdb_id === row.imdb_id)
    || (row.tmdb_id != null && x.tmdb_id != null && String(x.tmdb_id) === String(row.tmdb_id)));
  return hit ? hit.rating : null;
}

// remove → add (dated) → re-rate. Throws after attempting to restore `restoreAt`
// if the add fails once the remove has succeeded.
async function redate(profile, row, targetAt, restoreAt, rating, deps) {
  const ids = { type: 'movie', imdb_id: row.imdb_id || undefined, tmdb_id: row.tmdb_id != null ? row.tmdb_id : undefined };
  await deps.simkl.removeFromHistory(profile, [ids]);            // if this throws nothing has changed
  const body = { movies: [{ ids: {}, watched_at: targetAt }], shows: [] };
  if (row.imdb_id) body.movies[0].ids.imdb = String(row.imdb_id);
  if (row.tmdb_id != null && row.tmdb_id !== '') body.movies[0].ids.tmdb = String(row.tmdb_id);
  try {
    await deps.simkl.addToHistory(profile, body);
  } catch (err) {
    let restored = false;
    try {
      body.movies[0].watched_at = restoreAt;
      await deps.simkl.addToHistory(profile, body);
      if (rating) await deps.simkl.setRatings(profile, [{ ...ids, rating }]);
      restored = true;
    } catch { /* reported below */ }
    const e = new Error(`${err.message}${restored ? ' (original date restored)' : ' (COULD NOT RESTORE — title is missing from Simkl history)'}`);
    e.restored = restored;
    throw e;
  }
  if (rating) await deps.simkl.setRatings(profile, [{ ...ids, rating }]);
}

function findWatchedRow(profileId, ref) {
  const imdb = ref.imdb_id || null;
  const tmdb = ref.tmdb_id != null && ref.tmdb_id !== '' ? String(ref.tmdb_id) : null;
  return watchedStore.getWatched(profileId, { type: 'movie' })
    .find((r) => (imdb && r.imdb_id === imdb) || (tmdb && r.tmdb_id != null && String(r.tmdb_id) === tmdb)) || null;
}

// Verify a batch with ONE ratings read and ONE history read; retry a missing
// rating once. Returns nothing; updates statuses in place.
async function verifyBatch(profile, items, deps) {
  const ratingsNow = await deps.simkl.getRatings(profile, 'movies');
  const hist = await deps.simkl.getAllItems(profile, 'movies', { status: 'completed' });
  for (const it of items) {
    if (it.status !== 'done') continue;
    let detail = null; let status = 'done';
    const h = hist.find((x) => (it.row.imdb_id && x.movie?.ids?.imdb === it.row.imdb_id)
      || (it.row.tmdb_id != null && String(x.movie?.ids?.tmdb) === String(it.row.tmdb_id)));
    const stored = h ? (h.last_watched_at || h.watched_at) : null;
    if (!stored || !sameInstant(stored, it.newAt)) { status = 'date_mismatch'; detail = `Simkl shows ${stored || 'no entry'}`; }
    if (it.rating && ratingOf(ratingsNow, it.row) !== it.rating) {
      try {
        await deps.simkl.setRatings(profile, [{ type: 'movie', imdb_id: it.row.imdb_id || undefined, tmdb_id: it.row.tmdb_id ?? undefined, rating: it.rating }]);
        const again = await deps.simkl.getRatings(profile, 'movies');
        if (ratingOf(again, it.row) !== it.rating) { status = 'rating_lost'; detail = `rating ${it.rating} did not come back`; }
      } catch (e) { status = 'rating_lost'; detail = `rating ${it.rating}: ${e.message}`; }
    }
    it.status = status; it.detail = detail;
    setStatus(it.repairId, status, detail);
  }
}

// Apply the repair to the ticked titles. `refs` = [{imdb_id, tmdb_id}]. The
// release date and the stored date are re-derived HERE (never trusted from the
// browser). Returns { batch, results:[{title,imdb_id,status,detail,old,new,rating}] }.
async function applyRepair(profile, refs, deps = realDeps()) {
  init();
  if (!Array.isArray(refs) || !refs.length) return { error: 'nothing-selected' };
  if (refs.length > MAX_APPLY) return { error: 'too-many', max: MAX_APPLY };
  if (busy.has(profile.id)) return { error: 'busy' };
  busy.add(profile.id);
  try {
    const batch = `${deps.now()}`;
    const scrobbled = watchedStore.pushedMovieIds(profile.id);
    const simklRatings = await deps.simkl.getRatings(profile, 'movies');
    const nowMs = deps.now();
    const items = [];
    for (const ref of refs) {
      const row = findWatchedRow(profile.id, ref);
      const out = { row: row || ref, status: 'skipped', detail: null, title: row?.title ?? null, imdb_id: ref.imdb_id || null };
      items.push(out);
      if (!row) { out.detail = 'not-found'; continue; }
      if (row.imdb_id && scrobbled.has(row.imdb_id)) { out.detail = 'scrobbled (real watch date)'; continue; }
      const newAt = await releaseIso(profile, row, deps);
      if (!newAt) { out.detail = 'no-release-date'; continue; }
      const nMs = Date.parse(newAt); const oMs = Date.parse(row.watched_at);
      if (nMs > nowMs || !(oMs - nMs >= MIN_GAP_DAYS * DAY_MS)) { out.detail = 'no-change-needed'; continue; }
      const rating = ratingOf(simklRatings, row);
      out.oldAt = row.watched_at; out.newAt = newAt; out.rating = rating;
      // Record the undo info BEFORE touching Simkl.
      out.repairId = insertRepair(profile.id, batch, row, row.watched_at, newAt, rating, 'started', null, deps.now());
      try {
        await redate(profile, row, newAt, row.watched_at, rating, deps);
        out.status = 'done';
      } catch (err) {
        out.status = 'failed'; out.detail = err.message;
        setStatus(out.repairId, 'failed', err.message);
      }
    }
    const done = items.filter((i) => i.status === 'done');
    if (done.length) {
      try { await verifyBatch(profile, items, deps); }
      catch (e) { for (const i of done) { i.status = 'done'; i.detail = `unverified: ${e.message}`; setStatus(i.repairId, 'done', i.detail); } }
      // Mirror the new dates/ratings locally so the engines see them before the next sync.
      const upd = [];
      for (const i of items) {
        if (!i.repairId || (i.status !== 'done' && i.status !== 'rating_lost')) continue;
        upd.push({ ...i.row, watched_at: i.newAt });
        if (i.rating && i.row.tmdb_id != null) {
          tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: i.row.tmdb_id, imdb_id: i.row.imdb_id, simkl_id: i.row.simkl_id, rating: i.rating, rated_at: new Date(deps.now()).toISOString() });
        }
      }
      watchedStore.upsertMany(profile.id, upd);
      tasteFeedback.recordChange(profile.id, deps.now());
    }
    return {
      batch,
      results: items.map((i) => ({
        title: i.title, imdb_id: i.imdb_id, status: i.status, detail: i.detail,
        old: i.oldAt || null, new: i.newAt || null, rating: i.rating ?? null,
      })),
    };
  } finally {
    busy.delete(profile.id);
  }
}

// Undo a batch: put every repaired title back to its old date and rating.
async function undoBatch(profile, batch, deps = realDeps()) {
  init();
  if (busy.has(profile.id)) return { error: 'busy' };
  const rows = db.get().prepare(
    "SELECT * FROM watched_repairs WHERE profile_id = ? AND batch = ? AND status IN ('done','rating_lost','date_mismatch') ORDER BY id")
    .all(profile.id, String(batch));
  if (!rows.length) return { error: 'nothing-to-undo' };
  if (rows.length > MAX_APPLY * 5) return { error: 'too-many', max: MAX_APPLY * 5 };
  busy.add(profile.id);
  try {
    const results = [];
    const ratingsNow = await deps.simkl.getRatings(profile, 'movies');   // throws before any change
    for (const r of rows) {
      const local = findWatchedRow(profile.id, r) || { imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, simkl_id: r.simkl_id, title: r.title, type: 'movie' };
      try {
        const keep = ratingOf(ratingsNow, r) ?? r.rating;   // a rating changed since the repair wins
        await redate(profile, local, r.old_watched_at, r.new_watched_at, keep, deps);
        setStatus(r.id, 'undone');
        if (local.simkl_id) watchedStore.upsertMany(profile.id, [{ ...local, watched_at: r.old_watched_at }]);
        if (keep && r.tmdb_id != null) {
          tasteFeedback.upsertRating(profile.id, { type: 'movie', tmdb_id: r.tmdb_id, imdb_id: r.imdb_id, simkl_id: r.simkl_id, rating: keep, rated_at: new Date(deps.now()).toISOString() });
        }
        results.push({ title: r.title, imdb_id: r.imdb_id, status: 'undone' });
      } catch (err) {
        results.push({ title: r.title, imdb_id: r.imdb_id, status: 'failed', detail: err.message });
      }
    }
    tasteFeedback.recordChange(profile.id, deps.now());
    return { batch: String(batch), results };
  } finally {
    busy.delete(profile.id);
  }
}

// Recent repair log, newest first, grouped for the UI by batch.
function listLog(profileId, { limit = 200 } = {}) {
  init();
  return db.get().prepare('SELECT id, batch, imdb_id, title, old_watched_at, new_watched_at, rating, status, detail, at FROM watched_repairs WHERE profile_id = ? ORDER BY id DESC LIMIT ?')
    .all(profileId, Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500));
}

module.exports = {
  findCandidates, applyRepair, undoBatch, listLog,
  MAX_APPLY, DEFAULT_DAYS, MAX_DAYS,
  _resetForTests() { ready = false; busy.clear(); },
};
