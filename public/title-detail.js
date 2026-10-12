// TD-1 — Title detail modal. ONE shared component used by both the portal
// (/configure) and the mobile companion. UMD like trainer-ui.js: in the browser
// it becomes window.TitleDetail; in Node it is module.exports for tests.
// No DOM access at module level. All classes prefixed td- so nothing collides.
const TitleDetail = {};

// ---- Pure helpers (exported for tests) ----

// XSS: escape a server-derived string for safe HTML insertion.
TitleDetail.esc = (s) => {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
};

// Tap detection: true when the pointer moved < 8px and < 300ms.
TitleDetail.isTap = (dx, dy, dtMs) => Math.hypot(dx, dy) < 8 && dtMs < 300;

// Initials: up to 2 uppercase letters from a name (for the photo placeholder).
TitleDetail.initials = (name) => {
  if (!name) return '';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
};

// Build the item object from a td-open button's data attributes.
TitleDetail.itemFromEl = (btn) => {
  const d = btn?.dataset || {};
  const tmdb = d.tmdb || null;
  return {
    type: d.type || null,
    imdb_id: d.imdb || null,
    tmdb_id: tmdb ? String(tmdb) : null,
    name: d.name || '',
    poster: d.poster || null,
    year: d.year ? parseInt(d.year, 10) : null,
  };
};

// The click target: a real <button type="button"> carrying the title's ids in
// data-* attributes (poster and title text). Every surface uses the same
// attributes so itemFromEl can read them back. `kind` is 'poster' or 'title'.
// item = {type, imdb_id, tmdb_id, name, year, poster}.
TitleDetail.openBtn = (item, inner, kind) => {
  const esc = TitleDetail.esc;
  const name = item.name || '';
  const tmdb = item.tmdb_id != null ? String(item.tmdb_id) : '';
  const year = item.year != null ? String(item.year) : '';
  const cls = 'td-open td-open-' + (kind || 'poster');
  const tooltip = kind === 'poster' ? 'Details: ' + name : name;
  const aria = kind === 'poster' ? ' aria-label="' + esc('Details: ' + name) + '"' : '';
  return '<button type="button" class="' + cls + '"'
    + ' data-type="' + esc(item.type || '') + '"'
    + ' data-imdb="' + esc(item.imdb_id || '') + '"'
    + ' data-tmdb="' + esc(tmdb) + '"'
    + ' data-name="' + esc(name) + '"'
    + ' data-year="' + esc(year) + '"'
    + ' data-poster="' + esc(item.poster || '') + '"'
    + ' title="' + esc(tooltip) + '"'
    + aria
    + '>' + inner + '</button>';
};

// Same as openBtn but sets the attributes on a DOM <button> element (for the
// surfaces that build rows with createElement instead of innerHTML).
TitleDetail.markOpenBtn = (btn, item, kind) => {
  const name = item.name || '';
  btn.type = 'button';
  btn.classList.add('td-open', 'td-open-' + (kind || 'poster'));
  btn.dataset.type = item.type || '';
  btn.dataset.imdb = item.imdb_id || '';
  btn.dataset.tmdb = item.tmdb_id != null ? String(item.tmdb_id) : '';
  btn.dataset.name = name;
  btn.dataset.year = item.year != null ? String(item.year) : '';
  btn.dataset.poster = item.poster || '';
  btn.title = kind === 'poster' ? 'Details: ' + name : name;
  if (kind === 'poster') btn.setAttribute('aria-label', 'Details: ' + name);
};

// Open the detail modal from a td-open button. The host supplies fetchDetail
// (portal uses api(), mobile uses apiFetch()) and optional footer actions.
TitleDetail.openFromBtn = (btn, fetchDetail, actions) => {
  const item = TitleDetail.itemFromEl(btn);
  TitleDetail.open(item, { fetchDetail, actions: actions || null, opener: btn });
};

// shouldOpen: the tap-vs-drag flag logic (exported for testing).
TitleDetail.shouldOpen = (wasDrag) => !wasDrag;

