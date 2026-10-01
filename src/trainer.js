// Trainer T1 — the transport-agnostic taste-trainer action core.
//
// A per-profile screen where the user rates (1–10), loves (10/10) or ignores
// titles from their watch history so the Marquee engine learns. This module is
// the SINGLE core every surface (portal + companion) shares, shaped like
// markWatched / dontRecommend.suppress: no req/res, plain data in and out, so
// the two surfaces can't drift apart (TD-7).
//
// Mandates honoured here:
//   M1 — rate() writes Simkl FIRST; the local taste_ratings row is written only
//        after the Simkl write succeeds (a failed write changes nothing local).
//   M2 — setIgnored() is local only: it never calls Simkl and never touches the
//        watched rows; an ignored film stays in watchedIdSets.
//   M3 — no "loved"/"super-like" flag in storage: `loved` is computed as
//        rating === 10 in the DTO, never stored.
//   M4 — movies only in v1: type 'series' → not-supported, else → bad-type.
//   M5 — every action resolves against THIS profile's own history only; an
//        unknown title is not-in-history.
//   M6 — all logic lives here; the routes only parse input + call the core +
//        map with httpStatus.
//   M7 — every Simkl write goes through simkl.setRatings/removeRatings (the
//        governed simkl_post lane); no direct fetch, no retries.
//   M10 — the wrappers use req.profile only; the core takes a resolved profile.
//   M12 — logs carry counts and ids only, never titles.
const simkl = require('./services/simkl');
const watchedStore = require('./watchedStore');
const tasteFeedback = require('./tasteFeedback');
const engagement = require('./engines/marquee/engagement');
const marqueeConfig = require('./engines/marquee/config');
const metaStore = require('./engines/glass/metaStore');
const markWatchedMod = require('./markWatched');
const settings = require('./settings');
const db = require('./db');

// The filter views (spec §6).
const VIEWS = ['all', 'unrated', 'rated', 'loved', 'ignored', 'unfinished'];

// Collaborators, injectable for hermetic tests (M11). Production callers may
// pass nothing; the defaults are the real modules.
const defaultDeps = {
  simkl,
  watchedStore,
  tasteFeedback,
  engagement,
  marqueeConfig,
  markWatched: markWatchedMod.markWatched,
  settings,
  enrich: metaStore.enrich,
  metaGet: metaStore.get,
  unfinishedRows,
  db,
  now: Date.now,
  log: console,
};
function mergeDeps(deps) {
  return { ...defaultDeps, ...(deps || {}) };
}

// v1 is movies only (M4): 'movie' ok, 'series' → not-supported, else → bad-type.
function resolveType(type) {
  const t = type || 'movie';
  if (t === 'movie') return { ok: true, type: t };
  if (t === 'series') return { ok: false, reason: 'not-supported' };
  return { ok: false, reason: 'bad-type' };
}

// The shared status mapper (M6). A thrown Simkl error is mapped to 502 by the
// wrapper's catch, not here.
function httpStatus(result) {
  if (result && result.ok) return 200;
  const reason = result && result.reason;
  if (reason === 'not-in-history') return 404;
  if (['bad-type', 'not-supported', 'bad-rating', 'bad-value', 'bad-view', 'no-simkl', 'no-id'].includes(reason)) return 400;
  return 422;
}

// Simkl connected for this profile? (M1/M7 pre-check — a clean 400, not a 502.)
function hasSimkl(profile) {
  return !!(profile && profile.keys && profile.keys.simkl_client_id && profile.simkl_auth && profile.simkl_auth.access_token);
}

