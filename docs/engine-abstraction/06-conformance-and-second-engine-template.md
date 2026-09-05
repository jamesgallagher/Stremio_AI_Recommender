# SC-06 — Conformance spec + second-engine template

**Layer:** doc / validation (+ a test-only fake engine) · **Depends on:** `01`–`03`
**Behavioral change for users:** none. This card exists to **prove the
abstraction holds** and to give future engine authors a ready template — without
committing to any specific new engine.

> ⚠ **Source-choice guardrail.** A *real* second engine that pulls from a new
> data source, list, or catalog is **James's decision, not the implementer's**
> (standing rule: catalog/source choices are surfaced as options and confirmed by
> James, never chosen or substituted unilaterally). This card ships a
> **conformance checklist**, a **test-only fake engine**, and a **worked template
> with the source left blank**. Any concrete engine gets its own card once James
> picks the source.

---

## Why this card

Cards `01`–`05` are all validated against Genesis, which is the very engine the
abstraction was reverse-engineered from — so "it works" partly begs the question.
A **second engine that shares none of Genesis's internals** is the real test that
the seam is clean. We get that assurance two ways:

1. A **fake engine** in the test suite that produces hand-built candidates (no
   TMDB seeding, no affinity math) and still flows correctly through the pipeline,
   pool, serve, decay and age gate.
2. A **conformance checklist** every future engine must pass before it's
   registered.

---

## Part A — Conformance checklist (goes in `docs/engine-abstraction/` and is the
"definition of done" for any engine)

An engine is conformant iff:

**Contract**
- [ ] Exports the full `Engine` descriptor (`id`, `name`, `description`,
      `supportedTypes`, `requirements`, `capabilities`, `generate`).
- [ ] `id` is a stable slug, unique in the registry, never reused for a different
      engine (it's persisted in profiles).
- [ ] `generate(profile, type, ctx, onProgress)` returns
      `NormalizedCandidate[]` for **exactly** the requested `type`, each with the
      three required fields (`type`, `tmdb_id`, `rankScore`). (00-overview §4.2)
- [ ] `rankScore` is comparable and higher-is-stronger (populates `affinity`, I6).
- [ ] Returns `[]` (not an error) when it has nothing to produce (e.g. no seeds).
- [ ] `requirements(profile)` returns `{ ok, missing }` truthfully; when `ok`
      is false the engine is skipped, its slice is **not** wiped, and the reason
      surfaces in logs/Advanced.

**Invariants it must NOT try to own** (the shared pipeline/serve do these — an
engine that duplicates or bypasses them is non-conformant):
- [ ] Age gate (I1) — never self-vet for age; the pool age gate handles it.
- [ ] Serve-time filters (I2), vote-floor storage gate (I3), watched/dont_recommend
      exclusion (I5) — do not re-implement or contradict.
- [ ] Never write `imdb_rating`, `age_classification`, or impression/decay columns.

**Safety**
- [ ] For a kids profile, the engine's candidate set going into the shared age
      gate results in a fully-vetted served list (verify with an age-limited test
      profile — the age gate must catch anything the engine surfaced).
- [ ] No request-path work: `generate` runs only in the background build, never in
      the serve path.

**Capabilities**
- [ ] `capabilities.preResolved` accurately reflects whether candidates already
      carry `imdb_id` + poster + genres. If `false`, the pipeline resolves them; if
      `true`, the engine guarantees a valid `tt` id (no-tt candidates are dropped).
- [ ] `capabilities.serveOrder` is `'affinity'` unless the serve path has been
      taught to honor `'preserve'` (out of scope until an engine needs it).
- [ ] `capabilities.unrestricted` is set honestly (I7). A **gated** engine
      (`false`) must produce candidates the shared age gate can make safe for any
      profile. An **unrestricted** engine (`true`, "all ages"/fully open):
  - [ ] declares it, so the registry excludes it from age-limited profiles
        (`availableFor`) and `resolveFor` refuses it for them;
  - [ ] still does **not** bypass the NSFW/porn blacklist (absolute for all
        engines) — "open" is no age *classification*, not NSFW (overview §8 Q1);
  - [ ] never surfaces on the companion for an age-limited profile (filtered
        server-side, age never exposed).

**Registration**
- [ ] Added to `src/engines/index.js`'s registry with `supportedTypes` correct, so
      it appears only in the per-type dropdowns it supports.
- [ ] Has a user-facing `description` written for a non-technical family member.

---

## Part B — The fake engine (test fixture, ships in the test suite)

`test/fixtures/fake-engine.js` (or inline in a test): a minimal conformant engine
used by `01`/`03` tests and as the living example.

```js
module.exports = {
  id: 'fake', name: 'Fake Engine', description: 'Test fixture — fixed candidates.',
  supportedTypes: ['movie', 'series'],
  capabilities: { providesRankScore: true, preResolved: false, serveOrder: 'affinity' },
  requirements: () => ({ ok: true, missing: [] }),
  async generate(profile, type, ctx) {
    // No TMDB, no affinity — just three deterministic candidates for `type`.
    return [
      { type, tmdb_id: '111', rankScore: 3, title: 'Alpha', genre_ids: [18] },
      { type, tmdb_id: '222', rankScore: 2, title: 'Bravo', genre_ids: [35] },
      { type, tmdb_id: '333', rankScore: 1, title: 'Charlie', genre_ids: [28] },
    ];
  },
};
```

Tests assert (with `tmdb.imdbFor`/MDBList stubbed): these three flow through
`runEngineBuild` → pool rows with `affinity` = 3/2/1, correct genres, and serve
in that genre-balanced order; and that selecting `fake` for one type and Genesis
for the other keeps the two slices independent (the `03` isolation test).

**A second stub — `fake-open` (`unrestricted: true`)** — exercises the I7
age-gating path (D1). Same shape as `fake` but
`capabilities.unrestricted = true`. Tests assert:
- `engines.availableFor(adultProfile, type)` **includes** `fake-open`;
  `availableFor(ageLimitedProfile, type)` **excludes** it.
- Selecting `fake-open` on an age-limited profile coerces to `genesis`
  (`updateProfile`); raising a profile's age limit while it holds `fake-open`
  revokes it → `genesis` + slice clear + rebuild (`03`).
- `resolveFor(ageLimitedProfile, type)` never returns `fake-open`.
- `companionSettings(ageLimitedProfile).engines.available.<type>` omits it, with
  no age value in the payload.

Provide a **test-only registration hook** — e.g. `engines.__registerForTest(e)`
guarded by `process.env.NODE_ENV === 'test'` (or a param) — so production's
registry stays Genesis-only. Both stubs register through it.

---

## Part C — Worked template for a real engine (source left blank)

`src/engines/_template.js` (underscore = not registered). A skeleton an
implementer fills in **after James picks a source**:

```js
// A new engine. Fill in generate(); do NOT register until the SOURCE is
// confirmed by James (catalog/source choices are his call).
module.exports = {
  id: 'REPLACE_ME',
  name: 'REPLACE_ME',
  description: 'How this engine picks titles, in plain language for a family member.',
  supportedTypes: ['movie', 'series'],   // trim if it only does one
  capabilities: { providesRankScore: true, preResolved: false, serveOrder: 'affinity' },
  requirements(profile) {
    const missing = [];
    // e.g. if (!settings.keyFor(profile,'tmdb_api_key')) missing.push('TMDB key');
    // e.g. if (!settings.hasLlm()) missing.push('an LLM (Server Config)');
    return { ok: missing.length === 0, missing };
  },
  async generate(profile, type, ctx, onProgress) {
    // 1. Gather this engine's raw source for `type` (its own logic).
    // 2. Map to NormalizedCandidate[]: { type, tmdb_id, rankScore, ...optional }.
    //    - Non-TMDB source? Resolve to a tmdb_id here (or set preResolved+imdb_id).
    //    - rankScore = your strength metric, higher = better.
    // 3. onProgress(100, `…`); return candidates. Do NOT age-gate or serve-filter.
    return [];
  },
};
```

### Candidate real engines (illustrative only — each needs James's source sign-off)
Listed so the template has concrete shapes in mind; **not** proposed for build here:
- **LLM Taste engine** — an LLM proposes age-aware `{title, year}` per profile
  taste; resolve to TMDB; `rankScore` from the model's ordering. (Was the old
  `'ai'` idea; age-aware *generation* complements the shared age gate.) Needs the
  Groq/custom-LLM source — infra already present.
