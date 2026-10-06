// Pure front-end helpers — routing + view selection. UMD so the browser gets
// `window.ui` and the Node test suite can `require('../public/ui')`. Nothing here
// touches the DOM, fetch, or globals, so it's unit-testable offline (the DOM/
// fetch wiring lives in app.js and is exercised in the e2e/browser pass).
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.ui = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROUTES = ['login', 'setup', 'recs', 'search', 'settings', 'trainer'];
  const DEFAULT_VIEW = 'recs'; // authed landing

  // '#/search' -> { view:'search' }; '', '#/' -> default; unknown -> default.
  function parseRoute(hash) {
    const raw = String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\//, '');
    const seg = raw.split(/[?/]/)[0].trim().toLowerCase();
    return { view: ROUTES.indexOf(seg) !== -1 ? seg : DEFAULT_VIEW, params: {} };
  }

  // The view to actually render given auth + the requested route.
  // setupNeeded -> always 'setup' (zero profiles, Initial User Creation).
  // Not signed in -> always 'login'. Signed in -> the route, but
  // 'login'/'setup'/unknown fall back to the default.
  function viewForState(state) {
    const s = state || {};
    if (s.setupNeeded) return 'setup';
    if (!s.authed) return 'login';
    const r = s.route;
    if (!r || r === 'login' || r === 'setup' || ROUTES.indexOf(r) === -1) return DEFAULT_VIEW;
    return r;
  }

  return { ROUTES, DEFAULT_VIEW, parseRoute, viewForState };
});
