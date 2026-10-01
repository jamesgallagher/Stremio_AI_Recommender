// Trainer UI — pure helpers for the portal Trainer tab (T3).
// In the browser it becomes a global; in Node it is module.exports, so
// test/smoke.js can require it. No DOM access and no timers at module level —
// the rate queue takes its timer functions as parameters (createRateQueue).
const TrainerUI = {};

// Filter views, in chip order.
TrainerUI.VIEWS = [['all', 'All'], ['unrated', 'Unrated'], ['rated', 'Rated'], ['loved', 'Loved ♥'], ['ignored', 'Ignored'], ['unfinished', 'Unfinished']];

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

// Filter chips with counts; only the active one carries aria-pressed="true".
TrainerUI.chipsHtml = (counts, active) =>
  TrainerUI.VIEWS.map(([id, label]) =>
    `<button class="tr-chip" data-view="${id}" aria-pressed="${id === active ? 'true' : 'false'}">${label} <span class="tr-count">${counts[id] || 0}</span></button>`
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
    const starDis = !canRate ? ' disabled title="Connect Simkl to rate"' : (item.ignored ? ' disabled' : '');
    const wraps = [];
    for (let i = 0; i < 5; i++) {
      const lv = levels[i];
      const halfBtn = (half) => {
        const rating = TrainerUI.ratingFromStarClick(i, half);
        const on = (half === 'left' ? lv >= 0.5 : lv === 1) ? ' tr-on' : '';
        return `<button class="tr-star${on}" data-half="${half}" data-rating="${rating}" aria-label="Rate ${rating} out of 10"${starDis}>★</button>`;
      };
      wraps.push(`<span class="tr-star-wrap">${halfBtn('left')}${halfBtn('right')}</span>`);
    }
    const clearDis = canRate ? '' : ' disabled title="Connect Simkl to rate"';
    const clear = item.rating != null
      ? `<button class="ghost mini" data-act="clear" aria-label="Clear rating"${clearDis}>×</button>`
      : '';
    return `<span class="tr-stars" role="group" aria-label="Your rating">${wraps.join('')}</span>${clear}`;
  };
  const acts = item.status === 'unfinished'
    ? `<button class="ghost mini" data-act="finished" aria-label="Mark finished"${canRate ? '' : ' disabled title="Connect Simkl to rate"'}>I finished it</button> <button class="ghost mini" data-act="ignore" aria-label="Ignore">Ignore</button>`
    : item.ignored
      ? '<button class="ghost mini" data-act="unignore" aria-label="Undo ignore">Unignore</button>'
      : `<button class="ghost mini tr-heart" data-act="love" aria-pressed="${item.loved ? 'true' : 'false'}" aria-label="Love"${canRate ? '' : ' disabled title="Connect Simkl to rate"'}>♥</button> <button class="ghost mini" data-act="ignore" aria-label="Ignore">Ignore</button>`;
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
  return `<div class="tr-banner">${text} <button class="ghost mini" data-act="rebuild">Rebuild now</button></div>`;
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
    onSettle(err, result);
    s.inflight = null;
    if (s.next && s.next.rating !== rating) {
      const carry = s.next;
      s.next = null;
      s.inflight = { rating: carry.rating, onSettle: carry.onSettle };
      sendNow(key);
    } else {
      s.next = null;
    }
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

if (typeof module !== 'undefined' && module.exports) module.exports = TrainerUI; else window.TrainerUI = TrainerUI;
