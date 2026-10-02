# TV-14 age tier: plan (Marquee TV)

**Date:** 2 October 2026 · **For:** Ciara (turned 14) · **Scope: Marquee TV only.** Anime is excluded from Marquee TV and must never appear in its results. Marquee Cinema, Genesis and the anime lane are out of scope.

## 1. Decisions (James, 2 October 2026)

| # | Decision |
|---|---|
| D1 | TV-14 **allow list:** TV-Y, TV-Y7, P, C, TV-G, TV-PG, G, PG, TV-14, M. **Block list:** TV-MA, MA 15+, R, R 18+, adult |
| D2 | Re-judge Ciara's cached LLM decisions once under the TV-14 wording |
| D3 | Anime: ignore here. **Anime is excluded from Marquee TV**, so its results never show anime |
| D4 | A title with no AU/US rating is checked against **several sources** before the LLM. Only if none has a rating does the LLM decide |
| D5 | Store real certificates on every Marquee TV row for age-limited profiles |

## 2. Research behind D4 (live, 2 October)

**Population:** every non-anime show in all live series lists and watch histories: **854 shows**.

| | Count |
|---|---|
| TMDB AU rating | 602 (70%) |
| TMDB US rating | 819 (96%) |
| **Neither AU nor US** | **25 (2.9%)** |

**The 25 unrated shows, checked against the other sources:**

| Source | Has a rating |
|---|---|
| TMDB, another country (GB, CA, DE, KR, SG…) | 12 |
| Simkl show `certification` (US TV scale) | 15 |
| MDBList `certification` (excluding "NR") | 15 |
| MDBList Common Sense age | 16 |
| **Any source** | **23 of 25** |
| **Truly unrated → LLM** | **2** (*Travel Guides (AU)*, *Alien Stage*) |

**TVDB:** no key is configured. TVDB v4 needs an API key, either a subscriber key or a licensed project key. With 23 of 25 already resolved without it, TVDB would add at most 2 titles (D8).

**Rating strings seen on TMDB for these shows:**
- AU: M 146, PG 70, MA 15+ 310 (two spellings), G 52, R 18+ 23 (two spellings), **AV 15+** 1.
- US: TV-14 238, TV-PG 82, TV-MA 387, TV-Y7 65, TV-G 32, TV-Y 15.
- P and C (AU children's TV) didn't appear but are on the allow list. Variants such as **TV-Y7-FV** and spacing differences ("MA15+" vs "MA 15+") must normalise.

**Sources disagree** when they're foreign or alternative, e.g.:
- *Harry Wild*: Simkl TV-14, Common Sense 15, Germany 12, Taiwan 18+.
- *The Doctor Blake Mysteries*: Simkl TV-PG, GB 12, Canada 18+, Common Sense 15.

**AU vs US for the same show:** 592 shows have both; **121 (20%) disagree**:
- **80:** AU MA 15+ / US TV-14 (*Citadel*, *Halo*, *24*, *9-1-1*, *Chicago P.D.*, *Miami Vice* is even AU R 18+).
- **41:** AU M / US TV-MA (*American Crime Story*, *Vigil*, *The Capture*).

**Anime leak:** *Pokémon* (tt0313487) passed the Fribb anime map and was counted as a normal show. Anime exclusion needs several detectors (§3.5).

## 3. Design

### 3.1 The TV-14 tier (for Marquee TV)

```
allow: TV-Y, TV-Y7 (incl. TV-Y7-FV), P, C, TV-G, TV-PG, G, PG, TV-14, M
block: TV-MA, MA15+, AV15+ (D9), R, R18+, X18+, RC, TMDB adult flag
```

Ratings are normalised first: upper case, no spaces ("MA 15+" = "MA15+"); NR, Unrated or an empty value = no rating.

### 3.2 Deciding a show (first stage that gives an answer wins)

1. **TMDB AU and US** (one call, already in the Marquee TV lookup). If **either** is on the block list → **blocked** (D6, recommended: strictest wins). Else if at least one is on the allow list → **allowed**.
2. **Fallback sources**, only when AU and US are both missing:
   - Simkl show `certification`;
   - MDBList `certification`;
   - MDBList Common Sense age;
   - TMDB GB / IE / NZ / CA ratings.

   Each value maps to allow or block. US/AU strings use the lists. Numeric or foreign ages: ≤ 14 → allow, ≥ 15 → block (GB 12 allow, GB 15 block, Common Sense 15 block, SG M18 block, KR 19 block). **Strictest wins** across the available fallback values (D6).
3. **The LLM:** only when every source is empty. TV-14 wording: "a 14-year-old in Australia; suitable up to US TV-14 / AU M; not suitable: anything TV-MA, MA 15+, R 18+, or beyond". Cached under a TV-14 key (D2).

The decision and its source (`tmdb-au`, `tmdb-us`, `simkl`, `mdblist`, `csm`, `tmdb-gb`, `llm`) are stored on the row (D5) and shown in the debug/backtest output.

### 3.3 Where it runs

- Inside **Marquee TV's filters**, before scoring (like Marquee Cinema's certificate filter), so a blocked show is never stored. The serve-time re-check reads the stored rating.
- TMDB's `content_ratings` comes back with the per-show lookup that Marquee TV already makes, so it costs nothing extra. The fallbacks run only for the ~3% without AU/US: ≈ 3 Simkl + 3 MDBList calls per 100 shows, and these get cached.

