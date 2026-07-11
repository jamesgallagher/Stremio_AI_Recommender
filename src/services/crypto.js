// Reversible secret encryption at rest.
//
// Covers the auto-scrobble provider passwords AND (v2.5.0) every per-profile
// API key and Trakt OAuth token. Secrets that must be replayed can't be hashed,
// so they're AES-256-GCM encrypted with a key derived (SHA-256) from the
// SECRET_KEY env var (SCROBBLE_KEY still accepted as a legacy alias). The key
// never lives on the /data volume, so a leaked profiles.json backup is useless
// without the separately-held env secret.
//
// Honest threat model: this defends against config/backup exposure, NOT against
// an attacker who already has the container's environment (they can derive the
// key too). That's the realistic ceiling for any service that must replay a
// secret. With no key set, sealing is a no-op (values stay plaintext — opt-in),
// and storing a scrobble password is refused outright rather than risk plaintext.
const crypto = require('crypto');

function getKey() {
  const raw = process.env.SECRET_KEY || process.env.SCROBBLE_KEY || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest(); // 32 bytes
}

function encryptionAvailable() {
  return !!getKey();
}

// Returns "v1:<iv>:<tag>:<ciphertext>" (all base64). Throws if no key.
function encrypt(plaintext) {
  const key = getKey();
  if (!key) throw new Error('SECRET_KEY is not set — cannot store credentials securely');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  const key = getKey();
  if (!key) throw new Error('SECRET_KEY is not set — cannot read stored credentials');
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unrecognized credential format');
  const [, ivb, tagb, ctb] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
  decipher.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctb, 'base64')), decipher.final()]).toString('utf8');
}

// ---- Field sealing for stored secrets ----
// An in-band "enc::" marker distinguishes an encrypted value from a legacy
// plaintext one, so migration is transparent: unseal passes through anything
// unmarked. seal is a no-op without a key (opt-in encryption).
const SEAL_PREFIX = 'enc::';

function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEAL_PREFIX);
}

function seal(value) {
  if (value === '' || value === null || value === undefined) return value; // nothing to seal
  if (isSealed(value)) return value; // already sealed — idempotent
  if (!getKey()) return value; // no key: leave plaintext (opt-in)
  return SEAL_PREFIX + encrypt(String(value));
}

// Returns the plaintext. Marked values require the key: throws if it's missing
// or wrong (GCM auth failure) so the caller can lock rather than use garbage.
function unseal(value) {
  if (!isSealed(value)) return value; // legacy plaintext
  if (!getKey()) throw new Error('sealed secret present but SECRET_KEY is not set');
  return decrypt(value.slice(SEAL_PREFIX.length));
}

module.exports = { encrypt, decrypt, encryptionAvailable, seal, unseal, isSealed };
