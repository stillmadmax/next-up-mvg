import { searchStations, nearbyStations, departures } from './api.js';

// Im Naehe-Modus kostet jede Haltestelle einen eigenen Request. Ohne Deckel
// wird ein Seitenaufruf schnell zu 30 Anfragen gegen eine inoffizielle API.
const NEARBY_MAX_STATIONS = 6;
const NEARBY_RADIUS_METERS = 1000;
const DEPARTURES_PER_STATION = 4;
const FAVORITE_DEPARTURES = 10;
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

// ---- Favoriten (nur clientseitig; ein Nutzer, ein Geraet) -------------------

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
  list.push({ id: station.id, name: station.name, place: station.place });
  saveFavorites(list);
}

function removeFavorite(id) {
  saveFavorites(loadFavorites().filter((s) => s.id !== id));
}

// ---- Rendern ---------------------------------------------------------------

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

function stationCard(station, deps, { removable = false } = {}) {
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
        const deps = await departures(station.id, FAVORITE_DEPARTURES);
        return stationCard(station, deps, { removable: true });
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

// ---- Suche -----------------------------------------------------------------

let searchTimer = null;

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = el.search.value.trim();
  if (query.length < 3) {
    el.results.innerHTML = '';
    return;
  }
  // Entprellt, damit nicht jeder Tastendruck einen Request auslöst.
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
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  removeFavorite(btn.dataset.remove);
  renderFavorites();
});

// ---- Tabs und Auto-Refresh -------------------------------------------------

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

// Abfahrtszeiten veralten im Sekundentakt, deshalb regelmaessig neu laden —
// aber nur, solange die Seite sichtbar ist.
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
