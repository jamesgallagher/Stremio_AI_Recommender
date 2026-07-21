# AI Recommender — Stremio/Nuvio addon

Self-hosted, per-family-profile movie & series recommendations. Trakt watch
history → Groq → TMDB resolution, served from a disk-backed cache that
refreshes in the background (stale-while-revalidate, 24 h threshold).

Every catalog open is instant — Stremio only ever reads the pre-computed cache.
Rebuilds happen in the background and never purge a good list on failure.

> ## ⚠ v4.0.0-beta — Trakt-powered engine (THIS BRANCH ONLY)
>
> Everything in this block applies to the `v3-phase1` beta branch, published
> as `:4.0.0-beta` (also `:beta`) — the stable `:latest` image (v2.6.x) is
> unaffected.
>
> - **Trakt recommends, code filters, LLM guards.** The AI lists now come
>   from Trakt's own personalized `/recommendations` (collaborative filtering
>   over your entire history; watched excluded at source, watchlisted items
>   excluded so Watch Later isn't duplicated). Every profile filter — rating
>   floor, statuses (no unreleased movies, no canceled shows), genre/Anime
>   exclusions, recency, vote floor — is enforced locally and
>   deterministically. Lists are steadier day-to-day and improve as you watch.
> - **Ratings default to Trakt's own 0–10** (60% = 6.0 floor; new-profile
>   default 6.0); IMDb via MDBList remains an option. Recency defaults to all
>   years (one-time migration relaxes existing profiles; re-tighten in the
>   portal if wanted).
> - **The LLM is now only the kids age goalkeeper**: for profiles with an age
>   limit, after the strict CSM gate, Groq reviews the list against
>   Australian (ACB) standards and can only REMOVE titles. **Groq key is
>   required only for kids profiles** — adult pipelines make zero LLM calls.
> - **Bench + promote-on-watch**, Watch Later (Trakt watchlist) catalog,
>   "Anime" exclusion filter, curated MDBList extras, auto-scrobble, RPDB,
>   and encryption all carry over unchanged.
> - **Superseded v2 behavior notes below:** fill-to-quota LLM rounds, the
>   rolling avoid-list ("Fresh picks daily"), and generation-prompt details
>   no longer apply on this branch.

## Run

**Docker (Unraid):**

```bash
docker compose up -d
```

Images are built by GitHub Actions on every push to `main` and published to
`ghcr.io/jamesgallagher/stremio_ai_recommender:latest` (amd64 + arm64). To pin
a version, push a git tag (`git tag v1.0.0 && git push origin v1.0.0`) and use
the `:1.0.0` image tag. Build locally instead with `docker compose up -d --build`
(swap `image:` for `build:` in the compose file).

Map `/data` to persistent storage (e.g. `/mnt/user/appdata/ai-recommender`) —
it holds `profiles.json` (keys + tokens) and the recommendation caches.

**Local dev:**

```bash
npm install
npm start          # http://localhost:7000/configure/
```

## Setup (per family member)

Each profile carries its own full key set — nothing is shared.

