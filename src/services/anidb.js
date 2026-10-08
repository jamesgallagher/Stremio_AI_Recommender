// AN-1a: the AniDB HTTP client. Fetches a single anime record by aid with
// strict flood control: ≥ 4000 ms spacing (server-wide, one request in flight
// at a time), a 30-day cache, a 24h repeat guard, a 150/day cap per client,
// back-off on timeout/5xx, and a ban circuit. Errors are detected in the BODY
// (HTTP 200 with an <error> body), not the status code.
const db = require('../db');
const settings = require('../settings');

const CACHE_TTL_MS = 30 * 86400e3; // 30-day cache
const REPEAT_GUARD_MS = 86400e3; // 24h repeat guard
const DAILY_CAP = 150; // 150 requests per client per Sydney day
const BAN_MS = 48 * 3600e3; // ban circuit: 48h
const TIMEOUT_MS = 15000; // 15s timeout
const BACKOFF_DELAYS = [4000, 16000, 60000]; // 4s, 16s, 60s
const SPACING_MS = 4000; // ≥ 4000ms between any two requests

// Fetch seam: tests stub fetch through this.
let fetchImpl = global.fetch;
function _setFetch(fn) { fetchImpl = fn; }
// Clock seam: tests control time through this.
let now = () => Date.now();
function _setNow(fn) { now = fn; }
// Server-wide spacing: the last request start (in-memory). On restart this is
// 0, so the persisted last_request_at (per client) is the fallback.
let lastRequestAt = 0;

