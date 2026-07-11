// Profile management. All keys are per profile (decided 2026-07-03):
// Trakt client ID/secret + OAuth tokens, TMDB key, Gemini key.
const crypto = require('crypto');
const store = require('./store');
const { EXTRA_CATALOGS } = require('./catalogs');

// RPDB's generic free-tier key — works for everyone, pre-filled on every new
// profile. Replaceable per profile with a personal (paid-tier) key anytime.
const DEFAULT_RPDB_KEY = 't0-free-rpdb';

const DEFAULT_FILTERS = {
  min_rating: 7.0,
  max_age_years: 5, // recency window; 0 = no limit
  excluded_genres: [], // TMDB genre names, e.g. ["Horror", "War"]
  age_limit: 0, // Common Sense age gate; 0 = off. >0 requires an MDBList key
  list_size: 20, // fill-to-quota target per catalog
};

function newProfile(name) {
  return {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomBytes(16).toString('hex'), // unguessable install-URL token
    keys: {
      trakt_client_id: '',
      trakt_client_secret: '',
      tmdb_api_key: '',
      gemini_api_key: '',
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

function listProfiles() {
  const profiles = store.loadProfiles().profiles;
  // Migration: profiles created before the RPDB field existed get the free
  // key too (undefined = pre-feature; '' = explicitly cleared, respected).
  for (const p of profiles) {
    if (p.keys.rpdb_api_key === undefined) p.keys.rpdb_api_key = DEFAULT_RPDB_KEY;
    if (p.keys.mdblist_api_key === undefined) p.keys.mdblist_api_key = '';
    if (p.filters.age_limit === undefined) p.filters.age_limit = 0;
    if (p.filters.list_size === undefined) p.filters.list_size = 20;
    if (p.catalogs === undefined) p.catalogs = {};
    if (p.scrobble === undefined) p.scrobble = { ...DEFAULT_SCROBBLE };
  }
  return profiles;
}

function getProfile(id) {
  return listProfiles().find((p) => p.id === id) || null;
}

function getProfileByToken(token) {
  if (!token) return null;
  return listProfiles().find((p) => p.token === token) || null;
}

function addProfile(name) {
  const data = store.loadProfiles();
  const profile = newProfile(name);
  data.profiles.push(profile);
  store.saveProfiles(data);
  return profile;
}

function updateProfile(id, patch) {
  const data = store.loadProfiles();
  const profile = data.profiles.find((p) => p.id === id);
  if (!profile) return null;
  if (patch.name !== undefined) profile.name = String(patch.name);
  if (patch.keys) Object.assign(profile.keys, patch.keys);
  if (patch.filters) {
    const f = patch.filters;
    if (f.min_rating !== undefined) profile.filters.min_rating = Math.max(0, Number(f.min_rating) || 0);
    if (f.max_age_years !== undefined) profile.filters.max_age_years = Math.max(0, parseInt(f.max_age_years, 10) || 0);
    if (Array.isArray(f.excluded_genres)) profile.filters.excluded_genres = f.excluded_genres.map(String);
    if (f.age_limit !== undefined) profile.filters.age_limit = Math.max(0, parseInt(f.age_limit, 10) || 0);
    if (f.list_size !== undefined) profile.filters.list_size = Math.min(50, Math.max(5, parseInt(f.list_size, 10) || 20));
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
  store.saveProfiles(data);
  return profile;
}

function removeProfile(id) {
  const data = store.loadProfiles();
  const before = data.profiles.length;
  data.profiles = data.profiles.filter((p) => p.id !== id);
  store.saveProfiles(data);
  if (data.profiles.length < before) store.deleteCache(id);
  return data.profiles.length < before;
}

module.exports = {
  DEFAULT_FILTERS,
  listProfiles,
  getProfile,
  getProfileByToken,
  addProfile,
  updateProfile,
  removeProfile,
};
