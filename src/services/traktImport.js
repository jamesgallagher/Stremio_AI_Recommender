// Trakt → Simkl one-time importer (v6). Ports the standalone SimklImporter tool
// into the app so it shares the profile's stored Simkl token and, critically,
// the central rate governor — a second, uncoordinated throttle would double the
// live API load and risk the client_id suspension Simkl hands out without appeal
// (docs/v6-plan §6b; the "once and done" migration path from Trakt).
//
// Flow: read the Trakt export ZIP -> collect watched-history-*.json rows ->
// collapse repeat plays to the EARLIEST watch (never a rewatch) -> drop anything
// already in Simkl -> POST the remainder to /sync/history in <=50-item batches.
// The caller then runs a normal Simkl resync to pull the now-updated history
// into the local watched store.
const zlib = require('zlib');
const simkl = require('./simkl');

const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// ZIP reading (zero-dependency, matches the project's minimal-deps philosophy)
// ---------------------------------------------------------------------------
// Trakt exports are standard ZIPs (deflate, no Zip64). We parse the central
// directory, then inflate only the watched-history-*.json entries — we never
// need the other 50+ files (ratings, lists, network, …). Verified against a
// real 461 KB export: 72 entries, all deflate, 15 history files.

const SIG_EOCD = 0x06054b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

function findEocd(buf) {
  // EOCD is 22 bytes + up to 65535 of trailing comment. Scan back from the end.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('Not a valid ZIP file (no end-of-central-directory record). Upload the .zip Trakt gave you, not an extracted folder.');
}

