# Next Up MVG

Static mobile-first PWA, deployed to GitHub Pages from `main`. Full context in
[.claude/docs/ARCHITECTURE.md](.claude/docs/ARCHITECTURE.md) — read it before
changing structure.

## Hard constraints

- **No build step, no dependencies, no framework.** Plain ES modules loaded
  directly by the browser. Keep it that way; adding a bundler changes the
  deployment model.
- **`sw.js`, `manifest.json` and `index.html` must stay at the repository root.**
  A service worker cannot control pages above its own directory (and Pages
  cannot send `Service-Worker-Allowed`), and the manifest resolves `scope` /
  `start_url` against its own URL. Moving them breaks the app quietly.
- **A new file that the app loads must be added to `SHELL` in `sw.js`** and the
  `CACHE` name bumped. `cache.addAll` rejects as a whole if a single path 404s,
  which kills offline start silently — verify the worker reaches `activated`.

## Conventions

- All API access goes through `api.js`; nothing else may know a URL.
- Device state goes through `storage.js`. `localStorage` keys are prefixed
  `nextup:` — on `github.io` the origin is the whole account, so unprefixed keys
  collide with other projects.
- UI strings are German; code, comments and commit messages are English.

## Verifying

There is no test suite. Changes are verified in the browser: serve the project
root (`python3 -m http.server 8765`, wired up in `.claude/launch.json`) and
exercise the affected path — favourites, filter chips, trip detail, compact
mode, nearby. Check the console and, for service worker changes, that the shell
actually lands in the cache. Clear `nextup:` keys afterwards.

Note: the MVG API returns 403 to curl but 200 to the browser. A failing curl is
not evidence the API is down.

## Rendering

Views are built by interpolating strings into `innerHTML`. Every value that
comes from the API or from the user must go through `esc()` — in text *and* in
attributes, because a quote breaks out of an attribute. Only pre-built markup
fragments are interpolated raw. Do not add an unescaped `${...}` of foreign data;
that is how this file's previous "known gap" section came about.

Values read back via `dataset` are already decoded by the parser, so never
unescape them by hand.
