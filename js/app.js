import * as api from './api.js';
import { store } from './store.js';
import {
  esc, lineBadge, modeIcon, modeFromCategories, relTime, clock, quayLabel,
  OCCUPANCY, debounce, MODES, normMode,
} from './ui.js';
import { initMap, showMap, hideMap, focusLine } from './map.js';
import * as theme from './theme.js';

const REFRESH_MS = 30000;
const $ = (s, el = document) => el.querySelector(s);

const state = {
  view: 'departures',
  deps: {},          // stopId -> calls[]
  lastFetch: null,
  error: null,
  loading: false,
  expanded: new Set(),
};

// ---------------- Navigasjon ----------------

const TITLES = { departures: 'Avganger', map: 'Sanntidskart', favorites: 'Favoritter' };

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-title').textContent = TITLES[view];
  $('#btn-add').setAttribute('aria-label', view === 'map' ? 'Legg til linje' : 'Legg til holdeplass');
  document.body.dataset.view = view;
  if (view === 'map') showMap(); else hideMap();
  if (view === 'departures') refreshDepartures();
  if (view === 'favorites') renderFavorites();
  renderUpdated();
  try { localStorage.setItem('minbuss:view', view); } catch {}
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) setView(t.dataset.view);
});
$('#btn-add').addEventListener('click', () => (state.view === 'map' ? openAddLine() : openAddStop()));

// ---------------- Avganger ----------------

let refreshTimer = null;

function stopFilter(stop) {
  if (stop.lineIds?.length) return stop.lineIds;
  if (stop.onlyFavLines) {
    const fav = store.get().lines.map((l) => l.id);
    return fav.length ? fav : null;
  }
  return null;
}

let depAbort = null;
async function refreshDepartures() {
  const stops = store.get().stops;
  clearTimeout(refreshTimer);
  if (!stops.length) { renderDepartures(); return; }
  if (state.view === 'departures' && !document.hidden) {
    refreshTimer = setTimeout(refreshDepartures, REFRESH_MS);
  }
  depAbort?.abort();
  depAbort = new AbortController();
  state.loading = true;
  renderUpdated();
  try {
    state.deps = await api.departures(
      stops.map((s) => ({ id: s.id, lineIds: stopFilter(s) })),
      { count: 20, signal: depAbort.signal },
    );
    state.lastFetch = new Date();
    state.error = null;
  } catch (e) {
    if (e.name === 'AbortError') return;
    state.error = e.message;
  }
  state.loading = false;
  renderDepartures();
}

function renderUpdated() {
  const el = $('#updated');
  if (state.view !== 'departures') { el.textContent = ''; return; }
  if (state.loading && !state.lastFetch) el.textContent = 'Henter…';
  else if (state.error) el.innerHTML = '<span class="warn">Frakoblet</span>';
  else if (state.lastFetch) el.textContent = `Oppdatert ${clock(state.lastFetch)}`;
  el.classList.toggle('loading', state.loading);
}

