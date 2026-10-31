// Felles visningshjelpere: transportmidler, linjemerker, tid.

const ICONS = {
  bus: '<path d="M6 17V6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v11"/><path d="M5 17h14v2H5zM6 11h12M8 20v1M16 20v1"/><circle cx="8.5" cy="14" r=".6"/><circle cx="15.5" cy="14" r=".6"/>',
  coach: '<path d="M4 16V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9"/><path d="M3 16h18v2H3zM4 10h16M7 19v1M17 19v1"/>',
  tram: '<path d="M7 18V8a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v10z"/><path d="M9 3h6M12 3v3M7 13h10M8 21l1.5-3M16 21l-1.5-3"/>',
  rail: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4M9.5 14h.01M14.5 14h.01"/>',
  metro: '<circle cx="12" cy="12" r="9"/><path d="M8 8h8M12 8v9"/>',
  water: '<path d="M4 15l2-5h12l2 5"/><path d="M9 10V6h6v4M12 6V3"/><path d="M2 19c2 1.3 4 1.3 6 0s4-1.3 6 0 4 1.3 6 0"/>',
  air: '<path d="M10 14 3 12v-2l7 1V5.5a2 2 0 0 1 4 0V11l7-1v2l-7 2v4l2 1.5V21l-4-1-4 1v-1.5l2-1.5z"/>',
  cableway: '<path d="M3 5l18-2M12 4v4"/><rect x="7" y="8" width="10" height="9" rx="2"/><path d="M7 12h10"/>',
};

export const MODES = {
  bus:       { label: 'Buss',     color: '#e8384f' },
  coach:     { label: 'Ekspressbuss', color: '#8b5cf6' },
  tram:      { label: 'Bybane/trikk', color: '#1fa463' },
  rail:      { label: 'Tog',      color: '#2f6fed' },
  metro:     { label: 'T-bane',   color: '#f08a24' },
  water:     { label: 'Båt',      color: '#0ea5b7' },
  air:       { label: 'Fly',      color: '#64748b' },
  cableway:  { label: 'Taubane',  color: '#a16207' },
  funicular: { label: 'Bane',     color: '#a16207' },
};

const CATEGORY_TO_MODE = {
  onstreetBus: 'bus', busStation: 'bus', coachStation: 'coach',
  onstreetTram: 'tram', tramStation: 'tram',
  railStation: 'rail', metroStation: 'metro',
  ferryStop: 'water', ferryPort: 'water', harbourPort: 'water',
  airport: 'air', liftStation: 'cableway',
};

export const modeFromCategories = (cats = []) =>
  [...new Set(cats.map((c) => CATEGORY_TO_MODE[c]).filter(Boolean))];

export const normMode = (m) => {
  m = (m || '').toLowerCase();
  if (m === 'ferry' || m === 'boat') return 'water';
  if (m === 'trolleybus') return 'bus';
  return MODES[m] ? m : 'bus';
};

export function modeIcon(mode, cls = 'mode-icon') {
  const m = normMode(mode);
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-label="${MODES[m].label}" role="img">${ICONS[m] || ICONS.bus}</svg>`;
}

export function lineColors(line) {
  const bg = line.colour || MODES[normMode(line.mode)].color;
  const fg = line.textColour || readableText(bg);
  return { bg, fg };
}

function readableText(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#111' : '#fff';
}

export function lineBadge(line, extra = '') {
  const { bg, fg } = lineColors(line);
  const code = esc(line.publicCode || line.name?.slice(0, 3) || '?');
  return `<span class="line-badge ${extra}" style="--lc:${bg};--lt:${fg}">${code}</span>`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const clockFmt = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
export const clock = (d) => clockFmt.format(d);

/** "Nå", "3 min" eller klokkeslett. */
export function relTime(d, now = Date.now()) {
  const min = Math.floor((d.getTime() - now) / 60000);
  if (min <= 0) return 'Nå';
  if (min < 15) return `${min} min`;
  return clock(d);
}

export function delayText(sec) {
  if (sec == null) return '';
  const m = Math.round(sec / 60);
  if (Math.abs(m) < 1) return 'I rute';
  return m > 0 ? `${m} min forsinket` : `${-m} min før rute`;
}

export function agoText(d, now = Date.now()) {
  if (!d) return '';
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return `${s} s siden`;
  return `${Math.round(s / 60)} min siden`;
}

export const OCCUPANCY = {
  empty: 'Tomt', manySeatsAvailable: 'God plass', fewSeatsAvailable: 'Få seter',
  standingRoomOnly: 'Kun ståplass', crushedStandingRoomOnly: 'Svært fullt', full: 'Fullt',
  notAcceptingPassengers: 'Tar ikke passasjerer',
  EMPTY: 'Tomt', MANY_SEATS_AVAILABLE: 'God plass', FEW_SEATS_AVAILABLE: 'Få seter',
  STANDING_ROOM_ONLY: 'Kun ståplass', CRUSHED_STANDING_ROOM_ONLY: 'Svært fullt', FULL: 'Fullt',
  NOT_ACCEPTING_PASSENGERS: 'Tar ikke passasjerer',
};

export function quayLabel(mode, code) {
  if (!code) return '';
  return normMode(mode) === 'rail' ? `Spor ${esc(code)}` : `Plf. ${esc(code)}`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