// ---- renderDetailHtml: build the modal HTML from item + detail + state ----
// state = { loading: bool, error: bool, expanded: bool }
TitleDetail.renderDetailHtml = (item, detail, state = {}) => {
  const esc = TitleDetail.esc;
  const title = detail?.title || item?.name || '';
  const poster = detail?.poster || item?.poster || null;
  const year = detail?.year || item?.year || null;
  const synopsis = detail?.synopsis || '';
  const runtime = detail?.runtime || null;
  const genres = detail?.genres || [];
  const rating = detail?.rating || null;
  const cast = detail?.cast || [];
  const loading = state?.loading || false;
  const error = state?.error || false;

  // Meta line: "2019 · 142 min · Drama, Thriller" — skip missing parts.
  const metaParts = [];
  if (year) metaParts.push(String(year));
  if (runtime) metaParts.push(runtime);
  if (genres.length) metaParts.push(genres.join(', '));
  const meta = metaParts.join(' · ');

  // Age badge.
  let badge = '';
  if (rating) {
    const label = esc(rating.label);
    const country = esc(rating.country);
    badge = `<span class="td-badge" title="Rated ${label} in ${country}">${country} · ${label}</span>`;
  }

  // Synopsis (clamped to 6 lines, More/Less toggle).
  let synHtml = '';
  if (loading) {
    synHtml = '<div class="td-skel"><div class="td-skel-line"></div><div class="td-skel-line"></div><div class="td-skel-line"></div></div>';
  } else if (error) {
    synHtml = '<div class="td-err">Couldn\'t load details. <button type="button" class="td-retry">Retry</button></div>';
  } else {
    const syn = synopsis ? `<p class="td-syn">${esc(synopsis)}</p><button type="button" class="td-more">More</button>` : '';
    synHtml = syn;
  }

  // Cast scroller.
  let castHtml = '';
  if (loading) {
    castHtml = '<div class="td-cast">' + '<div class="td-skel-circle"></div>'.repeat(5) + '</div>';
  } else if (cast.length) {
    const people = cast.map((p) => {
      const photo = p.photo
        ? `<img class="td-person-photo" src="${esc(p.photo)}" alt="">`
        : `<div class="td-person-initials">${esc(TitleDetail.initials(p.name))}</div>`;
      const name = `<span class="td-person-name">${esc(p.name)}</span>`;
      const char = p.character ? `<span class="td-person-char">as ${esc(p.character)}</span>` : '';
      return `<div class="td-person">${photo}${name}${char}</div>`;
    }).join('');
    castHtml = `<h3 class="td-cast-heading">Main cast</h3><div class="td-cast">${people}</div>`;
  }

  // Poster (or placeholder).
  const posterHtml = poster
    ? `<img class="td-poster" src="${esc(poster)}" alt="Poster for ${esc(title)}">`
    : `<div class="td-poster-placeholder"></div>`;

  return `
    <div class="td-head">
      ${posterHtml}
      <div class="td-info">
        <h2 id="td-title">${esc(title)}</h2>
        ${meta ? `<div class="td-meta">${esc(meta)}</div>` : ''}
        ${badge}
      </div>
    </div>
    <div class="td-body">
      ${synHtml}
      ${castHtml}
    </div>
  `;
};

// ---- DOM component (open/close) ----
// In the browser, TitleDetail.open() builds the modal DOM and injects it.
// In Node (tests), only the pure helpers above are used.

