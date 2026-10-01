// Trainer T4 — the companion Trainer DOM controller.
//
// An IIFE exposing window.trainerView = { open }. It drives the two modes
// (Quick and List) from the session-scoped /mobile/api/trainer* routes, reusing
// the portal's pure helpers from public/trainer-ui.js (served at /mobile/
// trainer-ui.js) — no fork of that logic. The phone never sends a profile id;
// the routes use req.profile (P3).
(function () {
  'use strict';
  const T = window.TrainerUI;
  const comp = window.companion; // { apiFetch, showSnack, hideSnack }
  const esc = T.esc;

  // One state object for the whole view.
  const st = {
    mode: 'quick', // 'quick' | 'list'
    view: 'all', q: '', page: 1, data: null,
    confirmed: new Map(), shown: new Map(),
    rebuilding: false,
    settings: null, // GET /settings (once per session)
    canRate: false, // me.simkl_connected (once)
    canRateFetched: false,
    quick: { items: [], page: 0, handled: new Set(), current: 0, counts: null },
  };

  const queue = T.createRateQueue({
    send: (key, rating) => postRate(key, rating),
    delayMs: 800,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  });
  st.queue = queue;

  const $ = (id) => document.getElementById(id);
  const els = {
    section: $('view-trainer'),
    tabs: document.querySelectorAll('#view-trainer .trainer-tabs .seg'),
    notice: $('trainer-notice'),
    banner: $('trainer-banner'),
    quick: $('trainer-quick'),
    list: $('trainer-list'),
  };

  // ---- API helpers (session-scoped, no profile id) ----
  async function api(path, opts) {
    const res = await comp.apiFetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
    return body;
  }
  async function postRate(key, rating) {
    return api('/trainer/rate', { method: 'POST', body: { type: 'movie', tmdb_id: key, rating } });
  }

  // ---- open() ----
  async function open() {
    if (!st.settings) {
      try { st.settings = await api('/settings'); } catch { st.settings = null; }
    }
    if (!st.canRateFetched) {
      try {
        const me = await api('/me');
        st.canRate = !!(me.profile && me.profile.simkl_connected);
      } catch { st.canRate = false; }
      st.canRateFetched = true;
    }
    loadMode();
    drawNotice();
    drawMode();
  }

  // ---- P8 notice ----
  function drawNotice() {
    if (!st.settings) { els.notice.innerHTML = ''; return; }
    const engineMovie = st.settings.filters && st.settings.filters.engine_movie;
    if (engineMovie === 'marquee') { els.notice.innerHTML = ''; return; }
    const engines = st.settings.engines || {};
    const movieEngines = (engines.available && engines.available.movie) || [];
    const engine = movieEngines.find((e) => e.id === engineMovie);
    const engineName = engine ? engine.name : (engineMovie || 'another engine');
    els.notice.innerHTML = '<div class="tr-notice">Ratings still save to Simkl, but this profile\'s movies come from ' + esc(engineName) + ', so the Trainer won\'t change its recommendations. Switch the Movies engine to Marquee in Filters.</div>';
  }

  // ---- mode switch ----
  function loadMode() {
    try {
      const m = localStorage.getItem('trainer.mode');
      if (m === 'quick' || m === 'list') st.mode = m;
    } catch (_) { /* ignore */ }
  }
  function saveMode() {
    try { localStorage.setItem('trainer.mode', st.mode); } catch (_) { /* ignore */ }
  }
  function drawMode() {
    els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tmode === st.mode));
    if (st.mode === 'quick') {
      els.quick.hidden = false;
      els.list.hidden = true;
      // Quick mode lands in the next step (T4 Step 3); List is live now.
      els.quick.innerHTML = '<span class="muted">Quick mode lands in the next step — use List for now.</span>';
    } else {
      els.quick.hidden = true;
      els.list.hidden = false;
      loadList();
    }
  }

  // ---- List mode ----
  async function loadList() {
    els.list.innerHTML = '<span class="muted">Loading…</span>';
    try {
      const d = await api('/trainer?view=' + st.view + '&q=' + encodeURIComponent(st.q) + '&page=' + st.page + '&page_size=25');
      st.data = d;
      d.items.forEach((item) => {
        if (!st.confirmed.has(item.key)) st.confirmed.set(item.key, item);
        st.shown.set(item.key, item.rating);
      });
      drawList();
    } catch (e) {
      els.list.innerHTML = '<span class="msg err">' + esc(e.message) + '</span>';
    }
  }

  function drawList() {
    const d = st.data;
    if (!d) return;
    const now = Date.now();
    const rows = d.items.length
      ? d.items.map((item) => T.rowHtml(item, { canRate: st.canRate, now })).join('')
      : '<div class="muted">No films in this view yet.</div>';
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    els.list.innerHTML = '<div class="tr-chips">' + T.chipsHtml(d.counts, st.view) + '</div>'
      + '<div class="tr-search-row"><input type="search" class="tr-search" placeholder="Search titles…" value="' + esc(st.q) + '"></div>'
      + '<div class="tr-table">' + rows + '</div>'
      + '<div class="tr-pager">'
      + '<button class="ghost mini" data-act="prev"' + (st.page <= 1 ? ' disabled' : '') + '>Prev</button>'
      + '<span class="muted">' + T.pagerText(d.page, d.pageSize, d.total) + '</span>'
      + '<button class="ghost mini" data-act="next"' + (st.page >= pages ? ' disabled' : '') + '>Next</button>'
      + '</div>';
    els.banner.innerHTML = T.bannerHtml(d.training, now, { rebuilding: st.rebuilding });
    els.list.querySelectorAll('.tr-row').forEach((row) => bindRowStars(row, row.dataset.key));
  }

  // Refresh ONLY the chips + banner (rows stay put).
  async function refreshMeta() {
    if (!st.data) return;
    try {
      const d = await api('/trainer?view=' + st.view + '&q=' + encodeURIComponent(st.q) + '&page=' + st.page + '&page_size=25');
      st.data.counts = d.counts;
      st.data.training = d.training;
      const chips = els.list.querySelector('.tr-chips');
      if (chips) chips.innerHTML = T.chipsHtml(d.counts, st.view);
      els.banner.innerHTML = T.bannerHtml(d.training, Date.now(), { rebuilding: st.rebuilding });
    } catch (e) { /* quiet — leave the rows alone */ }
  }

  function bindList() {
    if (els.list.dataset.bound) return;
    els.list.dataset.bound = '1';
    els.list.addEventListener('click', listClick);
    els.list.addEventListener('input', (e) => {
      if (!e.target.matches('.tr-search')) return;
      const v = e.target.value;
      clearTimeout(els.list._searchT);
      els.list._searchT = setTimeout(() => { st.q = v; st.page = 1; loadList(); }, 300);
    });
  }

  function listClick(e) {
    const chip = e.target.closest('.tr-chip');
    if (chip) {
      st.view = chip.dataset.view;
      st.page = 1;
      loadList();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const rowEl = btn.closest('.tr-row');
    const key = rowEl ? rowEl.dataset.key : null;
    const item = st.data ? st.data.items.find((x) => x.key === key) : null;
    switch (btn.dataset.act) {
      case 'prev':
      case 'next':
        st.page = btn.dataset.act === 'prev' ? st.page - 1 : st.page + 1;
        loadList();
        break;
      case 'star': {
        // Keyboard (Enter/Space) only — e.detail === 0 means no mouse click. A
        // mouse/touch click already committed via the pointer scrub on pointerup.
        if (e.detail !== 0) break;
        rateStar(key, item, Number(btn.dataset.rating));
        break;
      }
      case 'clear':
      case 'love': {
        const shown = st.shown.has(key) ? st.shown.get(key) : (item ? item.rating : null);
        const rating = btn.dataset.act === 'clear' ? null : T.nextRatingForHeart(shown);
        rateStar(key, item, rating);
        break;
      }
      case 'ignore':
        doIgnore(key, item, true);
        break;
      case 'undo':
      case 'unignore':
        doIgnore(key, item, false);
        break;
      case 'unwatch':
        doUnwatch(key, item);
        break;
      case 'finished':
        doFinished(key, item);
        break;
      case 'rebuild':
        doRebuild();
        break;
    }
  }

  // The star path: set the shown rating, optimistically redraw the row, and push
  // the value onto the per-title rate queue. One save per gesture.
  function rateStar(key, item, rating) {
    st.shown.set(key, rating);
    redrawRow(key, { ...item, rating, loved: rating === 10 });
    queue.push(key, rating, (err, result) => rateSettle(key, err, result));
  }

  function redrawRow(key, item) {
    const row = els.list.querySelector('.tr-row[data-key="' + esc(key) + '"]');
    if (!row) return;
    row.outerHTML = T.rowHtml(item, { canRate: st.canRate, now: Date.now() });
    const newRow = els.list.querySelector('.tr-row[data-key="' + esc(key) + '"]');
    if (newRow) bindRowStars(newRow, key);
  }

  function rateSettle(key, err, result) {
    if (queue.pending(key)) {
      if (!err) st.confirmed.set(key, result.item);
      return;
    }
    if (err) {
      const prev = st.confirmed.get(key);
      if (prev) {
        redrawRow(key, prev);
        st.shown.set(key, prev.rating);
      }
      comp.showSnack('Couldn\'t save rating — ' + err.message, null);
      return;
    }
    st.confirmed.set(key, result.item);
    st.shown.set(key, result.item.rating);
    redrawRow(key, result.item);
    if (st.data && !st.data.items.some((item) => queue.pending(item.key))) refreshMeta();
  }

  async function doIgnore(key, item, ignored) {
    try {
      const r = await api('/trainer/ignore', { method: 'POST', body: { type: 'movie', tmdb_id: key, ignored } });
      st.confirmed.set(key, r.item);
      if (ignored) {
        const row = els.list.querySelector('.tr-row[data-key="' + esc(key) + '"]');
        if (row) {
          row.classList.add('tr-dim');
          row.querySelectorAll('.tr-stars button').forEach((b) => { b.disabled = true; });
          const acts = row.querySelector('.tr-acts');
          if (acts) acts.innerHTML = 'Ignored · <button class="ghost mini" data-act="undo">Undo</button>';
        }
        comp.showSnack('Ignored "' + (item.title || '') + '"', () => doIgnore(key, item, false));
      } else {
        redrawRow(key, r.item);
      }
      refreshMeta();
    } catch (err) {
      comp.showSnack("Couldn't ignore — " + err.message, null);
    }
  }

  async function doUnwatch(key, item) {
    if (!item || !confirm('Remove "' + item.title + '" from your Simkl watch history?\n\nUse this if it was marked watched by mistake. It can be recommended to you again.')) return;
    try {
      const r = await api('/trainer/unwatched', { method: 'POST', body: { type: 'movie', tmdb_id: key, imdb_id: item.imdb_id } });
      st.confirmed.set(key, r.item);
      const row = els.list.querySelector('.tr-row[data-key="' + esc(key) + '"]');
      if (row) {
        row.classList.add('tr-dim');
        row.querySelectorAll('.tr-stars button').forEach((b) => { b.disabled = true; });
        const acts = row.querySelector('.tr-acts');
        if (acts) acts.innerHTML = 'Removed from history';
      }
      comp.showSnack('Removed "' + (item.title || '') + '" from your watch history', null);
      refreshMeta();
    } catch (err) {
      comp.showSnack("Couldn't mark unwatched — " + err.message, null);
    }
  }

  async function doFinished(key, item) {
    if (!item || !confirm('Mark this film as watched on Simkl?')) return;
    try {
      await api('/trainer/finished', { method: 'POST', body: { type: 'movie', tmdb_id: key, imdb_id: item.imdb_id } });
      const row = els.list.querySelector('.tr-row[data-key="' + esc(key) + '"]');
      if (row) {
        row.classList.add('tr-dim');
        const acts = row.querySelector('.tr-acts');
        if (acts) acts.innerHTML = 'Marked watched';
      }
      comp.showSnack('Marked "' + (item.title || '') + '" as watched', null);
      refreshMeta();
    } catch (err) {
      comp.showSnack("Couldn't mark finished — " + err.message, null);
    }
  }

  async function doRebuild() {
    st.rebuilding = true;
    els.banner.innerHTML = T.bannerHtml(st.data ? st.data.training : { changes_since_build: 0 }, Date.now(), { rebuilding: true });
    try {
      await api('/trainer/rebuild', { method: 'POST' });
      comp.showSnack('Rebuild started — new picks in a few minutes', null);
      setTimeout(() => { st.rebuilding = false; refreshMeta(); }, 3000);
    } catch (err) {
      st.rebuilding = false;
      comp.showSnack('Rebuild failed: ' + err.message, null);
    }
  }

  // Bind the pointer-event star scrub to one row's .tr-stars group.
  function bindRowStars(row, key) {
    const group = row.querySelector('.tr-stars');
    if (!group) return;
    const item = st.data ? st.data.items.find((x) => x.key === key) : null;
    if (group._scrub) group._scrub();
    group._scrub = T.bindStarScrub(group, {
      getRects: () => [...group.querySelectorAll('.tr-star-wrap')].map((w) => { const r = w.getBoundingClientRect(); return { left: r.left, width: r.width }; }),
      isEnabled: () => {
        if (!st.canRate) return false;
        const cur = st.confirmed.get(key) || item;
        return !!cur && !cur.ignored && cur.status === 'watched';
      },
      onPreview: (r) => {
        const fills = T.fillsForRating(r);
        group.querySelectorAll('.tr-fill').forEach((f, i) => { f.style.width = fills[i]; });
        group.classList.add('tr-previewing');
      },
      onCancel: () => {
        const rating = st.shown.has(key) ? st.shown.get(key) : (item ? item.rating : null);
        const fills = T.fillsForRating(rating);
        group.querySelectorAll('.tr-fill').forEach((f, i) => { f.style.width = fills[i]; });
        group.classList.remove('tr-previewing');
      },
      onCommit: (r) => {
        rateStar(key, item, r);
      },
    });
  }

  // ---- bind once ----
  function bind() {
    if (els.section.dataset.bound) return;
    els.section.dataset.bound = '1';
    els.tabs.forEach((tab) => tab.addEventListener('click', () => {
      st.mode = tab.dataset.tmode;
      saveMode();
      drawMode();
    }));
    bindList();
    els.banner.addEventListener('click', (e) => {
      if (e.target.closest('button[data-act="rebuild"]')) doRebuild();
    });
  }

  bind();
  window.trainerView = { open };
})();
