// Mobile Companion router — mounted at /mobile in src/server.js, deliberately
// OUTSIDE the admin Basic Auth that guards /api (family members are not admins).
//
// The two /auth routes are public (they issue/verify codes). Everything else
// sits behind requireSession, which binds the request to one profile via the
// session cookie — the isolation boundary. requireSession is exported so the
// later steps' route files reuse the exact same guard.
const express = require('express');
const path = require('path');
const auth = require('./auth');
const handlers = require('./handlers');
const config = require('../../src/config');
const sessionAuth = require('../../src/sessionAuth');
const { readCookie, setSessionCookie, clearSessionCookies, sessionFromRequest, COOKIE } = sessionAuth;

const router = express.Router();
router.use(express.json());

// Never cache ANYTHING under /mobile. The per-session API must always be fresh,
// AND forcing fresh SPA assets (index.html/app.js/…) means a new deploy is never
// masked by a stale cached bundle — the cause of "still broken after I deployed"
// (the browser kept running old app.js). Static + fallback also disable
// etag/last-modified below so there are no conditional requests at all.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// THE isolation guard: attaches req.profile from the session cookie, or 401.
// Every data route (Steps 3–4) uses req.profile.id, never a client-supplied id.
function requireSession(req, res, next) {
  const session = sessionFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  req.profile = session.profile;
  req.sessionToken = session.token;
  next();
}

const appUrl = () => (process.env.EXTERNAL_URL ? `${process.env.EXTERNAL_URL.replace(/\/$/, '')}/mobile` : '');

// ---- auth (public) ----
// Always answers 200 { ok:true } — a code is only generated + sent when the email
// maps to exactly one profile. Internal errors are swallowed to keep the response
// generic (no account enumeration by status or timing).
router.post('/api/auth/request', async (req, res) => {
  const email = (req.body || {}).email;
  const who = String(email || '').trim().toLowerCase() || '(no email)';
  try {
    const r = await auth.requestOtp(email, { appUrl: appUrl() });
    console.log(`[mobile] auth/request for ${who} -> issued=${r.issued} reason=${r.reason}`);
  } catch (err) {
    console.warn(`[mobile] auth/request errored for ${who}: ${err.message}`);
  }
  res.json({ ok: true });
});

router.post('/api/auth/verify', (req, res) => {
  const { email, code } = req.body || {};
  const who = String(email || '').trim().toLowerCase() || '(no email)';
  let result;
  try {
    result = auth.verifyOtp(email, code);
  } catch (err) {
    console.error(`[mobile] verify errored for ${who}: ${err.message}`);
    return res.status(503).json({ error: 'Verification failed — please try again' });
  }
  if (!result.ok) {
    // Diagnostic: reason is one of no-code | bad-code | expired | locked | no-profile.
    console.warn(`[mobile] verify DENIED for ${who} — reason=${result.reason} codeLen=${String(code || '').length}`);
    return res.status(401).json({ error: 'Invalid or expired code' });
  }
  console.log(`[mobile] verify OK for ${who} -> ${result.profile.name}`);
  setSessionCookie(res, result.token, Math.floor((result.expiresAt - Date.now()) / 1000));
  res.json({ ok: true, profile: result.profile });
});

// ---- setup (public, only when zero profiles) ----
router.get('/api/setup', (req, res) => {
  res.json({ needed: config.listProfiles().length === 0 });
});

router.post('/api/setup/request', async (req, res) => {
  const { name, email } = req.body || {};
  try {
    const r = await auth.requestSetupOtp({ name, email }, { appUrl: appUrl() });
    if (!r.ok) {
      const statusMap = { BAD_NAME: 400, BAD_EMAIL: 400, SETUP_DONE: 409, RATE_LIMITED: 429 };
      const msgMap = {
        BAD_NAME: 'Enter a name (up to 40 characters).',
        BAD_EMAIL: 'Enter a valid email address.',
        SETUP_DONE: 'Setup is already complete — sign in instead.',
        RATE_LIMITED: 'Too many codes requested — wait 15 minutes.',
      };
      res.status(statusMap[r.code] || 400).json({ error: msgMap[r.code] || r.code });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`[setup] request errored: ${err.message}`);
    res.status(503).json({ error: 'Setup request failed' });
  }
});