// Waits that respect the clock seam, so tests don't sleep for real.
async function sleep(ms) {
  const target = now() + ms;
  while (now() < target) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

// Sydney calendar day (UTC+10), YYYY-MM-DD.
function sydneyDay(t) {
  const d = new Date(t + 10 * 3600e3);
  return d.toISOString().slice(0, 10);
}

// §6.3: slim JSON and the parser (reference code; keep the regexes).
const attr = (s, name) => { const m = s.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const CONTENT_TAGS = { 2748: 'sex', 2749: 'nudity', 2750: 'violence', 4096: 'gore' }; // AniDB content-indicator tag ids (parent 2604)

function parseAnime(xml) {
  const err = xml.match(/<error[^>]*>([^<]*)<\/error>/);
  if (err) return { error: decode(err[1]).trim() || 'unknown' };
  const root = xml.match(/<anime\s([^>]*)>/);
  if (!root) return { error: 'unparseable' };
  const pick = (re) => { const m = xml.match(re); return m ? decode(m[1]).trim() : null; };
  const tags = [];
  for (const m of xml.matchAll(/<tag\s([^>]*)>\s*<name>([^<]*)<\/name>/g)) {
    tags.push({ id: Number(attr(m[1], 'id')), parentid: Number(attr(m[1], 'parentid')) || null, weight: Number(attr(m[1], 'weight')) || 0, name: decode(m[2]) });
  }
  const content = {};
  for (const t of tags) if (CONTENT_TAGS[t.id]) content[CONTENT_TAGS[t.id]] = t.weight;
  const related = [];
  const relBlock = pick(/<relatedanime>([\s\S]*?)<\/relatedanime>/);
  if (relBlock) for (const m of relBlock.matchAll(/<anime\s+id="(\d+)"\s+type="([^"]*)"/g)) related.push({ aid: Number(m[1]), type: m[2] });
  const similar = [];
  const simBlock = pick(/<similaranime>([\s\S]*?)<\/similaranime>/);
  if (simBlock) for (const m of simBlock.matchAll(/<anime\s+id="(\d+)"\s+approval="(\d+)"\s+total="(\d+)"/g)) similar.push({ aid: Number(m[1]), approval: Number(m[2]), total: Number(m[3]) });
  const malIds = [];
  const malBlock = pick(/<resource type="2">([\s\S]*?)<\/resource>/);
  if (malBlock) for (const m of malBlock.matchAll(/<identifier>(\d+)<\/identifier>/g)) malIds.push(Number(m[1]));
  return {
    aid: Number(attr(root[1], 'id')),
    restricted: attr(root[1], 'restricted') === 'true',
    type: pick(/<type>([^<]*)<\/type>/),
    episodes: Number(pick(/<episodecount>(\d+)<\/episodecount>/)) || null,
    startdate: pick(/<startdate>([^<]*)<\/startdate>/),
    enddate: pick(/<enddate>([^<]*)<\/enddate>/),
    title: pick(/<title xml:lang="x-jat" type="main">([^<]*)<\/title>/),
    title_en: pick(/<title xml:lang="en" type="official">([^<]*)<\/title>/),
    rating: Number(pick(/<permanent[^>]*>([\d.]+)<\/permanent>/)) || null,
    tags: tags.filter((t) => t.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 40),
    content, related, similar, mal: malIds,
  };
}

function init() {
  db.get().exec(`
    CREATE TABLE IF NOT EXISTS anidb_anime (
      aid        INTEGER PRIMARY KEY,
      data       TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anidb_attempts (
      aid     INTEGER PRIMARY KEY,
      at      INTEGER NOT NULL,
      outcome TEXT
    );
    CREATE TABLE IF NOT EXISTS anidb_clients (
      client          TEXT PRIMARY KEY,
      day             TEXT,
      day_calls       INTEGER NOT NULL DEFAULT 0,
      last_request_at INTEGER,
      banned_until    INTEGER,
      last_error      TEXT,
      last_test_at    INTEGER,
      last_test_ok    INTEGER
    );
  `);
}

function clientRow(client) {
  const key = client.toLowerCase();
  let row = db.get().prepare('SELECT * FROM anidb_clients WHERE client = ?').get(key);
  if (!row) {
    db.get().prepare('INSERT INTO anidb_clients (client) VALUES (?)').run(key);
    row = db.get().prepare('SELECT * FROM anidb_clients WHERE client = ?').get(key);
  }
  return row;
}

function updateClient(client, fields) {
  const key = client.toLowerCase();
  const set = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  const vals = Object.values(fields);
  db.get().prepare(`UPDATE anidb_clients SET ${set} WHERE client = ?`).run(...vals, key);
}

function recordAttempt(aid, outcome) {
  db.get().prepare(
    'INSERT INTO anidb_attempts (aid, at, outcome) VALUES (?, ?, ?) ON CONFLICT(aid) DO UPDATE SET at = ?, outcome = ?'
  ).run(aid, now(), outcome, now(), outcome);
}

function recordDayCall(client) {
  const day = sydneyDay(now());
  const row = clientRow(client);
  if (row.day !== day) {
    updateClient(client, { day, day_calls: 1 });
  } else {
    updateClient(client, { day_calls: row.day_calls + 1 });
  }
}

function cacheAnime(aid, data) {
  db.get().prepare(
    'INSERT INTO anidb_anime (aid, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(aid) DO UPDATE SET data = ?, fetched_at = ?'
  ).run(aid, JSON.stringify(data), now(), JSON.stringify(data), now());
}

// §6.2: fresh cache (30-day TTL), no network.
function cachedAnime(aid) {
  const row = db.get().prepare('SELECT data, fetched_at FROM anidb_anime WHERE aid = ?').get(aid);
  if (!row) return null;
  if (now() - row.fetched_at > CACHE_TTL_MS) return null; // stale
  return JSON.parse(row.data);
}

// §6.1: server-wide spacing. The most recent request across all clients
// (in-memory OR persisted, so a restart can't burst).
async function waitForSpacing(client) {
  const persisted = db.get().prepare('SELECT MAX(last_request_at) AS max_at FROM anidb_clients').get().max_at || 0;
  const earliest = Math.max(lastRequestAt, persisted) + SPACING_MS;
  if (now() < earliest) {
    await sleep(earliest - now());
  }
  lastRequestAt = now();
  updateClient(client, { last_request_at: now() });
}

// §6.1: the endpoint.
async function requestAnime(client, clientver, aid) {
  const url = `http://api.anidb.net:9001/httpapi?request=anime&client=${encodeURIComponent(client)}&clientver=${clientver}&protover=1&aid=${aid}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return await res.text();
}

// §6.1: classify an <error> body — ban circuit, bad client, other.
function classifyError(xml, errorText) {
  const errMatch = xml.match(/<error([^>]*)>([^<]*)<\/error>/);
  const attrs = errMatch ? errMatch[1] : '';
  const code = attrs.match(/code="(\d+)"/);
  if ((code && code[1] === '302') || /client/i.test(errorText)) return 'client';
  if (/banned/i.test(errorText)) return 'banned';
  return 'other';
}

// §6.4: getAnime — the full flood-control order.
async function getAnime(aid, profile, log) {
  init();
  // 1. resolve the client (§4.3), else no-client.
  const client = settings.resolveAnidbClient(profile);
  if (client.source === 'none') return { skipped: 'no-client' };

  // 2. fresh cache → { cached: true }.
  const cached = cachedAnime(aid);
  if (cached) return { cached: true, data: cached };

  // 3. 24h repeat guard → repeat.
  const attempt = db.get().prepare('SELECT at FROM anidb_attempts WHERE aid = ?').get(aid);
  if (attempt && now() - attempt.at < REPEAT_GUARD_MS) return { skipped: 'repeat' };

  // 4. ban → banned.
  const row = clientRow(client.client);
  if (row.banned_until && now() < row.banned_until) return { skipped: 'banned' };

  // 5. daily cap → cap.
  const day = sydneyDay(now());
  if (row.day === day && row.day_calls >= DAILY_CAP) return { skipped: 'cap' };

  // 6. spacing + request.
  await waitForSpacing(client.client);
  recordDayCall(client.client);

  // §6.1 back-off: at most 3 attempts, waiting 4s, 16s, 60s.
  for (let i = 0; i < 3; i++) {
    let xml;
    try {
      xml = await requestAnime(client.client, client.clientver, aid);
    } catch (err) {
      // Timeout or network error.
      if (i < 2) {
        await sleep(BACKOFF_DELAYS[i]);
        continue;
      }
      recordAttempt(aid, 'timeout');
      return { error: 'timeout' };
    }

    const parsed = parseAnime(xml);
    if (parsed.error) {
      const kind = classifyError(xml, parsed.error);
      if (kind === 'banned') {
        const bannedUntil = now() + BAN_MS;
        updateClient(client.client, { banned_until: bannedUntil, last_error: 'banned' });
        recordAttempt(aid, 'banned');
        return { skipped: 'banned' };
      }
      if (kind === 'client') {
        updateClient(client.client, { last_error: 'client' });
        recordAttempt(aid, 'error:client');
        return { error: 'client' };
      }
      updateClient(client.client, { last_error: parsed.error });
      recordAttempt(aid, 'error:' + parsed.error);
      return { error: parsed.error };
    }

    // Success: cache and record.
    cacheAnime(aid, parsed);
    recordAttempt(aid, 'ok');
    return { data: parsed };
  }
}

// §6.4: testClient — a real request for aid 1, obeying spacing/cap/ban.
async function testClient({ client, clientver }) {
  init();
  const row = clientRow(client);

  // Cached OK within 24h → no request.
  if (row.last_test_ok && now() - row.last_test_at < 86400e3) {
    const d = new Date(row.last_test_at);
    const hhmm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    return { ok: true, detail: `✓ Client accepted (checked ${hhmm})` };
  }

  // Ban → no request.
  if (row.banned_until && now() < row.banned_until) {
    return { ok: false, error: `✗ AniDB has banned this client until ${new Date(row.banned_until).toLocaleString()}` };
  }

  // Daily cap → no request.
  const day = sydneyDay(now());
  if (row.day === day && row.day_calls >= DAILY_CAP) {
    return { ok: false, error: '✗ Daily limit reached — try tomorrow' };
  }

  // Spacing + request aid 1.
  await waitForSpacing(client);
  recordDayCall(client);

  let xml;
  try {
    xml = await requestAnime(client, clientver, 1);
  } catch (err) {
    return { ok: false, error: '✗ AniDB unreachable' };
  }

  const parsed = parseAnime(xml);
  if (parsed.error) {
    const kind = classifyError(xml, parsed.error);
    if (kind === 'banned') {
      const bannedUntil = now() + BAN_MS;
      updateClient(client, { banned_until: bannedUntil, last_error: 'banned', last_test_at: now(), last_test_ok: 0 });
      return { ok: false, error: `✗ AniDB has banned this client until ${new Date(bannedUntil).toLocaleString()}` };
    }
    if (kind === 'client') {
      updateClient(client, { last_error: 'client', last_test_at: now(), last_test_ok: 0 });
      return { ok: false, error: '✗ AniDB doesn\'t recognise this client' };
    }
    updateClient(client, { last_error: parsed.error, last_test_at: now(), last_test_ok: 0 });
    return { ok: false, error: `✗ ${parsed.error}` };
  }

  // Success: cache aid 1 and record the test.
  cacheAnime(1, parsed);
  updateClient(client, { last_test_at: now(), last_test_ok: 1 });
  return { ok: true, detail: '✓ Client accepted' };
}

// §6.4: clientStatus — the Advanced-tab status line.
function clientStatus(profile) {
  init();
  const client = settings.resolveAnidbClient(profile);
  if (client.source === 'none') {
    return { source: 'none', client: '', today: 0, cap: DAILY_CAP, banned_until: null, last_error: null };
  }
  const row = clientRow(client.client);
  const day = sydneyDay(now());
  return {
    source: client.source,
    client: client.client,
    today: row.day === day ? row.day_calls : 0,
    cap: DAILY_CAP,
    banned_until: row.banned_until || null,
    last_error: row.last_error || null,
  };
}

// Test seam: clear all state (in-memory + persisted) on the current DATA_DIR.
function _resetForTests() {
  lastRequestAt = 0;
  db.get().exec('DELETE FROM anidb_anime; DELETE FROM anidb_attempts; DELETE FROM anidb_clients;');
}

module.exports = { init, getAnime, cachedAnime, testClient, clientStatus, parseAnime, _setFetch, _setNow, _resetForTests };
