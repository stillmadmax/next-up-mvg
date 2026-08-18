# Architecture

A static, mobile-first PWA showing the next MVG departures in Munich. No
backend, no build step, no dependencies, no framework. Deployed to GitHub Pages
at `stillmadmax.github.io/next-up-mvg/`.

## Shape

```
GitHub Pages (HTTPS, /next-up-mvg/)
        │  static files only — no server process
   index.html + app.js + storage.js + api.js + style.css + sw.js
        │
   the browser calls, directly:
   https://www.mvg.de/api/bgw-pt/v3
```

There is no backend because there is nothing for one to do. The MVG API sends
`access-control-allow-origin: *` and needs no key, so a proxy would only add a
moving part — verified 2026-08-17 against `/departures`, `/stations/nearby` and
`/locations`, including live from the deployed origin.

That is not a promise, though: it is an unofficial API with no public contract.
Every `fetch` therefore lives in `api.js`. If the CORS headers ever disappear,
the base URL there is the only thing that changes, and a proxy goes in front.

When debugging, note that the API answers **curl with 403** while serving the
same request from a browser with 200 — presumably a client filter. A red curl is
therefore not evidence that the API is down; reproduce from the browser.

## Modules

| File | Responsibility |
|---|---|
| `api.js` | The only place that knows a URL. Normalises the API's field names and converts ms-epochs to minutes, so no other module deals with the raw shape. |
| `storage.js` | Everything kept on the device: favourites and the directions each station has been seen serving. Owns the key prefix and the one-off migrations. |
| `app.js` | Rendering, views, event wiring, auto-refresh. |
| `sw.js` | App shell cache for offline start, and the deploy-freshness workaround. |
| `style.css` | One dark theme, no breakpoints. |

### What has to stay at the repository root

Not a stylistic choice — moving these breaks the app:

- **`sw.js`** — a service worker's default scope is the directory it is served
  from, and it cannot control pages above that directory unless the server sends
  a `Service-Worker-Allowed` header. GitHub Pages does not let us set headers,
  so in a subfolder the worker would simply stop controlling the app.
- **`manifest.json`** — `scope` and `start_url` resolve against the *manifest's*
  own URL, not the document's. Both are `"."`, so from a subfolder they would
  point at that subfolder: wrong start URL, and a scope excluding the app.
- **`index.html`** — the Pages entry point.

Icons live in `icons/`, referenced from `index.html`, `manifest.json` and the
service worker's shell list.

## Mobile first

The app is built for a phone held one-handed, launched from the home screen and
glanced at for a few seconds. This is the primary target, not a small-screen
adaptation of a desktop layout:

- `style.css` contains **no media queries**. The single-column layout *is* the
  layout; compact mode's grid (`repeat(auto-fill, minmax(9.5rem, 1fr))`) grows
  into a wider viewport on its own, with no breakpoint to maintain.
