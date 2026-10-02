#!/usr/bin/env node
// AGE-1 live check: drive the REAL source adapters (buildSources) through the
// chain's decide for a TV-14 profile, and print the verdict plus the raw value
// each source saw. Read-only: it never records verdicts and never calls the LLM
// (the llmGate seam returns an empty Map; a title that would reach the LLM is
// printed as "→ would go to LLM").
//
// Usage:
//   node --experimental-sqlite scripts/age-verify-check.js --type series --tier 14 tt0086759 tt9794044
//   node --experimental-sqlite scripts/age-verify-check.js --type movie --tier 14 --profile <name> tt1375666
//
// The TMDB/TVDB/MDBList keys and the Simkl connection come from the profile
// (the first age-limited profile, or --profile <name>). No key for a source →
// that source gives no answer (the chain continues), exactly as in production.
const config = require('../src/config');
const tiers = require('../src/ageVerification/tiers');
const chain = require('../src/ageVerification/chain');
const ageSources = require('../src/ageVerification/sources');
const tmdb = require('../src/services/tmdb');
const settings = require('../src/settings');

const USAGE = 'Usage: node --experimental-sqlite scripts/age-verify-check.js --type series|movie --tier 14 [--profile <name>] <imdb> [<imdb>…]';

function parseArgs(argv) {
  const args = { type: 'series', tier: 14, profile: null, imdb: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') args.type = argv[++i];
    else if (a === '--tier') args.tier = parseInt(argv[++i], 10);
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else args.imdb.push(a);
  }
  return args;
}

const DASH = '—';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.imdb.length) { console.error(USAGE); process.exit(1); }
  if (args.type !== 'series' && args.type !== 'movie') { console.error(`--type must be series or movie (got "${args.type}")`); process.exit(1); }
  const tier = tiers.TIERS[args.tier];
  if (!tier || tier.mode !== 'chain') { console.error(`--tier ${args.tier} is not a chain tier (only 14 uses the chain)`); process.exit(1); }

  // Resolve the profile: --profile <name>, else the first age-limited profile.
  const profiles = config.listProfiles();
  const profile = args.profile
    ? profiles.find((p) => p.name === args.profile)
    : profiles.find((p) => (p.filters?.age_limit || 0) > 0);
  if (!profile) { console.error(args.profile ? `No profile named "${args.profile}"` : 'No age-limited profile found'); process.exit(1); }
  console.log(`Profile: ${profile.name} (age_limit ${profile.filters?.age_limit ?? 0})`);

  // Resolve each IMDb id to a TMDB id (read-only TMDB find).
  const tmdbKey = (settings.keyFor(profile, 'tmdb_api_key') || '').trim();
  if (!tmdbKey) { console.error('No TMDB API key for this profile'); process.exit(1); }
  const titles = [];
  for (const imdb of args.imdb) {
    const tmdbId = await tmdb.findByImdbId(tmdbKey, args.type, imdb);
    if (!tmdbId) { console.log(`${imdb}: no TMDB id found — skipping`); continue; }
    titles.push({ key: `${args.type}:${tmdbId}`, imdb_id: imdb, adult: false, title: imdb, year: null, genres: [], certification: null });
  }
  if (!titles.length) { console.log('No titles to check'); process.exit(0); }

  // The real source adapters; the LLM seam returns an empty Map (read-only:
  // never call the LLM). Fetch each source's raw values ONCE, then drive the
  // chain's decide over those cached values so the printed verdict is consistent
  // with the printed raw values (no re-fetch).
  const sources = ageSources.buildSources(profile, console);
  const imdbIds = titles.map((t) => t.imdb_id);
  const tmdbRaw = await sources.tmdbRatings(args.type, titles);
  const csmRaw = await sources.csmAges(args.type, imdbIds);
  const tvdbRaw = await sources.tvdbRatings(args.type, imdbIds);
  const simklRaw = await sources.simklCerts(args.type, imdbIds);
  const mdbRaw = await sources.mdblistCerts(args.type, imdbIds);
  const cachedSources = {
    tmdbRatings: () => tmdbRaw,
    csmAges: () => csmRaw,
    tvdbRatings: () => tvdbRaw,
    simklCerts: () => simklRaw,
    mdblistCerts: () => mdbRaw,
    llmGate: () => new Map(), // read-only: never call the LLM
  };
  const verdicts = await chain.decide(titles, args.type, tier, cachedSources, console);

  for (const t of titles) {
    const v = verdicts.get(t.key);
    const tmdb = tmdbRaw.get(t.key) || {};
    const csm = csmRaw.get(t.imdb_id);
    const tvdb = tvdbRaw.get(t.imdb_id) || {};
    const simkl = simklRaw.get(t.imdb_id);
    const mdb = mdbRaw.get(t.imdb_id);
    const verdict = v ? `${v.verdict}/${v.source}${v.rating ? ` (${v.rating})` : ''}` : 'unknown';
    const raw = [
      `TMDB AU=${tmdb.AU || DASH} US=${tmdb.US || DASH}`,
      `CSM=${csm != null ? csm : DASH}`,
      `TVDB aus=${tvdb.aus || DASH} usa=${tvdb.usa || DASH}`,
      `Simkl=${simkl || DASH}`,
      `MDBList=${mdb || DASH}`,
    ].join('  ');
    console.log(`${t.imdb_id}: ${verdict}   [${raw}]`);
    if (v && v.source === 'llm') console.log(`  → would go to LLM (read-only: not called)`);
  }
}

main().catch((err) => { console.error('Error:', err.message); process.exit(1); });