function renderDepartures() {
  renderUpdated();
  const root = $('#departures');
  const stops = store.get().stops;

  if (!stops.length) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty-art">${modeIcon('bus', 'empty-icon')}${modeIcon('tram', 'empty-icon')}${modeIcon('rail', 'empty-icon')}${modeIcon('water', 'empty-icon')}</div>
        <h2>Velkommen til MinBuss</h2>
        <p>Legg til holdeplassene og stasjonene du bruker mest, så ser du alltid når neste buss, bybane, tog eller båt går.</p>
        <button class="primary-btn" data-action="add-stop">Søk etter holdeplass</button>
        <button class="ghost-btn" data-action="nearby">Finn holdeplasser nær meg</button>
      </div>`;
    return;
  }

  const now = Date.now();
  const errorBanner = state.error
    ? `<div class="banner">Kunne ikke hente sanntid (${esc(state.error)}). Prøver igjen automatisk.</div>` : '';

  root.innerHTML = errorBanner + stops.map((stop) => {
    const calls = (state.deps[stop.id] || []).filter((c) => c.expected.getTime() > now - 60000);
    const modes = stop.modes?.length ? stop.modes : modeFromCategories(stop.categories);
    const filtered = !!stopFilter(stop);
    const grouped = stop.layout !== 'list';
    const body = !state.deps[stop.id]
      ? skeleton()
      : calls.length
        ? (grouped ? groupedRows(stop, calls, now) : listRows(stop, calls, now))
        : `<p class="none">Ingen avganger de neste timene${filtered ? ' for valgte linjer' : ''}.</p>`;
    return `
      <article class="stop-card" data-stop="${esc(stop.id)}">
        <header class="stop-head">
          <div class="stop-modes">${(modes.length ? modes : ['bus']).slice(0, 3).map((m) => modeIcon(m)).join('')}</div>
          <div class="stop-title">
            <h2>${esc(stop.name)}</h2>
            <p>${esc(stop.locality || '')}${filtered ? ' · <span class="tag">filtrert</span>' : ''}</p>
          </div>
          <button class="icon-btn sm" data-action="toggle-layout" aria-label="${grouped ? 'Vis som liste' : 'Grupper per linje'}" title="${grouped ? 'Vis som liste' : 'Grupper per linje'}">
            ${grouped
              ? '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
              : '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/></svg>'}
          </button>
          <button class="icon-btn sm" data-action="stop-settings" aria-label="Innstillinger for ${esc(stop.name)}">
            <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>
          </button>
        </header>
        ${body}
      </article>`;
  }).join('');
}

function skeleton() {
  return `<div class="skeleton">${'<div class="sk-row"></div>'.repeat(3)}</div>`;
}

function timeCell(c, now, big = true) {
  const delayMin = Math.round((c.expected - c.aimed) / 60000);
  const late = c.realtime && delayMin >= 2;
  const rel = relTime(c.expected, now);
  const soon = rel === 'Nå' || (rel.endsWith('min') && parseInt(rel, 10) <= 2);
  return `<span class="time ${big ? 'big' : ''} ${c.cancelled ? 'cancelled' : ''} ${soon ? 'soon' : ''}">
    ${c.realtime && !c.cancelled ? '<i class="rt-dot" title="Sanntid"></i>' : ''}${esc(rel)}
    ${late && big ? `<s class="aimed">${clock(c.aimed)}</s>` : ''}
  </span>`;
}

function groupedRows(stop, calls, now) {
  const groups = new Map();
  for (const c of calls) {
    const k = `${c.line.id}|${c.destination}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const all = [...groups.values()];
  const expanded = state.expanded.has(stop.id);
  const shown = expanded ? all : all.slice(0, 6);
  const favIds = new Set(store.get().lines.map((l) => l.id));
  const rows = shown.map((g) => {
    const c = g[0];
    const next = g.slice(1, 3).map((x) => timeCell(x, now, false)).join('');
    const quays = [...new Set(g.map((x) => x.quay).filter(Boolean))];
    const meta = [
      quays.length === 1 ? quayLabel(c.line.mode, quays[0]) : '',
      c.cancelled ? '<span class="warn">Innstilt</span>' : '',
      c.situations.length ? '<span class="warn" title="Avvik">⚠ Avvik</span>' : '',
      c.occupancy && OCCUPANCY[c.occupancy] && c.occupancy !== 'noData' ? esc(OCCUPANCY[c.occupancy]) : '',
    ].filter(Boolean).join(' · ');
    return `
      <li>
        <button class="dep" data-action="line" data-line="${esc(c.line.id)}">
          ${lineBadge(c.line, favIds.has(c.line.id) ? 'fav' : '')}
          <span class="dep-main">
            <span class="dest">${esc(c.destination)}</span>
            ${meta ? `<span class="meta">${meta}</span>` : ''}
          </span>
          <span class="dep-times">${timeCell(c, now)}${next ? `<span class="next">${next}</span>` : ''}</span>
        </button>
      </li>`;
  }).join('');
  const more = all.length > 6
    ? `<button class="more-btn" data-action="expand">${expanded ? 'Vis færre' : `Vis alle ${all.length} linjer`}</button>` : '';
  return `<ol class="deps">${rows}</ol>${more}`;
}

