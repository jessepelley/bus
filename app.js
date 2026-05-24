/* ════════════════════════════════════════════════════════════════════════
   OC Transpo Live — bus.jjjp.ca
   Static front-end. Talks to the NAS proxy for the realtime feeds and to the
   bundled GTFS schedule (data/index.json + per-route data/routes/<id>.json,
   loaded on demand) for the start-to-end stop list.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';

// Production proxy. For local testing, set window.BUS_API_URL before app.js
// loads to point at a local PHP server — api.php allows the localhost origin.
const API_URL   = window.BUS_API_URL || 'https://jjjp.ca/bus/api.php';
// Bundled schedule data. index.json + stops.json load once at launch; each
// route's stop lists / shapes live in data/routes/<id>.json and are fetched
// only when that route is actually shown — so the app stays light no matter
// how many of OC Transpo's routes are in the bundle.
const INDEX_URL = 'data/index.json';
const STOPS_URL = 'data/stops.json';
const ROUTE_URL = (file) => `data/routes/${file}.json`;
const PREFS_KEY = 'busjjjp.prefs';
const STALE_VEHICLE = 150;                  // s — a bus older than this is "faded"

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const META_THEME = { light: '#ffffff', dark: '#16161a' };

/* ── State ──────────────────────────────────────────────────────────────── */
let GTFS        = null;                     // {generated, routes, stops, shapes, trip_patterns}
let LINES       = new Map();                // "route:dir" -> line object (pattern filled lazily)
let PATTERNS    = new Map();                // patternId -> pattern object
let loadedRoutes = new Set();               // route ids whose data/routes/<id>.json is loaded
const routeLoads = new Map();               // route id -> in-flight load Promise (dedup)
const routeLoadFailed = new Set();          // route ids whose detail file failed to load

let runs        = [];
let lastData    = null;
let lastPollClient = 0;
let pollTimer   = null;
let renderTimer = null;
let statsTimer  = null;
let statsByRoute = {};                      // routeId -> reliability stats
let map = null, mapLayers = null, tileLayer = null;
let nearbyMap = null, nearbyMapLayers = null, nearbyTiles = null;
let lastNearbyResults = null;               // { me:{lat,lon}, items:[{sid,s,d}] }
const expandedCards = new Set();            // line keys shown as full timelines

const prefs = {
  lines:    ['45:1', '5:0'],
  favStops: [],                             // mirror of activeGroup().stopIds — see syncActiveStops()
  stopGroups: [],                           // [{ id, name, stopIds:[] }]
  activeGroupId: null,
  nearbyOnMap: false,
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
    const [index, stops] = await Promise.all([
      fetch(INDEX_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch(STOPS_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    ]);
    GTFS = {
      generated: index.generated, tz: index.tz,
      routes: index.routes,                  // light metadata; patterns added on load
      stops,                                 // all stops, shared by every route
      shapes: {}, trip_patterns: {},         // merged in as route files load
    };
  } catch (e) {
    document.getElementById('timelines').innerHTML =
      `<div class="empty-state">Could not load the bundled schedule
       (${INDEX_URL}). Run <code>build-data.py</code> first.</div>`;
    return;
  }

  buildLinesFromIndex();
  document.getElementById('data-date').textContent = GTFS.generated || '—';

  prefs.lines = prefs.lines.filter(k => LINES.has(k));
  if (prefs.lines.length === 0)
    prefs.lines = [...LINES.keys()].sort(compareLineKeys).slice(0, 2);
  for (const k of prefs.expanded) if (LINES.has(k)) expandedCards.add(k);

  // Fetch the data files for the routes that are about to be shown.
  await ensureLinesLoaded(prefs.lines);

  renderLinePicker();
  renderFavStops();
  if (prefs.showMap) { document.getElementById('map-toggle').checked = true; enableMap(); }

  await poll();
  startTimers();
  pollStats();
  statsTimer = setInterval(pollStats, 300000);   // reliability changes slowly

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
  window.addEventListener('resize', onResize);
}

/* ── Reliability stats ──────────────────────────────────────────────────── */
async function pollStats() {
  const routes = [...new Set(
    prefs.lines.map(k => LINES.get(k)).filter(Boolean).map(l => l.routeId))];
  const headers = {};
  if (auth.isAuthenticated()) headers['X-API-Key'] = auth.getToken();
  for (const route of routes) {
    try {
      const res = await fetch(`${API_URL}?action=stats&route=${route}&days=7`, { headers });
      if (res.ok) statsByRoute[route] = await res.json();
    } catch (e) { /* stats are optional — ignore */ }
  }
  renderTimelines();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
  }
}

