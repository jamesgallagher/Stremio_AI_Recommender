# AI Recommender — Stremio/Nuvio addon

Self-hosted, per-family-profile movie & series recommendations. Trakt watch
history → Gemini → TMDB resolution, served from a disk-backed cache that
refreshes in the background (stale-while-revalidate, 24 h threshold).

Every catalog open is instant — Stremio only ever reads the pre-computed cache.
Rebuilds happen in the background and never purge a good list on failure.

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
   - a Gemini API key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
3. Paste the four keys into the profile card → **Save keys**.
4. **Connect Trakt** → enter the PIN at trakt.tv/activate while signed in as
   that member's Trakt account. Tokens auto-refresh from then on.
5. Set filters if wanted (min rating, recency window, genre exclusions —
   defaults: ≥7.0, last 5 years, none excluded).
6. Copy the install URL from the card into Stremio/Nuvio → Addons.
   Two catalogs appear: **Movies recommended for you** and
   **Series recommended for you**.

First list generates within a minute or two (a "warming up" card shows until
then). After that, lists refresh in the background roughly daily.

## Behavior notes

- **Cold start:** with fewer than 3 watched titles, the list comes from TMDB
  discover ("popular picks") using the same filters — no Gemini. Once history
  exists, the next rebuild upgrades to personalized ("picked for you").
- **De-dupe guarantee:** everything ever watched on Trakt (even one episode of
  a show) is excluded, matched on canonical IMDb/TMDB IDs after resolution —
  not on title text.
- **Failure = stale, never empty:** if Gemini/TMDB/Trakt error out or return
  too few usable titles (<5), the previous list stays live and a 30 min
  backoff prevents API hammering.
- **Filters are enforced**, not suggested: Gemini is instructed, TMDB discover
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
| `ADMIN_USER` | Recommended | — | Admin portal username (Basic Auth) |
| `ADMIN_PASSWORD` | Recommended | — | Admin portal password. If either is unset, `/configure` is unprotected (startup log warns) |
| `PORT` | No | `7000` | Internal HTTP port — only change if you also change the container port mapping |
| `DATA_DIR` | No | `/data` | Storage location inside the container — leave as is |
| `STALE_HOURS` | No | `24` | How old a cached list may get before a background rebuild |
| `BACKOFF_MINUTES` | No | `30` | Wait after a failed rebuild before retrying |

No API keys go in the template — Trakt/TMDB/Gemini keys are entered per
profile in the web portal and stored in `/data/profiles.json`.

After starting: open `http://<unraid-ip>:7000/configure/`, log in with the
admin credentials, add profiles.

## Exposure (Cloudflare Tunnel)

Point a tunnel at `http://<unraid-ip>:7000`. Then:

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

## Credits

Prompt constraints, Gemini model-fallback chain, and TMDB resolution fallback
adapted from [rocsx/stremiorecomendacion](https://github.com/rocsx/stremiorecomendacion)
(snapshot in `reference/`), restructured from serverless live-generation to a
long-running cached service.
