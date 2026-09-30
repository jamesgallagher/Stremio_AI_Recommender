// Marquee ME-00 (docs/engine-marquee/cards/ME-00-live-verify.md): MANUAL
// live-API verification of the assumptions the Marquee design cannot confirm
// from the docs alone — the Simkl ratings shape, users_recommendations
// presence, and whether TMDB certification.lte / with_release_type behave as
// spec §3.1 assumes.
//
// It is NOT part of `npm test` — it makes REAL GET calls against the real
// Simkl + TMDB APIs. READ-ONLY: GET requests only, never a Simkl POST, never
// a write to the DB or the JSON caches. Every Simkl call goes through
// simkl.authedGet (the governed simkl_get lane); every TMDB call goes through
// the governed tmdb lane. Total Simkl calls ≤ 10.
//
// ── Run: ──
//   node --experimental-sqlite test/verify-marquee-live.js --profile="Name"
//
// Creds: uses a Simkl-connected profile from DATA_DIR (needs SECRET_KEY set,
// same as the app). Override with --profile="Name", or bypass the local
// data/DB entirely with explicit env creds:
//   SIMKL_CLIENT_ID=... SIMKL_ACCESS_TOKEN=... TMDB_API_KEY=... node --experimental-sqlite test/verify-marquee-live.js
//
// Without env creds, the TMDB key comes from the server settings
// (settings.getSettings().keys.tmdb_api_key).
//
// Guardrails: --help; exit non-zero if any check FAILs; a Simkl 429 stops the
// run immediately (no retries — Simkl suspends client ids for abuse).
const simkl = require('../src/services/simkl');
const tmdb = require('../src/services/tmdb');
const governor = require('../src/services/governor');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def = null) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def; // '--' + name + '='
};

const TMDB_API = 'https://api.themoviedb.org/3';

let tmdbKey = '';
// A tiny governed GET on the tmdb lane (tmdb.get is not exported; this
// mirrors its auth handling — v4 bearer tokens vs v3 api keys).
async function tmdbGet(endpoint, params = {}) {
  const url = new URL(`${TMDB_API}/${endpoint}`);
  const headers = tmdbKey.length > 50 ? { Authorization: `Bearer ${tmdbKey}` } : {};
  const auth = tmdbKey.length > 50 ? {} : { api_key: tmdbKey };
  for (const [k, v] of Object.entries({ ...auth, ...params })) url.searchParams.set(k, v);
  const res = await governor.schedule('tmdb', () => fetch(url, { headers }));
  if (!res.ok) throw new Error(`TMDB ${endpoint} failed (${res.status})`);
  return res.json();
}

// Output hygiene: one redacted sample payload per endpoint — arrays truncated
// to 2 items, strings to 80 characters. Never print tokens, client ids, API
// keys or the account name.
function redact(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 2).map(redact);
    if (value.length > 2) head.push(`…(+${value.length - 2} more)`);
    return head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return value;
}

// Simkl call accounting + the 429 stop (no retries).
let simklCalls = 0;
let stopped = null;
async function simklGet(profile, path, extra = {}) {
  simklCalls += 1;
  try {
    return await simkl.authedGet(profile, path, extra);
  } catch (err) {
    if (/429/.test(err.message)) stopped = `Simkl 429 on ${path} — stopping (no retries)`;
    throw err;
  }
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO';
  console.log(`  ${name}: ${tag} — ${detail}`);
}

// V1: GET /sync/ratings/movies — the user's movie ratings (the strongest
// explicit taste signal, spec §2).
async function checkV1(profile) {
  const data = await simklGet(profile, '/sync/ratings/movies');
  const topShape = Array.isArray(data) ? 'array' : `object (keys: ${Object.keys(data || {}).join(', ') || 'none'})`;
  const entries = Array.isArray(data) ? data : (data.movies || []);
  if (!Array.isArray(entries) || !entries.length) {
    record('V1', false, `no movie rating entries found (top-level ${topShape})`);
    return null;
  }
  const first = entries[0];
  const ratingField = Object.keys(first || {}).find((k) => /rating/i.test(k));
  const ids = first?.ids || {};
  const ratedAt = Object.keys(first || {}).find((k) => /rated_at|rating_date|updated/i.test(k));
  record('V1', true,
    `top-level ${topShape}; ${entries.length} entries; rating field "${ratingField || '?'}"; `
    + `ids: tmdb=${ids.tmdb != null ? 'present' : 'absent'} imdb=${ids.imdb != null ? 'present' : 'absent'} `
    + `simkl=${ids.simkl != null ? 'present' : 'absent'}; rated-at "${ratedAt || '?'}"`);
  console.log('  sample (redacted): ' + JSON.stringify(redact(first)));
  return entries;
}

