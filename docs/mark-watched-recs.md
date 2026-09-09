# MW-01 — Recs actions: add "mark as watched" + rename "Remove" → "not interested"

**Layer:** frontend (Mobile Companion) · **Depends on:**
[MW-00](mark-watched-core.md) (`POST /api/watched`) · **Behavioral change for
users:** the recommendations list (`mobile/#/recs`) gains a **third** action — an
eye button that marks the title watched (scrobbles to Simkl) — and the existing X
button's helper text changes from "Remove" to **"not interested"** (its behaviour
is unchanged).

> Read the recs row builder
> [`mobile/public/app.js:276-303`](../mobile/public/app.js) (`buildRecRow` —
> `rec-actions`, `saveBtn`, `remBtn`), the swipe handlers + underlay hint
> [`app.js:279-280,305-366`](../mobile/public/app.js), and the swipe label module
> [`mobile/public/swipe.js:13-14,24,27`](../mobile/public/swipe.js). The current
> row is `[＋ Add to Watch Later] [✕ Remove]`; this card makes it
> `[＋ Add to Watch Later] [👁 Mark as watched] [✕ Not interested]`.

---

## Why this card exists

The X on a recommendation already means "don't recommend this" — a permanent user
rejection ([MW-00](mark-watched-core.md) §Why). But its label says "Remove", which
reads like "hide this once", not "I'm not interested in this". Renaming it to
**"not interested"** makes the training intent honest to the user, with **zero
logic change**.

The genuinely new affordance is **"mark as watched"**: today a user who has already
seen a recommended title can only reject it (which trains "don't recommend"),
losing the fact that they *watched and possibly liked* it. Marking watched writes it
to Simkl, where it becomes a taste seed + de-dupe on the next sync — a strictly
better signal than a bare rejection.

---

## Context primer (current state)

- **Row actions** — [`app.js:292-298`](../mobile/public/app.js): a `.rec-actions`
  div with two buttons — `rec-save` (`＋`, title/aria "Add to Watch Later",
  → `saveRec`) and `rec-remove` (`✕`, title/aria "Remove", → `removeRec`).
- **`removeRec(r, row)`** — [`app.js:345-366`](../mobile/public/app.js): optimistic
  row removal + bench promotion, then `POST /api/recommend/suppress`, then a snackbar
  with **Undo** (`undoRemove` → `POST /api/recommend/unsuppress`). This is the
  "not interested" action already — keep it verbatim.
- **`saveRec(r, btn)`** — [`app.js:333-343`](../mobile/public/app.js): `POST
  /api/watchlist`, snackbar. Pattern to copy for the watched call.
- **Swipe** — [`app.js:305-331`](../mobile/public/app.js): right-swipe = remove,
  left-swipe = save; underlay hints read `window.swipe.REMOVE_LABEL` / `SAVE_LABEL`
  ([`app.js:279-280`](../mobile/public/app.js)); labels defined at
  [`swipe.js:13-14`](../mobile/public/swipe.js). Buttons opt out of the swipe via
  `e.target.closest('button')` ([`app.js:308`](../mobile/public/app.js)) — the new
  button inherits that for free.
- **DTO** — `toRecDTO` ([`handlers.js:99-112`](../mobile/server/handlers.js)) gives
  each row `{ id (imdb tt), tmdb_id, type, title, year, … }` — everything
  `POST /api/watched` needs.

---

## Goal

1. A **third button** between save and remove: a small **eye** icon, `title`/
   `aria-label` = **"Mark as watched"**, that calls `POST /api/watched` and removes
   the row (it's watched — it shouldn't keep showing as a rec).
2. **Rename** the X helper text (both `title` and `aria-label`) from "Remove" to
   **"Not interested"**. No handler change.
3. **Rename the swipe-right label** `REMOVE_LABEL` to match ("Not interested").

---

## Design

### 1. Third button — `rec-watched`

In `buildRecRow` ([`app.js:292-298`](../mobile/public/app.js)), insert between
`saveBtn` and `remBtn`:

```js
const watchedBtn = document.createElement('button');
watchedBtn.type = 'button'; watchedBtn.className = 'rec-watched';
watchedBtn.title = 'Mark as watched'; watchedBtn.setAttribute('aria-label', 'Mark as watched');
watchedBtn.innerHTML = EYE_ICON;                       // small eye SVG (see §3)
watchedBtn.addEventListener('click', (e) => { e.stopPropagation(); watchRec(r, row); });
actions.appendChild(saveBtn); actions.appendChild(watchedBtn); actions.appendChild(remBtn);
```

New handler, modelled on `removeRec` (optimistic removal + bench promotion) but
posting to the watched endpoint and with **no Undo** — a watched mark is a real
Simkl write, and "undo" would mean an un-watch (out of scope, MW-00):

