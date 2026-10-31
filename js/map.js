// Sanntidskart med Leaflet: kjøretøy på favorittlinjer, traséer og favorittholdeplasser.
import * as api from './api.js';
import { store } from './store.js';
import { lineColors, normMode, esc, delayText, agoText, OCCUPANCY, MODES } from './ui.js';

const L = window.L;
const POLL_MS = 10000;        // uten strøm
const POLL_LIVE_MS = 30000;   // med strøm: kun avstemming (fjerner kjøretøy som er borte)
const STALE_MS = 5 * 60 * 1000;
const FOCUS_MS = 2000;        // oppdateringsintervall for valgt kjøretøy

let map, tiles, stopLayer, shapeLayer, vehicleLayer, meMarker;
let timer = null;
let active = false;
let firstFit = true;
const markers = new Map();      // vehicleId -> { marker, data, anim }
const shapeCache = new Map();   // lineId -> [[lat,lon]...][]
let lastVehicles = [];
const vehState = new Map();     // vehicleId -> kjøretøy
let closeStream = null, streamKey = '', streamState = 'down';
let selectedId = null, selTimer = null, selAbort = null;
let statusEl, chipsEl;

// Kartbakgrunn uten API-nøkkel: Kartverkets åpne gråtonekart (CC BY 4.0).
// Faller tilbake til OpenStreetMap hvis Kartverket ikke svarer. Mørk modus lages med CSS-filter.
const BASEMAPS = [
  {
    url: 'https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png',
    options: { maxZoom: 18, attribution: '© <a href="https://www.kartverket.no/" target="_blank" rel="noopener">Kartverket</a>' },
  },
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
  },
];

function addBasemap(i = 0) {
  const bm = BASEMAPS[i];
  const layer = L.tileLayer(bm.url, { ...bm.options, className: 'basemap' }).addTo(map);
  let errors = 0, loaded = 0;
  layer.on('tileload', () => { loaded++; });
  layer.on('tileerror', () => {
    errors++;
    // Mange feil og ingen vellykkede fliser: bytt til neste kilde.
    if (errors >= 4 && loaded === 0 && i + 1 < BASEMAPS.length) {
      map.removeLayer(layer);
      tiles = addBasemap(i + 1);
    }
  });
  return layer;
}

export function initMap() {
  statusEl = document.getElementById('map-status');
  chipsEl = document.getElementById('map-chips');
  if (!L) { statusEl.textContent = 'Kartbiblioteket kunne ikke lastes.'; return; }

  map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView([60.39, 5.33], 12); // standard: Bergen sentrum
  map.attributionControl.addAttribution('Sanntid © Entur');
  tiles = addBasemap(0);

  shapeLayer = L.layerGroup().addTo(map);
  // Skjul holdeplassnavn når man zoomer langt ut, så kartet ikke blir rotete.
  const labelZoom = () => map.getContainer().classList.toggle('hide-stop-labels', map.getZoom() < 12);
  map.on('zoomend', labelZoom);
  labelZoom();
  stopLayer = L.layerGroup().addTo(map);
  vehicleLayer = L.layerGroup().addTo(map);

  document.getElementById('btn-fit').addEventListener('click', () => fitAll(true));
  document.getElementById('btn-locate').addEventListener('click', locateMe);
  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-line]');
    if (b) store.toggleLineHidden(b.dataset.line);
  });

  store.subscribe(() => { if (active) refreshStatic(); });
  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    document.hidden ? stopPolling() : startPolling();
  });
}

export function showMap() {
  if (!map) return;
  active = true;
  map.invalidateSize(); // kartet var skjult (display:none) – må måle størrelse på nytt
  setTimeout(() => map.invalidateSize(), 250);
  refreshStatic();
  startPolling();
}

export function hideMap() {
  active = false;
  stopPolling();
}

/** Fokusér på én linje (fra avgangslisten). */
export function focusLine(lineId) {
  firstFit = true;
  store.showOnlyLine(lineId);
}

function visibleLines() {
  return store.get().lines.filter((l) => !l.hidden);
}

function renderChips() {
  const lines = store.get().lines;
  if (!lines.length) {
    chipsEl.innerHTML = '';
    return;
  }
  chipsEl.innerHTML = lines.map((l) => {
    const { bg, fg } = lineColors(l);
    const n = lastVehicles.filter((v) => v.lineId === l.id).length;
    return `<button class="chip ${l.hidden ? 'off' : ''}" data-line="${esc(l.id)}" style="--lc:${bg};--lt:${fg}"
      aria-pressed="${!l.hidden}" title="${esc(l.name)}">
      <b>${esc(l.publicCode)}</b>${!l.hidden && active ? `<small>${n}</small>` : ''}</button>`;
  }).join('');
}

