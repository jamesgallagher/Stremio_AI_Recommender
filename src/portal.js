// Configure-portal API. Sits behind Cloudflare Access in production —
// the addon endpoints under /addon/:token are the only public surface.
const express = require('express');
const config = require('./config');
const store = require('./store');
const rebuild = require('./rebuild');
const catalogs = require('./catalogs');
const trakt = require('./services/trakt');
const tmdb = require('./services/tmdb');
const mdblistService = require('./services/mdblist');
const scrobble = require('./services/scrobble');
const crypto = require('./services/crypto');

const { version } = require('../package.json');

const router = express.Router();
router.use(express.json());

// Locked mode (SECRET_KEY missing/invalid but profiles.json holds sealed
// secrets): refuse every mutating request so the on-disk ciphertext is never
// overwritten. Reads still work (secrets read back blank). config.mutateProfiles
// is the hard backstop; this gives a clean 423 instead of a 500.
router.use((req, res, next) => {
  if (req.method !== 'GET' && config.secretsLocked()) {
    return res.status(423).json({ error: 'Secrets are locked — SECRET_KEY is missing or invalid. Restore the correct key on the server to make changes.' });
  }
  next();
});

router.get('/version', (req, res) => {
  res.json({ version, secrets_locked: config.secretsLocked(), encryption_available: crypto.encryptionAvailable() });
});

// In-flight device-flow sessions: profileId -> { user_code, verification_url, state, error }
const deviceFlows = new Map();

function redactKey(v) {
  if (!v) return '';
  return v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••';
}

const { baseUrl, normalizeExternal } = require('./baseurl');

function publicProfile(p, req) {
  return {
    id: p.id,
    name: p.name,
    token: p.token,
    install_url: `${baseUrl(req)}/addon/${p.token}/manifest.json`,
    external_url_set: !!normalizeExternal(process.env.EXTERNAL_URL),
    filters: p.filters,
    catalogs: p.catalogs || {},
    // Full key values — returned only to the admin-authed portal so each key
    // input can be pre-filled (with a show/hide toggle). This endpoint is
    // behind adminAuth; the public /addon surface never sees these.
    keys: {
      trakt_client_id: p.keys.trakt_client_id || '',
      trakt_client_secret: p.keys.trakt_client_secret || '',
      tmdb_api_key: p.keys.tmdb_api_key || '',
      groq_api_key: p.keys.groq_api_key || '',
      rpdb_api_key: p.keys.rpdb_api_key || '',
      mdblist_api_key: p.keys.mdblist_api_key || '',
    },
    keys_set: {
      trakt_client_id: !!p.keys.trakt_client_id,
      trakt_client_secret: !!p.keys.trakt_client_secret,
      tmdb_api_key: !!p.keys.tmdb_api_key,
      groq_api_key: !!p.keys.groq_api_key,
      rpdb_api_key: !!p.keys.rpdb_api_key,
      mdblist_api_key: !!p.keys.mdblist_api_key,
    },
    keys_preview: {
      trakt_client_id: redactKey(p.keys.trakt_client_id),
      trakt_client_secret: redactKey(p.keys.trakt_client_secret),
      tmdb_api_key: redactKey(p.keys.tmdb_api_key),
      groq_api_key: redactKey(p.keys.groq_api_key),
      rpdb_api_key: redactKey(p.keys.rpdb_api_key),
      mdblist_api_key: redactKey(p.keys.mdblist_api_key),
    },
    trakt_connected: !!p.trakt_auth?.access_token,
    trakt_expires_at: p.trakt_auth?.expires_at || null,
    trakt_username: p.trakt_auth?.username || null,
    // Auto-scrobble config — password is never returned, only whether it's set.
    scrobble: {
      enabled: !!p.scrobble?.enabled,
      provider: p.scrobble?.provider || 'nuvio',
      email: p.scrobble?.email || '',
      password_set: !!p.scrobble?.password_enc,
      nuvio_profile_index: p.scrobble?.nuvio_profile_index ?? null,
      nuvio_profile_name: p.scrobble?.nuvio_profile_name || '',
      encryption_available: crypto.encryptionAvailable(),
    },
    status: rebuild.status(p),
  };
}