// V1b: GET /sync/activities — the movies ratings timestamp P2 gates its
// re-pull on (e.g. movies.rated_at).
async function checkV1b(profile) {
  const data = await simklGet(profile, '/sync/activities');
  const movies = data?.movies || {};
  const keys = Object.keys(movies || {});
  const ratedKey = keys.find((k) => /rated/i.test(k));
  record('V1b', ratedKey ? true : false,
    `activities.movies keys: ${keys.join(', ') || '(none)'}; movies ratings timestamp path: ${ratedKey ? `movies.${ratedKey}` : 'NOT FOUND'}`);
  console.log('  sample (redacted): ' + JSON.stringify(redact(data)));
}

// V2: GET /movies/{simkl_id} for 3 watched movies — is users_recommendations
// present by default, or does it need ?extended=full?
async function checkV2(profile, ratedEntries) {
  let simklIds = (ratedEntries || []).map((e) => e?.ids?.simkl).filter((x) => x != null);
  if (simklIds.length < 3) {
    // Top up from the watched store (one governed GET, read-only).
    const items = await simklGet(profile, '/sync/all-items/movies/completed');
    const arr = Array.isArray(items) ? items : (items.movies || []);
    for (const it of arr) {
      const sid = it?.movie?.ids?.simkl;
      if (sid != null && !simklIds.includes(sid)) simklIds.push(sid);
      if (simklIds.length >= 3) break;
    }
  }
  simklIds = simklIds.slice(0, 3);
  if (!simklIds.length) {
    record('V2', false, 'no simkl ids available (no rated movies, no watched movies)');
    return;
  }
  const detail = [];
  let foundDefault = false;
  let foundExtended = false;
  let sample = null;
  for (const sid of simklIds) {
    let data = null;
    let mode = 'default';
    try {
      data = await simklGet(profile, `/movies/${sid}`);
    } catch (err) {
      detail.push(`${sid}: default call failed (${err.message})`);
      continue;
    }
    if (data && !data.users_recommendations) {
      try {
        data = await simklGet(profile, `/movies/${sid}`, { extended: 'full' });
        mode = 'extended=full';
      } catch (err) {
        detail.push(`${sid}: extended call failed (${err.message})`);
        continue;
      }
    }
    const recs = data?.users_recommendations;
    if (recs) {
      if (mode === 'default') foundDefault = true; else foundExtended = true;
      const first = Array.isArray(recs) ? recs[0] : null;
      const hasTmdb = first ? (first.ids?.tmdb != null || first.tmdb != null) : false;
      detail.push(`${sid}: present (${mode}), length ${Array.isArray(recs) ? recs.length : '?'}${first ? `, first item tmdb id ${hasTmdb ? 'present' : 'absent'}` : ''}`);
      if (!sample) sample = first;
    } else {
      detail.push(`${sid}: NOT present (default and extended)`);
    }
  }
  const pass = foundDefault || foundExtended;
  record('V2', pass, detail.join('; '));
  if (sample) console.log('  sample (redacted): ' + JSON.stringify(redact(sample)));
}

// V3: discover/movie with certification.lte=PG — do uncertified titles slip
// through? (For each of the first 20 results, fetch release_dates.)
async function checkV3() {
  const data = await tmdbGet('discover/movie', {
    certification_country: 'AU', 'certification.lte': 'PG', sort_by: 'popularity.desc', include_adult: 'false', page: 1,
  });
  const results20 = (data.results || []).slice(0, 20);
  let noAu = 0;
  for (const r of results20) {
    const rd = await tmdbGet(`movie/${r.id}/release_dates`);
    const cert = tmdb.certForCountry(rd.results, 'AU');
    if (!cert) noAu += 1;
  }
  record('V3', results20.length > 0,
    `${results20.length} results; ${noAu} of them have NO AU certification — `
    + (noAu === 0 ? 'certification.lte DROPS uncertified titles' : `certification.lte does NOT drop them (${noAu} slipped through)`));
}

// V4: same + with_release_type=4|5|6 — does the param exclude cinema-only
// titles? (For the first 20, compute tmdb.movieAvailability.)
async function checkV4() {
  const data = await tmdbGet('discover/movie', {
    certification_country: 'AU', 'certification.lte': 'PG', sort_by: 'popularity.desc', include_adult: 'false',
    with_release_type: '4|5|6', page: 1,
  });
  const results20 = (data.results || []).slice(0, 20);
  let notYet = 0;
  for (const r of results20) {
    const rd = await tmdbGet(`movie/${r.id}/release_dates`);
    if (tmdb.movieAvailability(rd.results) === 'NOT_YET') notYet += 1;
  }
  record('V4', results20.length > 0,
    `${results20.length} results; ${notYet} NOT_YET — `
    + (notYet === 0 ? 'with_release_type=4|5|6 EXCLUDES cinema-only titles' : `cinema-only titles still present (${notYet} NOT_YET)`));
}

