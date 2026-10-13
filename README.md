# AI Recommender — Stremio/Nuvio addon

Self-hosted, per-family-profile recommendations for movies, series and (opt-in)
anime. Each person's **Simkl** watch history drives a taste model; a local or cloud
LLM and TMDB do the matching; and the results are served from a pre-built cache, so
opening a catalog in Stremio/Nuvio is instant and never waits on an API.

- **Quality over volume.** Fewer, better picks: a rating-weighted taste model, an
  LLM fit pass, and a served genre mix calibrated to what that person actually likes.
- **Built for a family.** Per-profile Simkl accounts and filters, a multi-source
  **age gate** for kids' profiles (fail-closed on lists, extra catalogs and search),
  and a phone **Companion** app.
- **Failure = stale, never empty.** Builds run in the background, are staged and
  verified before they replace the live list, and back off on error.

Current version: see `package.json` (v7 line, stable on `main`).
How it works inside: [docs/architecture.md](docs/architecture.md).

## What you get

| Surface | What it is |
|---|---|
| **Catalogs** in Stremio/Nuvio | *Recommended for you* — Movies, Series, and Anime (opt-in); *Watch Later* (your Simkl plan-to-watch); optional curated lists |
| **Addon `meta` + search** | The addon serves its own metadata and TMDB search, age-gated for kids profiles, so a kid's device needs only this addon plus a stream addon |
| **Configure portal** (`/configure/`) | Admin: profiles, Server Config, filters, catalogs, ratings trainer, auto-scrobble, install URL, diagnostics |
| **Mobile Companion** (`/mobile/`) | Installable phone app for every family member: recommendations, search → Watch Later, mark watched / not interested, rate your history, personal settings — see [mobile/README.md](mobile/README.md) |

### Engines

Each profile has one engine per lane. Movies and Shows are mandatory; Anime is
**off** until enabled for a profile.

| Lane | Engine | Design |
|---|---|---|
| Movies | **Marquee Cinema** | [docs/engine-marquee](docs/engine-marquee/README.md) |
| Series | **Marquee TV** | [docs/engine-marquee-tv](docs/engine-marquee-tv/00-design-spec.md) |
| Anime | **Marquee Anime** | [docs/engine-marquee-tv](docs/engine-marquee-tv/00-design-spec.md) |

Taste is trained from Simkl ratings, finished/abandoned engagement, and the
**Ratings** trainer (rate, love, or ignore watches; see
[docs/trainer](docs/trainer/00-design-spec.md)).

### Extra catalogs (per profile, Catalogs tab)

| Catalog | Notes |
|---|---|
| **Watch Later** (default on) | Mirrors the Simkl plan-to-watch list in your order; keeps watched titles you queued; hides titles not yet streamable until they are ([details](docs/watch-later-availability.md)). Needs Simkl |
| Popular Movies / Series, Trending Kids Movies / TV, Anime TV-14 | Curated MDBList charts; Filter Gate applies the profile's filters ([details](docs/filter-gate.md)) |
| Comedy, Action, Rom-Com, War, Horror, Thriller, Christmas | Curated genre lists, IMDb ≥ 6 |

Extra catalogs need an MDBList key (personal or global). On age-limited profiles
every catalog passes the age gate.

## Run

**Docker / Unraid** (published by CI on every push to `main`):

```bash
docker compose up -d
```

Image: `ghcr.io/jamesgallagher/stremio_ai_recommender` (`linux/amd64`, `linux/arm64`).
`:latest` follows `main`; a git tag `vX.Y.Z` also publishes `:X.Y.Z`, `:X.Y`, `:X`;
prerelease tags (`vX.Y.Z-beta`) publish `:X.Y.Z-beta` and `:beta` only and can never
move `:latest`. To build locally, swap `image:` for `build: .` in `docker-compose.yml`.

Map `/data` to persistent storage (e.g. `/mnt/user/appdata/ai-recommender`). It holds
`profiles.json`, `settings.json`, `store.db` and the caches.

**Local dev** (Node ≥ 22):

```bash
npm install
npm start          # http://localhost:7000/  → redirects to /configure/
npm test
```

## First run

1. Start the container. With no profiles yet, the log prints a one-time setup token:
   `[setup] Setup token: …`.
2. Open `/mobile/`, enter your name, email and that token. The emailed 6-digit code
   creates the first (admin) account. (Without SMTP configured, codes are written to
   the container log — dev only.)
