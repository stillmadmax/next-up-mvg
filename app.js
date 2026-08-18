import { searchStations, nearbyStations, departures, stationLines, tripStops } from './api.js';
import {
  store,
  loadFavorites,
  updateFavorite,
  addFavorite,
  moveFavorite,
  moveSection,
  removeFavorite,
  setGroup,
  setIcon,
  favoriteGroups,
  favoriteSections,
  toggleLine,
  toggleDestination,
  learnRoutes,
} from './storage.js';

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

// A fixed palette rather than free input: it needs no keyboard and looks the
// same on every platform. The empty entry is the "no icon" chip.
const FAVORITE_ICONS = ['', '🏠', '🏢', '🎓', '🛒', '🚉', '🏋️', '❤️', '✈️'];

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

let activeView = 'favoriten';
let compact = store.get('compact') === '1';

// ---- Known lines per station ------------------------------------------------

// The departures list only reaches ~75 minutes ahead, so at 23:00 it knows
// nothing about the rush hour express bus. The lines endpoint does, and the
// answer never changes within a session — so ask it once per station.
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

// ---- Rendering -------------------------------------------------------------

// Everything here builds markup by interpolating strings, and most of those
// strings come from the API or from a name the user typed. Escape them at every
// leaf: a station called `Foo & Bar` would otherwise mangle the markup, and a
// quote in an attribute would let the value break out of it entirely.
// Values read back via dataset need no counterpart — the parser decodes them.
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

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
    return `<li class="trip"><p class="status">${esc(openTrip.message)}</p></li>`;
  }

  const stops = openTrip.stops
    .map(
      (s) =>
        `<li><span class="at">${clockTime(s.at)}</span><span class="stop">${esc(s.name)}</span></li>`
    )
    .join('');
  return `<li class="trip"><ol>${stops}</ol><p class="note">Planzeiten</p></li>`;
}

// Line badge and countdown look the same in both views, so build them once.
function lineBadge(d) {
  // hasOwn, not a plain lookup: a transportType of "constructor" or "toString"
  // would otherwise inherit from Object.prototype and skip the fallback.
  const color = d.sev
    ? LINE_COLORS.SEV
    : Object.hasOwn(LINE_COLORS, d.type)
      ? LINE_COLORS[d.type]
      : '#666';
  // A replacement bus keeps the rail label, so the badge alone would say "U6"
  // and send you down to a platform with no train. Colour is not enough on its
  // own — it has to survive colour blindness and a glance — hence the marker.
  const sev = d.sev ? '<span class="sev" title="Schienenersatzverkehr">SEV</span>' : '';
  return `<span class="line" style="background:${color}">${esc(d.line)}</span>${sev}`;
}

function whenLabel(d) {
  const when = d.inMinutes <= 0 ? 'jetzt' : `${d.inMinutes} min`;
  return `<span class="when">${d.cancelled ? 'entfällt' : when}</span>`;
}

function departureRow(d, stationId) {
  const delay = d.delay > 0 ? `<span class="delay">+${d.delay}</span>` : '';
  const key = tripKey(stationId, d);
  const open = openTrip?.key === key;

  return `
    <li class="${d.cancelled ? 'cancelled' : ''}${open ? ' open' : ''}">
      <button class="row" data-trip="${esc(key)}" data-station="${esc(stationId)}"
        data-line="${esc(d.line)}" data-destination="${esc(d.destination)}"
        data-planned="${d.planned}">
        ${lineBadge(d)}
        <span class="dest">${esc(d.destination)}</span>
        ${delay}
        <span class="at">${clockTime(d.at)}</span>
        ${whenLabel(d)}
      </button>
    </li>
    ${open ? tripPanel() : ''}`;
}

// Which favorites the user has expanded. Kept in memory only: it is view state,
// and the auto refresh rebuilds the markup every 30 s.
const expanded = new Set();

// The favorite whose icon/group row is open, at most one — same reasoning.
let editing = null;

function departureList(uid, deps, stationId, collapsible) {
  const rows = (list) => list.map((d) => departureRow(d, stationId)).join('');
  if (!collapsible || deps.length <= FAVORITE_VISIBLE) {
    return `<ul>${rows(deps)}</ul>`;
  }

  const rest = deps.slice(FAVORITE_VISIBLE);
  return `
    <ul>${rows(deps.slice(0, FAVORITE_VISIBLE))}</ul>
    <details ${expanded.has(uid) ? 'open' : ''}>
      <summary data-expand="${esc(uid)}">${rest.length} weitere</summary>
      <ul>${rows(rest)}</ul>
    </details>`;
}

