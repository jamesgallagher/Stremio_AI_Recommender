// Profile management. All keys are per profile (decided 2026-07-03):
// Trakt client ID/secret + OAuth tokens, TMDB key, Gemini key.
const crypto = require('crypto');
const store = require('./store');

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
      mdblist_api_key: '', // required only when an age limit is set (CSM lookups)
    },
    trakt_auth: null, // { access_token, refresh_token, expires_at(ms) }
    filters: { ...DEFAULT_FILTERS },
    created_at: Date.now(),
  };
}

function listProfiles() {
  const profiles = store.loadProfiles().profiles;
  // Migration: profiles created before the RPDB field existed get the free
  // key too (undefined = pre-feature; '' = explicitly cleared, respected).
  for (const p of profiles) {
    if (p.keys.rpdb_api_key === undefined) p.keys.rpdb_api_key = DEFAULT_RPDB_KEY;
    if (p.keys.mdblist_api_key === undefined) p.keys.mdblist_api_key = '';
    if (p.filters.age_limit === undefined) p.filters.age_limit = 0;
    if (p.filters.list_size === undefined) p.filters.list_size = 20;
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
  if (patch.trakt_auth !== undefined) profile.trakt_auth = patch.trakt_auth;
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
