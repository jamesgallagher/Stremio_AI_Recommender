// Profile management. All keys are per profile (decided 2026-07-03):
// Trakt client ID/secret + OAuth tokens, TMDB key, Groq (LLM) key.
//
// Secrets at rest (v2.5.0): every API key and Trakt OAuth token is sealed with
// AES-256-GCM when SECRET_KEY is set (see services/crypto). Transparent — the
// in-memory profile objects handed to the rest of the app are always plaintext;
// only profiles.json on disk is encrypted. The install token stays plaintext (a
// capability URL that must be served, already exposed in install links).
//
// Locked mode: if the file holds sealed secrets but the key is missing or wrong,
// the store enters locked mode — reads blank the secrets (features degrade, but
// cached recommendations keep serving) and ALL writes are refused, so the
// on-disk ciphertext is never clobbered. Restore the key to recover, no loss.
const crypto = require('crypto');
const secret = require('./services/crypto');
const store = require('./store');
const { EXTRA_CATALOGS } = require('./catalogs');

// RPDB's generic free-tier key — works for everyone, pre-filled on every new
// profile. Replaceable per profile with a personal (paid-tier) key anytime.
const DEFAULT_RPDB_KEY = 't0-free-rpdb';

const DEFAULT_FILTERS = {
  min_rating: 7.0,
  rating_source: 'imdb', // 'imdb' (via MDBList) | 'tmdb' — TMDB scores run ~1 lower
  vote_count_floor: 1000, // noise gate; a high rating on few votes is meaningless
  max_age_years: 5, // recency window; 0 = no limit
  excluded_genres: [], // TMDB genre names, e.g. ["Horror", "War"]
  age_limit: 0, // Common Sense age gate; 0 = off. >0 requires an MDBList key
  list_size: 20, // displayed titles per catalog (+ an equal-sized hidden bench)
  pool_seed_count: 5, // history titles used to seed TMDB recommendations/similar
};

// Auto-scrobble: mirror this profile's Nuvio/Stremio watched history into
// Trakt. Per profile (no cross-account leakage). password_enc is AES-GCM (see
// services/crypto) — never plaintext. nuvio_profile_index picks which Nuvio
// household profile to read (Stremio has no sub-profiles).
const DEFAULT_SCROBBLE = {
  enabled: false,
  provider: 'nuvio', // 'nuvio' | 'stremio'
  email: '',
  password_enc: '', // AES-256-GCM blob; '' = unset
  nuvio_profile_index: null,
  nuvio_profile_name: '',
};
const SCROBBLE_PROVIDERS = ['nuvio', 'stremio'];

// Secret fields sealed at rest. The scrobble password_enc is already its own
// AES blob and the install token is deliberately excluded (see header).
const SECRET_KEY_FIELDS = ['trakt_client_id', 'trakt_client_secret', 'tmdb_api_key', 'groq_api_key', 'rpdb_api_key', 'mdblist_api_key'];
const SECRET_TOKEN_FIELDS = ['access_token', 'refresh_token'];

let locked = false;
function secretsLocked() {
  return locked;
}

function newProfile(name) {
  return {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomBytes(16).toString('hex'), // unguessable install-URL token
    keys: {
      trakt_client_id: '',
      trakt_client_secret: '',
      tmdb_api_key: '',
      groq_api_key: '',
      rpdb_api_key: DEFAULT_RPDB_KEY, // rating-overlay posters; free key pre-set
      mdblist_api_key: '', // required: extra catalogs + Common Sense age checks
    },
    trakt_auth: null, // { access_token, refresh_token, expires_at(ms) }
    filters: { ...DEFAULT_FILTERS },
    catalogs: {}, // extra-catalog toggles by id; absent/false = off. AI catalogs are always on.
    scrobble: { ...DEFAULT_SCROBBLE },
    created_at: Date.now(),
  };
}

