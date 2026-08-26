// Mobile Companion SPA wiring. Pure routing/view logic lives in ui.js; this file
// is the DOM + fetch glue (exercised in the e2e/browser pass, not the unit tests).
(function () {
  'use strict';
  const API = '/mobile/api';
  const state = { authed: false, profile: null, pendingEmail: '' };

  const $ = (id) => document.getElementById(id);
  const els = {
    login: $('view-login'), shell: $('shell'),
    emailStep: $('login-email-step'), codeStep: $('login-code-step'),
    email: $('email'), code: $('code'),
    send: $('send-code'), verify: $('verify-code'), back: $('back-to-email'),
    logout: $('logout'), profileName: $('profile-name'), msg: $('login-msg'),
    content: $('content'),
  };

  async function apiFetch(path, opts = {}) {
    return fetch(API + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
  }
  const setMsg = (text, kind) => { els.msg.textContent = text || ''; els.msg.className = 'msg' + (kind ? ' ' + kind : ''); };

  // ---- render ----
  function render() {
    const route = window.ui.parseRoute(location.hash).view;
    const view = window.ui.viewForState({ authed: state.authed, route });
    els.login.hidden = view !== 'login';
    els.shell.hidden = view === 'login';
    if (view === 'login') return;
    els.profileName.textContent = state.profile ? state.profile.name : '';
    els.content.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.route === view));
    if (view === 'recs') loadRecs();
  }

  // ---- login flow ----
  function showEmailStep() { els.emailStep.hidden = false; els.codeStep.hidden = true; setMsg(''); }
  function showCodeStep() { els.emailStep.hidden = true; els.codeStep.hidden = false; els.code.value = ''; els.code.focus(); }

  els.send.addEventListener('click', async () => {
    const email = els.email.value.trim();
    if (!email) return setMsg('Enter your email.', 'err');
    els.send.disabled = true; setMsg('Sending…');
    try {
      await apiFetch('/auth/request', { method: 'POST', body: JSON.stringify({ email }) });
      state.pendingEmail = email;
      showCodeStep();
      setMsg('If that email is registered, a 6-digit code is on its way. It expires in 1 hour.', 'ok');
    } catch { setMsg('Something went wrong — try again.', 'err'); }
    finally { els.send.disabled = false; }
  });

  els.verify.addEventListener('click', async () => {
    const code = els.code.value.trim();
    if (!code) return setMsg('Enter the code from your email.', 'err');
    els.verify.disabled = true; setMsg('Verifying…');
    try {
      const res = await apiFetch('/auth/verify', { method: 'POST', body: JSON.stringify({ email: state.pendingEmail, code }) });
      if (!res.ok) { setMsg('That code is invalid or expired.', 'err'); return; }
      const data = await res.json();
      state.authed = true; state.profile = data.profile;
      if (location.hash === '#/login' || !location.hash) location.hash = '#/recs';
      render();
    } catch { setMsg('Something went wrong — try again.', 'err'); }
    finally { els.verify.disabled = false; }
  });

  els.back.addEventListener('click', () => { state.pendingEmail = ''; showEmailStep(); els.email.focus(); });
  els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.verify.click(); });
  els.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.send.click(); });

  els.logout.addEventListener('click', async () => {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.authed = false; state.profile = null; state.pendingEmail = '';
    recs.loaded = false; recs.cache = { movie: [], series: [] }; hideSnack();
    showEmailStep();
    location.hash = '#/login';
    render();
  });

  // ---- nav ----
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => { location.hash = '#/' + t.dataset.route; });
  });
  window.addEventListener('hashchange', render);

  // ---- search (Step 3) ----
  const search = { type: 'movie', results: [], timer: null };
  const sEls = {
    input: $('search-input'), msg: $('search-msg'), results: $('search-results'),
    segs: document.querySelectorAll('.seg'),
    sheet: $('detail-sheet'), poster: $('sheet-poster'), title: $('sheet-title'),
    meta: $('sheet-meta'), syn: $('sheet-synopsis'), add: $('sheet-add'), addMsg: $('sheet-add-msg'),
  };
  const setSearchMsg = (t, kind) => { sEls.msg.textContent = t || ''; sEls.msg.className = 'msg' + (kind ? ' ' + kind : ''); };
  const setAddMsg = (t, kind) => { sEls.addMsg.textContent = t || ''; sEls.addMsg.className = 'msg' + (kind ? ' ' + kind : ''); };

  async function runSearch() {
    const q = sEls.input.value.trim();
    search.results = []; sEls.results.innerHTML = '';
    if (q.length < 2) { setSearchMsg(''); return; }
    setSearchMsg('Searching…');
    try {
      const res = await apiFetch('/search?q=' + encodeURIComponent(q) + '&type=' + search.type);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSearchMsg(data.error || 'Search failed.', 'err'); return; }
      search.results = data.results || [];
      if (!search.results.length) { setSearchMsg('No results.'); return; }
      setSearchMsg(''); renderResults(search.results);
    } catch { setSearchMsg('Search failed — try again.', 'err'); }
  }

  function renderResults(results) {
    const frag = document.createDocumentFragment();
    results.forEach((r, i) => {
      const card = document.createElement('button');
      card.className = 'result'; card.type = 'button';
      const img = document.createElement('img');
      img.className = 'result-poster'; img.loading = 'lazy'; img.alt = '';
      if (r.poster) img.src = r.poster; else img.classList.add('no-poster');
      const meta = document.createElement('div'); meta.className = 'result-meta';
      const h = document.createElement('div'); h.className = 'result-title'; h.textContent = r.title || 'Untitled';
      const sub = document.createElement('div'); sub.className = 'result-sub';
      sub.textContent = [r.year || '', r.rating ? '★ ' + r.rating : ''].filter(Boolean).join(' · ');
      meta.appendChild(h); meta.appendChild(sub);
      card.appendChild(img); card.appendChild(meta);
      card.addEventListener('click', () => openSheet(i));
      frag.appendChild(card);
    });
    sEls.results.appendChild(frag);
  }

  function openSheet(index) {
    const r = search.results[index];
    if (!r) return;
    sEls.sheet.dataset.index = String(index);
    if (r.poster) { sEls.poster.src = r.poster; sEls.poster.style.visibility = 'visible'; }
    else { sEls.poster.removeAttribute('src'); sEls.poster.style.visibility = 'hidden'; }
    sEls.title.textContent = r.title || 'Untitled';
    sEls.meta.textContent = [r.type === 'series' ? 'Show' : 'Movie', r.year || '', r.rating ? '★ ' + r.rating : ''].filter(Boolean).join(' · ');
    sEls.syn.textContent = r.synopsis || 'No synopsis available.';
    sEls.add.disabled = false; sEls.add.textContent = '➕ Add to watchlist';
    setAddMsg('');
    sEls.sheet.hidden = false;
  }
  const closeSheet = () => { sEls.sheet.hidden = true; };

  async function addToWatchlist() {
    const r = search.results[parseInt(sEls.sheet.dataset.index, 10)];
    if (!r) return;
    sEls.add.disabled = true; setAddMsg('Adding…');
    try {
      const res = await apiFetch('/watchlist', {
        method: 'POST',
        body: JSON.stringify({ type: r.type, imdb_id: r.id, tmdb_id: r.tmdb_id, title: r.title, year: r.year }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setAddMsg(data.error || 'Could not add.', 'err'); sEls.add.disabled = false; return; }
      sEls.add.textContent = '✓ Added to watchlist';
      setAddMsg('Added to your Simkl Watch Later.', 'ok');
    } catch { setAddMsg('Could not add — try again.', 'err'); sEls.add.disabled = false; }
  }

  sEls.input.addEventListener('input', () => { clearTimeout(search.timer); search.timer = setTimeout(runSearch, 300); });
  sEls.segs.forEach((seg) => seg.addEventListener('click', () => {
    search.type = seg.dataset.stype;
    sEls.segs.forEach((s) => s.classList.toggle('active', s === seg));
    sEls.input.placeholder = search.type === 'series' ? 'Search shows…' : 'Search movies…';
    runSearch();
  }));
  sEls.add.addEventListener('click', addToWatchlist);
  sEls.sheet.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeSheet));

  // ---- recommendations (Step 4) ----
  const recs = { type: 'movie', cache: { movie: [], series: [] }, loaded: false, undo: null, snackTimer: null };
  const rEls = {
    segs: document.querySelectorAll('#recs-tabs .seg'),
    list: $('recs-list'), msg: $('recs-msg'), hint: $('recs-hint'),
    badgeMovie: $('badge-movie'), badgeSeries: $('badge-series'),
    snackbar: $('snackbar'), snackText: $('snackbar-text'), snackUndo: $('snackbar-undo'),
  };
  const setRecsMsg = (t, kind) => { rEls.msg.textContent = t || ''; rEls.msg.className = 'msg' + (kind ? ' ' + kind : ''); };

  async function loadRecs() {
    if (recs.loaded) { renderActive(); return; }
    setRecsMsg('Loading…'); rEls.hint.hidden = true;
    try {
      const [m, s] = await Promise.all([
        apiFetch('/recommendations?type=movie').then((r) => r.json()).catch(() => ({})),
        apiFetch('/recommendations?type=series').then((r) => r.json()).catch(() => ({})),
      ]);
      recs.cache = { movie: (m && m.items) || [], series: (s && s.items) || [] };
      recs.loaded = true;
      updateBadges();
      renderActive();
    } catch { setRecsMsg('Could not load recommendations — try again.', 'err'); }
  }

  function updateBadges() {
    rEls.badgeMovie.textContent = recs.cache.movie.length ? String(recs.cache.movie.length) : '';
    rEls.badgeSeries.textContent = recs.cache.series.length ? String(recs.cache.series.length) : '';
  }

  function renderActive() {
    const items = recs.cache[recs.type] || [];
    rEls.list.innerHTML = '';
    if (!items.length) {
      setRecsMsg(recs.type === 'series' ? 'No show recommendations yet — watch something and they’ll appear.' : 'No movie recommendations yet — watch something and they’ll appear.');
      rEls.hint.hidden = true; return;
    }
    setRecsMsg(''); rEls.hint.hidden = false;
    const frag = document.createDocumentFragment();
    items.forEach((r) => frag.appendChild(buildRecRow(r)));
    rEls.list.appendChild(frag);
  }

  function buildRecRow(r) {
    const row = document.createElement('div'); row.className = 'rec';
    const under = document.createElement('div'); under.className = 'rec-underlay';
    const hRemove = document.createElement('span'); hRemove.className = 'hint hint-remove'; hRemove.textContent = window.swipe.REMOVE_LABEL;
    const hSave = document.createElement('span'); hSave.className = 'hint hint-save'; hSave.textContent = window.swipe.SAVE_LABEL;
    under.appendChild(hRemove); under.appendChild(hSave);

    const body = document.createElement('div'); body.className = 'rec-body';
    const img = document.createElement('img'); img.className = 'rec-poster'; img.loading = 'lazy'; img.alt = '';
    if (r.poster) img.src = r.poster; else img.classList.add('no-poster');
    const meta = document.createElement('div'); meta.className = 'rec-meta';
    const title = document.createElement('div'); title.className = 'rec-title'; title.textContent = r.title || 'Untitled';
    const sub = document.createElement('div'); sub.className = 'rec-sub';
    sub.textContent = [r.year || '', r.genre || '', r.rating ? '★ ' + Number(r.rating).toFixed(1) : ''].filter(Boolean).join(' · ');
    meta.appendChild(title); meta.appendChild(sub);
    if (r.because) { const b = document.createElement('div'); b.className = 'rec-because'; b.textContent = 'Because you watched ' + r.because; meta.appendChild(b); }
    const actions = document.createElement('div'); actions.className = 'rec-actions';
    const saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'rec-save'; saveBtn.title = 'Add to Watch Later'; saveBtn.setAttribute('aria-label', 'Add to Watch Later'); saveBtn.textContent = '＋';
    const remBtn = document.createElement('button'); remBtn.type = 'button'; remBtn.className = 'rec-remove'; remBtn.title = 'Remove'; remBtn.setAttribute('aria-label', 'Remove'); remBtn.textContent = '✕';
    saveBtn.addEventListener('click', (e) => { e.stopPropagation(); saveRec(r, saveBtn); });
    remBtn.addEventListener('click', (e) => { e.stopPropagation(); removeRec(r, row); });
    actions.appendChild(saveBtn); actions.appendChild(remBtn);
    body.appendChild(img); body.appendChild(meta); body.appendChild(actions);

    row.appendChild(under); row.appendChild(body);
    attachSwipe(row, body, under, hRemove, hSave, r);
    return row;
  }

  function attachSwipe(row, body, under, hRemove, hSave, r) {
    let dragging = false, startX = 0, width = 0, action = 'none';
    body.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // buttons handle their own taps
      dragging = true; startX = e.clientX; width = row.offsetWidth || 320; action = 'none';
      try { body.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    body.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const o = window.swipe.swipeOutcome(e.clientX - startX, width);
      action = o.action;
      body.style.transform = 'translateX(' + (e.clientX - startX) + 'px)';
      under.style.background = o.color || '';
      hRemove.style.opacity = o.direction === 'right' ? String(o.progress) : '0';
      hSave.style.opacity = o.direction === 'left' ? String(o.progress) : '0';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      body.style.transform = ''; under.style.background = ''; hRemove.style.opacity = '0'; hSave.style.opacity = '0';
      const a = action; action = 'none';
      if (a === 'remove') removeRec(r, row);
      else if (a === 'save') saveRec(r, null);
    };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
  }

  async function saveRec(r, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/watchlist', { method: 'POST', body: JSON.stringify({ type: r.type, imdb_id: r.id, tmdb_id: r.tmdb_id, title: r.title, year: r.year }) });
      const d = await res.json().catch(() => ({}));
      showSnack(res.ok ? ('Added “' + (r.title || 'title') + '” to Watch Later') : (d.error || 'Could not add'), null);
    } catch { showSnack('Could not add — try again.', null); }
    finally { if (btn) btn.disabled = false; }
  }

  async function removeRec(r, row) {
    row.classList.add('removing');
    setTimeout(() => row.remove(), 200);
    recs.cache[r.type] = (recs.cache[r.type] || []).filter((x) => x.id !== r.id);
    updateBadges();
    try {
      await apiFetch('/recommend/suppress', { method: 'POST', body: JSON.stringify({ type: r.type, imdb_id: r.id, tmdb_id: r.tmdb_id, title: r.title }) });
      showSnack('Removed “' + (r.title || 'title') + '”', () => undoRemove(r));
    } catch { showSnack('Could not remove — try again.', null); }
  }

  async function undoRemove(r) {
    hideSnack();
    try { await apiFetch('/recommend/unsuppress', { method: 'POST', body: JSON.stringify({ type: r.type, tmdb_id: r.tmdb_id }) }); } catch (_) { /* ignore */ }
    recs.cache[r.type] = [r, ...(recs.cache[r.type] || []).filter((x) => x.id !== r.id)];
    updateBadges();
    if (recs.type === r.type) renderActive();
  }

  function showSnack(text, onUndo) {
    clearTimeout(recs.snackTimer);
    rEls.snackText.textContent = text;
    rEls.snackUndo.hidden = !onUndo;
    recs.undo = onUndo || null;
    rEls.snackbar.hidden = false;
    recs.snackTimer = setTimeout(hideSnack, 5000);
  }
  function hideSnack() { clearTimeout(recs.snackTimer); rEls.snackbar.hidden = true; recs.undo = null; }

  rEls.snackUndo.addEventListener('click', () => { if (recs.undo) recs.undo(); });
  rEls.segs.forEach((seg) => seg.addEventListener('click', () => {
    recs.type = seg.dataset.rtype;
    rEls.segs.forEach((s) => s.classList.toggle('active', s === seg));
    renderActive();
  }));

  // ---- boot ----
  (async function boot() {
    try {
      const res = await apiFetch('/me');
      if (res.ok) { state.authed = true; state.profile = (await res.json()).profile; }
    } catch { /* offline → login */ }
    render();
  })();
})();
