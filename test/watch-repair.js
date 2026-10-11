// WD-2 — Fix watch dates (repair of pre-7.55.1 "watched today" marks).
// Plain Node assert, injected fakes, no network. The fake Simkl mirrors the
// behaviour measured live on 2026-10-12: removing a title from history also
// deletes its rating, and a dated re-add does not restore it.
process.env.DATA_DIR = require('os').tmpdir() + '/ai-rec-wd2-test-' + Date.now();
process.env.PORT = '7314';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-do-not-use-in-prod';
process.env.EXTERNAL_URL = '';

const assert = require('assert');
const asyncPending = [];
function okAsync(name, fn) { asyncPending.push({ name, fn }); }

const watchedStore = require('../src/watchedStore');
const tasteFeedback = require('../src/tasteFeedback');
const wr = require('../src/watchRepair');
const db = require('../src/db');

const NOW = Date.parse('2026-10-12T00:00:00Z');
const iso = (d) => new Date(d).toISOString();
const daysAgo = (n) => iso(NOW - n * 86400000);
const profile = (id) => ({ id, name: id, keys: { tmdb_api_key: 'k', simkl_client_id: 'c' }, simkl_auth: { access_token: 't' } });

let seq = 100;
function addMovie(pid, { imdb, tmdb, title, watchedAt, year = 2000 }) {
  watchedStore.upsertMany(pid, [{ simkl_id: ++seq, type: 'movie', imdb_id: imdb, tmdb_id: String(tmdb), title, year, watched_at: watchedAt }]);
}

// Fake Simkl with the measured semantics. `fail` flags inject errors.
function fakeSimkl(init = {}) {
  const hist = new Map(Object.entries(init.history || {}));
  const rate = new Map(Object.entries(init.ratings || {}));
  const s = { calls: [], fail: {}, hist, rate };
  const key = (it) => it.imdb_id || it.ids?.imdb;
  s.removeFromHistory = async (_p, items) => {
    s.calls.push(['remove', key(items[0])]);
    if (s.fail.remove) throw new Error('remove boom');
    hist.delete(key(items[0])); rate.delete(key(items[0]));
  };
  s.addToHistory = async (_p, body) => {
    const m = body.movies[0];
    s.calls.push(['add', m.ids.imdb, m.watched_at]);
    if (s.fail.addOnce && !s.fail.addDone) { s.fail.addDone = true; throw new Error('add boom'); }
    if (s.fail.addAlways) throw new Error('add boom');
    hist.set(m.ids.imdb, m.watched_at);
  };
  s.setRatings = async (_p, items) => {
    s.calls.push(['rate', key(items[0]), items[0].rating]);
    if (s.fail.rate) return;                      // silently does not stick
    rate.set(key(items[0]), items[0].rating);
  };
  s.getRatings = async () => { s.calls.push(['getRatings']); if (s.fail.getRatings) throw new Error('ratings boom'); return [...rate].map(([imdb_id, rating]) => ({ imdb_id, tmdb_id: null, rating })); };
  s.getAllItems = async () => [...hist].map(([imdb, w]) => ({ movie: { ids: { imdb } }, last_watched_at: s.fail.skewDate ? '2000-01-01T00:00:00Z' : w }));
  return s;
}
const deps = (simkl, dates = {}) => ({
  simkl, now: () => NOW, log: { log() {}, warn() {} },
  fetchDate: async (_k, _t, ids) => ({ date: dates[ids.imdbId] ?? null, year: null }),
});

