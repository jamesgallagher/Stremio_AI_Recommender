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
const serveCalibration = require('./serveCalibration');
const dontRecommend = require('./dontRecommend');
const markWatched = require('./markWatched');
const trainer = require('./trainer');
const tasteFeedback = require('./tasteFeedback');
const engines = require('./engines');
const catalogServe = require('./catalogServe');
const metaStore = require('./engines/shared/metaStore');

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

// AUTH-1: current admin's profile (behind requireAdminApi — req.account is set).
router.get('/me', (req, res) => {
  res.json({ profile: { id: req.account.id, name: req.account.name, is_admin: true } });
});

// Rate-governor snapshot: per-service call totals, today's count vs any daily
// cap, and current throttle/backoff state. Observability for the heavy paths
// (Simkl 1-POST/s write cap, TMDB build volume, Jikan 60/min) — GET /api/governor.
// Uses publicStats() which never exposes raw keys or fingerprints.
router.get('/governor', (req, res) => {
  res.json({ stats: require('./services/governor').publicStats() });
});

function redactKey(v) {
  if (!v) return '';
  return v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••';
}

const { baseUrl, normalizeExternal } = require('./baseurl');

// AUTH V2 (mandate M2): the canonical callback URI, derived ONLY from a
// validated HTTPS EXTERNAL_URL — no request-Host fallback for production V2.
// A private LAN/test redirect may be allowed only in test configuration; it is
// never published as the deployment URI. Returns '' when EXTERNAL_URL is
// absent or not a valid HTTPS origin, so the portal disables V2 Connect with
// an actionable message rather than publishing a broken redirect.
function simklV2CallbackUri() {
  const raw = normalizeExternal(process.env.EXTERNAL_URL);
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  return `${raw}/simkl/oauth2/callback`;
}

function publicProfile(p, req) {
  return {
    id: p.id,
    name: p.name,
    token: p.token,
    install_url: `${baseUrl(req)}/addon/${p.token}/manifest.json`,
    external_url_set: !!normalizeExternal(process.env.EXTERNAL_URL),
    filters: p.filters,
    catalogs: p.catalogs || {},
    // Per-type engine selection (v7 — see docs/engine-abstraction). The effective
    // engine id per type (resolved against the registry + age limit) and the
    // requirement check per type (so the UI can warn "needs Simkl"/"needs a key").
    // engine_movie/engine_series also arrive verbatim inside `filters`; this block
    // is the convenience shape cards 04/05 need.
    engines: {
      movie: engines.resolveFor(p, 'movie').id,
      series: engines.resolveFor(p, 'series').id,
      anime: engines.resolveFor(p, 'anime')?.id || 'off',
      requirements: {
        movie: engines.resolveFor(p, 'movie').requirements(p),
        series: engines.resolveFor(p, 'series').requirements(p),
        anime: engines.resolveFor(p, 'anime')?.requirements(p) || { ok: true, missing: [] },
      },
    },
    // Full key values — returned only to the admin-authed portal so each key
    // input can be pre-filled (with a show/hide toggle). This endpoint is
    // behind adminAuth; the public /addon surface never sees these.
    // The V2 Client Secret is NEVER returned to the browser (M4): the input
    // is blank and replace-only, preserving the stored secret on an
    // untouched or empty save.
    keys: {
      simkl_client_id: p.keys.simkl_client_id || '',
      simkl_client_secret: p.keys.simkl_client_secret || '',
      simkl_v2_client_id: p.keys.simkl_v2_client_id || '',
      // simkl_v2_client_secret is deliberately absent (M4).
      tmdb_api_key: p.keys.tmdb_api_key || '',
      groq_api_key: p.keys.groq_api_key || '',
      rpdb_api_key: p.keys.rpdb_api_key || '',
      mdblist_api_key: p.keys.mdblist_api_key || '',
      mal_client_id: p.keys.mal_client_id || '',
      anidb_client: p.keys.anidb_client || '',
      anidb_clientver: p.keys.anidb_clientver || 0,
    },
    // Lookup keys are GLOBAL (Server Config) now — reflect the effective key
    // (global, with a per-profile fallback) so per-profile warnings are correct.
    keys_set: {
      simkl_client_id: !!p.keys.simkl_client_id,
      simkl_client_secret: !!p.keys.simkl_client_secret,
      simkl_v2_client_id: !!p.keys.simkl_v2_client_id,
      simkl_v2_client_secret: !!p.keys.simkl_v2_client_secret,
      tmdb_api_key: !!settings.keyFor(p, 'tmdb_api_key'),
      groq_api_key: !!settings.keyFor(p, 'groq_api_key'),
      rpdb_api_key: !!settings.keyFor(p, 'rpdb_api_key'),
      mdblist_api_key: !!settings.resolveMdblistKey(p).key,
      mal_client_id: !!settings.resolveMalKey(p).key,
      anidb_client: !!settings.resolveAnidbClient(p).client,
    },
    keys_preview: {
      tmdb_api_key: redactKey(p.keys.tmdb_api_key),
      groq_api_key: redactKey(p.keys.groq_api_key),
      rpdb_api_key: redactKey(p.keys.rpdb_api_key),
      mdblist_api_key: redactKey(p.keys.mdblist_api_key),
      // V2 Client Secret is never disclosed to the browser (M4). Only a
      // generic masked placeholder is shown; the boolean `keys_set` above
      // tells the portal whether it's set.
      simkl_v2_client_secret: p.keys.simkl_v2_client_secret ? '••••' : '',
    },
    // Simkl: whether a token is STORED. Live validity is checked separately via
    // /simkl/status (the portal calls it on the Simkl tab open).
    simkl_connected: !!p.simkl_auth?.access_token,
    simkl_username: p.simkl_auth?.username || null,
    // The latest manual check state (from the simklChecks Map). The passive
    // status poll and the header badge use this to show the real connection
    // state, not just token presence.
    simkl_check_state: (simklChecks.get(grantFingerprint(p)) || {}).state || null,
    simkl_check_message: (simklChecks.get(grantFingerprint(p)) || {}).message || null,
    // AUTH V1/V2 (M1/M3): the preferred connection version (what Connect
    // starts) and the active token's version (what is currently connected).
    // Shown separately when they differ — a V1 token can stay active while the
    // user has selected V2 for the next connection.
    simkl_auth_version: p.simkl_auth_version || 2,
    simkl_active_version: p.simkl_auth?.access_token ? (p.simkl_auth.version === 2 ? 2 : 1) : null,
    // The canonical V2 callback URI, derived ONLY from a validated HTTPS
    // EXTERNAL_URL (no request-Host fallback for production V2). Empty when
    // EXTERNAL_URL is absent/invalid — the portal then disables V2 Connect with
    // an actionable message. The registered URI and both OAuth requests must
    // use this exact string (slash/case/port).
    simkl_v2_callback_uri: simklV2CallbackUri(),
    simkl_v2_callback_ready: !!simklV2CallbackUri(),
    email: p.email || '', // user email — Mobile Companion passwordless login (stored only for now)
    is_admin: p.is_admin === true, // AUTH-1: admin flag for /configure access + Admin checkbox
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
      // MDBList provider status: show key source, cooldown/deferred state for
      // this profile's key. Rendered even before the first request (source is
      // known from key resolution; stats are null until a call occurs).
      const { key, source } = settings.resolveMdblistKey(p);
      const mdblist_status = { source };
      if (key) {
        const crypto = require('crypto');
        const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
        const credStats = require('./services/governor').credentialStats(fp);
        if (credStats) {
          mdblist_status.backing_off = credStats.backing_off;
          mdblist_status.backoff_ms_left = credStats.backoff_ms_left;
          mdblist_status.circuit_open = credStats.circuit_open;
          mdblist_status.circuit_ms_left = credStats.circuit_ms_left;
          mdblist_status.calls = credStats.calls;
          mdblist_status.today = credStats.today;
        }
      }
      // Queue position: named preceding job (the ACTIVE job's profile name,
      // not this waiting job's own label).
      if (job && job.state === 'queued') {
        mdblist_status.queue_position = jobs.queuePosition(p.id);
        const activeInfo = jobs.activeJobInfo();
        if (activeInfo) {
          // Resolve the active job's profile name (safe: only name, no secrets)
          const activeProfile = config.getProfile(activeInfo.profileId);
          mdblist_status.queue_blocker = activeProfile ? `${activeProfile.name} (${activeInfo.kind})` : activeInfo.kind;
        }
      }
      // The extras summary is computed at job completion (jobs.js pump) for
      // extras jobs only. Here we read it without mutating the stored snapshot.
      // A persisted retry interval decays via the absolute retry_at instant.
      let jobOut = job;
      if (job && job.summary) {
        // Return a copy with the decayed retry time (never mutate the stored snapshot).
        const summary = { ...job.summary };
        if (job.retry_at && job.retry_at > Date.now()) {
          summary.retry_after_ms = job.retry_at - Date.now();
        } else if (job.retry_at) {
          summary.retry_after_ms = 0;
        }
        jobOut = { ...job, summary };
      } else if (job && job.deferred && job.retry_at) {
        // Top-level deferred error: decay retry_after_ms from the absolute retry_at.
        jobOut = { ...job, retry_after_ms: job.retry_at > Date.now() ? job.retry_at - Date.now() : 0 };
      }
      return { ...st, job: jobOut, rebuilding: st.rebuilding || jobs.isBusy(p.id), mdblist_status };
    })(),
    anime_status: {
      mal: { source: settings.resolveMalKey(p).source },
      anidb: require('./services/anidb').clientStatus(p),
      migration: require('./anime/migration').getReport(p.id),
    },
  };
}