router.get('/genres', (req, res) => {
  res.json({ genres: Object.keys(tmdb.GENRE_ALIASES).sort() });
});

// Available extra-catalog definitions (static) for the portal's Catalogs section.
router.get('/catalogs', (req, res) => {
  res.json({
    catalogs: catalogs.EXTRA_CATALOGS.map(
      ({ id, type, name, min_imdb, source, default_on, target }) => ({ id, type, name, min_imdb, source, default_on: !!default_on, target: target || 20 }),
    ),
  });
});

router.get('/profiles', (req, res) => {
  // listProfiles() refreshes the lock state, so read it after.
  const profiles = config.listProfiles().map((p) => publicProfile(p, req));
  res.json({ profiles, secrets_locked: config.secretsLocked() });
});

router.post('/profiles', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const profile = config.addProfile(name);
  res.json({ profile: publicProfile(profile, req) });
});

router.put('/profiles/:id', (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.filters) patch.filters = req.body.filters;
  if (req.body.catalogs) patch.catalogs = req.body.catalogs;
  if (req.body.keys) {
    // Only overwrite keys that were actually provided (non-empty)
    patch.keys = {};
    for (const k of ['trakt_client_id', 'trakt_client_secret', 'tmdb_api_key', 'groq_api_key', 'rpdb_api_key', 'mdblist_api_key']) {
      if (req.body.keys[k]) patch.keys[k] = String(req.body.keys[k]).trim();
    }
    // Explicit clear for optional keys (null -> '' disables the feature)
    for (const k of ['rpdb_api_key', 'mdblist_api_key']) {
      if (req.body.keys[k] === null) patch.keys[k] = '';
    }
  }
  if (req.body.scrobble && typeof req.body.scrobble === 'object') {
    const s = req.body.scrobble;
    patch.scrobble = {};
    if (s.enabled !== undefined) patch.scrobble.enabled = !!s.enabled;
    if (s.provider !== undefined) patch.scrobble.provider = s.provider;
    if (s.email !== undefined) patch.scrobble.email = s.email;
    if (s.nuvio_profile_index !== undefined) patch.scrobble.nuvio_profile_index = s.nuvio_profile_index;
    if (s.nuvio_profile_name !== undefined) patch.scrobble.nuvio_profile_name = s.nuvio_profile_name;
    // Password: encrypt a provided value; null clears it. Storing a password
    // requires SCROBBLE_KEY — refuse rather than risk plaintext.
    if (s.password === null) {
      patch.scrobble.password_enc = '';
    } else if (s.password) {
      if (!crypto.encryptionAvailable()) {
        return res.status(400).json({ error: 'SCROBBLE_KEY is not set on the server — cannot store the password securely. Set it in the container environment first.' });
      }
      patch.scrobble.password_enc = crypto.encrypt(String(s.password));
    }
    // Guard: don't let a profile be enabled without a usable credential.
    const willHavePassword = patch.scrobble.password_enc !== undefined
      ? !!patch.scrobble.password_enc
      : !!config.getProfile(req.params.id)?.scrobble?.password_enc;
    if (patch.scrobble.enabled && !willHavePassword) {
      return res.status(400).json({ error: 'Set and test the account password before enabling auto-scrobble' });
    }
  }
  const profile = config.updateProfile(req.params.id, patch);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Rule: extra-catalog caches can be built "from the configure" — when the
  // toggle set changes and any enabled, buildable catalog has no cache yet,
  // build those in the background (extras only: never burns LLM quota).
  if (patch.catalogs) {
    const cache = store.loadCache(profile.id);
    const missing = catalogs.enabledExtras(profile).filter(
      (d) => catalogs.requirementMet(profile, d) && !cache.extras?.[d.id]?.metas?.length,
    );
    if (missing.length) {
      rebuild.rebuildProfile(profile, console, { ai: false, extras: true })
        .catch((err) => console.error(`[extra] ${profile.name}: background build failed: ${err.message}`));
    }
  }
  res.json({ profile: publicProfile(profile, req) });
});

