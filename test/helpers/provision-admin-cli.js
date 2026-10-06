// AUTH-1: CLI for test suites that spawn the server as a child process.
// Creates an admin profile + session token, prints the token to stdout.
// Usage: node --experimental-sqlite test/helpers/provision-admin-cli.js
const config = require('../../src/config');
const auth = require('../../mobile/server/auth');

const profiles = config.listProfiles();
let admin = profiles.find((p) => p.is_admin === true);
if (!admin) {
  if (profiles.length === 0) {
    admin = config.createInitialAdmin({ name: 'Test Admin', email: 'test-admin@example.com' });
  } else {
    const promo = config.promoteFirstAdminIfMissing();
    admin = promo.promoted ? config.getProfile(promo.promoted) : null;
    if (!admin) { console.error('No admin could be provisioned'); process.exit(1); }
  }
}
const { token } = auth.createSession(admin.id);
console.log(token);
