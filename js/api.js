// Klient for Enturs åpne API-er (https://developer.entur.no/apis/open)
//  - Journey Planner v3 (GraphQL): avganger, linjer, linjetraséer
//  - Geocoder v1 (REST): søk etter holdeplasser / holdeplasser i nærheten
//  - Vehicles v2 (GraphQL): sanntidsposisjoner (GPS) for kjøretøy – spørring + abonnement (WebSocket)
//
// Entur ber alle klienter identifisere seg med headeren ET-Client-Name
// på formen "<organisasjon>-<applikasjon>".

export const CLIENT_NAME = 'minbuss-web';

const JP_URL = 'https://api.entur.io/journey-planner/v3/graphql';
const VEHICLES_URL = 'https://api.entur.io/realtime/v2/vehicles/graphql';
const VEHICLES_WS_URL = 'wss://api.entur.io/realtime/v2/vehicles/subscriptions';
const GEOCODER_URL = 'https://api.entur.io/geocoder/v1';

const HEADERS = { 'ET-Client-Name': CLIENT_NAME };

async function gql(url, query, variables = {}, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`Entur svarte ${res.status}`);
  const json = await res.json();
  if (json.errors?.length && !json.data) throw new Error(json.errors[0].message);
  return json.data;
}

// ---------- Geocoder ----------

function mapFeature(f) {
  const p = f.properties;
  return {
    id: p.id,
    name: p.name,
    locality: p.locality || p.county || '',
    categories: p.category || [],
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    distance: p.distance, // km, kun ved reverse
  };
}

const isStopPlace = (s) => s.id?.startsWith('NSR:StopPlace:');

export async function searchStops(text, signal) {
  const q = new URLSearchParams({ text, layers: 'venue', size: '12', lang: 'no' });
  const res = await fetch(`${GEOCODER_URL}/autocomplete?${q}`, { headers: HEADERS, signal });
  if (!res.ok) throw new Error(`Søk feilet (${res.status})`);
  const json = await res.json();
  return json.features.map(mapFeature).filter(isStopPlace);
}

export async function nearbyStops(lat, lon, signal) {
  const q = new URLSearchParams({
    'point.lat': lat, 'point.lon': lon,
    'boundary.circle.radius': '1.5', layers: 'venue', size: '15',
  });
  const res = await fetch(`${GEOCODER_URL}/reverse?${q}`, { headers: HEADERS, signal });
  if (!res.ok) throw new Error(`Søk feilet (${res.status})`);
  const json = await res.json();
  return json.features.map(mapFeature).filter(isStopPlace);
}

// ---------- Journey Planner ----------

const LINE_FIELDS = `
  id publicCode name transportMode transportSubmode
  presentation { colour textColour }
  authority { id name }
`;

export function normalizeLine(l) {
  return {
    id: l.id,
    publicCode: l.publicCode || '',
    name: l.name || '',
    mode: l.transportMode || 'bus',
    submode: l.transportSubmode || '',
    colour: l.presentation?.colour ? `#${l.presentation.colour}` : null,
    textColour: l.presentation?.textColour ? `#${l.presentation.textColour}` : null,
    authority: l.authority?.name || '',
  };
}

/** Søk etter linjer på linjenummer og/eller navn. */
export async function searchLines(text, signal) {
  const query = `query($q: String!) {
    byCode: lines(publicCode: $q) { ${LINE_FIELDS} }
    byName: lines(name: $q) { ${LINE_FIELDS} }
  }`;
  const data = await gql(JP_URL, query, { q: text.trim() }, signal);
  const seen = new Map();
  for (const l of [...(data.byCode || []), ...(data.byName || [])]) {
    if (!seen.has(l.id)) seen.set(l.id, normalizeLine(l));
  }
  return [...seen.values()].slice(0, 50);
}

/** Alle linjer som betjener en holdeplass. */
export async function linesForStop(stopId, signal) {
  const query = `query($id: String!) {
    stopPlace(id: $id) { id quays { lines { ${LINE_FIELDS} } } }
  }`;
  const data = await gql(JP_URL, query, { id: stopId }, signal);
  const seen = new Map();
  for (const q of data.stopPlace?.quays || []) {
    for (const l of q.lines || []) if (!seen.has(l.id)) seen.set(l.id, normalizeLine(l));
  }
  return [...seen.values()].sort((a, b) =>
    a.publicCode.localeCompare(b.publicCode, 'nb', { numeric: true }));
}

/**
 * Henter neste avganger for flere holdeplasser i én spørring.
 * @param {{id:string, lineIds?:string[]}[]} stops
 */
export async function departures(stops, { count = 12, signal } = {}) {
  if (!stops.length) return {};
  const parts = stops.map((s, i) => {
    const wl = s.lineIds?.length ? `, whiteListed: { lines: ${JSON.stringify(s.lineIds)} }` : '';
    return `s${i}: stopPlace(id: ${JSON.stringify(s.id)}) {
      id name
      estimatedCalls(numberOfDepartures: ${count}, timeRange: 43200, includeCancelledTrips: true${wl}) {
        realtime cancellation predictionInaccurate
        aimedDepartureTime expectedDepartureTime
        occupancyStatus
        destinationDisplay { frontText via }
        quay { id publicCode name }
        serviceJourney { id line { ${LINE_FIELDS} } }
        situations { summary { value language } }
      }
    }`;
  });
  const data = await gql(JP_URL, `{ ${parts.join('\n')} }`, {}, signal);
  const out = {};
  stops.forEach((s, i) => {
    const sp = data[`s${i}`];
    out[s.id] = (sp?.estimatedCalls || []).map((c) => ({
      key: `${c.serviceJourney.id}|${c.aimedDepartureTime}`,
      realtime: c.realtime,
      cancelled: c.cancellation,
      inaccurate: c.predictionInaccurate,
      aimed: new Date(c.aimedDepartureTime),
      expected: new Date(c.expectedDepartureTime),
      occupancy: c.occupancyStatus,
      destination: c.destinationDisplay?.frontText || '',
      via: c.destinationDisplay?.via || [],
      quay: c.quay?.publicCode || '',
      line: normalizeLine(c.serviceJourney.line),
      situations: (c.situations || [])
        .map((x) => (x.summary.find((t) => t.language?.startsWith('n')) || x.summary[0])?.value)
        .filter(Boolean),
    }));
  });
  return out;
}