router.delete('/profiles/:id', (req, res) => {
  if (!config.removeProfile(req.params.id)) return res.status(404).json({ error: 'Profile not found' });
  deviceFlows.delete(req.params.id);
  res.json({ ok: true });
});

// ---- Key testing ----
async function testTrakt(profile) {
  if (!profile.keys.trakt_client_id) return { ok: false, error: 'Client ID not set' };
  if (!profile.keys.trakt_client_secret) return { ok: false, error: 'Client Secret not set — both fields are required before Trakt can be used' };
  // Full check when already authorized
  if (profile.trakt_auth?.access_token) {
    const res = await fetch('https://api.trakt.tv/sync/last_activities', {
      headers: {
        ...trakt.baseHeaders(profile.keys.trakt_client_id),
        Authorization: `Bearer ${profile.trakt_auth.access_token}`,
      },
    });
    if (res.ok) {
      const who = profile.trakt_auth.username ? ` (authorized as Trakt user "${profile.trakt_auth.username}")` : '';
      return { ok: true, detail: `Client ID and OAuth token both valid${who}` };
    }
    return { ok: false, error: `Trakt returned ${res.status} — token may need re-authorization` };
  }
  // Not authorized yet: validate the Client ID via a device-code request
  // (harmless — the code simply expires unused). The secret can only be
  // verified by completing Connect Trakt.
  const res = await fetch('https://api.trakt.tv/oauth/device/code', {
    method: 'POST',
    headers: trakt.baseHeaders(profile.keys.trakt_client_id),
    body: JSON.stringify({ client_id: profile.keys.trakt_client_id }),
  });
  if (res.ok) return { ok: true, detail: 'Client ID valid. Secret is verified when you Connect Trakt.' };
  const body = (await res.text().catch(() => '')).slice(0, 200);
  return { ok: false, error: `Trakt rejected the request (${res.status}${body ? `: ${body}` : ''})` };
}

async function testTmdb(profile) {
  const key = profile.keys.tmdb_api_key;
  if (!key) return { ok: false, error: 'TMDB key not set' };
  const isBearer = key.length > 50;
  const url = `https://api.themoviedb.org/3/authentication${isBearer ? '' : `?api_key=${encodeURIComponent(key)}`}`;
  const headers = { 'User-Agent': trakt.USER_AGENT, ...(isBearer ? { Authorization: `Bearer ${key}` } : {}) };
  const res = await fetch(url, { headers });
  if (res.ok) return { ok: true, detail: 'TMDB key valid' };
  return { ok: false, error: `Invalid TMDB key (${res.status})` };
}

async function testGroq(profile) {
  const key = profile.keys.groq_api_key;
  if (!key) return { ok: false, error: 'Groq key not set' };
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': trakt.USER_AGENT },
  });
  if (res.ok) return { ok: true, detail: 'Groq key valid' };
  if (res.status === 429) return { ok: true, detail: 'Key valid, but free-tier rate limit is currently exhausted' };
  return { ok: false, error: `Invalid Groq key (${res.status})` };
}

async function testRpdb(profile) {
  const key = profile.keys.rpdb_api_key;
  if (!key) return { ok: false, error: 'RPDB key not set (optional — posters stay standard without it)' };
  const res = await fetch(`https://api.ratingposterdb.com/${encodeURIComponent(key)}/isValid`, {
    headers: { 'User-Agent': trakt.USER_AGENT },
  });
  if (res.ok) return { ok: true, detail: 'RPDB key valid — posters will show ratings' };
  return { ok: false, error: `Invalid RPDB key (${res.status})` };
}

async function testMdblist(profile) {
  const key = profile.keys.mdblist_api_key;
  if (!key) return { ok: false, error: 'MDBList key not set — required (extra catalogs + Common Sense age checks)' };
  try {
    const r = await mdblistService.testKey(key);
    return { ok: true, detail: `MDBList key valid (sample Common Sense lookup: ${r.sampleAge ? r.sampleAge + '+' : 'not rated'})` };
  } catch (err) {
    return { ok: false, error: `MDBList test failed: ${err.message}` };
  }
}