router.get('/genres', (req, res) => {
  res.json({ genres: Object.keys(tmdb.GENRE_ALIASES).sort() });
});

// The engine registry (static) for the portal's per-type engine dropdowns +
// descriptions (card 04). Mirrors GET /genres. Per-profile availability + the
// requirement check are profile-specific, so they live in publicProfile's
// `engines` block, not here. Returns the two Marquee engines (Marquee Cinema
// for movies, Marquee TV for series).
router.get('/engines', (req, res) => {
  res.json({
    engines: engines.list().map((e) => ({
      id: e.id, name: e.name, description: e.description,
      supported_types: e.supportedTypes,
    })),
  });
});

// Available extra-catalog definitions (static) for the portal's Catalogs section.
// CB-1: no per-catalog `target` — every non-Watch-Later catalog is sized by the
// profile's list-size setting, and Watch Later is source-sized. `sized_by` tells
// the client how the row is sized (it has no profile here, so it can't report a
// number).
router.get('/catalogs', (req, res) => {
  res.json({
    catalogs: catalogs.EXTRA_CATALOGS.map(
      ({ id, type, name, min_imdb, source, default_on, min_profile_age, age_band, dedupe_watched }) => ({
        id, type, name, min_imdb, source, default_on: !!default_on,
        sized_by: source === 'simkl_plantowatch' ? 'source' : 'list_size',
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
  if (req.body.is_admin !== undefined) patch.is_admin = req.body.is_admin;
  if (req.body.filters) patch.filters = req.body.filters;
  if (req.body.catalogs) patch.catalogs = req.body.catalogs;
  if (req.body.keys) {
    // Only overwrite keys that were actually provided (non-empty)
    patch.keys = {};
    for (const k of ['simkl_client_id', 'simkl_client_secret', 'simkl_v2_client_id', 'simkl_v2_client_secret', 'tmdb_api_key', 'groq_api_key', 'rpdb_api_key', 'mdblist_api_key', 'mal_client_id', 'anidb_client']) {
      if (req.body.keys[k]) patch.keys[k] = String(req.body.keys[k]).trim();
    }
    if (req.body.keys.anidb_clientver !== undefined) {
      patch.keys.anidb_clientver = req.body.keys.anidb_clientver === null ? 0 : Number(req.body.keys.anidb_clientver);
    }
    // Explicit clear for optional keys (null -> '' disables the feature)
    for (const k of ['rpdb_api_key', 'mdblist_api_key', 'mal_client_id', 'anidb_client']) {
      if (req.body.keys[k] === null) patch.keys[k] = '';
    }
  }
  // AUTH V1/V2: the preferred connection version (what Connect starts).
  // Validated strictly in config.updateProfile (rejects unknown values).
  if (req.body.simkl_auth_version !== undefined) patch.simkl_auth_version = req.body.simkl_auth_version;
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
  // Capture the profile before the update for credential-change detection.
  const beforeProfile = config.getProfile(req.params.id);
  let result;
  try {
    result = config.updateProfile(req.params.id, patch);
  } catch (err) {
    // Email uniqueness conflict (or any other write-boundary validation
    // failure): no partial change was made (mutateProfiles is atomic).
    // Return 409 with a clear message.
    if (err.message && err.message.includes('is already used by profile')) {
      return res.status(409).json({ error: err.message });
    }
    // AUTH-1 error codes → stable HTTP status + body.
    if (err.code === 'LAST_ADMIN') return res.status(409).json({ error: err.message });
    if (err.code === 'ADMIN_NEEDS_EMAIL' || err.code === 'BAD_ADMIN_FLAG') return res.status(400).json({ error: err.message });
    throw err;
  }
  const { profile, engineChanged } = result;
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // SC-03: an engine change (a new per-type selection, or an age-limit raise that
  // revoked an unrestricted engine) replaces that type's candidate producer —
  // clear its stale rows and kick a rebuild (fire-and-forget; the portal already
  // polls status/job). dont_recommend is engine-independent and survives.
  if (engineChanged.length) {
    for (const t of engineChanged) recommendationStore.clearType(profile.id, t);
    recommendationStore.rebuildAfterChange(profile.id)
      .catch((err) => console.warn(`[rec] ${profile.name}: engine-change rebuild failed — ${err.message}`));
  }
  // §2: On actual relevant credential edits, invalidate the attempt immediately.
  // Compare the connection snapshot (grantDigest) before and after the update.
  // Identical saves do nothing. Unrelated field changes do nothing. A change
  // followed by changing back must not revive it (the attempt is terminal
  // once invalidated).
  if (beforeProfile && (patch.keys || patch.simkl_auth_version !== undefined)) {
    const simklConnectionFlow = require('./services/simklConnectionFlow');
    if (simklConnectionFlow.grantDigest(beforeProfile) !== simklConnectionFlow.grantDigest(profile)) {
      simklConnectionFlow.invalidateAttempts(req.params.id);
    }
  }
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
  try {
    if (!config.removeProfile(req.params.id)) return res.status(404).json({ error: 'Profile not found' });
  } catch (err) {
    if (err.code === 'LAST_ADMIN') return res.status(409).json({ error: err.message });
    throw err;
  }
  simklFlows.delete(req.params.id);
  try { watchedStore.deleteForProfile(req.params.id); recommendationStore.deleteForProfile(req.params.id); tasteFeedback.deleteForProfile(req.params.id); serveCalibration.deleteForProfile(req.params.id); } catch (err) { console.warn(`[store] cleanup failed for ${req.params.id}: ${err.message}`); }
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
  // Test the EFFECTIVE key (personal first, then global server key) — the same
  // resolution enrichment/serve use via resolveMdblistKey — so a passing test
  // reflects what actually runs, not a stray per-profile field.
  const { key } = settings.resolveMdblistKey(profile);
  if (!key) return { ok: false, error: 'MDBList key not set — required (rating floor, extra catalogs + Common Sense age checks)' };
  try {
    const r = await mdblistService.testKey(key);
    return { ok: true, detail: `MDBList key valid (sample Common Sense lookup: ${r.sampleAge ? r.sampleAge + '+' : 'not rated'})` };
  } catch (err) {
    return { ok: false, error: `MDBList test failed: ${err.message}` };
  }
}

const TESTERS = { tmdb: testTmdb, groq: testGroq, rpdb: testRpdb, mdblist: testMdblist };

// TVDB v4 (AGE-1): validate the TVDB key by logging in (POST /v4/login). The
// key is exchanged for a token — a 200 with a token means the key is valid.
// Optional — it only feeds the TV-14 age chain's country-certification fallback.
async function testTvdb(profile) {
  const key = profile.keys.tvdb_api_key;
  if (!key) return { ok: false, error: 'TVDB key not set (optional — TV-14 age chain)' };
  try {
    const res = await fetch('https://api4.thetvdb.com/v4/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: key }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.data?.token) return { ok: true, detail: 'TVDB key valid' };
      return { ok: false, error: 'TVDB login returned no token' };
    }
    return { ok: false, error: `Invalid TVDB key (${res.status})` };
  } catch (err) {
    return { ok: false, error: `TVDB test failed: ${err.message}` };
  }
}

// Per-profile MDBList user-key test (Advanced → API Keys). Unlike the global
// Server Config test (testMdblist, which uses settings.keyFor — global-first),
// this tests the EXACT per-profile key. Modes: {key: <draft>} tests an unsaved
// draft; {use_saved: true} tests the stored user key server-side. A missing
// user key reports missing (no silent fallback to the global key). Conflicting
// modes are rejected.
// NOTE: This route must be registered BEFORE test/:service (Express matches
// routes in registration order; test/:service would otherwise catch mdblist-user).
router.post('/profiles/:id/test/mdblist-user', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { key, use_saved } = req.body || {};
  if (key !== undefined && use_saved) {
    return res.status(400).json({ error: 'Conflicting modes: send either {key} or {use_saved}, not both' });
  }
  let testKey;
  if (use_saved) {
    testKey = profile.keys.mdblist_api_key;
    if (!testKey) return res.json({ ok: false, error: 'MDBList user key not set' });
  } else if (key !== undefined) {
    testKey = String(key).trim();
    if (!testKey) return res.json({ ok: false, error: 'MDBList user key not set' });
  } else {
    // No draft, no use_saved — test the stored user key.
    testKey = profile.keys.mdblist_api_key;
    if (!testKey) return res.json({ ok: false, error: 'MDBList user key not set' });
  }
  try {
    const r = await mdblistService.testKey(testKey);
    console.log(`[test] ${profile.name}/mdblist-user: OK — ${r.sampleAge ? r.sampleAge + '+' : 'not rated'}`);
    res.json({ ok: true, detail: `MDBList user key valid (sample Common Sense lookup: ${r.sampleAge ? r.sampleAge + '+' : 'not rated'})` });
  } catch (err) {
    console.error(`[test] ${profile.name}/mdblist-user: FAIL — ${err.message}`);
    res.json({ ok: false, error: `MDBList user key test failed: ${err.message}` });
  }
});

// Per-profile MyAnimeList user-key test (Advanced → API Keys). Same modes as
// mdblist-user: {key: <draft>} tests an unsaved draft; {use_saved: true} tests
// the stored user key server-side.
router.post('/profiles/:id/test/mal-user', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { key, use_saved } = req.body || {};
  if (key !== undefined && use_saved) {
    return res.status(400).json({ error: 'Conflicting modes: send either {key} or {use_saved}, not both' });
  }
  let testKey;
  if (use_saved) {
    testKey = profile.keys.mal_client_id;
    if (!testKey) return res.json({ ok: false, error: 'MyAnimeList user key not set' });
  } else if (key !== undefined) {
    testKey = String(key).trim();
    if (!testKey) return res.json({ ok: false, error: 'MyAnimeList user key not set' });
  } else {
    testKey = profile.keys.mal_client_id;
    if (!testKey) return res.json({ ok: false, error: 'MyAnimeList user key not set' });
  }
  try {
    const res2 = await fetch('https://api.myanimelist.net/v2/anime/1?fields=rating', {
      headers: { 'X-MAL-CLIENT-ID': testKey, 'User-Agent': USER_AGENT },
    });
    if (res2.ok) {
      const data = await res2.json();
      const rating = data?.data?.rating || 'unknown';
      console.log(`[test] ${profile.name}/mal-user: OK — ${rating}`);
      res.json({ ok: true, detail: `MyAnimeList key valid (Cowboy Bebop rated ${rating})` });
    } else {
      console.error(`[test] ${profile.name}/mal-user: FAIL — ${res2.status}`);
      res.json({ ok: false, error: `MyAnimeList test failed (${res2.status})` });
    }
  } catch (err) {
    console.error(`[test] ${profile.name}/mal-user: ERROR — ${err.message}`);
    res.json({ ok: false, error: `MyAnimeList test failed: ${err.message}` });
  }
});

// Per-profile AniDB client test (Advanced → API Keys). {client, clientver}
// tests a draft pair; {use_saved: true} tests the stored pair.
router.post('/profiles/:id/test/anidb-user', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { client, clientver, use_saved } = req.body || {};
  const anidb = require('./services/anidb');
  let testClient, testClientver;
  if (use_saved) {
    testClient = profile.keys.anidb_client;
    testClientver = profile.keys.anidb_clientver || 1;
    if (!testClient) return res.json({ ok: false, error: 'AniDB client not set' });
  } else if (client !== undefined) {
    testClient = String(client).trim();
    testClientver = Number(clientver) || 1;
    if (!testClient) return res.json({ ok: false, error: 'AniDB client not set' });
  } else {
    testClient = profile.keys.anidb_client;
    testClientver = profile.keys.anidb_clientver || 1;
    if (!testClient) return res.json({ ok: false, error: 'AniDB client not set' });
  }
  try {
    const result = await anidb.testClient({ client: testClient, clientver: testClientver });
    if (result.ok) {
      res.json({ ok: true, detail: '✓ Client accepted' });
    } else if (result.error === 'client') {
      res.json({ ok: false, error: "✗ AniDB doesn't recognise this client" });
    } else if (result.banned_until) {
      res.json({ ok: false, error: `✗ AniDB has banned this client until ${new Date(result.banned_until).toLocaleString()}` });
    } else if (result.cap) {
      res.json({ ok: false, error: '✗ Daily limit reached — try tomorrow' });
    } else {
      res.json({ ok: false, error: `✗ ${result.error || 'test failed'}` });
    }
  } catch (err) {
    res.json({ ok: false, error: `AniDB test failed: ${err.message}` });
  }
});

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

// ---- Simkl PIN device flow (v6) + AUTH V1/V2 (mandate M1/M6) ----
const simklFlows = new Map(); // profileId -> { user_code, verification_url, state, error, expires_at }
// Last manual Check-connection result per grant (mandate M6). The passive
// status poll reads this (lightweight — no Simkl call); only the manual check
// makes the provider's one-request check. A stored token alone is "token
// stored", never "connected" — the badge reflects the latest live check.
// Keyed by grant fingerprint (profileId:version:client_id) so a check result
// is only valid for the exact active grant that produced it. When the grant
// changes (new authorization, credential change, version switch, Disconnect)
// the fingerprint changes and the old check is naturally invalidated.
const simklChecks = new Map(); // grantFingerprint -> { state, message, username, account_id, checked_at }

// Non-secret grant fingerprint: identifies the exact active grant. A check
// result is only valid for this exact grant binding. Includes a token-derived
// digest (SHA-256 of the access token, first 16 hex chars) so that a new
// access/refresh token through the same V2 client invalidates the old check.
// The digest is non-disclosed (a truncated hash, not the token itself).
function grantFingerprint(p) {
  return simkl.checkFingerprint(p);
}

// Manual Check connection (mandate M6): the button's own admin-authenticated
// endpoint. It does not create a connection flow, authorize a user, or show a
// PIN, and it does not edit profile settings. Returns the structured state + a
// short safe message (never a generic {connected:false}).
router.post('/profiles/:id/simkl/check', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Validate the explicitly supplied version: must be numeric 1 or 2.
  const rawVersion = req.body?.version;
  if (rawVersion !== undefined && rawVersion !== 1 && rawVersion !== 2) {
    return res.status(400).json({ error: 'version must be 1 or 2' });
  }
  const version = rawVersion; // 1, 2, or undefined (omitted = legacy behavior)
  // When an explicit valid version is supplied and differs from the profile's
  // stored preference, return 409 without any provider call (configuration
  // changed — the user must save the new preference first).
  const savedPref = profile.simkl_auth_version;
  if (version !== undefined && version !== savedPref) {
    return res.status(409).json({ error: 'Configuration changed — save the selected version first', target_version: version });
  }
  let result = await simkl.manualCheck(profile, { version });
  const current = config.getProfile(profile.id);
  if (!current || result.check_fingerprint !== grantFingerprint(current)) {
    return res.json({ state: 'credential_mismatch', message: 'Simkl connection changed — check again', connected: false, target_version: version });
  }
  // Keep the SELECTED readiness out of the OLD grant's verification cache/badge
  // when the selected version does not match the active grant's version.
  const activeVersion = current.simkl_auth?.access_token ? (current.simkl_auth.version || 1) : null;
  const selectedMatchesActive = version === undefined || activeVersion === version;
  if (selectedMatchesActive) {
    const check = { state: result.state, message: result.message, username: result.username || null, account_id: result.account_id || null, checked_at: Date.now() };
    simklChecks.set(grantFingerprint(current), check);
  }
  res.json({ state: result.state, message: result.message, username: result.username || null, account_id: result.account_id || null, connected: result.state === 'connected', target_version: version });
});

// Passive status poll (mandate M6): LIGHTWEIGHT — no Simkl call. Returns the
// last manual check's state (or the stored-token state when no manual check has
// run yet), so the header badge can never say "Connected" when the latest live
// check failed. The provider's one-request check is the manual check's job.
router.get('/profiles/:id/simkl/status', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const simklConnectionFlow = require('./services/simklConnectionFlow');
  // Prune expired attempts (terminal records past polling window, abandoned
  // pending/verifying attempts). Keeps storage bounded.
  simklConnectionFlow.pruneExpired();
  const flow = simklFlows.get(profile.id);
  const lastCheck = simklChecks.get(grantFingerprint(profile)) || null;
  // When no manual check has run, derive a lightweight stored-token state
  // ("token stored", never "connected") so the badge is honest before the
  // first live check.
  let state, message, username;
  if (lastCheck) {
    state = lastCheck.state; message = lastCheck.message; username = lastCheck.username;
    // Guard a known account mismatch: if the check result's account_id
    // (the Simkl account the check verified) differs from the stored
    // account_id (the Simkl account the grant was created against), the
    // grant is for a different Simkl account than the one verified.
    if (lastCheck.account_id != null && profile.simkl_auth?.account_id != null && String(lastCheck.account_id) !== String(profile.simkl_auth.account_id)) {
      state = 'account_mismatch';
      message = 'Simkl account mismatch — reconnect';
    }
  } else if (profile.simkl_auth?.access_token) {
    state = 'token_stored'; message = 'Token stored — run Check connection to verify live'; username = profile.simkl_auth.username || null;
  } else {
    state = 'not_authorized'; message = 'Not connected'; username = null;
  }
  let watched_count = 0;
  try { watched_count = watchedStore.countWatched(profile.id); } catch { /* store may be empty */ }
  // Connection attempt state (only when flow_id is provided).
  let connection_attempt = null;
  if (req.query.flow_id) {
    const attempt = simklConnectionFlow.getAttemptForProfile(profile.id, req.query.flow_id);
    connection_attempt = { flow_id: attempt.flowId, state: attempt.state, result: attempt.result, message: attempt.message };
  }
  res.json({
    connected: state === 'connected',
    state,
    message,
    username,
    reason: state === 'connected' ? null : message,
    watched_count,
    flow: flow ? { state: flow.state, user_code: flow.user_code, verification_url: flow.verification_url, error: flow.error } : null,
    connection_attempt,
  });
});

router.post('/profiles/:id/simkl/connect', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const version = profile.simkl_auth_version || 2;
  const simklConnectionFlow = require('./services/simklConnectionFlow');

  if (version === 2) {
    // V2: OAuth authorization code + PKCE. The browser opens the authorize URL;
    // Simkl redirects back to /simkl/oauth2/callback with code + state.
    const callbackUri = simklV2CallbackUri();
    if (!callbackUri) {
      return res.status(400).json({ error: 'Set EXTERNAL_URL (HTTPS) to enable V2 OAuth' });
    }
    const v2Id = profile.keys.simkl_v2_client_id;
    const v2Secret = profile.keys.simkl_v2_client_secret;
    if (!v2Id || !v2Secret) {
      return res.status(400).json({ error: 'Set the V2 Client ID and Secret first' });
    }
    try {
      const simklAuthV2 = require('./services/simklAuthV2');
      const { authorizeUrl } = simklAuthV2.startFlow(profile, callbackUri);
      // Create a connection attempt (supersedes any previous attempt).
      const flowId = simklConnectionFlow.startAttempt(profile);
      // Associate the attempt's flow_id with the OAuth flow record so the
      // callback references THIS specific attempt, not the latest active one.
      simklAuthV2.setFlowId(profile.id, flowId);
      res.json({ authorize_url: authorizeUrl, flow_id: flowId });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
    return;
  }

  // V1: PIN device flow.
  const clientId = profile.keys.simkl_client_id;
  if (!clientId) return res.status(400).json({ error: 'Set the Simkl Client ID first' });
  try {
    // Create the connection attempt BEFORE the async provider startup so a
    // delayed PIN-start response cannot supersede a later Connect/Disconnect.
    const flowId = simklConnectionFlow.startAttempt(profile);
    let dc;
    try {
      dc = await simkl.startPinFlow(clientId);
    } catch (pinErr) {
      // Provider startup threw — fail only this captured attempt.
      const pinAttempt = simklConnectionFlow.getAttempt(flowId);
      if (pinAttempt && (pinAttempt.state === 'pending' || pinAttempt.state === 'verifying')) {
        simklConnectionFlow.completeAttempt(flowId, 'failed', null, pinErr.message);
      }
      throw pinErr;
    }
    // Re-read the attempt after the network wait. Require it's still current,
    // pending, unexpired, and its grant/credential snapshot still matches.
    const attempt = simklConnectionFlow.getAttempt(flowId);
    if (!simklConnectionFlow.isCurrent(flowId, config.getProfile(profile.id), ['pending'])) {
      // Invalidated or superseded during the await.
      if (attempt && (attempt.state === 'pending' || attempt.state === 'verifying')) {
        simklConnectionFlow.completeAttempt(flowId, 'failed', null, 'Connection changed — start again');
      }
      return res.status(409).json({ error: 'Connection changed — start again' });
    }
    // Update the attempt's expiry from the provider's returned expiry.
    const pinExpiry = Date.now() + (dc.expires_in || 900) * 1000;
    simklConnectionFlow.updateAttemptExpiry(flowId, pinExpiry);
    const flow = {
      user_code: dc.user_code,
      verification_url: dc.verification_url || 'https://simkl.com/pin',
      state: 'pending', error: null,
      expires_at: pinExpiry,
      flow_id: flowId,
    };
    simklFlows.set(profile.id, flow);

    const intervalMs = Math.max(dc.interval || 5, 5) * 1000;
    let polling = false;
    const poll = setInterval(async () => {
      if (polling) return;
      const current = simklFlows.get(profile.id);
      if (!current || current !== flow || !simklConnectionFlow.isCurrent(flowId, config.getProfile(profile.id)) || Date.now() > flow.expires_at) {
        clearInterval(poll);
        if (current === flow && flow.state === 'pending') {
          flow.state = 'error'; flow.error = 'PIN expired — start again';
          // Mark the specific attempt failed on PIN expiry.
          const expAttempt = simklConnectionFlow.getAttempt(flowId);
          if (expAttempt && (expAttempt.state === 'pending' || expAttempt.state === 'verifying')) {
            simklConnectionFlow.completeAttempt(flowId, 'failed', null, 'PIN expired — start again');
          }
        }
        return;
      }
      try {
        polling = true;
        const result = await simkl.pollPin(clientId, dc.user_code);
        if (result.pending) return;
        clearInterval(poll);
        if (result.token) {
          // §2: Guarded promotion. The token is in a local variable; not persisted yet.
          // Use the flow_id captured by this PIN operation's closure, not the
          // latest active attempt (which may have been superseded during polling).
          const attempt = simklConnectionFlow.getAttempt(flowId);
          if (!attempt || (attempt.state !== 'pending' && attempt.state !== 'verifying')) {
            flow.state = 'error'; flow.error = 'Connection changed — start again';
            if (attempt) simklConnectionFlow.completeAttempt(flowId, 'failed', null, 'Connection changed — start again');
            console.error(`[simkl] ${profile.name}: PIN flow — no active attempt`);
            return;
          }
          simklConnectionFlow.markVerifying(attempt.flowId);
          // §3: Bounded identity verification (10 s deadline, includes JSON parse).
          const identity = await simklConnectionFlow.verifyIdentity(clientId, result.token.access_token);
          // §2: Final guard — re-read the profile immediately before writing.
          const currentProfile = config.getProfile(profile.id);
          const guardOk = simklConnectionFlow.isCurrent(flowId, currentProfile, ['verifying']);
          if (!guardOk) {
            simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Connection changed — start again');
            flow.state = 'error'; flow.error = 'Connection changed — start again';
            console.error(`[simkl] ${profile.name}: PIN flow guard failed`);
            return;
          }
          // §3 outcome — no await between guard, grant update, check-cache update, and attempt completion.
          const oldAuth = currentProfile.simkl_auth;
          const oldAccountId = oldAuth?.account_id ? String(oldAuth.account_id) : null;
          const newAccountId = identity.id || null;
          if (identity.ok) {
            if (oldAccountId && newAccountId && oldAccountId !== newAccountId) {
              // Valid identity + known old ID differs → preserve old grant/check cache.
              simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Simkl account mismatch — the new authorization is for a different Simkl account. Disconnect first to switch accounts.');
              flow.state = 'error'; flow.error = 'Simkl account mismatch — the new authorization is for a different Simkl account. Disconnect first to switch accounts.';
              console.error(`[simkl] ${profile.name}: PIN flow account mismatch`);
              return;
            }
            // Valid identity + no known old ID or IDs match → promote.
            config.updateProfile(profile.id, {
              simkl_auth: { ...result.token, version: 1, client_id: clientId, username: identity.name || result.token.username || undefined, account_id: newAccountId || undefined },
            });
            const newProfile = config.getProfile(profile.id);
            simklChecks.set(grantFingerprint(newProfile), {
              state: 'connected',
              message: 'Connected and verified',
              username: identity.name || result.token.username || null,
              account_id: newAccountId || null,
              checked_at: Date.now(),
            });
            simklConnectionFlow.completeAttempt(attempt.flowId, 'completed', 'connected', 'Connected and verified');
            flow.state = 'connected';
            console.log(`[simkl] ${profile.name}: connected via PIN${identity.name ? ` as "${identity.name}"` : ''}`);
          } else {
            if (oldAuth?.access_token) {
              // Verification fails + any grant existed → preserve old grant/check cache.
              simklConnectionFlow.completeAttempt(attempt.flowId, 'failed', null, 'Could not verify Simkl account — existing connection preserved; try again');
              flow.state = 'error'; flow.error = 'Could not verify Simkl account — existing connection preserved; try again';
              console.error(`[simkl] ${profile.name}: PIN flow verification failed, existing grant preserved`);
              return;
            }
            // Verification fails + no grant existed → store new token as unverified.
            config.updateProfile(profile.id, { simkl_auth: { ...result.token, version: 1, client_id: clientId } });
            const newProfile = config.getProfile(profile.id);
            simklChecks.set(grantFingerprint(newProfile), {
              state: 'token_stored',
              message: 'Token stored — run Check connection to verify live',
              username: result.token.username || null,
              account_id: null,
              checked_at: Date.now(),
            });
            simklConnectionFlow.completeAttempt(attempt.flowId, 'completed', 'token_stored', 'Token stored — run Check connection to verify live');
            flow.state = 'connected';
            console.log(`[simkl] ${profile.name}: token stored via PIN (unverified)`);
          }
        } else {
          flow.state = 'error'; flow.error = result.error || 'Authorization failed';
          // Mark the specific attempt failed on provider PIN error.
          const errAttempt = simklConnectionFlow.getAttempt(flowId);
          if (errAttempt && (errAttempt.state === 'pending' || errAttempt.state === 'verifying')) {
            simklConnectionFlow.completeAttempt(flowId, 'failed', null, flow.error);
          }
          console.error(`[simkl] ${profile.name}: PIN flow failed — ${flow.error}`);
        }
      } catch (err) {
        clearInterval(poll); flow.state = 'error'; flow.error = err.message;
        // Mark the specific attempt failed on thrown polling error.
        const throwAttempt = simklConnectionFlow.getAttempt(flowId);
        if (throwAttempt && (throwAttempt.state === 'pending' || throwAttempt.state === 'verifying')) {
          simklConnectionFlow.completeAttempt(flowId, 'failed', null, err.message);
        }
      } finally {
        polling = false;
      }
    }, intervalMs);

    res.json({ user_code: flow.user_code, verification_url: flow.verification_url, flow_id: flowId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// LIVE status — verifies the token against Simkl, never trusts a stored flag.
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

// ---- Trakt → Simkl import (retired) ----
// The endpoint is retired: it returns 410 before reading ZIPs, queueing jobs,
// calling providers, or writing history. Historical data and unrelated legacy
// fields are preserved.
router.post('/profiles/:id/simkl/import-trakt',
  express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '250mb' }),
  (req, res) => {
    res.status(410).json({ error: 'Trakt import is retired. Your existing watched history is preserved.' });
  });

// ---- Recommendation builder (v6 F5) ----
// Build the pool: enqueued on the global job queue (one rebuild at a time) and
// answered 202 immediately — the build runs for minutes and reports progress via
// GET /:id/job, which the portal polls for the percentage.
router.post('/profiles/:id/recommend/build', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const jobs = require('./jobs');
  recommendationStore.rebuildAfterChange(profile.id)
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
  // Show exactly what the AI catalogs SERVE — the profile's filters (rating
  // floor, recency, excluded genres, age band) + its list size, genre-balanced —
  // not the raw pool's top 40. The pool routinely holds titles the filters hide
  // (the ME-10 backtest: ~70% of a Genesis pool), so the old raw view listed
  // films the user would never be shown. Read-only: no impressions recorded.
  const listSize = recommendationStore.listSizeFor(profile);
  // The same watched-first shared selection the AI catalogs use, so the Advanced
  // view shows exactly the user-visible titles (watched/pending excluded before
  // the limit) — not the raw pool's top list_size with watched titles leaking in.
  const served = (type) => recommendationStore.selectedRecommendationRows(profile, type, { limit: listSize });
  res.json({
    total: recommendationStore.countRecommended(profile.id),
    listSize,
    // Which engine currently produces each catalog (SC-03) — for the Advanced tab.
    engines: { movie: engines.resolveFor(profile, 'movie').id, series: engines.resolveFor(profile, 'series').id },
    movies: served('movie'),
    series: served('series'),
  });
});

// CP-01: preview a catalog's served titles for a profile — the SAME list the
// addon feeds Nuvio (via the shared servedCatalog), so the configurator can
// compare "what AI Recommender has" against what the client shows. Read-only:
// record:false, so peeking never advances the recommendation decay lifecycle.
// Covers the two always-on AI catalogs and every extra id.
router.get('/profiles/:id/catalogs/:catalogId/preview', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const catalogId = req.params.catalogId;
  // Age safety: refuse an over-band extra (Kids/Anime TV-14) for an age-limited
  // profile, mirroring the addon route — never surface it even in a preview.
  const extraDef = catalogs.getExtra(catalogId);
  if (extraDef && !catalogs.ageAppropriate(profile, extraDef)) {
    return res.status(404).json({ error: 'Catalog not available for this profile' });
  }
  const served = catalogServe.servedCatalog(profile, catalogId, { record: false });
  if (!served) return res.status(404).json({ error: 'Unknown catalog' });
  res.json({
    id: served.id,
    name: served.name,
    type: served.type,
    source: served.source,
    requirement_met: served.requirement_met,
    state: served.state,
    count: served.metas.length,
    metas: served.metas.map((m) => ({
      id: m.id,
      name: m.name,
      poster: m.poster || null,
      imdbRating: m.imdbRating || null,
      releaseInfo: m.releaseInfo || null,
    })),
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

// Trainer T1 — the per-profile taste-trainer surface. The portal is admin-guarded
// (an :id in the path); the companion is session-scoped (req.profile only). Both
// delegate to the SAME transport-agnostic core (src/trainer.js), so the two
// surfaces can't drift apart (TD-7). The routes only parse input + call the core
// + map with the shared status mapper (M6); a thrown Simkl write is a 502.
router.get('/profiles/:id/trainer', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, view, q, page, page_size: pageSize } = req.query || {};
  try {
    const r = await trainer.listHistory(profile, { type, view, q, page, pageSize });
    res.status(trainer.httpStatus(r)).json(r.ok ? r : { error: r.reason });
  } catch (err) {
    res.status(502).json({ error: `Simkl write failed — ${err.message}` });
  }
});

router.post('/profiles/:id/trainer/rate', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, simkl_id, rating } = req.body || {};
  const ref = { type, tmdb_id, imdb_id, simkl_id };
  try {
    const r = await trainer.rate(profile, ref, rating);
    res.status(trainer.httpStatus(r)).json(r.ok ? r : { error: r.reason });
  } catch (err) {
    res.status(502).json({ error: `Simkl write failed — ${err.message}` });
  }
});

router.post('/profiles/:id/trainer/ignore', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, simkl_id, ignored } = req.body || {};
  const ref = { type, tmdb_id, imdb_id, simkl_id };
  try {
    const r = await trainer.setIgnored(profile, ref, ignored);
    res.status(trainer.httpStatus(r)).json(r.ok ? r : { error: r.reason });
  } catch (err) {
    res.status(502).json({ error: `Simkl write failed — ${err.message}` });
  }
});