1. Open the portal (`/configure/`) → **Add profile**.
2. That family member creates, under **their own accounts** (each key field in
   the portal has a "get key" link to the right page):
   - a Trakt API app at
     [app.trakt.tv/settings/advanced?mode=media](https://app.trakt.tv/settings/advanced?mode=media)
     → Client ID + Secret (redirect URI: `urn:ietf:wg:oauth:2.0:oob`, enable
     the device code grant)
   - a TMDB API key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)
   - a Groq API key at [console.groq.com/keys](https://console.groq.com/keys)
     (free tier). **Required only for kids profiles** (age limit set) — it
     powers the AI age check; adult profiles never call the LLM (v4 beta)
   - an MDBList API key at [mdblist.com/preferences](https://mdblist.com/preferences/)
     (free; sign in → Preferences → API Access) — powers the extra catalogs
     and Common Sense age checks
   - RPDB (rating-on-poster artwork) works out of the box — every profile is
     pre-set with the generic free-tier key (`t0-free-rpdb`). Optionally paste
     a personal key from [ratingposterdb.com](https://ratingposterdb.com/) for
     higher tiers. Applied at serve time; changes need no rebuild.
3. Paste the keys into the profile card → **Save keys** (each has a Test button).
4. **Connect Trakt** → enter the PIN at trakt.tv/activate while signed in as
   that member's Trakt account. Tokens auto-refresh from then on.
5. Set filters if wanted (min rating, recency window, genre exclusions —
   v4 defaults: Trakt rating ≥6.0, all years, none excluded).
6. Copy the install URL from the card into Stremio/Nuvio → Addons.
   Two catalogs appear: **Movies recommended for you** and
   **Series recommended for you**.

First list generates within a minute or two (a "warming up" card shows until
then). After that, lists refresh in the background roughly daily.

## Extra catalogs (curated MDBList lists)

Per profile, in the portal's **Catalogs** section: the two AI catalogs are
always on; six optional catalogs can be toggled per profile, each appearing
as its own catalog in Stremio/Nuvio:

- **Popular Movies** / **Popular Series** — the JustWatch streaming charts
  (unfiltered, 20 titles).
- **Christmas / Comedy / Action / Thriller Movies** — curated lists, 20
  titles each; anything rated below **IMDb 6** is dropped and the list is
  paged further until 20 titles are collected.

Each extra catalog's 20 titles are **shuffled on every rebuild**, so the order
looks fresh day to day and different titles rotate into the top slots.

Rules: extra catalogs **ignore watched status** (only the AI catalogs exclude
what you've seen), refresh on the same daily cadence, are served from cache,
and need the profile's **MDBList API key**. Newly enabled catalogs build in
the background when you hit Save (or on first request); they show up in the
app once it refreshes the addon manifest. To force that without removing the
addon: **Nuvio** re-fetches every installed manifest on launch, so fully quit
and reopen the app (browser: reload the tab); **Stremio** updates an addon
in place when you open its install URL again and press Install — same URL,
nothing is removed, settings and ordering are kept.
Kids-mode age limits still apply to extra catalogs — the Common Sense gate
cannot be bypassed by toggling on a chart list.

## Auto scrobble (Nuvio / Stremio → Trakt)

Optional, per profile. Mirrors a person's **Nuvio** or **Stremio** watched
history into their Trakt account hourly — so "mark as watched" and plays made
in the app reach Trakt even when the app's own Trakt session silently drops
(a real failure mode: both apps swallow Trakt write errors, so watched titles
drift out of Trakt and leak back into recommendations).

Set it up in the profile's **Auto scrobble** section: pick the source app,
enter that person's **account email + password**, hit **Test** (for Nuvio this
lists the account's profiles — pick which one feeds this recommender profile),
then **Save** and tick the enable box. The reconcile runs on the hourly tick:
it pulls the app's watched list, diffs against what Trakt already has, and
pushes only the missing plays using this profile's own Trakt token — so newly
watched items disappear from recommendations within the hour.

- **Per account, isolated.** Credentials are stored per profile and pushed only
  to that profile's own Trakt token — one Nuvio login shared across profiles is
  fine, because each binds to a specific Nuvio profile. Picking the wrong Nuvio
  profile would mix in someone else's history, so the picker is explicit.
- **Passwords are encrypted at rest** (AES-256-GCM) with the `SECRET_KEY`
  env var — never plaintext, and refused entirely if that key isn't set.
- **Fail-closed.** Any provider/Trakt error logs a warning and changes nothing.
- **Stremio series (v1):** the last-watched episode is scrobbled — enough to
  register the show in Trakt history and exclude it from recommendations.
  Nuvio scrobbles full per-episode history. Stremio has no sub-profiles, so its
  one account maps straight to the recommender profile.
- Uses the apps' own sync backends (undocumented); overridable via
  `NUVIO_API_URL` / `NUVIO_ANON_KEY` / `STREMIO_API_URL` if they ever change.

## Encryption at rest

Set `SECRET_KEY` (any long random string) and **every stored secret is encrypted
at rest** with AES-256-GCM: all per-profile API keys, the Trakt OAuth tokens, and
Auto-scrobble passwords. Only `profiles.json` on disk is encrypted — everything in
the running app stays plaintext, so there's no behaviour change. The profile
install token is deliberately left plaintext (it's a capability URL that has to be
served and is already in your install links).

- **Transparent + automatic.** On the first start after you set `SECRET_KEY`,
  existing plaintext secrets are encrypted in place. Nothing else to do.
- **Keep the key off `/data`.** Set it as a container environment variable, not
  in a file on the mapped volume — that's what makes a leaked `profiles.json`
  backup worthless without the key.
- **Back the key up** (password manager). If you lose it, the encrypted secrets
  can't be recovered — you'd re-enter API keys and re-authorize Trakt per profile.
- **Locked mode (fail-safe).** If the file holds encrypted secrets but the key is
  missing or wrong at start-up, the addon enters **locked mode**: it keeps serving
  cached recommendations, but refuses all profile edits and shows a red banner —
  so it can never overwrite the encrypted data. Restore the correct key and
  restart to recover fully, with no data loss.

Losing or changing the key is the one real risk — it doesn't touch your
Nuvio/Stremio/Trakt data, but a mismatched key means re-setting up the addon's
own keys. This is a helper addon, so worst case is re-entry, never lost history.

## Kids mode (Common Sense age limit)

Per profile: tick **Limit to age** in Filters and pick a tier (5+, 6+, 8+,
10+, 12+, 13+, 15+ — granular at the younger end). Uses that profile's
MDBList API key. Lookups are batched (one request per ~50 titles) and cached
on disk for 30 days — including "not rated" results — so even refill-heavy
kids rebuilds stay well inside the free tier's 1,000 requests/day.

Strict by design: with an age limit set, **every** candidate title is checked
against Common Sense Media (via MDBList) at rebuild time. Titles CSM hasn't
rated are never listed — there is no fallback to MPAA/TMDB certifications or
any other rating system. The Groq prompt is also steered toward
age-appropriate content, but the CSM check is the enforcement. If MDBList
lookups fail mid-rebuild, the previous list is kept rather than serving an
unverified one.

## Behavior notes

- **Cold start:** with fewer than 3 watched titles, the list comes from TMDB
  discover ("popular picks") using the same filters — no Groq. Once history
  exists, the next rebuild upgrades to personalized ("picked for you").
- **De-dupe guarantee:** everything ever watched on Trakt (even one episode of
  a show) is excluded, matched on canonical IMDb/TMDB IDs after resolution —
  not on title text. IMDb matching is cross-type: a title Trakt logged as a
  movie can't appear in the series catalog either. Between daily rebuilds, a
  cheap hourly watched-set refresh prunes newly-watched titles from the served
  list, so items you just watched disappear within the hour.
- **"But I've watched that!" troubleshooting:** the addon can only exclude
  what Trakt knows. If your player (Stremio/Nuvio) shows a watched tick on a
  listed item, the tick usually comes from the app's *local* watched state —
  the play was never scrobbled to Trakt (Trakt integration off, watched <80%,
  or the app is signed into a different Trakt account than this profile).
  Check with `GET /api/profiles/<id>/diagnose` (admin-authed): it fetches your
  live Trakt watched list and flags every listed title against it. Items
  flagged `in_trakt_watched: false` are invisible to the addon until they land
  in Trakt history — verify at trakt.tv → your profile → History.
- **Fresh picks daily:** each profile keeps a rolling history of recently
  listed titles (last 150 per catalog) and asks Groq to avoid them, so the
  daily rebuild rotates in new recommendations instead of re-serving the same
  safe picks. Heavily filtered profiles (narrow genres + high rating + short
  recency window) may exhaust the pool and get shorter lists — relax a filter
  if that happens.
- **Cheap change detection:** the hourly watched-set refresh first asks Trakt
  `last_activities` (one tiny call) and skips the full watched-history
  download when nothing new was watched.
- **Fill-to-quota:** each catalog targets its profile's list size (default
  20). The Groq path runs extra suggestion rounds (expanding the exclusion
  list each time) and the discover path walks extra pages until the quota is
  filled or attempts are exhausted — heavy watchers still get full lists.
- **Title logos:** catalog metas carry the title's transparent logo (TMDB),
  so Stremio/Nuvio can show the logo-over-backdrop treatment. Fetched in the
  same TMDB call as the IMDb ID — no extra requests.
- **Full prompt logging:** every Groq prompt is printed in the container
  log between PROMPT START/END markers for troubleshooting.
- **Failure = stale, never empty:** if Groq/TMDB/Trakt error out or return
  too few usable titles (<5), the previous list stays live and a 30 min
  backoff prevents API hammering.
- **Filters are enforced**, not suggested: Groq is instructed, TMDB discover
  is parameterized, and a final hard filter checks resolved rating, release
  date, and genre IDs.

## Unraid setup

Docker tab → **Add Container** (or point a Compose stack at this repo's
`docker-compose.yml`). Everything the template needs:

**Basic**

| Field | Value |
|---|---|
| Name | `ai-recommender` |
| Repository | `ghcr.io/jamesgallagher/stremio_ai_recommender:latest` |
| Network type | `bridge` |
| Restart policy | `unless-stopped` |
| Icon URL | `https://raw.githubusercontent.com/jamesgallagher/Stremio_AI_Recommender/main/public/logo.png` |

**Ports**

| Container port | Host port | Protocol | Purpose |
|---|---|---|---|
| `7000` | `7000` (or any free port) | TCP | Web portal + addon endpoints — point your Cloudflare Tunnel here |

**Paths**

| Container path | Host path | Purpose |
|---|---|---|
| `/data` | `/mnt/user/appdata/ai-recommender` | **Required.** Profiles, API keys, Trakt tokens, recommendation caches. Back this up; losing it means re-entering keys and re-authorizing Trakt for every profile. |

**Variables**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `EXTERNAL_URL` | Yes (for real use) | — | Public base URL, e.g. `https://recs.yourdomain.com` (your Cloudflare Tunnel hostname). Baked into install URLs and the manifest logo. Without it, links use the LAN address you opened the portal from — Stremio clients outside your network can't reach those |
| `ADMIN_USER` | Recommended | — | Admin portal username (Basic Auth) |
| `ADMIN_PASSWORD` | Recommended | — | Admin portal password. If either is unset, `/configure` is unprotected (startup log warns) |
| `PORT` | No | `7000` | Internal HTTP port — only change if you also change the container port mapping |
| `DATA_DIR` | No | `/data` | Storage location inside the container — leave as is |
| `STALE_HOURS` | No | `24` | How old a cached list may get before a background rebuild |
| `BACKOFF_MINUTES` | No | `30` | Wait after a failed rebuild before retrying |
| `GROQ_MODELS` | No | built-in list | Comma-separated Groq model fallback chain (best first), e.g. `openai/gpt-oss-120b,llama-3.3-70b-versatile` — override when the built-in list ages |
| `SECRET_KEY` | Recommended | — | Encrypts **all** stored secrets at rest — every profile's API keys, Trakt OAuth tokens, and Auto-scrobble passwords (AES-256-GCM). Any long random string. When set, existing plaintext secrets are encrypted in place on the next start. Without it, secrets are stored in plaintext (and a scrobble password can't be saved). Keep it **out of the `/data` volume** so a leaked backup can't decrypt anything, and **back it up** — see [Encryption at rest](#encryption-at-rest). (`SCROBBLE_KEY` is still accepted as a legacy alias.) |

No API keys go in the template — Trakt/TMDB/Groq keys are entered per
profile in the web portal and stored in `/data/profiles.json`.

After starting: open `http://<unraid-ip>:7000/configure/`, log in with the
admin credentials, add profiles.

## Exposure (Cloudflare Tunnel)

Point a tunnel at `http://<unraid-ip>:7000` and set `EXTERNAL_URL` to the
tunnel hostname (e.g. `https://recs.yourdomain.com`) so install links and the
manifest point somewhere Stremio clients can actually reach. Then:

- `/addon/*` — must be publicly reachable **without** auth (Stremio can't do
  login prompts). Safe: profile tokens are unguessable 128-bit values.
- `/configure/` and `/api/*` — protected by HTTP Basic Auth when `ADMIN_USER`
  and `ADMIN_PASSWORD` are set (do this). Optionally layer **Cloudflare
  Access** on these paths as well.

## Config (env)

| Var | Default | |
|---|---|---|
| `PORT` | 7000 | HTTP port |
| `DATA_DIR` | `./data` | persistent storage |
| `STALE_HOURS` | 24 | cache staleness threshold |
| `BACKOFF_MINUTES` | 30 | retry backoff after failed rebuild |
| `ADMIN_USER` | — | admin portal username (Basic Auth) |
| `ADMIN_PASSWORD` | — | admin portal password; portal is unprotected if either is unset |
| `SECRET_KEY` | — | encrypts all stored secrets at rest (API keys, Trakt tokens, scrobble passwords); `SCROBBLE_KEY` accepted as alias |

## Credits

Prompt constraints, the model-fallback chain, and TMDB resolution fallback
adapted from [rocsx/stremiorecomendacion](https://github.com/rocsx/stremiorecomendacion)
(snapshot in `reference/`), restructured from serverless live-generation to a
long-running cached service.
