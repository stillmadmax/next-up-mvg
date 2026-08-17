import { searchStations, nearbyStations, departures, stationLines, tripStops } from './api.js';

// In nearby mode every station costs its own request. Without a cap a single
// page load turns into ~30 requests against an unofficial API.
const NEARBY_MAX_STATIONS = 6;
const NEARBY_RADIUS_METERS = 1000;
const DEPARTURES_PER_STATION = 4;
const FAVORITE_DEPARTURES = 10;
// Only the next few matter at a glance; the rest sit behind a disclosure.
const FAVORITE_VISIBLE = 4;
// Compact mode is for a glance: one tile per favorite, side by side.
const COMPACT_DEPARTURES = 2;
// Filtering happens client-side, so a favorite always fetches a larger batch:
// it keeps the list full when a line filter throws most departures away, and it
// is the only way to know which lines a station actually serves.
const FAVORITE_FETCH = 40;
const REFRESH_MS = 30000;

const LINE_COLORS = {
  UBAHN: '#0065ae',
  SBAHN: '#00893c',
  TRAM: '#d4021d',
  BUS: '#00586a',
  REGIONAL_BUS: '#00586a',
  BAHN: '#3c3c3c',
  SEV: '#c8963c',
  SCHIFF: '#0084c8',
};

const el = {
  tabs: document.querySelectorAll('[data-tab]'),
  views: document.querySelectorAll('[data-view]'),
  favorites: document.getElementById('favorites'),
  nearby: document.getElementById('nearby'),
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  compact: document.getElementById('compact'),
};

// ---- Storage ----------------------------------------------------------------

// localStorage belongs to the origin, and on github.io that is the whole
// account — every project published there shares this namespace. Hence the
// prefix: another project's "favorites" must not collide with ours.
const PREFIX = 'nextup:';
const OWN_KEYS = (key) => key === 'favorites' || key === 'compact' || key.startsWith('routes:');

const store = {
  get: (key) => localStorage.getItem(PREFIX + key),
  set: (key, value) => localStorage.setItem(PREFIX + key, value),
  remove: (key) => localStorage.removeItem(PREFIX + key),
};

// Earlier versions wrote these keys unprefixed; move them once.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith(PREFIX) || !OWN_KEYS(key)) continue;
  localStorage.setItem(PREFIX + key, localStorage.getItem(key));
  localStorage.removeItem(key);
}

let activeView = 'favoriten';
let compact = store.get('compact') === '1';
let refreshTimer = null;

// ---- Favorites (client-side only; one user, one device) ---------------------

// A favorite is a named, filtered view of a station — the same station can be in
// the list twice, e.g. "Fahrt heim" and "Fahrt los" with opposite directions.
// Hence uid: the station id no longer identifies a card.
function loadFavorites() {
  let list;
  try {
    list = JSON.parse(store.get('favorites') ?? '[]');
  } catch {
    return [];
  }

  // Favorites saved before uid existed; persist the migration so the ids the
  // markup carries stay stable across renders.
  if (list.some((f) => !f.uid)) {
    list.forEach((f, i) => (f.uid ??= `${f.id}-${i}`));
    saveFavorites(list);
  }
  return list;
}

function saveFavorites(list) {
  store.set('favorites', JSON.stringify(list));
}

function updateFavorite(uid, change) {
  const list = loadFavorites();
  const fav = list.find((f) => f.uid === uid);
  if (!fav) return;
  change(fav);
  saveFavorites(list);
}

function addFavorite(station) {
  const list = loadFavorites();
  list.push({
    uid: `${station.id}-${list.length}-${Date.now()}`,
    id: station.id,
    name: station.name,
    place: station.place,
    label: '', // user-given name; empty falls back to the station name
    lines: [], // selected line labels; empty means "show everything"
    destinations: [], // selected directions, same convention
  });
  saveFavorites(list);
}

function removeFavorite(uid) {
  saveFavorites(loadFavorites().filter((f) => f.uid !== uid));
}

