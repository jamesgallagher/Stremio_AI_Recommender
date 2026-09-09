// MANUAL live-API verification for the two open Simkl build-time gates the MW
// cluster left behind (docs/mark-watched-review.md → I2, I3). This is the ONLY
// way to close them: the offline suite (test/integration.js J/K + the mobile
// smoke) pins the request SHAPES, but only a real Simkl account can confirm the
// API actually ACTS on those shapes.
//
//   I2 — a SERIES marked whole-show via POST /sync/history with
//        `shows:[{ids:{imdb}}]` and NO seasons actually lands the show as
//        COMPLETED (not merely "watching", not a no-op). This is the shape
//        markWatched.buildWatchedHistoryBody sends for a series.
//   I3 — POST /sync/history/remove with a whole title (no seasons) actually
//        takes it OFF the plan-to-watch list. This is what
//        simkl.removeFromPlanToWatch sends (the Watch Later ✕).
//
// It is NOT part of `npm test` — it makes REAL writes to a REAL Simkl account.
// Guardrails: it read-back-verifies every step, self-cleans (I3 restores your
// prior list state; I2 removes the test show from history afterwards), runs I3
// FIRST so the /sync/history/remove path is proven before I2 relies on it for
// cleanup, refuses I2 on a series you have ALREADY watched (so cleanup can never
// wipe real history), and performs NO writes at all without --confirm.
//
// ── Run (dry run first — shows exactly what it would do, writes nothing): ──
//   node --experimental-sqlite test/verify-simkl-live.js
// ── Then the real thing: ──
//   node --experimental-sqlite test/verify-simkl-live.js --confirm
//
// Creds: uses the first Simkl-connected profile in DATA_DIR (needs SECRET_KEY set,
// same as the app). Override with --profile="Name", or bypass the local data/DB
// entirely with explicit creds:
//   SIMKL_CLIENT_ID=... SIMKL_ACCESS_TOKEN=... node --experimental-sqlite test/verify-simkl-live.js --confirm
//
// Optional title overrides (defaults: I3 = Inception, I2 = Chernobyl — an ended
// miniseries). Pass a series you have NOT watched if the default is already in
// your history:
//   --movie-tmdb=  --movie-imdb=  --series-tmdb=  --series-imdb=
const simkl = require('../src/services/simkl');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def = null) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def; // '--' + name + '='
};
const confirm = flag('confirm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Match a normalised watched/plan-to-watch item against a target by imdb (pref) or tmdb.
const idMatch = (item, t) => (!!t.imdb && item.imdb_id === t.imdb)
  || (!!t.tmdb && String(item.tmdb_id) === String(t.tmdb));

async function resolveProfile() {
  const envId = process.env.SIMKL_CLIENT_ID;
  const envTok = process.env.SIMKL_ACCESS_TOKEN;
  if (envId && envTok) {
    return { id: 'env', name: '(SIMKL_* env creds)', keys: { simkl_client_id: envId }, simkl_auth: { access_token: envTok } };
  }
  const config = require('../src/config'); // only here — the env path stays sqlite-free
  const profiles = config.listProfiles();
  const connected = profiles.filter((p) => p.keys?.simkl_client_id && p.simkl_auth?.access_token);
  const wanted = opt('profile');
  const chosen = wanted ? connected.find((p) => p.name === wanted) : connected[0];
  if (!chosen) {
    throw new Error(wanted
      ? `No connected Simkl profile named "${wanted}"`
      : 'No Simkl-connected profile in DATA_DIR — set SIMKL_CLIENT_ID/SIMKL_ACCESS_TOKEN, or connect Simkl in the portal (and export SECRET_KEY)');
  }
  return chosen;
}

// Series across BOTH Simkl sections (shows + anime), one status, delta-only via date_from.
async function seriesItems(profile, status, dateFrom) {
  const out = [];
  for (const section of ['shows', 'anime']) {
    const items = await simkl.getAllItems(profile, section, { status, dateFrom });
    out.push(...simkl.parseWatchedItems(items, section));
  }
  return out;
}

// ── I3 — plan-to-watch remove (run first: proves /sync/history/remove) ──
async function verifyI3(profile, movie) {
  console.log('\n── I3: plan-to-watch remove (POST /sync/history/remove) ──');
  const before = await simkl.getPlanToWatch(profile, 'movie');
  const wasPresent = before.some((it) => idMatch(it, movie));
  console.log(`  "${movie.title}" on plan-to-watch before: ${wasPresent}`);

  if (!wasPresent) {
    await simkl.addToPlanToWatch(profile, { type: 'movie', tmdb_id: movie.tmdb, imdb_id: movie.imdb });
    await sleep(1500);
    const afterAdd = await simkl.getPlanToWatch(profile, 'movie');
    if (!afterAdd.some((it) => idMatch(it, movie))) {
      return { name: 'I3', pass: false, detail: 'could not seed the test title onto plan-to-watch (add-to-list failed) — cannot verify remove' };
    }
    console.log('  seeded the test title onto plan-to-watch');
  }

  await simkl.removeFromPlanToWatch(profile, { type: 'movie', tmdb_id: movie.tmdb, imdb_id: movie.imdb }); // the call under test
  await sleep(1500);
  const afterRemove = await simkl.getPlanToWatch(profile, 'movie');
  const removed = !afterRemove.some((it) => idMatch(it, movie));
  console.log(`  after remove → ${removed ? 'GONE from plan-to-watch' : 'STILL PRESENT'}`);

  if (wasPresent && removed) { // it was YOUR entry — put it back
    await simkl.addToPlanToWatch(profile, { type: 'movie', tmdb_id: movie.tmdb, imdb_id: movie.imdb });
    console.log('  restored: re-added the title (it was on your list before the test)');
  }
  return {
    name: 'I3',
    pass: removed,
    detail: removed
      ? '/sync/history/remove clears a whole title from plan-to-watch — the shipped endpoint is correct'
      : 'remove did NOT clear plan-to-watch — endpoint or body shape is wrong (removeFromPlanToWatch)',
  };
}

// ── I2 — whole-show watched (run second: cleanup reuses the I3-proven remove) ──
async function verifyI2(profile, series) {
  console.log('\n── I2: whole-show watched (POST /sync/history, shows:[{ids}] no seasons) ──');
  const dateFrom = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // delta window, keeps read-backs cheap
  const already = (await seriesItems(profile, 'completed', dateFrom)).some((it) => idMatch(it, series));
  if (already) {
    console.log(`  ! "${series.title}" is already completed on your account.`);
    console.log('    I2 needs a series you have NOT watched, so cleanup can restore state.');
    console.log('    Re-run with --series-imdb=ttXXXX --series-tmdb=NNNN for an unwatched, ENDED series.');
    return { name: 'I2', pass: null, detail: 'skipped — the chosen series is already watched; pass an unwatched, ended one' };
  }

  // Mirrors markWatched.buildWatchedHistoryBody({ type:'series' }): whole show, NO seasons, NO watched_at.
  const ids = {};
  if (series.imdb) ids.imdb = series.imdb;
  if (series.tmdb) ids.tmdb = String(series.tmdb);
  const body = { movies: [], shows: [{ ids }] };
  console.log(`  POST /sync/history  ${JSON.stringify(body)}`);
  await simkl.addToHistory(profile, body); // the write under test
  await sleep(2000);

  const nowCompleted = (await seriesItems(profile, 'completed', dateFrom)).some((it) => idMatch(it, series));
  const nowWatching = (await seriesItems(profile, 'watching', dateFrom)).some((it) => idMatch(it, series));
  console.log(`  after write → completed: ${nowCompleted}, watching: ${nowWatching}`);

  let cleaned = true;
  if (nowCompleted || nowWatching) { // remove the test show from history (same verified endpoint as I3)
    await simkl.removeFromPlanToWatch(profile, { type: 'series', tmdb_id: series.tmdb, imdb_id: series.imdb });
    await sleep(2000);
    const after = [...await seriesItems(profile, 'completed', dateFrom), ...await seriesItems(profile, 'watching', dateFrom)];
    cleaned = !after.some((it) => idMatch(it, series));
    console.log(cleaned
      ? '  cleaned up: removed the test show from history'
      : `  ! COULD NOT auto-clean "${series.title}" — remove it from your Simkl history manually`);
  }

  let detail;
  if (nowCompleted) detail = 'whole-show body marks the series COMPLETED — the shipped MW-00 series shape is correct';
  else if (nowWatching) detail = 'landed in WATCHING, not completed — the whole-show body is insufficient; MW-00 series path must fetch aired episodes (or use a show-level endpoint)';
  else detail = 'no effect — Simkl did not record the whole-show write at all';
  if (!cleaned) detail += ' (MANUAL CLEANUP NEEDED)';
  return { name: 'I2', pass: nowCompleted, detail };
}

async function main() {
  if (flag('help')) {
    console.log('Usage: node --experimental-sqlite test/verify-simkl-live.js [--confirm] [--profile=Name]');
    console.log('       [--movie-tmdb= --movie-imdb=] [--series-tmdb= --series-imdb=]');
    console.log('Env creds (skip local data/DB): SIMKL_CLIENT_ID=... SIMKL_ACCESS_TOKEN=...');
    process.exit(0);
  }

  const mTmdb = opt('movie-tmdb'); const mImdb = opt('movie-imdb');
  const sTmdb = opt('series-tmdb'); const sImdb = opt('series-imdb');
  const movie = (mTmdb || mImdb)
    ? { title: `movie ${mImdb || mTmdb}`, tmdb: mTmdb, imdb: mImdb }
    : { title: 'Inception', tmdb: '27205', imdb: 'tt1375666' };
  const series = (sTmdb || sImdb)
    ? { title: `series ${sImdb || sTmdb}`, tmdb: sTmdb, imdb: sImdb }
    : { title: 'Chernobyl', tmdb: '87108', imdb: 'tt7366338' };

  const profile = await resolveProfile();
  console.log(`Profile: ${profile.name}`);
  const conn = await simkl.checkConnection(profile.keys.simkl_client_id, profile.simkl_auth.access_token);
  if (!conn.valid) { console.error(`✗ Simkl connection invalid: ${conn.reason}`); process.exit(2); }
  console.log(`✓ Simkl connected${conn.username ? ` as ${conn.username}` : ''}`);

  if (!confirm) {
    console.log('\nDRY RUN (no writes). With --confirm this would:');
    console.log(`  I3  add "${movie.title}" (tmdb:${movie.tmdb || '-'} imdb:${movie.imdb || '-'}) to plan-to-watch, remove it via /sync/history/remove, then restore your prior state.`);
    console.log(`  I2  mark the whole show "${series.title}" (tmdb:${series.tmdb || '-'} imdb:${series.imdb || '-'}) watched, verify it lands COMPLETED, then remove it from history.`);
    console.log('\nRe-run with --confirm to perform the live verification.');
    process.exit(0);
  }

  console.log('\n⚠  LIVE MODE — writing to your Simkl account (self-cleaning, read-back-verified).');
  const r3 = await verifyI3(profile, movie); // first: proves the remove path I2 cleans up with
  const r2 = await verifyI2(profile, series);

  console.log('\n──────── summary ────────');
  for (const r of [r2, r3]) {
    const tag = r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'SKIP';
    console.log(`  ${r.name}: ${tag} — ${r.detail}`);
  }
  const anyFail = [r2, r3].some((r) => r.pass === false);
  console.log(anyFail
    ? '\nAt least one gate FAILED — do NOT promote; fix the owning card (see the detail above).'
    : (r2.pass === null
      ? '\nI3 verified. I2 was skipped — re-run with an unwatched series to finish closing it.'
      : '\nBoth gates verified live. The MW cluster is clear to promote (docs §9).'));
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('\n✗ verification errored:', e.message); process.exit(2); });
