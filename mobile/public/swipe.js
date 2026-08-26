// Pure swipe-gesture math for the recommendation rows. UMD so the browser gets
// `window.swipe` and the Node tests can `require('../public/swipe')`. No DOM here
// — app.js applies the returned color/label/transform and fires the action.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.swipe = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REMOVE_COLOR = '#f8d7da'; // light red  — swipe RIGHT to remove
  const SAVE_COLOR = '#d4edda';   // light green — swipe LEFT to add to watch later
  const REMOVE_LABEL = 'Remove';
  const SAVE_LABEL = 'Add to watch later';

  // Given the horizontal drag `dx` (px, + = right) and the row width, return the
  // live gesture state. The color + label appear as SOON as dx != 0 (the "as they
  // start to swipe" affordance); the action only commits once past the threshold.
  function swipeOutcome(dx, width, opts) {
    const threshold = (opts && opts.threshold) || 0.28;
    const ratio = width ? dx / width : 0;
    const past = Math.abs(ratio) >= threshold;
    if (dx > 0) {
      return { direction: 'right', action: past ? 'remove' : 'none', color: REMOVE_COLOR, label: REMOVE_LABEL, progress: Math.min(1, ratio / threshold) };
    }
    if (dx < 0) {
      return { direction: 'left', action: past ? 'save' : 'none', color: SAVE_COLOR, label: SAVE_LABEL, progress: Math.min(1, -ratio / threshold) };
    }
    return { direction: 'none', action: 'none', color: null, label: '', progress: 0 };
  }

  return { swipeOutcome, REMOVE_COLOR, SAVE_COLOR, REMOVE_LABEL, SAVE_LABEL };
});