// W1 — preview filters
okAsync('W1: candidates keep only recent, much-older-release, non-scrobbled movies; attach rating', async () => {
  const pid = 'w1'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt1', tmdb: 11, title: 'Marked A', watchedAt: daysAgo(2) });        // keep
  addMovie(pid, { imdb: 'tt2', tmdb: 12, title: 'Too old watch', watchedAt: daysAgo(200) });  // outside 90d window
  addMovie(pid, { imdb: 'tt3', tmdb: 13, title: 'Scrobbled', watchedAt: daysAgo(3) });        // real watch
  addMovie(pid, { imdb: 'tt4', tmdb: 14, title: 'Watched at release', watchedAt: daysAgo(3) }); // release 4d earlier: plausible
  addMovie(pid, { imdb: 'tt5', tmdb: 15, title: 'Already dated', watchedAt: '2001-05-05T00:00:00.000Z' });
  addMovie(pid, { imdb: 'tt6', tmdb: 16, title: 'No TMDB date', watchedAt: daysAgo(4) });
  addMovie(pid, { imdb: 'tt7', tmdb: 17, title: 'Rated one', watchedAt: daysAgo(5) });       // keep, rated 8
  watchedStore.recordPushedMovies(pid, ['tt3']);
  tasteFeedback.upsertRating(pid, { type: 'movie', tmdb_id: 17, imdb_id: 'tt7', rating: 8, rated_at: daysAgo(5) });
  const dates = { tt1: '1999-03-31', tt2: '1990-01-01', tt3: '1990-01-01', tt4: iso(NOW - 7 * 86400000 + 86400000).slice(0, 10), tt5: '2001-05-05', tt7: '2010-07-16' };
  const r = await wr.findCandidates(p, { days: 90 }, deps(fakeSimkl(), dates));
  assert.deepStrictEqual(r.rows.map((x) => x.title).sort(), ['Marked A', 'Rated one']);
  assert.strictEqual(r.skipped_scrobbled, 1);
  const a = r.rows.find((x) => x.title === 'Marked A');
  assert.strictEqual(a.proposed, '1999-03-31T00:00:00.000Z');
  assert.strictEqual(a.rating, null);
  assert.strictEqual(r.rows.find((x) => x.title === 'Rated one').rating, 8);
});

okAsync('W2: an unreleased title and a future release are never candidates; days is clamped to 1..365', async () => {
  const pid = 'w2'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt20', tmdb: 20, title: 'Future', watchedAt: daysAgo(1) });
  const r = await wr.findCandidates(p, { days: 99999 }, deps(fakeSimkl(), { tt20: '2027-01-01' }));
  assert.strictEqual(r.rows.length, 0);
  assert.strictEqual(r.days, 365);
});

// W3 — unrated happy path
okAsync('W3: apply (unrated) = remove then dated add, no rating call; local date + log row updated', async () => {
  const pid = 'w3'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt30', tmdb: 30, title: 'Plain', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt30: daysAgo(2) } });
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt30', tmdb_id: '30' }], deps(sk, { tt30: '1994-09-23' }));
  assert.strictEqual(r.results[0].status, 'done');
  assert.strictEqual(r.results[0].new, '1994-09-23T00:00:00.000Z');
  const verbs = sk.calls.map((c) => c[0]);
  assert.deepStrictEqual(verbs.filter((v) => v === 'remove' || v === 'add' || v === 'rate'), ['remove', 'add']);
  assert.ok(verbs.indexOf('remove') < verbs.indexOf('add'));
  assert.strictEqual(sk.hist.get('tt30'), '1994-09-23T00:00:00.000Z');
  assert.strictEqual(watchedStore.getWatched(pid, { type: 'movie' })[0].watched_at, '1994-09-23T00:00:00.000Z');
  const log = wr.listLog(pid);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].status, 'done');
  assert.strictEqual(log[0].old_watched_at, daysAgo(2));
});

// W4 — the rating must survive (the live finding)
okAsync('W4: apply (rated 7) re-applies the rating after the re-add and Simkl ends with 7', async () => {
  const pid = 'w4'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt40', tmdb: 40, title: 'Rated', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt40: daysAgo(2) }, ratings: { tt40: 7 } });
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt40', tmdb_id: '40' }], deps(sk, { tt40: '2010-07-16' }));
  assert.strictEqual(r.results[0].status, 'done');
  assert.strictEqual(r.results[0].rating, 7);
  const verbs = sk.calls.filter((c) => ['remove', 'add', 'rate'].includes(c[0])).map((c) => c[0]);
  assert.deepStrictEqual(verbs, ['remove', 'add', 'rate']);
  assert.strictEqual(sk.rate.get('tt40'), 7);
  assert.strictEqual(tasteFeedback.getRating(pid, 'movie', 40), 7);
  assert.strictEqual(wr.listLog(pid)[0].rating, 7);
});

okAsync('W5: a rating that will not stick is retried once, then reported rating_lost (not silently done)', async () => {
  const pid = 'w5'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt50', tmdb: 50, title: 'Stubborn', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt50: daysAgo(2) }, ratings: { tt50: 9 } });
  sk.fail.rate = true;
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt50', tmdb_id: '50' }], deps(sk, { tt50: '2001-01-01' }));
  assert.strictEqual(r.results[0].status, 'rating_lost');
  assert.strictEqual(sk.calls.filter((c) => c[0] === 'rate').length, 2, 'initial set + exactly one retry');
  assert.strictEqual(wr.listLog(pid)[0].status, 'rating_lost');
});

