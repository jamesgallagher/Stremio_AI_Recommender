require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('path');
const store = require('./store');
const config = require('./config');
const rebuild = require('./rebuild');
const addon = require('./addon');
const portal = require('./portal');

store.ensureDirs();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // correct req.protocol/host behind Cloudflare Tunnel

// Request logging: all /api calls and every error response, with timestamps.
// docker logs ai-recommender  (or the Unraid log button) shows these.
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400 || req.originalUrl.startsWith('/api')) {
      console.log(`[http] ${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
    }
  });
  next();
});

// Public assets (Unraid icon, favicon, Stremio manifest logo) — intentionally
// outside admin auth: Unraid and Stremio fetch these without credentials.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
for (const f of ['logo.png', 'logo.svg', 'favicon.ico']) {
  app.get(`/${f}`, (req, res) => res.sendFile(path.join(PUBLIC_DIR, f)));
}

// CORS: Stremio clients fetch manifests/catalogs cross-origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Addon endpoints (public surface — token-guarded, never behind auth:
// Stremio/Nuvio cannot answer login prompts)
app.use('/addon/:token', addon.router);

// Admin auth: HTTP Basic, enabled when ADMIN_USER + ADMIN_PASSWORD are set.
// Protects the portal and its API only.
const crypto = require('crypto');
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const authEnabled = !!(ADMIN_USER && ADMIN_PASSWORD);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Brute-force protection: per-IP failed-attempt window. In-memory (resets on
// restart) — fine for a self-hosted admin portal. A successful login clears
// the counter so a shared/NATed IP isn't locked out by one bad client.
const AUTH_WINDOW_MS = 15 * 60e3;
const AUTH_MAX_FAILURES = 20;
const authFailures = new Map(); // ip -> { count, resetAt }

function authBlocked(ip) {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { authFailures.delete(ip); return false; }
  return entry.count >= AUTH_MAX_FAILURES;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  if (authFailures.size > 10000) { // scanner flood guard: drop expired entries
    for (const [k, v] of authFailures) if (now > v.resetAt) authFailures.delete(k);
  }
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count++;
    if (entry.count === AUTH_MAX_FAILURES) {
      console.warn(`[auth] ${ip}: blocked for ${AUTH_WINDOW_MS / 60e3} min after ${entry.count} failed login attempts`);
    }
  }
}

function adminAuth(req, res, next) {
  if (!authEnabled) return next();
  if (authBlocked(req.ip)) {
    return res.status(429).send('Too many failed login attempts — try again later');
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    const pass = rest.join(':');
    if (safeEqual(user, ADMIN_USER) && safeEqual(pass, ADMIN_PASSWORD)) {
      authFailures.delete(req.ip);
      return next();
    }
    recordAuthFailure(req.ip); // only count actual wrong credentials, not the initial challenge
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="AI Recommender admin"');
  res.status(401).send('Authentication required');
}

// Configure portal (Basic Auth via ADMIN_USER/ADMIN_PASSWORD; optionally also
// put Cloudflare Access in front of /configure and /api)
app.use('/api', adminAuth, portal.router);
app.use('/configure', adminAuth, express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/configure/'));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = parseInt(process.env.PORT || '7000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Recommender listening on :${PORT}`);
  console.log(`Configure portal: http://localhost:${PORT}/configure/`);
  console.log(authEnabled
    ? '[auth] Admin portal protected by Basic Auth (ADMIN_USER set)'
    : '[auth] WARNING: admin portal is UNPROTECTED — set ADMIN_USER and ADMIN_PASSWORD');
});

// Scheduler: keep lists warm and pruned so nobody ever waits on a cold open.
// Checks every profile hourly; ensureFresh() is a no-op unless the cache is
// past the 24h staleness threshold, and ensureExclusionsFresh() costs one
// last_activities call per profile when nothing new was watched.
// ensureSynced() mirrors the profile's Nuvio/Stremio watched history into Trakt
// first (when auto-scrobble is configured), so the exclusion refresh in the
// same tick picks up whatever it just pushed.
const scrobble = require('./services/scrobble');
const TICK_MS = 60 * 60e3;
function tick() {
  for (const profile of config.listProfiles()) {
    try {
      scrobble.ensureSynced(profile);
      rebuild.ensureFresh(profile);
      rebuild.ensureExclusionsFresh(profile);
    } catch (err) {
      console.error(`[scheduler] ${profile.name}: ${err.message}`);
    }
  }
}
setInterval(tick, TICK_MS);

// Also warm on boot (after a short delay so the container settles)
setTimeout(tick, 15e3);
