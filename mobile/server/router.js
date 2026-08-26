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

const router = express.Router();
router.use(express.json());

const COOKIE = 'mobile_sid';
// Secure cookies need HTTPS (production runs behind the Cloudflare Tunnel).
// MOBILE_INSECURE_COOKIE=1 drops Secure for bare-HTTP LAN testing only.
const secureCookies = process.env.MOBILE_INSECURE_COOKIE !== '1';

// Minimal cookie reader — avoids adding cookie-parser. Returns '' if absent.
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setSessionCookie(res, token) {
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/mobile', 'SameSite=Lax', `Max-Age=${auth.SESSION_DAYS * 24 * 3600}`];
  if (secureCookies) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  const attrs = [`${COOKIE}=`, 'HttpOnly', 'Path=/mobile', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookies) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// THE isolation guard: attaches req.profile from the session cookie, or 401.
// Every data route (Steps 3–4) uses req.profile.id, never a client-supplied id.
function requireSession(req, res, next) {
  const token = readCookie(req, COOKIE);
  const profile = auth.resolveSession(token);
  if (!profile) return res.status(401).json({ error: 'Not signed in' });
  req.profile = profile;
  req.sessionToken = token;
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
  setSessionCookie(res, result.token);
  res.json({ ok: true, profile: result.profile });
});

// ---- session-guarded ----
router.post('/api/auth/logout', requireSession, (req, res) => {
  auth.logout(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/api/me', requireSession, (req, res) => {
  res.json({
    profile: {
      id: req.profile.id,
      name: req.profile.name,
      simkl_connected: !!req.profile.simkl_auth?.access_token,
    },
  });
});

// ---- feature data (session-guarded) ----
router.get('/api/search', requireSession, handlers.searchHandler);       // Step 3: TMDB search
router.post('/api/watchlist', requireSession, handlers.watchlistHandler); // Step 3: add to Simkl plan-to-watch
router.get('/api/recommendations', requireSession, handlers.recommendationsHandler);   // Step 4: Movies/Shows tabs
router.post('/api/recommend/suppress', requireSession, handlers.suppressHandler);      // Step 4: swipe-right remove
router.post('/api/recommend/unsuppress', requireSession, handlers.unsuppressHandler);  // Step 4: undo a remove

// ---- app config (public) ----
// A single source for the SPA's app name/version, no session needed.
router.get('/api/config', (req, res) => {
  res.json({ name: 'AI Recommender', version: require('../../package.json').version });
});

// ---- static SPA shell (Step 2) ----
// Public assets (index.html, app.js, styles.css, ui.js, manifest) — like
// /configure. The DATA under /api/* above is what requires a session; the shell
// itself is public. Registered AFTER the API routes so it can never shadow them.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
router.use(express.static(PUBLIC_DIR));

// SPA fallback: a client-side deep link (e.g. /mobile/search) has no matching
// file — serve index.html so the front-end router takes over. Never for /api/*
// (those must 404 as API, not HTML) and never for non-GET.
router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

module.exports = { router, requireSession, readCookie, setSessionCookie, clearSessionCookie, COOKIE };
