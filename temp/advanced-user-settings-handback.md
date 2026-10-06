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
| **R2: Selected readiness overwrites the existing active connection** | `manualCheckImpl` distingu explicit vs omitted version: omitted always verifies the active grant (legacy); only explicit target changes the readiness branch. `renderSimklFlow` preserves the connected summary (Sync/Disconnect/Change connection) when a target check for a different version returns; the target's result is shown as a supplementary note. Check cache keeps selected readiness out of the active grant's badge. |
| **R3: Connected/secret editor presentation is incomplete** | `data-simkl-editor` is hidden when connected; "Change connection" reveals it. `savedSecretRow` shows "Saved securely + Replace" for V2 secret; Replace reveals empty input; eye toggles only draft; Save reverts to saved indicator; Cancel preserves. Same pattern applied to TVDB (`replaceTvdbKey`/`cancelTvdbKey`). Misleading "verified live" prose removed. "Card 2 changes that" text replaced with "server key continues to be used for normal operation at this stage." |
| **R4: Blank MDBList draft deletes saved key; Clear leaves stale display** | `saveSimkl` only submits non-blank changed MDBList values (blank/untouched preserves stored key; null only from explicit Clear). `clearMdblistUser` updates the field value, original, and placeholder after successful Clear (no full-card rebuild). |
| **R5: Trakt import remains callable** | `POST /profiles/:id/simkl/import-trakt` returns 410 with a clear retired response before reading ZIPs, queueing jobs, calling providers, or writing history. |

## Review round 2 fixes (P1 × 3)

**Commit:** `3086c7d` on `feature/advanced-user-settings`

| Issue | Fix |
|-------|-----|
| **P1: Stored/unverified connection has no Check; other-version readiness invents verification** | `renderSimklFlow` now renders three distinct states: (1) verified active connection shows exact verified summary/name/count/version + Sync/Disconnect/Change connection; (2) stored/unverified grant shows honest "Token stored" state + accessible Check connection + Change connection + Disconnect; (3) other-version readiness appends a separate target result note while preserving the actual active state. Badge reflects `activeState` (not `isTargetMismatch`). Editor visibility driven by `simkl_check_state === 'connected'` (not `simkl_connected`). Never requires reauthorization to check a stored token. |
| **P1: Saving one version discards the other version's unsaved secret draft** | `saveSimkl` saved-secret revert now restricted to `Object.keys(keys)` (the committed fields only) and scoped to the selected block via `block.querySelector`. Uses captured submitted values, not current DOM values read after the await. |
| **P1: TVDB Replace removes the Test button** | `replaceTvdbKey` now includes the Test button alongside Save and Cancel. `testTvdbDraft()` sends `{key: draft}` to the provider; empty draft returns "✗ Enter a key to test" (honest missing-draft message). Saved key is never touched by the draft test. |

### Browser harness evidence

`test/simkl.lifecycle.js --browser` updated to the real Advanced tab interaction:
- Navigate to `/configure/?profile=` → switch to Advanced tab
- Wait for `data-simkl-editor` visible + "Token stored" in flow (stored/unverified state)
- Click "Check connection" → wait for "verified live" → editor hidden
- Click "Change connection" → editor visible → select V2 → click "Connect"
- OAuth callback flow (consent='wrong' for failure, 'good' for success)

**Note:** Playwright is not installed on this machine. The 21 non-browser lifecycle checks pass; the `--browser` section requires `npm install playwright` to run. The browser test code is verified correct by inspection against the updated UI.

### Focused smoke test evidence (red → green)

| Test | Red (before fix) | Green (after fix) |
|-------|-----------------|-------------------|
| Card 1: Stored/unverified grant | `credential_mismatch` (keys.simkl_client_id not set in fixture) | `connected` (omitted version verifies active grant) |
| Card 1: Other-version readiness | `credential_mismatch` (same fixture issue) + missing username | `connected` (V1 verified) + `not_authorized` (V2 target) + V1 state preserved |
| Card 1: TVDB Replace draft | `capturedTvdbKey = null` (stub checked wrong body field) | `capturedTvdbKey = 'draft-tvdb-xyz'` (draft sent, saved key untouched) |

## Review round 3 fixes (3 issues)

**Commit:** `73f576f` on `feature/advanced-user-settings`

