// Reversible credential encryption for the auto-scrobble feature.
//
// Provider passwords (Nuvio/Stremio) must be replayed to log in, so they can't
// be hashed — they're encrypted at rest with AES-256-GCM. The key is derived
// (SHA-256) from the SCROBBLE_KEY env var, so any passphrase works and the key
// itself never lives on the /data volume: a leaked profiles.json backup is
// useless without the separately-held env secret.
//
// Honest threat model: this defends against config/backup exposure, NOT against
// an attacker who already has the container's environment (they can derive the
// key too). That's the realistic ceiling for any service that must replay a
// password. With SCROBBLE_KEY unset, storing a password is refused outright —
// the feature never silently falls back to plaintext.
const crypto = require('crypto');

function getKey() {
  const raw = process.env.SCROBBLE_KEY || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest(); // 32 bytes
}

function encryptionAvailable() {
  return !!getKey();
}

// Returns "v1:<iv>:<tag>:<ciphertext>" (all base64). Throws if no key.
function encrypt(plaintext) {
  const key = getKey();
  if (!key) throw new Error('SCROBBLE_KEY is not set — cannot store credentials securely');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  const key = getKey();
  if (!key) throw new Error('SCROBBLE_KEY is not set — cannot read stored credentials');
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unrecognized credential format');
  const [, ivb, tagb, ctb] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
  decipher.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctb, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, encryptionAvailable };
