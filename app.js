/* ════════════════════════════════════════════════════════════════════════
   OC Transpo Live — bus.jjjp.ca
   Static front-end. Talks to the NAS proxy for the realtime feeds and to a
   bundled GTFS schedule (data/gtfs-bus.json) for the start-to-end stop list.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';

// Production proxy. For local testing, set window.BUS_API_URL before app.js
// loads to point at a local PHP server — api.php allows the localhost origin.
const API_URL   = window.BUS_API_URL || 'https://jjjp.ca/bus/api.php';
const DATA_URL  = 'data/gtfs-bus.json';
const PREFS_KEY = 'busjjjp.prefs';
const STALE_VEHICLE = 150;                  // s — a bus older than this is "faded"

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const META_THEME = { light: '#ffffff', dark: '#16161a' };

/* ── State ──────────────────────────────────────────────────────────────── */
let GTFS        = null;
let LINES       = new Map();                // "route:dir" -> line object
let PATTERNS    = new Map();                // patternId -> pattern object
let stopRoutes  = new Map();                // stopId -> Set of route short names

let runs        = [];
let lastData    = null;
let lastPollClient = 0;
let pollTimer   = null;
let renderTimer = null;
let map = null, mapLayers = null, tileLayer = null;
const expandedCards = new Set();            // line keys shown as full timelines

const prefs = {
  lines:    ['45:1', '5:0'],
  favStops: [],
  showMap:  false,
  refresh:  20,
  theme:    'light',
  compact:  true,
  expanded: [],
};

/* ── Boot ───────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  auth.handleCallback();
  loadPrefs();
  applyTheme(prefs.theme);
  registerServiceWorker();
  wireChrome();
  renderAuth();
  setSidebar(window.innerWidth > 760);

  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    GTFS = await res.json();
  } catch (e) {
    document.getElementById('timelines').innerHTML =
      `<div class="empty-state">Could not load the bundled schedule
       (${DATA_URL}). Run <code>build-data.py</code> first.</div>`;
    return;
  }

  prepareGtfs();
  document.getElementById('data-date').textContent = GTFS.generated || '—';

  prefs.lines = prefs.lines.filter(k => LINES.has(k));
  if (prefs.lines.length === 0) prefs.lines = [...LINES.keys()].slice(0, 2);
  for (const k of prefs.expanded) if (LINES.has(k)) expandedCards.add(k);

  renderLinePicker();
  renderFavStops();
  if (prefs.showMap) { document.getElementById('map-toggle').checked = true; enableMap(); }

  await poll();
  startTimers();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
  window.addEventListener('resize', onResize);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
  }
}

/* ── Prepare bundled data ───────────────────────────────────────────────── */
function prepareGtfs() {
  for (const [rid, route] of Object.entries(GTFS.routes)) {
    for (const pat of route.patterns) {
      PATTERNS.set(pat.id, pat);
      for (const sid of pat.stops) {
        if (!stopRoutes.has(sid)) stopRoutes.set(sid, new Set());
        stopRoutes.get(sid).add(route.short);
      }
    }
    const byDir = {};
    for (const pat of route.patterns) {
      if (!byDir[pat.dir] || pat.stops.length > byDir[pat.dir].stops.length)
        byDir[pat.dir] = pat;
    }
    for (const [dir, pat] of Object.entries(byDir)) {
      const key = rid + ':' + dir;
      LINES.set(key, {
        key, routeId: rid, dir: +dir,
        short: route.short, long: route.long,
        color: '#' + route.color, text: '#' + route.text,
        headsign: pat.headsign, pattern: pat,
      });
    }
  }
}