/* ── Bundled data: light index now, per-route detail on demand ──────────── */

/* One LINES entry per route:direction, from the lightweight index. The
   `pattern` (stop list + shape) is null until the route's file is loaded. */
function buildLinesFromIndex() {
  for (const [rid, route] of Object.entries(GTFS.routes)) {
    route.patterns = route.patterns || [];
    for (const d of route.dirs || []) {
      const key = rid + ':' + d.dir;
      LINES.set(key, {
        key, routeId: rid, dir: d.dir,
        short: route.short, long: route.long,
        color: '#' + route.color, text: '#' + route.text,
        headsign: d.headsign, pattern: null,
      });
    }
  }
}

/* Fetch and merge one route's detail file (patterns, shapes, trip->pattern).
   Deduplicates concurrent calls and is a no-op once a route is loaded. */
function loadRouteData(rid) {
  if (loadedRoutes.has(rid)) return Promise.resolve();
  if (routeLoads.has(rid)) return routeLoads.get(rid);

  const route = GTFS.routes[rid];
  if (!route) return Promise.resolve();

  const promise = fetch(ROUTE_URL(route.file))
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(detail => {
      route.patterns = detail.patterns || [];
      Object.assign(GTFS.shapes, detail.shapes || {});
      Object.assign(GTFS.trip_patterns, detail.trip_patterns || {});
      prepareRoute(rid);
      loadedRoutes.add(rid);
      routeLoadFailed.delete(rid);
    })
    .catch(e => {
      console.error('route ' + rid + ' failed to load', e);
      routeLoadFailed.add(rid);          // don't auto-retry every render
    })
    .finally(() => routeLoads.delete(rid));

  routeLoads.set(rid, promise);
  return promise;
}

/* Index PATTERNS and fill each LINES entry's representative pattern (the
   longest one per direction) once a route's detail file has arrived. */
function prepareRoute(rid) {
  const route = GTFS.routes[rid];
  const byDir = {};
  for (const pat of route.patterns) {
    PATTERNS.set(pat.id, pat);
    if (!byDir[pat.dir] || pat.stops.length > byDir[pat.dir].stops.length)
      byDir[pat.dir] = pat;
  }
  for (const [dir, pat] of Object.entries(byDir)) {
    const key = rid + ':' + dir;
    let line = LINES.get(key);
    if (!line) {
      line = { key, routeId: rid, dir: +dir,
               short: route.short, long: route.long,
               color: '#' + route.color, text: '#' + route.text,
               headsign: pat.headsign, pattern: null };
      LINES.set(key, line);
    }
    line.pattern = pat;
    line.headsign = pat.headsign;
  }
}

/* Ensure the detail files for every route referenced by these line keys are
   loaded. Returns a Promise that resolves once they all are. */
function ensureLinesLoaded(lineKeys) {
  const rids = [...new Set(
    lineKeys.map(k => LINES.get(k)).filter(Boolean).map(l => l.routeId))];
  return Promise.all(rids.map(loadRouteData));
}

