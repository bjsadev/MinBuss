// Sanntidskart med Leaflet: kjøretøy på favorittlinjer, traséer og favorittholdeplasser.
import * as api from './api.js';
import { store } from './store.js';
import { lineColors, normMode, esc, delayText, agoText, OCCUPANCY, MODES } from './ui.js';

const L = window.L;
const POLL_MS = 10000;
const STALE_MS = 5 * 60 * 1000;

let map, tiles, stopLayer, shapeLayer, vehicleLayer, meMarker;
let timer = null;
let active = false;
let firstFit = true;
const markers = new Map();      // vehicleId -> { marker, data, anim }
const shapeCache = new Map();   // lineId -> [[lat,lon]...][]
let lastVehicles = [];
let statusEl, chipsEl;

const dark = window.matchMedia('(prefers-color-scheme: dark)');

function tileUrl() {
  return dark.matches
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
}

export function initMap() {
  statusEl = document.getElementById('map-status');
  chipsEl = document.getElementById('map-chips');
  if (!L) { statusEl.textContent = 'Kartbiblioteket kunne ikke lastes.'; return; }

  map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView([60.39, 5.33], 12); // standard: Bergen sentrum
  tiles = L.tileLayer(tileUrl(), {
    maxZoom: 19, subdomains: 'abcd',
    attribution: '© OpenStreetMap, © CARTO · Entur',
  }).addTo(map);
  dark.addEventListener?.('change', () => tiles.setUrl(tileUrl()));

  shapeLayer = L.layerGroup().addTo(map);
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
      radius: 6, weight: 2, color: '#fff', fillColor: '#111827', fillOpacity: 0.9,
    }).bindTooltip(esc(s.name), { direction: 'top', offset: [0, -6] }).addTo(stopLayer);
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
  pollVehicles();
  timer = setInterval(pollVehicles, POLL_MS);
}
function stopPolling() { clearInterval(timer); timer = null; }

let inflight = null;
async function pollVehicles() {
  const lines = visibleLines();
  if (!store.get().lines.length) {
    setStatus('Legg til favorittlinjer for å se kjøretøy i sanntid.', true);
    syncMarkers([]);
    return;
  }
  if (!lines.length) { setStatus('Alle linjer er skjult. Trykk på en linje over for å vise den.', true); syncMarkers([]); return; }
  inflight?.abort();
  inflight = new AbortController();
  try {
    const vs = await api.vehicles(lines.map((l) => l.id), inflight.signal);
    lastVehicles = vs;
    syncMarkers(vs);
    renderChips();
    if (!vs.length) {
      setStatus('Ingen kjøretøy med sanntidsposisjon på valgte linjer akkurat nå.', true);
    } else {
      setStatus(`${vs.length} kjøretøy · oppdateres hvert ${POLL_MS / 1000}. sekund`);
    }
    if (firstFit && vs.length) { fitAll(false); firstFit = false; }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`Kunne ikke hente posisjoner: ${e.message}`, true);
  }
}

function setStatus(text, prominent = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('prominent', prominent);
}

function vehicleIcon(v, line) {
  const { bg, fg } = lineColors(line || { mode: v.mode });
  const stale = v.lastUpdated && Date.now() - v.lastUpdated.getTime() > STALE_MS;
  const arrow = v.bearing != null
    ? `<i class="veh-arrow" style="transform:rotate(${Math.round(v.bearing)}deg)"></i>` : '';
  return L.divIcon({
    className: 'veh-wrap',
    html: `<div class="veh ${stale ? 'stale' : ''}" style="--lc:${bg};--lt:${fg}">${arrow}<span>${esc(v.publicCode || line?.publicCode || '')}</span></div>`,
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
    `<div class="muted">Oppdatert ${agoText(v.lastUpdated)}</div>`,
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
      animateTo(existing, [v.lat, v.lon]);
      existing.marker.setIcon(vehicleIcon(v, line));
      existing.marker.setPopupContent(popupHtml(v, line));
      existing.data = v;
    } else {
      const marker = L.marker([v.lat, v.lon], { icon: vehicleIcon(v, line), keyboard: false })
        .bindPopup(popupHtml(v, line))
        .addTo(vehicleLayer);
      markers.set(v.id, { marker, data: v });
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { vehicleLayer.removeLayer(m.marker); markers.delete(id); }
  }
}

// Myk animasjon mellom posisjoner.
function animateTo(entry, to) {
  cancelAnimationFrame(entry.anim);
  const from = entry.marker.getLatLng();
  if (from.lat === to[0] && from.lng === to[1]) return;
  const dur = 1200;
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
