# Marquee Cinema

**Status:** built and live — the movie engine for every profile (algorithm
`marquee-m4`, id `marquee`, settings under `settings.marquee`). Not optional: Movies
and Shows engines are mandatory; only the Anime lane can be switched off.

A **candidate-producer** engine behind the engine seam (`src/engines/types.js`). It
exists to fix four gaps in the retired Genesis/Glass engines: filters were enforced
only at serve time, movies reached the age gate without a real classification,
trending lists included titles not yet streamable, and the LLM only re-ordered.

Read **[`00-design-spec.md`](00-design-spec.md)** — research, the filter envelope,
candidate sources, scoring, LLM use, invariants, backtests (§14–§15) and calibrated
serving (§16). Platform context: [`../architecture.md`](../architecture.md).

**Decisions (James, 2026-09-26):**
- The local LLM is fast (≥30 tok/s); it suggests titles *and* scores every shortlisted
  candidate.
- Trending is a meaningful boost (~20% of the score), **gated by taste match** so it
  only lifts films that already fit the viewer.
- On kids profiles, a movie with **no AU/US classification is excluded** before the
  shared age gate.
- Every data source was approved by James; adding another needs a new sign-off.

Sibling engines: [Marquee TV and Anime](../engine-marquee-tv/00-design-spec.md). The
per-card build breakdown (ME-00…ME-10, SH-01) was retired once the engine shipped; it
is in git history if you need it.
