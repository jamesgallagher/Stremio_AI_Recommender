# Card 1 — Advanced user settings and credential usability

**Branch:** `feature/advanced-user-settings`
**PR:** [#37](https://github.com/jamesgallagher/Stremio_AI_Recommender/pull/37) → `v7`
**Version:** 7.40.0-beta

## Scope

| File | Changes |
|------|---------|
| `public/index.html` | Advanced tab layout (User Settings, Simkl Integration, API Keys); V1/V2 selector; MDBList key row; TVDB key row; `collectSettings` omits blank TVDB; `saveSimkl` one-PUT with selected version fields + field-original update + saved-secret revert; `toggleSimklVersion`; `revealSimklEditor` shows hidden editor; `testMdblistUser`; `clearMdblistUser` updates field display; `checkSimklLive` saves before check + stale-result guard; `renderSimklFlow` preserves active connection on target mismatch; `savedSecretRow`/`replaceSecret`/`cancelSecret` for V2 secret; `tvdbKeyRow` saved/replacement pattern; `replaceTvdbKey`/`cancelTvdbKey`; `data-simkl-editor` hidden when connected; removed Simkl tab, Trakt import, `importTrakt`/`uploadTraktZip`; Filters default/first |
| `src/config.js` | `updateProfile` email normalization (trim + lowercase) + cross-profile uniqueness check (throws on conflict) |
| `src/portal.js` | `PUT /profiles/:id` → 409 on email conflict; `POST /profiles/:id/test/mdblist-user` (per-profile key test, registered before `test/:service`); `POST /profiles/:id/simkl/check` with version validation (400 invalid, 409 preference mismatch, target_version in response); `POST /profiles/:id/simkl/import-trakt` → 410 retired; `POST /settings/test/:service` TVDB `use_saved` mode; mask guard on `PUT /settings` |
| `src/services/simkl.js` | `manualCheck`/`manualCheckImpl` with explicit-vs-omitted version distinction (omitted preserves legacy active-grant verification; only explicit target changes readiness branch) |
| `mobile/test/mobile.smoke.js` | Ambiguous OTP test uses direct store manipulation (simulating preexisting duplicates) |
| `test/smoke.js` | Card 1 focused tests: email uniqueness, Simkl V1/V2 visibility/check targeting/400 invalid version/409 preference mismatch/secret non-leak, connected V2 summary, V1 grant survival, MDBList user key (personal vs global, blank draft preserves key), Trakt import 410, TVDB test/save/reload/test/mask guard |
| `test/integration.js` | TVDB key row expectation updated to `tvdbKeyRow` |
| `package.json` | Version 7.40.0-beta |

## Review fixes (R1–R5)

| Issue | Fix |
|-------|-----|
| **R1: Check does not save the selected configuration or enforce its contract** | `checkSimklLive` now calls `saveSimkl` first (single coherent PUT, stops on failure, hidden drafts excluded, field originals updated). `POST /simkl/check` validates version (400 for invalid, 409 for preference mismatch with no provider call), returns `target_version`. Stale-result guard discards results if selection changed while awaiting. |
| **R2: Selected readiness overwrites the existing active connection** | `manualCheckImpl` distinguishes explicit vs omitted version: omitted always verifies the active grant (legacy); only explicit target changes the readiness branch. `renderSimklFlow` preserves the connected summary (Sync/Disconnect/Change connection) when a target check for a different version returns; the target's result is shown as a supplementary note. Check cache keeps selected readiness out of the active grant's badge. |
| **R3: Connected/secret editor presentation is incomplete** | `data-simkl-editor` is hidden when connected; "Change connection" reveals it. `savedSecretRow` shows "Saved securely + Replace" for V2 secret; Replace reveals empty input; eye toggles only draft; Save reverts to saved indicator; Cancel preserves. Same pattern applied to TVDB (`replaceTvdbKey`/`cancelTvdbKey`). Misleading "verified live" prose removed. "Card 2 changes that" text replaced with "server key continues to be used for normal operation at this stage." |
| **R4: Blank MDBList draft deletes saved key; Clear leaves stale display** | `saveSimkl` only submits non-blank changed MDBList values (blank/untouched preserves stored key; null only from explicit Clear). `clearMdblistUser` updates the field value, original, and placeholder after successful Clear (no full-card rebuild). |
| **R5: Trakt import remains callable** | `POST /profiles/:id/simkl/import-trakt` returns 410 with a clear retired response before reading ZIPs, queueing jobs, calling providers, or writing history. |

## Tests (all pass)

- **smoke:** 216 unit + 59 async/http + T1-T8 + Card 1 (7 focused checks)
- **integration:** 271 checks
- **mobile:** 75 unit + http
- **simkl.lifecycle:** 21 checks

## Card 1 acceptance coverage

| Acceptance criterion | Test |
|----------------------|------|
| Filters default, Advanced last, correct heading order, no Simkl tab/Trakt import | HTML assertions in Card 1 Simkl test |
| Email whitespace/case variants conflict (409) | `Card 1: Email uniqueness` |
| Same-profile save succeeds | `Card 1: Email uniqueness` |
| Blank legacy email remains usable | `Card 1: Email uniqueness` |
| Failed update preserves all other fields (atomic) | `Card 1: Email uniqueness` |
| V1/V2 visibility (both blocks present) | `Card 1: Simkl V1/V2` |
| Check targeting: 409 preference mismatch (no provider call) | `Card 1: Simkl V1/V2` |
| Check targeting: 400 invalid version | `Card 1: Simkl V1/V2` |
| Check with no grant (missing_configuration) | `Card 1: Simkl V1/V2` |
| Actionable missing fields | `Card 1: Simkl V1/V2` |
| No hidden-credential mutation (secret not returned) | `Card 1: Simkl V1/V2` |
| Connected V2 summary (connected, active version, username) | `Card 1: Connected V2 summary` |
| Existing V1 grant survives failed V2 attempt | `Card 1: Connected V2 summary` |
| Personal MDBList draft/saved Test sends personal key (not global) | `Card 1: MDBList user key` |
| MDBList missing key reports missing | `Card 1: MDBList user key` |
| MDBList conflicting modes rejected | `Card 1: MDBList user key` |
| MDBList blank draft preserves stored key | `Card 1: MDBList user key` |
| Trakt import retired (410) | `Card 1: Trakt import retired` |
| TVDB Test → Save → Test → Reload → Test (identical full key) | `Card 1: TVDB Server Config` |
| Unsaved replacement does not overwrite saved key | `Card 1: TVDB Server Config` |
| No mask reaches provider | `Card 1: TVDB Server Config` |
| Mask guard on PUT /settings | `Card 1: TVDB Server Config` |
| Existing auth lifecycle and Companion tests remain green | All suites pass |

## Notes for Card 2

- The runtime MDBList precedence (global-first resolver via `settings.keyFor`) is **unchanged**. The per-profile `test/mdblist-user` endpoint is a separate explicit test mode; it does not affect the build/serve path. The server key continues to be used for normal operation at this stage.
- The Simkl check-result cache (`simklChecks`) only caches when the selected version matches the active grant's version. Selected-version readiness results are kept out of the old grant's cache/badge.
- The `simkl_auth_version` preference is stored per-profile and determines what Connect starts. It does not change the active token's version (which lives in `simkl_auth.version`).
- The `POST /simkl/check` route now enforces the version contract: an explicit valid version that differs from the saved preference returns 409 (no provider call). The client must save the new preference first.
- The Trakt import endpoint is retired (410). Historical data and unrelated legacy fields are preserved.
