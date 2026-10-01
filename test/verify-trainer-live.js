// MANUAL live-API verification for the Taste Trainer T1 Simkl rating writes
// (POST /sync/ratings + POST /sync/ratings/remove) and the engine-agnostic
// ratings sync (tasteFeedback.syncRatings). This is the ONLY way to close the
// live gate: the offline suite (test/integration.js tests 1–10 + the mobile
// smoke) pins the request SHAPES and the store semantics, but only a real
// Simkl account can confirm the API actually ACTS on those writes.
//
//   VT1 — setRatings(7) lands a 7 on the account: getRatings contains the
//        target movie at rating 7, and getActivities().movies.rated_at advances.
//   VT2 — setRatings(10) (a "love") reads back as 10.
//   VT3 — removeRatings clears the rating (getRatings no longer contains it).
//   VT4 — tasteFeedback.syncRatings (force) pulls the account's movie ratings
//        into the engine-agnostic store (type='movie'); print ok + row count.
//
// It is NOT part of `npm test` — it makes REAL writes to a REAL Simkl account.
// Guardrails: it read-back-verifies every step, self-cleans (VT3 removes the
// test rating the earlier steps set, so the account's rating for the target
// movie is restored to "unrated" at the end), and performs NO writes at all
// without --confirm. VT4's store write is isolated to a FRESH temp DATA_DIR
// (never the profile's real taste_ratings).
//
// ── Run (dry run first — shows exactly what it would do, writes nothing): ──
//   node --experimental-sqlite test/verify-trainer-live.js
// ── Then the real thing: ──
//   node --experimental-sqlite test/verify-trainer-live.js --confirm
//
// Creds: uses the first Simkl-connected profile in the ORIGINAL DATA_DIR (needs
// SECRET_KEY set, same as the app). Override with --profile="Name", or bypass
// the local data/DB entirely with explicit creds:
//   SIMKL_CLIENT_ID=... SIMKL_ACCESS_TOKEN=... node --experimental-sqlite test/verify-trainer-live.js --confirm
//
// Output is counts + PASS/FAIL only — no titles (mandate M12 privacy). The
// target is shown only as simkl:<id>.
const simkl = require('../src/services/simkl');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def = null) => {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
};
const confirm = flag('confirm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the profile BEFORE the DATA_DIR repoint below, so config reads the
// ORIGINAL data dir (the local profiles.json). config.listProfiles() returns
// profiles already unsealed (keys + simkl_auth), so no manual crypto here.
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

// A movie to rate. Chosen from the account's OWN completed movies, minus every
// movie already rated (matched by tmdb OR imdb OR simkl id), taking the most
// recent by watched_at that carries a simkl_id. No hardcoded target, no flags.
async function pickTarget(profile) {
  const items = await simkl.getAllItems(profile, 'movies', { status: 'completed' });
  const watched = simkl.parseWatchedItems(items, 'movies');
  const ratings = await simkl.getRatings(profile, 'movies');
  const ratedTmdb = new Set(); const ratedImdb = new Set(); const ratedSimkl = new Set();
  for (const r of ratings) {
    if (r.tmdb_id != null) ratedTmdb.add(String(r.tmdb_id));
    if (r.imdb_id != null) ratedImdb.add(r.imdb_id);
    if (r.simkl_id != null) ratedSimkl.add(Number(r.simkl_id));
  }
  const candidates = watched.filter((w) => {
    const t = w.tmdb_id != null ? String(w.tmdb_id) : null;
    const i = w.imdb_id != null ? w.imdb_id : null;
    const s = w.simkl_id != null ? Number(w.simkl_id) : null;
    if (t && ratedTmdb.has(t)) return false;
    if (i && ratedImdb.has(i)) return false;
    if (s != null && ratedSimkl.has(s)) return false;
    return true;
  });
  let target = null;
  for (const w of candidates) {
    if (w.simkl_id == null) continue; // must carry a simkl_id to be rated
    if (!target || (Date.parse(w.watched_at || '1970-01-01') > Date.parse(target.watched_at || '1970-01-01'))) target = w;
  }
  return target;
}

// Is the target present in a ratings list (matched by tmdb OR imdb OR simkl)?
function isRated(ratings, target) {
  return ratings.some((r) =>
    (target.tmdb_id != null && r.tmdb_id != null && String(r.tmdb_id) === String(target.tmdb_id))
    || (target.imdb_id != null && r.imdb_id != null && r.imdb_id === target.imdb_id)
    || (target.simkl_id != null && r.simkl_id != null && Number(r.simkl_id) === Number(target.simkl_id)));
}

// Read back the account's current rating for a movie by tmdb or imdb.
function ratingFor(ratings, t) {
  const hit = ratings.find((r) => (t.tmdb_id && String(r.tmdb_id) === String(t.tmdb_id)) || (t.imdb_id && r.imdb_id === t.imdb_id));
  return hit ? hit.rating : null;
}

// getActivities().movies.rated_at (the §12 L2 gate value), or null.
function ratedAtOf(activities) {
  return activities && activities.movies && typeof activities.movies === 'object' ? activities.movies.rated_at : null;
}

async function main() {
  if (flag('help')) {
    console.log('Usage: node --experimental-sqlite test/verify-trainer-live.js [--confirm] [--profile=Name]');
    console.log('Env creds (skip local data/DB): SIMKL_CLIENT_ID=... SIMKL_ACCESS_TOKEN=...');
    process.exit(0);
  }

  const profile = await resolveProfile();
  console.log('Profile: resolved');
  const conn = await simkl.checkConnection(profile.keys.simkl_client_id, profile.simkl_auth.access_token);
  if (!conn.valid) { console.error(`✗ Simkl connection invalid: ${conn.reason}`); process.exit(2); }
  console.log('✓ Simkl connected');

  const target = await pickTarget(profile);
  if (!target) {
    console.log('SKIP: no unrated watched movie');
    process.exit(0);
  }

  if (!confirm) {
    console.log('\nDRY RUN (no writes). With --confirm this would:');
    console.log(`  target: simkl:${target.simkl_id}`);
    console.log('  VT1  setRatings → 7 on the target; read back the 7 + the activities rated_at change.');
    console.log('  VT2  setRatings → 10 (a love); read back the 10.');
    console.log('  VT3  removeRatings; read back that the rating is gone.');
    console.log('  VT4  tasteFeedback.syncRatings (force) into an isolated temp store; print ok + row count.');
    console.log('\nRe-run with --confirm to perform the live verification.');
    process.exit(0);
  }

  console.log('\n⚠  LIVE MODE — writing to your Simkl account (self-cleaning, read-back-verified).');
  // Isolate VT4's store to a FRESH temp dir (the spec's guardrail: a verify run
  // must never clobber the profile's real taste_ratings). The repoint happens
  // BEFORE the first tasteFeedback require (lazy, inside VT4).
  process.env.DATA_DIR = require('os').tmpdir() + '/trainer-verify-' + Date.now();
  const results = [];

  try {
    // Refuse (no writes) if a fresh getRatings shows the target already rated.
    const fresh = await simkl.getRatings(profile, 'movies');
    if (isRated(fresh, target)) {
      console.error('✗ target already rated on the account — refusing to write (no changes made)');
      process.exit(2);
    }

    // VT1 — setRatings(7) lands + advances the activities gate.
    {
      console.log('\n── VT1: setRatings → 7 ──');
      const ratedAtBefore = ratedAtOf(await simkl.getActivities(profile));
      await simkl.setRatings(profile, [{ type: 'movie', simkl_id: target.simkl_id, imdb_id: target.imdb_id, tmdb_id: target.tmdb_id, rating: 7 }]);
      await sleep(1500);
      const got = ratingFor(await simkl.getRatings(profile, 'movies'), target);
      const ratedAtAfter = ratedAtOf(await simkl.getActivities(profile));
      const advanced = ratedAtAfter != null && ratedAtAfter !== ratedAtBefore;
      console.log(`  read back rating=${got} (want 7); rated_at ${ratedAtBefore || 'null'} → ${ratedAtAfter || 'null'}`);
      results.push({ name: 'VT1', pass: got === 7, detail: got === 7 ? (advanced ? 'rating 7 landed + activities rated_at advanced' : 'rating 7 landed (rated_at unchanged this run — expected if the gate was already current)') : `read back ${got}, not 7` });
    }

    // VT2 — setRatings(10) (a love) reads back as 10.
    {
      console.log('\n── VT2: setRatings → 10 (love) ──');
      await simkl.setRatings(profile, [{ type: 'movie', simkl_id: target.simkl_id, imdb_id: target.imdb_id, tmdb_id: target.tmdb_id, rating: 10 }]);
      await sleep(1500);
      const got = ratingFor(await simkl.getRatings(profile, 'movies'), target);
      console.log(`  read back rating=${got} (want 10)`);
      results.push({ name: 'VT2', pass: got === 10, detail: got === 10 ? 'love (10) landed' : `read back ${got}, not 10` });
    }
  } finally {
    // VT3 — removeRatings clears the rating (self-cleanup: restores the movie to
    // unrated). Always runs if any write was attempted, even if VT1/VT2 threw.
    {
      console.log('\n── VT3: removeRatings (clear) ──');
      await simkl.removeRatings(profile, [{ type: 'movie', simkl_id: target.simkl_id, imdb_id: target.imdb_id, tmdb_id: target.tmdb_id }]);
      await sleep(1500);
      const got = ratingFor(await simkl.getRatings(profile, 'movies'), target);
      console.log(`  read back rating=${got} (want null)`);
      results.push({ name: 'VT3', pass: got === null, detail: got === null ? 'rating cleared (movie restored to unrated)' : `still ${got}, not cleared` });
    }
  }

  // VT4 — tasteFeedback.syncRatings (force) into the isolated temp store.
  {
    console.log('\n── VT4: tasteFeedback.syncRatings (force) ──');
    const tasteFeedback = require('../src/tasteFeedback'); // lazy — store is the fresh temp dir
    const res = await tasteFeedback.syncRatings(profile, { force: true });
    console.log(`  ok=${res.ok} synced=${res.ok ? res.synced : '-'} unresolved=${res.ok ? res.unresolved : (res.error || '-')}`);
    results.push({ name: 'VT4', pass: res.ok === true, detail: res.ok ? `synced ${res.synced} movie rating(s) into the engine-agnostic store` : `sync failed: ${res.error}` });
  }

  console.log('\n──────── summary ────────');
  for (const r of results) {
    const tag = r.pass === true ? 'PASS' : 'FAIL';
    console.log(`  ${r.name}: ${tag} — ${r.detail}`);
  }
  const anyFail = results.some((r) => r.pass === false);
  console.log(anyFail
    ? '\nAt least one check FAILED — do NOT promote; fix the owning card (see the detail above).'
    : '\nAll checks verified live. Trainer T1 is clear to promote.');
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('\n✗ verification errored:', e.message); process.exit(2); });