// The 15-key trainer item DTO (spec §6). `key` is the tmdb id (unique after
// dedupe; the stable id for actions). `loved` is computed, never stored (M3).
function toItem(row, status, { ratings, ignored, meta }) {
  const tmdbId = row.tmdb_id != null ? String(row.tmdb_id) : null;
  const rating = tmdbId != null && ratings.has(tmdbId) ? ratings.get(tmdbId) : null;
  const genre = row.primary_genre || (meta && (meta.primary_genre || (meta.genres && meta.genres[0]) || null)) || null;
  const poster = meta ? meta.poster : null;
  const title = row.title || (meta && meta.title) || null;
  const year = row.year != null ? row.year : (meta ? meta.year : null);
  const imdbId = row.imdb_id != null ? row.imdb_id : (meta && meta.imdb_id) || null;
  return {
    key: tmdbId,
    type: row.type || 'movie',
    simkl_id: row.simkl_id != null ? row.simkl_id : null,
    tmdb_id: tmdbId,
    imdb_id: imdbId,
    title,
    year,
    genre,
    poster,
    watched_at: row.watched_at != null ? row.watched_at : null,
    rating,
    loved: rating === 10,
    ignored: tmdbId != null ? ignored.has(tmdbId) : false,
    status,
    percent: row.percent != null ? Math.round(Number(row.percent)) : null,
  };
}

// Build the full DTO for an action's resolved row (F8: rate/setIgnored return
// the same shape as listHistory, so the two surfaces can't drift).
function buildItem(D, profile, type, row, status = 'watched') {
  const ratings = D.tasteFeedback.getRatingsMap(profile.id, type);
  const ignored = D.tasteFeedback.ignoredSet(profile.id, type);
  const meta = row.tmdb_id != null ? D.metaGet(type, row.tmdb_id) : null;
  return toItem(row, status, { ratings, ignored, meta });
}

// Resolve a ref against THIS profile's watched rows (type-scoped), deduplicated
// by tmdb_id keeping the newest watched_at. Rows without a tmdb_id can't be
// acted on (M5). Resolution order: simkl_id → tmdb_id → imdb_id, each compared
// as normalized strings. Returns the row or null.
function resolveWatchedRow(profileId, type, ref, watchedStore) {
  if (!ref || typeof ref !== 'object') return null;
  const rows = watchedStore.getWatched(profileId, { type });
  const byTmdb = new Map();
  for (const r of rows) {
    const tmdbId = r.tmdb_id != null ? String(r.tmdb_id) : null;
    if (tmdbId && !byTmdb.has(tmdbId)) byTmdb.set(tmdbId, r);
  }
  if (ref.simkl_id != null) {
    const r = rows.find((x) => x.simkl_id != null && String(x.simkl_id) === String(ref.simkl_id));
    const tmdbId = r && r.tmdb_id != null ? String(r.tmdb_id) : null;
    if (tmdbId) return byTmdb.get(tmdbId) || null;
  }
  if (ref.tmdb_id != null && ref.tmdb_id !== '') {
    return byTmdb.get(String(ref.tmdb_id)) || null;
  }
  if (ref.imdb_id) {
    const r = rows.find((x) => x.imdb_id === ref.imdb_id);
    const tmdbId = r && r.tmdb_id != null ? String(r.tmdb_id) : null;
    return tmdbId ? byTmdb.get(tmdbId) : null;
  }
  return null;
}

// The Marquee engagement config for the shared abandoned rule (N7): the same
// resolved config Marquee builds with, so the two consumers can't disagree.
// A test-injected `settings` without getSettings falls back to the defaults.
function engagementCfg(D) {
  const s = D.settings.getSettings ? D.settings.getSettings() : null;
  return D.marqueeConfig.resolveConfig(s).engagement;
}

// Is a marquee_engagement row an unfinished (abandoned) row? PURE (F6).
// Trainer T2 (N7): the ONE rule — engagement.isAbandoned, the same function
// Marquee uses for its abandoned set — so the Trainer's "Unfinished" list and
// the engine's dropped set can never disagree. `watchedIds` is
// watchedStore.watchedIdSets (it already includes the pending shim).
function isUnfinishedRow(row, watchedIds, { now = Date.now(), deps = {} } = {}) {
  const D = mergeDeps(deps);
  return D.engagement.isAbandoned(row, engagementCfg(D), { now, watchedIds });
}

// The profile's unfinished rows: the shared engagement.abandonedRows (N7 —
// one rule, two consumers). Injectable for tests (deps.unfinishedRows).
// The grace period measures REAL elapsed time (engagement rows are stamped
// with Date.now()), so the rule runs on the real clock even when D.now() is
// an injectable action clock used for recording changes.
function unfinishedRows(profileId, D) {
  const cfg = D.marqueeConfig.resolveConfig(D.settings.getSettings ? D.settings.getSettings() : null);
  return D.engagement.abandonedRows(profileId, cfg, { now: Date.now() });
}