function toggleLine(uid, line) {
  updateFavorite(uid, (fav) => {
    const lines = fav.lines ?? [];
    fav.lines = lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line];
    // A direction belongs to a line, so a changed line filter can leave a
    // selected direction invisible — and then unselectable. Reset it instead.
    fav.destinations = [];
  });
}

function toggleDestination(uid, destination) {
  updateFavorite(uid, (fav) => {
    const dests = fav.destinations ?? [];
    fav.destinations = dests.includes(destination)
      ? dests.filter((d) => d !== destination)
      : [...dests, destination];
  });
}

// ---- Known lines and directions per station ---------------------------------

// The departures list only reaches ~75 minutes ahead, so at night it knows
// nothing about the rush hour express bus or the direction that stops running
// after 20:00. Lines come from the API; directions have no such endpoint, so
// they are remembered as they are seen.
const lineCache = new Map();

function stationLinesCached(stationId) {
  if (!lineCache.has(stationId)) {
    // A failure here only costs completeness, so the render must not depend on it.
    lineCache.set(
      stationId,
      stationLines(stationId).catch(() => [])
    );
  }
  return lineCache.get(stationId);
}

function knownRoutes(stationId) {
  try {
    return JSON.parse(store.get(`routes:${stationId}`) ?? '[]');
  } catch {
    return [];
  }
}

/** Remembers which directions a line was seen going in, for the filter chips. */
function learnRoutes(stationId, deps) {
  const known = knownRoutes(stationId);
  const seen = new Set(known.map(([l, d]) => `${l}|${d}`));
  let added = false;

  for (const d of deps) {
    if (seen.has(`${d.line}|${d.destination}`)) continue;
    seen.add(`${d.line}|${d.destination}`);
    known.push([d.line, d.destination]);
    added = true;
  }
  if (added) store.set(`routes:${stationId}`, JSON.stringify(known));
  return known;
}

// ---- Rendering -------------------------------------------------------------

function clockTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// The trip currently unfolded, at most one at a time.
let openTrip = null;

function tripKey(stationId, d) {
  return `${stationId}|${d.line}|${d.planned}`;
}

function tripPanel() {
  if (openTrip.state === 'loading') {
    return '<li class="trip"><p class="status">Fahrtverlauf wird geladen …</p></li>';
  }
  if (openTrip.state === 'error') {
    return `<li class="trip"><p class="status">${openTrip.message}</p></li>`;
  }

  const stops = openTrip.stops
    .map((s) => `<li><span class="at">${clockTime(s.at)}</span><span class="stop">${s.name}</span></li>`)
    .join('');
  return `<li class="trip"><ol>${stops}</ol><p class="note">Planzeiten</p></li>`;
}

function departureRow(d, stationId) {
  const color = LINE_COLORS[d.type] ?? '#666';
  const when = d.inMinutes <= 0 ? 'jetzt' : `${d.inMinutes} min`;
  const delay = d.delay > 0 ? `<span class="delay">+${d.delay}</span>` : '';
  const key = tripKey(stationId, d);
  const open = openTrip?.key === key;

  return `
    <li class="${d.cancelled ? 'cancelled' : ''}${open ? ' open' : ''}">
      <button class="row" data-trip="${key}" data-station="${stationId}" data-line="${d.line}"
        data-destination="${d.destination}" data-planned="${d.planned}">
        <span class="line" style="background:${color}">${d.line}</span>
        <span class="dest">${d.destination}</span>
        ${delay}
        <span class="at">${clockTime(d.at)}</span>
        <span class="when">${d.cancelled ? 'entfällt' : when}</span>
      </button>
    </li>
    ${open ? tripPanel() : ''}`;
}

// Which favorites the user has expanded. Kept in memory only: it is view state,
// and the auto refresh rebuilds the markup every 30 s.
const expanded = new Set();