// V5: trending/movie/week pages 1–5 + day pages 1–2 — counts per page and
// whether the fields P3 scores on are present.
async function checkV5() {
  const detail = [];
  let ok = true;
  for (const [window, n] of [['week', 5], ['day', 2]]) {
    for (let page = 1; page <= n; page += 1) {
      const data = await tmdbGet(`trending/movie/${window}`, { page });
      const list = data.results || [];
      const fields = ['id', 'genre_ids', 'vote_average', 'vote_count', 'adult', 'release_date'];
      const present = list[0] ? fields.filter((f) => f in list[0]) : [];
      detail.push(`${window} p${page}: ${list.length} items${list[0] ? ` (${present.join('/')})` : ''}`);
      if (!list.length) ok = false;
    }
  }
  record('V5', ok, detail.join('; '));
}

// V6: movie/603 with append_to_response=credits,keywords,external_ids,
// release_dates — one request returns all four blocks; print the AU/US
// certifications and movieAvailability.
async function checkV6() {
  const data = await tmdbGet('movie/603', { append_to_response: 'credits,keywords,external_ids,release_dates' });
  const blocks = ['credits', 'keywords', 'external_ids', 'release_dates'].filter((b) => data[b] != null);
  const certAU = tmdb.certForCountry(data.release_dates?.results, 'AU');
  const certUS = tmdb.certForCountry(data.release_dates?.results, 'US');
  const avail = tmdb.movieAvailability(data.release_dates?.results);
  record('V6', blocks.length === 4,
    `blocks in one request: ${blocks.join(', ') || 'none'}; AU cert ${certAU || 'none'}, US cert ${certUS || 'none'}, availability ${avail}`);
  console.log('  sample (redacted): ' + JSON.stringify(redact(data)));
}

async function main() {
  if (flag('help')) {
    console.log('Usage: node --experimental-sqlite test/verify-marquee-live.js [--profile=Name]');
    console.log('Env creds (skip local data/DB): SIMKL_CLIENT_ID=... SIMKL_ACCESS_TOKEN=... TMDB_API_KEY=...');
    console.log('Read-only: GET requests only; ≤ 10 Simkl calls; a Simkl 429 stops the run (no retries).');
    process.exit(0);
  }

  // Profile resolution (mirrors verify-simkl-live.js).
  const envId = process.env.SIMKL_CLIENT_ID;
  const envTok = process.env.SIMKL_ACCESS_TOKEN;
  let profile;
  if (envId && envTok) {
    profile = { id: 'env', name: '(SIMKL_* env creds)', keys: { simkl_client_id: envId }, simkl_auth: { access_token: envTok } };
  } else {
    const config = require('../src/config'); // only here — the env path stays sqlite-free
    const profiles = config.listProfiles();
    const connected = profiles.filter((p) => p.keys?.simkl_client_id && p.simkl_auth?.access_token);
    const wanted = opt('profile');
    const chosen = wanted ? connected.find((p) => p.name === wanted) : connected[0];
    if (!chosen) {
      throw new Error(wanted
        ? `No Simkl-connected profile named "${wanted}"`
        : 'No Simkl-connected profile in DATA_DIR — set SIMKL_CLIENT_ID/SIMKL_ACCESS_TOKEN, or connect Simkl in the portal (and export SECRET_KEY)');
    }
    profile = chosen;
  }
  tmdbKey = process.env.TMDB_API_KEY || require('../src/settings').getSettings()?.keys?.tmdb_api_key || '';
  if (!tmdbKey) throw new Error('No TMDB API key — set TMDB_API_KEY or save it in the server settings');

  console.log(`Profile: ${profile.name}`);
  console.log('\n── ME-00 live checks (read-only) ──');

  let rated = null;
  const run = async (name, fn) => {
    if (stopped) return;
    try { await fn(); } catch (err) { record(name, false, `errored: ${err.message}`); }
  };
  await run('V1', async () => { rated = await checkV1(profile); });
  await run('V1b', () => checkV1b(profile));
  await run('V2', () => checkV2(profile, rated));
  await run('V3', checkV3);
  await run('V4', checkV4);
  await run('V5', checkV5);
  await run('V6', checkV6);

  if (stopped) {
    console.error(`\n✗ ${stopped}`);
    process.exit(2);
  }

  const anyFail = results.some((r) => r.pass === false);
  const date = new Date().toISOString().slice(0, 10);
  console.log('\n──────── live findings (paste into 00-design-spec.md §12) ────────');
  console.log(`## Live findings (ME-00, ${date})`);
  console.log();
  for (const r of results) {
    const tag = r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'INFO';
    console.log(`- **${r.name}** (${tag}): ${r.detail}`);
  }
  console.log();
  console.log(`Simkl calls made: ${simklCalls} (budget ≤ 10)`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('\n✗ verification errored:', e.message); process.exit(2); });
