# v6 Config Architecture & UI

**Status:** DESIGN ONLY. Companion to `docs/v6-features.md` and `docs/v6-plan.md`.
Captures the global-vs-per-profile config split and the portal redesign.

---

## The real change: a global/per-profile config split

Today **everything** is per-profile — every family member re-enters TMDB,
MDBList, RPDB, and an LLM key. v6 splits config into **shared infrastructure**
(one set) and **personal identity/preferences** (per profile). This is the
architecturally significant part; the tabs are just how it's surfaced.

| Concern | Scope in v6 | Why |
|---|---|---|
| Custom LLM (name/URI/key) | **Global** | One local endpoint for the whole service. |
| Groq (cloud fallback) | **Global** | Infrastructure, not identity. One key. |
| TMDB | **Global** | A lookup/recommendations key — "single account for lookups". |
| MDBList | **Global** | Catalog + CSM lookups; one key. |
| RPDB | **Global** | Poster overlay; one key, serve-time. |
| **Simkl** (client id/secret + token) | **Per profile** | Personal watch history — each person their own account. |
| Filters | **Per profile** | Personal preference. |
| Catalogs | **Per profile** | Personal preference. |

**"Single account for lookups" clarified:** the global TMDB key is *infrastructure*
— it makes the API calls. The *data* those calls run on is still per-profile
(each profile's own Simkl watched list → its own TMDB recommendations). Shared
plumbing, personal water.

### Decisions (locked)
- **Migration — LOCKED.** On upgrade, seed the global keys from the profile
  named **"James"** (the oldest profile): its TMDB/MDBList/RPDB/Groq values
  become the global set. Surface them in Server Config, then drop the
  per-profile copies from every profile.
- **Setup gating — LOCKED, HARD BLOCK.** Profiles do nothing until Server Config
  is complete and valid. An incomplete or broken global config disables profile
  function entirely (no builds, no serving) with a clear "finish/​fix Server
  Config" state — not a silent failure.

## Rate governance & key pools (Decision 3 + the dual-account idea)

Two requests that turn out to be **one mechanism**: (a) the app must respect
every external service's limits and self-throttle; (b) allow backup/overflow
accounts. Both are solved by a **key pool + rate governor** per service.

### Key pools — DECIDED: only Groq has two keys
Simplified from the general "1..N per service" idea — the only service with a
backup slot is Groq:

| Service | Keys | Why |
|---|---|---|
| **Groq** | **primary + backup** | Free tier is the tightest bottleneck (TPM/RPM/daily). The 2nd key ~doubles headroom and gives failover on 429/exhaustion. MediaVoyager does exactly this. |
| **Custom LLM** | one endpoint | Local, no quota. Tried first, ahead of Groq. |
| **TMDB / MDBList / RPDB** | **single each** | TMDB/RPDB limits are generous; MDBList single is accepted. |
| **Simkl** | per-profile token | Personal account, not a rotatable infra key. |

So the Groq failover is `primary → backup`; no other service needs pool logic.

### Rate governor — central, per-service, limit-aware
A single module every outbound call routes through, seeded with each service's
real limits so we throttle *ourselves* before the provider does:

| Service | Known limits (build the governor around these) |
|---|---|
| Groq | ~30 RPM + per-model TPM + daily token cap; honour `Retry-After` |
| Simkl | 10 GET/s, **1 POST/s** per client_id AND per token |
| TMDB | ~50 req/s, no hard daily cap |
| MDBList | ~1000 req/day (free) |
| Jikan (MAL) | 3 req/s, 60 req/min |
| AniList | 30 req/min |
| RPDB | generous; serve-time |

Behaviour: token-bucket / sliding-window per service; queue or space requests to
stay under; on a 429 read `Retry-After` and back off; on repeated failure rotate
to the next key in the pool; surface "throttled/exhausted" state to the
diagnostics (Advanced tab). This is the piece that stops a heavy weekly
recommendation build from tripping a limit and, per Simkl's policy, getting a
client_id suspended.

**SHIPPED — v6.16.0-beta (`src/services/governor.js`).** Central per-service
pacing via `schedule(service, fn)`: a synchronous slot-reservation queue spaces
concurrent callers by each service's min-interval (tmdb ~40/s, simkl_get ~8/s,
**simkl_post <1/s** — the hard write cap, mdblist ~4/s + daily counter, jikan
~57/min, groq ~28/min). A 429 sets a backoff window honouring `Retry-After` that
pushes subsequent slots out. Wired into every governed fetch: tmdb `get`, simkl
`authedGet`/`addToHistory`, mdblist list + `mediaInfoBatch`, MAL/Jikan, and the
Groq leg of the LLM chain (the local Custom LLM is NOT paced). Groq **key
rotation** stays in the LLM chain (custom → primary → backup), so the governor
only paces. Not a retry layer — callers keep their own error handling; a 429
still surfaces, the governor just makes the NEXT call wait. Stats exposed at
`GET /api/governor` (calls, today vs daily cap, backoff state) for the Advanced
tab. Auto-retry-after-backoff is a possible future enhancement.