/* Sort "route:dir" keys by route number, then direction. */
function compareLineKeys(a, b) {
  const la = LINES.get(a), lb = LINES.get(b);
  const na = parseInt(la ? la.short : a, 10);
  const nb = parseInt(lb ? lb.short : b, 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── Preferences ────────────────────────────────────────────────────────── */
function loadPrefs() {
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
  } catch (e) { /* keep defaults */ }
  migrateStopGroups();
  document.getElementById('refresh-select').value = String(prefs.refresh);
  document.getElementById('theme-select').value = prefs.theme;
  document.getElementById('compact-toggle').checked = prefs.compact;
  const nmToggle = document.getElementById('nearby-map-toggle');
  if (nmToggle) nmToggle.checked = !!prefs.nearbyOnMap;
}
function savePrefs() {
  prefs.expanded = [...expandedCards];
  // favStops is a derived mirror of the active group; don't persist it.
  const { favStops, ...persist } = prefs;
  localStorage.setItem(PREFS_KEY, JSON.stringify(persist));
}

/* ── Stop groups ────────────────────────────────────────────────────────── */
/* Backwards-compat: if the user has older prefs with a flat favStops array,
   migrate it into a single "Saved" group. After this, the canonical store is
   prefs.stopGroups and prefs.favStops is just a live mirror of whichever
   group is currently active (kept so existing render code stays simple). */
function migrateStopGroups() {
  if (!Array.isArray(prefs.stopGroups) || prefs.stopGroups.length === 0) {
    prefs.stopGroups = [{
      id: 'g_default',
      name: 'Saved',
      stopIds: Array.isArray(prefs.favStops) ? prefs.favStops.slice() : [],
    }];
    prefs.activeGroupId = 'g_default';
  } else if (!prefs.activeGroupId ||
             !prefs.stopGroups.find(g => g.id === prefs.activeGroupId)) {
    prefs.activeGroupId = prefs.stopGroups[0].id;
  }
  syncActiveStops();
}
function activeGroup() {
  return prefs.stopGroups.find(g => g.id === prefs.activeGroupId) || prefs.stopGroups[0];
}
function syncActiveStops() {
  prefs.favStops = activeGroup().stopIds.slice();
}
function setActiveGroup(gid) {
  if (!prefs.stopGroups.find(g => g.id === gid)) return;
  prefs.activeGroupId = gid;
  syncActiveStops();
  savePrefs();
  renderFavStops();
  renderDeparturesBoard();
  renderTimelines();
}
function addGroup() {
  const name = prompt('Name for this group of stops (e.g. “To work”):', '');
  if (!name || !name.trim()) return;
  const g = { id: 'g_' + Date.now().toString(36),
              name: name.trim().slice(0, 40), stopIds: [] };
  prefs.stopGroups.push(g);
  setActiveGroup(g.id);
}
function editGroup(gid) {
  const g = prefs.stopGroups.find(x => x.id === gid);
  if (!g) return;
  const reply = prompt(
    `Rename “${g.name}”, or type the word "delete" to remove this group.\n` +
    `(Stops in the group will be removed from your saved list, but the stops\n` +
    ` themselves stay in OC Transpo — you can re-add them anywhere.)\n\n` +
    `New name:`, g.name);
  if (reply == null) return;
  const text = reply.trim();
  if (text.toLowerCase() === 'delete') {
    if (prefs.stopGroups.length <= 1) {
      toast('Keep at least one group — rename it instead.');
      return;
    }
    if (!confirm(`Delete the “${g.name}” group?`)) return;
    prefs.stopGroups = prefs.stopGroups.filter(x => x.id !== gid);
    if (prefs.activeGroupId === gid)
      prefs.activeGroupId = prefs.stopGroups[0].id;
    setActiveGroup(prefs.activeGroupId);
    return;
  }
  if (text) g.name = text.slice(0, 40);
  savePrefs();
  renderFavStops();
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
  if (nearbyMap && nearbyTiles) {
    nearbyMap.removeLayer(nearbyTiles);
    nearbyTiles = L.tileLayer(TILES[theme], {
      maxZoom: 20, subdomains: 'abcd',
    }).addTo(nearbyMap);
    nearbyTiles.bringToBack();
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

  const nmToggle = document.getElementById('nearby-map-toggle');
  if (nmToggle) nmToggle.onchange = (e) => {
    prefs.nearbyOnMap = e.target.checked;
    savePrefs();
    if (prefs.nearbyOnMap) {
      enableNearbyMap();
    } else {
      document.getElementById('nearby-map').classList.add('hidden');
    }
  };

  document.getElementById('line-search').oninput = () => renderLinePicker();
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
  // Only ask the proxy for the routes currently on screen — this keeps the
  // realtime payload small and scopes the proxy's reliability sampling to
  // exactly the routes people are looking at.
  const routes = [...new Set(
    prefs.lines.map(k => LINES.get(k)).filter(Boolean).map(l => l.routeId))].join(',');
  if (!routes) {
    lastData = { ok: true, fetched: Date.now() / 1000, vehicles: [], trips: [] };
    lastPollClient = Date.now();
    buildRuns();
    renderAll();
    return;
  }
  btn.classList.add('spinning');
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
  renderFavStops();                          // refresh live-feed dots per poll
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

  // Route detail not in yet — show a placeholder and kick off the load
  // (unless a previous attempt failed, in which case don't retry-spam).
  if (!line.pattern) {
    const failed = routeLoadFailed.has(line.routeId);
    if (!failed)
      loadRouteData(line.routeId).then(() => { if (line.pattern) renderTimelines(); });
    const card = document.createElement('div');
    card.className = 'timeline-card';
    card.innerHTML = `<div class="timeline-head">
      <span class="route-badge" style="background:${line.color};color:${line.text}">
        ${esc(line.short)}</span>
      <span class="tl-title">→ ${esc(line.headsign)}</span>
      <span class="tl-sub">${failed ? 'route data unavailable' : 'loading…'}</span></div>`;
    return card;
  }

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

  const strip = buildReliabilityStrip(line.routeId);
  if (strip) card.appendChild(strip);

  card.appendChild(expanded
    ? buildFullBody(line, lineRuns, now)
    : buildCompactBody(line, lineRuns, now));
  return card;
}

/* A per-route reliability summary. Hidden entirely if the stats endpoint
   reports unavailable (no schedule deployed, or no data gathered yet). */
function buildReliabilityStrip(routeId) {
  const s = statsByRoute[routeId];
  if (!s || !s.available) return null;

  const today = (s.by_day && s.by_day[0]) || null;
  const parts = [];
  let otp = null;
  if (today && today.measured > 0) {
    otp = today.on_time_pct;
    parts.push(`${otp}% on time today`);
    if (today.avg_delay_sec != null) parts.push('avg ' + fmtDelay(today.avg_delay_sec));
  } else {
    parts.push('today: no data yet');
  }
  if (today && today.scheduled > 0) parts.push(`${today.observed}/${today.scheduled} trips ran`);
  if (s.days > 1 && s.measured > 0) parts.push(`7-day ${s.on_time_pct}%`);

  const grade = otp != null ? otp : s.on_time_pct;
  const dotCls = grade == null ? 'ok' : (grade >= 90 ? 'good' : grade >= 75 ? 'ok' : 'bad');

  const el = document.createElement('div');
  el.className = 'reliability';
  const mf = s.monitored_from;
  el.title = 'On-time = within −1 to +5 min of schedule, estimated from '
    + 'predicted arrivals. Reliability is gathered while people use the app — '
    + 'numbers cover the times this route was being watched, not the whole day. '
    + 'Cancellations are inferred — OC Transpo publishes no official signal. '
    + (mf ? 'Watched since ' + fmtClock(mf) + ' today.' : 'Not watched yet today.');

  let html = `<span class="rel-dot ${dotCls}"></span>`
           + `<span class="rel-text">${esc(parts.join(' · '))}`;
  if (today && today.missed > 0)
    html += ` · <span class="rel-miss">${today.missed} missed</span>`;
  html += '</span>';
  el.innerHTML = html;
  return el;
}

/* ── Compact body — saved-stop view ─────────────────────────────────────── */
/* The compact view is *from a saved stop's perspective*: for each saved stop
   that lies on this line+direction, show one mini-strip that says where the
   closest approaching bus currently is, using a chain-of-dots that omits the
   stops in between. Falls back to per-bus strips if you have no saved stops
   on this line yet. */
function buildCompactBody(line, lineRuns, now) {
  const body = document.createElement('div');
  body.className = 'compact-body';
  const stops = line.pattern.stops;
  const stopSet = new Set(stops);
  // Saved stops in the active group that lie on this direction, in route order.
  const savedOnLine = stops.filter(sid => activeGroup().stopIds.includes(sid));

  if (savedOnLine.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'mini-empty';
    hint.textContent =
      'No saved stops from “' + activeGroup().name + '” on this direction — ' +
      'showing buses instead. Expand the timeline and tap ★ on a stop to ' +
      'pin it here.';
    body.appendChild(hint);
    if (lineRuns.length === 0) {
      const note = document.createElement('div');
      note.className = 'tl-empty';
      note.textContent = 'No buses currently running this direction.';
      body.appendChild(note);
      return body;
    }
    const ordered = lineRuns.slice().sort((a, b) => {
      const ta = a.nextStopId ? a.etas.get(a.nextStopId) : Infinity;
      const tb = b.nextStopId ? b.etas.get(b.nextStopId) : Infinity;
      return (ta || Infinity) - (tb || Infinity);
    });
    for (const run of ordered) body.appendChild(buildBusStrip(run, line, now));
    return body;
  }

  for (const sid of savedOnLine) {
    body.appendChild(buildStopMiniStrip(sid, line, lineRuns, stops, now));
  }
  return body;
}

/* One row per saved-stop-on-this-line: route badge, stop name, chain dots
   showing the closest approaching bus's position, and ETA. */
function buildStopMiniStrip(savedSid, line, lineRuns, stops, now) {
  const savedIdx = stops.indexOf(savedSid);
  const stop = GTFS.stops[savedSid] || { name: savedSid, code: '?' };

  // Pick the run that reaches this stop soonest.
  let bestRun = null, bestEta = Infinity;
  for (const run of lineRuns) {
    const t = run.etas.get(savedSid);
    if (t == null || t < now - 30) continue;
    if (t < bestEta) { bestEta = t; bestRun = run; }
  }

  // Where the chosen bus is right now (its next-stop index on this pattern).
  let busIdx = -1;
  if (bestRun) {
    busIdx = bestRun.nextStopId ? stops.indexOf(bestRun.nextStopId) : -1;
    if (busIdx < 0 && bestRun.vehicle && bestRun.vehicle.lat != null)
      busIdx = nearestStopIndex(stops, bestRun.vehicle.lat, bestRun.vehicle.lon);
  }

  const strip = document.createElement('div');
  strip.className = 'mini-strip is-fav';

  const etaSec = bestRun ? bestEta - now : null;
  const etaCls = etaSec == null ? 'none'
    : (etaSec < 45 ? 'now' : etaSec < 6 * 60 ? 'soon' : 'later');
  const etaText = etaSec == null ? 'no live bus' : fmtEta(etaSec);

  const badgeRun = bestRun || { color: line.color, short: line.short };

  strip.innerHTML = `
    <div class="mini-head">
      ${badge(badgeRun)}
      <span class="mini-name" title="${esc(stop.name)}">${esc(stop.name)}</span>
      <span class="stop-code-tag">#${esc(stop.code)}</span>
      <span class="mini-eta ${etaCls}">${esc(etaText)}</span>
    </div>
    ${buildMiniChain(busIdx, savedIdx)}`;
  return strip;
}

/* The visual symbol the user asked for:
   bus • next-stop  ···(hidden)···  prev-of-saved • saved.
   Big dots = visible stops, tiny clustered dots = omitted stops. */
function buildMiniChain(busIdx, savedIdx) {
  let html = '<div class="mini-chain">';
  if (busIdx < 0) {
    html += '<span class="chain-dot saved"></span>';
    html += '</div>';
    return html;
  }
  const gap = savedIdx - busIdx;
  const skip = (n) => {
    let s = '<span class="chain-skip">';
    for (let i = 0; i < n; i++) s += '<span class="skip-dot"></span>';
    return s + '</span>';
  };
  if (gap < 0) {
    // Bus already past the saved stop on this trip.
    html += '<span class="chain-dot saved"></span>' + skip(3) +
            '<span class="chain-dot bus-here"></span>';
  } else if (gap === 0) {
    html += '<span class="chain-dot bus-here saved"></span>';
  } else if (gap === 1) {
    html += '<span class="chain-dot bus-here"></span>' +
            '<span class="chain-dot saved"></span>';
  } else if (gap === 2) {
    html += '<span class="chain-dot bus-here"></span>' +
            '<span class="chain-dot"></span>' +
            '<span class="chain-dot saved"></span>';
  } else if (gap === 3) {
    // Bus, next, prev-of-saved, saved — nothing to hide yet.
    html += '<span class="chain-dot bus-here"></span>' +
            '<span class="chain-dot"></span>' +
            '<span class="chain-dot"></span>' +
            '<span class="chain-dot saved"></span>';
  } else {
    // gap >= 4: bus, next, [hidden cluster], prev-of-saved, saved.
    const hidden = gap - 3;
    const dots = Math.min(4, Math.max(2, hidden));
    html += '<span class="chain-dot bus-here"></span>' +
            '<span class="chain-dot"></span>' +
            skip(dots) +
            '<span class="chain-dot"></span>' +
            '<span class="chain-dot saved"></span>';
  }
  html += '</div>';
  return html;
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
  // Leaflet measures its container at init. If we were hidden when it was
  // first attached (or if the toggle was just flipped on), the container
  // had zero size and tiles never paint. Force a remeasure now.
  requestAnimationFrame(() => { if (map) map.invalidateSize(); });
  drawMapStatic();
  renderMap();
}

async function enableNearbyMap() {
  const wrap = document.getElementById('nearby-map');
  wrap.classList.remove('hidden');
  if (!nearbyMap) {
    await loadLeaflet();
    nearbyMap = L.map('nearby-map', {
      zoomControl: true, attributionControl: false,
    }).setView([45.402, -75.642], 14);
    nearbyTiles = L.tileLayer(TILES[prefs.theme] || TILES.light, {
      maxZoom: 20, subdomains: 'abcd',
    }).addTo(nearbyMap);
    nearbyMapLayers = L.layerGroup().addTo(nearbyMap);
  }
  requestAnimationFrame(() => { if (nearbyMap) nearbyMap.invalidateSize(); });
  drawNearbyMarkers();
}

function drawNearbyMarkers() {
  if (!nearbyMap || !nearbyMapLayers) return;
  nearbyMapLayers.clearLayers();
  if (!lastNearbyResults) return;
  const { me, items } = lastNearbyResults;
  const bounds = [];
  if (me) {
    L.marker([me.lat, me.lon], {
      icon: L.divIcon({ className: '', iconSize: [16, 16],
        html: '<div class="nearby-pin me"></div>' }),
    }).bindPopup('You are here').addTo(nearbyMapLayers);
    bounds.push([me.lat, me.lon]);
  }
  for (const { sid, s } of (items || [])) {
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', iconSize: [14, 14],
        html: '<div class="nearby-pin"></div>' }),
    }).bindPopup(
      `<strong>${esc(s.name)}</strong><br>Stop #${esc(s.code)}` +
      ((s.r && s.r.length) ? `<br>Routes: ${esc(s.r.join(', '))}` : '')
    ).addTo(nearbyMapLayers);
    bounds.push([s.lat, s.lon]);
  }
  if (bounds.length) nearbyMap.fitBounds(bounds, { padding: [20, 20] });
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
/* Every OC Transpo route is available, so the picker is search-driven: with
   no query it lists only the lines already chosen; type a route number or a
   destination to find more. */
