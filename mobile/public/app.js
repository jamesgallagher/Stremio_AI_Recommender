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
    logout: $('logout'), openSettings: $('open-settings'), profileName: $('profile-name'), msg: $('login-msg'),
    content: $('content'),
  };

  async function apiFetch(path, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000); // never hang forever
    try {
      return await fetch(API + path, {
        ...opts,
        credentials: 'same-origin',
        cache: 'no-store', // per-session API — don't cache or send conditional (If-None-Match) requests
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
    } finally {
      clearTimeout(timer);
    }
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
    if (view === 'settings') loadSettings();
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
      // Success: the session cookie is set from the response HEADERS (which have
      // arrived — status is 200). Do NOT read the POST response body — some
      // proxies stall a POST body even when GET bodies deliver fine. Confirm the
      // session and load the profile with GET /me, then render.
      setMsg('Signed in — loading…', 'ok');
      if (location.hash === '#/login' || !location.hash) location.hash = '#/recs';
      await boot();
    } catch { setMsg('Something went wrong — try again.', 'err'); }
    finally { els.verify.disabled = false; }
  });

  els.back.addEventListener('click', () => { state.pendingEmail = ''; showEmailStep(); els.email.focus(); });
  els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.verify.click(); });
  els.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.send.click(); });

  els.logout.addEventListener('click', async () => {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.authed = false; state.profile = null; state.pendingEmail = '';
    recs.loaded = false; recs.data = { movie: null, series: null }; hideSnack();
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
      // Don't read the POST body (proxy may stall it) — act on the status.
      if (res.ok) { sEls.add.textContent = '✓ Added to watchlist'; setAddMsg('Added to your Simkl Watch Later.', 'ok'); return; }
      setAddMsg(res.status === 400 ? 'Connect Simkl in the portal first.' : 'Could not add — try again.', 'err');
      sEls.add.disabled = false;
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

  // ---- recommendations (Step 4/5) ----
  // recs.data[type] = { view, items, display, benchExhausted } | null
  //   view          'catalog' (mirror of the Stremio row) | 'all' (entire pool)
  //   items         the visible `display` titles PLUS a hidden on-deck bench
  //   display       how many to actually show (the profile's list_size)
  //   benchExhausted no more bench to promote from (don't refetch on removal)
  const recs = { type: 'movie', data: { movie: null, series: null }, loaded: false, undo: null, snackTimer: null };
  const rEls = {
    segs: document.querySelectorAll('#recs-tabs .seg'),
    list: $('recs-list'), msg: $('recs-msg'), hint: $('recs-hint'),
    badgeMovie: $('badge-movie'), badgeSeries: $('badge-series'),
    snackbar: $('snackbar'), snackText: $('snackbar-text'), snackUndo: $('snackbar-undo'),
  };
  const setRecsMsg = (t, kind) => { rEls.msg.textContent = t || ''; rEls.msg.className = 'msg' + (kind ? ' ' + kind : ''); };

  // Shape a /recommendations response into recs.data. In catalog view the bench
  // is items beyond `display`; a response with no bench (or the 'all' view)
  // starts exhausted, so a removal just shrinks the list honestly.
  function toRecData(resp) {
    const items = (resp && resp.items) || [];
    const view = (resp && resp.view) || 'catalog';
    const display = (resp && typeof resp.display_count === 'number') ? resp.display_count : items.length;
    return { view, items, display, benchExhausted: view !== 'catalog' || items.length <= display };
  }
  const visibleItems = (d) => (d ? d.items.slice(0, d.display) : []);

  async function loadRecs() {
    if (recs.loaded) { renderActive(); return; }
    setRecsMsg('Loading…'); rEls.hint.hidden = true;
    try {
      const [m, s] = await Promise.all([
        apiFetch('/recommendations?type=movie').then((r) => r.json()).catch(() => ({})),
        apiFetch('/recommendations?type=series').then((r) => r.json()).catch(() => ({})),
      ]);
      recs.data = { movie: toRecData(m), series: toRecData(s) };
      recs.loaded = true;
      updateBadges();
      renderActive();
    } catch { setRecsMsg('Could not load recommendations — try again.', 'err'); }
  }

  function countFor(type) {
    const d = recs.data[type];
    if (!d) return '';
    const n = Math.min(d.display, d.items.length);
    return n ? String(n) : '';
  }
  function updateBadges() {
    rEls.badgeMovie.textContent = countFor('movie');
    rEls.badgeSeries.textContent = countFor('series');
  }

  function renderActive() {
    const items = visibleItems(recs.data[recs.type]);
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

  // Promotion: append one row to the active list (the title that just slid into
  // the visible window from the top of the bench). No-op off the active tab.
  function appendRecRow(type, r) {
    if (type !== recs.type || !r) return;
    rEls.list.appendChild(buildRecRow(r));
  }

  // Bench consumed — refetch the same view to see if the pool still has more
  // (it may, beyond the buffer we fetched, or after suppressions settled).
  async function refillBench(type) {
    const prev = recs.data[type];
    const view = prev ? prev.view : 'catalog';
    try {
      const resp = await apiFetch('/recommendations?type=' + type + '&view=' + view).then((r) => r.json()).catch(() => null);
      if (!resp) return;
      recs.data[type] = toRecData(resp);
      updateBadges();
      if (type === recs.type) renderActive();
    } catch (_) { /* keep the shrunken list — not fatal */ }
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
      // Don't read the POST body (proxy may stall it) — act on the status.
      if (res.ok) showSnack('Added “' + (r.title || 'title') + '” to Watch Later', null);
      else if (res.status === 400) showSnack('Couldn’t add — connect Simkl in the portal first', null);
      else showSnack('Couldn’t add — try again', null);
    } catch { showSnack('Could not add — try again.', null); }
    finally { if (btn) btn.disabled = false; }
  }

  async function removeRec(r, row) {
    row.classList.add('removing');
    setTimeout(() => row.remove(), 200);
    const d = recs.data[r.type];
    let needRefill = false;
    if (d) {
      const idx = d.items.findIndex((x) => x.id === r.id);
      if (idx !== -1) d.items.splice(idx, 1);
      // One in, one out: in catalog view, promote the top of the bench into the
      // freed slot; when the bench is spent, top it up after the server settles.
      if (d.view === 'catalog') {
        if (d.items.length >= d.display) appendRecRow(r.type, d.items[d.display - 1]);
        else needRefill = !d.benchExhausted;
      }
    }
    updateBadges();
    try {
      await apiFetch('/recommend/suppress', { method: 'POST', body: JSON.stringify({ type: r.type, imdb_id: r.id, tmdb_id: r.tmdb_id, title: r.title }) });
      showSnack('Removed “' + (r.title || 'title') + '”', () => undoRemove(r));
      if (needRefill) await refillBench(r.type);
    } catch { showSnack('Could not remove — try again.', null); }
  }

  async function undoRemove(r) {
    hideSnack();
    try { await apiFetch('/recommend/unsuppress', { method: 'POST', body: JSON.stringify({ type: r.type, tmdb_id: r.tmdb_id }) }); } catch (_) { /* ignore */ }
    const d = recs.data[r.type];
    if (d) {
      d.items = [r, ...d.items.filter((x) => x.id !== r.id)]; // back to the top; a promoted bench title slides back
      updateBadges();
      if (recs.type === r.type) renderActive();
    }
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

  // ---- settings (Step 5/6): Filters + Catalogs tabs ----
  const settingsState = { catalogs: [] };
  const setEls = {
    tabs: document.querySelectorAll('#settings-tabs .seg'),
    msg: $('settings-msg'),
    minRating: $('set-min-rating'), recency: $('set-recency'), listSize: $('set-list-size'),
    voteFloor: $('set-vote-floor'), genres: $('set-genres'), catalogOnly: $('set-catalog-only'),
    titleDecay: $('set-title-decay'), titleDecayDays: $('set-title-decay-days'), titleDecayDaysField: $('set-title-decay-days-field'),
    save: $('settings-save'), done: $('settings-done'),
    catalogs: $('set-catalogs'), catalogsWarn: $('set-catalogs-warn'), catalogsSave: $('catalogs-save'),
  };
  const setSettingsMsg = (t, kind) => { setEls.msg.textContent = t || ''; setEls.msg.className = 'msg' + (kind ? ' ' + kind : ''); };

  function switchSettingsTab(tab) {
    setEls.tabs.forEach((s) => s.classList.toggle('active', s.dataset.settab === tab));
    document.querySelectorAll('#view-settings .settab').forEach((p) => { p.hidden = p.dataset.settab !== tab; });
    setSettingsMsg('');
  }

  // Set a <select> to a value, falling back to its first option if the value
  // isn't one of the presets (e.g. a hand-edited profile).
  function setSelect(sel, value) {
    const v = String(value);
    sel.value = [...sel.options].some((o) => o.value === v) ? v : (sel.options[0] ? sel.options[0].value : '');
  }

  function renderGenres(genres, excluded) {
    const set = new Set((excluded || []).map(String));
    setEls.genres.innerHTML = '';
    const frag = document.createDocumentFragment();
    (genres || []).forEach((g) => {
      const label = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = g; cb.checked = set.has(g);
      const span = document.createElement('span'); span.textContent = g;
      label.appendChild(cb); label.appendChild(span);
      frag.appendChild(label);
    });
    setEls.genres.appendChild(frag);
  }

  // Compact meta line under a catalog name (type · source · IMDb floor · size).
  // Age-band notes are intentionally omitted — the Companion never surfaces age.
  function catMeta(c) {
    const bits = [c.type === 'series' ? 'series' : 'movies'];
    if (c.source === 'simkl_plantowatch') bits.push('Simkl plan-to-watch');
    if (c.min_imdb) bits.push('IMDb ≥ ' + c.min_imdb);
    if (c.target && c.target !== 20) bits.push(c.target + ' titles');
    if (c.dedupe_watched === false) bits.push('keeps watched');
    return bits.join(' · ');
  }

  function catRow(name, meta, { id, checked, locked } = {}) {
    const label = document.createElement('label'); label.className = 'cat-row' + (locked ? ' locked' : '');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!checked;
    if (locked) cb.disabled = true; else cb.dataset.catalog = id;
    if (!locked) cb.addEventListener('change', updateCatalogWarning);
    const nm = document.createElement('span'); nm.className = 'cat-name'; nm.textContent = name;
    const mt = document.createElement('span'); mt.className = 'cat-meta'; mt.textContent = meta;
    label.appendChild(cb); label.appendChild(nm); label.appendChild(mt);
    return label;
  }

  function renderCatalogs(cats) {
    settingsState.catalogs = cats || [];
    setEls.catalogs.innerHTML = '';
    const frag = document.createDocumentFragment();
    // The two AI lists are always on (locked).
    frag.appendChild(catRow('Movies recommended for you', 'always on', { checked: true, locked: true }));
    frag.appendChild(catRow('Series recommended for you', 'always on', { checked: true, locked: true }));
    settingsState.catalogs.forEach((c) => frag.appendChild(catRow(c.name, catMeta(c), { id: c.id, checked: c.enabled })));
    setEls.catalogs.appendChild(frag);
    updateCatalogWarning();
  }

  // Warn (like the portal) when an ENABLED catalog can't build for lack of its
  // data source. Recomputed live as toggles change.
  function updateCatalogWarning() {
    const byId = new Map(settingsState.catalogs.map((c) => [c.id, c]));
    let needsSimkl = false; let needsMdblist = false;
    setEls.catalogs.querySelectorAll('input[data-catalog]:checked').forEach((cb) => {
      const c = byId.get(cb.dataset.catalog);
      if (!c || c.requirement_met) return;
      if (c.source === 'simkl_plantowatch') needsSimkl = true; else needsMdblist = true;
    });
    const msgs = [];
    if (needsSimkl) msgs.push('Watch Later needs Simkl connected');
    if (needsMdblist) msgs.push('Curated lists need an MDBList key');
    setEls.catalogsWarn.textContent = msgs.length ? '⚠ ' + msgs.join(' · ') + ' (set in the portal)' : '';
    setEls.catalogsWarn.className = 'msg' + (msgs.length ? ' err' : '');
  }

  async function loadSettings() {
    switchSettingsTab('filters'); // Filters is the default tab on every entry
    setSettingsMsg('Loading…');
    try {
      const res = await apiFetch('/settings');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSettingsMsg(data.error || 'Could not load settings.', 'err'); return; }
      const f = data.filters || {};
      setSelect(setEls.minRating, f.min_rating != null ? f.min_rating : 0);
      setSelect(setEls.recency, f.max_age_years != null ? f.max_age_years : 0);
      setSelect(setEls.listSize, f.list_size != null ? f.list_size : 20);
      setSelect(setEls.voteFloor, f.vote_count_floor != null ? f.vote_count_floor : 1000);
      setEls.titleDecay.checked = !!f.title_decay_enabled;
      setSelect(setEls.titleDecayDays, f.title_decay_days != null ? f.title_decay_days : 60);
      setEls.titleDecayDaysField.hidden = !setEls.titleDecay.checked;
      setEls.catalogOnly.checked = data.catalog_only !== false;
      renderGenres(data.genres, f.excluded_genres);
      renderCatalogs(data.catalogs);
      setSettingsMsg('');
    } catch { setSettingsMsg('Could not load settings — try again.', 'err'); }
  }

  async function saveSettings() {
    setEls.save.disabled = true; setSettingsMsg('Saving…');
    const payload = {
      min_rating: parseFloat(setEls.minRating.value),
      max_age_years: parseInt(setEls.recency.value, 10),
      list_size: parseInt(setEls.listSize.value, 10),
      vote_count_floor: parseInt(setEls.voteFloor.value, 10),
      excluded_genres: [...setEls.genres.querySelectorAll('input:checked')].map((i) => i.value),
      title_decay_enabled: setEls.titleDecay.checked,
      title_decay_days: parseInt(setEls.titleDecayDays.value, 10),
      catalog_only: setEls.catalogOnly.checked,
    };
    try {
      const res = await apiFetch('/settings', { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSettingsMsg(data.error || 'Could not save — try again.', 'err'); return; }
      setSettingsMsg('Saved. Your list updates the next time it loads.', 'ok');
      recs.loaded = false; // filters/view changed — the Recommendations tab refetches on next visit
    } catch { setSettingsMsg('Could not save — try again.', 'err'); }
    finally { setEls.save.disabled = false; }
  }

  async function saveCatalogs() {
    setEls.catalogsSave.disabled = true; setSettingsMsg('Saving…');
    const catalogs = {};
    setEls.catalogs.querySelectorAll('input[data-catalog]').forEach((cb) => { catalogs[cb.dataset.catalog] = cb.checked; });
    try {
      const res = await apiFetch('/settings', { method: 'POST', body: JSON.stringify({ catalogs }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSettingsMsg(data.error || 'Could not save — try again.', 'err'); return; }
      setSettingsMsg('Catalogs saved — newly enabled lists build in the background.', 'ok');
      if (Array.isArray(data.catalogs)) renderCatalogs(data.catalogs);
    } catch { setSettingsMsg('Could not save — try again.', 'err'); }
    finally { setEls.catalogsSave.disabled = false; }
  }

  setEls.tabs.forEach((seg) => seg.addEventListener('click', () => switchSettingsTab(seg.dataset.settab)));
  setEls.titleDecay.addEventListener('change', () => { setEls.titleDecayDaysField.hidden = !setEls.titleDecay.checked; });
  setEls.save.addEventListener('click', saveSettings);
  setEls.catalogsSave.addEventListener('click', saveCatalogs);
  setEls.done.addEventListener('click', () => { location.hash = '#/recs'; });
  els.openSettings.addEventListener('click', () => { location.hash = '#/settings'; });

  // ---- boot ---- (declaration so the verify flow can reuse it)
  async function boot() {
    try {
      const res = await apiFetch('/me');
      if (res.ok) { state.authed = true; state.profile = (await res.json()).profile; }
      else { state.authed = false; state.profile = null; }
    } catch { state.authed = false; state.profile = null; }
    render();
  }
  boot();
})();