function listRows(stop, calls, now) {
  const expanded = state.expanded.has(stop.id);
  const shown = expanded ? calls : calls.slice(0, 8);
  const favIds = new Set(store.get().lines.map((l) => l.id));
  const rows = shown.map((c) => {
    const meta = [
      quayLabel(c.line.mode, c.quay),
      c.cancelled ? '<span class="warn">Innstilt</span>' : '',
      c.situations.length ? '<span class="warn">⚠ Avvik</span>' : '',
    ].filter(Boolean).join(' · ');
    return `
      <li>
        <button class="dep" data-action="line" data-line="${esc(c.line.id)}">
          ${lineBadge(c.line, favIds.has(c.line.id) ? 'fav' : '')}
          <span class="dep-main">
            <span class="dest">${esc(c.destination)}</span>
            ${meta ? `<span class="meta">${meta}</span>` : ''}
          </span>
          <span class="dep-times">${timeCell(c, now)}</span>
        </button>
      </li>`;
  }).join('');
  const more = calls.length > 8
    ? `<button class="more-btn" data-action="expand">${expanded ? 'Vis færre' : `Vis ${calls.length - 8} flere`}</button>` : '';
  return `<ol class="deps">${rows}</ol>${more}`;
}

$('#departures').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.stop-card');
  const stopId = card?.dataset.stop;
  const stop = store.get().stops.find((s) => s.id === stopId);
  switch (btn.dataset.action) {
    case 'add-stop': openAddStop(); break;
    case 'nearby': openAddStop({ nearby: true }); break;
    case 'expand':
      state.expanded.has(stopId) ? state.expanded.delete(stopId) : state.expanded.add(stopId);
      renderDepartures();
      break;
    case 'toggle-layout':
      store.updateStop(stopId, { layout: stop.layout === 'list' ? 'grouped' : 'list' });
      break;
    case 'stop-settings': openStopSettings(stop); break;
    case 'line': {
      const call = (state.deps[stopId] || []).find((c) => c.line.id === btn.dataset.line);
      if (call) openLineActions(call, stop);
      break;
    }
  }
});

// Oppdater relative tider lokalt mellom henting
setInterval(() => { if (state.view === 'departures' && !document.hidden) renderDepartures(); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.view === 'departures') refreshDepartures();
});

// ---------------- Bottom sheet ----------------

const sheet = $('#sheet');
const backdrop = $('#sheet-backdrop');
let sheetCleanup = null;

function openSheet(html, onMount) {
  $('#sheet-body').innerHTML = html;
  sheet.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => { sheet.classList.add('open'); backdrop.classList.add('open'); });
  sheetCleanup = onMount?.($('#sheet-body')) || null;
}

function closeSheet() {
  sheet.classList.remove('open');
  backdrop.classList.remove('open');
  sheetCleanup?.();
  sheetCleanup = null;
  setTimeout(() => { sheet.hidden = true; backdrop.hidden = true; }, 220);
}
backdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 250); }, 2200);
}

// ---- Legg til holdeplass ----