function chipRow(uid, attribute, values, selected) {
  if (values.length < 2) return '';
  return `<div class="lines">${values
    .map(
      (v) =>
        `<button class="chip${selected.includes(v) ? ' on' : ''}" data-uid="${esc(uid)}"
           data-${attribute}="${esc(v)}" aria-pressed="${selected.includes(v)}">${esc(v)}</button>`
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

// Icon and group share one disclosure: the card header already carries title,
// subtitle, arrows and remove — two more buttons would not fit a phone.
function editRow(fav, groups) {
  const chip = (attribute, value, text, active, extra = '') =>
    `<button class="chip${extra}${active ? ' on' : ''}" data-uid="${esc(fav.uid)}"
       data-${attribute}="${esc(value)}" aria-pressed="${active}">${text}</button>`;

  // An emoji needs a square chip, a word needs a wide one.
  const icons = FAVORITE_ICONS.map((i) =>
    chip('icon', i, i || 'kein Icon', (fav.icon ?? '') === i, i ? ' glyph' : '')
  ).join('');
  const names = groups
    .map((g) => chip('group', g, esc(g), (fav.group ?? '') === g))
    .join('');

  return `
    <div class="edit">
      <div class="lines">${icons}</div>
      <div class="lines">${names}
        <button class="chip" data-newgroup="${esc(fav.uid)}">+ Gruppe</button></div>
    </div>`;
}

// A section heading carries the same two arrows as a card, one level up. The
// nameless section has no heading to put them in, so it is only ever moved by
// another section passing it.
function sectionHead(name, index, count) {
  if (!name) return '';
  const button = (delta, glyph, label) => {
    const blocked = index + delta < 0 || index + delta >= count;
    return `<button class="move" data-section="${esc(name)}" data-delta="${delta}"
       aria-label="${label}"${blocked ? ' disabled' : ''}>${glyph}</button>`;
  };
  const move = count > 1 ? button(-1, '▲', 'Gruppe nach oben') + button(1, '▼', 'Gruppe nach unten') : '';
  return `<h2 class="grouphead">${esc(name)}${move}</h2>`;
}

// Reordering by arrows, not by dragging: the same two buttons work in the list
// and in the compact grid, on touch as on a mouse. The glyphs follow the layout
// the buttons sit in — vertical in the list, horizontal in the grid.
function moveButtons(uid, index, count, horizontal = false) {
  if (count < 2) return '';
  const button = (delta, glyph, label) => {
    const blocked = index + delta < 0 || index + delta >= count;
    return `<button class="move" data-move="${esc(uid)}" data-delta="${delta}"
       aria-label="${label}"${blocked ? ' disabled' : ''}>${glyph}</button>`;
  };

  return horizontal
    ? button(-1, '‹', 'Nach vorne') + button(1, '›', 'Nach hinten')
    : button(-1, '▲', 'Nach oben') + button(1, '▼', 'Nach unten');
}

function stationCard(
  station,
  deps,
  { favorite = null, chips = '', collapsible = false, move = '', edit = '' } = {}
) {
  const distance = station.distance !== undefined ? `${station.distance} m` : station.place;
  // A renamed favorite keeps the station name as its subtitle — otherwise the
  // card no longer says where "Fahrt heim" actually departs.
  const title = favorite?.label || station.name;
  const sub = favorite?.label ? station.name : distance;

  // Outside the <h2>, so tapping the icon does not start a rename.
  const icon = favorite?.icon ? `<span class="favicon">${esc(favorite.icon)}</span>` : '';

  const head = favorite
    ? `${icon}<h2 data-rename="${esc(favorite.uid)}">${esc(title)}</h2><span class="sub">${esc(sub)}</span>
       <button class="editbtn" data-edit="${esc(favorite.uid)}" aria-label="Icon und Gruppe"
         aria-expanded="${!!edit}">✎</button>
       ${move}
       <button class="remove" data-remove="${esc(favorite.uid)}" aria-label="Favorit entfernen">×</button>`
    : `<h2>${esc(title)}</h2><span class="sub">${esc(sub)}</span>`;

  const body = deps.length
    ? departureList(favorite?.uid, deps, station.id, collapsible)
    : '<p class="empty">Keine Abfahrten</p>';

  return `
    <section class="station">
      <header>${head}</header>
      ${edit}
      ${chips}
      ${body}
    </section>`;
}

function compactTile(fav, deps, move) {
  // Same open/closed state as the list view — it is the same favorite.
  const open = expanded.has(fav.uid);
  const visible = open ? deps.length : COMPACT_DEPARTURES;
  const hidden = deps.length - COMPACT_DEPARTURES;

  const rows = deps.slice(0, visible).map(
    (d) => `
      <li class="${d.cancelled ? 'cancelled' : ''}">
        ${lineBadge(d)}
        <span class="at">${clockTime(d.at)}</span>
        ${whenLabel(d)}
      </li>`
  );

  const more =
    hidden > 0
      ? `<button class="more" data-tile="${esc(fav.uid)}">${open ? 'weniger' : `${hidden} weitere`}</button>`
      : '';

  return `
    <section class="tile">
      <div class="tilehead"><h3>${fav.icon ? `${esc(fav.icon)} ` : ''}${esc(fav.label || fav.name)}</h3>${move}</div>
      ${rows.length ? `<ul>${rows.join('')}</ul>` : '<p class="empty">Keine Abfahrten</p>'}
      ${more}
    </section>`;
}

function setStatus(container, message) {
  container.className = ''; // a status line is never part of the compact grid
  // Callers pass error texts through here, and those carry API strings.
  container.innerHTML = `<p class="status">${esc(message)}</p>`;
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

    const sections = favoriteSections(favorites);
    const groups = favoriteGroups();
    // The arrows reorder inside a section, so their position is the one inside
    // it — not the index in the flat list.
    const inSection = new Map();
    for (const [, list] of sections) {
      list.forEach((fav, index) => inSection.set(fav.uid, [index, list.length]));
    }

    const cards = new Map(
      await Promise.all(
        favorites.map(async (fav) => {
          const all = await fetchOnce(fav.id);
          const lines = fav.lines ?? [];
          const dests = fav.destinations ?? [];
          const lineFiltered = lines.length ? all.filter((d) => lines.includes(d.line)) : all;
          const shown = (dests.length
            ? lineFiltered.filter((d) => dests.includes(d.destination))
            : lineFiltered
          ).slice(0, FAVORITE_DEPARTURES);

          const [index, count] = inSection.get(fav.uid);
          const move = moveButtons(fav.uid, index, count, compact);
          if (compact) return [fav.uid, compactTile(fav, shown, move)];

          const known = await stationLinesCached(fav.id);
          const routes = learnRoutes(fav.id, all);
          return [
            fav.uid,
            stationCard(fav, shown, {
              favorite: fav,
              chips: filterChips(fav, [...known, ...all.map((d) => d.line)], routes),
              collapsible: true,
              move,
              edit: editing === fav.uid ? editRow(fav, groups) : '',
            }),
          ];
        })
      )
    );

    el.favorites.className = '';
    el.favorites.innerHTML = sections
      .map(([name, list], index) => {
        const body = list.map((fav) => cards.get(fav.uid)).join('');
        return (
          sectionHead(name, index, sections.length) +
          (compact ? `<div class="grid">${body}</div>` : body)
        );
      })
      .join('');
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
            `<li><button data-add="${esc(s.id)}" data-name="${esc(s.name)}" data-place="${esc(s.place)}">${esc(s.name)}<span>${esc(s.place)}</span></button></li>`
        )
        .join('');
    } catch (err) {
      el.results.innerHTML = `<li class="status">Fehler: ${esc(err.message)}</li>`;
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
    // The × sits next to the title on a small screen, so a stray tap is easy
    // and the loss — name, line and direction filters — is not undoable.
    const fav = loadFavorites().find((f) => f.uid === remove.dataset.remove);
    if (!fav) return; // already gone; nothing to ask about and nothing to remove
    if (!confirm(`„${fav.label || fav.name}“ aus den Favoriten entfernen?`)) return;
    removeFavorite(fav.uid);
    renderFavorites();
    return;
  }

  const section = e.target.closest('[data-section]');
  if (section) {
    moveSection(section.dataset.section, Number(section.dataset.delta));
    renderFavorites();
    return;
  }

  const move = e.target.closest('[data-move]');
  if (move) {
    moveFavorite(move.dataset.move, Number(move.dataset.delta));
    renderFavorites();
    return;
  }

  const edit = e.target.closest('[data-edit]');
  if (edit) {
    editing = editing === edit.dataset.edit ? null : edit.dataset.edit;
    renderFavorites();
    return;
  }

  // Icon and group chips carry .chip too, so they are handled before the
  // filter chips below — otherwise they would fall through to the filters.
  const icon = e.target.closest('[data-icon]');
  if (icon) {
    setIcon(icon.dataset.uid, icon.dataset.icon);
    renderFavorites();
    return;
  }

  const group = e.target.closest('[data-group]');
  if (group) {
    const uid = group.dataset.uid;
    const current = loadFavorites().find((f) => f.uid === uid)?.group ?? '';
    // Tapping the active group again is how a favorite leaves it.
    setGroup(uid, current === group.dataset.group ? '' : group.dataset.group);
    renderFavorites();
    return;
  }

  const newGroup = e.target.closest('[data-newgroup]');
  if (newGroup) {
    const name = prompt('Name der Gruppe')?.trim();
    if (name) setGroup(newGroup.dataset.newgroup, name);
    renderFavorites();
    return;
  }

  const chip = e.target.closest('.chip');
  if (chip) {
    if (chip.dataset.line) toggleLine(chip.dataset.uid, chip.dataset.line);
    else if (chip.dataset.destination) toggleDestination(chip.dataset.uid, chip.dataset.destination);
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
setInterval(() => {
  if (document.visibilityState === 'visible') renderActiveView();
}, REFRESH_MS);

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
