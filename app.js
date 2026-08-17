import { searchStations, nearbyStations, departures } from './api.js';

// In nearby mode every station costs its own request. Without a cap a single
// page load turns into ~30 requests against an unofficial API.
const NEARBY_MAX_STATIONS = 6;
const NEARBY_RADIUS_METERS = 1000;
const DEPARTURES_PER_STATION = 4;
const FAVORITE_DEPARTURES = 10;
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
};

let activeView = 'favoriten';
let refreshTimer = null;

// ---- Favorites (client-side only; one user, one device) ---------------------

function loadFavorites() {
  try {
    return JSON.parse(localStorage.getItem('favorites') ?? '[]');
  } catch {
    return [];
  }
}

function saveFavorites(list) {
  localStorage.setItem('favorites', JSON.stringify(list));
}

function addFavorite(station) {
  const list = loadFavorites();
  if (list.some((s) => s.id === station.id)) return;
  // lines: selected line labels; empty means "show everything"
  list.push({ id: station.id, name: station.name, place: station.place, lines: [] });
  saveFavorites(list);
}

function removeFavorite(id) {
  saveFavorites(loadFavorites().filter((s) => s.id !== id));
}

function toggleLine(id, line) {
  const list = loadFavorites();
  const fav = list.find((s) => s.id === id);
  if (!fav) return;
  const lines = fav.lines ?? [];
  fav.lines = lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line];
  saveFavorites(list);
}

// ---- Rendering -------------------------------------------------------------

function departureRow(d) {
  const color = LINE_COLORS[d.type] ?? '#666';
  const when = d.inMinutes <= 0 ? 'jetzt' : `${d.inMinutes} min`;
  const delay = d.delay > 0 ? `<span class="delay">+${d.delay}</span>` : '';

  return `
    <li class="${d.cancelled ? 'cancelled' : ''}">
      <span class="line" style="background:${color}">${d.line}</span>
      <span class="dest">${d.destination}</span>
      ${delay}
      <span class="when">${d.cancelled ? 'entfällt' : when}</span>
    </li>`;
}

/** Toggle chips for every line seen at the station; active ones are the filter. */
function lineChips(station, deps) {
  const selected = station.lines ?? [];
  const lines = [...new Set(deps.map((d) => d.line))].sort((a, b) =>
    a.localeCompare(b, 'de', { numeric: true })
  );
  if (lines.length < 2) return '';

  return `<div class="lines">${lines
    .map(
      (l) =>
        `<button class="chip${selected.includes(l) ? ' on' : ''}" data-station="${station.id}"
           data-line="${l}" aria-pressed="${selected.includes(l)}">${l}</button>`
    )
    .join('')}</div>`;
}

function stationCard(station, deps, { removable = false, chips = '' } = {}) {
  const sub = station.distance !== undefined ? `${station.distance} m` : station.place;
  const remove = removable
    ? `<button class="remove" data-remove="${station.id}" aria-label="Favorit entfernen">×</button>`
    : '';

  const body = deps.length
    ? `<ul>${deps.map(departureRow).join('')}</ul>`
    : '<p class="empty">Keine Abfahrten</p>';

  return `
    <section class="station">
      <header><h2>${station.name}</h2><span class="sub">${sub}</span>${remove}</header>
      ${chips}
      ${body}
    </section>`;
}

function setStatus(container, message) {
  container.innerHTML = `<p class="status">${message}</p>`;
}

// ---- Views -----------------------------------------------------------------

async function renderFavorites() {
  const favorites = loadFavorites();
  if (!favorites.length) {
    setStatus(el.favorites, 'Noch keine Favoriten. Über die Suche unten hinzufügen.');
    return;
  }

  setStatus(el.favorites, 'Lade …');
  try {
    const cards = await Promise.all(
      favorites.map(async (station) => {
        const all = await departures(station.id, FAVORITE_FETCH);
        const filter = station.lines ?? [];
        const shown = (filter.length ? all.filter((d) => filter.includes(d.line)) : all).slice(
          0,
          FAVORITE_DEPARTURES
        );
        return stationCard(station, shown, { removable: true, chips: lineChips(station, all) });
      })
    );
    el.favorites.innerHTML = cards.join('');
  } catch (err) {
    setStatus(el.favorites, `Fehler: ${err.message}`);
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
  setStatus(el.nearby, 'Standort wird ermittelt …');
  try {
    const { latitude, longitude } = await currentPosition();

    setStatus(el.nearby, 'Suche Haltestellen …');
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
    setStatus(el.nearby, `Fehler: ${err.message}`);
  }
}

function renderActiveView() {
  if (activeView === 'favoriten') renderFavorites();
  else renderNearby();
}

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

  const chip = e.target.closest('[data-line]');
  if (!chip) return;
  toggleLine(chip.dataset.station, chip.dataset.line);
  renderFavorites();
});

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

syncTabs();
renderActiveView();
startRefresh();
