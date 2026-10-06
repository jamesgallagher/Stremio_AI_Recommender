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

// AUTH-1: shared email-OTP sign-in for /mobile and /configure (no Basic Auth).
// requireAdminApi guards /api (401 {auth:'signin'} / 403 {auth:'forbidden'});
// requireAdminPage guards /configure (302 → /mobile/?next=%2Fconfigure%2F).
const sessionAuth = require('./sessionAuth');

// Boot migration: ensure at least one admin exists (promote the oldest
// profile with an email if none is admin).
try {
  const promo = config.promoteFirstAdminIfMissing();
  if (promo.reason === 'promoted') console.log(`[auth] promoted "${promo.promoted}" to admin (no admin existed)`);
} catch (err) {
  console.warn(`[auth] promoteFirstAdminIfMissing failed: ${err.message}`);
}

// Configure portal (session auth via air_sid cookie; optionally also put
// Cloudflare Access in front of /configure and /api)
app.use('/api', sessionAuth.requireAdminApi, portal.router);
app.use('/configure', sessionAuth.requireAdminPage, express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/configure/'));

app.get('/health', (req, res) => res.json({ ok: true }));

// Simkl V2 OAuth callback — outside admin auth (the browser is redirected
// back by Simkl with no credentials). The query carries code + state; the
// code_verifier and client_secret stay server-side (M4). The HTTP log
// redacts the query so no tokens/verifier ever appear in logs.
const simklAuthV2 = require('./services/simklAuthV2');
app.get('/simkl/oauth2/callback', async (req, res) => {
  const { code, state, error, iss } = req.query;
  let callbackProfileId = null;
  // Profile ID is safe UI routing metadata, never an OAuth credential.
  const redirect = target => res.redirect(callbackProfileId
    ? target + (target.includes('?') ? '&' : '?') + 'profile=' + encodeURIComponent(callbackProfileId)
    : target);
  // Cancellation: Simkl redirects back with error=access_denied when the user
  // denies or closes the consent page. This is NOT a failure — the existing
  // grant (if any) is preserved and the user is redirected to the portal.
  // Bind the cancellation to a real pending state and consume it. If the
  // state is missing/unknown/expired, reject safely (do not treat as a
  // successful cancellation).
  if (error) {
    const config = require('./config');
    const simklConnectionFlow = require('./services/simklConnectionFlow');
    let consumed = false;
    for (const p of config.listProfiles()) {
      const flowRec = simklAuthV2.getFlow(p.id);
      if (flowRec?.state === state) {
        // Mark the specific attempt failed on OAuth cancellation.
        if (flowRec.flow_id) {
          const cancelAttempt = simklConnectionFlow.getAttempt(flowRec.flow_id);
          if (cancelAttempt && (cancelAttempt.state === 'pending' || cancelAttempt.state === 'verifying')) {
            simklConnectionFlow.completeAttempt(flowRec.flow_id, 'failed', null, 'Connection cancelled — start again');
          }
        }
        callbackProfileId = p.id;
        simklAuthV2.consumeFlow(p.id);
        consumed = true;
        break;
      }
    }
    if (consumed) {
      redirect('/configure/#simkl?error=' + encodeURIComponent('Connection cancelled — start again'));
    } else {
      // No matching pending flow: reject safely, show the outcome.
      redirect(`/configure/#simkl?error=${encodeURIComponent('V2 cancellation rejected — no matching pending flow')}`);
    }
    return;
  }
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });
  // Match state first so handleCallback can fail the specific attempt on a
  // missing/wrong issuer. It validates the exact issuer before token exchange.
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
    redirect(`/configure/#simkl?error=${encodeURIComponent('V2 flow expired or already used — start the connection again')}`);
    return;
  }
  // Capture the attempt's flow_id BEFORE the token exchange (which consumes
  // the flow). This ensures we reference the specific attempt that started
  // this flow, not a newer one that may have superseded it during the await.
  const simklConnectionFlow = require('./services/simklConnectionFlow');
  callbackProfileId = matched.id;
  const flowRecord = simklAuthV2.getFlow(matched.id);
  const flowId = flowRecord?.flow_id || null;
  try {
    const tokens = await simklAuthV2.handleCallback(matched, { code, state, iss });
    // §2: Guarded promotion. The token is in a local variable; not persisted yet.
    const attempt = flowId ? simklConnectionFlow.getAttempt(flowId) : null;
    if (!attempt || (attempt.state !== 'pending' && attempt.state !== 'verifying')) {
      // No active attempt for this profile (invalidated, superseded, or never started).
      if (attempt) simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Connection changed — start again');
      redirect(`/configure/#simkl?error=${encodeURIComponent('Connection changed — start again')}`);
      return;
    }
    // Mark the attempt as verifying (token obtained, identity verification underway).
    simklConnectionFlow.markVerifying(attempt.flowId);
    // §3: Bounded identity verification (10 s deadline, includes JSON parse).
    const identity = await simklConnectionFlow.verifyIdentity(matched.keys.simkl_v2_client_id, tokens.access_token);
    // §2: Final guard — re-read the profile immediately before writing.
    // Require: profile exists; attempt is current and unexpired; active grant
    // matches the starting snapshot; relevant credentials match.
    const currentProfile = config.getProfile(matched.id);
    const guardOk = simklConnectionFlow.isCurrent(flowId, currentProfile, ['verifying']);
    if (!guardOk) {
      simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Connection changed — start again');
      redirect(`/configure/#simkl?error=${encodeURIComponent('Connection changed — start again')}`);
      return;
    }
    // §3 outcome — no await between guard, grant update, check-cache update, and attempt completion.
    const oldAuth = currentProfile.simkl_auth;
    const oldAccountId = oldAuth?.account_id ? String(oldAuth.account_id) : null;
    const newAccountId = identity.id || null;
    const { simklChecks, grantFingerprint } = require('./portal');
    if (identity.ok) {
      if (oldAccountId && newAccountId && oldAccountId !== newAccountId) {
        // Valid identity + known old ID differs → preserve old grant/check cache.
        simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Simkl account mismatch — the new authorization is for a different Simkl account. Disconnect first to switch accounts.');
        redirect(`/configure/#simkl?error=${encodeURIComponent('Simkl account mismatch — the new authorization is for a different Simkl account. The existing connection is preserved. Disconnect first to switch accounts.')}`);
        return;
      }
      // Valid identity + no known old ID or IDs match → promote.
      config.updateProfile(matched.id, {
        simkl_auth: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          scope: tokens.scope,
          username: identity.name || tokens.username || undefined,
          account_id: newAccountId || undefined,
          connected_at: Date.now(),
          version: 2,
          client_id: matched.keys.simkl_v2_client_id,
        },
      });
      const newProfile = config.getProfile(matched.id);
      simklChecks.set(grantFingerprint(newProfile), {
        state: 'connected',
        message: 'Connected and verified',
        username: identity.name || tokens.username || null,
        account_id: newAccountId || null,
        checked_at: Date.now(),
      });
      simklConnectionFlow.completeAttempt(attempt.flowId, 'completed', 'connected', 'Connected and verified');
      redirect('/configure/#simkl');
    } else {
      if (oldAuth?.access_token) {
        // Verification fails + any grant existed → preserve old grant/check cache.
        simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Could not verify Simkl account — existing connection preserved; try again');
        redirect(`/configure/#simkl?error=${encodeURIComponent('Could not verify Simkl account — existing connection preserved; try again')}`);
        return;
      }
      // Verification fails + no grant existed → store new token as unverified.
      config.updateProfile(matched.id, {
        simkl_auth: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          scope: tokens.scope,
          username: tokens.username || undefined,
          connected_at: Date.now(),
          version: 2,
          client_id: matched.keys.simkl_v2_client_id,
        },
      });
      const newProfile = config.getProfile(matched.id);
      simklChecks.set(grantFingerprint(newProfile), {
        state: 'token_stored',
        message: 'Token stored — run Check connection to verify live',
        username: tokens.username || null,
        account_id: null,
        checked_at: Date.now(),
      });
      simklConnectionFlow.completeAttempt(attempt.flowId, 'completed', 'token_stored', 'Token stored — run Check connection to verify live');
      redirect('/configure/#simkl');
    }
  } catch (err) {
    // A failed exchange (bad code, expired, wrong issuer, insufficient scope,
    // credential change) must NOT overwrite the existing grant. Redirect to
    // the portal with a safe, actionable message. Never echo the provider
    // body to the browser (M4).
    const msg = err.state === 'credential_changed'
      ? 'Connection changed — Simkl credentials were edited; start again'
      : err.state === 'insufficient_scope'
        ? 'Simkl granted a read-only token — re-authorize with the full scope'
        : err.state === 'invalid_issuer'
          ? 'Unexpected callback issuer — start the connection again'
          : 'V2 OAuth failed — start the connection again';
    // §2: Mark the specific attempt as failed — no promotion on callback failure.
    if (flowId) {
      const failedAttempt = simklConnectionFlow.getAttempt(flowId);
      if (failedAttempt && (failedAttempt.state === 'pending' || failedAttempt.state === 'verifying')) {
        simklConnectionFlow.completeAttempt(failedAttempt.flowId, 'failed', null, msg);
      }
    }
    redirect(`/configure/#simkl?error=${encodeURIComponent(msg)}`);
  }
});

const PORT = parseInt(process.env.PORT || '7000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Recommender listening on :${PORT}`);
  console.log(`Configure portal: http://localhost:${PORT}/configure/`);
  console.log('[auth] Admin portal protected by shared email-OTP sign-in (air_sid)');
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