### 3.4 The profile setting

- `age_limit: 14` appears in the portal as **"TV-14 (14+, AU M)"**, read by Marquee TV.
- The companion never shows or edits the age limit (unchanged).
- **Films:** see D7.

### 3.5 Anime exclusion (Marquee TV)

A show counts as anime, and is excluded from candidates, seeds and taste, if **any** of these is true:
- Fribb anime map hit;
- in the profile's Simkl `anime` section (history);
- Simkl summary `type`/`anime_type` says anime;
- TMDB Animation genre **and** Japanese origin (`origin_country` JP or `original_language` ja).

*Pokémon* would have been caught by the Simkl and TMDB rules.

## 4. Decisions D6–D9 (James, 2 October 2026)

| # | Decision |
|---|---|
| D6 | **Common Sense Media decides.** If there's no Common Sense age, the **AU rating** decides; then the rest of the D4 chain |
| D7 | **Films** at TV-14 follow the same line: **G, PG, PG-13, M allowed; MA 15+, R blocked** |
| D8 | **TVDB is in.** The key was verified live (login OK, no PIN needed). It's stored in the local gitignored `.env` (`TVDB_API_KEY`), **not committed** (the repo is public). The app will read it from Server Config (`settings.keys.tvdb_api_key`, encrypted at rest), and the reviewer sets it on the live server when that ships |
| D9 | **AV 15+ blocked**; **E** treated as unrated (fallback sources) |

## 5. Research behind D6/D8 (live, 2 October)

**TVDB** (on the D4 unrated set):
- *Travel Guides (AU)* → AU PG (no other source had it).
- *Alien Stage* → none.
- *Harry Wild* → US TV-14, FR -12.
- *Peppa Pig* → AU G, US TV-G.

With TVDB, **1 of 854** shows needs the LLM.

**Common Sense via MDBList:**

| | Shows (853 non-anime) | Ciara's films (78) |
|---|---|---|
| Has a Common Sense age | **842 (99%)** | **78 (100%)** |
| Age histogram (shows) | ≤ 13: 255 · **14: 151** · **15: 217** · 16: 112 · 17: 87 · 18: 20 | — |

**Common Sense vs AU, where both exist (600 shows):** agree 479; Common Sense allows / AU blocks **61**; Common Sense blocks / AU allows **60**.
- *Allowed by Common Sense, blocked by AU:* *Citadel*, *9-1-1*, *Platonic*, *Zero Day*, *Lethal Weapon*, *NCIS: Hawai'i* (all CSM 14 / AU MA 15+), **Miami Vice (CSM 14 / AU R 18+)**.
- *Blocked by Common Sense, allowed by AU:* *Happy Endings* (CSM 15 / AU PG), *2 Broke Girls*, *American Crime Story*, *Vigil*, *Little Britain* (CSM 15 / AU M), *The Capture* (CSM 17 / AU M).

**Ciara's current films under the TV-14 film line:** 74 allowed, 4 blocked (*The Pianist* CSM 15, *The Physician* 17, *Tenacious D in The Pick of Destiny* 16, *My Left Foot* 16).

## 6. The final decision chain (per title, first stage with an answer wins)