/* ── Preferences ────────────────────────────────────────────────────────── */
function loadPrefs() {
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
  } catch (e) { /* keep defaults */ }
  document.getElementById('refresh-select').value = String(prefs.refresh);
  document.getElementById('theme-select').value = prefs.theme;
  document.getElementById('compact-toggle').checked = prefs.compact;
}
function savePrefs() {
  prefs.expanded = [...expandedCards];
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/* ── Theme ──────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = META_THEME[theme] || META_THEME.light;
  if (map && tileLayer) {
    map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(TILES[theme], {
      maxZoom: 20, subdomains: 'abcd',
      attribution: '© OpenStreetMap, © CARTO',
    }).addTo(map);
    tileLayer.bringToBack();
  }
}

/* ── Chrome / controls ──────────────────────────────────────────────────── */
function wireChrome() {
  document.getElementById('refresh-btn').onclick = () => poll();

  document.getElementById('sidebar-toggle').onclick = () =>
    setSidebar(document.getElementById('sidebar').classList.contains('collapsed'));
  document.getElementById('backdrop').onclick = () => setSidebar(false);

  document.getElementById('theme-select').onchange = (e) => {
    prefs.theme = e.target.value; savePrefs(); applyTheme(prefs.theme);
  };

  document.getElementById('compact-toggle').onchange = (e) => {
    prefs.compact = e.target.checked;
    expandedCards.clear();
    if (!prefs.compact) prefs.lines.forEach(k => expandedCards.add(k));
    savePrefs(); renderTimelines();
  };

  document.getElementById('map-toggle').onchange = (e) => {
    prefs.showMap = e.target.checked; savePrefs();
    if (prefs.showMap) enableMap();
    else document.getElementById('map-wrap').classList.add('hidden');
  };

  document.getElementById('refresh-select').onchange = (e) => {
    prefs.refresh = +e.target.value; savePrefs(); startTimers();
  };

  document.getElementById('nearby-btn').onclick = findNearby;
}

function setSidebar(open) {
  document.getElementById('sidebar').classList.toggle('collapsed', !open);
  document.getElementById('backdrop').classList.toggle('hidden', !open);
}

function onResize() {
  if (window.innerWidth > 760) setSidebar(true);
}

function startTimers() {
  clearInterval(pollTimer);
  clearInterval(renderTimer);
  if (prefs.refresh > 0) pollTimer = setInterval(poll, prefs.refresh * 1000);
  renderTimer = setInterval(renderAll, 15000);   // keep countdowns ticking
}

/* px height of a timeline stop row — read from CSS so it stays in sync */
function rowH() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
  return parseFloat(v) || 56;
}

/* ── Realtime poll ──────────────────────────────────────────────────────── */
async function poll() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  const routes = Object.keys(GTFS.routes).join(',');
  try {
    const headers = {};
    if (auth.isAuthenticated()) headers['X-API-Key'] = auth.getToken();
    const res = await fetch(`${API_URL}?action=realtime&routes=${routes}`, { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'proxy error');
    lastData = data;
    lastPollClient = Date.now();
    buildRuns();
    renderAll();
  } catch (e) {
    console.error('poll failed', e);
    setFreshness('dead', 'proxy unreachable');
    document.documentElement.classList.remove('live');
    toast('Could not reach the bus proxy — ' + e.message);
  } finally {
    btn.classList.remove('spinning');
  }
}

/* serverNow(): current time on the feed's clock — immune to a wrong client
   clock, because data.fetched is the proxy's timestamp. */
function serverNow() {
  if (!lastData) return Date.now() / 1000;
  return lastData.fetched + (Date.now() - lastPollClient) / 1000;
}

/* ── Build the list of active trips from the realtime payload ───────────── */
function buildRuns() {
  runs = [];
  const now = serverNow();
  const vehByTrip = new Map();
  for (const v of lastData.vehicles || []) if (v.trip) vehByTrip.set(v.trip, v);
  const seenTrips = new Set();

  for (const tr of lastData.trips || []) {
    if (!tr.trip) continue;
    seenTrips.add(tr.trip);
    const lineKey = lineKeyForTrip(tr);
    const line = LINES.get(lineKey);

    const etas = new Map();
    for (const s of tr.stu || []) {
      const t = s.arr || s.dep;
      if (s.stop && t) etas.set(s.stop, t);
    }
    let nextStopId = null;
    for (const s of tr.stu || []) {
      const t = s.arr || s.dep;
      if (s.stop && t && t > now - 60) { nextStopId = s.stop; break; }
    }
    if (!nextStopId && tr.stu && tr.stu.length) nextStopId = tr.stu[0].stop;

    runs.push(makeRun(tr, line, lineKey, etas, nextStopId, vehByTrip.get(tr.trip)));
  }

  for (const v of lastData.vehicles || []) {
    if (!v.trip || seenTrips.has(v.trip)) continue;
    const lineKey = lineKeyForTrip(v);
    runs.push(makeRun(v, LINES.get(lineKey), lineKey, new Map(), null, v));
  }
}