function openAddStop({ nearby = false } = {}) {
  openSheet(`
    <div class="sheet-head"><h2>Legg til holdeplass</h2><button class="text-btn" data-close>Ferdig</button></div>
    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="stop-q" type="search" placeholder="Holdeplass, stasjon eller kai" autocomplete="off" enterkeyhint="search" />
    </div>
    <button class="ghost-btn wide" id="stop-near">
      <svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>
      Holdeplasser nær meg
    </button>
    <ul id="stop-results" class="results"></ul>`,
  (body) => {
    const input = $('#stop-q', body);
    const list = $('#stop-results', body);
    let ctrl;
    let results = [];

    const render = (items, emptyText) => {
      results = items;
      if (!items.length) { list.innerHTML = emptyText ? `<li class="muted pad">${emptyText}</li>` : ''; return; }
      list.innerHTML = items.map((s, i) => {
        const modes = modeFromCategories(s.categories);
        const added = store.hasStop(s.id);
        return `<li><button class="result" data-i="${i}">
          <span class="result-icons">${(modes.length ? modes : ['bus']).slice(0, 2).map((m) => modeIcon(m)).join('')}</span>
          <span class="result-main"><b>${esc(s.name)}</b><small>${esc(s.locality)}${s.distance != null ? ` · ${Math.round(s.distance * 1000)} m` : ''}</small></span>
          <span class="result-state ${added ? 'added' : ''}">${added ? '✓' : '+'}</span>
        </button></li>`;
      }).join('');
    };

    const search = debounce(async (q) => {
      ctrl?.abort();
      if (q.trim().length < 2) { render([]); return; }
      ctrl = new AbortController();
      list.innerHTML = '<li class="muted pad">Søker…</li>';
      try { render(await api.searchStops(q, ctrl.signal), 'Ingen treff'); } catch (e) {
        if (e.name !== 'AbortError') list.innerHTML = `<li class="warn pad">${esc(e.message)}</li>`;
      }
    }, 220);

    const near = () => {
      if (!navigator.geolocation) return toast('Posisjon er ikke tilgjengelig');
      list.innerHTML = '<li class="muted pad">Finner posisjon…</li>';
      navigator.geolocation.getCurrentPosition(async (p) => {
        try { render(await api.nearbyStops(p.coords.latitude, p.coords.longitude), 'Fant ingen holdeplasser i nærheten'); } catch (e) {
          list.innerHTML = `<li class="warn pad">${esc(e.message)}</li>`;
        }
      }, () => { list.innerHTML = '<li class="warn pad">Fikk ikke tilgang til posisjon.</li>'; },
      { enableHighAccuracy: true, timeout: 10000 });
    };

    input.addEventListener('input', () => search(input.value));
    $('#stop-near', body).addEventListener('click', near);
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.result');
      if (!b) return;
      const s = results[+b.dataset.i];
      if (store.hasStop(s.id)) { store.removeStop(s.id); toast(`${s.name} fjernet`); } else {
        store.addStop({
          id: s.id, name: s.name, locality: s.locality, lat: s.lat, lon: s.lon,
          categories: s.categories, modes: modeFromCategories(s.categories),
        });
        toast(`${s.name} lagt til`);
      }
      render(results);
    });

    if (nearby) near(); else setTimeout(() => input.focus(), 250);
  });
}

// ---- Legg til linje ----