okAsync('W6: Simkl showing a different date after the add is reported date_mismatch, local date NOT changed', async () => {
  const pid = 'w6'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt60', tmdb: 60, title: 'Skewed', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt60: daysAgo(2) } });
  sk.fail.skewDate = true;
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt60', tmdb_id: '60' }], deps(sk, { tt60: '2001-01-01' }));
  assert.strictEqual(r.results[0].status, 'date_mismatch');
  assert.strictEqual(watchedStore.getWatched(pid, { type: 'movie' })[0].watched_at, daysAgo(2));
});

// W7/W8 — failure safety
okAsync('W7: remove fails -> nothing else is called for that title, status failed, local unchanged', async () => {
  const pid = 'w7'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt70', tmdb: 70, title: 'NoRemove', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt70: daysAgo(2) }, ratings: { tt70: 5 } });
  sk.fail.remove = true;
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt70', tmdb_id: '70' }], deps(sk, { tt70: '2001-01-01' }));
  assert.strictEqual(r.results[0].status, 'failed');
  assert.deepStrictEqual(sk.calls.filter((c) => c[0] === 'add' || c[0] === 'rate'), []);
  assert.strictEqual(sk.hist.get('tt70'), daysAgo(2));
  assert.strictEqual(watchedStore.getWatched(pid, { type: 'movie' })[0].watched_at, daysAgo(2));
});

okAsync('W8: add fails after the remove -> the ORIGINAL date and rating are restored; status failed', async () => {
  const pid = 'w8'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt80', tmdb: 80, title: 'AddFails', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt80: daysAgo(2) }, ratings: { tt80: 6 } });
  sk.fail.addOnce = true;
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt80', tmdb_id: '80' }], deps(sk, { tt80: '2001-01-01' }));
  assert.strictEqual(r.results[0].status, 'failed');
  assert.ok(/original date restored/.test(r.results[0].detail), r.results[0].detail);
  assert.strictEqual(sk.hist.get('tt80'), daysAgo(2), 'Simkl is back on the old date');
  assert.strictEqual(sk.rate.get('tt80'), 6, 'and the rating is back');
  assert.strictEqual(watchedStore.getWatched(pid, { type: 'movie' })[0].watched_at, daysAgo(2));
});

okAsync('W9: if the ratings read fails up front, NOTHING is changed (aborts before any write)', async () => {
  const pid = 'w9'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt90', tmdb: 90, title: 'Untouched', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt90: daysAgo(2) }, ratings: { tt90: 4 } });
  sk.fail.getRatings = true;
  await assert.rejects(() => wr.applyRepair(p, [{ imdb_id: 'tt90', tmdb_id: '90' }], deps(sk, { tt90: '2001-01-01' })), /ratings boom/);
  assert.deepStrictEqual(sk.calls.filter((c) => c[0] !== 'getRatings'), []);
  assert.strictEqual(wr.listLog(pid).length, 0);
});

// W10 — skips and guards
okAsync('W10: scrobbled, unknown and no-change titles are skipped with a reason and never touch Simkl', async () => {
  const pid = 'w10'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt100', tmdb: 101, title: 'Scrobbled', watchedAt: daysAgo(2) });
  addMovie(pid, { imdb: 'tt102', tmdb: 102, title: 'RecentRelease', watchedAt: daysAgo(2) });
  watchedStore.recordPushedMovies(pid, ['tt100']);
  const sk = fakeSimkl();
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt100', tmdb_id: '101' }, { imdb_id: 'ttZZZ', tmdb_id: '999' }, { imdb_id: 'tt102', tmdb_id: '102' }],
    deps(sk, { tt100: '1990-01-01', tt102: daysAgo(3).slice(0, 10) }));
  assert.deepStrictEqual(r.results.map((x) => x.status), ['skipped', 'skipped', 'skipped']);
  assert.ok(/scrobbled/.test(r.results[0].detail));
  assert.strictEqual(r.results[1].detail, 'not-found');
  assert.strictEqual(r.results[2].detail, 'no-change-needed');
  assert.deepStrictEqual(sk.calls.filter((c) => c[0] !== 'getRatings'), []);
});