function lineKeyForTrip(tr) {
  const patId = GTFS.trip_patterns[tr.trip];
  if (patId && PATTERNS.has(patId)) {
    const p = PATTERNS.get(patId);
    return p.route + ':' + p.dir;
  }
  return tr.route + ':' + (tr.dir != null ? tr.dir : 0);
}

function makeRun(tr, line, lineKey, etas, nextStopId, veh) {
  return {
    trip: tr.trip, lineKey, line,
    short: line ? line.short : tr.route,
    color: line ? line.color : '#2563eb',
    headsign: line ? line.headsign : '',
    etas, nextStopId,
    vehicle: veh || null,
    vehId: (veh && veh.id) || tr.vehicle || tr.id || '?',
    feedTs: tr.ts || (veh && veh.ts) || null,
  };
}

/* ════════════════════════════ Rendering ═══════════════════════════════ */
function renderAll() {
  renderFreshness();
  renderDeparturesBoard();
  renderTimelines();
  if (prefs.showMap && map) renderMap();
}

/* ── Freshness pill + live indicator ────────────────────────────────────── */
function renderFreshness() {
  if (!lastData) return;
  const feedTs = Math.min(lastData.vp_ts || Infinity, lastData.tu_ts || Infinity);
  if (!isFinite(feedTs)) { setFreshness('stale', 'no feed timestamp'); return; }
  const age = serverNow() - feedTs;
  let cls = 'fresh';
  if (age > 180) cls = 'dead';
  else if (age > 75) cls = 'stale';
  setFreshness(cls, (lastData.stale ? 'feed stale · ' : '') + 'data ' + fmtAgo(age));
  document.documentElement.classList.toggle('live', cls === 'fresh');
}
function setFreshness(cls, text) {
  document.getElementById('freshness').className = 'pill ' + cls;
  document.getElementById('freshness-text').textContent = text;
}

/* ── Departures board (favourite stops) ─────────────────────────────────── */
function renderDeparturesBoard() {
  const board = document.getElementById('departures-board');
  board.innerHTML = '';
  const now = serverNow();

  for (const sid of prefs.favStops) {
    const stop = GTFS.stops[sid];
    if (!stop) continue;

    const arrivals = [];
    for (const run of runs) {
      const t = run.etas.get(sid);
      if (t && t > now - 30) arrivals.push({ run, t, mins: (t - now) / 60 });
    }
    arrivals.sort((a, b) => a.t - b.t);

    const card = document.createElement('div');
    card.className = 'dep-card';
    if (arrivals.length && arrivals[0].mins <= 6) card.classList.add('urgent');

    let rows = arrivals.length === 0
      ? `<div class="dep-none">No live arrivals right now.</div>`
      : arrivals.slice(0, 4).map(a => `<div class="dep-row">
          ${badge(a.run)}
          <span class="headsign">${esc(a.run.headsign)}</span>
          ${etaBig(a.t, now)}</div>`).join('');

    card.innerHTML = `
      <div class="dep-head">
        <span class="stop-name">${esc(stop.name)}</span>
        <span class="stop-code">#${esc(stop.code)}</span>
      </div>
      <div class="dep-rows">${rows}</div>`;
    board.appendChild(card);
  }
}

/* ── Route timelines ────────────────────────────────────────────────────── */
function renderTimelines() {
  const host = document.getElementById('timelines');
  host.innerHTML = '';
  document.getElementById('empty-state')
    .classList.toggle('hidden', prefs.lines.length > 0);
  for (const key of prefs.lines) {
    const line = LINES.get(key);
    if (line) host.appendChild(buildTimelineCard(line));
  }
}