function renderLinePicker() {
  const host = document.getElementById('line-picker');
  const searchEl = document.getElementById('line-search');
  const q = (searchEl ? searchEl.value : '').trim().toLowerCase();
  host.innerHTML = '';

  const selected = new Set(prefs.lines);
  let shown = [...LINES.values()];
  shown = q
    ? shown.filter(l => l.short.toLowerCase().includes(q) ||
                        (l.headsign || '').toLowerCase().includes(q))
    : shown.filter(l => selected.has(l.key));
  shown.sort((a, b) => compareLineKeys(a.key, b.key));

  const CAP = 60;
  const truncated = Math.max(0, shown.length - CAP);
  if (truncated) shown = shown.slice(0, CAP);

  if (shown.length === 0) {
    host.innerHTML = q
      ? `<div class="empty-mini">No routes match “${esc(q)}”.</div>`
      : `<div class="empty-mini">No lines selected — search a route number
         or destination above.</div>`;
    return;
  }

  for (const line of shown) {
    const lbl = document.createElement('label');
    lbl.className = 'line-opt';
    lbl.innerHTML = `
      <input type="checkbox" ${selected.has(line.key) ? 'checked' : ''}>
      <span class="route-badge" style="background:${line.color};color:${line.text}">
        ${esc(line.short)}</span>
      <span class="ln-name">→ ${esc(line.headsign)}</span>`;
    lbl.querySelector('input').onchange = async (e) => {
      if (e.target.checked) {
        if (!prefs.lines.includes(line.key)) prefs.lines.push(line.key);
        if (!prefs.compact) expandedCards.add(line.key);
        savePrefs();
        renderLinePicker();
        renderTimelines();                  // shows a "loading…" card meanwhile
        await loadRouteData(line.routeId);
        renderTimelines();
        poll();                             // pull realtime for the new route
        pollStats();
      } else {
        prefs.lines = prefs.lines.filter(k => k !== line.key);
        expandedCards.delete(line.key);
        savePrefs();
        renderLinePicker();
        renderTimelines();
      }
      if (prefs.showMap && map) drawMapStatic();
    };
    host.appendChild(lbl);
  }

  if (truncated) {
    const more = document.createElement('div');
    more.className = 'empty-mini';
    more.textContent = `+${truncated} more — keep typing to narrow down.`;
    host.appendChild(more);
  }
}