// Resolve a ref against THIS profile's unfinished rows (spec §6: setIgnored and
// markFinished can act on an unfinished row). Match by imdb_id, then tmdb_id.
// Returns the whole row or null.
function resolveUnfinishedRow(profileId, type, ref, D) {
  if (!ref || typeof ref !== 'object') return null;
  const rows = D.unfinishedRows(profileId, D);
  if (ref.imdb_id) {
    const r = rows.find((x) => x.imdb_id === ref.imdb_id);
    if (r) return r;
  }
  if (ref.tmdb_id != null && ref.tmdb_id !== '') {
    const tmdbId = String(ref.tmdb_id);
    const r = rows.find((x) => x.tmdb_id != null && String(x.tmdb_id) === tmdbId);
    if (r) return r;
  }
  return null;
}

// listHistory — the per-profile watch-history listing (spec §6). Returns
// { ok:true, items, page, pageSize, total, counts, training } on success, or
// { ok:false, reason } on a bad type/view.
async function listHistory(profile, { type: typeIn, view = 'all', q = null, page = 1, pageSize = 25 } = {}, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(typeIn);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  const v = view || 'all';
  if (!VIEWS.includes(v)) return { ok: false, reason: 'bad-view' };
  const ps = Math.min(100, Math.max(1, Math.floor(Number(pageSize)) || 25));
  const pg = Math.max(1, Math.floor(Number(page)) || 1);

  const ratings = D.tasteFeedback.getRatingsMap(profile.id, type);
  const ignored = D.tasteFeedback.ignoredSet(profile.id, type);

  // Watched rows, deduplicated by tmdb_id keeping the newest watched_at.
  const rows = D.watchedStore.getWatched(profile.id, { type });
  const byTmdb = new Map();
  let unresolved = 0;
  for (const r of rows) {
    const tmdbId = r.tmdb_id != null ? String(r.tmdb_id) : null;
    if (!tmdbId) { unresolved += 1; continue; } // no tmdb_id → can't be acted on
    if (!byTmdb.has(tmdbId)) byTmdb.set(tmdbId, r); // rows are newest-first
  }
  const watchedItems = [];
  for (const [tmdbId, r] of byTmdb) {
    const item = toItem(r, 'watched', { ratings, ignored, meta: null });
    item._sortMs = r.watched_at ? (Date.parse(r.watched_at) || 0) : 0;
    watchedItems.push(item);
  }

  // Unfinished (abandoned) items — movies only, keyed by tmdb_id.
  const unfinishedRowsList = D.unfinishedRows(profile.id, D);
  const unfinishedItems = [];
  for (const row of unfinishedRowsList) {
    const item = toItem(row, 'unfinished', { ratings, ignored, meta: null });
    item._sortMs = row.updated_at || 0;
    item._imdbId = row.imdb_id;
    unfinishedItems.push(item);
  }

  // Counts (filter chips) — over the whole universe, per view. F5: rated
  // includes a 10 (loved); the loved chip is the 10 subset.
  const counts = {
    all: watchedItems.filter((i) => !i.ignored).length,
    unrated: watchedItems.filter((i) => !i.ignored && i.rating == null).length,
    rated: watchedItems.filter((i) => !i.ignored && i.rating != null).length,
    loved: watchedItems.filter((i) => !i.ignored && i.rating === 10).length,
    ignored: watchedItems.filter((i) => i.ignored).length + unfinishedItems.filter((i) => i.ignored).length,
    unfinished: unfinishedItems.filter((i) => !i.ignored).length,
    unresolved,
  };

  // The current view.
  let viewItems;
  switch (v) {
    case 'all': viewItems = watchedItems.filter((i) => !i.ignored); break;
    case 'unrated': viewItems = watchedItems.filter((i) => !i.ignored && i.rating == null); break;
    case 'rated': viewItems = watchedItems.filter((i) => !i.ignored && i.rating != null); break;
    case 'loved': viewItems = watchedItems.filter((i) => !i.ignored && i.rating === 10); break;
    case 'ignored': viewItems = [...watchedItems.filter((i) => i.ignored), ...unfinishedItems.filter((i) => i.ignored)]; break;
    case 'unfinished': viewItems = unfinishedItems.filter((i) => !i.ignored); break;
  }

  // Case-insensitive title search (F9: trim; skip the filter when empty).
  const qStr = q == null ? '' : String(q).trim();
  if (qStr) {
    const needle = qStr.toLowerCase();
    viewItems = viewItems.filter((i) => i.title && String(i.title).toLowerCase().includes(needle));
  }

  // Sort: watched_at DESC, simkl_id DESC (watched); updated_at DESC, imdb_id
  // (unfinished) — F6 tie-break.
  viewItems.sort((a, b) => {
    if (b._sortMs !== a._sortMs) return b._sortMs - a._sortMs;
    const sim = (b.simkl_id || 0) - (a.simkl_id || 0);
    if (sim !== 0) return sim;
    const ia = a._imdbId || '', ib = b._imdbId || '';
    if (ia < ib) return 1;
    if (ia > ib) return -1;
    return 0;
  });

  const total = viewItems.length;
  const pageItems = viewItems.slice((pg - 1) * ps, pg * ps);

  // F2: fill poster/genre/title/year from the meta cache (no network) for every
  // page item, then lazily enrich ≤ 25 still-missing posters (batches of 8).
  for (const item of pageItems) {
    if (item.tmdb_id != null) {
      const meta = D.metaGet(type, item.tmdb_id);
      if (meta) {
        if (item.poster == null) item.poster = meta.poster;
        if (item.genre == null) item.genre = meta.primary_genre || (meta.genres && meta.genres[0]) || null;
        if (item.title == null) item.title = meta.title;
        if (item.year == null) item.year = meta.year;
      }
    }
  }
  const apiKey = D.settings.keyFor(profile, 'tmdb_api_key');
  if (apiKey) {
    const missing = pageItems.filter((i) => i.tmdb_id != null && i.poster == null);
    const toEnrich = missing.slice(0, 25);
    for (let i = 0; i < toEnrich.length; i += 8) {
      const batch = toEnrich.slice(i, i + 8);
      const metas = await Promise.all(batch.map((item) => D.enrich(apiKey, type, item.tmdb_id, D.log, {}).catch(() => null)));
      metas.forEach((meta, idx) => {
        const item = batch[idx];
        if (!meta) return;
        if (item.poster == null) item.poster = meta.poster;
        if (item.genre == null) item.genre = meta.primary_genre || (meta.genres && meta.genres[0]) || null;
        if (item.title == null) item.title = meta.title;
        if (item.year == null) item.year = meta.year;
      });
    }
  }
  for (const item of pageItems) { delete item._sortMs; delete item._imdbId; }

  const training = D.tasteFeedback.getTraining(profile.id);
  // Trainer T2 (N8): when the change is NEWER than the last build that
  // included it, the rebuild becomes due after the 10-minute quiet period.
  let rebuildDueAt = null;
  if (training.changed_at != null
    && !(training.built_changed_at != null && training.changed_at <= training.built_changed_at)) {
    rebuildDueAt = training.changed_at + D.tasteFeedback.REBUILD_DEBOUNCE_MS;
  }
  return {
    ok: true,
    items: pageItems,
    page: pg,
    pageSize: ps,
    total,
    counts,
    training: { changes_since_build: training.changes_since_build, changed_at: training.changed_at, rebuild_due_at: rebuildDueAt },
  };
}

