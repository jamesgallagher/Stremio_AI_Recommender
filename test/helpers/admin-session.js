// AUTH-1: test helper for provisioning an admin session and attaching the
// air_sid cookie to HTTP requests. Used by suites that hit the /api surface
// (which now requires an admin session instead of Basic Auth).
const config = require('../../src/config');
const auth = require('../../mobile/server/auth');

// Create an admin profile (if none exists) and return a session token.
// Idempotent: if an admin already exists, creates a session for it.
function provisionAdmin() {
  const profiles = config.listProfiles();
  let admin = profiles.find((p) => p.is_admin === true);
  if (!admin) {
    if (profiles.length === 0) {
      admin = config.createInitialAdmin({ name: 'Test Admin', email: 'test-admin@example.com' });
    } else {
      // Promote the oldest profile with an email. If none has an email,
      // create a new admin (the existing profiles can't sign in).
      const promo = config.promoteFirstAdminIfMissing();
      if (promo.promoted) {
        admin = config.getProfile(promo.promoted);
      } else {
        admin = config.addProfile('Test Admin');
        config.updateProfile(admin.id, { email: 'test-admin@example.com', is_admin: true });
      }
    }
  }
  const { token } = auth.createSession(admin.id);
  return { token, profile: admin };
}

// Build the Cookie header value for a session token.
function cookieHeader(token) {
  return `air_sid=${token}`;
}

module.exports = { provisionAdmin, cookieHeader };