function departureList(uid, deps, stationId, collapsible) {
  const rows = (list) => list.map((d) => departureRow(d, stationId)).join('');
  if (!collapsible || deps.length <= FAVORITE_VISIBLE) {
    return `<ul>${rows(deps)}</ul>`;
  }

  const rest = deps.slice(FAVORITE_VISIBLE);
  return `
    <ul>${rows(deps.slice(0, FAVORITE_VISIBLE))}</ul>
    <details ${expanded.has(uid) ? 'open' : ''}>
      <summary data-expand="${uid}">${rest.length} weitere</summary>
      <ul>${rows(rest)}</ul>
    </details>`;
}

function chipRow(uid, attribute, values, selected) {
  if (values.length < 2) return '';
  return `<div class="lines">${values
    .map(
      (v) =>
        `<button class="chip${selected.includes(v) ? ' on' : ''}" data-uid="${uid}"
           data-${attribute}="${v}" aria-pressed="${selected.includes(v)}">${v}</button>`
    )
    .join('')}</div>`;
}

/**
 * One row of line chips, one of direction chips; both filters apply together.
 * Both rows list what the station is known to serve, not only what departs in
 * the next hour. Picking a line narrows the second row to that line's
 * directions.
 */
function filterChips(fav, lines, routes) {
  const sorted = (list) =>
    [...new Set(list)].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  const selectedLines = fav.lines ?? [];
  const directions = routes
    .filter(([line]) => !selectedLines.length || selectedLines.includes(line))
    .map(([, destination]) => destination);

  return (
    chipRow(fav.uid, 'line', sorted(lines), selectedLines) +
    chipRow(fav.uid, 'destination', sorted(directions), fav.destinations ?? [])
  );
}

function stationCard(station, deps, { favorite = null, chips = '', collapsible = false } = {}) {
  const distance = station.distance !== undefined ? `${station.distance} m` : station.place;
  // A renamed favorite keeps the station name as its subtitle — otherwise the
  // card no longer says where "Fahrt heim" actually departs.
  const title = favorite?.label || station.name;
  const sub = favorite?.label ? station.name : distance;

  const head = favorite
    ? `<h2 data-rename="${favorite.uid}">${title}</h2><span class="sub">${sub}</span>
       <button class="remove" data-remove="${favorite.uid}" aria-label="Favorit entfernen">×</button>`
    : `<h2>${title}</h2><span class="sub">${sub}</span>`;

  const body = deps.length
    ? departureList(favorite?.uid, deps, station.id, collapsible)
    : '<p class="empty">Keine Abfahrten</p>';

  return `
    <section class="station">
      <header>${head}</header>
      ${chips}
      ${body}
    </section>`;
}

function compactTile(fav, deps) {
  // Same open/closed state as the list view — it is the same favorite.
  const open = expanded.has(fav.uid);
  const visible = open ? deps.length : COMPACT_DEPARTURES;
  const hidden = deps.length - COMPACT_DEPARTURES;

  const rows = deps.slice(0, visible).map((d) => {
    const color = LINE_COLORS[d.type] ?? '#666';
    const when = d.inMinutes <= 0 ? 'jetzt' : `${d.inMinutes} min`;
    return `
      <li class="${d.cancelled ? 'cancelled' : ''}">
        <span class="line" style="background:${color}">${d.line}</span>
        <span class="at">${clockTime(d.at)}</span>
        <span class="when">${d.cancelled ? 'entfällt' : when}</span>
      </li>`;
  });

  const more =
    hidden > 0
      ? `<button class="more" data-tile="${fav.uid}">${open ? 'weniger' : `${hidden} weitere`}</button>`
      : '';

  return `
    <section class="tile">
      <h3>${fav.label || fav.name}</h3>
      ${rows.length ? `<ul>${rows.join('')}</ul>` : '<p class="empty">Keine Abfahrten</p>'}
      ${more}
    </section>`;
}

function setStatus(container, message) {
  container.className = ''; // a status line is never part of the compact grid
  container.innerHTML = `<p class="status">${message}</p>`;
}

// ---- Views -----------------------------------------------------------------

