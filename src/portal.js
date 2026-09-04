// Configure-portal API. Sits behind Cloudflare Access in production —
// the addon endpoints under /addon/:token are the only public surface.
const express = require('express');
const config = require('./config');
const store = require('./store');
const rebuild = require('./rebuild');
const jobs = require('./jobs');
const catalogs = require('./catalogs');
const tmdb = require('./services/tmdb');
const mdblistService = require('./services/mdblist');
const scrobble = require('./services/scrobble');
const crypto = require('./services/crypto');
const settings = require('./settings');
const llm = require('./services/llm');
const simkl = require('./services/simkl');
const traktImport = require('./services/traktImport');
const watchedStore = require('./watchedStore');
const recommendationStore = require('./recommendationStore');
const dontRecommend = require('./dontRecommend');

const { version } = require('../package.json');
const USER_AGENT = `AI-Recommender/1.0 (+https://github.com/jamesgallagher/Stremio_AI_Recommender)`;

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

// Rate-governor snapshot: per-service call totals, today's count vs any daily
// cap, and current throttle/backoff state. Observability for the heavy paths
// (Simkl 1-POST/s write cap, TMDB build volume, Jikan 60/min) — GET /api/governor.
router.get('/governor', (req, res) => {
  res.json({ stats: require('./services/governor').stats() });
});

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
      simkl_client_id: p.keys.simkl_client_id || '',
      simkl_client_secret: p.keys.simkl_client_secret || '',
      tmdb_api_key: p.keys.tmdb_api_key || '',
      groq_api_key: p.keys.groq_api_key || '',
      rpdb_api_key: p.keys.rpdb_api_key || '',
      mdblist_api_key: p.keys.mdblist_api_key || '',
    },
    // Lookup keys are GLOBAL (Server Config) now — reflect the effective key
    // (global, with a per-profile fallback) so per-profile warnings are correct.
    keys_set: {
      simkl_client_id: !!p.keys.simkl_client_id,
      simkl_client_secret: !!p.keys.simkl_client_secret,
      tmdb_api_key: !!settings.keyFor(p, 'tmdb_api_key'),
      groq_api_key: !!settings.keyFor(p, 'groq_api_key'),
      rpdb_api_key: !!settings.keyFor(p, 'rpdb_api_key'),
      mdblist_api_key: !!settings.keyFor(p, 'mdblist_api_key'),
    },
    keys_preview: {
      tmdb_api_key: redactKey(p.keys.tmdb_api_key),
      groq_api_key: redactKey(p.keys.groq_api_key),
      rpdb_api_key: redactKey(p.keys.rpdb_api_key),
      mdblist_api_key: redactKey(p.keys.mdblist_api_key),
    },
    // Simkl: whether a token is STORED. Live validity is checked separately via
    // /simkl/status (the portal calls it on the Simkl tab open).
    simkl_connected: !!p.simkl_auth?.access_token,
    simkl_username: p.simkl_auth?.username || null,
    email: p.email || '', // user email — Mobile Companion passwordless login (stored only for now)
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
    // status.rebuilding now reflects the JOB QUEUE (a queued/running build), and
    // status.job carries the live progress (pct + label) for the percentage UI.
    status: (() => {
      const st = rebuild.status(p);
      const job = jobs.snapshot(p.id);
      return { ...st, job, rebuilding: st.rebuilding || jobs.isBusy(p.id) };
    })(),
  };
}

router.get('/genres', (req, res) => {
  res.json({ genres: Object.keys(tmdb.GENRE_ALIASES).sort() });
});