- **TMDB Trending/Discover engine** — popularity/discover seeded, not
  history-similar. Source = TMDB (already keyed).
- **MDBList-list engine** — build the AI catalog from a chosen MDBList list.
  **Squarely a source decision → James picks the list.**

For any of these: open a new scope card, state the source + why, get James's nod,
then implement against Part A's checklist using Part C's template.

---

## Tasks

- [ ] Write Part A as a standalone `CONFORMANCE.md` (or keep it in this file and
      link it from `00-overview.md`).
- [ ] Add the `fake` + `fake-open` engine fixtures + the test-only registration hook.
- [ ] Add `01`/`03` tests that exercise the fake engine end-to-end (pipeline →
      pool → serve; per-type isolation; age gate over a fake-sourced kids pool).
- [ ] Add I7 tests via `fake-open` (`availableFor`/`resolveFor`/`updateProfile`
      coercion/age-limit-raise revocation/companion omission).
- [ ] Commit `src/engines/_template.js` (unregistered).

## Acceptance criteria

- The fake engine's three candidates become three pool rows and serve in
  rankScore order, with **no Genesis code involved** in producing them.
- Per-type isolation holds: `fake` for movies + `genesis` for series yields a
  movie slice from the fake engine and a series slice from Genesis.
- An age-limited profile whose (fake-sourced) pool contains an over-band title
  has that title removed by the shared age gate — proving safety is
  engine-independent (I1).
- The `fake-open` (`unrestricted`) stub is never offered to, selectable by, or
  resolved for an age-limited profile, on either surface (I7), and does not
  bypass the NSFW blacklist.
- No production registry change (still Genesis-only).

## Out of scope

- Any real second engine (separate, source-gated card).
- Teaching the serve path `serveOrder:'preserve'` (only when an engine needs it).
