# Engine Abstraction — scope cards

**Status:** DESIGN ONLY (no code). A multi-engine recommendation architecture:
pluggable engines behind an engine-agnostic output, per-type (Movies/Series)
selection in the portal and the Mobile Companion, defaulting to the current
engine — now named **Genesis Engine**.

Start with **[`00-overview.md`](00-overview.md)** — the contract, invariants,
config model, migration, naming, and the dependency graph. Then the cards:

| # | Card | Layer | Depends on |
|---|---|---|---|
| 00 | [Overview & North Star](00-overview.md) | anchor | — |
| 01 | [Engine interface, registry & Genesis extraction](01-engine-interface-and-genesis.md) | backend core | — |
| 02 | [Per-type engine config](02-per-type-engine-config.md) | backend/config | 01 |
| 03 | [Build dispatch + rebuild-on-change](03-build-dispatch.md) | backend | 01, 02 |
| 04 | [Portal UI selectors](04-portal-ui.md) | frontend (portal) | 02 |
| 05 | [Companion UI selectors](05-companion-ui.md) | frontend (mobile) | 02 |
| 06 | [Conformance spec + second-engine template](06-conformance-and-second-engine-template.md) | doc/validation | 01–03 |
| 07 | [Global engine enablement (admin toggle)](07-global-engine-enablement.md) | backend/config + frontend (portal) | 01, 02, 03 |

The card `06` deliverables are live: the pass/fail gate for any engine is
[`CONFORMANCE.md`](CONFORMANCE.md), the copy-me skeleton is
[`src/engines/_template.js`](../../src/engines/_template.js) (unregistered), and
the tested example is [`test/fixtures/fake-engine.js`](../../test/fixtures/fake-engine.js).

**Delivery order:** 01 → 02 → 03 → 07 → (04 ∥ 05) → 06.

**Key property:** cards 01–05/07 are a **user-visible no-op** until a second
engine is both **registered** (in code) and **enabled** (admin toggle, `07`) —
both dropdowns show only "Genesis Engine" and everyone keeps today's results.
That makes the whole thing shippable in stages with near-zero risk to existing
profiles.

**Decisions (resolved 2026-09-05 — see `00-overview.md` §8):**
- **D1** — engines declare `supportedTypes` (Movies+Shows / Only Movies / Only
  Shows) and an **`unrestricted`** ("all ages"/fully open) capability;
  unrestricted engines are **selection-gated away from any age-limited profile**
  (I7, §5.5). NSFW/porn blacklist stays absolute for every engine (open sub-Q1).
- **D2** — second engine is a **mock/stub only** (card 06); real new-source
  engines are deferred, source-gated, James's call.
- **D3** — current v6 build → **stable `main`**; engine work → **new
  `v7.0.0-beta`** line (design note only; git actions are James's, §9).
- **D4** (added 2026-09-05) — engines carry a **global admin enable/disable**
  toggle in Server Config (card `07`). **Genesis is permanently enabled** (the
  default + safe floor, non-disableable); a new engine ships **disabled** and the
  admin turns it on. A disabled engine reverts affected profiles to Genesis
  (persisted revert + slice rebuild, reusing `03`). Right now only Genesis is
  enabled.

Each card is self-contained: current-state file/line references, design,
tasks, acceptance criteria, and test notes — ready to hand to an independent
coding agent.
