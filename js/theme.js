// Lys/mørk modus: «system» følger enheten, «light»/«dark» overstyrer.
const KEY = 'minbuss:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export function getChoice() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

export const isDark = () => {
  const c = getChoice();
  return c === 'dark' || (c === 'system' && media.matches);
};

function apply() {
  const c = getChoice();
  const root = document.documentElement;
  if (c === 'system') delete root.dataset.theme; else root.dataset.theme = c;
  const meta = document.getElementById('meta-theme');
  if (meta) meta.content = isDark() ? '#0b0f16' : '#f3f5fa';
  listeners.forEach((fn) => fn({ choice: c, dark: isDark() }));
}

export function setChoice(c) {
  try {
    if (c === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, c);
  } catch { /* privat modus: gjelder bare denne økten */ if (c !== 'system') document.documentElement.dataset.theme = c; }
  apply();
}

/** Bytter direkte mellom lys og mørk ut fra det som vises nå. */
export const toggle = () => setChoice(isDark() ? 'light' : 'dark');

export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

media.addEventListener?.('change', () => { if (getChoice() === 'system') apply(); });
apply();
