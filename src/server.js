require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('path');
const store = require('./store');
const config = require('./config');
const rebuild = require('./rebuild');
const addon = require('./addon');
const portal = require('./portal');
const settings = require('./settings');

store.ensureDirs();
config.migrateSecrets(); // encrypt plaintext secrets at rest if SECRET_KEY is set (or report state)

// v6 one-time migration: seed global Server Config keys from the "James" profile
// if settings.json doesn't exist yet (docs/v6-ui.md). No-op once set up.
try {
  const seeded = settings.migrateFromProfiles(config.listProfiles());
  if (seeded) console.log(`[settings] Server Config seeded from profile "${seeded.seededFrom}"`);
} catch (err) {
  console.warn(`[settings] migration skipped: ${err.message}`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // correct req.protocol/host behind Cloudflare Tunnel

// Request logging: all /api calls and every error response, with timestamps.
// docker logs ai-recommender  (or the Unraid log button) shows these.
// The OAuth callback query is redacted (M4): code/state are sensitive.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400 || req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/mobile/api')) {
      let url = req.originalUrl;
      if (url.startsWith('/simkl/oauth2/callback')) url = '/simkl/oauth2/callback [query redacted]';
      // Duration is server-side handling time (receive → response flushed to the
      // socket); it excludes tunnel transit, so a fast time here + a slow client
      // means the delay is in the network/proxy, not the app.
      console.log(`[http] ${new Date().toISOString()} ${req.method} ${url} -> ${res.statusCode} (${Date.now() - start}ms)`);
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

// Mobile Companion app (/mobile): passwordless OTP login + per-profile views.
// Has its own OTP session auth — deliberately NOT behind the admin Basic Auth
// below (family members are not admins). See mobile/README.md.
const mobile = require('../mobile/server/router');
app.use('/mobile', mobile.router);

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

// Simkl V2 OAuth callback — outside admin auth (the browser is redirected
// back by Simkl with no credentials). The query carries code + state; the
// code_verifier and client_secret stay server-side (M4). The HTTP log
// redacts the query so no tokens/verifier ever appear in logs.
const simklAuthV2 = require('./services/simklAuthV2');
app.get('/simkl/oauth2/callback', async (req, res) => {
  const { code, state, error, iss } = req.query;
  // Cancellation: Simkl redirects back with error=access_denied when the user
  // denies or closes the consent page. This is NOT a failure — the existing
  // grant (if any) is preserved and the user is redirected to the portal.
  // Bind the cancellation to a real pending state and consume it. If the
  // state is missing/unknown/expired, reject safely (do not treat as a
  // successful cancellation).
  if (error) {
    const config = require('./config');
    let consumed = false;
    for (const p of config.listProfiles()) {
      if (simklAuthV2.getFlow(p.id)?.state === state) {
        simklAuthV2.consumeFlow(p.id);
        consumed = true;
        break;
      }
    }
    if (consumed) {
      res.redirect('/configure/#simkl');
    } else {
      // No matching pending flow: reject safely, show the outcome.
      res.redirect(`/configure/#simkl?error=${encodeURIComponent('V2 cancellation rejected — no matching pending flow')}`);
    }
    return;
  }
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });
  // Validate the callback issuer (Simkl supplies `iss` on the callback query).
  // This is the first trust boundary: a callback from a non-Simkl issuer is
  // rejected before any token exchange. A missing issuer is also rejected —
  // the documented exact issuer is required.
  if (iss !== 'https://simkl.com') {
    res.redirect(`/configure/#simkl?error=${encodeURIComponent('Unexpected callback issuer — start the connection again')}`);
    return;
  }
  // The callback is tied to the profile that started the flow. We look up
  // the profile by matching the state against stored flows.
  const config = require('./config');
  let matched = null;
  for (const p of config.listProfiles()) {
    if (simklAuthV2.getFlow(p.id)?.state === state) { matched = p; break; }
  }
  if (!matched) {
    // No matching pending flow: the flow expired or was already consumed
    // (replay). Redirect to the portal with a message; the existing grant
    // is preserved.
    res.redirect(`/configure/#simkl?error=${encodeURIComponent('V2 flow expired or already used — start the connection again')}`);
    return;
  }
  try {
    const tokens = await simklAuthV2.handleCallback(matched, { code, state, iss });
    // Bounded verification: capture the stable Simkl account ID via
    // /users/settings BEFORE persisting the new grant. If the old grant has
    // a known account_id and the new grant's account_id differs, reject the
    // promotion (preserve the old grant) — a silent account switch would
    // corrupt watched-history data and later writes.
    const simkl = require('./services/simkl');
    const oldAuth = matched.simkl_auth;
    const oldAccountId = oldAuth?.account_id || null;
    let info = null;
    try {
      info = await simkl.accountName(matched.keys.simkl_v2_client_id, tokens.access_token);
    } catch { /* account info is best-effort */ }
    const newAccountId = info?.id || null;
    // Guard: if both old and new stable Simkl IDs are available and differ,
    // reject the promotion and preserve the old grant.
    if (oldAccountId && newAccountId && oldAccountId !== newAccountId) {
      res.redirect(`/configure/#simkl?error=${encodeURIComponent('Simkl account mismatch — the new authorization is for a different Simkl account. The existing connection is preserved. Disconnect first to switch accounts.')}`);
      return;
    }
    // Persist the full grant: absolute expiry, scope, account identity.
    config.updateProfile(matched.id, {
      simkl_auth: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        scope: tokens.scope,
        username: info?.name || tokens.username || undefined,
        account_id: newAccountId || undefined,
        connected_at: Date.now(),
        version: 2,
        client_id: matched.keys.simkl_v2_client_id,
      },
    });
    // Store a check result for the new grant's fingerprint so the Configure
    // poll can complete. The bounded verification (/users/settings) succeeded
    // → `connected`; failed → `token_stored` (never label an unverified
    // grant `connected`).
    const { simklChecks, grantFingerprint } = require('./portal');
    const newProfile = config.getProfile(matched.id);
    const checkState = info ? 'connected' : 'token_stored';
    simklChecks.set(grantFingerprint(newProfile), {
      state: checkState,
      message: info ? 'Connected and verified' : 'Token stored — run Check connection to verify live',
      username: info?.name || tokens.username || null,
      account_id: newAccountId || null,
      checked_at: Date.now(),
    });
    // Redirect to the portal's Simkl tab so the user sees the result.
    res.redirect('/configure/#simkl');
  } catch (err) {
    // A failed exchange (bad code, expired, wrong issuer, insufficient scope,
    // credential change) must NOT overwrite the existing grant. Redirect to
    // the portal with a safe, actionable message. Never echo the provider
    // body to the browser (M4).
    const msg = err.state === 'credential_changed'
      ? 'Simkl Client ID changed during the flow — start again'
      : err.state === 'insufficient_scope'
        ? 'Simkl granted a read-only token — re-authorize with the full scope'
        : err.state === 'invalid_issuer'
          ? 'Unexpected token issuer — start the connection again'
          : 'V2 OAuth failed — start the connection again';
    res.redirect(`/configure/#simkl?error=${encodeURIComponent(msg)}`);
  }
});