// Return [{ name, method, offset }] for entries whose name matches `nameRe`.
function centralEntries(buf, nameRe) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let o = buf.readUInt32LE(eocd + 16); // central directory offset
  const out = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(o) !== SIG_CDH) break; // malformed / truncated
    const method = buf.readUInt16LE(o + 10);
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const commentLen = buf.readUInt16LE(o + 32);
    const localOffset = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nameLen);
    if (nameRe.test(name)) out.push({ name, method, localOffset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Inflate one entry's data, reading the LOCAL header (its extra field length can
// differ from the central directory's, so the data offset must come from here).
function readEntry(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== SIG_LFH) throw new Error(`Corrupt ZIP entry: ${entry.name}`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  // We can't trust the local-header compressed size (it's 0 when a data
  // descriptor is used), so slice to the next entry via the CD is overkill —
  // inflateRaw stops at the deflate stream's end marker on its own.
  const data = buf.subarray(start);
  if (entry.method === 0) return data; // stored
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

// Pull every row out of the watched-history-*.json files inside the export ZIP.
function extractWatchHistory(zipBuffer) {
  const entries = centralEntries(zipBuffer, /(^|\/)watched-history-\d+\.json$/i)
    .sort((a, b) => fileIndex(a.name) - fileIndex(b.name));
  if (entries.length === 0) {
    throw new Error('No watched-history-*.json files found in the ZIP. This does not look like a Trakt data export.');
  }
  const rows = [];
  for (const entry of entries) {
    let text;
    try {
      text = readEntry(zipBuffer, entry).toString('utf8');
    } catch (err) {
      throw new Error(`Failed to read ${entry.name} from the ZIP: ${err.message}`);
    }
    let data;
    try { data = JSON.parse(text); } catch (err) {
      throw new Error(`Malformed JSON in ${entry.name}: ${err.message}`);
    }
    if (Array.isArray(data)) rows.push(...data);
  }
  return rows;
}

function fileIndex(name) {
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Normalize + collapse (port of SimklImporter's TraktExportParser)
// ---------------------------------------------------------------------------
// One watch per unique title/episode, keeping the EARLIEST watched_at. Episodes
// are keyed by SHOW ids + SxxExx (episode-level ids in the export are unreliable).

function idKey(ids) {
  if (!ids) return null;
  if (ids.imdb) return `imdb:${ids.imdb}`;
  if (ids.tmdb != null) return `tmdb:${ids.tmdb}`;
  if (ids.trakt != null) return `trakt:${ids.trakt}`;
  if (ids.slug) return `slug:${ids.slug}`;
  return null;
}

// Every id present, for dedup matching against Simkl's id variants.
function candidateIdKeys(ids) {
  if (!ids) return [];
  const out = [];
  if (ids.imdb) out.push(`imdb:${ids.imdb}`);
  if (ids.tmdb != null) out.push(`tmdb:${ids.tmdb}`);
  if (ids.tvdb != null) out.push(`tvdb:${ids.tvdb}`);
  if (ids.trakt != null) out.push(`trakt:${ids.trakt}`);
  if (ids.slug) out.push(`slug:${ids.slug}`);
  if (ids.simkl != null) out.push(`simkl:${ids.simkl}`);
  return out;
}

function normalizeRow(row) {
  if (!row || !row.watched_at) return null;
  if (row.type === 'movie' && row.movie) {
    const key = idKey(row.movie.ids);
    if (!key) return null;
    return { kind: 'movie', key, ids: row.movie.ids, title: row.movie.title, year: row.movie.year, watchedAt: row.watched_at };
  }
  if (row.type === 'episode' && row.episode && row.show) {
    const showKey = idKey(row.show.ids);
    if (!showKey) return null;
    const { season, number } = row.episode;
    if (season == null || number == null) return null;
    return {
      kind: 'episode', key: `${showKey}|S${season}E${number}`,
      showIds: row.show.ids, showTitle: row.show.title, showYear: row.show.year,
      season, number, watchedAt: row.watched_at,
    };
  }
  return null;
}

function collapseToEarliest(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const n = normalizeRow(row);
    if (!n) continue;
    const existing = byKey.get(n.key);
    if (!existing) byKey.set(n.key, n);
    else if (n.watchedAt < existing.watchedAt) existing.watchedAt = n.watchedAt; // ISO strings sort chronologically
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Existing-Simkl dedup (port of SimklApiClient.getExistingKeys)
// ---------------------------------------------------------------------------
// Data lives at /sync/all-items/{movies,shows,anime}; shows/anime need
// ?extended=full for the watched-episode detail. A fully-watched show returns an
// EMPTY seasons array, so it's marked with a `<show>|ALL` sentinel and all its
// episodes are treated as watched. GETs route through the governor (simkl_get).

async function getExistingKeys(profile) {
  const keys = new Set();
  await collectMovieKeys(profile, keys);
  await collectEpisodeKeys(profile, 'shows', keys);
  await collectEpisodeKeys(profile, 'anime', keys);
  return keys;
}

async function collectMovieKeys(profile, keys) {
  const data = await simkl.authedGet(profile, '/sync/all-items/movies');
  const items = data?.movies ?? (Array.isArray(data) ? data : []);
  for (const it of items) {
    if (it?.status && it.status !== 'completed') continue; // watched movies only
    const ids = it?.movie?.ids ?? it?.ids ?? {};
    for (const k of candidateIdKeys(ids)) keys.add(k);
  }
}

async function collectEpisodeKeys(profile, type, keys) {
  const data = await simkl.authedGet(profile, `/sync/all-items/${type}`, { extended: 'full' });
  const items = data?.shows ?? data?.anime ?? (Array.isArray(data) ? data : []);
  for (const it of items) {
    const ids = it?.show?.ids ?? it?.ids ?? {};
    const showKeys = candidateIdKeys(ids);
    if (showKeys.length === 0) continue;
    if (it?.status === 'completed') { // whole show watched; Simkl omits episodes
      for (const sk of showKeys) keys.add(`${sk}|ALL`);
      continue;
    }
    for (const season of it?.seasons ?? []) {
      const sn = season?.number;
      for (const ep of season?.episodes ?? []) {
        const en = ep?.number;
        if (sn == null || en == null) continue;
        for (const sk of showKeys) keys.add(`${sk}|S${sn}E${en}`);
      }
    }
  }
}

function existsInSimkl(w, existing) {
  if (w.kind === 'movie') return candidateIdKeys(w.ids).some((k) => existing.has(k));
  return candidateIdKeys(w.showIds).some(
    (sk) => existing.has(`${sk}|S${w.season}E${w.number}`) || existing.has(`${sk}|ALL`),
  );
}

// ---------------------------------------------------------------------------
// Payload build (port of buildPayload) — Simkl /sync/history shape
// ---------------------------------------------------------------------------

function buildPayload(watches) {
  const movies = [];
  const showMap = new Map(); // showKey -> { ids, title, year, seasons: Map<number, Map<number, watchedAt>> }
  for (const w of watches) {
    if (w.kind === 'movie') {
      movies.push({ watched_at: w.watchedAt, title: w.title, year: w.year, ids: { imdb: w.ids.imdb, tmdb: w.ids.tmdb, tvdb: w.ids.tvdb } });
    } else {
      const showKey = candidateIdKeys(w.showIds)[0] ?? w.key;
      let entry = showMap.get(showKey);
      if (!entry) { entry = { ids: w.showIds, title: w.showTitle, year: w.showYear, seasons: new Map() }; showMap.set(showKey, entry); }
      let season = entry.seasons.get(w.season);
      if (!season) { season = new Map(); entry.seasons.set(w.season, season); }
      const prev = season.get(w.number);
      if (!prev || w.watchedAt < prev) season.set(w.number, w.watchedAt);
    }
  }
  const shows = [];
  for (const entry of showMap.values()) {
    shows.push({
      title: entry.title, year: entry.year,
      ids: { imdb: entry.ids.imdb, tmdb: entry.ids.tmdb, tvdb: entry.ids.tvdb },
      seasons: [...entry.seasons.entries()].map(([number, eps]) => ({
        number, episodes: [...eps.entries()].map(([n, watched_at]) => ({ number: n, watched_at })),
      })),
    });
  }
  return { movies, shows };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Import a Trakt export ZIP buffer into the profile's Simkl account.
// `progress(pct, label)` is optional (the job queue supplies it). Returns a
// summary the portal shows; the caller runs the Simkl resync afterwards.
async function importFromZip(profile, zipBuffer, log = console, progress = () => {}) {
  if (!profile.keys?.simkl_client_id || !profile.simkl_auth?.access_token) {
    throw new Error('Simkl is not connected for this profile');
  }

  progress(2, 'Reading Trakt export');
  const rows = extractWatchHistory(zipBuffer);
  const watches = collapseToEarliest(rows);
  log.log(`[trakt-import] ${profile.name}: parsed ${rows.length} history rows -> ${watches.length} unique watches`);

  progress(12, 'Reading Simkl history');
  const existing = await getExistingKeys(profile);
  log.log(`[trakt-import] ${profile.name}: Simkl already has ${existing.size} id-keys on record`);

  const toImport = watches.filter((w) => !existsInSimkl(w, existing));
  const alreadyInSimkl = watches.length - toImport.length;
  log.log(`[trakt-import] ${profile.name}: skipping ${alreadyInSimkl} already in Simkl; importing ${toImport.length}`);

  const batches = chunk(toImport, BATCH_SIZE);
  let postRequests = 0;
  for (let i = 0; i < batches.length; i++) {
    await simkl.addToHistory(profile, buildPayload(batches[i])); // governed 1 POST/s
    postRequests++;
    // Reserve 12–90% of the bar for the import POSTs (the long, paced phase).
    progress(12 + Math.round(((i + 1) / batches.length) * 78), `Importing to Simkl (batch ${i + 1}/${batches.length})`);
  }

  const result = {
    parsed: rows.length,
    collapsed: watches.length,
    alreadyInSimkl,
    imported: toImport.length,
    postRequests,
  };
  log.log(`[trakt-import] ${profile.name}: done — ${JSON.stringify(result)}`);
  return result;
}

module.exports = {
  importFromZip,
  // exported for tests / reuse
  extractWatchHistory,
  collapseToEarliest,
  buildPayload,
  existsInSimkl,
  candidateIdKeys,
};