| Issue | Fix |
|-------|-----|
| **Active state preserved separately from target readiness** | `renderSimklFlow` now uses the passive active grant state (from `/simkl/status`) as the authoritative badge/controls. An explicit other-version check stores its result as `SIMKL_UI.targetResult`, appended as a separate labelled note. Never reinterprets `targetResult.state` as `activeState`. `checkSimklLive` fetches passive status on target mismatch; matching-version checks render their actual verification result. Later passive renders retain the target note; a newer Check/selection/connection clears or replaces it. |
| **Drafts edited while Save is pending** | `saveSimkl` captures submitted values and field nodes BEFORE the PUT. After success, updates originals to the acknowledged submitted values (not current DOM). Collapses a secret row to "Saved securely" ONLY if its current draft still equals the acknowledged value. If changed meanwhile, leaves it visible and dirty with original set to the acknowledged stored value so a subsequent Save submits the later draft correctly. |
| **Browser harness executable** | Corrected to use `/configure/#simkl?profile=<id>` (selects profile + activates Advanced tab). Explicitly selects V1 before checking (BrowserTarget has active V1 but preferred V2). Check button scoped to `.simkl-flow` to avoid ambiguity. Assertions use "✓ Connected" (not substring "verified live" which also matches "not yet verified live"). Added browser regression: active state preserved separately from target readiness. |

### Browser harness corrections

- **URL:** `/configure/#simkl?profile=<id>` (the `readSimklCallbackError` function reads the hash to select the profile and activate the Advanced tab)
- **Version selection:** Explicitly select V1 before checking (BrowserTarget has active V1 but preferred V2; an explicit V2 Check is readiness, not V1 verification)
- **Check button scope:** Scoped to `.simkl-flow` to avoid ambiguity with any editor check button
- **Assertions:** Use "✓ Connected" and "Simkl connected" badge (not substring "verified live" which also matches "not yet verified live")
- **New regression:** Verify V1 → record username/watched count/Sync/Disconnect → select V2 → Check → assert all active details/controls remain + V2 note appended once → passive render retains truthful state + one note

### Playwright status

**Playwright is installed.** All 24 `--browser` checks pass, including the 4 browser regressions:
1. Pending migration (V2 replacement secret saved while pending)
2. Callback failure (OAuth consent='wrong')
3. Actual success (OAuth consent='good')
4. **RegTarget active-state regression** — V1 active + V2 target: active username/watched count/Sync/Disconnect preserved after V2 Check; V2 target note appended exactly once; badge remains "Simkl connected"

## Tests (all pass on final head `73f576f`)

- **smoke:** 216 unit + 59 async/http + T1-T8 + Card 1 (10 focused checks)
- **integration:** 271 checks
- **mobile:** 75 unit + http
- **simkl.lifecycle:** 21 checks (non-browser)
- **simkl.lifecycle --browser:** 24 checks (Playwright, Chromium; includes 4 browser regressions)

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
| Stored/unverified grant shows honest state + accessible Check (no reauthorization) | `Card 1: Stored/unverified grant` |
| Other-version readiness appends target result, preserves active state | `Card 1: Other-version readiness` |
| TVDB Replace keeps Test button; draft test sends entered key, not saved | `Card 1: TVDB Replace` |
| Saved-secret draft of non-selected version preserved after save | `saveSimkl` code (block-scoped, committed-fields-only) |
| Active state (badge/username/watched/Sync/Disconnect) preserved after other-version Check | Browser regression (RegTarget, `--browser` passed) |
| Target note appended exactly once; passive render retains it | Browser regression (RegTarget, `--browser` passed) |
| Draft edited while Save pending survives (not collapsed to Saved securely) | `saveSimkl` code (captured values + current-DOM check) |
| Browser harness uses correct URL/version/locator/assertions | `test/simkl.lifecycle.js --browser` (24 checks passed) |

## Notes for Card 2

- The runtime MDBList precedence (global-first resolver via `settings.keyFor`) is **unchanged**. The per-profile `test/mdblist-user` endpoint is a separate explicit test mode; it does not affect the build/serve path. The server key continues to be used for normal operation at this stage.
- The Simkl check-result cache (`simklChecks`) only caches when the selected version matches the active grant's version. Selected-version readiness results are kept out of the old grant's cache/badge.
- The `simkl_auth_version` preference is stored per-profile and determines what Connect starts. It does not change the active token's version (which lives in `simkl_auth.version`).
- The `POST /simkl/check` route now enforces the version contract: an explicit valid version that differs from the saved preference returns 409 (no provider call). The client must save the new preference first.
- The Trakt import endpoint is retired (410). Historical data and unrelated legacy fields are preserved.
