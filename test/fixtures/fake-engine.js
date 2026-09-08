// SC-06 conformance fixtures — the canonical fake engines used across the test
// suites (main smoke + mobile smoke) as the living example of a conformant
// engine (see docs/engine-abstraction/CONFORMANCE.md, Part B).
//
// TWO stubs, both fully conformant against CONFORMANCE.md Part A:
//   • `fake`      — a GATED engine (unrestricted:false). Safe for any profile via
//                   the shared age gate; the general-purpose end-to-end fixture.
//   • `fakeOpen`  — an UNRESTRICTED engine (unrestricted:true, "all ages"/fully
//                   open). Exercises the I7 age-selection gate: it must be offered
//                   only to age_limit === 0 profiles and never resolved/served for
//                   an age-limited one, on either surface.
//
// Neither engine shares ANY of Genesis's internals — no Simkl seeding, no TMDB
// affinity math — so a green run proves the abstraction seam (the pool row) holds
// for a producer that has nothing in common with the engine it was reverse-
// engineered from.
//
// `preResolved: true` is a DELIBERATE test-hermeticity choice: it makes the
// shared pipeline skip the TMDB tt-id/poster/genre resolve step, so these
// fixtures flow all the way to pool rows with NO network. A conformant engine may
// of course be preResolved:false in production (Genesis is) — the pipeline
// resolves those via tmdb.imdbFor; that path is covered by Genesis's own tests.
// Candidates therefore already carry imdb_id + genres, and guarantee a valid `tt`
// id (Part A: a preResolved engine drops no-tt candidates by contract).

// Three deterministic candidates for ONE type, in descending rankScore so serve
// order (affinity DESC) is predictable: <tag>-<type>-1 (strongest) → -3 (weakest).
// `tag` namespaces the ids so two engines from makeEngine produce DISTINGUISHABLE
// candidates (integration tests tell one engine's slice from another's). Fields
// cover the required trio (type/tmdb_id/rankScore) plus the optional pool columns
// upsertCandidates binds, so storage needs no backfill. tmdb_id is a STRING
// (contract); popularity + primary_genre are always present (a preResolved engine
// owns primary_genre — the pipeline does not backfill it for preResolved rows).
function candidatesFor(type, tag = 'fake') {
  return [
    { type, tmdb_id: `${tag}-${type}-1`, rankScore: 3, imdb_id: `tt${tag}${type}1`, title: 'Alpha',   year: 2024, primary_genre: 'Drama',  genres: 'Drama',  vote_average: 8, vote_count: 5000, popularity: 30, reason: 'because Alpha', recCount: 2 },
    { type, tmdb_id: `${tag}-${type}-2`, rankScore: 2, imdb_id: `tt${tag}${type}2`, title: 'Bravo',   year: 2023, primary_genre: 'Comedy', genres: 'Comedy', vote_average: 7, vote_count: 4000, popularity: 20, reason: 'because Bravo', recCount: 1 },
    { type, tmdb_id: `${tag}-${type}-3`, rankScore: 1, imdb_id: `tt${tag}${type}3`, title: 'Charlie', year: 2022, primary_genre: 'Action', genres: 'Action', vote_average: 6, vote_count: 3000, popularity: 10, recCount: 3 },
  ];
}

// Build a conformant engine descriptor. `unrestricted` is the only axis that
// varies between the two canonical fixtures; everything else is identical so a
// test can swap gated↔open and observe ONLY the I7 behaviour change. `tag`
// (defaults to `id`) namespaces the candidate ids so integration tests can
// register several distinct engines and keep their slices apart.
function makeEngine({ id, name, unrestricted, tag }) {
  const idTag = tag || id;
  return {
    id,
    name,
    description: 'Test fixture — deterministic candidates, no network. Not a real engine.',
    supportedTypes: ['movie', 'series'],
    capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted },
    // Always usable — the fixture has no external inputs to be missing.
    requirements: () => ({ ok: true, missing: [] }),
    async generate(profile, type, ctx) {
      // Report a non-zero seed count so buildRecommendations treats a fixture-only
      // build as a real build (Genesis reports its watched-seed count here; a
      // preResolved fixture has none, so it reports how many candidates it emitted).
      const cands = candidatesFor(type, idTag);
      if (ctx && ctx.stats) ctx.stats.seeds = cands.length;
      return cands;
    },
  };
}

// The canonical gated fixture (safe for any profile via the shared age gate). Its
// candidate ids are `fake-<type>-N` (tag defaults to the id).
const fake = makeEngine({ id: 'fake', name: 'Fake Engine', unrestricted: false });

// The canonical unrestricted ("all ages"/fully open) fixture — I7's test vehicle.
const fakeOpen = makeEngine({ id: 'fake-open', name: 'Fake Open Engine', unrestricted: true });

module.exports = { fake, fakeOpen, makeEngine, candidatesFor };
