# ME-10 — Offline backtest harness

**Depends on:** ME-09 · Spec: README "enable-for-family gate"

## Why
The gate for enabling Marquee for the family: evidence that it beats Genesis on real history.

## Deliverable
`scripts/bench-engines.js <profileName> [--holdout 10] [--engines genesis,glass,marquee]`
1. Load the profile's watched movies. Hide the `holdout` most recent (the targets).
2. For each engine, run `generate(profile,'movie',ctx)` against a **ctx whose watched sets and
   the taste inputs exclude the held-out titles**. Use an in-memory/temp DB copy so the real pool
   is never written.
3. Metrics per engine: **hit@20** (targets in the top-20 after `selectServe` with the profile's
   filters), **recall@100**, **mean rank of hits**, **filter-pass rate** (share of the returned
   set passing `selectServe`, which should be ~1.0 for Marquee), **trending share** in the top-20.
4. Print a table, and optionally write JSON to `DATA_DIR/bench/`.

## Traps
- Leakage: ratings of held-out titles must also be hidden from Marquee's taste model.
- LLM caches: pass `--no-cache` to force fresh fit scores, or leave caches on to measure steady state.
- Never writes to Simkl, and never touches the live `recommended` table.

## Acceptance
Runs on each real profile. Results are recorded in `00-design-spec.md` §"Backtest results". Marquee
is enabled for the family only if it beats Genesis on hit@20 for most profiles (James decides).
