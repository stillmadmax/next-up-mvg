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

  // Groups were introduced without this guarantee, so a list saved then can
  // interleave them. Everything below relies on a group being one run.
  const grouped = flatten(favoriteSections(list));
  if (grouped.some((f, i) => f !== list[i])) {
    saveFavorites(grouped);
    return grouped;
  }
  return list;
}

/**
 * The favorites grouped into display sections, in section order: a group sits
 * where its first card does, and the cards without one form the section with no
 * name. The flat list stays the single source of order — a section is only a run
 * of it, which is what lets a whole section move by swapping two runs.
 */
export function favoriteSections(list) {
  const sections = new Map();
  for (const fav of list) {
    const key = fav.group ?? '';
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(fav);
  }
  return [...sections];
}

// Empty sections disappear on their own — a run of nothing contributes nothing.
function flatten(sections) {
  return sections.flatMap(([, items]) => items);
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
// neighbour rather than a sort key.
export function moveFavorite(uid, delta) {
  const list = loadFavorites();
  const from = list.findIndex((f) => f.uid === uid);
  const to = from + Math.sign(delta);
  if (from < 0 || to < 0 || to >= list.length) return;
  // At the edge of its section the neighbour belongs to another group. Moving
  // the card there would change its group behind the user's back; that is what
  // moveSection and the group chips are for.
  if ((list[to].group ?? '') !== (list[from].group ?? '')) return;

  [list[from], list[to]] = [list[to], list[from]];
  saveFavorites(list);
}

/** Swaps a whole section with its neighbouring one, cards and all. */
export function moveSection(group, delta) {
  const sections = favoriteSections(loadFavorites());
  const from = sections.findIndex(([name]) => name === group);
  const to = from + Math.sign(delta);
  if (from < 0 || to < 0 || to >= sections.length) return;

  [sections[from], sections[to]] = [sections[to], sections[from]];
  saveFavorites(flatten(sections));
}

// The card joins its new section at the end, and the list is rewritten section
// by section: otherwise a card keeping its old index would drag the section
// order with it — a group is where its *first* card is.
export function setGroup(uid, group) {
  const list = loadFavorites();
  const fav = list.find((f) => f.uid === uid);
  if (!fav) return;

  const sections = favoriteSections(list).map(([name, items]) => [
    name,
    items.filter((f) => f.uid !== uid),
  ]);
  fav.group = group;
  const target = sections.find(([name]) => name === group);
  if (target) target[1].push(fav);
  else sections.push([group, [fav]]);

  saveFavorites(flatten(sections));
}

export function setIcon(uid, icon) {
  updateFavorite(uid, (fav) => (fav.icon = icon));
}

/** The named sections, in section order. */
export function favoriteGroups() {
  return favoriteSections(loadFavorites())
    .map(([name]) => name)
    .filter(Boolean);
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
