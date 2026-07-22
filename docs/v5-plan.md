# v5 Implementation Plan — engine selection, two-pass AI age gating, metadata service

**Status:** Approved for build (staged). Companion to `docs/phase1-plan.md` and
the v4 sections of `DESIGN.md`.
**Target release:** `v5.0.0-beta` — published WITHOUT moving `:latest`
(`:latest` stays pinned at v2.6.1).

## Why

Two live problems, both hitting the kids' profiles:

1. **Trakt's engine is structurally unsafe for a child.** It optimises for
   "people like you also watched"; a 13-year-old anime watcher's nearest
   neighbours are adult anime viewers, so her recommendations came back as
   Elfen Lied / High School DxD / Devilman Crybaby. No post-filter fixes a
   generator that is blind to age — generation itself must be age-aware.
2. **Search leaks.** Our addon can't serve `meta`, so a metadata addon
   (AIOMetadata) is mandatory for playback — and it answers search
   *unfiltered*, alongside our sanitised results. The "install only our addon"
   mitigation was unusable until we serve `meta` ourselves.

CSM is also retired: its anime coverage is thin, so most anime returns *no
rating*, and strict mode drops unrated titles. For an anime-heavy profile CSM
isn't strict — it's absent.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Verifier vendor | **Groq for both passes**, verifier vendor-swappable in config (add Gemini later only if veto logs prove it's needed) |
| 2 | Judgement age | **`age_limit + 1`** (Ciara: limit 13 → judged at 14, the nearest bracket for anime/TV-14) |
| 3 | `meta` age gating | **Ungated** — every discovery surface is already gated, and this avoids latency on every title open |
| 4 | MDBList | **Optional** — with CSM gone it's only needed for curated catalogs + optional IMDb ratings |
| 5 | Engine setting | Per-profile `engine: trakt \| ai`, default `trakt` |

---

## Stage 1 — Metadata service (do first: closes the live leak)

Makes a kid's device viable with **our addon + a stream addon only**. Stream
addons (Torrentio/Comet) declare only `stream` with no catalogs, so they don't
answer search — verify against the one in use.

**Strategy adapted from [aiometadata](https://github.com/cedya77/aiometadata)**
(studied its `getMeta` path; it solves these well):

- **One call per title.** Movies: `append_to_response=videos,credits,
  external_ids,images,release_dates`. Series: same but `content_ratings`.
- **Season batching — the key trick.** Its `genSeasonsString` chunks seasons
  into groups of 20 and requests `append_to_response=season/1,season/2,…`, so
  a 10-season show costs **1 call, not 11**; >20 seasons chunks into
  `ceil(n/20)`.
- **Episode (`videos`) object shape** — this array is what enables playback:
  ```
  { id: "tt123:S:E", title, season, episode, released (ISO),
    available, overview, thumbnail, runtime }
  ```
- **`available`** flags whether the episode has aired — adopt it, so unaired
  episodes don't present as playable.
- **Caching is mandatory**, not optional: `meta` is a request-path call on
  every title open. Disk cache per tt id (long TTL for movies/ended series,
  short for returning ones) plus a generous `cacheMaxAge` response hint.

**Work:** `meta` in the manifest (idPrefixes `tt`); `GET /meta/:type/:id.json`;
tt→TMDB via `/find`; movie + series meta; season batching; disk cache.

**Known risk — anime episode numbering.** TMDB seasonal numbering often
diverges from what stream addons expect for anime (absolute numbering,
kitsu/mal ids). aiometadata carries substantial machinery for this
(kitsu/mal mapping, Cinemeta cross-check). We will ship standard `tt:S:E`,
which is correct for most content and much anime, and treat mis-mapped anime
as a follow-up rather than pre-building that complexity. Ciara is the anime
watcher, so this is the thing to watch in testing.

## Stage 2 — Engine selection + AI engine

New per-profile `engine`. `trakt` = today's v4 pipeline, unchanged. `ai` =
age-aware generation:

1. **Groq generate** — recent history + "recommend 50 titles suitable for a
   [age_limit + 1]-year-old, Australian standards"
2. **Resolve to real IDs** (TMDB) — drop unresolvable. *Non-negotiable: the v2
   lesson is that LLM output is a suggestion, never ground truth.*
3. **Deterministic filters** — watched-exclusion, rating floor, excluded genres
4. **Groq verify** — fresh context, remove-only, same age bracket, "err on the
   side of exclusion; judged against Australian classification (ACB)"
5. Top `list_size` displayed + equal bench

The two passes are separated by *job*, not vendor: the verifier sees each title
cold, without the generator's investment in its own answer. Verifier provider
is config so a second vendor is a setting, not a rewrite.

## Stage 3 — Retire CSM + consolidate + ship

- Remove the strict CSM gate from **every** surface — AI lists, extra
  catalogs, Watch Later, **and search** (otherwise search silently becomes the
  weakest surface).
- The AI age gate becomes the single age authority, everywhere, fail-closed.
- MDBList demoted to optional; portal badge/requirements updated.
- README + DESIGN v5 sections; `package.json` → `5.0.0-beta`; tag.

---

## Residual risks (name them, watch them)

- **The LLM is now the only age gate.** No CSM; certifications are sparse and
  US-centric for anime. LLMs know mainstream anime well and are shakier on the
  long tail — which is exactly where the unpleasant material lives. Mitigation:
  the veto logs are the review surface for week one; excluded-genres remains a
  hard deterministic wall for anything specific.
- **Search + meta are request-path.** Both call out live. Caps and caching keep
  them sane; watch latency on first open of a long series.
- **Groq free-tier limits.** Two LLM passes per kids catalog per rebuild plus
  search/meta traffic. Kids profiles only; adult profiles still make zero LLM
  calls.

## Build sequence

1. `meta` service + cache (Stage 1) → commit → user removes AIOMetadata
2. `engine` setting + AI two-pass engine (Stage 2) → commit
3. CSM retirement + consolidation + docs + version (Stage 3) → tag `v5.0.0-beta`