// rate — rate a title 1–10 (or null to clear). Simkl is the authority (M1): the
// write happens first; the local row is written only on success. A no-op (same
// value) makes zero Simkl calls and records no change (F4).
async function rate(profile, ref, rating, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(ref && ref.type);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  // `null` clears the rating; an omitted rating (undefined) is a bad value,
  // not a clear — clearing must be explicit.
  if (rating === undefined || (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 10))) {
    return { ok: false, reason: 'bad-rating' };
  }
  if (!hasSimkl(profile)) return { ok: false, reason: 'no-simkl' };
  const row = resolveWatchedRow(profile.id, type, ref, D.watchedStore);
  if (!row) return { ok: false, reason: 'not-in-history' };
  // F4 no-op: same value (both null counts too) → no Simkl call, no change.
  const current = D.tasteFeedback.getRating(profile.id, type, row.tmdb_id);
  if (current === rating) {
    return { ok: true, item: buildItem(D, profile, type, row), unchanged: true };
  }
  // M7: every Simkl write goes through the governed simkl_post lane.
  if (rating == null) {
    await D.simkl.removeRatings(profile, [{ type, simkl_id: row.simkl_id, imdb_id: row.imdb_id, tmdb_id: row.tmdb_id }]);
  } else {
    await D.simkl.setRatings(profile, [{ type, simkl_id: row.simkl_id, imdb_id: row.imdb_id, tmdb_id: row.tmdb_id, rating }]);
  }
  const now = D.now();
  if (rating == null) {
    D.tasteFeedback.deleteRating(profile.id, type, row.tmdb_id);
  } else {
    D.tasteFeedback.upsertRating(profile.id, { type, tmdb_id: row.tmdb_id, imdb_id: row.imdb_id, simkl_id: row.simkl_id, rating, rated_at: new Date(now).toISOString() });
  }
  D.tasteFeedback.recordChange(profile.id, now);
  D.log.log(`[trainer] ${profile.name}: rated ${type} tmdb:${row.tmdb_id} → ${rating == null ? 'cleared' : rating}`);
  return { ok: true, item: buildItem(D, profile, type, row), unchanged: false };
}