if (typeof document !== 'undefined') {
  let _panel = null;
  let _reqId = 0;
  let _prevOverflow = null;
  let _prevFocus = null;
  let _opener = null;
  let _actions = null;
  let _tdPushed = false;

  function _ensureDOM() {
    if (_panel) return _panel;
    // Build once.
    const backdrop = document.createElement('div');
    backdrop.className = 'td-backdrop';
    const panel = document.createElement('div');
    panel.className = 'td-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'td-title');
    panel.setAttribute('tabindex', '-1');
    // Grab bar (mobile only via CSS).
    const grab = document.createElement('div');
    grab.className = 'td-grab';
    // Close button.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'td-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => TitleDetail.close());
    panel.appendChild(grab);
    panel.appendChild(closeBtn);
    const head = document.createElement('div');
    head.className = 'td-head';
    const body = document.createElement('div');
    body.className = 'td-body';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'td-actions';
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(actionsDiv);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    _panel = panel;
    // Inject style once.
    if (!document.getElementById('td-style')) {
      const style = document.createElement('style');
      style.id = 'td-style';
      style.textContent = _CSS();
      document.head.appendChild(style);
    }
    return panel;
  }

  function _attachRetry(panel, item, opts) {
    const retryBtn = panel.querySelector('.td-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        panel.querySelector('.td-head').innerHTML = _extractHead(TitleDetail.renderDetailHtml(item, null, { loading: true }));
        panel.querySelector('.td-body').innerHTML = _extractBody(TitleDetail.renderDetailHtml(item, null, { loading: true }));
        _reqId++;
        const retryId = _reqId;
        opts.fetchDetail(item).then((detail) => {
          if (retryId !== _reqId) return;
          const html = TitleDetail.renderDetailHtml(item, detail || null, detail ? {} : { error: true });
          panel.querySelector('.td-head').innerHTML = _extractHead(html);
          panel.querySelector('.td-body').innerHTML = _extractBody(html);
        }).catch(() => {
          const errHtml = TitleDetail.renderDetailHtml(item, null, { error: true });
          panel.querySelector('.td-head').innerHTML = _extractHead(errHtml);
          panel.querySelector('.td-body').innerHTML = _extractBody(errHtml);
        });
      });
    }
  }

  TitleDetail.open = (item, opts = {}) => {
    const panel = _ensureDOM();
    _reqId++;
    const myId = _reqId;
    _opener = opts.opener || null;
    _actions = opts.actions || null;
    _prevOverflow = document.body.style.overflow;
    _prevFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    // Focus the close button.
    const closeBtn = panel.querySelector('.td-close');
    closeBtn.focus();
    // History pushState (mobile Back button).
    history.pushState({ td: 1 }, '');
    _tdPushed = true;
    // Render loading state.
    const loadingHtml = TitleDetail.renderDetailHtml(item, null, { loading: true });
    panel.querySelector('.td-head').innerHTML = _extractHead(loadingHtml);
    panel.querySelector('.td-body').innerHTML = _extractBody(loadingHtml);
    // Fetch detail.
    if (opts.fetchDetail) {
      opts.fetchDetail(item).then((detail) => {
        if (myId !== _reqId) return; // stale
        if (!detail) {
          const errHtml = TitleDetail.renderDetailHtml(item, null, { error: true });
          panel.querySelector('.td-head').innerHTML = _extractHead(errHtml);
          panel.querySelector('.td-body').innerHTML = _extractBody(errHtml);
          _attachRetry(panel, item, opts);
          return;
        }
        const html = TitleDetail.renderDetailHtml(item, detail, {});
        panel.querySelector('.td-head').innerHTML = _extractHead(html);
        panel.querySelector('.td-body').innerHTML = _extractBody(html);
        // Actions.
        const actionsDiv = panel.querySelector('.td-actions');
        if (_actions && _actions.length) {
          actionsDiv.innerHTML = _actions.map((a) => `<button type="button" class="td-action-btn">${TitleDetail.esc(a.label)}</button>`).join('');
          actionsDiv.querySelectorAll('.td-action-btn').forEach((btn, i) => {
            btn.addEventListener('click', () => {
              _actions[i].onClick(item, () => TitleDetail.close());
            });
          });
        } else {
          actionsDiv.innerHTML = '';
        }
        // Synopsis overflow check.
        const syn = panel.querySelector('.td-syn');
        const moreBtn = panel.querySelector('.td-more');
        if (syn && moreBtn) {
          const overflows = syn.scrollHeight > syn.clientHeight || (syn.textContent.length > 280);
          if (!overflows) moreBtn.style.display = 'none';
          moreBtn.addEventListener('click', () => {
            syn.classList.toggle('td-expanded');
            moreBtn.textContent = syn.classList.contains('td-expanded') ? 'Less' : 'More';
          });
        }
      }).catch(() => {
        if (myId !== _reqId) return;
        const errHtml = TitleDetail.renderDetailHtml(item, null, { error: true });
        panel.querySelector('.td-head').innerHTML = _extractHead(errHtml);
        panel.querySelector('.td-body').innerHTML = _extractBody(errHtml);
        _attachRetry(panel, item, opts);
      });
    }
  };

  TitleDetail.close = () => {
    if (!_panel) return;
    const backdrop = _panel.parentElement;
    backdrop.remove();
    _panel = null;
    _tdPushed = false;
    document.body.style.overflow = _prevOverflow || '';
    // Focus return.
    const target = (_opener && document.contains(_opener)) ? _opener : _prevFocus;
    if (target && typeof target.focus === 'function') target.focus();
    _opener = null;
    // History pop if we pushed.
    if (history.state && history.state.td) {
      history.back();
    }
  };

  // Backdrop click closes (only on the backdrop itself, not the panel).
  document.addEventListener('click', (e) => {
    if (_panel && e.target.classList.contains('td-backdrop')) {
      TitleDetail.close();
    }
  });

  // Escape key closes.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel) {
      e.stopPropagation();
      TitleDetail.close();
    }
  }, true); // capture phase so it fires before other handlers.

  // Focus trap: Tab cycles within the modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !_panel) return;
    const focusable = _panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, true);

  // popstate: close on Back button (flag-based, since e.state is the entry we navigate TO).
  window.addEventListener('popstate', (e) => {
    if (_panel && _tdPushed) {
      _tdPushed = false;
      TitleDetail.close();
    }
  });
}