/** Traséer (polylinjer) for en linje – én per unike journeyPattern. */
export async function lineShapes(lineId, signal) {
  const query = `query($id: ID!) {
    line(id: $id) { id journeyPatterns { id directionType pointsOnLink { points } } }
  }`;
  const data = await gql(JP_URL, query, { id: lineId }, signal);
  const uniq = new Set();
  const shapes = [];
  for (const jp of data.line?.journeyPatterns || []) {
    const pts = jp.pointsOnLink?.points;
    if (pts && !uniq.has(pts)) {
      uniq.add(pts);
      shapes.push(decodePolyline(pts));
    }
  }
  return shapes;
}

// ---------- Vehicles ----------

const VEHICLE_FIELDS = `
  vehicleId
  line { lineRef publicCode lineName }
  mode
  location { latitude longitude }
  bearing delay inCongestion occupancyStatus
  destinationName originName
  lastUpdated
`;

export function normalizeVehicle(v, lineId) {
  if (!v?.location) return null;
  return {
    id: v.vehicleId,
    lineId: lineId || v.line?.lineRef,
    publicCode: v.line?.publicCode,
    lat: v.location.latitude,
    lon: v.location.longitude,
    bearing: v.bearing,
    delay: v.delay, // sekunder
    congestion: v.inCongestion,
    occupancy: v.occupancyStatus,
    destination: v.destinationName,
    origin: v.originName,
    lastUpdated: v.lastUpdated ? new Date(v.lastUpdated) : null,
    mode: (v.mode || '').toLowerCase(),
  };
}

/** Sanntidsposisjoner (GPS) for kjøretøy på gitte linjer – ett øyeblikksbilde. */
export async function vehicles(lineIds, signal) {
  if (!lineIds.length) return [];
  const parts = lineIds.map((id, i) => `v${i}: vehicles(lineRef: ${JSON.stringify(id)}) { ${VEHICLE_FIELDS} }`);
  const data = await gql(VEHICLES_URL, `{ ${parts.join('\n')} }`, {}, signal);
  const out = [];
  lineIds.forEach((id, i) => {
    for (const v of data[`v${i}`] || []) {
      const n = normalizeVehicle(v, id);
      if (n) out.push(n);
    }
  });
  return out;
}

/** Ferskeste posisjon for ett bestemt kjøretøy (brukes når en buss er valgt i kartet). */
export async function vehicleById(vehicleId, signal) {
  const data = await gql(VEHICLES_URL, `query($id: String) { vehicles(vehicleId: $id) { ${VEHICLE_FIELDS} } }`, { id: vehicleId }, signal);
  return normalizeVehicle((data.vehicles || [])[0]);
}

/**
 * Strømmer posisjonsoppdateringer via GraphQL-abonnement (protokollen graphql-transport-ws).
 * Leverer kun kjøretøy som har endret seg; kombineres med vehicles() for fullt bilde.
 * Kobler til på nytt med økende ventetid. Returnerer en funksjon som stenger strømmen.
 * @param {string[]} lineIds
 * @param {(vs: object[]) => void} onVehicles
 * @param {(state: 'connecting'|'live'|'down') => void} [onState]
 */
export function subscribeVehicles(lineIds, onVehicles, onState = () => {}) {
  let ws = null, closed = false, retry = 0, retryTimer = null, pingTimer = null;
  const connect = () => {
    if (closed || !lineIds.length) return;
    onState('connecting');
    try {
      ws = new WebSocket(`${VEHICLES_WS_URL}?ET-Client-Name=${encodeURIComponent(CLIENT_NAME)}`, 'graphql-transport-ws');
    } catch { schedule(); return; }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: { 'ET-Client-Name': CLIENT_NAME } }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'connection_ack') {
        retry = 0;
        onState('live');
        lineIds.forEach((id, i) => ws.send(JSON.stringify({
          id: `l${i}`, type: 'subscribe',
          payload: { query: `subscription { vehicles(lineRef: ${JSON.stringify(id)}) { ${VEHICLE_FIELDS} } }` },
        })));
        clearInterval(pingTimer);
        pingTimer = setInterval(() => { if (ws?.readyState === 1) ws.send('{"type":"ping"}'); }, 25000);
      } else if (msg.type === 'ping') {
        ws.send('{"type":"pong"}');
      } else if (msg.type === 'next') {
        const i = Number(String(msg.id).slice(1));
        const raw = msg.payload?.data?.vehicles;
        const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((v) => normalizeVehicle(v, lineIds[i])).filter(Boolean);
        if (list.length) onVehicles(list);
      }
    };
    ws.onclose = () => { clearInterval(pingTimer); if (!closed) { onState('down'); schedule(); } };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  const schedule = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(60000, 2000 * 2 ** retry++) + Math.random() * 1000);
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retryTimer); clearInterval(pingTimer);
    if (ws && ws.readyState <= 1) { try { ws.close(1000); } catch {} }
  };
}

// ---------- Hjelpere ----------

export function decodePolyline(str, precision = 5) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  const factor = 10 ** precision;
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