router.post('/api/setup/verify', (req, res) => {
  const { email, code } = req.body || {};
  let result;
  try {
    result = auth.verifySetupOtp(email, code);
  } catch (err) {
    console.error(`[setup] verify errored: ${err.message}`);
    res.status(503).json({ error: 'Verification failed — please try again' });
    return;
  }
  if (!result.ok) {
    console.warn(`[setup] verify DENIED for ${email} — reason=${result.reason}`);
    if (result.reason === 'SETUP_DONE') {
      res.status(409).json({ error: 'Setup is already complete — sign in instead.' });
      return;
    }
    res.status(401).json({ error: 'Invalid or expired code' });
    return;
  }
  setSessionCookie(res, result.token, Math.floor((result.expiresAt - Date.now()) / 1000));
  res.json({ ok: true, profile: result.profile });
});

// ---- session-guarded ----
router.post('/api/auth/logout', requireSession, (req, res) => {
  auth.logout(req.sessionToken);
  clearSessionCookies(res);
  res.json({ ok: true });
});

router.get('/api/me', requireSession, (req, res) => {
  res.json({
    profile: {
      id: req.profile.id,
      name: req.profile.name,
      is_admin: req.profile.is_admin === true,
      simkl_connected: !!req.profile.simkl_auth?.access_token,
    },
  });
});

// ---- feature data (session-guarded) ----
router.get('/api/search', requireSession, handlers.searchHandler);       // Step 3: TMDB search
router.post('/api/watchlist', requireSession, handlers.watchlistHandler); // Step 3: add to Simkl plan-to-watch
router.post('/api/watchlist/remove', requireSession, handlers.watchlistRemoveHandler); // MW-04: remove from Simkl plan-to-watch
router.get('/api/recommendations', requireSession, handlers.recommendationsHandler);   // Step 4/5: catalog or entire-list view
router.post('/api/recommend/suppress', requireSession, handlers.suppressHandler);      // Step 4: swipe-right remove
router.post('/api/recommend/unsuppress', requireSession, handlers.unsuppressHandler);  // Step 4: undo a remove
router.post('/api/watched', requireSession, handlers.watchedHandler);                  // MW-00: mark as watched (Simkl history)
router.get('/api/trainer', requireSession, handlers.trainerHandler);                  // Trainer T1: list watch history
router.post('/api/trainer/rate', requireSession, handlers.trainerRateHandler);        // Trainer T1: rate 1–10 (or clear)
router.post('/api/trainer/ignore', requireSession, handlers.trainerIgnoreHandler);    // Trainer T1: ignore / un-ignore
router.post('/api/trainer/finished', requireSession, handlers.trainerFinishedHandler);// Trainer T1: mark unfinished film finished
router.post('/api/trainer/unwatched', requireSession, handlers.trainerUnwatchedHandler); // Trainer T3.1: mark unwatched
router.post('/api/trainer/rebuild', requireSession, handlers.trainerRebuildHandler);  // Trainer T1: trigger a rebuild
router.get('/api/settings', requireSession, handlers.settingsGetHandler);              // Step 5: editable filters + view pref
router.post('/api/settings', requireSession, handlers.settingsPostHandler);            // Step 5: save filters + view pref
router.get('/api/catalogs/:catalogId/preview', requireSession, handlers.catalogPreviewHandler); // CP-02: served-titles preview (session-scoped)

// ---- app config (public) ----
// A single source for the SPA's app name/version, no session needed.
router.get('/api/config', (req, res) => {
  res.json({ name: 'AI Recommender', version: require('../../package.json').version });
});

// ---- static SPA shell (Step 2) ----
// Public assets (index.html, app.js, styles.css, ui.js, manifest) — like
// /configure. The DATA under /api/* above is what requires a session; the shell
// itself is public. Registered AFTER the API routes so it can never shadow them.
// Trainer T4: the portal's pure Trainer helpers, served to the companion as the
// SAME file (no fork). Public like the rest of the SPA shell — it holds no data.
router.get('/trainer-ui.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').sendFile(path.join(__dirname, '..', '..', 'public', 'trainer-ui.js'));
});
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
router.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'), // always serve the latest bundle
}));

// SPA fallback: a client-side deep link (e.g. /mobile/search) has no matching
// file — serve index.html so the front-end router takes over. Never for /api/*
// (those must 404 as API, not HTML) and never for non-GET.
router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), {
    etag: false, lastModified: false, headers: { 'Cache-Control': 'no-store' },
  });
});

module.exports = { router, requireSession, readCookie, setSessionCookie, clearSessionCookies, COOKIE };