const TESTERS = { trakt: testTrakt, tmdb: testTmdb, groq: testGroq, rpdb: testRpdb, mdblist: testMdblist };

router.post('/profiles/:id/test/:service', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const tester = TESTERS[req.params.service];
  if (!tester) return res.status(400).json({ error: 'Unknown service' });
  try {
    const result = await tester(profile);
    console.log(`[test] ${profile.name}/${req.params.service}: ${result.ok ? `OK — ${result.detail}` : `FAIL — ${result.error}`}`);
    res.json(result);
  } catch (err) {
    console.error(`[test] ${profile.name}/${req.params.service}: ERROR — ${err.message}`);
    res.json({ ok: false, error: `Test failed: ${err.message}` });
  }
});

// ---- Trakt device flow ----
router.post('/profiles/:id/trakt/connect', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (!profile.keys.trakt_client_id || !profile.keys.trakt_client_secret) {
    return res.status(400).json({ error: 'Set the Trakt Client ID and Secret first' });
  }
  try {
    const dc = await trakt.startDeviceFlow(profile);
    const flow = {
      user_code: dc.user_code,
      verification_url: dc.verification_url,
      state: 'pending',
      error: null,
      expires_at: Date.now() + dc.expires_in * 1000,
    };
    deviceFlows.set(profile.id, flow);

    // Poll in the background at Trakt's requested interval
    const intervalMs = Math.max(dc.interval || 5, 5) * 1000;
    const poll = setInterval(async () => {
      const current = deviceFlows.get(profile.id);
      if (!current || current !== flow || Date.now() > flow.expires_at) {
        clearInterval(poll);
        if (current === flow && flow.state === 'pending') {
          flow.state = 'error';
          flow.error = 'Code expired — start again';
        }
        return;
      }
      try {
        const result = await trakt.pollDeviceToken(profile, dc.device_code);
        if (result.pending) return;
        clearInterval(poll);
        if (result.token) {
          config.updateProfile(profile.id, { trakt_auth: result.token });
          flow.state = 'connected';
          // Record which Trakt account actually authorized — mismatches
          // (wrong family member signed in) become visible in the portal.
          try {
            const fresh = config.getProfile(profile.id);
            const username = await trakt.getAccountUsername(fresh);
            config.updateProfile(profile.id, { trakt_auth: { ...fresh.trakt_auth, username } });
            console.log(`[trakt] ${profile.name}: connected via device flow as Trakt user "${username}"`);
          } catch {
            console.log(`[trakt] ${profile.name}: connected via device flow (could not fetch account name)`);
          }
        } else {
          flow.state = 'error';
          flow.error = result.error || 'Authorization failed';
          console.error(`[trakt] ${profile.name}: device flow failed — ${flow.error}`);
        }
      } catch (err) {
        clearInterval(poll);
        flow.state = 'error';
        flow.error = err.message;
      }
    }, intervalMs);

    res.json({ user_code: flow.user_code, verification_url: flow.verification_url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/profiles/:id/trakt/status', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const flow = deviceFlows.get(profile.id);
  res.json({
    connected: !!profile.trakt_auth?.access_token,
    flow: flow ? { state: flow.state, user_code: flow.user_code, verification_url: flow.verification_url, error: flow.error } : null,
  });
});

router.post('/profiles/:id/trakt/disconnect', (req, res) => {
  const profile = config.updateProfile(req.params.id, { trakt_auth: null });
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  deviceFlows.delete(req.params.id);
  res.json({ ok: true });
});

// ---- Watched-exclusion diagnostics ----
// Answers "why is a watched item still in my list?": fetches the LIVE Trakt
// watched sets and flags every currently-listed title against them. Any item
// flagged in_trakt_watched=true is a bug in this addon; an item the app shows
// a watched tick for but is flagged false here was never scrobbled to Trakt
// (app-side watched state or a different Trakt account).
router.get('/profiles/:id/diagnose', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (!profile.trakt_auth?.access_token) return res.status(400).json({ error: 'Connect Trakt first' });
  try {
    const watched = {
      movie: await trakt.getWatchedSets(profile, 'movie'),
      series: await trakt.getWatchedSets(profile, 'series'),
    };
    const cache = store.loadCache(profile.id);
    const catalogs = {};
    for (const type of ['movie', 'series']) {
      catalogs[type] = (cache[type]?.metas || []).map((m) => ({
        id: m.id,
        name: m.name,
        in_trakt_watched: watched.movie.imdbIds.has(m.id) || watched.series.imdbIds.has(m.id),
      }));
    }
    res.json({
      trakt_username: profile.trakt_auth.username || null,
      watched_counts: { movies: watched.movie.imdbIds.size, shows: watched.series.imdbIds.size },
      watched_synced_at: cache.watched_synced_at || null,
      catalogs,
      note: 'in_trakt_watched=true should never happen (report it). A title your app ticks as watched but shows false here was not scrobbled to this Trakt account.',
    });
  } catch (err) {
    res.status(502).json({ error: `Trakt lookup failed: ${err.message}` });
  }
});

// ---- Rebuild now ----
// Fire-and-forget: a rebuild runs for minutes, and holding the HTTP response
// open that long gets killed upstream (Cloudflare Tunnel caps origin responses
// at ~100 s), so the portal reported failure for rebuilds that finished fine.
// Start the job and answer 202 immediately; the portal polls status.rebuilding
// and reads status.last_results once it flips false.
router.post('/profiles/:id/rebuild', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Clean 400 for a fully-unconfigured profile (no Trakt, nothing the user
  // explicitly enabled). Default-on Watch Later alone doesn't count — the
  // user never asked for it, so don't run a rebuild that can only error.
  // Explicitly enabled catalogs DO count even with missing requirements:
  // the rebuild's per-catalog error results tell the user what's missing.
  const buildable = !!profile.trakt_auth?.access_token
    || catalogs.enabledExtras(profile).some(
      (d) => catalogs.requirementMet(profile, d) || profile.catalogs?.[d.id] === true,
    );
  if (!buildable) {
    return res.status(400).json({ error: 'Connect Trakt first' });
  }
  if (rebuild.isRebuilding(profile.id)) {
    return res.status(409).json({ error: 'A rebuild is already running for this profile — try again in a minute' });
  }
  rebuild.rebuildProfile(profile)
    .catch((err) => console.error(`[rebuild] ${profile.name}: ${err.message}`));
  res.status(202).json({ started: true });
});

// ---- Auto-scrobble ----
// Test the provider credentials. Accepts an unsaved password (from the form)
// or falls back to the stored one. For Nuvio returns the selectable profile
// list so the UI can bind this profile to a Nuvio household member.
router.post('/profiles/:id/scrobble/test', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const provider = req.body?.provider || profile.scrobble?.provider || 'nuvio';
  const email = (req.body?.email ?? profile.scrobble?.email ?? '').trim();
  const password = req.body?.password || '';
  const passwordEnc = profile.scrobble?.password_enc || '';
  if (password && !crypto.encryptionAvailable()) {
    // Not fatal for a test (we don't store it here), but warn the operator early.
    console.warn('[scrobble] test run while SCROBBLE_KEY is unset — the password cannot be saved until it is set');
  }
  try {
    const result = await scrobble.testCredentials({ provider, email, password, passwordEnc });
    console.log(`[scrobble] ${profile.name}/${provider}: test OK`);
    res.json(result);
  } catch (err) {
    console.warn(`[scrobble] ${profile.name}/${provider}: test failed — ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

// Run a scrobble reconcile now (manual trigger). Fire-and-forget: the pull +
// Trakt push can take a while, same reasoning as Rebuild now.
// full=true (query or body) re-pushes the provider's entire watched list,
// ignoring what Trakt already has — the "Full rebuild" button.
router.post('/profiles/:id/scrobble/sync', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (!profile.scrobble?.enabled) return res.status(400).json({ error: 'Auto-scrobble is not enabled for this profile' });
  if (!profile.trakt_auth?.access_token) return res.status(400).json({ error: 'Connect Trakt first' });
  const full = req.query.full === 'true' || req.body?.full === true;
  try {
    const result = await scrobble.syncProfile(profile, console, { full });
    res.json({ result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = { router };
