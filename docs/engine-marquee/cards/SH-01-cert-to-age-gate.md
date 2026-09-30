# SH-01 — Real movie classifications reach the shared age gate (shared, optional)

**Depends on:** — (independent) · Benefits **every** engine · Spec: §1 G2

## Problem
`ageGatePool` sends the LLM `certification: r.age_classification`, but `age_classification`
is only ever filled with a MAL band (anime). Non-anime movies reach the gate with **no
classification**. The serve-time net `certMinAge` knows only `G/PG/PG-13/R/R+`.

## Deliverable
1. The pool gets a new nullable column `certification TEXT` (the idempotent `ALTER TABLE` pattern in
   `recommendationStore.init`). `upsertCandidates` writes `c.certification`.
2. The pipeline fills it:
   - **preResolved engines** (Glass, Marquee) supply `certification` = strictest of `certAU`/`certUS`
     from deep meta (Marquee sets it. Glass can set it once ME-02's deep-meta fields exist).
   - **Resolve path** (Genesis): upgrade the pipeline's `imdbFor` step to one call with
     `append_to_response=release_dates` (the `external_ids` endpoint → the details endpoint with
     `external_ids,release_dates` appended). It's still one request per candidate.
3. `ageGatePool` passes `certification: r.certification || r.age_classification` to `groq.ageGate`.
4. `certMinAge` learns the AU/US table from ME-01 §3.4. Better: import `certMinAge` from
   `engines/marquee/filters.js` into a shared util so both use one table.

## Safety argument
This is **stricter-only**. Adding real certs gives the LLM more evidence and gives the serve net more
titles it can judge. No title that passes today can be made to pass more easily, because unknown
still means "kept at serve" exactly as before.

## Tests
Genesis build: a pool row carries the cert. The age-gate prompt includes it. `passesAgeBand` rejects
`MA 15+` at age 10 and keeps `PG`.

## Acceptance
`npm test` is green. There are no behaviour changes for adult profiles.