/* ── Favourite stops ────────────────────────────────────────────────────── */
function renderFavStops() {
  renderStopGroups();
  const host = document.getElementById('fav-stops');
  host.innerHTML = '';
  const stops = activeGroup().stopIds;
  if (stops.length === 0) {
    host.innerHTML = `<div class="empty-mini">No stops in “${esc(activeGroup().name)}”
      yet — tap ★ on any stop in an expanded timeline, or use
      “Find stops near me”.</div>`;
    return;
  }
  for (const sid of stops) {
    const s = GTFS.stops[sid];
    if (!s) continue;
    const live = favStopIsLive(sid);
    const row = document.createElement('div');
    row.className = 'fav-stop-row';
    row.innerHTML = `
      <span class="fav-live ${live ? 'on' : ''}"
            title="${live ? 'Live feed flowing for this stop'
                          : 'Waiting for live data (route may not be selected)'}"></span>
      <span class="stop-code">#${esc(s.code)}</span>
      <span class="nm">${esc(s.name)}</span>
      <button class="mini-x" title="Remove from this group">✕</button>`;
    row.querySelector('.mini-x').onclick = () => toggleFav(sid);
    host.appendChild(row);
  }
}

function renderStopGroups() {
  const host = document.getElementById('stop-groups');
  if (!host) return;
  host.innerHTML = '';
  for (const g of prefs.stopGroups) {
    const chip = document.createElement('span');
    chip.className = 'group-chip' + (g.id === prefs.activeGroupId ? ' active' : '');
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.innerHTML = `
      <span class="grp-name">${esc(g.name)}</span>
      <span class="grp-count">${g.stopIds.length}</span>
      <span class="grp-edit" title="Rename or delete this group">✎</span>`;
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('grp-edit')) { editGroup(g.id); return; }
      setActiveGroup(g.id);
    });
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); setActiveGroup(g.id);
      }
    });
    host.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'group-add';
  add.textContent = '+ New group';
  add.onclick = addGroup;
  host.appendChild(add);
}