async function renderFavorites() {
  const favorites = loadFavorites();
  if (!favorites.length) {
    setStatus(el.favorites, 'Noch keine Favoriten. Über die Suche unten hinzufügen.');
    return;
  }

  // Only the first render shows a placeholder. A refresh swaps the markup once
  // the new data is there, so the list does not blink away every 30 seconds.
  const filled = !!el.favorites.querySelector('.station, .tile');
  if (!filled) setStatus(el.favorites, 'Lade …');

  try {
    // Two favorites can point at the same station; one request serves both.
    const pending = new Map();
    const fetchOnce = (id) => {
      if (!pending.has(id)) pending.set(id, departures(id, FAVORITE_FETCH));
      return pending.get(id);
    };

    const cards = await Promise.all(
      favorites.map(async (fav) => {
        const all = await fetchOnce(fav.id);
        const lines = fav.lines ?? [];
        const dests = fav.destinations ?? [];
        const lineFiltered = lines.length ? all.filter((d) => lines.includes(d.line)) : all;
        const shown = (dests.length
          ? lineFiltered.filter((d) => dests.includes(d.destination))
          : lineFiltered
        ).slice(0, FAVORITE_DEPARTURES);

        if (compact) return compactTile(fav, shown);

        const known = await stationLinesCached(fav.id);
        const routes = learnRoutes(fav.id, all);
        return stationCard(fav, shown, {
          favorite: fav,
          chips: filterChips(fav, [...known, ...all.map((d) => d.line)], routes),
          collapsible: true,
        });
      })
    );
    el.favorites.className = compact ? 'grid' : '';
    el.favorites.innerHTML = cards.join('');
  } catch (err) {
    // On a refresh, keep what is on screen — a hiccup should not wipe the list.
    if (!filled) setStatus(el.favorites, `Fehler: ${err.message}`);
  }
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation nicht verfügbar'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => reject(new Error(`Standort nicht verfügbar (${err.message})`)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

async function renderNearby() {
  const filled = !!el.nearby.querySelector('.station');
  if (!filled) setStatus(el.nearby, 'Standort wird ermittelt …');

  try {
    const { latitude, longitude } = await currentPosition();

    if (!filled) setStatus(el.nearby, 'Suche Haltestellen …');
    const stations = (await nearbyStations(latitude, longitude, NEARBY_RADIUS_METERS)).slice(
      0,
      NEARBY_MAX_STATIONS
    );

    if (!stations.length) {
      setStatus(el.nearby, `Keine Haltestelle im Umkreis von ${NEARBY_RADIUS_METERS} m.`);
      return;
    }

    const cards = await Promise.all(
      stations.map(async (station) => {
        const deps = await departures(station.id, DEPARTURES_PER_STATION);
        return stationCard(station, deps);
      })
    );
    el.nearby.innerHTML = cards.join('');
  } catch (err) {
    if (!filled) setStatus(el.nearby, `Fehler: ${err.message}`);
  }
}

function renderActiveView() {
  // A rebuild would throw away a half-typed name.
  if (document.querySelector('.rename')) return;
  if (activeView === 'favoriten') renderFavorites();
  else renderNearby();
}

function syncCompact() {
  el.compact.classList.toggle('active', compact);
  el.compact.setAttribute('aria-pressed', String(compact));
}

el.compact.addEventListener('click', () => {
  compact = !compact;
  store.set('compact', compact ? '1' : '0');
  syncCompact();
  renderFavorites();
});

// ---- Search ----------------------------------------------------------------

let searchTimer = null;

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = el.search.value.trim();
  if (query.length < 3) {
    el.results.innerHTML = '';
    return;
  }
  // Debounced so not every keystroke fires a request.
  searchTimer = setTimeout(async () => {
    try {
      const stations = await searchStations(query);
      el.results.innerHTML = stations
        .slice(0, 8)
        .map(
          (s) =>
            `<li><button data-add="${s.id}" data-name="${s.name}" data-place="${s.place}">${s.name}<span>${s.place}</span></button></li>`
        )
        .join('');
    } catch (err) {
      el.results.innerHTML = `<li class="status">Fehler: ${err.message}</li>`;
    }
  }, 300);
});

