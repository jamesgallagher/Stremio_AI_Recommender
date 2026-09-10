// MANUAL live verification for the Glass GE-02 source gate: does the Simkl
// trending CDN endpoint Glass encodes actually exist and return the shape the
// engine parses? The offline suite (integration O) pins the PARSER; only a real
// fetch confirms the URL + item shape. If this fails or the shape differs, the
// trending half of Glass (strategies C–G + trending_momentum) silently degrades
// to recommendations-only — so verify BEFORE a data-gathering rebuild.
//
// READ-ONLY: it makes only public GETs to data.simkl.in (no auth, no writes, no
// account). Not part of `npm test`. Run:
//   node --experimental-sqlite test/verify-glass-live.js
// Optionally probe extra URL forms:  --url=https://…  (repeatable)
//
// It probes several plausible URL patterns (the exact path is the unverified
// bit), reports which return valid JSON, inspects the top-level shape, and runs
// the winner through src/services/simklTrending's parser to confirm the fields
// Glass scores on (ids.tmdb/imdb, genres, ratings, watched, drop_rate) are present.
const st = require('../src/services/simklTrending');

const args = process.argv.slice(2);
const extraUrls = args.filter((a) => a.startsWith('--url=')).map((a) => a.slice(6));
const APP = { 'app-name': 'AI-Recommender', 'app-version': require('../package.json').version };

// Candidate URL patterns to probe, best-guess first. The FIRST is exactly what
// src/services/simklTrending.COMBINED_WEEK_URL encodes today.
const CANDIDATES = [
  st.COMBINED_WEEK_URL,
  'https://data.simkl.in/discover/trending/week.json',
  'https://data.simkl.in/trending/week_500.json',
  'https://data.simkl.in/discover/trending/movies/week_500.json',
  'https://data.simkl.in/discover/trending/tv/week_500.json',
  'https://data.simkl.in/discover/trending/anime/week_500.json',
  ...extraUrls,
];

function withApp(url) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(APP)) u.searchParams.set(k, v);
  return u.toString();
}

async function probe(url) {
  try {
    const res = await fetch(withApp(url), { headers: { 'User-Agent': require('../src/services/simkl').USER_AGENT, Accept: 'application/json' } });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) return { url, ok: false, status: res.status };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { url, ok: false, status: res.status, note: `non-JSON (${ct}), ${text.length}B` }; }
    return { url, ok: true, status: res.status, ct, json, bytes: text.length };
  } catch (err) {
    return { url, ok: false, error: err.message };
  }
}

function describeShape(json) {
  if (Array.isArray(json)) return `array[${json.length}]`;
  if (json && typeof json === 'object') {
    const keys = Object.keys(json);
    const sub = keys.slice(0, 6).map((k) => `${k}${Array.isArray(json[k]) ? `[${json[k].length}]` : ''}`).join(', ');
    return `object{ ${sub}${keys.length > 6 ? ', …' : ''} }`;
  }
  return typeof json;
}

// Report which scoring fields survive the parser on a sample of items.
function fieldCoverage(items) {
  const sample = items.slice(0, 50);
  if (!sample.length) return 'no items parsed';
  const present = (pred) => `${sample.filter(pred).length}/${sample.length}`;
  return [
    `tmdb_id ${present((i) => i.tmdb_id)}`,
    `imdb_id ${present((i) => i.imdb_id)}`,
    `genres ${present((i) => i.genres.length)}`,
    `ratings.imdb ${present((i) => i.ratings.imdb.rating != null)}`,
    `watched ${present((i) => i.watched != null)}`,
    `drop_rate ${present((i) => i.drop_rate != null)}`,
    `year ${present((i) => i.year != null)}`,
  ].join(' · ');
}

async function main() {
  console.log('Glass GE-02 — Simkl trending CDN live verification (read-only)\n');
  console.log(`Encoded in code: ${st.COMBINED_WEEK_URL}\n`);

  const results = [];
  for (const url of CANDIDATES) {
    const r = await probe(url);
    results.push(r);
    const tag = r.ok ? `200 ${r.ct} ${r.bytes}B` : (r.status ? `HTTP ${r.status}` : `ERR ${r.error || r.note}`);
    console.log(`  ${r.ok ? '✓' : '✗'} ${url}\n      ${tag}${r.ok ? `  →  ${describeShape(r.json)}` : ''}`);
  }

  const combined = results.find((r) => r.ok && r.json && !Array.isArray(r.json) && (r.json.movies || r.json.tv || r.json.shows || r.json.anime));
  const anyOk = results.find((r) => r.ok && r.json);

  console.log('');
  if (combined) {
    const lists = st.parseCombined(combined.json);
    console.log(`COMBINED endpoint OK: ${combined.url}`);
    console.log(`  parsed → movies ${lists.movies.length}, tv ${lists.tv.length}, anime ${lists.anime.length}`);
    for (const k of ['movies', 'tv', 'anime']) if (lists[k].length) console.log(`  ${k} field coverage: ${fieldCoverage(lists[k])}`);
    const sample = lists.movies[0] || lists.tv[0] || lists.anime[0];
    if (sample) console.log(`  sample item: ${JSON.stringify(sample, null, 2).split('\n').map((l, i) => (i ? '    ' + l : l)).join('\n')}`);
    console.log('\nRESULT: PASS — the encoded combined endpoint works and the parser extracts the scoring fields.');
    if (combined.url !== st.COMBINED_WEEK_URL) console.log(`  NOTE: winning URL differs from code — update COMBINED_WEEK_URL to: ${combined.url}`);
    process.exit(0);
  } else if (anyOk) {
    console.log('PARTIAL: an endpoint returned JSON but NOT the combined {movies,tv,anime} shape.');
    console.log(`  Inspect: ${anyOk.url} → ${describeShape(anyOk.json)}`);
    console.log('  Likely the lists are PER-TYPE files, not combined. Share this output and I\'ll adapt simklTrending (fetch 3 files, or fix the path/params).');
    process.exit(2);
  } else {
    console.log('RESULT: FAIL — no candidate returned usable JSON.');
    console.log('  Possible causes: wrong host/path, the CDN needs a client_id param, or egress is blocked from here.');
    console.log('  Run this on the server (which has egress), or share the Simkl trending URL your browser hits and I\'ll match it.');
    process.exit(1);
  }
}

main().catch((err) => { console.error('verify crashed:', err); process.exit(1); });