- `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on `body`, so
  nothing hides under a notch in standalone mode.
- `apple-mobile-web-app-capable`, a full-bleed `apple-touch-icon` and
  `display: standalone` — the intended launch path is the home screen, not a
  browser tab.
- Whole departure rows are buttons (`.row`, full width) rather than small
  tap targets, and the trip detail unfolds in place instead of navigating away.
- Compact mode exists for exactly this: one tile per favourite, two departures
  each, several favourites on screen at once without scrolling.

## State

All client-side; one user, one device, no sync.

| Where | What | Why |
|---|---|---|
| `localStorage` | favourites, compact toggle, seen routes per station | Survives reloads. A database would only have created operational work. |
| Module state in `app.js` | `openTrip`, `expanded`, `editing`, `activeView` | Pure view state, thrown away on reload — and the 30 s refresh rebuilds the markup anyway. |
| `lineCache` (Map) | lines per station | The answer does not change within a session, so ask once. |

Keys are prefixed `nextup:`. On `github.io` the origin is the *whole account*,
so every project published there shares one `localStorage` namespace — an
unprefixed `favorites` would collide with another project's. Unprefixed keys
from earlier versions are migrated once, on load.

A favourite is a **named, filtered view of a station**, not just a station: the
same stop can appear twice, e.g. "Fahrt heim" and "Fahrt los" with opposite
directions. Hence each carries a `uid` — the station id no longer identifies a
card.

A favourite also carries an optional `icon` (one emoji from a fixed palette) and
an optional `group`. Groups are **derived, not stored separately**: the flat
favourites list stays the single source of order, and a section is the *run* of
cards sharing a `group`, appearing where its first card does. Favourites without
a group form the one section with no heading.

That a group is one contiguous run is an invariant, not a coincidence — moving a
whole section is a swap of two runs, and it only stays predictable if no third
group is interleaved. `loadFavorites` therefore regroups a list that violates it
(lists written by the first version of this feature can) and persists the result,
`setGroup` appends the card to the end of its new section and rewrites the list
section by section, and `moveFavorite` refuses a swap across a section edge —
that would change the card's group behind the user's back.

The nameless section has no heading and therefore no arrows of its own; it moves
only when a named section passes it.

## Decisions worth remembering

- **Six stations max in nearby mode**, radius 1000 m. Each station costs its own
  departures request; without the cap one page load becomes ~30 requests against
  an unofficial API.
- **`distanceInMeters` instead of Haversine.** `/stations/nearby` returns the
  distance per hit, so filtering is exact rather than recomputed.
- **`limit` is cut hard client-side.** The API treats it as an approximation and
  returns one entry more often than not — 11 for `limit=10`, and re-checked
  2026-08-17, 3 for `limit=2`.
- **Favourites fetch a larger batch (40) than they show.** Filtering happens
  client-side, so a line filter would otherwise empty the list — and the batch
  is also how we learn which directions a line actually serves.
- **Filter chips list what the station is known to serve**, not only what departs
  in the next hour. The departures feed reaches ~75 minutes ahead, so at 23:00 it
  knows nothing about the rush-hour express bus. Lines come from `/lines`;
  directions have no such endpoint and are remembered as they are seen.
- **Auto-refresh every 30 s, only while the page is visible**, plus an immediate
  refresh on `visibilitychange`.
- **The service worker is network-first.** GitHub Pages serves files with
  `max-age=600`, so a plain reload could otherwise run the previous build for ten
  minutes after a deploy — that is the whole reason the file exists. Requests use
  `cache: 'reload'` to bypass the HTTP cache; the cache is an offline fallback
  only. Departure data is never cached, and the API sends `cache-control:
  no-store` itself.
- **Markup is escaped at every leaf.** Rendering is string interpolation into
  `innerHTML`, and the values come from the API or from a name the user typed, so
  `esc()` wraps each one — in text and in attributes alike, since a quote in an
  attribute escapes the attribute. Values read back through `dataset` need no
  counterpart: the HTML parser decodes them, so the filter and trip lookups still
  compare against the original string. Composite keys (`tripKey`) are escaped
  where they are written, not where they are built, so both sides keep matching.
- **Rail replacement is marked, not just recoloured.** A replacement bus keeps
  the rail line's label, so the API returns `label: "U6"` with
  `transportType: "BUS"` — the badge alone would send you to a platform with no
  train. It carries a `sev` boolean, so this is read from the flag rather than
  guessed from the label. The badge takes the `SEV` colour *and* an "SEV"
  marker: colour on its own fails colour blindness and a hurried glance.
- **`LINE_COLORS` is looked up with `Object.hasOwn`.** A plain lookup would
  inherit from `Object.prototype`, so a `transportType` of `constructor` or
  `toString` would skip the `?? '#666'` fallback and put function source into a
  `style` attribute.
- **The PNG icon is full-bleed.** iOS applies its own mask to `apple-touch-icon`;
  a pre-rounded image would give doubled corners. `icons/icon-square.svg` is the
  raster source and is intentionally referenced by nothing.

## Known gaps

- **Not verified on a real iPhone**: "Add to Home Screen", a real Safari
  geolocation prompt, whether the PNG icon shows up. Nearby mode has only been
  exercised with faked coordinates on a Mac.
- **Outliers far in the future.** At terminal stops the API returns genuine
  departures hours ahead (seen: U6 to Garching, 324 min). They currently fall out
  of the list only by chance, via `limit`. Filtering above ~60 min is tempting,
  but at night one *wants* to see the last train.
- Behaviour when the network drops mid-request is untested.
- The icon is a placeholder: three coloured bars.

## Local development

```bash
python3 -m http.server 8765
```

Must run from the project root, so the relative paths resolve as they do on
Pages. `.claude/launch.json` wires this up for the editor's preview.
