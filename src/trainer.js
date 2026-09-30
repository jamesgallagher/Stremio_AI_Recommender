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
const metaStore = require('./engines/glass/metaStore');
const markWatchedMod = require('./markWatched');
const settings = require('./settings');

// The filter views (spec §6).
const VIEWS = ['all', 'unrated', 'rated', 'loved', 'ignored', 'unfinished'];

// Collaborators, injectable for hermetic tests (M11). Production callers may
// pass nothing; the defaults are the real modules.
const defaultDeps = {
  simkl,
  watchedStore,
  tasteFeedback,
  engagement,
  markWatched: markWatchedMod.markWatched,
  settings,
  enrich: metaStore.enrich,
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

// Resolve a ref against THIS profile's watched rows (type-scoped), deduplicated
// by tmdb_id keeping the newest watched_at. Rows without a tmdb_id can't be
// acted on (M5). Returns the row or null.
function resolveWatchedRow(profileId, type, ref, watchedStore) {
  if (!ref || typeof ref !== 'object') return null;
  const rows = watchedStore.getWatched(profileId, { type });
  const byTmdb = new Map();
  for (const r of rows) {
    const tmdbId = r.tmdb_id != null ? String(r.tmdb_id) : null;
    if (tmdbId && !byTmdb.has(tmdbId)) byTmdb.set(tmdbId, r);
  }
  if (ref.tmdb_id != null && ref.tmdb_id !== '') {
    return byTmdb.get(String(ref.tmdb_id)) || null;
  }
  if (ref.imdb_id) {
    const r = rows.find((x) => x.imdb_id === ref.imdb_id);
    const tmdbId = r && r.tmdb_id != null ? String(r.tmdb_id) : null;
    return tmdbId ? byTmdb.get(tmdbId) : null;
  }
  if (ref.simkl_id != null) {
    const r = rows.find((x) => x.simkl_id === ref.simkl_id);
    const tmdbId = r && r.tmdb_id != null ? String(r.tmdb_id) : null;
    return tmdbId ? byTmdb.get(tmdbId) : null;
  }
  return null;
}

// Resolve a ref against THIS profile's UNFINISHED (abandoned) rows, keyed by
// tmdb_id (spec §6: setIgnored can hide an unfinished row). Returns { tmdb_id }
// or null.
function resolveUnfinishedRow(profileId, type, ref, engagement, settings) {
  if (!ref || typeof ref !== 'object') return null;
  const cfg = settings.getSettings() || {};
  const abandoned = engagement.abandonedFor(profileId, cfg, { now: Date.now() });
  if (ref.tmdb_id != null && ref.tmdb_id !== '') {
    const tmdbId = String(ref.tmdb_id);
    return abandoned.has(tmdbId) ? { tmdb_id: tmdbId } : null;
  }
  return null;
}

// Is a trainer item an unfinished (abandoned) row?
function isUnfinishedRow(item) {
  return !!(item && item.status === 'unfinished');
}

// listHistory — the per-profile watch-history listing (spec §6). Returns
// { items, page, pageSize, total, counts, training } on success, or
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

  // Watched rows, deduplicated by tmdb_id keeping the newest watched_at.
  const rows = D.watchedStore.getWatched(profile.id, { type });
  const byTmdb = new Map();
  let unresolved = 0;
  for (const r of rows) {
    const tmdbId = r.tmdb_id != null ? String(r.tmdb_id) : null;
    if (!tmdbId) { unresolved += 1; continue; } // no tmdb_id → can't be acted on
    if (!byTmdb.has(tmdbId)) byTmdb.set(tmdbId, r); // rows are newest-first
  }
  const ratings = D.tasteFeedback.getRatingsMap(profile.id, type);
  const ignored = D.tasteFeedback.ignoredSet(profile.id, type);

  const watchedItems = [];
  for (const [tmdbId, r] of byTmdb) {
    const rating = ratings.get(tmdbId) != null ? ratings.get(tmdbId) : null;
    watchedItems.push({
      key: tmdbId,
      type,
      simkl_id: r.simkl_id,
      tmdb_id: tmdbId,
      imdb_id: r.imdb_id,
      title: r.title,
      year: r.year,
      genre: r.primary_genre || null,
      poster: null,
      watched_at: r.watched_at,
      rating,
      loved: rating === 10,
      ignored: ignored.has(tmdbId),
      status: 'watched',
      percent: null,
      _sortMs: r.watched_at ? (Date.parse(r.watched_at) || 0) : 0,
    });
  }

  // Unfinished (abandoned) items — movies only, keyed by tmdb_id.
  const cfg = D.settings.getSettings() || {};
  const abandoned = D.engagement.abandonedFor(profile.id, cfg, { now: D.now() });
  const unfinishedItems = [];
  for (const [tmdbId, info] of abandoned) {
    const rating = ratings.get(tmdbId) != null ? ratings.get(tmdbId) : null;
    unfinishedItems.push({
      key: tmdbId,
      type,
      simkl_id: null,
      tmdb_id: tmdbId,
      imdb_id: null,
      title: null,
      year: null,
      genre: null,
      poster: null,
      watched_at: null,
      rating,
      loved: rating === 10,
      ignored: ignored.has(tmdbId),
      status: 'unfinished',
      percent: info.percent,
      _sortMs: info.ts || 0,
    });
  }

  // Counts (filter chips) — over the whole universe, per view.
  const counts = {
    all: watchedItems.filter((i) => !i.ignored).length,
    unrated: watchedItems.filter((i) => !i.ignored && i.rating == null).length,
    rated: watchedItems.filter((i) => !i.ignored && i.rating != null && i.rating < 10).length,
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
    case 'rated': viewItems = watchedItems.filter((i) => !i.ignored && i.rating != null && i.rating < 10); break;
    case 'loved': viewItems = watchedItems.filter((i) => !i.ignored && i.rating === 10); break;
    case 'ignored': viewItems = [...watchedItems.filter((i) => i.ignored), ...unfinishedItems.filter((i) => i.ignored)]; break;
    case 'unfinished': viewItems = unfinishedItems.filter((i) => !i.ignored); break;
  }

  // Case-insensitive title search.
  if (q) {
    const needle = String(q).toLowerCase();
    viewItems = viewItems.filter((i) => i.title && String(i.title).toLowerCase().includes(needle));
  }

  // Sort: watched_at DESC, simkl_id DESC (watched); updated_at DESC (unfinished).
  viewItems.sort((a, b) => {
    if (b._sortMs !== a._sortMs) return b._sortMs - a._sortMs;
    return (b.simkl_id || 0) - (a.simkl_id || 0);
  });

  const total = viewItems.length;
  const pageItems = viewItems.slice((pg - 1) * ps, pg * ps);

  // Lazily enrich ≤ 25 poster/title misses on the page (M11: the enrich seam is
  // injectable, so tests never hit the network).
  const apiKey = D.settings.keyFor(profile, 'tmdb_api_key');
  let misses = 0;
  for (const item of pageItems) {
    if (!item.tmdb_id) continue;
    if (item.poster != null && item.title != null) continue;
    if (misses >= 25) break;
    misses += 1;
    const meta = await D.enrich(apiKey, type, item.tmdb_id, D.log, {});
    if (meta) {
      if (item.poster == null) item.poster = meta.poster;
      if (item.genre == null) item.genre = meta.primary_genre || (meta.genres && meta.genres[0]) || null;
      if (item.title == null) item.title = meta.title;
      if (item.year == null) item.year = meta.year;
    }
  }
  for (const item of pageItems) delete item._sortMs;

  const training = D.tasteFeedback.getTraining(profile.id);
  return {
    items: pageItems,
    page: pg,
    pageSize: ps,
    total,
    counts,
    // rebuild_due_at is T2 (the 10-min debounce); T1 leaves it null.
    training: { changes_since_build: training.changes_since_build, changed_at: training.changed_at, rebuild_due_at: null },
  };
}

