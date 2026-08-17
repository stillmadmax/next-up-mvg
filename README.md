# Next Up MVG

A small PWA for the next public transport departures in Munich, built to be
opened from the home screen and glanced at. Two modes:

- **Favourites** — saved stops, freely named, filterable by line and direction;
  the next four departures with the rest one tap away
- **Nearby** — geolocation, stops within 1 km sorted by distance

Live: <https://stillmadmax.github.io/next-up-mvg/>

## How it works

A static site with no backend. The browser calls the unofficial MVG API at
`mvg.de/api/bgw-pt/v3` directly: it sends permissive CORS headers and needs no
API key, so a proxy would only add moving parts. All API access is wrapped in
`api.js` — if those headers ever go away, only the base URL there changes.

Favourites are kept in `localStorage`. Nearby mode uses the `distanceInMeters`
the API already returns instead of computing distances, and is capped at six
stops so one page load stays a handful of requests rather than thirty.

A service worker (`sw.js`) caches the app shell so it starts offline, but always
asks the network first and bypasses the browser's HTTP cache while doing so —
GitHub Pages serves the files with `max-age=600`, which would otherwise keep a
deployed change hidden for ten minutes.

No build step, no dependencies, no framework.

## Development

Serve the directory and open it:

```bash
python3 -m http.server 8765
```

## Note

Departure data comes from MVG's internal API, which has no public contract and
may change without notice. This is a personal project and not affiliated with
or endorsed by MVG.
