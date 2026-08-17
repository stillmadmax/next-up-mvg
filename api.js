// Access to the unofficial MVG API. Deliberately the only place in the project
// that knows a URL: if MVG closes the CORS headers, this is where we switch to
// our own proxy, without touching the rest of the app.
const BASE = 'https://www.mvg.de/api/bgw-pt/v3';

// The API returns times as millisecond epochs. The UI thinks in minutes, so
// convert once here instead of at every display site.
function minutesUntil(epochMs) {
  return Math.round((epochMs - Date.now()) / 60000);
}

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MVG-API ${res.status} bei ${path}`);
  return res.json();
}

function toStation(raw) {
  return {
    id: raw.globalId,
    name: raw.name,
    place: raw.place,
    // only provided by /stations/nearby
    distance: raw.distanceInMeters,
  };
}

/** Stations by name search. Filters out addresses and POIs. */
export async function searchStations(query) {
  const raw = await get('/locations', { query });
  return raw.filter((r) => r.type === 'STATION').map(toStation);
}

/**
 * Stations nearby. The API has no radius parameter but returns
 * distanceInMeters per hit, which makes filtering exact and saves us from
 * computing distances ourselves.
 */
export async function nearbyStations(latitude, longitude, radiusMeters) {
  const raw = await get('/stations/nearby', { latitude, longitude });
  return raw
    .map(toStation)
    .filter((s) => s.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

// The routing search wants a local ISO timestamp with an offset; an epoch or a
// zoneless timestamp is rejected.
function isoLocal(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

/**
 * Every line serving a station, including the ones that only run at night or
 * during rush hour. The departures list alone cannot answer this: it looks at
 * most ~75 minutes ahead, so at 23:00 an express bus simply is not in it.
 */
export async function stationLines(stationId) {
  const raw = await get(`/lines/${encodeURIComponent(stationId)}`);
  return [...new Set(raw.map((l) => l.label))];
}

/** Next departures for a station. */
export async function departures(stationId, limit = 10) {
  const raw = await get('/departures', {
    globalId: stationId,
    limit,
    offsetInMinutes: 0,
  });

  // The API treats limit as an approximation and sometimes returns one entry
  // more, so cut it hard here.
  return raw.slice(0, limit).map((d) => ({
    line: d.label,
    destination: d.destination,
    type: d.transportType,
    at: d.realtimeDepartureTime,
    // The trip lookup below matches on the timetable, not on realtime.
    planned: d.plannedDepartureTime,
    inMinutes: minutesUntil(d.realtimeDepartureTime),
    // delayInMinutes is absent in the normal case and only set on deviation
    delay: d.delayInMinutes ?? 0,
    cancelled: d.cancelled,
    // Rail replacement: keeps the rail line's label ("U6") but runs as a bus,
    // from a different stop. The API flags it, so we don't guess from the label.
    sev: d.sev === true,
  }));
}

/**
 * Every stop of one departure's trip, with the time it is scheduled there.
 *
 * There is no endpoint for a trip, so this reconstructs it from the routing
 * search: a direct connection leaving this station for the departure's
 * destination, on the same line at the same minute, *is* that trip, and its
 * intermediate stops are the ones we want. The times are timetable times — the
 * routing search carries no realtime for intermediate stops.
 */
export async function tripStops(stationId, departure) {
  const targets = await searchStations(departure.destination);
  if (!targets.length) throw new Error('Ziel ist keine Haltestelle');

  const raw = await get('/routes', {
    originStationGlobalId: stationId,
    destinationStationGlobalId: targets[0].id,
    routingDateTime: isoLocal(departure.planned),
  });

  const minute = (t) => Math.floor(new Date(t).getTime() / 60000);
  const trip = raw
    // Only a connection without a change is the whole trip; in a multi-part one
    // our vehicle would end at the interchange, not at the destination.
    .filter((c) => c.parts.length === 1)
    .map((c) => c.parts[0])
    .find(
      (p) => p.line?.label === departure.line && minute(p.from.plannedDeparture) === minute(departure.planned)
    );
  if (!trip) throw new Error('Fahrt nicht gefunden');

  return [trip.from, ...(trip.intermediateStops ?? []), trip.to].map((s) => ({
    // Some nodes carry the city in the name ("München, Ostbahnhof"), most do not.
    name: s.place && s.name.startsWith(`${s.place}, `) ? s.name.slice(s.place.length + 2) : s.name,
    at: new Date(s.plannedDeparture).getTime(),
  }));
}