```js
async function watchRec(r, row) {
  row.classList.add('removing'); setTimeout(() => row.remove(), 200);
  // same one-in-one-out bench bookkeeping as removeRec (factor the shared bit out)
  dropFromBenchAndMaybeRefill(r);
  try {
    const res = await apiFetch('/watched', { method: 'POST',
      body: JSON.stringify({ type: r.type, imdb_id: r.id, tmdb_id: r.tmdb_id, title: r.title }) });
    if (res.ok) showSnack('Marked “' + (r.title || 'title') + '” watched', null);
    else if (res.status === 400) showSnack('Couldn’t mark watched — connect Simkl in the portal first', null);
    else showSnack('Couldn’t mark watched — try again', null);
  } catch { showSnack('Couldn’t mark watched — try again.', null); }
}
```

The bench/refill logic in `removeRec` ([`app.js:348-364`](../mobile/public/app.js))
should be extracted into a small shared helper so `watchRec` and `removeRec` stay in
lockstep (both remove one row and promote one from the bench).

### 2. Rename the reject affordance (no behaviour change)

- Button ([`app.js:294`](../mobile/public/app.js)): `remBtn.title` and the
  `aria-label` → **"Not interested"**. Handler stays `removeRec` / suppress. (Class
  name `rec-remove` can stay to avoid churning CSS.)
- Swipe label ([`swipe.js:13`](../mobile/public/swipe.js)):
  `REMOVE_LABEL = 'Not interested'` (constant name unchanged; value only). The
  underlay hint picks it up automatically.
- Snackbar copy in `removeRec` may stay "Removed …" or become "Not interested in …"
  — cosmetic, James's preference.

> The suppress call is unchanged here, but its **reach** grows: with
> [MW-03](not-interested-all-catalogs.md) a "not interested" title is filtered from
> every curated catalog too, not only the AI recs — so the label "Not interested"
> becomes literally true across the whole app. No client change needed for that.

### 3. Eye icon

Add an `EYE_ICON` SVG constant (a clean outline eye, `16×16`,
`stroke="currentColor"`) so it renders crisply next to the `＋`/`✕` glyphs and can be
themed. Keep it visually distinct from the catalog **preview** glyph
(`PREVIEW_ICON`, a document-with-eye badge) — this is a plain eye = "seen it".
Consider defining it once and reusing it in [MW-02](mark-watched-catalog.md) so the
recs eye and the catalog eye are the same mark.

CSS: reuse the existing `.rec-save`/`.rec-remove` button sizing; add `.rec-watched`
with the same box and a neutral hover (not the destructive red of remove).

---

## Tasks

- [ ] `app.js` `buildRecRow`: insert `rec-watched` eye button between save and
      remove; wire to `watchRec`; keep `stopPropagation`.
- [ ] `app.js`: `watchRec(r, row)` → `POST /api/watched`, optimistic removal + bench
      promotion (shared helper extracted from `removeRec`), snackbar (no Undo).
- [ ] `app.js`: rename the X `title`/`aria-label` to "Not interested" (handler
      unchanged).
- [ ] `swipe.js`: `REMOVE_LABEL = 'Not interested'`.
- [ ] `app.js` / stylesheet: `EYE_ICON` constant + `.rec-watched` button style.
- [ ] Tests / live check — see Test notes.

## Acceptance criteria

- **Three buttons in order** `[＋ Add to Watch Later] [👁 Mark as watched]
  [✕ Not interested]`, each with matching `title` + `aria-label`.
- **Mark as watched** POSTs `/api/watched` with `{ type, imdb_id, tmdb_id, title }`,
  removes the row, promotes one bench title, and shows a confirmation (no Undo).
- **Simkl-not-connected** shows the "connect Simkl in the portal first" message,
  not a silent failure.
- **X still suppresses** exactly as before (same endpoint, same Undo); only its
  label reads "Not interested".
- **Swipe-right** underlay now reads "Not interested"; swipe still triggers the same
  suppress. Tapping any of the three buttons never starts a swipe.

## Test notes

- Live in the browser (companion recs tab): confirm the three buttons, helper text
  on hover/focus, that the eye removes the row and fires one `POST /api/watched`
  (check the network panel), and that the X and swipe are unchanged. Screenshot the
  three-button row for the PR.
- Extend the mobile smoke suite for the `/api/watched` wiring if a DOM-level test
  exists for the recs row; otherwise the endpoint is covered by
  [MW-00](mark-watched-core.md).

## Out of scope

- The `/api/watched` endpoint + Simkl write — [MW-00](mark-watched-core.md).
- Catalog-preview overlays — [MW-02](mark-watched-catalog.md).
- An "un-watch"/undo for the watched mark — a watched Simkl write is authoritative
  (MW-00 Out of scope).