function buildTimelineCard(line) {
  const now = serverNow();
  const lineRuns = runs.filter(r => r.lineKey === line.key);
  const expanded = expandedCards.has(line.key);

  const card = document.createElement('div');
  card.className = 'timeline-card' + (expanded ? ' expanded' : '');

  const head = document.createElement('div');
  head.className = 'timeline-head';
  head.innerHTML = `
    <span class="tl-chevron">▶</span>
    <span class="route-badge" style="background:${line.color};color:${line.text}">
      ${esc(line.short)}</span>
    <span class="tl-title">→ ${esc(line.headsign)}</span>
    <span class="tl-sub">${lineRuns.length} bus${lineRuns.length === 1 ? '' : 'es'}
      · ${line.pattern.stops.length} stops · tap to
      ${expanded ? 'collapse' : 'expand'}</span>`;
  head.onclick = () => {
    if (expandedCards.has(line.key)) expandedCards.delete(line.key);
    else expandedCards.add(line.key);
    savePrefs(); renderTimelines();
  };
  card.appendChild(head);

  card.appendChild(expanded
    ? buildFullBody(line, lineRuns, now)
    : buildCompactBody(line, lineRuns, now));
  return card;
}

/* ── Compact body — bus-style strips ────────────────────────────────────── */
function buildCompactBody(line, lineRuns, now) {
  const body = document.createElement('div');
  body.className = 'compact-body';
  if (lineRuns.length === 0) {
    body.innerHTML = `<div class="tl-empty">No buses currently running
      this direction.</div>`;
    return body;
  }
  // Soonest buses first.
  const ordered = lineRuns.slice().sort((a, b) => {
    const ta = a.nextStopId ? a.etas.get(a.nextStopId) : Infinity;
    const tb = b.nextStopId ? b.etas.get(b.nextStopId) : Infinity;
    return (ta || Infinity) - (tb || Infinity);
  });
  for (const run of ordered) body.appendChild(buildBusStrip(run, line, now));
  return body;
}

function buildBusStrip(run, line, now) {
  const stops = line.pattern.stops;
  let nextIdx = run.nextStopId ? stops.indexOf(run.nextStopId) : -1;
  if (nextIdx < 0 && run.vehicle && run.vehicle.lat != null)
    nextIdx = nearestStopIndex(stops, run.vehicle.lat, run.vehicle.lon);

  const strip = document.createElement('div');
  strip.className = 'bus-strip';
  const old = run.feedTs && (now - run.feedTs > STALE_VEHICLE);

  if (nextIdx < 0) {
    strip.innerHTML = `${badge(run)}
      <span class="strip-stops"><span class="from">Location unknown</span></span>
      <span class="strip-veh">#${esc(run.vehId)}</span>`;
    return strip;
  }

  const lastIdx = stops.length - 1;
  const stopName = i => esc((GTFS.stops[stops[i]] || {}).name || stops[i]);
  const fromTxt  = nextIdx > 0 ? `<span class="from">${stopName(nextIdx - 1)}</span>
    <span class="strip-arrow">›</span>` : '';
  const atTerm   = nextIdx >= lastIdx;
  const moreDots = (nextIdx < lastIdx - 1)
    ? `<span class="strip-more">··</span>` : '';
  const termTxt  = atTerm ? '' :
    `${moreDots}<span class="term">${stopName(lastIdx)}</span>`;

  const eta = run.nextStopId ? run.etas.get(run.nextStopId) : null;
  const etaSec = eta ? eta - now : null;
  const etaCls = etaSec == null ? '' : (etaSec < 45 ? 'now' : (etaSec < 360 ? 'soon' : ''));

  strip.innerHTML = `
    ${badge(run)}
    ${old ? '' : '<span class="live-dot"></span>'}
    <span class="strip-stops">
      ${fromTxt}
      <span class="to">${stopName(nextIdx)}</span>
      ${termTxt}
    </span>
    <span class="strip-veh">#${esc(run.vehId)}</span>
    <span class="strip-eta ${etaCls}">${eta ? fmtEta(etaSec) : '—'}</span>`;
  return strip;
}

