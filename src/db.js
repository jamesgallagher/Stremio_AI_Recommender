// SQLite via Node's built-in node:sqlite (v6). No native module, no build
// tools — enabled by the --experimental-sqlite flag (see package.json / the
// Dockerfile). Holds the relational stores that the disk-backed JSON cache
// handles poorly: the watched table and (later) the recommendation table.
//
// One database file on the /data volume, alongside profiles.json.
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'node:sqlite is unavailable — run Node 22+ with --experimental-sqlite '
    + `(start scripts and the Dockerfile set this). Original: ${err.message}`,
  );
}

const store = require('./store');

let db = null;

// Lazy singleton. WAL mode so a background sync writing doesn't block a serve
// reading. The file lives under DATA_DIR (ensureDirs already created it).
function get() {
  if (db) return db;
  store.ensureDirs();
  const file = path.join(store.DATA_DIR, 'store.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

// Test/maintenance helper: close so a fresh DATA_DIR opens a new file.
function close() {
  if (db) { try { db.close(); } catch { /* already closed */ } db = null; }
}

module.exports = { get, close };