// setIgnored — ignore/un-ignore a title (local only — M2: never calls Simkl,
// never touches watched rows). Resolves against watched rows, then unfinished.
// The value must be a boolean (F3); a no-op records no change.
async function setIgnored(profile, ref, ignored, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(ref && ref.type);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  if (typeof ignored !== 'boolean') return { ok: false, reason: 'bad-value' };
  let row = resolveWatchedRow(profile.id, type, ref, D.watchedStore);
  let status = 'watched';
  if (!row) {
    row = resolveUnfinishedRow(profile.id, type, ref, D);
    status = 'unfinished';
    if (!row) return { ok: false, reason: 'not-in-history' };
  }
  const tmdbId = String(row.tmdb_id);
  const now = D.now();
  const changed = D.tasteFeedback.setIgnored(profile.id, { type, tmdb_id: tmdbId, simkl_id: row.simkl_id, imdb_id: row.imdb_id }, ignored, now);
  if (changed) D.tasteFeedback.recordChange(profile.id, now);
  D.log.log(`[trainer] ${profile.name}: ${ignored ? 'ignored' : 'un-ignored'} ${type} tmdb:${tmdbId}`);
  return { ok: true, item: buildItem(D, profile, type, row, status), unchanged: !changed };
}

// markFinished — mark an unfinished (abandoned) film finished. Delegates to the
// shared markWatched action (writes Simkl + pins a pending-watched shim). Uses
// the row's own ids (F6.5), never the ref's.
async function markFinished(profile, ref, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(ref && ref.type);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  const row = resolveUnfinishedRow(profile.id, type, ref, D);
  if (!row) return { ok: false, reason: 'not-in-history' };
  const meta = row.tmdb_id != null ? D.metaGet(type, row.tmdb_id) : null;
  const res = await D.markWatched(profile, { type, imdbId: row.imdb_id, tmdbId: String(row.tmdb_id), title: (meta && meta.title) || null }, D.log);
  if (res && res.ok === false) return { ok: false, reason: res.reason };
  const now = D.now();
  D.tasteFeedback.recordChange(profile.id, now);
  D.log.log(`[trainer] ${profile.name}: marked finished ${type} tmdb:${row.tmdb_id}`);
  return { ok: true };
}

module.exports = {
  VIEWS,
  listHistory,
  rate,
  setIgnored,
  markFinished,
  isUnfinishedRow,
  httpStatus,
  resolveType,
  hasSimkl,
};