function openAddLine(prefill = '') {
  openSheet(`
    <div class="sheet-head"><h2>Legg til linje</h2><button class="text-btn" data-close>Ferdig</button></div>
    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="line-q" type="search" placeholder="Linjenummer eller navn, f.eks. 1 eller Bybanen" autocomplete="off" enterkeyhint="search" value="${esc(prefill)}" />
    </div>
    <p class="hint">Tips: Trykk på en avgang under «Avganger» for å legge linjen til direkte.</p>
    <ul id="line-results" class="results"></ul>`,
  (body) => {
    const input = $('#line-q', body);
    const list = $('#line-results', body);
    let ctrl, results = [];
    const render = (items) => {
      results = items;
      if (!items.length) { list.innerHTML = input.value.trim() ? '<li class="muted pad">Ingen treff</li>' : ''; return; }
      list.innerHTML = items.map((l, i) => {
        const added = store.hasLine(l.id);
        return `<li><button class="result" data-i="${i}">
          ${lineBadge(l)}
          <span class="result-main"><b>${esc(l.name || MODES[normMode(l.mode)].label)}</b><small>${esc(MODES[normMode(l.mode)].label)} · ${esc(l.authority)}</small></span>
          <span class="result-state ${added ? 'added' : ''}">${added ? '✓' : '+'}</span>
        </button></li>`;
      }).join('');
    };
    const search = debounce(async (q) => {
      ctrl?.abort();
      if (!q.trim()) { render([]); return; }
      ctrl = new AbortController();
      list.innerHTML = '<li class="muted pad">Søker…</li>';
      try {
        const lines = await api.searchLines(q, ctrl.signal);
        // Prioritér linjer som betjener favorittholdeplassenes område (enkelt: samme operatør som eksisterende favoritter).
        const favAuth = new Set(store.get().lines.map((l) => l.authority));
        lines.sort((a, b) => (favAuth.has(b.authority) - favAuth.has(a.authority))
          || a.publicCode.localeCompare(b.publicCode, 'nb', { numeric: true }));
        render(lines);
      } catch (e) {
        if (e.name !== 'AbortError') list.innerHTML = `<li class="warn pad">${esc(e.message)}</li>`;
      }
    }, 300);
    input.addEventListener('input', () => search(input.value));
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.result');
      if (!b) return;
      const l = results[+b.dataset.i];
      if (store.hasLine(l.id)) { store.removeLine(l.id); toast(`Linje ${l.publicCode} fjernet`); } else {
        store.addLine(l); toast(`Linje ${l.publicCode} lagt til`);
      }
      render(results);
    });
    if (prefill) search(prefill); else setTimeout(() => input.focus(), 250);
  });
}

// ---- Handlinger for en linje fra avgangslisten ----

function openLineActions(call, stop) {
  const l = call.line;
  const fav = store.hasLine(l.id);
  const onlyThis = stop.lineIds?.length === 1 && stop.lineIds[0] === l.id;
  const upcoming = (state.deps[stop.id] || []).filter((c) => c.line.id === l.id).slice(0, 6);
  openSheet(`
    <div class="sheet-head">
      <div class="line-title">${lineBadge(l, 'lg')}<div><h2>${esc(l.name || l.publicCode)}</h2><small>${esc(MODES[normMode(l.mode)].label)} · ${esc(l.authority)}</small></div></div>
      <button class="text-btn" data-close>Lukk</button>
    </div>
    ${call.situations.length ? `<div class="banner">${call.situations.map(esc).join('<br>')}</div>` : ''}
    <ul class="upcoming">${upcoming.map((c) => `
      <li><span>${esc(c.destination)} <small>${quayLabel(l.mode, c.quay)}</small></span>
      <span>${c.cancelled ? '<span class="warn">Innstilt</span>' : `${clock(c.expected)}${c.realtime && Math.abs(c.expected - c.aimed) > 60000 ? ` <s class="aimed">${clock(c.aimed)}</s>` : ''}`}</span></li>`).join('')}
    </ul>
    <div class="actions">
      <button class="primary-btn" data-act="fav">${fav ? 'Fjern fra favorittlinjer' : '★ Legg til i favorittlinjer'}</button>
      <button class="ghost-btn" data-act="map">Vis på sanntidskart</button>
      <button class="ghost-btn" data-act="only">${onlyThis ? 'Vis alle linjer på holdeplassen' : `Vis kun linje ${esc(l.publicCode)} her`}</button>
    </div>`,
  (body) => {
    body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (!a) return;
      if (a === 'fav') {
        if (fav) { store.removeLine(l.id); toast(`Linje ${l.publicCode} fjernet`); } else { store.addLine(l); toast(`Linje ${l.publicCode} lagt til`); }
        closeSheet();
      } else if (a === 'map') {
        if (!store.hasLine(l.id)) store.addLine(l);
        focusLine(l.id);
        closeSheet();
        setView('map');
      } else if (a === 'only') {
        store.updateStop(stop.id, { lineIds: onlyThis ? [] : [l.id] });
        closeSheet();
        refreshDepartures();
      }
    });
  });
}