// rate — rate a title 1–10 (or null to clear). Simkl is the authority (M1): the
// write happens first; the local row is written only on success.
async function rate(profile, ref, rating, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(ref && ref.type);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
    return { ok: false, reason: 'bad-rating' };
  }
  const row = resolveWatchedRow(profile.id, type, ref, D.watchedStore);
  if (!row) return { ok: false, reason: 'not-in-history' };
  if (!hasSimkl(profile)) return { ok: false, reason: 'no-simkl' };

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
  return { ok: true, item: { type, tmdb_id: row.tmdb_id, imdb_id: row.imdb_id, simkl_id: row.simkl_id, rating, loved: rating === 10 } };
}

// setIgnored — ignore/un-ignore a title (local only — M2: never calls Simkl,
// never touches watched rows). Resolves against watched rows, then unfinished.
async function setIgnored(profile, ref, ignored, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(ref && ref.type);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  const row = resolveWatchedRow(profile.id, type, ref, D.watchedStore);
  let key;
  let simklId = null;
  let imdbId = null;
  if (row) {
    key = String(row.tmdb_id);
    simklId = row.simkl_id;
    imdbId = row.imdb_id;
  } else {
    const un = resolveUnfinishedRow(profile.id, type, ref, D.engagement, D.settings);
    if (!un) return { ok: false, reason: 'not-in-history' };
    key = un.tmdb_id;
  }
  const now = D.now();
  D.tasteFeedback.setIgnored(profile.id, { type, tmdb_id: key, simkl_id: simklId, imdb_id: imdbId }, !!ignored, now);
  D.tasteFeedback.recordChange(profile.id, now);
  D.log.log(`[trainer] ${profile.name}: ${ignored ? 'ignored' : 'un-ignored'} ${type} tmdb:${key}`);
  return { ok: true, item: { type, tmdb_id: key, ignored: !!ignored } };
}

// markFinished — mark an unfinished (abandoned) film finished. Delegates to the
// shared markWatched action (writes Simkl + pins a pending-watched shim).
async function markFinished(profile, ref, deps = {}) {
  const D = mergeDeps(deps);
  const t = resolveType(ref && ref.type);
  if (!t.ok) return { ok: false, reason: t.reason };
  const type = t.type;
  const un = resolveUnfinishedRow(profile.id, type, ref, D.engagement, D.settings);
  if (!un) return { ok: false, reason: 'not-in-history' };
  const res = await D.markWatched(profile, { type, imdbId: ref.imdb_id || null, tmdbId: un.tmdb_id, title: ref.title || null }, D.log);
  if (res && res.ok === false) return { ok: false, reason: res.reason };
  const now = D.now();
  D.tasteFeedback.recordChange(profile.id, now);
  D.log.log(`[trainer] ${profile.name}: marked finished ${type} tmdb:${un.tmdb_id}`);
  return { ok: true, item: { type, tmdb_id: un.tmdb_id, status: 'watched' } };
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