/* A saved stop is "live" iff at least one approaching trip has fresh data —
   i.e. its route is selected, ETAs are flowing, and the vehicle (if any) was
   heard from recently. */
function favStopIsLive(sid) {
  if (!lastData) return false;
  const now = serverNow();
  for (const run of runs) {
    const t = run.etas.get(sid);
    if (t == null || t < now - 30) continue;
    if (!run.feedTs || (now - run.feedTs) < STALE_VEHICLE) return true;
  }
  return false;
}

function toggleFav(sid) {
  const g = activeGroup();
  const i = g.stopIds.indexOf(sid);
  if (i >= 0) g.stopIds.splice(i, 1);
  else g.stopIds.push(sid);
  syncActiveStops();
  savePrefs();
  renderFavStops();
  renderDeparturesBoard();
  renderTimelines();
}

/* ── Nearby stops (geolocation) ─────────────────────────────────────────── */
function findNearby() {
  const list = document.getElementById('nearby-list');
  const controls = document.getElementById('nearby-controls');
  if (!navigator.geolocation) { toast('Geolocation not available.'); return; }
  list.innerHTML = '<div class="empty-mini">Locating…</div>';
  if (controls) controls.classList.remove('hidden');

  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    const ranked = Object.entries(GTFS.stops)
      .map(([sid, s]) => ({ sid, s, d: haversine(latitude, longitude, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);
    lastNearbyResults = { me: { lat: latitude, lon: longitude }, items: ranked };

    list.innerHTML = '';
    for (const { sid, s, d } of ranked) {
      const rts = (s.r || []).join(', ');
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
    if (prefs.nearbyOnMap) enableNearbyMap();
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
function fmtDelay(sec) {
  if (sec == null) return '—';
  if (sec > -60 && sec < 60) return 'on time';
  const m = Math.round(sec / 60);
  return (m > 0 ? '+' : '') + m + ' min';
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