// ---- Innstillinger for en holdeplass ----

function openStopSettings(stop) {
  openSheet(`
    <div class="sheet-head"><div><h2>${esc(stop.name)}</h2><small>${esc(stop.locality || '')}</small></div><button class="text-btn" data-close>Ferdig</button></div>
    <label class="switch-row">
      <span><b>Kun favorittlinjer</b><small>Vis bare linjer du har lagt til som favoritt</small></span>
      <input type="checkbox" id="only-fav" ${stop.onlyFavLines ? 'checked' : ''} />
    </label>
    <h3 class="sub">Velg linjer for denne holdeplassen</h3>
    <p class="hint">Ingen valgt = alle linjer vises. ★ legger linjen til i favoritter (og kartet).</p>
    <ul id="stop-lines" class="results"><li class="muted pad">Henter linjer…</li></ul>
    <div class="actions">
      <button class="danger-btn" data-act="remove">Fjern holdeplass</button>
    </div>`,
  (body) => {
    let lines = [];
    const list = $('#stop-lines', body);
    const render = () => {
      const cur = store.get().stops.find((s) => s.id === stop.id) || stop;
      const sel = new Set(cur.lineIds || []);
      list.innerHTML = lines.length ? lines.map((l, i) => `
        <li class="line-pick">
          <label>
            <input type="checkbox" data-i="${i}" ${sel.has(l.id) ? 'checked' : ''} />
            ${lineBadge(l)}
            <span class="result-main"><b>${esc(l.name)}</b><small>${esc(MODES[normMode(l.mode)].label)}</small></span>
          </label>
          <button class="star ${store.hasLine(l.id) ? 'on' : ''}" data-star="${i}" aria-label="Favorittlinje">★</button>
        </li>`).join('') : '<li class="muted pad">Fant ingen linjer.</li>';
    };
    api.linesForStop(stop.id).then((ls) => { lines = ls; render(); })
      .catch((e) => { list.innerHTML = `<li class="warn pad">${esc(e.message)}</li>`; });

    $('#only-fav', body).addEventListener('change', (e) => {
      store.updateStop(stop.id, { onlyFavLines: e.target.checked });
      refreshDepartures();
    });
    list.addEventListener('change', (e) => {
      const i = e.target.dataset.i;
      if (i == null) return;
      const cur = store.get().stops.find((s) => s.id === stop.id);
      const sel = new Set(cur.lineIds || []);
      e.target.checked ? sel.add(lines[i].id) : sel.delete(lines[i].id);
      store.updateStop(stop.id, { lineIds: [...sel] });
      refreshDepartures();
    });
    list.addEventListener('click', (e) => {
      const i = e.target.closest('[data-star]')?.dataset.star;
      if (i == null) return;
      const l = lines[i];
      store.hasLine(l.id) ? store.removeLine(l.id) : store.addLine(l);
      render();
    });
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="remove"]')) {
        store.removeStop(stop.id);
        toast(`${stop.name} fjernet`);
        closeSheet();
      }
    });
  });
}

// ---------------- Favoritter ----------------

