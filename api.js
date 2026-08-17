// Zugriff auf die inoffizielle MVG-API. Bewusst die einzige Stelle im Projekt,
// die eine URL kennt: falls MVG die CORS-Header schliesst, wird hier auf einen
// eigenen Proxy umgestellt, ohne den Rest der App anzufassen.
const BASE = 'https://www.mvg.de/api/bgw-pt/v3';

// Die API liefert Zeiten als Millisekunden-Epoch. Im UI rechnen wir in Minuten,
// also wird hier einmal umgerechnet statt an jeder Anzeigestelle.
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
    // nur von /stations/nearby geliefert
    distance: raw.distanceInMeters,
  };
}

/** Haltestellen per Namenssuche. Filtert Adressen und POIs heraus. */
export async function searchStations(query) {
  const raw = await get('/locations', { query });
  return raw.filter((r) => r.type === 'STATION').map(toStation);
}

/**
 * Haltestellen in der Umgebung. Die API kennt keinen Radius-Parameter, liefert
 * aber distanceInMeters pro Treffer — damit ist das Filtern exakt und wir
 * brauchen keine eigene Distanzberechnung.
 */
export async function nearbyStations(latitude, longitude, radiusMeters) {
  const raw = await get('/stations/nearby', { latitude, longitude });
  return raw
    .map(toStation)
    .filter((s) => s.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

/** Naechste Abfahrten einer Haltestelle. */
export async function departures(stationId, limit = 10) {
  const raw = await get('/departures', {
    globalId: stationId,
    limit,
    offsetInMinutes: 0,
  });

  // Die API behandelt limit als Naeherung und liefert teils einen Eintrag mehr,
  // deshalb hier hart abschneiden.
  return raw.slice(0, limit).map((d) => ({
    line: d.label,
    destination: d.destination,
    type: d.transportType,
    inMinutes: minutesUntil(d.realtimeDepartureTime),
    // delayInMinutes fehlt im Normalfall und steht nur bei Abweichung drin
    delay: d.delayInMinutes ?? 0,
    cancelled: d.cancelled,
    platform: d.platform,
  }));
}