// ---- Field-level migrations (add fields absent on older profiles) ----
function applyMigrations(p) {
  if (p.keys.rpdb_api_key === undefined) p.keys.rpdb_api_key = DEFAULT_RPDB_KEY;
  if (p.keys.mdblist_api_key === undefined) p.keys.mdblist_api_key = '';
  // Gemini -> Groq (LLM provider switch): the old key is useless for Groq, so
  // it's dropped rather than carried over. Users paste a Groq key.
  if (p.keys.groq_api_key === undefined) p.keys.groq_api_key = '';
  if (p.keys.gemini_api_key !== undefined) delete p.keys.gemini_api_key;
  if (p.filters.age_limit === undefined) p.filters.age_limit = 0;
  if (p.filters.list_size === undefined) p.filters.list_size = 20;
  if (p.filters.rating_source === undefined) p.filters.rating_source = 'imdb';
  if (p.filters.vote_count_floor === undefined) p.filters.vote_count_floor = 1000;
  if (p.filters.pool_seed_count === undefined) p.filters.pool_seed_count = 5;
  if (p.catalogs === undefined) p.catalogs = {};
  if (p.scrobble === undefined) p.scrobble = { ...DEFAULT_SCROBBLE };
}

// ---- Sealing (encryption at rest) ----
// Returns a sealed COPY for persistence; the input object is left plaintext.
function sealProfile(p) {
  const q = { ...p, keys: { ...p.keys } };
  for (const f of SECRET_KEY_FIELDS) if (q.keys[f]) q.keys[f] = secret.seal(q.keys[f]);
  if (q.trakt_auth) {
    q.trakt_auth = { ...q.trakt_auth };
    for (const t of SECRET_TOKEN_FIELDS) if (q.trakt_auth[t]) q.trakt_auth[t] = secret.seal(q.trakt_auth[t]);
  }
  return q;
}

// Decrypt secret fields in place. Throws if a sealed value can't be read
// (missing/wrong key) — callers catch it to enter locked mode.
function unsealProfileInPlace(p) {
  for (const f of SECRET_KEY_FIELDS) if (p.keys?.[f]) p.keys[f] = secret.unseal(p.keys[f]);
  if (p.trakt_auth) for (const t of SECRET_TOKEN_FIELDS) if (p.trakt_auth[t]) p.trakt_auth[t] = secret.unseal(p.trakt_auth[t]);
}

// Locked-mode read: replace unreadable sealed secrets with empty so no
// ciphertext is ever used as a key/token. The on-disk value is untouched.
function blankSecretsInPlace(p) {
  for (const f of SECRET_KEY_FIELDS) if (secret.isSealed(p.keys?.[f])) p.keys[f] = '';
  if (p.trakt_auth) for (const t of SECRET_TOKEN_FIELDS) if (secret.isSealed(p.trakt_auth[t])) p.trakt_auth[t] = '';
}

// Read path: migrate + unseal every profile to plaintext for use. On any
// decrypt failure, lock and blank (writes are then refused, preserving disk).
function listProfiles() {
  const profiles = store.loadProfiles().profiles;
  let anyLocked = false;
  for (const p of profiles) {
    applyMigrations(p);
    try {
      unsealProfileInPlace(p);
    } catch {
      anyLocked = true;
      blankSecretsInPlace(p);
    }
  }
  locked = anyLocked;
  return profiles;
}

// Write path: load raw -> migrate + unseal -> mutate (plaintext) -> reseal ->
// atomic save. Refuses if secrets can't be unsealed, so ciphertext is never
// overwritten with garbage.
function mutateProfiles(mutator) {
  const data = store.loadProfiles();
  try {
    for (const p of data.profiles) { applyMigrations(p); unsealProfileInPlace(p); }
  } catch {
    locked = true;
    throw new Error('Secrets are locked — SECRET_KEY is missing or invalid. Profile changes are disabled until the correct key is restored.');
  }
  const result = mutator(data);
  store.saveProfiles({ ...data, profiles: data.profiles.map(sealProfile) });
  return result;
}

function getProfile(id) {
  return listProfiles().find((p) => p.id === id) || null;
}

function getProfileByToken(token) {
  if (!token) return null;
  return listProfiles().find((p) => p.token === token) || null;
}

function addProfile(name) {
  const profile = newProfile(name);
  mutateProfiles((data) => { data.profiles.push(profile); });
  return profile; // plaintext (a new profile has no secrets yet)
}

