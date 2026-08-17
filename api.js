// Access to the unofficial MVG API. Deliberately the only place in the project
// that knows a URL: if MVG closes the CORS headers, this is where we switch to
// our own proxy, without touching the rest of the app.
const BASE = 'https://www.mvg.de/api/bgw-pt/v3';

// The API returns times as millisecond epochs. The UI thinks in minutes, so
// convert once here instead of at every display site.
function minutesUntil(epochMs) {
  return Math.round((epochMs - Date.now()) / 60000);
}

async function get(path, params) {
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
    transportTypes: raw.transportTypes ?? [],
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
    inMinutes: minutesUntil(d.realtimeDepartureTime),
    // delayInMinutes is absent in the normal case and only set on deviation
    delay: d.delayInMinutes ?? 0,
    cancelled: d.cancelled,
    platform: d.platform,
  }));
}
