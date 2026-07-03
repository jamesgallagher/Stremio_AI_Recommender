// Configure-portal API. Sits behind Cloudflare Access in production —
// the addon endpoints under /addon/:token are the only public surface.
const express = require('express');
const config = require('./config');
const rebuild = require('./rebuild');
const trakt = require('./services/trakt');
const tmdb = require('./services/tmdb');

const router = express.Router();
router.use(express.json());

// In-flight device-flow sessions: profileId -> { user_code, verification_url, state, error }
const deviceFlows = new Map();

function redactKey(v) {
  if (!v) return '';
  return v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••';
}

function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    token: p.token,
    filters: p.filters,
    keys_set: {
      trakt_client_id: !!p.keys.trakt_client_id,
      trakt_client_secret: !!p.keys.trakt_client_secret,
      tmdb_api_key: !!p.keys.tmdb_api_key,
      gemini_api_key: !!p.keys.gemini_api_key,
    },
    keys_preview: {
      trakt_client_id: redactKey(p.keys.trakt_client_id),
      trakt_client_secret: redactKey(p.keys.trakt_client_secret),
      tmdb_api_key: redactKey(p.keys.tmdb_api_key),
      gemini_api_key: redactKey(p.keys.gemini_api_key),
    },
    trakt_connected: !!p.trakt_auth?.access_token,
    trakt_expires_at: p.trakt_auth?.expires_at || null,
    status: rebuild.status(p),
  };
}

router.get('/genres', (req, res) => {
  res.json({ genres: Object.keys(tmdb.GENRE_ALIASES).sort() });
});

router.get('/profiles', (req, res) => {
  res.json({ profiles: config.listProfiles().map(publicProfile) });
});

router.post('/profiles', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const profile = config.addProfile(name);
  res.json({ profile: publicProfile(profile) });
});

router.put('/profiles/:id', (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.filters) patch.filters = req.body.filters;
  if (req.body.keys) {
    // Only overwrite keys that were actually provided (non-empty)
    patch.keys = {};
    for (const k of ['trakt_client_id', 'trakt_client_secret', 'tmdb_api_key', 'gemini_api_key']) {
      if (req.body.keys[k]) patch.keys[k] = String(req.body.keys[k]).trim();
    }
  }
  const profile = config.updateProfile(req.params.id, patch);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json({ profile: publicProfile(profile) });
});

router.delete('/profiles/:id', (req, res) => {
  if (!config.removeProfile(req.params.id)) return res.status(404).json({ error: 'Profile not found' });
  deviceFlows.delete(req.params.id);
  res.json({ ok: true });
});

// ---- Key testing ----
async function testTrakt(profile) {
  if (!profile.keys.trakt_client_id) return { ok: false, error: 'Client ID not set' };
  // Full check when already authorized
  if (profile.trakt_auth?.access_token) {
    const res = await fetch('https://api.trakt.tv/sync/last_activities', {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': profile.keys.trakt_client_id,
        Authorization: `Bearer ${profile.trakt_auth.access_token}`,
      },
    });
    if (res.ok) return { ok: true, detail: 'Client ID and OAuth token both valid' };
    return { ok: false, error: `Trakt returned ${res.status} — token may need re-authorization` };
  }
  // Not authorized yet: validate the Client ID via a device-code request
  // (harmless — the code simply expires unused). The secret can only be
  // verified by completing Connect Trakt.
  const res = await fetch('https://api.trakt.tv/oauth/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: profile.keys.trakt_client_id }),
  });
  if (res.ok) return { ok: true, detail: 'Client ID valid. Secret is verified when you Connect Trakt.' };
  return { ok: false, error: `Invalid Client ID (Trakt returned ${res.status})` };
}

async function testTmdb(profile) {
  const key = profile.keys.tmdb_api_key;
  if (!key) return { ok: false, error: 'TMDB key not set' };
  const isBearer = key.length > 50;
  const url = `https://api.themoviedb.org/3/authentication${isBearer ? '' : `?api_key=${encodeURIComponent(key)}`}`;
  const res = await fetch(url, { headers: isBearer ? { Authorization: `Bearer ${key}` } : {} });
  if (res.ok) return { ok: true, detail: 'TMDB key valid' };
  return { ok: false, error: `Invalid TMDB key (${res.status})` };
}

async function testGemini(profile) {
  const key = profile.keys.gemini_api_key;
  if (!key) return { ok: false, error: 'Gemini key not set' };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
  if (res.ok) return { ok: true, detail: 'Gemini key valid' };
  if (res.status === 429) return { ok: true, detail: 'Key valid, but free-tier quota is currently exhausted' };
  return { ok: false, error: `Invalid Gemini key (${res.status})` };
}

const TESTERS = { trakt: testTrakt, tmdb: testTmdb, gemini: testGemini };

router.post('/profiles/:id/test/:service', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const tester = TESTERS[req.params.service];
  if (!tester) return res.status(400).json({ error: 'Unknown service' });
  try {
    res.json(await tester(profile));
  } catch (err) {
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
        } else {
          flow.state = 'error';
          flow.error = result.error || 'Authorization failed';
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

// ---- Rebuild now ----
router.post('/profiles/:id/rebuild', async (req, res) => {
  const profile = config.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (!profile.trakt_auth?.access_token) return res.status(400).json({ error: 'Connect Trakt first' });
  try {
    const results = await rebuild.rebuildProfile(profile);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