---

## Portal structure

```
┌─ Top bar ────────────────────────────────────────────────┐
│  [ Profile ▼ ]   [ + Add profile ]      [ Server Config ] │
└──────────────────────────────────────────────────────────┘
```

- **Profile selector** lists all profiles. **No profiles → only "Add profile."**
- **Server Config** entry always present. **Not yet set up → "Setup new server."**

### Server Config (global) page
1. **LLM** — the full inference chain, all global:
   - **Custom LLM** — name, URI, API key, **Test** button. Disclaimer: *must
     support OpenAI v1 (`/chat/completions`) standards.* Test = live validation
     (see below). Tried **first** when configured.
   - **Groq primary** — cloud fallback #1.
   - **Groq backup (resilience)** — cloud fallback #2, used on primary 429/
     exhaustion.
   - Effective order: **Custom → Groq primary → Groq backup.**
2. **API keys** — TMDB, MDBList, RPDB. Each a **single** key (decided). Same
   rules as today: **test before save**, masked password field with an **eye
   toggle** to reveal.

### Profile page — TABS (replacing the show/hide accordions)
Five tabs (the note said "4" but listed five — Simkl, Filters, Catalogs,
Install, Advanced):

1. **Simkl** — client id/secret, **Connect** button, and a **live connection
   status**. **Tested on tab open against Simkl**, not read from stored state
   (see the bug below).
2. **Filters** — the per-profile filter set.
3. **Catalogs** — the catalog selector.
4. **Install** — the manifest URL to copy, plus install-in-Nuvio/Stremio.
5. **Advanced** *(new)* — diagnostic button, rebuild-catalog button, delete
   profile, and **view Recommended Movies / Recommended Shows** (read-only dump
   of the F5 recommendation table for debugging).

---

## The live-status fix (important — a real bug today)

James's observation: *"they all show as connected when the [Trakt] apps have
been deleted and are all invalid."* The current portal trusts **stored** state
("we have a token") and never re-verifies. v6 must fix this as a principle:

- **Connection status is derived from a live authenticated call, never from
  stored state.** On opening the Simkl tab, fire a cheap authed request (e.g.
  `/sync/activities` or `/users/settings`); green only if it actually returns
  200. A stored token that the provider has since invalidated shows **red**.
- Same spirit for the global key Tests — they hit the real API, not a format
  check.

This also means "connected" can degrade to "reconnect needed" on its own when a
provider revokes access — exactly what didn't happen with Trakt.

---

## The Custom LLM test (what "Test" actually runs)
Not just a ping — it must prove the endpoint can do *our* work, because local
models vary wildly in JSON reliability (the lesson from the gpt-oss
`json_validate_failed` saga):

1. **OpenAI-shape check** — POST `{URI}/chat/completions` with `model={name}` and
   a trivial message; require a well-formed `choices[0].message.content`.
2. **Our JSON tasks** — run a mini generation prompt (expect a parseable
   `[{title,year}]`) and a mini age-gate prompt (expect a parseable
   `[{id,ok}]`), validated through our existing `parseTitles` / `parseVerdicts`.
   This is what proves it's usable, not merely reachable.
3. Pass all → enable it (custom-first, Groq-fallback). Fail any → show which
   check failed, don't save.

---

## Resolved this round
- Migration seeds global keys from the **"James"** profile (oldest). LOCKED.
- Server Config incomplete/broken → **hard block** on all profile function. LOCKED.
- Key pools → **Groq primary + Groq backup only**; TMDB/MDBList/RPDB single each.
  Global LLM chain: **Custom → Groq primary → Groq backup.** LOCKED.
- Every service gets a **rate governor** with its real limits; self-throttle +
  backoff + key rotation. LOCKED.

## Still open
1. Confirm **Groq-as-global-fallback** placement in Server Config (implied yes).
2. Confirm the **global set** = {Custom LLM, Groq, TMDB, MDBList, RPDB} and the
   **per-profile set** = {Simkl, Filters, Catalogs}.