// Extract just the .td-head innerHTML from the renderDetailHtml output.
function _extractHead(html) {
  const match = html.match(/<div class="td-head">([\s\S]*?)<\/div>\s*<div class="td-body">/);
  return match ? match[1] : html;
}

function _extractBody(html) {
  const match = html.match(/<div class="td-body">([\s\S]*?)<\/div>\s*$/);
  return match ? match[1] : '';
}

// CSS (injected once via <style id="td-style">).
function _CSS() {
  return `
.td-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;display:flex;align-items:flex-end;justify-content:center}
.td-panel{position:relative;width:100%;max-height:90vh;overflow:auto;background:var(--card,#1a1a2e);border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));border:1px solid var(--border,#333)}
.td-grab{width:40px;height:4px;border-radius:2px;background:var(--border,#333);margin:0 auto 8px}
.td-close{position:absolute;top:8px;right:8px;width:44px;height:44px;background:none;border:none;color:var(--text,#eee);font-size:18px;cursor:pointer;z-index:1}
.td-head{display:flex;gap:12px;margin-bottom:12px}
.td-poster{width:110px;aspect-ratio:2/3;object-fit:cover;border-radius:10px;background:var(--card2,#2a2a3e)}
.td-poster-placeholder{width:110px;aspect-ratio:2/3;border-radius:10px;background:var(--card2,#2a2a3e)}
.td-info{flex:1;min-width:0}
.td-info h2{font-size:22px;font-weight:700;margin:0 0 4px}
.td-meta{font-size:14px;color:var(--muted,#888)}
.td-badge{display:inline-flex;align-items:center;font-size:13px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--border,#333);margin-top:6px}
.td-body{min-width:0}
.td-syn{font-size:16px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.td-syn.td-expanded{-webkit-line-clamp:unset;display:block}
.td-more{background:none;border:none;color:var(--accent,#4a9);cursor:pointer;font-size:13px;margin-top:4px}
.td-cast-heading{font-size:14px;font-weight:600;margin:12px 0 8px}
.td-cast{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x proximity;padding-bottom:6px}
.td-person{width:84px;flex:none;scroll-snap-align:start;text-align:center}
.td-person-photo{width:56px;height:56px;border-radius:50%;object-fit:cover;margin:0 auto 4px}
.td-person-initials{width:56px;height:56px;border-radius:50%;background:var(--card2,#2a2a3e);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;margin:0 auto 4px}
.td-person-name{font-size:13px;font-weight:600;display:block;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.td-person-char{font-size:12px;color:var(--muted,#888);display:block;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.td-skel{margin:8px 0}
.td-skel-line{height:14px;background:var(--card2,#2a2a3e);border-radius:4px;margin:6px 0;animation:td-shimmer 1.2s infinite}
.td-skel-circle{width:56px;height:56px;border-radius:50%;background:var(--card2,#2a2a3e);flex:none}
.td-err{color:var(--muted,#888);font-size:14px}
.td-retry{background:none;border:none;color:var(--accent,#4a9);cursor:pointer;font-size:14px}
.td-actions{display:flex;gap:8px;margin-top:12px}
.td-action-btn{background:var(--accent,#4a9);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}
.td-close:focus-visible,.td-more:focus-visible,.td-retry:focus-visible,.td-person:focus-visible{outline:2px solid var(--accent,#4a9)}
@keyframes td-shimmer{0%{opacity:.4}50%{opacity:.8}100%{opacity:.4}}
@media(min-width:640px){
.td-backdrop{align-items:center}
.td-panel{width:min(720px,calc(100% - 32px));max-height:86vh;border-radius:14px;padding:24px}
.td-grab{display:none}
.td-head{display:grid;grid-template-columns:220px 1fr;gap:16px}
.td-poster,.td-poster-placeholder{width:220px}
.td-info h2{font-size:22px}
}
@media(prefers-reduced-motion:reduce){
.td-skel-line{animation:none}
.td-panel{transition:none}
}
`;
}

// UMD footer.
if (typeof module !== 'undefined' && module.exports) module.exports = TitleDetail;
else if (typeof window !== 'undefined') window.TitleDetail = TitleDetail;