// Available extra-catalog definitions (static) for the portal's Catalogs section.
router.get('/catalogs', (req, res) => {
  res.json({
    catalogs: catalogs.EXTRA_CATALOGS.map(
      ({ id, type, name, min_imdb, source, default_on, target, min_profile_age, age_band, dedupe_watched }) => ({
        id, type, name, min_imdb, source, default_on: !!default_on, target: target || 20,
        min_profile_age: min_profile_age || 0, age_band: age_band || 0, dedupe_watched: dedupe_watched !== false,
      }),
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
  if (req.body.email !== undefined) patch.email = req.body.email;
  if (req.body.filters) patch.filters = req.body.filters;
  if (req.body.catalogs) patch.catalogs = req.body.catalogs;
  if (req.body.keys) {
    // Only overwrite keys that were actually provided (non-empty)
    patch.keys = {};
    for (const k of ['simkl_client_id', 'simkl_client_secret', 'tmdb_api_key', 'groq_api_key', 'rpdb_api_key', 'mdblist_api_key']) {
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
  simklFlows.delete(req.params.id);
  try { watchedStore.deleteForProfile(req.params.id); recommendationStore.deleteForProfile(req.params.id); } catch (err) { console.warn(`[store] cleanup failed for ${req.params.id}: ${err.message}`); }
  res.json({ ok: true });
});

// ---- Key testing ----
async function testTmdb(profile) {
  const key = profile.keys.tmdb_api_key;
  if (!key) return { ok: false, error: 'TMDB key not set' };
  const isBearer = key.length > 50;
  const url = `https://api.themoviedb.org/3/authentication${isBearer ? '' : `?api_key=${encodeURIComponent(key)}`}`;
  const headers = { 'User-Agent': USER_AGENT, ...(isBearer ? { Authorization: `Bearer ${key}` } : {}) };
  const res = await fetch(url, { headers });
  if (res.ok) return { ok: true, detail: 'TMDB key valid' };
  return { ok: false, error: `Invalid TMDB key (${res.status})` };
}

async function testGroq(profile) {
  const key = profile.keys.groq_api_key;
  if (!key) return { ok: false, error: 'Groq key not set' };
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
  });
  if (res.ok) return { ok: true, detail: 'Groq key valid' };
  if (res.status === 429) return { ok: true, detail: 'Key valid, but free-tier rate limit is currently exhausted' };
  return { ok: false, error: `Invalid Groq key (${res.status})` };
}

async function testRpdb(profile) {
  const key = profile.keys.rpdb_api_key;
  if (!key) return { ok: false, error: 'RPDB key not set (optional — posters stay standard without it)' };
  const res = await fetch(`https://api.ratingposterdb.com/${encodeURIComponent(key)}/isValid`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (res.ok) return { ok: true, detail: 'RPDB key valid — posters will show ratings' };
  return { ok: false, error: `Invalid RPDB key (${res.status})` };
}

async function testMdblist(profile) {
  // Test the EFFECTIVE key (global Server-Config key first, per-profile only as a
  // legacy fallback) — the same resolution enrichment/serve use via keyFor — so a
  // passing test reflects what actually runs, not a stray per-profile field.
  const key = settings.keyFor(profile, 'mdblist_api_key');
  if (!key) return { ok: false, error: 'MDBList key not set — required (rating floor, extra catalogs + Common Sense age checks)' };
  try {
    const r = await mdblistService.testKey(key);
    return { ok: true, detail: `MDBList key valid (sample Common Sense lookup: ${r.sampleAge ? r.sampleAge + '+' : 'not rated'})` };
  } catch (err) {
    return { ok: false, error: `MDBList test failed: ${err.message}` };
  }
}

const TESTERS = { tmdb: testTmdb, groq: testGroq, rpdb: testRpdb, mdblist: testMdblist };

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

// ---- Simkl PIN device flow (v6) ----
const simklFlows = new Map(); // profileId -> { user_code, verification_url, state, error, expires_at }

router.post('/profiles/:id/simkl/connect', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const clientId = profile.keys.simkl_client_id;
  if (!clientId) return res.status(400).json({ error: 'Set the Simkl Client ID first' });
  try {
    const dc = await simkl.startPinFlow(clientId);
    const flow = {
      user_code: dc.user_code,
      verification_url: dc.verification_url || 'https://simkl.com/pin',
      state: 'pending', error: null,
      expires_at: Date.now() + (dc.expires_in || 900) * 1000,
    };
    simklFlows.set(profile.id, flow);

    const intervalMs = Math.max(dc.interval || 5, 5) * 1000;
    const poll = setInterval(async () => {
      const current = simklFlows.get(profile.id);
      if (!current || current !== flow || Date.now() > flow.expires_at) {
        clearInterval(poll);
        if (current === flow && flow.state === 'pending') { flow.state = 'error'; flow.error = 'PIN expired — start again'; }
        return;
      }
      try {
        const result = await simkl.pollPin(clientId, dc.user_code);
        if (result.pending) return;
        clearInterval(poll);
        if (result.token) {
          config.updateProfile(profile.id, { simkl_auth: result.token });
          flow.state = 'connected';
          try {
            const username = await simkl.accountName(clientId, result.token.access_token);
            if (username) config.updateProfile(profile.id, { simkl_auth: { ...result.token, username } });
            console.log(`[simkl] ${profile.name}: connected via PIN${username ? ` as "${username}"` : ''}`);
          } catch { /* username is best-effort */ }
        } else {
          flow.state = 'error'; flow.error = result.error || 'Authorization failed';
          console.error(`[simkl] ${profile.name}: PIN flow failed — ${flow.error}`);
        }
      } catch (err) {
        clearInterval(poll); flow.state = 'error'; flow.error = err.message;
      }
    }, intervalMs);

    res.json({ user_code: flow.user_code, verification_url: flow.verification_url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// LIVE status — verifies the token against Simkl, never trusts a stored flag.
// This is the fix for the v5 bug where dead tokens still showed "connected".
router.get('/profiles/:id/simkl/status', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const flow = simklFlows.get(profile.id);
  const check = await simkl.checkConnection(profile.keys.simkl_client_id, profile.simkl_auth?.access_token);
  let watched_count = 0;
  try { watched_count = watchedStore.countWatched(profile.id); } catch { /* store may be empty */ }
  res.json({
    connected: check.valid,
    username: check.username || profile.simkl_auth?.username || null,
    reason: check.valid ? null : check.reason,
    watched_count,
    flow: flow ? { state: flow.state, user_code: flow.user_code, verification_url: flow.verification_url, error: flow.error } : null,
  });
});

// Manual watched-history sync from Simkl (also runs in the background later).
router.post('/profiles/:id/simkl/sync', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  try {
    const result = await watchedStore.syncFromSimkl(profile, console, { force: !!req.body?.force });
    // Top up genre/age enrichment for anything newly ingested (best-effort).
    try { result.enrich = await watchedStore.enrichPending(profile.id, console); } catch (err) { result.enrich = { error: err.message }; }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- One-time Trakt → Simkl import ----
// The user uploads their Trakt data-export ZIP; we push its watched history into
// this profile's Simkl account, then resync so the app's watched store reflects
// it. Runs on the global job queue (fire-and-forget, polled via /job) because a
// full library is minutes of paced 1-POST/s writes — far past Cloudflare's ~100s
// origin cap if held open. The ZIP arrives as a raw body (express.raw); the JSON
// body parser above skips it because the content-type isn't application/json.
router.post('/profiles/:id/simkl/import-trakt',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '250mb' }),
  (req, res) => {
    const profile = config.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (!profile.simkl_auth?.access_token) return res.status(400).json({ error: 'Connect Simkl first' });
    const zip = req.body;
    if (!Buffer.isBuffer(zip) || zip.length === 0) {
      return res.status(400).json({ error: 'No ZIP file received — upload your Trakt data export .zip' });
    }
    if (jobs.isBusy(profile.id)) {
      return res.status(409).json({ error: 'A build or import is already running for this profile — let it finish first' });
    }
    jobs.enqueue(profile.id, 'trakt-import', async (progress) => {
      // Band each phase's own 0–100 into the overall bar so the last phase (the
      // pool rebuild) is included — the whole point: the rebuild runs HERE, after
      // the full import + resync, on the complete watched store, not off a
      // partial mid-import sync the scheduler happened to catch.
      const band = (lo, hi) => (p, label) => progress(lo + ((hi - lo) * p) / 100, label);

      const imported = await traktImport.importFromZip(profile, zip, console, band(0, 68));
      // Pull the now-updated Simkl history into the local watched store, then top
      // up genre/age enrichment — same as the "Sync watched now" path.
      progress(70, 'Syncing watched history from Simkl');
      const sync = await watchedStore.syncFromSimkl(profile, console, { force: true });
      try { await watchedStore.enrichPending(profile.id, console); } catch { /* best-effort */ }
      // Rebuild the recommendation pool directly (not via jobs.enqueue — we're
      // already inside a job; enqueuing would deadlock behind ourselves) so it's
      // deterministic and built from the COMPLETE imported history.
      progress(76, 'Rebuilding recommendations');
      const built = await recommendationStore.buildPool(profile, console, band(78, 100));
      return {
        ...imported,
        resync: { total: sync.total, breakdown: sync.breakdown },
        rebuilt: built && !built.skipped ? { stored: built.stored, seeds: built.seeds } : null,
      };
    }).catch((err) => console.error(`[trakt-import] ${profile.name}: ${err.message}`));
    res.status(202).json({ started: true, job: jobs.snapshot(profile.id) });
  });

// ---- Recommendation builder (v6 F5) ----
// Build the pool: enqueued on the global job queue (one rebuild at a time) and
// answered 202 immediately — the build runs for minutes and reports progress via
// GET /:id/job, which the portal polls for the percentage.
router.post('/profiles/:id/recommend/build', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const jobs = require('./jobs');
  jobs.enqueue(profile.id, 'recs', (progress) => recommendationStore.buildPool(profile, console, progress))
    .catch((err) => console.warn(`[rec] ${profile.name}: pool build failed — ${err.message}`));
  res.status(202).json({ started: true, job: jobs.snapshot(profile.id) });
});

// Lightweight progress poll for the active/last rebuild job of this profile.
router.get('/profiles/:id/job', (req, res) => {
  res.json({ job: require('./jobs').snapshot(req.params.id) });
});

// Reset: wipe the pool + the user's don't-recommend flags (Advanced section later).
router.post('/profiles/:id/recommend/reset', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  recommendationStore.resetRecommendations(profile.id);
  res.json({ ok: true, total: recommendationStore.countRecommended(profile.id) });
});

// Read the pool (Advanced tab "view Recommended Movies / Shows" + debugging).
router.get('/profiles/:id/recommend', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json({
    total: recommendationStore.countRecommended(profile.id),
    movies: recommendationStore.getRecommended(profile.id, { type: 'movie', limit: 40 }),
    series: recommendationStore.getRecommended(profile.id, { type: 'series', limit: 40 }),
  });
});

// Debug (Advanced tab): the last 50 watched movies + 50 watched series, newest
// first, read LIVE from Simkl — the authority — not the local watched store or
// the Nuvio/Stremio scrobble view. Live call; may take a moment on a big
// library. Two independent lists; short libraries just return what they have.
router.get('/profiles/:id/watched/simkl', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (!profile.keys.simkl_client_id || !profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected for this profile' });
  }
  try {
    const [movies, series] = await Promise.all([
      simkl.getRecentWatched(profile, 'movie', { limit: 50 }),
      simkl.getRecentWatched(profile, 'series', { limit: 50 }),
    ]);
    res.json({ movies, series });
  } catch (err) {
    res.status(502).json({ error: `Simkl read failed — ${err.message}` });
  }
});

// "Don't recommend" — the configure-portal + Mobile Companion entry point.
// Delegates to the shared dontRecommend.suppress() (the same logic the in-player
// GET /addon/:token/dnr link uses), so a rejection behaves identically wherever
// it's tapped. Accepts a tmdb_id (Advanced tab has it) OR an imdb_id (the
// Companion app has the tt id from the catalog); at least one is required.
router.post('/profiles/:id/recommend/suppress', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, title } = req.body || {};
  if (!type || (!tmdb_id && !imdb_id)) return res.status(400).json({ error: 'type and tmdb_id (or imdb_id) required' });
  const result = await dontRecommend.suppress(profile, { type, tmdbId: tmdb_id, imdbId: imdb_id, title }, console);
  if (!result.ok) {
    return res.status(result.reason === 'bad-type' ? 400 : 422).json({ error: `could not suppress (${result.reason})` });
  }
  res.json({ ok: true, title: result.title, total: recommendationStore.countRecommended(profile.id) });
});

router.post('/profiles/:id/simkl/disconnect', (req, res) => {
  const profile = config.updateProfile(req.params.id, { simkl_auth: null });
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  simklFlows.delete(req.params.id);
  res.json({ ok: true });
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
  // Clean 400 for a fully-unconfigured profile (no Simkl, nothing the user
  // explicitly enabled). Default-on Watch Later alone doesn't count — the
  // user never asked for it, so don't run a rebuild that can only error.
  // Explicitly enabled catalogs DO count even with missing requirements:
  // the rebuild's per-catalog error results tell the user what's missing.
  const buildable = !!profile.simkl_auth?.access_token
    || catalogs.enabledExtras(profile).some(
      (d) => catalogs.requirementMet(profile, d) || profile.catalogs?.[d.id] === true,
    );
  if (!buildable) {
    return res.status(400).json({ error: 'Connect Simkl first' });
  }
  // Route through the global queue: one rebuild at a time, with progress. A
  // duplicate 'extras' request for this profile joins the in-flight one.
  const jobs = require('./jobs');
  jobs.enqueue(profile.id, 'extras', (progress) => rebuild.rebuildProfile(profile, console, { extras: true }, progress))
    .catch((err) => console.error(`[rebuild] ${profile.name}: ${err.message}`));
  res.status(202).json({ started: true, job: jobs.snapshot(profile.id) });
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
// Simkl push can take a while, same reasoning as Rebuild now.
// full=true (query or body) re-pushes the provider's entire watched list,
// ignoring what Simkl already has — the "Full rebuild" button.
router.post('/profiles/:id/scrobble/sync', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (!profile.scrobble?.enabled) return res.status(400).json({ error: 'Auto-scrobble is not enabled for this profile' });
  if (!profile.simkl_auth?.access_token) return res.status(400).json({ error: 'Connect Simkl first' });
  const full = req.query.full === 'true' || req.body?.full === true;
  try {
    const result = await scrobble.syncProfile(profile, console, { full });
    res.json({ result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Server Config (global settings, v6) ----

// Full values returned for portal pre-fill (same policy as the profile API).
router.get('/settings', (req, res) => {
  const s = settings.getSettings();
  res.json({
    settings: s, // null = never set up
    complete: settings.isComplete(s),
    locked: settings.settingsLocked(),
  });
});

router.put('/settings', (req, res) => {
  try {
    const patch = {};
    if (req.body.llm && typeof req.body.llm === 'object') patch.llm = req.body.llm;
    if (req.body.keys && typeof req.body.keys === 'object') patch.keys = req.body.keys;
    const updated = settings.updateSettings(patch);
    res.json({ settings: updated, complete: settings.isComplete(updated) });
  } catch (err) {
    res.status(423).json({ error: err.message });
  }
});

// Test one global lookup key by reusing the per-profile testers (they only read
// `.keys`). Key comes from the request body so an unsaved value can be tested.
const SETTINGS_KEY_TESTERS = { tmdb: testTmdb, mdblist: testMdblist, rpdb: testRpdb, groq: testGroq };
router.post('/settings/test/:service', async (req, res) => {
  const tester = SETTINGS_KEY_TESTERS[req.params.service];
  if (!tester) return res.status(400).json({ error: 'Unknown service' });
  const field = req.params.service === 'groq' ? 'groq_api_key' : `${req.params.service}_api_key`;
  const key = req.body.key;
  try {
    const result = await tester({ keys: { [field]: key } });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Custom LLM test — validates OpenAI shape + our two JSON tasks live.
router.post('/settings/test-llm', async (req, res) => {
  const { name, uri, apiKey, step } = req.body || {};
  try {
    const result = await llm.testCustomLlm({ name, uri, apiKey, step }, console);
    const summary = result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join(' · ');
    console.log(`[test] custom LLM ${uri}${step ? ` [${step}]` : ''}: ${result.ok ? 'OK' : 'FAIL'} — ${summary}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, checks: [{ name: 'request', ok: false, detail: err.message }] });
  }
});

module.exports = { router };