/* ── Full body — rail + every stop ──────────────────────────────────────── */
function buildFullBody(line, lineRuns, now) {
  const stops = line.pattern.stops;
  const H = rowH();
  const body = document.createElement('div');
  body.className = 'timeline-body';
  body.innerHTML = `<div class="rail"></div>`;

  stops.forEach((sid, i) => {
    const stop = GTFS.stops[sid] || { name: sid, code: '?' };
    const isFav = prefs.favStops.includes(sid);
    const terminus = (i === 0 || i === stops.length - 1);
    const etas = lineRuns.map(r => r.etas.get(sid))
      .filter(t => t && t > now - 30).sort((a, b) => a - b).slice(0, 3);

    const row = document.createElement('div');
    row.className = 'stop-row' + (isFav ? ' is-fav' : '') +
                    (terminus ? ' terminus' : '');
    row.innerHTML = `
      <div class="stop-node"></div>
      <div class="stop-main">
        <div class="stop-name">${esc(stop.name)}</div>
        <div class="stop-meta">
          <span class="stop-code-tag">#${esc(stop.code)}</span>
        </div>
      </div>
      <div class="stop-etas">
        ${etas.map(t => etaChip(t, now)).join('') ||
          '<span class="stop-meta">—</span>'}
      </div>
      <button class="fav-toggle ${isFav ? 'on' : ''}"
              title="Favourite this stop">★</button>`;
    row.querySelector('.fav-toggle').onclick = () => toggleFav(sid);
    body.appendChild(row);
  });

  for (const run of lineRuns) {
    const marker = buildBusMarker(run, stops, now, H);
    if (marker) body.appendChild(marker);
  }
  if (lineRuns.length === 0) {
    const note = document.createElement('div');
    note.className = 'tl-empty';
    note.textContent = 'No buses currently running this direction.';
    body.appendChild(note);
  }
  return body;
}

function buildBusMarker(run, stops, now, H) {
  let nextIdx = run.nextStopId ? stops.indexOf(run.nextStopId) : -1;
  if (nextIdx < 0 && run.vehicle && run.vehicle.lat != null)
    nextIdx = nearestStopIndex(stops, run.vehicle.lat, run.vehicle.lon);
  if (nextIdx < 0) return null;

  let frac = 0.55;
  const prevIdx = Math.max(0, nextIdx - 1);
  if (run.vehicle && run.vehicle.lat != null && nextIdx > 0) {
    const a = GTFS.stops[stops[prevIdx]], b = GTFS.stops[stops[nextIdx]];
    if (a && b) {
      const dA = haversine(a.lat, a.lon, run.vehicle.lat, run.vehicle.lon);
      const dB = haversine(b.lat, b.lon, run.vehicle.lat, run.vehicle.lon);
      if (dA + dB > 0) frac = Math.min(0.95, Math.max(0.05, dA / (dA + dB)));
    }
  }
  const top = Math.max(0, prevIdx + frac) * H + H / 2;
  const eta = run.nextStopId ? run.etas.get(run.nextStopId) : null;
  const old = run.feedTs && (now - run.feedTs > STALE_VEHICLE);

  const m = document.createElement('div');
  m.className = 'bus-marker' + (old ? ' faded' : '');
  m.style.top = top + 'px';
  m.innerHTML = `
    <div class="bus-dot" style="background:${run.color}">🚌</div>
    <div class="bus-info">
      <span class="veh">#${esc(run.vehId)}</span> ·
      ${eta ? esc(fmtEta(eta - now)) : 'tracking'}
      ${occDot(run.vehicle && run.vehicle.occ)}
    </div>`;
  return m;
}

/* ── Map (optional, Leaflet) ────────────────────────────────────────────── */
async function enableMap() {
  document.getElementById('map-wrap').classList.remove('hidden');
  if (!map) {
    await loadLeaflet();
    map = L.map('map', { zoomControl: true }).setView([45.402, -75.642], 13);
    tileLayer = L.tileLayer(TILES[prefs.theme] || TILES.light, {
      maxZoom: 20, subdomains: 'abcd',
      attribution: '© OpenStreetMap, © CARTO',
    }).addTo(map);
    mapLayers = { shapes: L.layerGroup().addTo(map),
                  stops:  L.layerGroup().addTo(map),
                  buses:  L.layerGroup().addTo(map) };
  }
  drawMapStatic();
  renderMap();
}

function loadLeaflet() {
  return new Promise((resolve) => {
    if (window.L) return resolve();
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = resolve;
    document.head.appendChild(js);
  });
}