async function refreshStatic() {
  renderChips();

  // Favorittholdeplasser
  stopLayer.clearLayers();
  for (const s of store.get().stops) {
    if (s.lat == null) continue;
    L.circleMarker([s.lat, s.lon], {
      radius: 7, weight: 2.5, color: '#fff', fillColor: '#111827', fillOpacity: 0.95,
    }).bindTooltip(esc(s.name), {
      permanent: true, direction: 'right', offset: [9, 0], className: 'stop-label', interactive: false,
    }).addTo(stopLayer);
  }

  // Traséer
  shapeLayer.clearLayers();
  const lines = visibleLines();
  await Promise.all(lines.map(async (l) => {
    if (!shapeCache.has(l.id)) {
      try { shapeCache.set(l.id, await api.lineShapes(l.id)); } catch { shapeCache.set(l.id, []); }
    }
  }));
  shapeLayer.clearLayers();
  for (const l of visibleLines()) {
    const { bg } = lineColors(l);
    for (const pts of shapeCache.get(l.id) || []) {
      L.polyline(pts, { color: bg, weight: 4, opacity: 0.35, interactive: false }).addTo(shapeLayer);
    }
  }
  pollVehicles();
}

function startPolling() {
  stopPolling();
  if (selectedId) startFocusPolling();
  pollVehicles();
  timer = setInterval(pollVehicles, streamState === 'live' ? POLL_LIVE_MS : POLL_MS);
  startStream();
}
function stopPolling() {
  stopFocusPolling();
  clearInterval(timer); timer = null;
  closeStream?.(); closeStream = null; streamKey = ''; streamState = 'down';
}

// Live-strøm av posisjoner (GraphQL-abonnement). Henting over HTTP er reserven.
function startStream() {
  const ids = visibleLines().map((l) => l.id);
  const key = ids.join(',');
  if (key === streamKey && closeStream) return;
  closeStream?.();
  streamKey = key;
  if (!ids.length) { closeStream = null; return; }
  closeStream = api.subscribeVehicles(ids, (vs) => {
    for (const v of vs) vehState.set(v.id, v);
    publish();
  }, (st) => {
    const was = streamState;
    streamState = st;
    if ((was === 'live') !== (st === 'live') && timer) {
      clearInterval(timer);
      timer = setInterval(pollVehicles, st === 'live' ? POLL_LIVE_MS : POLL_MS);
    }
    updateStatus();
  });
}

function publish() {
  const visible = new Set(visibleLines().map((l) => l.id));
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, v] of vehState) {
    if (!visible.has(v.lineId) || (v.lastUpdated && v.lastUpdated.getTime() < cutoff)) vehState.delete(id);
  }
  lastVehicles = [...vehState.values()];
  syncMarkers(lastVehicles);
  renderChips();
  updateStatus();
  if (firstFit && lastVehicles.length) { fitAll(false); firstFit = false; }
}

function updateStatus() {
  if (!active || !visibleLines().length) return;
  const n = lastVehicles.length;
  const sel = selectedId && vehState.get(selectedId);
  if (sel) {
    setStatus(`Følger ${sel.publicCode ? 'linje ' + sel.publicCode : 'kjøretøy'}${sel.destination ? ' → ' + sel.destination : ''} · oppdateres hvert ${FOCUS_MS / 1000}. sekund`);
    return;
  }
  if (!n) { setStatus('Ingen kjøretøy med GPS-posisjon på valgte linjer akkurat nå.', true); return; }
  setStatus(streamState === 'live'
    ? `${n} kjøretøy · live`
    : `${n} kjøretøy · oppdateres hvert ${POLL_MS / 1000}. sekund`);
}

let inflight = null;
async function pollVehicles() {
  const lines = visibleLines();
  if (!store.get().lines.length) {
    setStatus('Legg til favorittlinjer for å se kjøretøy i sanntid.', true);
    vehState.clear(); syncMarkers([]);
    return;
  }
  if (!lines.length) { setStatus('Alle linjer er skjult. Trykk på en linje over for å vise den.', true); vehState.clear(); syncMarkers([]); return; }
  startStream(); // linjeutvalget kan ha endret seg
  inflight?.abort();
  inflight = new AbortController();
  try {
    const vs = await api.vehicles(lines.map((l) => l.id), inflight.signal);
    // Fullt øyeblikksbilde: erstatt tilstanden, men behold nyere strømmede posisjoner.
    const prev = new Map(vehState);
    vehState.clear();
    for (const v of vs) {
      const p = prev.get(v.id);
      vehState.set(v.id, p?.lastUpdated && v.lastUpdated && p.lastUpdated > v.lastUpdated ? p : v);
    }
    publish();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`Kunne ikke hente posisjoner: ${e.message}`, true);
  }
}

function setStatus(text, prominent = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('prominent', prominent);
}

