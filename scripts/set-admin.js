#!/usr/bin/env node
// Break-glass admin promotion. Use when the web UI is unreachable (e.g. all
// admins locked out, no session cookie available). Enforces the same
// invariants as the API: at least one admin, admin requires an email,
// is_admin must be a boolean.
//
// Usage:
//   node scripts/set-admin.js list
//   node scripts/set-admin.js set <name-or-id>
//   node scripts/set-admin.js unset <name-or-id>
//
// "set" promotes a profile to admin (requires an email on the profile).
// "unset" demotes a profile (refuses if it would leave zero admins).
// The name matches case-insensitively against the profile's name field.

const config = require('../src/config');

const USAGE = `Usage:
  node scripts/set-admin.js list
  node scripts/set-admin.js set <name-or-id>
  node scripts/set-admin.js unset <name-or-id>`;

function list() {
  const profiles = config.listProfiles();
  if (profiles.length === 0) {
    console.log('No profiles.');
    return;
  }
  console.log(`${profiles.length} profile(s):`);
  for (const p of profiles) {
    const flag = p.is_admin === true ? ' [admin]' : '';
    const email = p.email ? ` (${p.email})` : ' (no email)';
    console.log(`  ${p.id}  ${p.name}${flag}${email}`);
  }
}

function findProfile(nameOrId) {
  const profiles = config.listProfiles();
  // Exact id match first.
  let match = profiles.find((p) => p.id === nameOrId);
  if (!match) {
    // Case-insensitive name match.
    const lower = nameOrId.toLowerCase();
    match = profiles.find((p) => p.name.toLowerCase() === lower);
  }
  return match || null;
}

function set(nameOrId) {
  const p = findProfile(nameOrId);
  if (!p) {
    console.error(`No profile matching "${nameOrId}".`);
    process.exit(1);
  }
  try {
    config.updateProfile(p.id, { is_admin: true });
    console.log(`Promoted "${p.name}" to admin.`);
  } catch (err) {
    console.error(`Refused: ${err.message}`);
    process.exit(1);
  }
}

function unset(nameOrId) {
  const p = findProfile(nameOrId);
  if (!p) {
    console.error(`No profile matching "${nameOrId}".`);
    process.exit(1);
  }
  if (p.is_admin !== true) {
    console.error(`"${p.name}" is not an admin.`);
    process.exit(1);
  }
  try {
    config.updateProfile(p.id, { is_admin: false });
    console.log(`Demoted "${p.name}" from admin.`);
  } catch (err) {
    console.error(`Refused: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const cmd = args[0];
  if (cmd === 'list') {
    list();
  } else if (cmd === 'set') {
    if (args.length < 2) { console.error('Missing profile name/ID.'); console.log(USAGE); process.exit(1); }
    set(args[1]);
  } else if (cmd === 'unset') {
    if (args.length < 2) { console.error('Missing profile name/ID.'); console.log(USAGE); process.exit(1); }
    unset(args[1]);
  } else {
    console.error(`Unknown command "${cmd}".`);
    console.log(USAGE);
    process.exit(1);
  }
}

main();