3. Click **Configure** in the Companion's top bar to open `/configure/`.
4. **Server Config** (top bar) — shared infrastructure, entered once:
   - **LLM**: a custom OpenAI-compatible endpoint (tried first; the **Test** button
     checks it can do this app's JSON tasks) and/or a **Groq** key, plus an optional
     Groq backup key. At least one provider is required.
   - **TMDB** key — required.
   - Optional: **MDBList** (curated catalogs, IMDb ratings), **RPDB** (ratings on
     posters; pre-set to RPDB's generic free key), **TVDB** (country certifications for
     the age gate), **MyAnimeList** client id and **AniDB** client (anime age ratings).
   - Profiles do nothing until Server Config has TMDB + one LLM provider.
5. **Add profile** for each family member, then per profile:
   - **Simkl**: create an app at [simkl.com/settings/developer](https://simkl.com/settings/developer),
     enter its Client ID/Secret, and **Connect**. Two auth versions — see below.
   - Set **Filters** (rating floor, release year, vote floor, excluded genres, list
     size, optional age limit) and **Catalogs**.
   - Copy the **Install** URL into Stremio/Nuvio → Addons.
6. The first list builds within a few minutes (a "warming up" card shows until then),
   then refreshes in the background: daily if watch history changed, weekly regardless.

## Simkl

Simkl is the watch-history source. Each profile uses its own Simkl app and account.

| | AUTH V2 (default for new profiles) | AUTH V1 (legacy) |
|---|---|---|
| Flow | OAuth authorization code + PKCE (S256); tokens refresh automatically | PIN device flow at `simkl.com/pin`; long-lived tokens |
| App type to register | **Server apps & services** | existing legacy registrations |
| Callback URI | `{EXTERNAL_URL}/simkl/oauth2/callback` | — |
| Scope | `media:read media:write` | — |

- The V2 callback is built **only** from a valid HTTPS `EXTERNAL_URL` — there is no
  Host-header fallback. Without it, V2 Connect is unavailable (the portal says so).
  The URI registered on the Simkl app must match exactly.
- The V2 Client Secret is never sent back to the browser; the field is replace-only.
- The **Auth version** dropdown chooses which flow *Connect* starts; it does not
  change the active token. **Check connection** verifies the grant live and returns a
  state such as `connected`, `not_authorized`, `credential_mismatch`, `rate_limited`
  or `provider_unavailable`. Only `connected` is a success badge. Reauthorising
  keeps the existing grant until the new account is verified.
- Simkl's API rules (activities-first sync, delta pulls, 1 POST/s) are enforced in
  code — see [docs/architecture.md](docs/architecture.md#7-external-services-and-rate-rules).

## Kids mode (age gate)

Per profile, **Limit to age** picks a tier: **10+, 12+, 14+ (TV-14), 15+**. Titles are
judged through a chain that stops at the first source with an answer: hard floor →
Common Sense → Australian rating → US rating → Simkl / MDBList / UK·IE·NZ·CA / TVDB →
**LLM last**. Anime has its own chain (MyAnimeList band, Kitsu, AniDB, then the LLM).

- Covers AI lists, every extra catalog, and **search** (Stremio and the Companion).
  `meta` is deliberately ungated; discovery already is.
- **Remove-only and fail-closed.** If the gate can't run, the previous list is kept
  and search returns nothing. A title the LLM leaves unjudged is re-asked once, then
  dropped. Age-limited profiles only serve rows something positively vetted.
- An adult-content blacklist (Rx / Hentai / Erotica) applies to every profile on
  every surface.
- On age-limited profiles, rating floor, release year, excluded genres and the Anime
  switch are **parental controls**: editable in the admin portal, read-only on the
  phone.

## Auto-scrobble (Nuvio / Stremio → Simkl)

Optional, per profile. Mirrors a person's **Nuvio** or **Stremio** watched history
into their Simkl account hourly, so "mark as watched" in the player reaches Simkl
even when the app's own sync silently fails. Set it up in the **Scrobble** tab: pick
the app, enter that person's account email + password, **Test** (Nuvio lists the
account's profiles — pick the right one), **Save**, enable. Passwords are sealed at
rest and refused outright if `SECRET_KEY` is unset. Any error logs a warning and
changes nothing. Uses the apps' own undocumented sync backends
(overridable: `NUVIO_API_URL`, `NUVIO_ANON_KEY`, `STREMIO_API_URL`).

## Configuration

All API keys are entered in the web UI (Server Config / per profile) and stored in
`DATA_DIR`. **Nothing secret belongs in the image or the repo.** Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `EXTERNAL_URL` | — | Public HTTPS base URL (your tunnel hostname). Used in install URLs, the manifest logo, the Simkl V2 callback and sign-in emails. **Required for real use** |
| `SECRET_KEY` | — | Encrypts every stored secret at rest (AES-256-GCM) and keys the sign-in code hash. **Recommended.** Keep it off the `/data` volume and back it up — see below. `SCROBBLE_KEY` is a legacy alias |
| `PORT` | `7000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Persistent storage |
| `TRUST_PROXY` | `1` | Proxy hops in front of the app (Cloudflare Tunnel = 1). A number, CIDR list, or `false`; don't use `true` |
| `STALE_HOURS` | `24` | Cache staleness threshold |
| `BACKOFF_MINUTES` | `30` | Wait after a failed rebuild |
| `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY` | — | Brevo SMTP relay credentials for sign-in codes. Unset → codes go to the log (dev only) |
| `BREVO_SMTP_HOST`, `BREVO_SMTP_PORT` | `smtp-relay.brevo.com`, `587` | `465` = implicit TLS |
| `MOBILE_MAIL_FROM`, `MOBILE_MAIL_FROM_NAME` | — , `AI Recommender` | Verified sender address and display name |
| `MOBILE_INSECURE_COOKIE` | — | `1` drops the cookie `Secure` flag for bare-HTTP LAN testing only |
| `GROQ_MODELS` | built-in | Comma-separated Groq model fallback chain, best first |
| `GROQ_TIMEOUT_MS`, `CUSTOM_LLM_TIMEOUT_MS`, `MARQUEE_LLM_TIMEOUT_MS` | `8000`, `25000`, per-engine | LLM call timeouts |
| `TVDB_API_KEY` | — | Fallback for the TVDB key (prefer Server Config) |
| `MARQUEE_TRENDING_TTL_MS`, `MARQUEE_SIMKL_RECS_TTL_MS`, `IMDB_RATING_TTL_MS`, `SIMKL_CDN_BASE` | 6 h, 30 d, 14 d, Simkl CDN | Cache/endpoint tuning |
| `AGEGATE_DEBUG_PROMPT` | — | `1` logs age-gate LLM prompts (debugging) |

`ADMIN_USER` / `ADMIN_PASSWORD` are **no longer used** — `/configure/` sits behind the
shared email sign-in (admin profiles only). Remove them if still set.

### Encryption at rest

With `SECRET_KEY` set, all stored secrets (Server Config keys, per-profile keys and
Simkl tokens, scrobble passwords) are encrypted in `profiles.json` / `settings.json`;
existing plaintext is encrypted in place on the next start. If the files hold
ciphertext and the key is missing or wrong, the app enters **locked mode**: it keeps
serving cached lists, refuses all edits, and shows a red banner — so it can never
overwrite your encrypted data. Restore the key and restart to recover. Losing the key
means re-entering keys and reconnecting Simkl; your watch history is untouched.

## Unraid

Docker tab → **Add Container** (or point a Compose stack at `docker-compose.yml`).

| Field | Value |
|---|---|
| Repository | `ghcr.io/jamesgallagher/stremio_ai_recommender:latest` |
| Network / restart | `bridge` / `unless-stopped` |
| Port | `7000` → `7000` (point your tunnel here) |
| Path | `/data` → `/mnt/user/appdata/ai-recommender` (**required**; back it up) |
| Variables | `EXTERNAL_URL`, `SECRET_KEY`, and the `BREVO_*` / `MOBILE_MAIL_FROM` set |
| Icon | `https://raw.githubusercontent.com/jamesgallagher/Stremio_AI_Recommender/main/public/logo.png` |

**Permissions.** The container runs as the unprivileged `node` user (uid 1000). Make
the appdata folder writable: `chown -R 1000:1000 /mnt/user/appdata/ai-recommender`
once, or add `--user 99:100` (nobody:users) to *Extra Parameters*. If it can't write,
the app stops at start-up and says so.

## Exposure (Cloudflare Tunnel)

Point the tunnel at `http://<host>:7000` and set `EXTERNAL_URL` to the tunnel hostname.

- `/addon/*` must be reachable **without** auth (Stremio can't log in). Profile install
  tokens are unguessable 128-bit values, redacted from request logs.
- `/configure/` and `/api/*` need an admin session; `/mobile/*` needs any profile's
  session. Optionally layer Cloudflare Access on top.
- Sign-in codes: valid 60 minutes, 5 wrong tries, 5 requests per email per hour.
  Sessions last 30 days.

## Troubleshooting

- **"I've watched that!"** The addon only excludes what Simkl knows. A watched tick in
  the player usually comes from the app's *local* state. Check the player's Simkl
  sync, or enable Auto-scrobble.
- **A list looks short.** Heavily filtered profiles (narrow genres + high rating +
  short recency + age limit) can exhaust the pool; relax a filter. Calibrated serving
  under-fills a genre rather than padding it with weak picks.
- **A catalog didn't appear after enabling it.** Nuvio re-reads manifests on launch
  (quit and reopen); in Stremio open the install URL again and press Install.
- **Pages say "locked".** `SECRET_KEY` is missing or wrong — see Encryption at rest.
- **Logs.** `docker logs ai-recommender`; the Advanced tab shows build progress and
  `GET /api/governor` shows rate-limit state.

## Project layout

```
src/            server, portal API, addon routes, engines/, ageVerification/, filterGate/, services/
public/         Configure portal (single-page, vanilla JS)
mobile/         Companion: server/ (auth, handlers), public/ (PWA), test/
test/           offline suites + manual live-API gates (verify-*-live.js)
scripts/        bench / backtest / admin tools
docs/           architecture + engine & feature design specs
```

## Credits

Early prompt constraints and TMDB resolution fallbacks were adapted from
[rocsx/stremiorecomendacion](https://github.com/rocsx/stremiorecomendacion).
Anime id mapping uses [Fribb's anime-lists](https://github.com/Fribb/anime-lists).
