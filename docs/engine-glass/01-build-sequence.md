# Glass Engine — Build Sequence & Dependency Map

**Version:** 0.1 · **Status:** DESIGN ONLY (sequencing, no code) · **Companion to**
[`00-glass-design-spec.md`](00-glass-design-spec.md).

This turns the eight resolved decisions (`GD-1…GD-8`, spec §6) into a sequenced set of
**build cards** (`GE-01…GE-12`) with dependencies, blocking relationships, and the truly
independent cards that can start in parallel. It is the index from which the full card
bodies get written; no card is built yet.

> **Baseline dependency for the whole set:** the engine-abstraction (`SC-01…07`) is
> **already complete** — registry, shared pipeline, per-type dispatch, per-type config,
> conformance gate, global enable/disable. Every Glass card plugs **into** that seam; none
> of it is rebuilt here. Glass is registered through `SC-01`'s registry, ships globally
> disabled per `SC-07`, and must pass `CONFORMANCE.md` before it is enabled.

---

## 1. How the 8 decisions distribute across cards

The decisions are *cross-cutting*; several realise across multiple cards.

| Decision | Realised by |
|---|---|
| **GD-1** Simkl trending source | **GE-02** (cache) + **GE-05** (candidate generation consumes it) |
| **GD-2** LLM rerank first / embeddings deferred | **GE-08** (rerank) + **GE-09** (embeddings, optional) |
| **GD-3** momentum in-file (CLOSED) | folded into **GE-02** (fields cached) + **GE-06** (momentum feature) — no card |
| **GD-4** trending cadence (by consequence) | folded into **GE-02** (daily refresh) — no card |
| **GD-5** TMDB deep metadata | **GE-03** (service+store) + **GE-04** (history backfill) + **GE-06** (intersect scoring) |
| **GD-6** tiered config | **GE-06** (Tier-1 defaults) + **GE-07** (Tier-2 admin) + **GE-12** (Tier-3 sliders, deferred) |
| **GD-7** `unrestricted:false` | **GE-07** (descriptor capability) |
| **GD-8** identity (`id:'glass'`, name, copy) | **GE-07** (descriptor) |

---

## 2. Card catalogue

| Card | Title | Realises | Phase | Depends on | Blocks |
|---|---|---|---|---|---|
| **GE-01** | Score-components store (JSON/side-table + `algorithm_version`, `engine_id`) — engine-agnostic | A | — (abstraction only) | GE-06, GE-08, GE-09, GE-11 |
| **GE-02** | Simkl trending cache — CDN client, combined `week_500`, 3-way store (movies/tv/anime), daily refresh, graceful-degrade | A | — | GE-05 |
| **GE-03** | TMDB metadata enrichment service (`append_to_response=credits,keywords,external_ids`) + Glass-owned metadata store | A | — (tmdb svc exists) | GE-04, GE-05, GE-06 |
| **GE-04** | Watched-history enrichment + one-time governor-paced backfill + enrich-on-ingest | A | GE-03 | GE-05, GE-06 |
| **GE-05** | Taste model v2 (L/M/R half-lives, enriched dims) + candidate generation (strategies A–G, dedupe+`sources[]`, exploration, GI-1 truncate) | A | GE-02, GE-03, GE-04 | GE-06, GE-10 |
| **GE-06** | Feature calc + weighted base scoring → `rankScore` + `score_components` (Tier-1 defaults; intersect bonuses) | A | GE-05, GE-01 | GE-07, GE-08, GE-09 |
| **GE-07** | Descriptor + registry registration (ships globally disabled) + `unrestricted:false` + Tier-2 admin config (`settings.glass`, build-affecting) + **conformance pass** | A | GE-06 | GE-08, GE-12 |
| **GE-08** | LLM semantic rerank + explanations (reuse `settings.llmChain`, prefer-local, degrade-to-deterministic) | B | GE-07, GE-01 | GE-11 |
| **GE-09** | Vector embeddings (local model + Float32 BLOB + cosine) → `semantic_similarity` — **optional, evidence-gated** | C | GE-06, GE-01 | — |
| **GE-10** | Feedback wiring — map impressions/decay/scrobble/mark-watched/`dont_recommend` into the taste-model event list | D | GE-05 | GE-11 |
| **GE-11** | Learned ranking (LTR) — model emits `rankScore`; A/B vs deterministic Glass + Genesis | E | GE-01, GE-08, GE-10 | — |
| **GE-12** | Per-profile tuning sliders (Tier-3: recency, exploration; companion-whitelisted, build-affecting) — **deferred** | (config) | GE-07 | — |

