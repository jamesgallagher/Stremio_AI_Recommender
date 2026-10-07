#!/usr/bin/env node
// AUTH-1 break-glass admin promotion. Replaces the old Basic Auth as the
// recovery path when the web UI is unreachable. Requires shell access to the
// container. Never demotes anyone — only promotes.
//
// Usage (inside the container):
//   node --experimental-sqlite scripts/set-admin.js --email <address> [--profile "<name>"]

const config = require('../src/config');

function fail(msg) {
  process.stderr.write('set-admin: ' + msg + '\n');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let email = null;
  let profile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email') {
      email = args[++i];
    } else if (args[i] === '--profile') {
      profile = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node --experimental-sqlite scripts/set-admin.js --email <address> [--profile "<name>"]');
      process.exit(0);
    } else {
      fail('unknown argument: ' + args[i]);
    }
  }

  if (!email) fail('missing --email <address>');

  const profiles = config.listProfiles();

  // With --profile: find by exact name (case-insensitive, trimmed), set email + is_admin in one call.
  if (profile) {
    const p = profiles.find((x) => x.name.trim().toLowerCase() === profile.trim().toLowerCase());
    if (!p) fail('no profile named "' + profile + '"');
    try {
      config.updateProfile(p.id, { email, is_admin: true });
      console.log('Admin set: ' + p.name + ' ' + email);
    } catch (err) {
      fail(err.message);
    }
    return;
  }

  // With --email only: find the profile whose normalised email matches.
  const norm = email.trim().toLowerCase();
  const p = profiles.find((x) => x.email && x.email.trim().toLowerCase() === norm);
  if (!p) fail('no profile with email "' + email + '"');
  try {
    config.updateProfile(p.id, { is_admin: true });
    console.log('Admin set: ' + p.name + ' ' + p.email);
  } catch (err) {
    fail(err.message);
  }
}

main();