| Step | Source | TV-14 rule |
|---|---|---|
| 0 | **Hard floor (D10, proposed):** AU R 18+ / X 18+ / RC, the TMDB adult flag, NSFW blacklist | always blocked, whatever Common Sense says |
| 1 | **Common Sense age** (MDBList, 30-day cache) | ≤ 14 allow · ≥ 15 block |
| 2 | **AU rating** (TMDB, then TVDB) | the TV or film allow/block lists |
| 3 | US rating (TMDB, then TVDB) | the lists |
| 4 | Simkl certification → MDBList certification → TMDB/TVDB GB/IE/NZ/CA | the lists; foreign ages ≤ 14 allow, ≥ 15 block |
| 5 | **LLM** (TV-14 wording, own cache key; D2 re-judge) | allow/veto |

**Lists:**
- **TV:** allow TV-Y, TV-Y7(-FV), P, C, TV-G, TV-PG, G, PG, TV-14, M; block TV-MA, MA 15+, AV 15+, R, R 18+, X 18+, RC.
- **Films:** allow G, PG, PG-13, M; block MA 15+, R, R 18+, X 18+, RC, NC-17. E = unrated.

The decision and its source are stored on every row (D5).

## 7. Packaging (proposed)

D7 covers films, and Ciara's shows stay on Genesis until Marquee TV is live. So the chain belongs in **one shared module** (`src/ageTiers.js` + the decision chain), used by:
- (a) the shared pool age gate, for every engine and both types;
- (b) Marquee Cinema's filters;
- (c) Marquee TV's filters, later.

Card **AGE-1** builds the module, wires it into (a) and (b), adds the portal option "TV-14 (14+, AU M)" and the Server Config TVDB key field. Every existing tier (5–13, 15) keeps today's behaviour exactly, proven by an identity test.

After AGE-1 ships, **Ciara can move to TV-14 immediately**: her Genesis shows and films get the chain. Marquee TV picks the module up in TV-2. Anime stays out of Marquee TV (§3.5); it's unaffected here.

| # | Still to confirm | Recommendation |
|---|---|---|
| D10 | A hard floor that Common Sense can't override: AU **R 18+** / X 18+ / RC and adult flags always block (*Miami Vice* is CSM 14 but AU R 18+) | **Yes** |
| D11 | Build AGE-1 as a separate card now (Bob, in parallel with TV-1), so Ciara can move to TV-14 before Marquee TV exists? | **Yes** |

---

## 9. Proposal: one tier model for all ages (10 / 12 / TV-14 / 15+)

**Requested by James, 2 October:** replace 5, 6, 8, 10, 12, 13, 15 with **10, 12, 14 (TV-14), 15+**, each mapped the same way as TV-14. Every tier runs the same chain (hard floor → Common Sense → AU → US → TVDB/Simkl/MDBList/foreign → LLM); only the thresholds and lists differ. The "+1 judgement age" goes away.

| | **10+** | **12+** | **TV-14** (decided) | **15+** |
|---|---|---|---|---|
| Common Sense allows | ≤ 10 | ≤ 12 | ≤ 14 | ≤ 15 |
| Shows allowed | TV-Y, TV-Y7(-FV), P, C, TV-G, G, TV-PG, PG | same as 10+ | + TV-14, M | + MA 15+, AV 15+ |
| Shows blocked | TV-14, M, TV-MA, MA 15+, AV 15+, R, R 18+ | same as 10+ | TV-MA, MA 15+, AV 15+, R, R 18+ | TV-MA, R, R 18+ |
| Films allowed | G, PG | G, PG | G, PG, PG-13, M | G, PG, PG-13, M, MA 15+ |
| Films blocked | PG-13, M, MA 15+, R, R 18+ | same as 10+ | MA 15+, R, R 18+ | R, R 18+ |
| Foreign / numeric | ≤ 10 (GB U, PG) | ≤ 12 (GB 12, 12A) | ≤ 14 | ≤ 15 (GB 15, IE 15A) |
| Anime MAL band | G, PG | G, PG | + PG-13 | + PG-13 (R-17+ blocked) |
| **Hard floor** (always blocked, whatever Common Sense says) | MA 15+, AV 15+, TV-MA, R, R 18+, X 18+, RC, NC-17, adult | same as 10+ | R 18+, X 18+, RC, NC-17, adult | same as TV-14 |
| LLM wording (own cache key per tier) | a 10-year-old: up to TV-PG / PG / AU PG | a 12-year-old: up to TV-PG / PG / AU PG | as decided | a 15-year-old: up to MA 15+ / TV-14 / PG-13; nothing R 18+, R or TV-MA |
| Portal label | 10+ (TV-PG / PG) | 12+ (PG, UK 12) | TV-14 (14+, AU M) | 15+ (MA 15+) |

