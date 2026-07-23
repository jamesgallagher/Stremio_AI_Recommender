# AI Recommender — Stremio/Nuvio addon

Self-hosted, per-family-profile movie & series recommendations. Trakt watch
history → Groq → TMDB resolution, served from a disk-backed cache that
refreshes in the background (stale-while-revalidate, 24 h threshold).

Every catalog open is instant — Stremio only ever reads the pre-computed cache.
Rebuilds happen in the background and never purge a good list on failure.

> ## ⚠ v5.2.0-beta — engine choice, AI + MAL age gating, metadata service (THIS BRANCH ONLY)
>
> Everything in this block applies to the `v3-phase1` beta branch, published
> as `:5.2.0-beta` (also `:beta`) — the stable `:latest` image (v2.6.x) is
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
> - **v5 — pick your engine per profile.** `Trakt` (default) is the v4
>   pipeline above. `AI` generates candidates with the age limit applied UP
>   FRONT, then a second Groq pass vets the survivors — because collaborative
>   filtering is structurally blind to age: a 13-year-old anime viewer's
>   nearest neighbours are ADULT anime viewers.
> - **v5 — Common Sense Media retired.** It was strict by design (no rating =
>   dropped), which works for mainstream Western titles and fails for anime,
>   where coverage is thin. For an anime-heavy child the gate wasn't strict,
>   it was absent. The AI age gate is now the sole age authority on lists,
>   extra catalogs AND search — remove-only and fail-closed. Titles are judged
>   one year ABOVE the limit; classification brackets are coarse.
>   **MDBList is now OPTIONAL** (curated catalogs + the IMDb rating source).
> - **v5 — the addon serves `meta`**, so a device can run this addon plus a
>   stream addon and nothing else. Previously a third-party metadata addon was
>   required for playback, and it answered search UNFILTERED next to our gated
>   results. **Groq key is required for kids profiles and for the AI engine**;
>   adult profiles on the Trakt engine still make zero LLM calls.
> - **v5.2 — anime is judged on data, not recall.** Titles are matched to
>   MyAnimeList via [Fribb's anime-lists](https://github.com/Fribb/anime-lists)
>   (ETag-refreshed daily), and MAL's rating (G / PG / PG-13 / R / R+ / Rx) is
>   used directly. Two rules, deliberately opposite: **any** adult signal (Rx,
>   Hentai/Erotica) is a **permanent blacklist** on every profile including
>   adults and every surface including `meta`; but a **missing** rating never
>   drops a title — it falls through to the LLM. "No rating" is not "too old".
>   The LLM safeguard still runs on everything that survives, and now receives
>   the MAL band as evidence instead of guessing at one.
> - **v5.2 — anime episode numbering** follows Cinemeta for anime series. TMDB
>   numbers anime by broadcast season and IMDb often doesn't; stream addons key
>   off Cinemeta's ids, and a mismatch is what "nothing opens" looks like.
> - **Search** (v4.1): the addon answers Stremio/Nuvio search. On profiles
>   with an age limit, results pass the SAME protection as the lists — the AI
>   goalkeeper — and fail CLOSED: if it can't run, search returns nothing
>   rather than unfiltered results. Adult profiles search ungated. On a kid's
>   device install only this addon and a stream addon, so nothing else answers
>   search unfiltered (v5's `meta` support is what makes that possible).
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
     (free tier). **Required for kids profiles** (age limit set) and for the
     **AI engine**; adult profiles on the Trakt engine never call the LLM
   - *(optional)* an MDBList API key at [mdblist.com/preferences](https://mdblist.com/preferences/)
     (free; sign in → Preferences → API Access) — powers the curated MDBList
     catalogs and the optional IMDb rating source
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

## Extra catalogs (curated lists)

Per profile, in the portal's **Catalogs** section: the two AI catalogs are
always on; the optional catalogs below can be toggled per profile, each
appearing as its own catalog in Stremio/Nuvio:

- **Popular Movies** / **Popular Series** — the JustWatch streaming charts
  (unfiltered, 20 titles).
- **Trending Kids Movies** / **Trending Kids TV** — kids-focused curated
  lists, **50 titles** each, anything below **IMDb 6** dropped. On a profile
  with an age limit these carry the full protection stack (see below).
- **Anime TV-14** — a public Trakt list (`snoak/trending-anime-shows`),
  **50 titles**, anything below **IMDb 6** dropped, watched titles excluded.
  Needs only the Trakt Client ID, not the MDBList key. The certification and
  rating filters in that list's web URL are applied by the Trakt *website*,
  not its API, so they are re-implemented here.
- **Christmas / Comedy / Action / Thriller Movies** — curated lists, 20
  titles each; anything rated below **IMDb 6** is dropped and the list is
  paged further until 20 titles are collected.

**Age-limited profiles:** every extra catalog passes the same age gate as the
AI lists and search — the remove-only AI goalkeeper (Australian/ACB
standards), judged one year above the limit. Fail-closed: without a Groq key,
or if the gate errors, the catalog keeps its previous contents rather than
publishing an unvetted list to a child.

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
Kids-mode age limits still apply to extra catalogs — the AI age gate
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

## Kids mode (AI age gate)

Per profile: tick **Limit to age** in Filters and pick a tier (5+, 6+, 8+,
10+, 12+, 13+, 15+ — granular at the younger end). Requires that profile's
**Groq API key**.

Titles are judged **one year above** the limit (13+ is judged at 14).
Classification brackets are coarse — a 13-year-old's material sits in the 14+
bracket — and judging exactly at the limit rejected most age-appropriate anime
along with the genuinely unsuitable.

Every discovery surface is gated: AI lists, every extra catalog, and search.
The gate is **remove-only** (it can veto a title, never rescue one) and
**fail-closed** (if it can't run the previous list is kept, and search returns
nothing). On the `AI` engine the limit is applied twice — once at generation,
once at review.

`meta` is deliberately **ungated**: every discovery surface is already gated,
so nothing un-vetted reaches a child through us, and gating there would put an
LLM call in front of every title open. Opening a title by direct id — from
Continue Watching, say — is not discovery.

> **Common Sense Media was retired in v5.** It was the primary authority and
> strict by design: no CSM rating meant the title was dropped. Its anime
> coverage is thin, so "unrated" was the common case rather than the
> exception, and entire kids catalogs came back empty. The AI gate reads
> titles it recognises rather than requiring a database row — exactly the
> property anime needed. MDBList is now optional.

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