okAsync('W11: more than MAX_APPLY titles, an empty list, and a concurrent run are rejected', async () => {
  const p = profile('w11');
  const sk = fakeSimkl();
  const many = Array.from({ length: wr.MAX_APPLY + 1 }, (_, i) => ({ imdb_id: `tt${i}`, tmdb_id: String(i) }));
  assert.strictEqual((await wr.applyRepair(p, many, deps(sk))).error, 'too-many');
  assert.strictEqual((await wr.applyRepair(p, [], deps(sk))).error, 'nothing-selected');
  addMovie('w11', { imdb: 'tt110', tmdb: 110, title: 'Slow', watchedAt: daysAgo(2) });
  let release; const gate = new Promise((res) => { release = res; });
  const slow = fakeSimkl({ history: { tt110: daysAgo(2) } });
  const orig = slow.removeFromHistory;
  slow.removeFromHistory = async (...a) => { await gate; return orig(...a); };
  const first = wr.applyRepair(p, [{ imdb_id: 'tt110', tmdb_id: '110' }], deps(slow, { tt110: '2001-01-01' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual((await wr.applyRepair(p, [{ imdb_id: 'tt110', tmdb_id: '110' }], deps(slow, { tt110: '2001-01-01' }))).error, 'busy');
  release(); await first;
});

// W12 — undo
okAsync('W12: undo puts the old date and the rating back; a second undo is a no-op', async () => {
  const pid = 'w12'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt120', tmdb: 120, title: 'Undoable', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt120: daysAgo(2) }, ratings: { tt120: 8 } });
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt120', tmdb_id: '120' }], deps(sk, { tt120: '2005-05-05' }));
  assert.strictEqual(sk.hist.get('tt120'), '2005-05-05T00:00:00.000Z');
  const u = await wr.undoBatch(p, r.batch, deps(sk));
  assert.strictEqual(u.results[0].status, 'undone');
  assert.strictEqual(sk.hist.get('tt120'), daysAgo(2));
  assert.strictEqual(sk.rate.get('tt120'), 8);
  assert.strictEqual(watchedStore.getWatched(pid, { type: 'movie' })[0].watched_at, daysAgo(2));
  assert.strictEqual(wr.listLog(pid)[0].status, 'undone');
  assert.strictEqual((await wr.undoBatch(p, r.batch, deps(sk))).error, 'nothing-to-undo');
});

okAsync('W13: undo keeps a rating the user changed after the repair (current Simkl rating wins)', async () => {
  const pid = 'w13'; const p = profile(pid);
  addMovie(pid, { imdb: 'tt130', tmdb: 130, title: 'Rerated', watchedAt: daysAgo(2) });
  const sk = fakeSimkl({ history: { tt130: daysAgo(2) }, ratings: { tt130: 3 } });
  const r = await wr.applyRepair(p, [{ imdb_id: 'tt130', tmdb_id: '130' }], deps(sk, { tt130: '2005-05-05' }));
  sk.rate.set('tt130', 9);                                   // user re-rates afterwards
  await wr.undoBatch(p, r.batch, deps(sk));
  assert.strictEqual(sk.rate.get('tt130'), 9);
});

// W14 — HTTP routes (the real portal router on a bare express app)
okAsync('W14: routes — 404 unknown profile, 400 no Simkl, 400 empty apply, 200 log; undo needs a batch', async () => {
  const express = require('express');
  const config = require('../src/config');
  const portal = require('../src/portal');
  const prof = config.addProfile('Repairer');
  const app = express(); app.use(express.json()); app.use(portal.router);
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (path, opts) => { const r = await fetch(base + path, opts); return { status: r.status, body: await r.json() }; };
  const post = (path, body) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.strictEqual((await j('/profiles/nope/watch-repair/candidates')).status, 404);
    assert.strictEqual((await j(`/profiles/${prof.id}/watch-repair/candidates`)).status, 400);   // Simkl not connected
    assert.strictEqual((await post(`/profiles/${prof.id}/watch-repair/apply`, { items: [] })).status, 400);
    assert.strictEqual((await post(`/profiles/${prof.id}/watch-repair/undo`, { batch: 'x' })).status, 400);
    const log = await j(`/profiles/${prof.id}/watch-repair/log`);
    assert.strictEqual(log.status, 200);
    assert.deepStrictEqual(log.body.rows, []);
  } finally { server.close(); }
});

(async () => {
  let passed = 0;
  for (const t of asyncPending) {
    try { await t.fn(); passed++; console.log(` ✓ ${t.name}`); }
    catch (e) { console.error(` ✗ ${t.name}\n   ${e.stack}`); process.exitCode = 1; }
  }
  try { db.close(); } catch { /* ignore */ }
  console.log(process.exitCode ? `\n${passed}/${asyncPending.length} passed` : `\n${passed} tests passed`);
  process.exit(process.exitCode || 0);
})();
