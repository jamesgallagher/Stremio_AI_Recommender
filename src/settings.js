// Global server settings (v6). Shared infrastructure, one set for the whole
// addon — as opposed to per-profile identity (Simkl/filters/catalogs, in
// config.js). See docs/v6-ui.md for the split.
//
// Holds:
//   - the LLM chain: custom endpoint (tried first) → Groq primary → Groq backup
//   - the lookup keys: TMDB, MDBList, RPDB (single each)
//
// Secrets are sealed at rest with the same AES-GCM helper as profiles
// (services/crypto), transparently: callers always see plaintext, only
// settings.json holds ciphertext. Mirrors config.js's sealing model.
const secret = require('./services/crypto');
const store = require('./store');

// Secret fields (sealed on disk). Nested under their sections.
const LLM_SECRET_FIELDS = ['custom_api_key', 'groq_api_key', 'groq_api_key_backup'];
const KEY_SECRET_FIELDS = ['tmdb_api_key', 'mdblist_api_key', 'rpdb_api_key', 'tvdb_api_key', 'mal_client_id', 'anidb_client'];

const DEFAULT_RPDB_KEY = 't0-free-rpdb'; // generic free-tier key, as in v5

function blankSettings() {
  return {
    llm: {
      custom_name: '',        // display/model name sent as `model`
      custom_uri: '',         // OpenAI-compatible base, e.g. http://localhost:11434/v1
      custom_api_key: '',     // may be empty for keyless local servers
      groq_api_key: '',       // cloud fallback #1
      groq_api_key_backup: '', // cloud fallback #2
    },
    keys: {
      tmdb_api_key: '',
      mdblist_api_key: '',
      rpdb_api_key: DEFAULT_RPDB_KEY,
      tvdb_api_key: '', // AGE-1: TVDB v4 key for country certifications (sealed at rest)
      mal_client_id: '',    // AN-1a: MyAnimeList Client ID (server fallback)
      anidb_client: '',     // AN-1a: AniDB HTTP client name (server fallback)
      anidb_clientver: 0,   // AN-1a: that client's registered version number
    },
    // Marquee Tier-2 global admin config (ME-09) — the same pattern as Glass
    // (GE-07) but Marquee's own blob: engines/marquee/config.resolveConfig
    // merges it over Marquee's DEFAULTS and ignores unknown keys. Empty =
    // pure Tier-1 defaults. BUILD-AFFECTING — a change fans out
    // clearType+rebuild across Marquee movie slices (portal write path).
    marquee: {},
    created_at: null, // null until Server Config is first saved
  };
}

let locked = false;
function settingsLocked() { return locked; }

// ---- sealing ----
function sealSettings(s) {
  // ME-09: the Marquee Tier-2 blob is sealed like glass (plain object, no secrets).
  const q = { llm: { ...s.llm }, keys: { ...s.keys }, marquee: { ...(s.marquee || {}) }, created_at: s.created_at };
  for (const f of LLM_SECRET_FIELDS) if (q.llm[f]) q.llm[f] = secret.seal(q.llm[f]);
  for (const f of KEY_SECRET_FIELDS) if (q.keys[f]) q.keys[f] = secret.seal(q.keys[f]);
  return q;
}

function unsealSettingsInPlace(s) {
  for (const f of LLM_SECRET_FIELDS) if (s.llm?.[f]) s.llm[f] = secret.unseal(s.llm[f]);
  for (const f of KEY_SECRET_FIELDS) if (s.keys?.[f]) s.keys[f] = secret.unseal(s.keys[f]);
}

function blankSecretsInPlace(s) {
  for (const f of LLM_SECRET_FIELDS) if (secret.isSealed(s.llm?.[f])) s.llm[f] = '';
  for (const f of KEY_SECRET_FIELDS) if (secret.isSealed(s.keys?.[f])) s.keys[f] = '';
}

// Fill in any fields absent on an older/partial settings file.
function applyDefaults(s) {
  const base = blankSettings();
  const merged = {
    llm: { ...base.llm, ...(s.llm || {}) },
    keys: { ...base.keys, ...(s.keys || {}) },
    marquee: { ...base.marquee, ...(s.marquee || {}) },  // seeds {} on older files (ME-09)
    created_at: s.created_at ?? null,
  };
  // Strip legacy keys (SC-07 engines, GE-07 glass, GE-09 embed) on read.
  delete merged.engines;
  delete merged.glass;
  delete merged.llm.embed_uri;
  delete merged.llm.embed_model;
  delete merged.llm.embed_api_key;
  return merged;
}

// Read path: load → default → unseal to plaintext. On a decrypt failure (wrong/
// missing SECRET_KEY) lock and blank, exactly like config.js — features degrade
// but the ciphertext on disk is never clobbered.
function getSettings() {
  const raw = store.loadSettings();
  if (!raw) { locked = false; return null; } // never set up
  const s = applyDefaults(raw);
  try {
    unsealSettingsInPlace(s);
    locked = false;
  } catch {
    locked = true;
    blankSecretsInPlace(s);
  }
  return s;
}