**What Common Sense lets through, by tier** (853 non-anime shows; cumulative): ≤ 10: 165 · ≤ 12: 204 · ≤ 14: 406 · ≤ 15: 623.

**Impact on current profiles** (only Conor = 10 and Ciara = 13 have a limit):
- **Conor (10):** Common Sense covers 55/55 of his films and 52/53 of his shows. A strict "≤ 10" removes **8** titles that today's gate (judging at 11) lets through:
  - *The Lord of the Rings* ×3 (CSM 11), *Jumanji: Welcome to the Jungle* (11), *Thor: Tales of Asgard* (11);
  - *Son of Batman* (13), *Dragonheart: Battle for the Heartfire* (13), *Mr. Bean: The Animated Series* (12).
- **Ciara:** moves to TV-14 as planned.

**Migration of stored values (never looser):** 13 → 12 and 11 → 10 round down; 16+ → 15; 1–9 → 10 (no profile uses them). James then picks TV-14 for Ciara himself.

**Curated catalog bands:** Trending Kids (12) → the 12+ tier; "Anime TV-14" (band 13, min age 13) → **14**, matching its name.

**Open decisions:**
- E1: include 15+?
- E2: strict Common Sense ≤ N (Conor loses the 8 above) or a +1 leeway?
- E3: a stricter hard floor for 10+/12+?
- E4: migration + catalog bands as above?

## 8. AGE-1 build notes

- The service is `src/ageVerification/`: `tiers.js` (the TV-14 tier), `ratings.js` (normalise + lists), `chain.js` (the pure decision chain over injected seams), `sources.js` (the real adapters), `store.js` (the SQLite `age_verdicts` table), `index.js` (public API: `tierFor`, `usesChain`, `verify`, `passesStored`).
- Only `age_limit === 14` runs the chain; every other tier keeps today's code path untouched (proven by the I1 identity test — the service is never called for 0/5/6/8/10/12/13/15).
- TVDB client: `src/services/tvdb.js` (v4, bearer token cached 25 days, one re-login on 401), paced on the governor's `tvdb` lane (≤ 5 req/s). Key: Server Config `settings.keys.tvdb_api_key` (encrypted at rest, redacted in GETs), with `process.env.TVDB_API_KEY` as a fallback read only inside the client.
- `groq.ageGate(type, age, titles, log, { tier })`: with `opts.tier`, the prompt's first two lines become the TV-14 wording and the cache key becomes `${type}:tv14:${id}` (D2's one-time re-judge); without `opts` the behaviour is byte-identical to before.
- Every decided title is recorded in `age_verdicts` (TTL 30 days for steps 0–4, 90 days for the LLM; `unknown` is never stored) and stamped on the pool row's `certification` column as `<source>:<rating>`; the serve-time re-check (`passesStored`) reads it without any network.
- Wiring: `ageGatePool` (block → hardDrop, per-source log line), `applyExtraAgeGate` (effective limit 14 → the chain; banded catalogs keep their legacy band), `handleSearch` (allow + unknown kept; any error → empty results), `passesAgeBand` (the stored verdict), and Marquee Cinema's envelope (discover ceiling `MA 15+`; the hard filter blocks only the hard floor — the pool gate makes the real age decision).
- Simkl step 4a: a batch certification lookup by IMDb id is out of scope for AGE-1 — the seam returns no answer and the chain continues to MDBList; a real Simkl source lands later.
- The portal offers **TV-14 (14+, AU M)** as age 14 with a one-line explainer; Server Config carries the TVDB key row (optional — the chain degrades without it).
- Tests: R1–R3 and C1–C4 (smoke, pure), I1–I7 (integration, every network seam stubbed), U1 (the portal option + key row + saving `age_limit: 14`).
