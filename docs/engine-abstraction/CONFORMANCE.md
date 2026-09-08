# Engine conformance checklist — the definition of done for any engine

This is the **authority** for whether a recommendation engine is allowed into the
registry (`src/engines/index.js`). It is Part A of scope card
[`06`](06-conformance-and-second-engine-template.md), lifted here as a standalone
document so an engine author has a single "definition of done" to work against.
Every item traces back to an invariant in
[`00-overview.md`](00-overview.md) §3–§4.

A ready-to-copy skeleton lives at
[`src/engines/_template.js`](../../src/engines/_template.js) (Part C); the living,
tested example is [`test/fixtures/fake-engine.js`](../../test/fixtures/fake-engine.js)
(Part B). The abstraction seam is the **pool row**: an engine is a *candidate
producer* — given `(profile, type)` it returns `NormalizedCandidate[]` — and the
shared pipeline resolves/enriches/age-gates/upserts them. Everything downstream of
the pool is engine-agnostic and must stay that way.

> ⚠ **Source-choice guardrail.** A *real* engine that pulls from a new data
> source, list, or catalog is **James's decision, not the implementer's** —
> catalog/source choices are surfaced as options and confirmed by James, never
> chosen or substituted unilaterally. The template ships with its source left
> blank on purpose. Get the source sign-off, then implement against this checklist.

---

An engine is **conformant iff** it satisfies every box below.

## Contract
- [ ] Exports the full `Engine` descriptor (`id`, `name`, `description`,
      `supportedTypes`, `capabilities`, `requirements`, `generate`).
- [ ] `id` is a stable slug, unique in the registry, and **never reused** for a
      different engine (it is persisted in profiles).
- [ ] `generate(profile, type, ctx, onProgress)` returns `NormalizedCandidate[]`
      for **exactly** the requested `type`, each with the three required fields
      (`type`, `tmdb_id`, `rankScore`). (overview §4.2)
- [ ] `rankScore` is comparable and higher-is-stronger (it populates the
      `affinity` column, **I6**).
- [ ] Returns `[]` (not an error) when it has nothing to produce (e.g. no seeds).
- [ ] `requirements(profile)` returns `{ ok, missing }` truthfully. When `ok` is
      false the engine is **skipped**, its slice is **not** wiped, and the reason
      surfaces in logs/Advanced.

## Invariants it must NOT try to own
The shared pipeline/serve do these. An engine that duplicates, bypasses, or
contradicts them is non-conformant.
- [ ] **Age gate (I1)** — never self-vet for age; the pool age gate handles it.
- [ ] **Serve-time filters (I2)**, **vote-floor storage gate (I3)**,
      **watched / `dont_recommend` exclusion (I5)** — do not re-implement or
      contradict. (Pre-filtering as an optimization is fine — Genesis does — but
      the shared invariant is the guarantee.)
- [ ] Never write pipeline-owned columns: `imdb_rating`, `age_classification`, or
      any impression/decay column (overview §4.2).

## Safety
- [ ] For a kids profile, the engine's candidate set going into the shared age
      gate results in a fully-vetted served list — verify with an age-limited test
      profile that the age gate catches anything the engine surfaced.
- [ ] No request-path work: `generate` runs **only** in the background build,
      never in the serve path.

## Capabilities
- [ ] `capabilities.preResolved` accurately reflects whether candidates already
      carry `imdb_id` + poster + genres. If `false`, the pipeline resolves them; if
      `true`, the engine guarantees a valid `tt` id (no-tt candidates are dropped).
- [ ] `capabilities.serveOrder` is `'affinity'` unless the serve path has been
      taught to honor `'preserve'` (out of scope until an engine needs it).
- [ ] `capabilities.unrestricted` is set **honestly** (I7):
  - A **gated** engine (`false`) must produce candidates the shared age gate can
    make safe for any profile.
  - An **unrestricted** engine (`true`, "all ages"/fully open, applying *no* age
    classification):
    - [ ] declares it, so the registry excludes it from age-limited profiles
          (`availableFor`) and `resolveFor` refuses it for them;
    - [ ] still does **not** bypass the NSFW/porn blacklist (absolute for **all**
          engines) — "open" is no age *classification*, not NSFW (overview §8 Q1);
    - [ ] never surfaces on the companion for an age-limited profile (filtered
          server-side, the age limit never exposed).

## Registration
- [ ] Added to `src/engines/index.js`'s registry with `supportedTypes` correct, so
      it appears only in the per-type dropdowns it supports.
- [ ] Ships **globally disabled** by default (SC-07 / D4): a newly code-registered
      engine is OFF until the admin enables it in Server Config, so it is
      user-visible only when **registered AND enabled**. (Genesis is the one
      permanent exception — always enabled, the safe floor.)
- [ ] Has a user-facing `description` written for a non-technical family member.

---

## How this is exercised in the suite

The fixtures at [`test/fixtures/fake-engine.js`](../../test/fixtures/fake-engine.js)
are registered through the test-only hook `engines._register(engine)` (which
returns a disposer, keeping production's registry Genesis-only) and drive these
conformance checks:

- **`fake` → pipeline → pool → serve.** Its hand-built candidates become pool rows
  with the right column mapping (`rankScore`→`affinity`, `reason`→`because_title`,
  `recCount`→`rec_count`) and serve in `rankScore` order — with **no Genesis code**
  producing them.
- **Per-type isolation.** `fake` for movies + Genesis for series yields a movie
  slice from the fake engine and a series slice owned by Genesis; neither leaks
  into the other.
- **Safety is engine-independent (I1).** An age-limited profile whose *fake-sourced*
  pool contains an over-band title has that title removed by the shared age gate —
  proving the age gate, not the engine, is the authority.
- **Unrestricted gating (I7)** via `fake-open`: it is offered to an adult profile
  but never listed (`availableFor`), resolved (`resolveFor`), selectable
  (`updateProfile` coercion + age-limit-raise revocation), or shown on the
  companion for an age-limited profile — and it never bypasses the NSFW blacklist.
