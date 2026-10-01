// Trainer UI — pure helpers for the portal Trainer tab (T3).
// In the browser it becomes a global; in Node it is module.exports, so
// test/smoke.js can require it. No DOM access and no timers at module level —
// the rate queue takes its timer functions as parameters (createRateQueue).
const TrainerUI = {};

// Filter views, in chip order.
TrainerUI.VIEWS = [['all', 'All'], ['unrated', 'Unrated'], ['rated', 'Rated'], ['loved', 'Loved ♥'], ['ignored', 'Ignored'], ['unfinished', 'Unfinished']];

// Every data-act value the portal controller switches on. The switch in
// index.html has a case for each entry — keep the two in sync.
TrainerUI.ACTIONS = ['star', 'clear', 'love', 'ignore', 'unignore', 'undo', 'unwatch', 'finished', 'rebuild', 'prev', 'next'];

// Tooltips for every Trainer control (R7). The companion (T4) does not use
// them. `star` is a template — {n} is replaced with the half's rating at
// render time. A disabled rate control (no Simkl) keeps "Connect Simkl to rate".
TrainerUI.TIPS = {
  star: 'Rate {n}/10 — saves to your Simkl ratings and steers Marquee',
  clear: 'Clear your rating (also removes it from Simkl)',
  love: 'Love it — rates 10/10. Loved films always count as a favourite in Marquee',
  unlove: 'Remove love — clears the 10/10 rating',
  ignore: "Ignore — keep it in your history but stop it shaping recommendations. It won't be recommended again",
  unignore: 'Stop ignoring — let this film shape recommendations again',
  undo: 'Undo the ignore',
  unwatch: 'Mark unwatched — removes it from your Simkl watch history (for films marked watched by mistake). It can be recommended again',
  finished: 'I finished it — marks it watched on Simkl and moves it into your history',
  rebuild: "Rebuild this profile's recommendations now instead of waiting for the hourly check",
  search: 'Search your watch history by title',
  prev: 'Previous page',
  next: 'Next page',
  chip_all: "Everything you've watched (except ignored)",
  chip_unrated: "Watched films you haven't rated yet",
  chip_rated: "Films you've rated (including loved)",
  chip_loved: 'Films you rated 10/10',
  chip_ignored: 'Films you told the recommender to ignore',
  chip_unfinished: 'Films you started but stopped before halfway — never recommended back',
};