const PORT = parseInt(process.env.PORT || '7000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Recommender listening on :${PORT}`);
  console.log(`Configure portal: http://localhost:${PORT}/configure/`);
  console.log(authEnabled
    ? '[auth] Admin portal protected by Basic Auth (ADMIN_USER set)'
    : '[auth] WARNING: admin portal is UNPROTECTED — set ADMIN_USER and ADMIN_PASSWORD');
});

// Scheduler: keep lists warm and pruned so nobody ever waits on a cold open.
// Checks every profile hourly; ensureFresh() is a no-op unless a curated extra
// catalog is past the 24h staleness threshold. ensureSynced() mirrors the
// profile's Nuvio/Stremio watched history into Simkl when auto-scrobble is
// configured.
const scrobble = require('./services/scrobble');
const watchedStore = require('./watchedStore');
const recommendationStore = require('./recommendationStore');
const jobs = require('./jobs');
const aiSchedule = require('./aiSchedule');
const mobileOtpStore = require('../mobile/server/otpStore');
const TICK_MS = 60 * 60e3;
async function tick() {
  for (const profile of config.listProfiles()) {
    try {
      // A rebuild or a Trakt import in flight is already moving this profile's
      // watched history and pool. Skip the tick's opportunistic sync/build so we
      // don't kick off a build off a half-finished import (the mid-import
      // activities bump would otherwise pull a partial history and rebuild on it).
      if (jobs.isBusy(profile.id)) continue;
      // Awaitable provider→Simkl sync (Stage 3): the tick waits for the sync
      // to complete before proceeding to the local backfill and the AI
      // schedule consider. A failure logs a warning and resolves (the tick
      // proceeds to the local backfill even when the provider/Simkl sync
      // fails).
      await scrobble.ensureSyncedAsync(profile);
      rebuild.ensureFresh(profile);
      // v6: pull Simkl watched history (activities-gated — a no-op when
      // nothing changed) into the local store, top up genre/age enrichment,
      // then let the AI schedule decide whether a heavy build is due. The
      // local backfill is request-time and network-free (M1.2); the heavy
      // watch-driven build is deferred to the daily/weekly window
      // (M1.3/M1.4).
      if (profile.simkl_auth?.access_token) {
        try {
          await watchedStore.syncFromSimkl(profile);
          await watchedStore.enrichPending(profile.id);
        } catch (err) {
          console.warn(`[simkl] ${profile.name}: watched sync/enrich failed — ${err.message}`);
        }
        // AI schedule consider: runs the local due test and enqueues at most
        // one heavy recs job per profile through the existing global queue.
        // Never calls an external API. A no-op when the daily/weekly window
        // is not due or the history is unchanged.
        aiSchedule.consider(profile, Date.now()).catch((err) =>
          console.warn(`[ai-schedule] ${profile.name}: consider failed — ${err.message}`)
        );
      }
      // v6 decay: retire persistently-shown-but-ignored recommendations. Cheap
      // local SQL scan. Opt-in per profile (v6.37) — decayWindowMsFor returns
      // null when the profile has title decay off, so we skip it entirely.
      try {
        const decayWindowMs = recommendationStore.decayWindowMsFor(profile);
        if (decayWindowMs) recommendationStore.applyDecay(profile.id, { windowMs: decayWindowMs });
      } catch (err) { console.warn(`[decay] ${profile.name}: ${err.message}`); }
    } catch (err) {
      console.error(`[scheduler] ${profile.name}: ${err.message}`);
    }
  }
  // Mobile Companion housekeeping: drop expired OTP codes + sessions.
  try {
    const pruned = mobileOtpStore.pruneExpired();
    if (pruned.otp || pruned.sessions) console.log(`[mobile] pruned ${pruned.otp} expired OTP(s), ${pruned.sessions} session(s)`);
  } catch (err) { console.warn(`[mobile] prune failed: ${err.message}`); }
}
setInterval(tick, TICK_MS);

// Also warm on boot (after a short delay so the container settles)
setTimeout(() => { tick().catch((err) => console.error(`[scheduler] boot tick failed: ${err.message}`)); }, 15e3);