function drawMapStatic() {
  mapLayers.shapes.clearLayers();
  mapLayers.stops.clearLayers();
  const bounds = [];
  for (const key of prefs.lines) {
    const line = LINES.get(key);
    if (!line) continue;
    const shape = GTFS.shapes[line.pattern.shape];
    if (shape && shape.length) {
      L.polyline(shape, { color: line.color, weight: 4, opacity: 0.7 })
        .addTo(mapLayers.shapes);
      shape.forEach(p => bounds.push(p));
    }
    for (const sid of line.pattern.stops) {
      const s = GTFS.stops[sid];
      if (!s) continue;
      L.circleMarker([s.lat, s.lon], {
        radius: 5, color: line.color, weight: 2,
        fillColor: '#fff', fillOpacity: 1,
      }).bindPopup(`<strong>${esc(s.name)}</strong><br>Stop #${esc(s.code)}`)
        .addTo(mapLayers.stops);
    }
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
}

function renderMap() {
  if (!mapLayers) return;
  mapLayers.buses.clearLayers();
  for (const run of runs) {
    const v = run.vehicle;
    if (!v || v.lat == null) continue;
    const icon = L.divIcon({
      className: '', iconSize: [26, 26],
      html: `<div class="bus-pin" style="background:${run.color}">
               ${esc(run.short)}</div>`,
    });
    const eta = run.nextStopId ? run.etas.get(run.nextStopId) : null;
    const next = run.nextStopId && GTFS.stops[run.nextStopId]
      ? GTFS.stops[run.nextStopId].name : '—';
    L.marker([v.lat, v.lon], { icon })
      .bindPopup(`<strong>Route ${esc(run.short)}</strong> → ${esc(run.headsign)}<br>
        Bus #${esc(v.id)}<br>Next: ${esc(next)}
        ${eta ? ' · ' + fmtEta(eta - serverNow()) : ''}`)
      .addTo(mapLayers.buses);
  }
}

/* ── Line picker ────────────────────────────────────────────────────────── */
function renderLinePicker() {
  const host = document.getElementById('line-picker');
  host.innerHTML = '';
  for (const line of LINES.values()) {
    const lbl = document.createElement('label');
    lbl.className = 'line-opt';
    lbl.innerHTML = `
      <input type="checkbox" ${prefs.lines.includes(line.key) ? 'checked' : ''}>
      <span class="route-badge" style="background:${line.color};color:${line.text}">
        ${esc(line.short)}</span>
      <span class="ln-name">→ ${esc(line.headsign)}</span>`;
    lbl.querySelector('input').onchange = (e) => {
      if (e.target.checked) {
        if (!prefs.lines.includes(line.key)) prefs.lines.push(line.key);
        if (!prefs.compact) expandedCards.add(line.key);
      } else {
        prefs.lines = prefs.lines.filter(k => k !== line.key);
        expandedCards.delete(line.key);
      }
      savePrefs();
      renderTimelines();
      if (prefs.showMap && map) drawMapStatic();
    };
    host.appendChild(lbl);
  }
}

/* ── Favourite stops ────────────────────────────────────────────────────── */
function renderFavStops() {
  const host = document.getElementById('fav-stops');
  host.innerHTML = '';
  if (prefs.favStops.length === 0) {
    host.innerHTML = `<div class="empty-mini">None yet — tap ★ on any stop in
      an expanded timeline, or use “Find stops near me”.</div>`;
    return;
  }
  for (const sid of prefs.favStops) {
    const s = GTFS.stops[sid];
    if (!s) continue;
    const row = document.createElement('div');
    row.className = 'fav-stop-row';
    row.innerHTML = `
      <span class="stop-code">#${esc(s.code)}</span>
      <span class="nm">${esc(s.name)}</span>
      <button class="mini-x" title="Remove">✕</button>`;
    row.querySelector('.mini-x').onclick = () => toggleFav(sid);
    host.appendChild(row);
  }
}

function toggleFav(sid) {
  if (prefs.favStops.includes(sid))
    prefs.favStops = prefs.favStops.filter(s => s !== sid);
  else
    prefs.favStops.push(sid);
  savePrefs();
  renderFavStops();
  renderDeparturesBoard();
  renderTimelines();
}

/* ── Nearby stops (geolocation) ─────────────────────────────────────────── */
function findNearby() {
  const list = document.getElementById('nearby-list');
  if (!navigator.geolocation) { toast('Geolocation not available.'); return; }
  list.innerHTML = '<div class="empty-mini">Locating…</div>';

  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    const ranked = Object.entries(GTFS.stops)
      .map(([sid, s]) => ({ sid, s, d: haversine(latitude, longitude, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);

    list.innerHTML = '';
    for (const { sid, s, d } of ranked) {
      const rts = [...(stopRoutes.get(sid) || [])].sort().join(', ');
      const item = document.createElement('div');
      item.className = 'nearby-item';
      item.innerHTML = `
        <span>${esc(s.name)}
          <span class="dist">${fmtDist(d)} · routes ${esc(rts || '—')}</span>
        </span>
        <button class="add">${prefs.favStops.includes(sid) ? '✓' : '+ add'}</button>`;
      item.querySelector('.add').onclick = () => {
        toggleFav(sid);
        item.querySelector('.add').textContent =
          prefs.favStops.includes(sid) ? '✓' : '+ add';
      };
      list.appendChild(item);
    }
  }, (err) => {
    list.innerHTML = `<div class="empty-mini">Location error: ${esc(err.message)}</div>`;
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

/* ── Auth area ──────────────────────────────────────────────────────────── */
async function renderAuth() {
  const host = document.getElementById('auth-area');
  if (auth.isAuthenticated()) {
    host.innerHTML = `<div class="auth-user">Signed in
      <button class="link-btn" id="logout-btn">log out</button></div>`;
    document.getElementById('logout-btn').onclick = () => { auth.logout(); renderAuth(); };
    const user = await auth.whoami();
    if (user && (user.given_name || user.name)) {
      host.querySelector('.auth-user').firstChild.textContent =
        'Signed in as ' + (user.given_name || user.name) + ' ';
    }
  } else {
    host.innerHTML = `Login isn’t required — the app works for everyone.
      <button class="link-btn" id="login-btn">Sign in with jjjp.ca</button>`;
    document.getElementById('login-btn').onclick = () => auth.login();
  }
}

/* ════════════════════════════ Helpers ═════════════════════════════════ */
function nearestStopIndex(stops, lat, lon) {
  let best = -1, bestD = Infinity;
  stops.forEach((sid, i) => {
    const s = GTFS.stops[sid];
    if (!s) return;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLa = (la2 - la1) * toRad, dLo = (lo2 - lo1) * toRad;
  const a = Math.sin(dLa / 2) ** 2 +
            Math.cos(la1 * toRad) * Math.cos(la2 * toRad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtEta(sec) {
  if (sec < 45) return 'due';
  return Math.round(sec / 60) + ' min';
}
function fmtAgo(sec) {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? sec + 's ago' : Math.round(sec / 60) + 'm ago';
}
function fmtDist(m) {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
}
function fmtClock(unix) {
  return new Date(unix * 1000).toLocaleTimeString([],
    { hour: 'numeric', minute: '2-digit' });
}
function etaClass(sec) {
  if (sec < 45) return 'now';
  if (sec < 6 * 60) return 'soon';
  return 'later';
}
function etaBig(t, now) {
  const sec = t - now;
  return `<span class="dep-eta ${etaClass(sec)}">${fmtEta(sec)}
    <small>${fmtClock(t)}</small></span>`;
}
function etaChip(t, now) {
  const sec = t - now;
  const cls = sec < 45 ? 'now' : (sec < 6 * 60 ? 'soon' : '');
  return `<span class="eta-chip ${cls}">${fmtEta(sec)}</span>`;
}
function badge(run) {
  return `<span class="route-badge big" style="background:${run.color}">
    ${esc(run.short)}</span>`;
}
function occDot(occ) {
  if (occ == null) return '';
  const cls = occ <= 1 ? 'occ-1' : (occ <= 3 ? 'occ-2' : 'occ-3');
  return `<span class="occ-dot ${cls}" title="Occupancy"></span>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}