el.results.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  addFavorite({ id: btn.dataset.add, name: btn.dataset.name, place: btn.dataset.place });
  el.search.value = '';
  el.results.innerHTML = '';
  activeView = 'favoriten';
  syncTabs();
  renderFavorites();
});

el.favorites.addEventListener('click', (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    removeFavorite(remove.dataset.remove);
    renderFavorites();
    return;
  }

  const chip = e.target.closest('.chip');
  if (chip) {
    if (chip.dataset.line) toggleLine(chip.dataset.uid, chip.dataset.line);
    else toggleDestination(chip.dataset.uid, chip.dataset.destination);
    renderFavorites();
    return;
  }

  // Tiles are rebuilt on toggle; <details> in the list view opens itself.
  const tile = e.target.closest('[data-tile]');
  if (tile) {
    const uid = tile.dataset.tile;
    if (expanded.has(uid)) expanded.delete(uid);
    else expanded.add(uid);
    renderFavorites();
    return;
  }

  const title = e.target.closest('[data-rename]');
  if (title) {
    startRename(title);
    return;
  }

  const row = e.target.closest('[data-trip]');
  if (row) {
    toggleTrip(row.dataset);
    return;
  }

  // <details> opens itself; we only record it so the next refresh keeps it open.
  const summary = e.target.closest('[data-expand]');
  if (!summary) return;
  const id = summary.dataset.expand;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
});

el.nearby.addEventListener('click', (e) => {
  const row = e.target.closest('[data-trip]');
  if (row) toggleTrip(row.dataset);
});

/** Unfolds the whole trip of one departure underneath its row. */
async function toggleTrip({ trip: key, station, line, destination, planned }) {
  if (openTrip?.key === key) {
    openTrip = null;
    renderActiveView();
    return;
  }

  openTrip = { key, state: 'loading' };
  renderActiveView();

  try {
    const stops = await tripStops(station, { line, destination, planned: Number(planned) });
    if (openTrip?.key !== key) return; // something else was opened meanwhile
    openTrip = { key, state: 'ok', stops };
  } catch (err) {
    if (openTrip?.key !== key) return;
    openTrip = { key, state: 'error', message: `Fahrtverlauf nicht verfügbar: ${err.message}` };
  }
  renderActiveView();
}

function startRename(title) {
  const uid = title.dataset.rename;
  const fav = loadFavorites().find((f) => f.uid === uid);
  if (!fav) return;

  const input = document.createElement('input');
  input.className = 'rename';
  input.value = fav.label ?? '';
  input.placeholder = fav.name;
  title.replaceWith(input);
  input.focus();

  let done = false;
  const finish = (save) => {
    if (done) return; // blur fires again once the re-render removes the input
    done = true;
    if (save) updateFavorite(uid, (f) => (f.label = input.value.trim()));
    renderFavorites();
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
}

// ---- Tabs and auto refresh -------------------------------------------------

function syncTabs() {
  el.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === activeView));
  el.views.forEach((v) => v.classList.toggle('active', v.dataset.view === activeView));
}

el.tabs.forEach((tab) =>
  tab.addEventListener('click', () => {
    activeView = tab.dataset.tab;
    syncTabs();
    renderActiveView();
  })
);

// Departure times go stale by the second, so reload regularly — but only while
// the page is actually visible.
function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') renderActiveView();
  }, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderActiveView();
});

// ---- Service worker --------------------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      // Returning to the app is the moment to notice a new deploy.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // Offline this check simply fails; that is expected, not an error.
        reg.update().catch((err) => console.debug('Update-Prüfung fehlgeschlagen:', err.message));
      });
    })
    .catch((err) => console.warn('Service Worker nicht registriert:', err));
}

syncTabs();
syncCompact();
renderActiveView();
startRefresh();
