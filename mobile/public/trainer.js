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
    quick: { items: [], page: 0, handled: new Set(), current: 0, counts: null, training: null, left: 0, counted: new Set(), advanceT: null },
  };

  const queue = T.createRateQueue({
    send: (key, rating, o) => postRate(key, rating, o),
    delayMs: 800,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  });
  st.queue = queue;

  // F1: flush pending ratings when the page is hidden or closing, so a rating
  // made just before leaving the app isn't lost (the 800 ms debounce timer
  // would otherwise never fire).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') queue.flush(); });
  window.addEventListener('pagehide', () => queue.flush());

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
    // K1: JSON-encode an object body (apiFetch passes it to fetch unchanged).
    const res = await comp.apiFetch(path, T.jsonRequest(opts));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
    return body;
  }
  async function postRate(key, rating, o) {
    // F1: pass keepalive through to fetch (apiFetch spreads opts into fetch), so
    // a flush on page-hide can send the rating even as the page closes.
    return api('/trainer/rate', { method: 'POST', body: { type: 'movie', tmdb_id: key, rating }, keepalive: !!(o && o.keepalive) });
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
    const fullText = "Ratings still save to Simkl, but this profile's movies come from " + engineName + ", so the Trainer won't change its recommendations. Switch the Movies engine to Marquee in Filters.";
    // K2.3: in Quick mode the notice is one line with a "More" button; List
    // keeps the full text.
    if (st.mode === 'quick') {
      els.notice.innerHTML = '<div class="tr-notice tr-notice-quick">ⓘ Ratings won\'t change Genesis picks <button class="link" data-tact="notice-more">More</button></div>';
      const btn = els.notice.querySelector('[data-tact="notice-more"]');
      if (btn) btn.addEventListener('click', () => {
        els.notice.innerHTML = '<div class="tr-notice">' + esc(fullText) + '</div>';
      });
    } else {
      els.notice.innerHTML = '<div class="tr-notice">' + esc(fullText) + '</div>';
    }
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
    drawNotice();
    if (st.mode === 'quick') {
      els.quick.hidden = false;
      els.list.hidden = true;
      loadQuick();
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

  // ---- Quick mode (§5.4–5.6) ----
  async function loadQuick() {
    st.quick.items = [];
    st.quick.handled = new Set();
    st.quick.counted = new Set(); // K4: fresh load — the "left" count restarts
    st.quick.current = 0;
    st.quick.page = 0;
    await fetchQuickPages();
    drawQuick();
  }

  // Re-run the page walk from page 1 (the server's unrated view changes as the
  // user rates/ignores). Append new cards (not already in st.quick.items) and
  // stop once we have a new card or exhaust the pages.
  async function fetchQuickPages() {
    let page = 1;
    let gotNew = false;
    while (true) {
      const data = await api('/trainer?view=unrated&page=' + page + '&page_size=50');
      const batch = T.pickQuickBatch(data.items, st.quick.handled);
      for (const item of batch) {
        if (!st.quick.items.some((x) => x.key === item.key)) {
          st.quick.items.push(item);
          gotNew = true;
        }
      }
      st.quick.counts = data.counts;
      st.quick.training = data.training;
      st.quick.left = data.counts ? (data.counts.unrated || 0) : 0;
      if (gotNew) break;
      const totalPages = Math.ceil(data.total / data.pageSize);
      if (page >= totalPages) break;
      page++;
    }
    st.quick.page = page;
  }

  function drawQuick() {
    if (els.section.hidden) return; // view is hidden — tolerate (§5.6)
    // K2.3: in Quick mode the banner is one line (N changes · Rebuild).
    const training = st.quick.training || { changes_since_build: 0 };
    els.banner.innerHTML = '<div class="tr-banner tr-banner-quick">' + (training.changes_since_build || 0) + ' changes · <button class="ghost mini" data-act="rebuild"' + (st.rebuilding ? ' disabled' : '') + '>Rebuild</button></div>';
    const item = st.quick.items[st.quick.current];
    const left = st.quick.left;
    if (!item) {
      els.quick.innerHTML = '<div class="tq-empty">All caught up — everything you\'ve watched is rated or ignored. 🎉<br><button class="ghost" data-tact="review">Review in List</button></div>';
      const btn = els.quick.querySelector('[data-tact="review"]');
      if (btn) btn.addEventListener('click', () => { st.mode = 'list'; saveMode(); drawMode(); });
      return;
    }
    const poster = item.poster
      ? '<img class="tq-poster" src="' + esc(item.poster) + '" alt="">'
      : '<div class="tq-poster tq-noposter"></div>';
    const meta = esc(item.title || '?') + (item.year ? ' <span class="muted">(' + esc(item.year) + ')</span>' : '')
      + '<br><span class="muted">' + esc(item.genre || '—') + ' · ' + T.whenText(item.watched_at, Date.now()) + '</span>';
    const stars = buildStarsHtml(item);
    const shown = st.shown.has(item.key) ? st.shown.get(item.key) : item.rating;
    els.quick.innerHTML = '<div class="tq-left">' + left + ' left to rate</div>'
      + '<div class="tq-card" data-key="' + esc(item.key) + '">'
      + poster
      + '<div class="tq-meta">' + meta + '</div>'
      + stars
      + '<div class="tq-rating-text">' + T.ratingText(shown) + '</div>'
      + '<div class="tq-actions">'
      + '<button class="tq-btn tq-love" data-tact="love" aria-label="Love">♥</button>'
      + '<button class="tq-btn tq-ignore" data-tact="ignore" aria-label="Ignore">Ignore</button>'
      + '<button class="tq-btn tq-skip" data-tact="skip" aria-label="Skip">Skip</button>'
      + '<button class="tq-unwatch" data-tact="unwatch" aria-label="Mark unwatched">Unwatch</button>'
      + '</div>'
      + '<div class="tq-hint">Swipe ← ignore · → skip · ↑ love</div>'
      + '<div class="tq-overlay"></div>'
      + '</div>';
    bindQuickCard(item);
  }

  function buildStarsHtml(item) {
    const levels = T.starsFromRating(item.rating);
    const wraps = [];
    for (let i = 0; i < 5; i++) {
      const lv = levels[i];
      const fillPct = lv === 1 ? '100%' : (lv === 0.5 ? '50%' : '0%');
      const halfBtn = (half) => {
        const rating = T.ratingFromStarClick(i, half);
        const disabled = !st.canRate || item.ignored;
        return '<button class="tr-star" data-tact="star" data-half="' + half + '" data-rating="' + rating + '" aria-label="Rate ' + rating + ' out of 10"' + (disabled ? ' disabled' : '') + '></button>';
      };
      wraps.push('<span class="tr-star-wrap"><span class="tr-glyph" aria-hidden="true">★</span><span class="tr-fill" aria-hidden="true" style="width:' + fillPct + '">★</span>' + halfBtn('left') + halfBtn('right') + '</span>');
    }
    return '<span class="tr-stars" role="group" aria-label="Your rating">' + wraps.join('') + '</span>';
  }

  function bindQuickCard(item) {
    const card = els.quick.querySelector('.tq-card');
    if (!card) return;
    const group = card.querySelector('.tr-stars');
    if (group) {
      if (group._scrub) group._scrub();
      group._scrub = T.bindStarScrub(group, {
        getRects: () => [...group.querySelectorAll('.tr-star-wrap')].map((w) => { const r = w.getBoundingClientRect(); return { left: r.left, width: r.width }; }),
        isEnabled: () => {
          const cur = st.confirmed.get(item.key) || item;
          return st.canRate && !!cur && !cur.ignored && cur.status === 'watched';
        },
        onPreview: (r) => {
          const fills = T.fillsForRating(r);
          group.querySelectorAll('.tr-fill').forEach((f, i) => { f.style.width = fills[i]; });
          group.classList.add('tr-previewing');
          const rt = card.querySelector('.tq-rating-text'); // K6: rating text follows the scrub preview
          if (rt) rt.textContent = T.ratingText(r);
        },
        onCancel: () => {
          const rating = st.shown.has(item.key) ? st.shown.get(item.key) : item.rating;
          const fills = T.fillsForRating(rating);
          group.querySelectorAll('.tr-fill').forEach((f, i) => { f.style.width = fills[i]; });
          group.classList.remove('tr-previewing');
          const rt = card.querySelector('.tq-rating-text'); // K6: restore the shown value
          if (rt) rt.textContent = T.ratingText(rating);
        },
        onCommit: (r) => {
          quickRate(item, r);
        },
      });
    }
    // Buttons (every action has a button — keyboard/desktop).
    card.querySelectorAll('[data-tact]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.tact === 'star') {
          // Keyboard only (e.detail === 0). Mouse/touch already committed via the scrub.
          if (e.detail !== 0) return;
          quickRate(item, Number(btn.dataset.rating));
          return;
        }
        quickAction(item, btn.dataset.tact);
      });
    });
    bindSwipe(card, item);
  }

  function quickRate(item, rating) {
    st.shown.set(item.key, rating);
    st.confirmed.set(item.key, { ...item, rating, loved: rating === 10 });
    updateQuickStars(item, rating);
    st.quick.handled.add(item.key);
    queue.push(item.key, rating, (err, result) => quickRateSettle(item, err, result));
    decrementLeft(item.key); // K4: once per card, not on a re-rate
    // K3: one pending advance — a re-rate within 600 ms replaces the timer.
    clearTimeout(st.quick.advanceT);
    st.quick.advanceT = setTimeout(() => advanceFrom(item.key), 600);
  }

  function updateQuickStars(item, rating) {
    const card = els.quick.querySelector('.tq-card');
    if (!card) return;
    const group = card.querySelector('.tr-stars');
    if (group) {
      const fills = T.fillsForRating(rating);
      group.querySelectorAll('.tr-fill').forEach((f, i) => { f.style.width = fills[i]; });
    }
    const rt = card.querySelector('.tq-rating-text');
    if (rt) rt.textContent = T.ratingText(rating);
  }

  function quickRateSettle(item, err, result) {
    if (err) {
      comp.showSnack('Couldn\'t save rating for "' + (item.title || '') + '" — ' + err.message, () => {
        // Retry: push the same value again.
        queue.push(item.key, st.shown.get(item.key), (e2, r2) => quickRateSettle(item, e2, r2));
      });
      return;
    }
    st.confirmed.set(item.key, result.item);
    st.shown.set(item.key, result.item.rating);
  }

  // K4: the "N left to rate" count. Decrement once per card on the first rate /
  // Love / Ignore / Unwatch (not Skip, not a re-rate); increment on Undo of an
  // ignore. Redraw .tq-left immediately.
  function decrementLeft(key) {
    if (st.quick.counted.has(key)) return;
    st.quick.counted.add(key);
    st.quick.left = Math.max(0, st.quick.left - 1);
    const el = els.quick.querySelector('.tq-left');
    if (el) el.textContent = st.quick.left + ' left to rate';
  }
  function incrementLeft(key) {
    if (!st.quick.counted.has(key)) return;
    st.quick.counted.delete(key);
    st.quick.left += 1;
    const el = els.quick.querySelector('.tq-left');
    if (el) el.textContent = st.quick.left + ' left to rate';
  }

  // K3: only advance if the current card is still the one that triggered it.
  function advanceFrom(key) {
    const current = st.quick.items[st.quick.current];
    if (!current || !T.shouldAdvance(current.key, key)) return;
    advanceQuick();
  }

  async function quickAction(item, act) {
    switch (act) {
      case 'love':
        quickRate(item, 10);
        break;
      case 'ignore':
        doQuickIgnore(item);
        break;
      case 'skip':
        clearTimeout(st.quick.advanceT); // K3: clear any pending advance
        st.quick.handled.add(item.key);
        advanceQuick();
        break;
      case 'unwatch':
        doQuickUnwatch(item);
        break;
    }
  }

  async function doQuickIgnore(item) {
    try {
      const r = await api('/trainer/ignore', { method: 'POST', body: { type: 'movie', tmdb_id: item.key, ignored: true } });
      st.confirmed.set(item.key, r.item);
      st.quick.handled.add(item.key);
      decrementLeft(item.key); // K4
      clearTimeout(st.quick.advanceT); // K3
      advanceQuick();
      comp.showSnack('Ignored "' + (item.title || '') + '"', () => {
        (async () => {
          try {
            const r2 = await api('/trainer/ignore', { method: 'POST', body: { type: 'movie', tmdb_id: item.key, ignored: false } });
            st.confirmed.set(item.key, r2.item);
            st.quick.handled.delete(item.key);
            incrementLeft(item.key); // K4: Undo of an ignore
            const idx = st.quick.items.findIndex((x) => x.key === item.key);
            if (idx !== -1) { st.quick.current = idx; drawQuick(); }
          } catch (err) { comp.showSnack("Couldn't undo — " + err.message, null); }
        })();
      });
    } catch (err) {
      comp.showSnack("Couldn't ignore — " + err.message, null);
    }
  }

  async function doQuickUnwatch(item) {
    if (!confirm('Remove "' + item.title + '" from your Simkl watch history?\n\nUse this if it was marked watched by mistake. It can be recommended to you again.')) return;
    try {
      const r = await api('/trainer/unwatched', { method: 'POST', body: { type: 'movie', tmdb_id: item.key, imdb_id: item.imdb_id } });
      st.confirmed.set(item.key, r.item);
      st.quick.handled.add(item.key);
      decrementLeft(item.key); // K4
      clearTimeout(st.quick.advanceT); // K3
      advanceQuick();
      comp.showSnack('Removed "' + item.title + '" from your watch history', null);
    } catch (err) {
      comp.showSnack("Couldn't mark unwatched — " + err.message, null);
    }
  }

  async function advanceQuick() {
    st.quick.current++;
    if (st.quick.current >= st.quick.items.length) {
      await fetchQuickPages();
    }
    drawQuick();
    // Prefetch in the background if fewer than 5 cards remain.
    const remaining = st.quick.items.length - st.quick.current;
    if (remaining < 5) fetchQuickPages();
  }

  // Card swipe: left = Ignore, right = Skip, up = Love. Never starts on the star
  // group or a button (P5).
  function bindSwipe(card, item) {
    let dragging = false, startX = 0, startY = 0, w = 0, h = 0;
    const overlayOf = () => card.querySelector('.tq-overlay');
    const resetOverlay = () => {
      const overlay = overlayOf();
      if (overlay) { overlay.style.opacity = '0'; overlay.className = 'tq-overlay'; }
    };
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tr-stars, button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      w = card.offsetWidth; h = card.offsetHeight;
      try { card.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    card.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const o = T.cardSwipeOutcome(dx, dy, w, h);
      card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (dx / 20) + 'deg)';
      const overlay = overlayOf();
      if (overlay) {
        overlay.textContent = o.label;
        overlay.style.opacity = String(o.progress);
        // Colour follows the direction: green Skip, red Ignore, pink Love.
        const col = o.label === 'Skip' ? 'skip' : (o.label === 'Ignore' ? 'ignore' : (o.label ? 'love' : ''));
        overlay.className = col ? 'tq-overlay tq-' + col : 'tq-overlay';
      }
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const o = T.cardSwipeOutcome(dx, dy, w, h);
      if (o.action !== 'none') {
        const tx = o.action === 'skip' ? 300 : (o.action === 'ignore' ? -300 : 0);
        const ty = o.action === 'love' ? -300 : 0;
        card.style.transition = 'transform 200ms';
        card.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
        setTimeout(() => {
          card.style.transform = '';
          card.style.transition = '';
          quickAction(item, o.action);
        }, 200);
      } else {
        card.style.transition = 'transform 200ms';
        card.style.transform = '';
        resetOverlay();
        setTimeout(() => { card.style.transition = ''; }, 200);
      }
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', () => {
      if (!dragging) return;
      dragging = false;
      card.style.transition = 'transform 200ms';
      card.style.transform = '';
      resetOverlay();
      setTimeout(() => { card.style.transition = ''; }, 200);
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
