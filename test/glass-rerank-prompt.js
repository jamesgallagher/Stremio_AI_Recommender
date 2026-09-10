// Dump the EXACT Glass LLM-rerank prompt (system + user) for a profile/type, so
// you can paste it into your local model and time it by hand. Reconstructs the
// prompt from the STORED POOL + the taste model — no network, no LLM call, so it
// matches what the last build sent (it reads the same taste dims + the pool rows'
// score_components the rerank used).
//
// Run (after a Glass build for the profile):
//   node --experimental-sqlite test/glass-rerank-prompt.js --profile="James" --type=movie
//   node --experimental-sqlite test/glass-rerank-prompt.js --profile="James" --type=series --cap=40
//
// --cap overrides how many candidates to include (defaults to the effective
// rerank.candidate_cap). Also prints a rough token estimate so you can gauge cost.
const config = require('../src/config');
const settings = require('../src/settings');
const rs = require('../src/recommendationStore');
const glassConfig = require('../src/engines/glass/config');
const tasteModel = require('../src/engines/glass/tasteModel');
const rerank = require('../src/engines/glass/rerank');

const args = process.argv.slice(2);
const opt = (n, d = null) => { const p = args.find((a) => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : d; };
const profileName = opt('profile');
const type = opt('type', 'movie');
const capOverride = opt('cap') ? parseInt(opt('cap'), 10) : null;

function main() {
  if (!profileName) { console.error('Pass --profile="Name" (and optionally --type=movie|series, --cap=N)'); process.exit(1); }
  const profile = config.listProfiles().find((p) => p.name === profileName || p.id === profileName);
  if (!profile) { console.error(`No profile "${profileName}"`); process.exit(1); }

  const cfg = glassConfig.resolveConfig(settings.getSettings());
  const cap = capOverride || cfg.rerank.candidate_cap;

  // Same taste model the build used (cached watched + metaStore, no network).
  const taste = tasteModel.buildTasteModel(profile.id, type, cfg);

  // Top-N pool rows by affinity = the rerank head. Rebuild the prompt items from
  // the stored score_components (matched dims → the "why" hint), exactly as
  // rerank.rerankCandidates does from live candidates.
  const rows = rs.getRecommended(profile.id, { type, limit: cap });
  if (!rows.length) { console.error(`No ${type} pool rows for ${profileName} — run a Glass build first.`); process.exit(1); }
  const items = rows.map((r) => {
    let comps = {}; try { comps = JSON.parse(r.score_components || '{}'); } catch { /* older row */ }
    return {
      id: r.tmdb_id,
      title: r.title || '',
      year: r.year || null,
      genres: (r.genres || '').split(',').filter(Boolean).slice(0, 3),
      why: rerank.matchHint({ score_components: comps, sources: comps.sources || [] }),
    };
  });

  const system = 'You re-rank film/TV recommendations for one viewer and explain each pick. '
    + 'Reply with RAW JSON ONLY — no prose, no markdown fences.';
  const user = rerank.buildUserPrompt(type, rerank.tasteSummary(taste), items);
  const estTokens = Math.round((system.length + user.length) / 4);

  console.log(`# Glass rerank prompt — profile "${profile.name}", type=${type}, ${items.length} candidates`);
  console.log(`# taste: ${taste.seedCount} seeds, ${taste.enrichedCount} enriched; ~${estTokens} input tokens`);
  console.log(`# NOTE: the model must return ~${items.length} {id,reason} objects — that OUTPUT volume is usually what makes a local run slow.\n`);
  console.log('===== SYSTEM =====');
  console.log(system);
  console.log('\n===== USER =====');
  console.log(user);
}

main();