function vehicleIcon(v, line, selected = v.id === selectedId) {
  const { bg, fg } = lineColors(line || { mode: v.mode });
  const stale = v.lastUpdated && Date.now() - v.lastUpdated.getTime() > STALE_MS;
  const arrow = v.bearing != null
    ? `<i class="veh-arrow" style="transform:rotate(${Math.round(v.bearing)}deg)"></i>` : '';
  return L.divIcon({
    className: 'veh-wrap',
    html: `<div class="veh ${stale ? 'stale' : ''} ${selected ? 'selected' : ''}" style="--lc:${bg};--lt:${fg}">${arrow}<span>${esc(v.publicCode || line?.publicCode || '')}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -16],
  });
}

function popupHtml(v, line) {
  const mode = MODES[normMode(line?.mode || v.mode)].label;
  const rows = [
    v.delay != null ? `<div>${delayText(v.delay)}${v.congestion ? ' · kø' : ''}</div>` : '',
    v.occupancy && OCCUPANCY[v.occupancy] ? `<div>${OCCUPANCY[v.occupancy]}</div>` : '',
    `<div class="muted">Posisjon fra ${agoText(v.lastUpdated)}${v.id === selectedId ? ' · følges tett' : ''}</div>`,
  ].join('');
  return `<div class="veh-pop"><strong>${esc(mode)} ${esc(v.publicCode || line?.publicCode || '')}</strong>
    <div>→ ${esc(v.destination || line?.name || '')}</div>${rows}</div>`;
}

function syncMarkers(vs) {
  const lines = new Map(store.get().lines.map((l) => [l.id, l]));
  const seen = new Set();
  for (const v of vs) {
    seen.add(v.id);
    const line = lines.get(v.lineId);
    const existing = markers.get(v.id);
    if (existing) {
      animateTo(existing, [v.lat, v.lon], v.id === selectedId ? 900 : 1200);
      existing.marker.setIcon(vehicleIcon(v, line));
      existing.marker.setPopupContent(popupHtml(v, line));
      existing.data = v;
    } else {
      const marker = L.marker([v.lat, v.lon], { icon: vehicleIcon(v, line), keyboard: false })
        .bindPopup(popupHtml(v, line), { autoPan: true })
        .addTo(vehicleLayer);
      marker.on('popupopen', () => selectVehicle(v.id));
      marker.on('popupclose', () => { if (selectedId === v.id) selectVehicle(null); });
      markers.set(v.id, { marker, data: v });
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id) && id !== selectedId) { vehicleLayer.removeLayer(m.marker); markers.delete(id); }
  }
}

// ---------- Valgt kjøretøy: tett oppfølging ----------

function selectVehicle(id) {
  const prev = selectedId;
  selectedId = id;
  for (const pid of [prev, id]) {
    const m = pid && markers.get(pid);
    if (!m) continue;
    const line = store.get().lines.find((l) => l.id === m.data.lineId);
    m.marker.setIcon(vehicleIcon(m.data, line));
    m.marker.setZIndexOffset(pid === id ? 1000 : 0);
    m.marker.setPopupContent(popupHtml(m.data, line));
  }
  stopFocusPolling();
  if (id && active && !document.hidden) startFocusPolling();
  updateStatus();
}

function startFocusPolling() {
  stopFocusPolling();
  pollSelected();
  selTimer = setInterval(pollSelected, FOCUS_MS);
}

function stopFocusPolling() {
  clearInterval(selTimer); selTimer = null;
  selAbort?.abort(); selAbort = null;
}

async function pollSelected() {
  const id = selectedId;
  if (!id || selAbort) return; // forrige forespørsel pågår fortsatt
  selAbort = new AbortController();
  try {
    const v = await api.vehicleById(id, selAbort.signal);
    if (!v || selectedId !== id) return;
    const old = vehState.get(id);
    v.lineId = old?.lineId || v.lineId;
    if (old?.lastUpdated && v.lastUpdated && old.lastUpdated > v.lastUpdated) return;
    vehState.set(id, v);
    publish();
    // Hold bussen i bildet når den kjører ut av kartutsnittet.
    const ll = L.latLng(v.lat, v.lon);
    if (!map.getBounds().pad(-0.15).contains(ll)) map.panTo(ll, { animate: true });
  } catch { /* neste runde prøver igjen */ } finally {
    selAbort = null;
  }
}

// Myk animasjon mellom posisjoner.
function animateTo(entry, to, dur = 1200) {
  cancelAnimationFrame(entry.anim);
  const from = entry.marker.getLatLng();
  if (from.lat === to[0] && from.lng === to[1]) return;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    entry.marker.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
    if (k < 1) entry.anim = requestAnimationFrame(step);
  };
  entry.anim = requestAnimationFrame(step);
}

function fitAll(includeStops) {
  const pts = [...markers.values()].map((m) => m.marker.getLatLng());
  if (includeStops || !pts.length) {
    for (const s of store.get().stops) if (s.lat != null) pts.push(L.latLng(s.lat, s.lon));
  }
  if (!pts.length) return;
  if (pts.length === 1) map.setView(pts[0], 15);
  else map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 15 });
}

function locateMe() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) {
      meMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2f6fed', fillOpacity: 1 }).addTo(map);
    } else meMarker.setLatLng(ll);
    map.setView(ll, 15);
  }, () => setStatus('Fikk ikke tilgang til posisjon.', true), { enableHighAccuracy: true, timeout: 10000 });
}