// Write path: refuse in locked mode (would seal blanked secrets over good
// ciphertext). Merge patch, stamp created_at on first save, reseal, persist.
function updateSettings(patch) {
  if (locked) throw new Error('Settings are locked (SECRET_KEY missing/wrong) — refusing to write');
  const current = applyDefaults(store.loadSettings() || blankSettings());
  try { unsealSettingsInPlace(current); } catch {
    locked = true;
    throw new Error('Settings are locked (SECRET_KEY missing/wrong) — refusing to write');
  }
  if (patch.llm) Object.assign(current.llm, patch.llm);
  if (patch.keys) Object.assign(current.keys, patch.keys);
  // AN-1a: anidb_clientver is a positive integer or 0 (unset).
  if (patch.keys && patch.keys.anidb_clientver !== undefined) {
    const v = parseInt(patch.keys.anidb_clientver, 10);
    current.keys.anidb_clientver = Number.isFinite(v) && v > 0 ? v : 0;
  }
  // ME-09: Marquee Tier-2 config — replace-whole: any section left out reverts
  // to its Tier-1 default, since engines/marquee/config.resolveConfig backfills
  // from DEFAULTS. `{}` is a true reset to pure defaults.
  if (patch.marquee !== undefined) current.marquee = (patch.marquee && typeof patch.marquee === 'object') ? patch.marquee : {};
  if (!current.created_at) current.created_at = Date.now();
  store.saveSettings(sealSettings(current));
  return current;
}

// One-time migration: seed the global keys from the oldest/"James" profile
// (decided 2026-08-15). Runs only if settings.json doesn't exist yet and at
// least one profile carries usable keys. Non-destructive to profiles here — the
// per-profile key removal happens later in the v6 profile refactor.
function migrateFromProfiles(profiles) {
  if (store.loadSettings()) return null; // already set up
  if (!Array.isArray(profiles) || !profiles.length) return null;
  const source = profiles.find((p) => p.name === 'James')
    || [...profiles].sort((a, b) => (a.created_at || 0) - (b.created_at || 0))[0];
  if (!source) return null;
  const k = source.keys || {};
  const seeded = blankSettings();
  seeded.llm.groq_api_key = k.groq_api_key || '';
  seeded.keys.tmdb_api_key = k.tmdb_api_key || '';
  seeded.keys.mdblist_api_key = k.mdblist_api_key || '';
  seeded.keys.rpdb_api_key = k.rpdb_api_key || DEFAULT_RPDB_KEY;
  seeded.created_at = Date.now();
  store.saveSettings(sealSettings(seeded));
  return { seededFrom: source.name };
}

// Server Config is "complete" only when the essentials exist: TMDB (all lookups
// + recommendations) and at least one LLM provider (custom OR groq). Profiles
// hard-block until this is true (docs/v6-ui.md).
function isComplete(s = getSettings()) {
  if (!s) return false;
  const hasLlm = !!(s.llm.custom_uri || s.llm.groq_api_key);
  return !!s.keys.tmdb_api_key && hasLlm;
}

// The ordered LLM provider chain for the transport layer (services/llm.js).
// Custom first when configured, then Groq primary, then Groq backup.
function llmChain(s = getSettings()) {
  if (!s) return [];
  const chain = [];
  if (s.llm.custom_uri) {
    chain.push({ type: 'custom', name: s.llm.custom_name || 'custom', uri: s.llm.custom_uri, apiKey: s.llm.custom_api_key });
  }
  if (s.llm.groq_api_key) chain.push({ type: 'groq', apiKey: s.llm.groq_api_key, label: 'groq-primary' });
  if (s.llm.groq_api_key_backup) chain.push({ type: 'groq', apiKey: s.llm.groq_api_key_backup, label: 'groq-backup' });
  return chain;
}

// Is at least one LLM provider configured? (custom endpoint or a Groq key)
function hasLlm(s = getSettings()) {
  return llmChain(s).length > 0;
}

// Effective lookup key for a profile. Keys are GLOBAL (Server Config) in v6; a
// per-profile key is honoured only as a fallback for older profiles that still
// carry one. `field` is a keys field (tmdb/mdblist/rpdb_api_key) or groq_api_key.
function keyFor(profile, field) {
  const s = getSettings();
  const global = field === 'groq_api_key' ? s?.llm?.groq_api_key : s?.keys?.[field];
  return global || profile?.keys?.[field] || '';
}

// MDBList key resolution: personal (profile) first, then global (server), then none.
// Returns { key, source } where source is 'user' | 'server' | 'none'.
// Fallback is for an absent personal key only — an invalid/rate-limited personal
// key must NOT silently consume the server's quota.
function resolveMdblistKey(profile) {
  const personal = (profile?.keys?.mdblist_api_key || '').trim();
  if (personal) return { key: personal, source: 'user' };
  const global = (getSettings()?.keys?.mdblist_api_key || '').trim();
  if (global) return { key: global, source: 'server' };
  return { key: '', source: 'none' };
}

// AN-1a: MyAnimeList Client ID — personal first, then server, then none.
function resolveMalKey(profile) {
  const personal = (profile?.keys?.mal_client_id || '').trim();
  if (personal) return { key: personal, source: 'user' };
  const global = (getSettings()?.keys?.mal_client_id || '').trim();
  if (global) return { key: global, source: 'server' };
  return { key: '', source: 'none' };
}

// AN-1a: AniDB HTTP client — personal pair first, then server pair, then none.
// A pair needs BOTH a name and a version >= 1; half a pair is "none" at that level.
function resolveAnidbClient(profile) {
  const pick = (k) => {
    const client = (k?.anidb_client || '').trim();
    const clientver = parseInt(k?.anidb_clientver, 10);
    return client && clientver > 0 ? { client, clientver } : null;
  };
  const personal = pick(profile?.keys);
  if (personal) return { ...personal, source: 'user' };
  const global = pick(getSettings()?.keys);
  if (global) return { ...global, source: 'server' };
  return { client: '', clientver: 0, source: 'none' };
}

module.exports = {
  blankSettings,
  getSettings,
  updateSettings,
  migrateFromProfiles,
  isComplete,
  llmChain,
  hasLlm,
  keyFor,
  resolveMdblistKey,
  resolveMalKey,
  resolveAnidbClient,
  settingsLocked,
  DEFAULT_RPDB_KEY,
  LLM_SECRET_FIELDS,
  KEY_SECRET_FIELDS,
};
