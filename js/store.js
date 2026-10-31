// Enkel lagring av favoritter i localStorage (lever kun på denne enheten).

const KEY = 'minbuss:v1';

const defaults = () => ({
  stops: [],   // { id, name, locality, lat, lon, categories, onlyFavLines }
  lines: [],   // normalisert linje fra api.normalizeLine + { hidden }
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

let state = load();
const listeners = new Set();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* privat modus o.l. */ }
  listeners.forEach((fn) => fn(state));
}

export const store = {
  get: () => state,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  hasStop: (id) => state.stops.some((s) => s.id === id),
  addStop(stop) {
    if (this.hasStop(stop.id)) return;
    state.stops.push({ onlyFavLines: false, ...stop });
    save();
  },
  removeStop(id) { state.stops = state.stops.filter((s) => s.id !== id); save(); },
  updateStop(id, patch) {
    state.stops = state.stops.map((s) => (s.id === id ? { ...s, ...patch } : s));
    save();
  },
  moveStop(id, dir) { move(state.stops, id, dir); save(); },

  hasLine: (id) => state.lines.some((l) => l.id === id),
  addLine(line) {
    if (this.hasLine(line.id)) return;
    state.lines.push({ hidden: false, ...line });
    save();
  },
  removeLine(id) { state.lines = state.lines.filter((l) => l.id !== id); save(); },
  toggleLineHidden(id) {
    state.lines = state.lines.map((l) => (l.id === id ? { ...l, hidden: !l.hidden } : l));
    save();
  },
  showOnlyLine(id) {
    state.lines = state.lines.map((l) => ({ ...l, hidden: l.id !== id }));
    save();
  },
  moveLine(id, dir) { move(state.lines, id, dir); save(); },
};

function move(arr, id, dir) {
  const i = arr.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