function updateProfile(id, patch) {
  let updated = null;
  mutateProfiles((data) => {
    const profile = data.profiles.find((p) => p.id === id);
    if (!profile) return;
    if (patch.name !== undefined) profile.name = String(patch.name);
    if (patch.keys) Object.assign(profile.keys, patch.keys);
    if (patch.filters) {
      const f = patch.filters;
      if (f.min_rating !== undefined) profile.filters.min_rating = Math.max(0, Number(f.min_rating) || 0);
      if (f.max_age_years !== undefined) profile.filters.max_age_years = Math.max(0, parseInt(f.max_age_years, 10) || 0);
      if (Array.isArray(f.excluded_genres)) profile.filters.excluded_genres = f.excluded_genres.map(String);
      if (f.age_limit !== undefined) profile.filters.age_limit = Math.max(0, parseInt(f.age_limit, 10) || 0);
      if (f.list_size !== undefined) profile.filters.list_size = Math.min(50, Math.max(5, parseInt(f.list_size, 10) || 20));
      if (f.rating_source !== undefined) profile.filters.rating_source = f.rating_source === 'tmdb' ? 'tmdb' : 'imdb';
      if (f.vote_count_floor !== undefined) profile.filters.vote_count_floor = Math.max(0, parseInt(f.vote_count_floor, 10) || 0);
      if (f.pool_seed_count !== undefined) profile.filters.pool_seed_count = Math.min(10, Math.max(1, parseInt(f.pool_seed_count, 10) || 5));
    }
    if (patch.catalogs && typeof patch.catalogs === 'object') {
      // Only known catalog ids, coerced to booleans — the toggle set is the
      // whole payload, so unmentioned ids default to off.
      profile.catalogs = {};
      for (const def of EXTRA_CATALOGS) {
        if (patch.catalogs[def.id]) profile.catalogs[def.id] = true;
      }
    }
    if (patch.trakt_auth !== undefined) profile.trakt_auth = patch.trakt_auth;
    if (patch.scrobble && typeof patch.scrobble === 'object') {
      const s = patch.scrobble;
      if (!profile.scrobble) profile.scrobble = { ...DEFAULT_SCROBBLE };
      const sc = profile.scrobble;
      if (s.enabled !== undefined) sc.enabled = !!s.enabled;
      if (s.provider !== undefined && SCROBBLE_PROVIDERS.includes(s.provider)) sc.provider = s.provider;
      if (s.email !== undefined) sc.email = String(s.email).trim();
      // password_enc is written already-encrypted by the portal layer; '' clears it.
      if (s.password_enc !== undefined) sc.password_enc = String(s.password_enc);
      if (s.nuvio_profile_index !== undefined) {
        sc.nuvio_profile_index = s.nuvio_profile_index === null ? null : (parseInt(s.nuvio_profile_index, 10) || null);
      }
      if (s.nuvio_profile_name !== undefined) sc.nuvio_profile_name = String(s.nuvio_profile_name);
    }
    updated = profile;
  });
  return updated; // plaintext object, or null if not found
}

function removeProfile(id) {
  let removed = false;
  mutateProfiles((data) => {
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((p) => p.id !== id);
    removed = data.profiles.length < before;
  });
  if (removed) store.deleteCache(id);
  return removed;
}

// Startup: encrypt any plaintext secrets in place (one-time), or report the
// state. If the key can't read existing sealed data, lock rather than touch it.
function migrateSecrets() {
  if (!secret.encryptionAvailable()) {
    console.log('[secrets] SECRET_KEY not set — API keys and Trakt tokens are stored in plaintext');
    return;
  }
  const data = store.loadProfiles();
  // Verify the key reads existing sealed data before writing anything.
  try {
    for (const p of data.profiles) unsealProfileInPlace(JSON.parse(JSON.stringify(p)));
  } catch {
    locked = true;
    console.error('[secrets] SECRET_KEY is set but existing encrypted data cannot be decrypted — LOCKED. Profile edits are disabled; restore the correct key. No data was changed.');
    return;
  }
  const needsSeal = data.profiles.some((p) =>
    SECRET_KEY_FIELDS.some((f) => p.keys?.[f] && !secret.isSealed(p.keys[f]))
    || (p.trakt_auth && SECRET_TOKEN_FIELDS.some((t) => p.trakt_auth[t] && !secret.isSealed(p.trakt_auth[t]))));
  if (needsSeal) {
    store.saveProfiles({ ...data, profiles: data.profiles.map(sealProfile) });
    console.log('[secrets] encrypted existing plaintext secrets at rest ✓');
  } else {
    console.log('[secrets] secrets encrypted at rest ✓');
  }
}

module.exports = {
  DEFAULT_FILTERS,
  listProfiles,
  getProfile,
  getProfileByToken,
  addProfile,
  updateProfile,
  removeProfile,
  secretsLocked,
  migrateSecrets,
};