---

## 3. Dependency graph

```
 ── TRULY INDEPENDENT (Wave 0 — no Glass-internal deps; start in parallel) ──
   GE-01  Score-components store ───────────────────────────────┐
   GE-02  Simkl trending cache ──────────────────────┐          │
   GE-03  TMDB enrichment svc + store ──┐             │          │
                                        ▼             │          │
                              GE-04  watched enrich + backfill   │
                                        │             │          │
                                        ▼             ▼          │
                              GE-05  taste model v2 + candidate gen
                                                      │          │
                                                      ▼          ▼
                              GE-06  feature calc + scoring (Tier-1 defaults) ◀── needs GE-01
                                                      │
                                                      ▼
                              GE-07  descriptor + registry + Tier-2 + CONFORMANCE
                                        ══════════════╪══════════════  ◀── PHASE A / MVP
                                                      │      (Glass selectable once admin-enables it, SC-07)
                    ┌─────────────────────────────────┼───────────────────────┐
                    ▼                                 ▼                        ▼
            GE-08  LLM rerank (Ph B) ◀─ GE-01   GE-12  Tier-3 sliders     GE-10  feedback wiring (Ph D)*
                    │                                                          │
                    ▼                                                          │
            GE-09  embeddings (Ph C, optional) ◀─ GE-06,GE-01                  │
                    │                                                          │
                    └──────────────────────────┬───────────────────────────────┘
                                                ▼
                                        GE-11  learned ranking (Ph E) ◀── GE-01
```
`*` **GE-10** only needs **GE-05**, so it can be slotted any time after the taste model
exists — drawn late because its *value* lands once Glass is live, but it is not on the
critical path.

---

## 4. Delivery waves (critical path in **bold**)

| Wave | Cards | Milestone |
|---|---|---|
| **0** | **GE-01**, **GE-02**, **GE-03** (parallel) | Foundations — all independent |
| **1** | **GE-04** | Enriched history ready |
| **2** | **GE-05** | Candidates + taste model produce a ranked set |
| **3** | **GE-06** | `rankScore` + components emitted |
| **4** | **GE-07** | **PHASE A / MVP — Glass is a conformant, registered engine** (dark until an admin enables it; a user-visible no-op until then per `SC-07`) |
| 5 | GE-08 | **Phase B** — LLM semantic rerank + explanations (the free-local-LLM layer) |
| 6 | GE-09 | **Phase C** — embeddings, *only if* GE-08-era components data shows a gap |
| — | GE-10 | **Phase D** — feedback wiring (slot in any time after GE-05) |
| — | GE-11 | **Phase E** — learned ranking (needs GE-01 + GE-10 + GE-08 data) |
| — | GE-12 | Tier-3 per-profile sliders — deferred until defaults are calibrated |

**Critical path to MVP:** GE-03 → GE-04 → GE-05 → GE-06 → GE-07 (with GE-01 joining at
GE-06, and GE-02 joining at GE-05). Five cards deep; three of the first four Wave-0/1
cards are independent, so the early work parallelises well.

---

## 5. Truly independent cards (can start immediately, in any order)

- **GE-01 — score-components store** (shared; Genesis can fill it too)
- **GE-02 — Simkl trending cache** (self-contained data layer)
- **GE-03 — TMDB enrichment service + store** (self-contained data layer)

These three share **no** Glass-internal dependency — only the already-complete
engine-abstraction and existing services. They are the parallel foundation; everything
else chains off them. (**GE-04** joins as soon as **GE-03** lands.)

---

## 6. Cross-cutting notes

- **Build-affecting (GD-6).** Every Glass tuning knob changes stored `rankScore`, so any
  config change (Tier-2 global or Tier-3 per-profile) routes through `SC-03`'s
  `clearType` + rebuild — wired in **GE-07** (Tier-2) and **GE-12** (Tier-3).
- **Conformance gate.** **GE-07** is where Glass is run against `CONFORMANCE.md` (I1–I7),
  including an age-limited profile proving the shared age gate vets a Glass-sourced pool
  (I1) and `unrestricted:false` behaviour (I7). No card registers Glass before this passes.
- **Everything is a no-op until enabled.** Because Glass ships globally disabled (`SC-07`),
  Wave-0 through GE-07 change nothing a user sees until the admin flips it on — the same
  staged-safety property the engine-abstraction was built to give.
- **`id:'glass'` is frozen** at GE-07 (persisted in profiles); copy/weights stay iterable.