router.post('/profiles/:id/trainer/finished', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, title } = req.body || {};
  const ref = { type, tmdb_id, imdb_id, title };
  try {
    const r = await trainer.markFinished(profile, ref);
    res.status(trainer.httpStatus(r)).json(r.ok ? r : { error: r.reason });
  } catch (err) {
    res.status(502).json({ error: `Simkl write failed — ${err.message}` });
  }
});

router.post('/profiles/:id/trainer/unwatched', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, simkl_id } = req.body || {};
  const ref = { type, tmdb_id, imdb_id, simkl_id };
  try {
    const r = await trainer.markUnwatched(profile, ref);
    res.status(trainer.httpStatus(r)).json(r.ok ? r : { error: r.reason });
  } catch (err) {
    res.status(502).json({ error: `Simkl write failed — ${err.message}` });
  }
});

// MW-04 — remove a title from the profile's Simkl plan-to-watch list (the ✕ on a
// Watch Later preview cell). Plain list management, NOT a suppression: it writes
// nothing to dont_recommend, so the title stays eligible for AI recs and other
// catalogs. Mirrors the companion /api/watchlist/remove; the portal has an :id in
// the path (admin-guarded), the companion is session-scoped.
router.post('/profiles/:id/watchlist/remove', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, title } = req.body || {};
  if (type !== 'movie' && type !== 'series') return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  if (!profile.keys.simkl_client_id || !profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected for this profile' });
  }
  try {
    await simkl.removeFromPlanToWatch(profile, { type, tmdb_id, imdb_id, title });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Could not remove from Watch Later — ${err.message}` });
  }
});

// MW-02 — mark a title watched from a catalog-preview cell (the eye). The one
// backend addition this card needs; the companion already has /api/watched from
// MW-00. Resolves the profile from :id (admin-guarded, like the other portal
// profile routes) and delegates to the SHARED markWatched action, so the Simkl
// history write + pending-watched serve-prune behave identically to the companion.
// Mirrors the companion watchedHandler's status codes (400 no-Simkl, 502 on error).
router.post('/profiles/:id/watched', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { type, tmdb_id, imdb_id, title } = req.body || {};
  if (type !== 'movie' && type !== 'series') return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  if (!profile.keys.simkl_client_id || !profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected for this profile' });
  }
  try {
    const out = await markWatched.markWatched(profile, { type, imdbId: imdb_id, tmdbId: tmdb_id, title }, console);
    if (!out.ok) return res.status(400).json({ error: `Could not mark watched (${out.reason})` });
    res.json({ ok: true, title: out.title || null });
  } catch (err) {
    res.status(502).json({ error: `Could not mark watched — ${err.message}` });
  }
});

router.post('/profiles/:id/simkl/disconnect', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Disconnect order: capture old grant for revocation → invalidate attempts
  // → clear local grant/PIN state/check cache synchronously → await
  // best-effort revocation of the captured old grant. Do NOT clear anything
  // again after the await (a newer connection may have been established).
  const simklConnectionFlow = require('./services/simklConnectionFlow');
  const oldAuth = profile.simkl_auth;
  simklConnectionFlow.invalidateAttempts(profile.id);
  // Clear local state synchronously (before the await).
  config.updateProfile(req.params.id, { simkl_auth: null });
  simklFlows.delete(req.params.id);
  for (const key of simklChecks.keys()) {
    if (key.startsWith(req.params.id + ':')) simklChecks.delete(key);
  }
  // Best-effort revocation of the captured old grant (M4 — token sent server-side only).
  if (oldAuth?.version === 2 && oldAuth?.access_token) {
    const simklAuthV2 = require('./services/simklAuthV2');
    try { await simklAuthV2.revokeToken({ simkl_auth: oldAuth, keys: profile.keys }); } catch (err) {
      console.warn(`[simkl] ${profile.name}: V2 revoke failed — ${err.message}`);
    }
  }
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

// Read-only visibility (Part A): the films Simkl couldn't match. The scrobble
// records each one and retries weekly; this is the Scrobble tab's read-out.
// title/year come from the meta cache when cached, else null.
router.get('/profiles/:id/scrobble/unmatched', (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const items = watchedStore.listUnmatched(profile.id).map((r) => {
    const meta = r.tmdb_id ? metaStore.get('movie', r.tmdb_id) : null;
    return {
      imdb_id: r.imdb_id,
      tmdb_id: r.tmdb_id,
      title: meta?.title || null,
      year: meta?.year != null ? meta.year : null,
      last_tried: r.last_tried,
      attempts: r.attempts,
    };
  });
  res.json({ items });
});

// ---- Server Config (global settings, v6) ----

// Values returned for portal pre-fill (same policy as the profile API). The
// TVDB key (A6) is a pasted third-party secret — redact it in the GET so the
// raw key is never echoed back (the portal pre-fills a masked value).
router.get('/settings', (req, res) => {
  const s = settings.getSettings();
  const out = s ? { ...s, keys: { ...s.keys, tvdb_api_key: redactKey(s.keys.tvdb_api_key) } } : null;
  res.json({
    settings: out, // null = never set up
    complete: settings.isComplete(s),
    locked: settings.settingsLocked(),
  });
});

// ME-09: a Tier-2 Marquee config change (settings.marquee) is BUILD-AFFECTING —
// the same GD-6 pattern as Glass, but MOVIE ONLY (Marquee is a movie engine).
// Deliberately a parallel function, not a refactor of Glass's: the two engines'
// rebuild paths stay independent (no shared factor to drift).
function rebuildMarqueeProfiles() {
  for (const p of config.listProfiles()) {
    if (require('./engines').resolveFor(p, 'movie').id !== 'marquee') continue;
    recommendationStore.clearType(p.id, 'movie');
    recommendationStore.rebuildAfterChange(p.id)
      .catch((err) => console.warn(`[marquee] ${p.name}: Tier-2 config rebuild failed — ${err.message}`));
  }
}

router.put('/settings', (req, res) => {
  try {
    const patch = {};
    if (req.body.llm && typeof req.body.llm === 'object') patch.llm = req.body.llm;
    if (req.body.keys && typeof req.body.keys === 'object') {
      patch.keys = { ...req.body.keys };
      // A6: the TVDB key is redacted in the GET (masked in the portal form). A
      // save that echoes the mask back (or null) means "unchanged" — keep the
      // stored value so a masked value never overwrites the real key.
      const tvdb = req.body.keys.tvdb_api_key;
      if (tvdb === null || (typeof tvdb === 'string' && (tvdb === '••••' || /^.{4}….{4}$/.test(tvdb)))) {
        delete patch.keys.tvdb_api_key;
      }
    }
    // ME-09: Marquee Tier-2 admin config (stored as-is, real change detected by
    // JSON compare so an unrelated save doesn't rebuild).
    let marqueeChanged = false;
    if (req.body.marquee && typeof req.body.marquee === 'object') {
      const before = JSON.stringify(settings.getSettings()?.marquee || {});
      patch.marquee = req.body.marquee;                // replace-whole (settings.js)
      marqueeChanged = JSON.stringify(req.body.marquee) !== before;
    }
    const updated = settings.updateSettings(patch);
    // ME-09: build-affecting Tier-2 change → clear + rebuild every Marquee movie slice.
    if (marqueeChanged) rebuildMarqueeProfiles();
    res.json({ settings: updated, complete: settings.isComplete(updated) });
  } catch (err) {
    res.status(423).json({ error: err.message });
  }
});

// Test one global lookup key by reusing the per-profile testers (they only read
// `.keys`). Key comes from the request body so an unsaved value can be tested.
// TVDB: the saved key is redacted in the GET (a display mask), so the portal
// never sends the mask as a key. Modes: {use_saved: true} resolves the saved
// decrypted key server-side; {key: <draft>} tests an unsaved replacement
// without persisting it. Conflicting modes are rejected.
async function testMal(profile) {
  const key = profile.keys.mal_client_id;
  if (!key) return { ok: false, error: 'MyAnimeList key not set' };
  try {
    const res = await fetch('https://api.myanimelist.net/v2/anime/1?fields=rating', {
      headers: { 'X-MAL-CLIENT-ID': key, 'User-Agent': USER_AGENT },
    });
    if (res.ok) {
      const data = await res.json();
      const rating = data?.data?.rating || 'unknown';
      return { ok: true, detail: `MyAnimeList key valid (Cowboy Bebop rated ${rating})` };
    }
    return { ok: false, error: `MyAnimeList test failed (${res.status})` };
  } catch (err) {
    return { ok: false, error: `MyAnimeList test failed: ${err.message}` };
  }
}

const SETTINGS_KEY_TESTERS = { tmdb: testTmdb, mdblist: testMdblist, rpdb: testRpdb, groq: testGroq, tvdb: testTvdb, mal: testMal };
router.post('/settings/test/:service', async (req, res) => {
  const tester = SETTINGS_KEY_TESTERS[req.params.service];
  if (!tester) return res.status(400).json({ error: 'Unknown service' });
  const field = req.params.service === 'groq' ? 'groq_api_key' : req.params.service === 'mal' ? 'mal_client_id' : `${req.params.service}_api_key`;
  const { key, use_saved } = req.body || {};
  if (key !== undefined && use_saved) {
    return res.status(400).json({ error: 'Conflicting modes: send either {key} or {use_saved}, not both' });
  }
  let testKey;
  if (use_saved && req.params.service === 'tvdb') {
    // TVDB: resolve the saved decrypted key server-side (never echo the raw
    // key to the browser).
    const s = settings.getSettings();
    testKey = s?.keys?.tvdb_api_key;
    if (!testKey) return res.json({ ok: false, error: 'TVDB key not set (optional — TV-14 age chain)' });
  } else if (use_saved && req.params.service === 'mal') {
    const s = settings.getSettings();
    testKey = s?.keys?.mal_client_id;
    if (!testKey) return res.json({ ok: false, error: 'MyAnimeList key not set' });
  } else if (key !== undefined) {
    testKey = String(key).trim();
    if (!testKey) return res.json({ ok: false, error: 'Key not set' });
  } else {
    testKey = '';
    return res.json({ ok: false, error: 'Key not set' });
  }
  try {
    const result = await tester({ keys: { [field]: testKey } });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dedicated AniDB server-key test (takes {client, clientver}).
router.post('/settings/test/anidb', async (req, res) => {
  const { client, clientver } = req.body || {};
  const anidb = require('./services/anidb');
  const c = String(client || '').trim();
  const v = Number(clientver) || 0;
  if (!c) return res.json({ ok: false, error: 'AniDB client not set' });
  try {
    const result = await anidb.testClient({ client: c, clientver: v || 1 });
    if (result.ok) {
      res.json({ ok: true, detail: '✓ Client accepted' });
    } else if (result.error === 'client') {
      res.json({ ok: false, error: "✗ AniDB doesn't recognise this client" });
    } else if (result.banned_until) {
      res.json({ ok: false, error: `✗ AniDB has banned this client until ${new Date(result.banned_until).toLocaleString()}` });
    } else if (result.cap) {
      res.json({ ok: false, error: '✗ Daily limit reached — try tomorrow' });
    } else {
      res.json({ ok: false, error: `✗ ${result.error || 'test failed'}` });
    }
  } catch (err) {
    res.json({ ok: false, error: `AniDB test failed: ${err.message}` });
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

module.exports = { router, publicProfile, simklChecks, grantFingerprint };
