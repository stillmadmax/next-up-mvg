// Everything the app keeps on the device: favorites and the directions each
// station has been seen serving. One user, one device — there is no sync.

// localStorage belongs to the origin, and on github.io that is the whole
// account — every project published there shares this namespace. Hence the
// prefix: another project's "favorites" must not collide with ours.
const PREFIX = 'nextup:';
const OWN_KEYS = (key) => key === 'favorites' || key === 'compact' || key.startsWith('routes:');

export const store = {
  get: (key) => localStorage.getItem(PREFIX + key),
  set: (key, value) => localStorage.setItem(PREFIX + key, value),
};

// Earlier versions wrote these keys unprefixed; move them once.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith(PREFIX) || !OWN_KEYS(key)) continue;
  localStorage.setItem(PREFIX + key, localStorage.getItem(key));
  localStorage.removeItem(key);
}

// ---- Favorites --------------------------------------------------------------

// A favorite is a named, filtered view of a station — the same station can be in
// the list twice, e.g. "Fahrt heim" and "Fahrt los" with opposite directions.
// Hence uid: the station id no longer identifies a card.
export function loadFavorites() {
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

export function updateFavorite(uid, change) {
  const list = loadFavorites();
  const fav = list.find((f) => f.uid === uid);
  if (!fav) return;
  change(fav);
  saveFavorites(list);
}

export function addFavorite(station) {
  const list = loadFavorites();
  list.push({
    uid: `${station.id}-${list.length}-${Date.now()}`,
    id: station.id,
    name: station.name,
    place: station.place,
    label: '', // user-given name; empty falls back to the station name
    icon: '', // emoji shown before the title; empty means none
    group: '', // section heading; empty means the unnamed section
    lines: [], // selected line labels; empty means "show everything"
    destinations: [], // selected directions, same convention
  });
  saveFavorites(list);
}

// The list order is the display order, in both views — hence a swap with the
// neighbour rather than a sort key. Sections are only a grouping of this list,
// so the swap skips over cards of other groups: an arrow must not silently move
// a card into a section the user did not aim for.
export function moveFavorite(uid, delta) {
  const list = loadFavorites();
  const from = list.findIndex((f) => f.uid === uid);
  if (from < 0) return;

  const group = list[from].group ?? '';
  const step = Math.sign(delta);
  let to = from + step;
  while (to >= 0 && to < list.length && (list[to].group ?? '') !== group) to += step;
  if (to < 0 || to >= list.length) return;

  [list[from], list[to]] = [list[to], list[from]];
  saveFavorites(list);
}

export function setGroup(uid, group) {
  updateFavorite(uid, (fav) => (fav.group = group));
}

export function setIcon(uid, icon) {
  updateFavorite(uid, (fav) => (fav.icon = icon));
}

/** Group names in the order their first card appears — that is the section order. */
export function favoriteGroups() {
  const names = [];
  for (const fav of loadFavorites()) {
    if (fav.group && !names.includes(fav.group)) names.push(fav.group);
  }
  return names;
}

export function removeFavorite(uid) {
  saveFavorites(loadFavorites().filter((f) => f.uid !== uid));
}

export function toggleLine(uid, line) {
  updateFavorite(uid, (fav) => {
    const lines = fav.lines ?? [];
    fav.lines = lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line];
    // A direction belongs to a line, so a changed line filter can leave a
    // selected direction invisible — and then unselectable. Reset it instead.
    fav.destinations = [];
  });
}

export function toggleDestination(uid, destination) {
  updateFavorite(uid, (fav) => {
    const dests = fav.destinations ?? [];
    fav.destinations = dests.includes(destination)
      ? dests.filter((d) => d !== destination)
      : [...dests, destination];
  });
}

// ---- Known directions per station -------------------------------------------

// The departures list only reaches ~75 minutes ahead, so at night it knows
// nothing about the direction that stops running after 20:00. There is no
// endpoint for this, so directions are remembered as they are seen.
function knownRoutes(stationId) {
  try {
    return JSON.parse(store.get(`routes:${stationId}`) ?? '[]');
  } catch {
    return [];
  }
}

/** Remembers which directions a line was seen going in, for the filter chips. */
export function learnRoutes(stationId, deps) {
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