// Same mapping as index.html's esc. null/undefined → ''.
TrainerUI.esc = (s) => {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

// watched_at ISO string → 'today' / 'yesterday' / 'N days ago' / an en-AU date.
TrainerUI.whenText = (iso, now) => {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '—';
  const DAY = 86400e3;
  const diff = now - t;
  if (diff < DAY) return 'today';
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  return new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Five star levels (1 full, 0.5 half, 0 empty) from a 1–10 rating.
TrainerUI.starsFromRating = (r) => {
  if (r == null) return [0, 0, 0, 0, 0];
  const out = [];
  for (let i = 0; i < 5; i++) {
    const lo = i * 2 + 1;
    const hi = i * 2 + 2;
    out.push(r >= hi ? 1 : (r === lo ? 0.5 : 0));
  }
  return out;
};

// Star half (index 0–4, 'left'/'right') → rating 1–10.
TrainerUI.ratingFromStarClick = (index, half) => index * 2 + (half === 'left' ? 1 : 2);

// ♥ shortcut: a 10 clears, anything else becomes a 10.
TrainerUI.nextRatingForHeart = (r) => (r === 10 ? null : 10);

// Star scrub (R9): map a pointer x (viewport px) to a 1–10 rating in half-star
// steps, from the 5 star-wrap hit boxes. `rects` is the 5 wraps' { left, width }
// in order. Within star i (0-based): the left half → 2i+1, the right half → 2i+2;
// the gap after star i (before star i+1) → 2i+2; before the first star → null;
// past the last star → 10. Pure — no DOM.
TrainerUI.ratingFromPointer = (x, rects) => {
  if (x < rects[0].left) return null;
  for (let i = 0; i < 5; i++) {
    const { left, width } = rects[i];
    const mid = left + width / 2;
    const right = left + width;
    if (x < mid) return 2 * i + 1;
    if (x <= right) return 2 * i + 2;
    // x is past star i: a gap before star i+1 → 2i+2, otherwise fall through
    // to the next star.
    if (i < 4 && x < rects[i + 1].left) return 2 * i + 2;
  }
  return 10; // past the last star
};

// A 1–10 rating (or null) → the 5 fill widths as '0%'|'50%'|'100%'.
TrainerUI.fillsForRating = (r) =>
  TrainerUI.starsFromRating(r).map(l => (l === 1 ? '100%' : (l === 0.5 ? '50%' : '0%')));

// Bind one .tr-stars group to pointer-event scrubbing. One implementation for
// mouse and touch: mouse hover previews in half-star steps, a click (pointerdown
// → pointerup) commits; touch taps preview, a sideways drag follows it, and
// pointerup commits; a vertical drag scrolls the page (touch-action: pan-y) and
// the browser fires pointercancel, which reverts the preview. Preview never
// saves — only onCommit goes through the rate queue. Only addEventListener and
// set/releasePointerCapture are used (no mouse/touch handlers); returns unbind().
TrainerUI.bindStarScrub = (groupEl, { getRects, isEnabled, onPreview, onCommit, onCancel }) => {
  let scrubbing = false;
  let last = null; // last previewed value
  const preview = (x) => {
    const r = TrainerUI.ratingFromPointer(x, getRects());
    last = r;
    onPreview(r);
  };
  const onPointerMove = (e) => {
    if (!isEnabled()) return;
    if (scrubbing) {
      const r = TrainerUI.ratingFromPointer(e.clientX, getRects());
      if (r !== last) { last = r; onPreview(r); }
    } else if (e.pointerType === 'mouse' && e.buttons === 0) {
      preview(e.clientX); // hover
    }
  };
  const onPointerDown = (e) => {
    if (!isEnabled()) return;
    if (e.button !== 0) return; // primary button only
    scrubbing = true;
    try { groupEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    preview(e.clientX);
  };
  const release = (e) => {
    try { groupEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };
  const onPointerUp = (e) => {
    if (!isEnabled() || !scrubbing) return;
    release(e);
    scrubbing = false;
    if (last != null) onCommit(last);
  };
  const onPointerCancel = (e) => {
    if (!isEnabled() || !scrubbing) return;
    release(e);
    scrubbing = false;
    onCancel(); // no commit
  };
  const onPointerLeave = (e) => {
    if (!isEnabled() || scrubbing) return;
    if (e.pointerType === 'mouse') onCancel();
  };
  groupEl.addEventListener('pointermove', onPointerMove);
  groupEl.addEventListener('pointerdown', onPointerDown);
  groupEl.addEventListener('pointerup', onPointerUp);
  groupEl.addEventListener('pointercancel', onPointerCancel);
  groupEl.addEventListener('pointerleave', onPointerLeave);
  return () => {
    groupEl.removeEventListener('pointermove', onPointerMove);
    groupEl.removeEventListener('pointerdown', onPointerDown);
    groupEl.removeEventListener('pointerup', onPointerUp);
    groupEl.removeEventListener('pointercancel', onPointerCancel);
    groupEl.removeEventListener('pointerleave', onPointerLeave);
  };
};

// Filter chips with counts; only the active one carries aria-pressed="true".
TrainerUI.chipsHtml = (counts, active) =>
  TrainerUI.VIEWS.map(([id, label]) =>
    `<button class="tr-chip" data-view="${id}" title="${TrainerUI.esc(TrainerUI.TIPS['chip_' + id])}" aria-pressed="${id === active ? 'true' : 'false'}">${label} <span class="tr-count">${counts[id] || 0}</span></button>`
  ).join('');

// One row of the history table. `now` feeds whenText. canRate=false (no Simkl)
// disables every rating control (stars, ♥, clear, finished) — ignore stays on.
TrainerUI.rowHtml = (item, { canRate, now }) => {
  const esc = TrainerUI.esc;
  const thumb = item.poster
    ? `<img class="tr-thumb" src="${esc(item.poster)}" alt="">`
    : '<span class="tr-thumb"></span>';
  const title = `${esc(item.title || '?')}${item.year ? ` <span class="muted">(${esc(item.year)})</span>` : ''}`;
  const genre = esc(item.genre || '—');
  const when = item.status === 'unfinished'
    ? `Stopped at ${esc(item.percent)}%`
    : TrainerUI.whenText(item.watched_at, now);
  const starsCell = () => {
    const levels = TrainerUI.starsFromRating(item.rating);
    const wraps = [];
    for (let i = 0; i < 5; i++) {
      const lv = levels[i];
      const fillPct = lv === 1 ? '100%' : (lv === 0.5 ? '50%' : '0%');
      const halfBtn = (half) => {
        const rating = TrainerUI.ratingFromStarClick(i, half);
        const disabled = !canRate || item.ignored;
        const tip = !canRate ? 'Connect Simkl to rate' : TrainerUI.TIPS.star.replace('{n}', rating);
        return `<button class="tr-star" data-act="star" data-half="${half}" data-rating="${rating}" aria-label="Rate ${rating} out of 10" title="${esc(tip)}"${disabled ? ' disabled' : ''}></button>`;
      };
      // Visual layer (glyph + fill) is separate from the two transparent hit
      // areas; the fill width comes from starsFromRating (0/0.5/1 → 0/50/100%).
      wraps.push(`<span class="tr-star-wrap"><span class="tr-glyph" aria-hidden="true">★</span><span class="tr-fill" aria-hidden="true" style="width:${fillPct}">★</span>${halfBtn('left')}${halfBtn('right')}</span>`);
    }
    const clearTip = !canRate ? 'Connect Simkl to rate' : TrainerUI.TIPS.clear;
    const clear = item.rating != null
      ? `<button class="ghost mini" data-act="clear" aria-label="Clear rating" title="${esc(clearTip)}"${canRate ? '' : ' disabled'}>×</button>`
      : '';
    return `<span class="tr-stars" role="group" aria-label="Your rating">${wraps.join('')}</span>${clear}`;
  };
  const unwatchBtn = () => `<button class="ghost mini" data-act="unwatch" aria-label="Mark unwatched" title="${esc(!canRate ? 'Connect Simkl to rate' : TrainerUI.TIPS.unwatch)}"${canRate ? '' : ' disabled'}>Unwatch</button>`;
  const acts = item.status === 'unfinished'
    ? `<button class="ghost mini" data-act="finished" aria-label="Mark finished" title="${esc(!canRate ? 'Connect Simkl to rate' : TrainerUI.TIPS.finished)}"${canRate ? '' : ' disabled'}>I finished it</button> <button class="ghost mini" data-act="ignore" aria-label="Ignore" title="${esc(TrainerUI.TIPS.ignore)}">Ignore</button>`
    : item.ignored
      ? `<button class="ghost mini" data-act="unignore" aria-label="Undo ignore" title="${esc(TrainerUI.TIPS.unignore)}">Unignore</button> ${unwatchBtn()}`
      : `<button class="ghost mini tr-heart" data-act="love" aria-pressed="${item.loved ? 'true' : 'false'}" aria-label="Love" title="${esc(!canRate ? 'Connect Simkl to rate' : (item.loved ? TrainerUI.TIPS.unlove : TrainerUI.TIPS.love))}"${canRate ? '' : ' disabled'}>♥</button> <button class="ghost mini" data-act="ignore" aria-label="Ignore" title="${esc(TrainerUI.TIPS.ignore)}">Ignore</button> ${unwatchBtn()}`;
  return `<div class="tr-row" data-key="${esc(item.key)}">
    <div class="tr-cell tr-title">${thumb}<span class="tr-tt">${title}</span></div>
    <div class="tr-cell">${genre}</div>
    <div class="tr-cell">${when}</div>
    <div class="tr-cell tr-rating">${item.status === 'unfinished' ? '—' : starsCell()}</div>
    <div class="tr-cell tr-acts">${acts}</div>
  </div>`;
};

// "N changes since the last build" banner with a Rebuild now button.
// '' when there is nothing to say and no rebuild in flight.
TrainerUI.bannerHtml = (training, now, { rebuilding = false } = {}) => {
  const n = training.changes_since_build || 0;
  const due = training.rebuild_due_at;
  if (n === 0 && due == null && !rebuilding) return '';
  let text;
  if (rebuilding) {
    text = 'Rebuilding… <span class="tr-joblabel"></span>';
  } else {
    text = `${n} change${n === 1 ? '' : 's'} since the last build`;
    if (due != null) {
      text += due <= now ? ' · rebuild due within the hour' : ` · rebuild in about ${Math.ceil((due - now) / 60000)} min`;
    }
  }
  return `<div class="tr-banner">${text} <button class="ghost mini" data-act="rebuild" title="${TrainerUI.esc(TrainerUI.TIPS.rebuild)}">Rebuild now</button></div>`;
};

TrainerUI.pagerText = (page, pageSize, total) =>
  `Page ${page} of ${Math.max(1, Math.ceil(total / pageSize))} · ${total} films`;

// Per-title rating queue (U5): pushes within delayMs collapse to one send with
// the latest value; at most one send in flight per key; a newer value that
// arrives while one is in flight waits and is sent right after it settles.
// Timers are injected, so tests drive them by hand.
TrainerUI.createRateQueue = ({ send, delayMs = 800, setTimer, clearTimer }) => {
  const states = new Map(); // key → { timer, inflight, next }
  const get = (key) => {
    let s = states.get(key);
    if (!s) { s = { timer: null, inflight: null, next: null }; states.set(key, s); }
    return s;
  };
  const settle = (key, rating, onSettle, err, result) => {
    const s = get(key);
    // 1. Clear inflight.
    s.inflight = null;
    // 2. If next exists and differs from the value just sent: move it to inflight
    //    (so pending(key) is now true). Otherwise clear next.
    let moved = false;
    if (s.next && s.next.rating !== rating) {
      s.inflight = { rating: s.next.rating, onSettle: s.next.onSettle };
      s.next = null;
      moved = true;
    } else {
      s.next = null;
    }
    // 3. Call onSettle — after the state update, so pending(key) reflects the
    //    queued "next" (a newer value on its way) rather than the settled one.
    onSettle(err, result);
    // 4. If step 2 moved a value into inflight, send it (no extra delay).
    if (moved) sendNow(key);
  };
  const sendNow = (key) => {
    const s = get(key);
    const { rating, onSettle } = s.inflight;
    let r;
    try { r = send(key, rating); } catch (e) { settle(key, rating, onSettle, e, null); return; }
    if (r && typeof r.then === 'function') {
      r.then(res => settle(key, rating, onSettle, null, res), err => settle(key, rating, onSettle, err, null));
    } else {
      settle(key, rating, onSettle, null, r);
    }
  };
  return {
    push(key, rating, onSettle) {
      const s = get(key);
      if (s.timer != null) { clearTimer(s.timer); s.timer = null; }
      s.timer = setTimer(() => {
        s.timer = null;
        if (s.inflight) { s.next = { rating, onSettle }; }
        else { s.inflight = { rating, onSettle }; sendNow(key); }
      }, delayMs);
    },
    pending(key) {
      const s = states.get(key);
      return !!s && (s.timer != null || !!s.inflight || !!s.next);
    },
  };
};

// ---- Trainer T4: pure helpers for the companion (no DOM) ----

// A 1–10 rating (or null) → a human-readable value string, so a rated card's
// state is never conveyed by colour alone (P7). null → 'Not rated'; 10 →
// '5★ · 10/10 · Loved'; otherwise `${r/2}★ · ${r}/10` with a .5 written as ½.
TrainerUI.ratingText = (r) => {
  if (r == null) return 'Not rated';
  if (r === 10) return '5★ · 10/10 · Loved';
  const whole = Math.floor(r / 2);
  const starStr = r % 2 === 1 ? (whole === 0 ? '½' : whole + '½') : String(whole);
  return starStr + '★ · ' + r + '/10';
};

// Card swipe → an action. `dx`/`dy` are the pointer's net movement (px, y up is
// negative), `w`/`h` the card's width/height. Up (dy<0 and |dy|>|dx|) → love;
// left (dx<0) → ignore; right (dx>0) → skip. The action only counts once the
// drag passes 22% of the height (up) or 28% of the width (left/right); below
// that the action is 'none' but label/progress are still set (live feedback).
TrainerUI.cardSwipeOutcome = (dx, dy, w, h) => {
  if (dx === 0 && dy === 0) return { action: 'none', label: '', progress: 0 };
  let label = '';
  let progress = 0;
  let action = 'none';
  if (dy < 0 && Math.abs(dy) > Math.abs(dx)) {
    label = 'Love ♥';
    progress = Math.min(1, -dy / (0.22 * h));
    if (progress >= 1) action = 'love';
  } else if (dx < 0) {
    label = 'Ignore';
    progress = Math.min(1, -dx / (0.28 * w));
    if (progress >= 1) action = 'ignore';
  } else if (dx > 0) {
    label = 'Skip';
    progress = Math.min(1, dx / (0.28 * w));
    if (progress >= 1) action = 'skip';
  }
  return { action, label, progress };
};

// The quick-train batch: watched, not ignored, not yet rated, and not already
// handled this session. Order preserved.
TrainerUI.pickQuickBatch = (items, handled) =>
  items.filter(i => i.status === 'watched' && !i.ignored && i.rating == null && !handled.has(i.key));

// The five quick-card actions, in order.
TrainerUI.QUICK_ACTIONS = ['love', 'ignore', 'skip', 'unwatch', 'undo'];

// K1: the companion's api() hands a plain object body to fetch, which
// serialises to "[object Object]" and the server's JSON parser rejects with 400.
// jsonRequest JSON-encodes an object body; a string body or no body passes
// through unchanged. Pure — never mutates its input.
TrainerUI.jsonRequest = (opts) => {
  if (!opts || opts.body == null || typeof opts.body === 'string') return opts;
  return { ...opts, body: JSON.stringify(opts.body) };
};

// K3: a pending advance from a card only applies if that card is still the
// current one (a re-rate within the delay must not skip past the next card).
TrainerUI.shouldAdvance = (currentKey, fromKey) => currentKey === fromKey;

if (typeof module !== 'undefined' && module.exports) module.exports = TrainerUI; else window.TrainerUI = TrainerUI;