function renderFavorites() {
  const { stops, lines } = store.get();
  $('#fav-stops').innerHTML = stops.length ? stops.map((s, i) => {
    const modes = s.modes?.length ? s.modes : modeFromCategories(s.categories);
    return `<li data-id="${esc(s.id)}" data-kind="stop">
      <span class="fav-icons">${(modes.length ? modes : ['bus']).slice(0, 2).map((m) => modeIcon(m)).join('')}</span>
      <span class="result-main"><b>${esc(s.name)}</b><small>${esc(s.locality || '')}</small></span>
      ${reorderButtons(i, stops.length)}
      <button class="icon-btn sm danger" data-act="del" aria-label="Fjern ${esc(s.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </li>`;
  }).join('') : '<li class="muted pad">Ingen holdeplasser ennå.</li>';

  $('#fav-lines').innerHTML = lines.length ? lines.map((l, i) => `
    <li data-id="${esc(l.id)}" data-kind="line" class="${l.hidden ? 'dim' : ''}">
      ${lineBadge(l)}
      <span class="result-main"><b>${esc(l.name || l.publicCode)}</b><small>${esc(MODES[normMode(l.mode)].label)} · ${esc(l.authority)}</small></span>
      <button class="icon-btn sm" data-act="vis" aria-label="${l.hidden ? 'Vis i kart' : 'Skjul i kart'}" title="${l.hidden ? 'Skjult i kart' : 'Vises i kart'}">
        ${l.hidden
          ? '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3 3.4M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4-1"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>'}
      </button>
      ${reorderButtons(i, lines.length)}
      <button class="icon-btn sm danger" data-act="del" aria-label="Fjern linje ${esc(l.publicCode)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </li>`).join('') : '<li class="muted pad">Ingen favorittlinjer ennå.</li>';
}

function reorderButtons(i, n) {
  return `<span class="reorder">
    <button class="icon-btn xs" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Flytt opp"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button>
    <button class="icon-btn xs" data-act="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Flytt ned"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
  </span>`;
}

$('#view-favorites').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'add-stop') return openAddStop();
  if (action === 'add-line') return openAddLine();
  const btn = e.target.closest('[data-act]');
  const li = e.target.closest('li[data-id]');
  if (!btn || !li) return;
  const { id, kind } = li.dataset;
  const act = btn.dataset.act;
  if (kind === 'stop') {
    if (act === 'del') store.removeStop(id);
    if (act === 'up') store.moveStop(id, -1);
    if (act === 'down') store.moveStop(id, 1);
  } else {
    if (act === 'del') store.removeLine(id);
    if (act === 'up') store.moveLine(id, -1);
    if (act === 'down') store.moveLine(id, 1);
    if (act === 'vis') store.toggleLineHidden(id);
  }
});

// ---------------- Tema ----------------

const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>';

function renderTheme() {
  const dark = theme.isDark();
  const btn = $('#btn-theme');
  btn.innerHTML = dark ? SUN : MOON;
  btn.setAttribute('aria-label', dark ? 'Bytt til lys modus' : 'Bytt til mørk modus');
  btn.title = btn.getAttribute('aria-label');
  const choice = theme.getChoice();
  document.querySelectorAll('[data-theme-choice]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
}
$('#btn-theme').addEventListener('click', () => {
  theme.toggle();
  toast(theme.isDark() ? 'Mørk modus' : 'Lys modus');
});
$('#theme-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-choice]');
  if (b) theme.setChoice(b.dataset.themeChoice);
});
theme.onThemeChange(renderTheme);
renderTheme();

// ---------------- Oppstart ----------------

const stopsKey = (s) => JSON.stringify(s.stops.map((x) => [x.id, x.lineIds, x.onlyFavLines]))
  + (s.stops.some((x) => x.onlyFavLines) ? JSON.stringify(s.lines.map((l) => l.id)) : '');
let lastStopsKey = stopsKey(store.get());
store.subscribe((s) => {
  if (state.view === 'favorites') renderFavorites();
  // Hent på nytt bare når holdeplasser/filtre endres
  const key = stopsKey(s);
  if (key !== lastStopsKey) { lastStopsKey = key; refreshDepartures(); } else if (state.view === 'departures') renderDepartures();
});

initMap();
let initial = 'departures';
try { initial = localStorage.getItem('minbuss:view') || 'departures'; } catch {}
setView(['departures', 'map', 'favorites'].includes(initial) ? initial : 'departures');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
