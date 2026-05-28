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
const TABS = ['now', 'routes', 'map', 'more'];
// Ghost-trail prediction: don't extrapolate further than this past the last GPS.
const GHOST_MAX_AGE = 240;                  // s — beyond this the bus is "lost"
const GHOST_TRAIL_LEN = 8;                  // recent predicted positions to keep
const RAIL_TICK_MS = 200;                   // smooth-animation cadence

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
let railTimer   = null;
let statsTimer  = null;
let statsByRoute = {};                      // routeId -> reliability stats
let map = null, mapLayers = null, tileLayer = null;
let nearbyMap = null, nearbyMapLayers = null, nearbyTiles = null;
let lastNearbyResults = null;               // { me:{lat,lon}, items:[{sid,s,d}] }
const expandedCards = new Set();            // line keys shown as full timelines
let activeTab = 'now';                      // current main pane
// Ghost-trail state: shapeIndex memoises cumulative-distance tables per shape
// id; vehicleHistory keeps a small ring of recent {lat,lon,t} per vehicle id
// so we can render a fading trail without persisting it server-side.
const shapeIndex    = new Map();            // shapeId -> { pts, cum, total }
const vehicleHistory = new Map();           // vehId -> [{lat, lon, t, predicted}]

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
  tab:      'now',
  ghost:    true,                           // calculus-based predicted-position overlay
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
  if (prefs.showMap) { document.getElementById('map-toggle').checked = true; }
  activateTab(TABS.includes(prefs.tab) ? prefs.tab : 'now');

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
   `pattern` (stop list + shape) is null until the route's file is loaded.
   For two-direction routes we also synthesise a `<route>:loop` entry so the
   user can opt into a merged view (e.g. Route 45, which is physically a loop
   even though GTFS models it as two directions). */
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
    if ((route.dirs || []).length === 2) {
      const lk = rid + ':loop';
      LINES.set(lk, {
        key: lk, routeId: rid, dir: 'loop', isLoop: true,
        short: route.short, long: route.long,
        color: '#' + route.color, text: '#' + route.text,
        headsign: route.dirs[0].headsign + ' ↔ ' + route.dirs[1].headsign,
        pattern: null,
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
   longest one per direction) once a route's detail file has arrived. Also
   builds the merged-loop pattern when both directions are present. */
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

  // Loop pattern: stitch dir 0 + dir 1 into one path. The bridge stop (last of
  // dir 0 == first of dir 1) is deduped so it appears once on the merged
  // timeline. The shape concatenates, so polyline projection traverses both
  // legs without a discontinuity for vehicles transitioning between trips.
  const loopKey = rid + ':loop';
  const loopLine = LINES.get(loopKey);
  if (loopLine && byDir[0] && byDir[1]) {
    const a = byDir[0], b = byDir[1];
    const aStops = a.stops, bStops = b.stops;
    const stops = aStops.concat(
      bStops[0] === aStops[aStops.length - 1] ? bStops.slice(1) : bStops);
    const shapeA = GTFS.shapes[a.shape] || [];
    const shapeB = GTFS.shapes[b.shape] || [];
    const shapeId = '__loop_' + rid;
    GTFS.shapes[shapeId] = shapeA.concat(shapeB);
    shapeIndex.delete(shapeId);              // invalidate any stale cum table

    loopLine.pattern = {
      id: '__loop_pat_' + rid,
      route: rid,
      dir: 'loop',
      headsign: loopLine.headsign,
      shape: shapeId,
      stops,
      trip_count: (a.trip_count || 0) + (b.trip_count || 0),
      isLoop: true,
      bridgeIdx: aStops.length - 1,           // where dir-0 ends / dir-1 begins
    };
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
  const ghToggle = document.getElementById('ghost-toggle');
  if (ghToggle) ghToggle.checked = prefs.ghost !== false;
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

  const ghToggle = document.getElementById('ghost-toggle');
  if (ghToggle) ghToggle.onchange = (e) => {
    prefs.ghost = e.target.checked; savePrefs();
    renderAll();
  };

  document.getElementById('map-toggle').onchange = (e) => {
    prefs.showMap = e.target.checked; savePrefs();
    if (prefs.showMap) activateTab('map');
  };

  document.getElementById('refresh-select').onchange = (e) => {
    prefs.refresh = +e.target.value; savePrefs(); startTimers();
  };

  document.getElementById('nearby-btn').onclick = findNearby;

  // Bottom tab bar — primary nav on mobile, also works on desktop.
  document.querySelectorAll('#tabbar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Freshness pill → diagnostics modal.
  document.getElementById('freshness').addEventListener('click', openDiag);
  document.getElementById('diag-close').addEventListener('click', closeDiag);
  document.getElementById('diag-refresh').addEventListener('click', refreshDiag);
  document.getElementById('diag-modal').addEventListener('click', (e) => {
    if (e.target.id === 'diag-modal') closeDiag();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDiag();
  });

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
  // Crossing the mobile breakpoint: re-park the sidebar back into the layout
  // (it might be hosted in the "More" tab from a previous mobile session).
  const sidebar = document.getElementById('sidebar');
  const moreHost = document.getElementById('more-host');
  if (window.innerWidth > 760) {
    if (sidebar.parentElement === moreHost) {
      document.getElementById('layout').insertBefore(
        sidebar, document.getElementById('content'));
      // The "more" pane is mobile-only — fall back to "now" on the bigger screen.
      if (activeTab === 'more') activateTab('now');
    }
    setSidebar(true);
  }
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */
function activateTab(tab) {
  if (!TABS.includes(tab)) tab = 'now';
  activeTab = tab;
  prefs.tab = tab;
  document.body.dataset.tab = tab;
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.hidden = p.dataset.tab !== tab;
  });
  document.querySelectorAll('#tabbar .tab-btn').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  // "More" tab is mobile-only — move the sidebar in/out of it as needed.
  // On desktop the sidebar stays where it is in #layout.
  const mobile = window.innerWidth <= 760;
  const sidebar = document.getElementById('sidebar');
  const moreHost = document.getElementById('more-host');
  if (mobile && tab === 'more') {
    if (sidebar.parentElement !== moreHost) moreHost.appendChild(sidebar);
  } else if (sidebar.parentElement === moreHost) {
    document.getElementById('layout').insertBefore(
      sidebar, document.getElementById('content'));
  }

  if (tab === 'map') enableMap();
  savePrefs();
  renderAll();
}

/* ── Diagnostics modal ─────────────────────────────────────────────────── */
let lastDiag = null;
function openDiag() {
  document.getElementById('diag-modal').classList.remove('hidden');
  refreshDiag();
}
function closeDiag() {
  document.getElementById('diag-modal').classList.add('hidden');
}
async function refreshDiag() {
  const body = document.getElementById('diag-body');
  body.innerHTML = '<div class="empty-mini">Loading…</div>';
  try {
    const headers = {};
    if (auth.isAuthenticated()) headers['X-API-Key'] = auth.getToken();
    const res = await fetch(`${API_URL}?action=diag`, { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    lastDiag = await res.json();
  } catch (e) {
    body.innerHTML = `<div class="diag-bad">Could not reach the proxy:
      ${esc(e.message)}.</div>`;
    return;
  }
  body.innerHTML = renderDiag(lastDiag);
}

function renderDiag(d) {
  if (!d || !d.ok) return `<div class="diag-bad">Proxy returned an error.</div>`;
  const ago = (t) => t ? fmtAgo((Date.now() / 1000) - t) : '—';
  const verdict = diagnose(d);

  const cacheRow = (name, c) => c.present
    ? `<tr><th>${name} cache</th><td>${fmtAgo(c.age)} old · ${fmtBytes(c.bytes)}</td></tr>`
    : `<tr><th>${name} cache</th><td class="bad">missing</td></tr>`;

  const feedNow = lastData && lastData.feeds ? lastData.feeds : null;
  const feedRow = (name, f) => !f ? '' :
    `<tr><th>${name} this poll</th><td>
      <code>${esc(f.source)}</code>
      ${f.err ? ` · <span class="bad">${esc(f.err)}</span>` : ''}
      ${f.http ? ' · HTTP ' + f.http : ''}
      ${f.ms ? ' · ' + f.ms + ' ms' : ''}
      ${f.age != null && f.age >= 0 ? ' · ' + fmtAgo(f.age) + ' old' : ''}
    </td></tr>`;

  const errors = (d.recent_errors || []).slice(0, 5).map(e =>
    `<li><code>${esc(e.path.split('/').slice(-2).join('/'))}</code>
      · HTTP ${e.http_code || '—'} · ${esc(e.err || 'unknown')}
      · ${ago(e.at)}</li>`).join('');

  const sum = (d.fetch_summary || []).map(p =>
    `<li><code>${esc(p.path.split('/').slice(-2).join('/'))}</code>:
      <span class="ok">${p.ok || 0} ok</span>
      ${p.fail > 0 ? ` · <span class="bad">${p.fail} fail</span>` : ''}
      · last ok ${ago(p.last_ok_at)}</li>`).join('');

  const series = (d.visitors && d.visitors.series) || [];
  const sparkline = series.length ? `<div class="diag-spark">${
    series.map(s => `<span class="spark-bar" style="height:${
      Math.min(100, (s.v || 0) * 18)}%"
      title="${esc(s.day)}: ${s.v} visitors · ${s.h || 0} hits"></span>`).join('')
    }</div>` : '';

  return `
    <div class="diag-verdict ${verdict.cls}">
      <strong>${esc(verdict.title)}</strong>
      <div>${esc(verdict.body)}</div>
    </div>

    <h4>This poll</h4>
    <table class="diag-table">
      ${feedRow('Vehicles', feedNow && feedNow.vp)}
      ${feedRow('Trips',    feedNow && feedNow.tu)}
      <tr><th>Server clock</th><td>${esc(new Date(d.time * 1000).toLocaleString())}</td></tr>
      <tr><th>Cache TTL</th><td>${d.cache_ttl}s · upstream timeout ${d.timeout}s</td></tr>
    </table>

    <h4>Proxy state</h4>
    <table class="diag-table">
      ${cacheRow('Vehicles', d.cache.vp)}
      ${cacheRow('Trips',    d.cache.tu)}
      ${d.samples ? `<tr><th>Samples today</th><td>${d.samples.today.toLocaleString()}
        of ${d.samples.total.toLocaleString()} · last write ${ago(d.samples.last_at)}</td></tr>` : ''}
      ${d.heartbeat ? `<tr><th>Heartbeat</th><td>${
        d.heartbeat.last_at ? 'last ' + ago(d.heartbeat.last_at) : '—'
      } · ${d.heartbeat.minutes_24h} minutes active in 24h</td></tr>` : ''}
    </table>

    ${sum ? `<h4>Last hour</h4><ul class="diag-list">${sum}</ul>` : ''}
    ${errors ? `<h4>Recent errors</h4><ul class="diag-list">${errors}</ul>` : ''}

    ${d.visitors ? `
      <h4>Visitors</h4>
      <table class="diag-table">
        <tr><th>Today</th><td>${d.visitors.today} unique · ${d.visitors.hits_today} hits</td></tr>
        <tr><th>Last 7 days</th><td>${d.visitors.week} unique</td></tr>
      </table>
      ${sparkline}
      <p class="diag-note">Anonymous: only a salted daily hash of the IP is stored.</p>
    ` : ''}

    <p class="diag-note">Schedule built ${esc(GTFS.generated || '—')}.
       Reliability data is gathered while the app is in use — not 24/7.</p>
  `;
}

/* Decide a one-line "is data flowing?" verdict from a diag payload. */
function diagnose(d) {
  const feeds = lastData && lastData.feeds;
  if (feeds) {
    if (feeds.vp.source === 'missing' || feeds.tu.source === 'missing')
      return { cls: 'bad', title: 'Upstream feed missing',
        body: 'OC Transpo did not return a usable feed and the proxy has no cache to fall back to.' };
    if (feeds.vp.source === 'stale_fallback' || feeds.tu.source === 'stale_fallback')
      return { cls: 'bad',
        title: 'Upstream failing — serving stale cache',
        body: 'The last upstream attempt failed (' +
          (feeds.vp.err || feeds.tu.err || 'unknown') +
          '). The proxy is serving the last cached payload.' };
  }
  const recent = d.recent_fetches || [];
  const failsInLastHour = (d.fetch_summary || []).reduce((n, p) => n + (p.fail || 0), 0);
  const oksInLastHour = (d.fetch_summary || []).reduce((n, p) => n + (p.ok || 0), 0);
  if (failsInLastHour > 0 && failsInLastHour >= oksInLastHour)
    return { cls: 'warn',
      title: 'Upstream unstable',
      body: failsInLastHour + ' failed upstream fetch'
        + (failsInLastHour === 1 ? '' : 'es')
        + ' vs ' + oksInLastHour + ' ok in the last hour.' };
  if (!lastData)
    return { cls: 'warn', title: 'No realtime data yet',
      body: 'The app hasn\'t completed its first poll. If this persists, the proxy may be unreachable.' };

  const feedTs = Math.min(lastData.vp_ts || Infinity, lastData.tu_ts || Infinity);
  const age = isFinite(feedTs) ? (serverNow() - feedTs) : null;
  if (age != null && age > 180)
    return { cls: 'warn', title: 'Feed timestamps are old',
      body: 'OC Transpo\'s own header timestamp is ' + fmtAgo(age) +
            '. The proxy is fetching, but the upstream feed itself is stale.' };
  return { cls: 'ok', title: 'Data is flowing',
    body: 'Upstream feeds reachable and recent. Proxy cache fresh.' };
}

/* ── Ghost-trail prediction — calculus along the route polyline ─────────── */
/* For each route shape we precompute a cumulative-distance table; projecting
   a GPS point onto the shape gives us a scalar offset s along the line. The
   bus then advances by `speed * dt`. This is essentially numerical integration
   of the bus's velocity along its known path. */
function getShapeIndex(shapeId) {
  if (!shapeId) return null;
  let idx = shapeIndex.get(shapeId);
  if (idx) return idx;
  const pts = GTFS.shapes[shapeId];
  if (!pts || pts.length < 2) return null;
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversine(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
    cum.push(total);
  }
  idx = { pts, cum, total };
  shapeIndex.set(shapeId, idx);
  return idx;
}

/* Project (lat,lon) onto the polyline, returning the cumulative-distance
   offset of the closest point. O(n) but n is small (≤ ~1000) and the result
   is cached per render. */
function projectOnShape(idx, lat, lon) {
  let best = 0, bestD = Infinity;
  const pts = idx.pts, cum = idx.cum;
  for (let i = 0; i < pts.length - 1; i++) {
    const [aLat, aLon] = pts[i], [bLat, bLon] = pts[i + 1];
    // Equirectangular approximation — good enough at city scale.
    const ax = aLon, ay = aLat;
    const bx = bLon, by = bLat;
    const px = lon,  py = lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = haversine(py, px, qy, qx);
    if (d < bestD) {
      bestD = d;
      const segLen = cum[i + 1] - cum[i];
      best = cum[i] + t * segLen;
    }
  }
  return { offset: best, deviation: bestD };
}

/* Walk forward along the polyline from offset `s` by `meters`, returning the
   interpolated lat/lon. Clamps to the end. */
function offsetToLatLon(idx, s) {
  const cum = idx.cum, pts = idx.pts;
  s = Math.max(0, Math.min(idx.total, s));
  // Binary search for the segment.
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0 ? (s - cum[lo]) / segLen : 0;
  return [
    pts[lo][0] + t * (pts[hi][0] - pts[lo][0]),
    pts[lo][1] + t * (pts[hi][1] - pts[lo][1]),
  ];
}

/* The headline calculation. Given a vehicle (with its run / line resolved),
   compute where it should be *now* based on its last GPS plus elapsed time. */
function predictVehiclePosition(run) {
  const v = run && run.vehicle;
  if (!v || v.lat == null || v.lon == null) return null;
  const now = serverNow();
  const ts = v.ts || run.feedTs || now;
  const dt = Math.max(0, now - ts);
  // Always carry the GPS through, even if no shape — the map needs it.
  const out = { lat: v.lat, lon: v.lon, dt, gpsAge: dt, predicted: false,
                lastFix: { lat: v.lat, lon: v.lon, ts } };
  if (dt < 3) return out;                          // too fresh to bother
  if (dt > GHOST_MAX_AGE) { out.lost = true; return out; }

  // 1) Shape-based prediction (preferred).
  if (run.line && run.line.pattern && run.line.pattern.shape) {
    const idx = getShapeIndex(run.line.pattern.shape);
    if (idx) {
      const proj = projectOnShape(idx, v.lat, v.lon);
      // If the GPS is wildly off the shape, fall back to dead reckoning.
      if (proj.deviation < 250) {
        const speed = (v.speed != null && v.speed > 0)
          ? v.speed
          : estimateSpeedFromHistory(run.vehId, v) || 8;   // 8 m/s ~ 29 km/h
        const advanced = proj.offset + speed * dt;
        const [lat, lon] = offsetToLatLon(idx, advanced);
        out.lat = lat; out.lon = lon;
        out.predicted = true;
        out.method = 'shape';
        out.predOffset = advanced;
        out.shapeId = run.line.pattern.shape;
        return out;
      }
    }
  }

  // 2) Dead reckoning by bearing + speed.
  if (v.bearing != null && v.speed != null && v.speed > 0) {
    const R = 6371000;
    const br = v.bearing * Math.PI / 180;
    const d = v.speed * dt / R;
    const φ1 = v.lat * Math.PI / 180;
    const λ1 = v.lon * Math.PI / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) +
                         Math.cos(φ1) * Math.sin(d) * Math.cos(br));
    const λ2 = λ1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(φ1),
                               Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
    out.lat = φ2 * 180 / Math.PI;
    out.lon = λ2 * 180 / Math.PI;
    out.predicted = true;
    out.method = 'bearing';
  }
  return out;
}

/* Compute speed from the last two recorded positions when the feed omits it
   (some vehicles only report position). Returns m/s or null. */
function estimateSpeedFromHistory(vehId, v) {
  const hist = vehicleHistory.get(vehId);
  if (!hist || hist.length < 2) return null;
  const a = hist[hist.length - 2], b = hist[hist.length - 1];
  const dt = b.t - a.t;
  if (dt < 5 || dt > 300) return null;
  const d = haversine(a.lat, a.lon, b.lat, b.lon);
  return d / dt;
}

/* Maintain a small ring buffer of recent positions per vehicle id so we can
   render a fading trail. Called once per poll with the *actual* GPS fix. */
function recordVehicleHistory() {
  if (!lastData) return;
  for (const v of lastData.vehicles || []) {
    if (!v || v.lat == null || !v.id) continue;
    let hist = vehicleHistory.get(v.id);
    if (!hist) { hist = []; vehicleHistory.set(v.id, hist); }
    const last = hist[hist.length - 1];
    const ts = v.ts || (lastData.fetched);
    if (last && last.t === ts) continue;                    // unchanged
    if (last && haversine(last.lat, last.lon, v.lat, v.lon) < 8 &&
        ts - last.t < 60) continue;                         // barely moved
    hist.push({ lat: v.lat, lon: v.lon, t: ts, gps: true });
    while (hist.length > GHOST_TRAIL_LEN) hist.shift();
  }
  // Drop entries for vehicles we haven't seen in a long time.
  const seen = new Set((lastData.vehicles || []).map(v => v.id));
  const now = serverNow();
  for (const [id, hist] of vehicleHistory) {
    const last = hist[hist.length - 1];
    if (!seen.has(id) && last && now - last.t > 600) vehicleHistory.delete(id);
  }
}

function startTimers() {
  clearInterval(pollTimer);
  clearInterval(renderTimer);
  clearInterval(railTimer);
  if (prefs.refresh > 0) pollTimer = setInterval(poll, prefs.refresh * 1000);
  renderTimer = setInterval(renderAll, 15000);   // keep countdowns ticking
  // Smooth ghost-trail animation: re-tick the prediction at RAIL_TICK_MS so the
  // bus marker visibly moves between GPS updates instead of jumping. Only runs
  // when the user has ghosts on and the page is visible (saves battery).
  railTimer = setInterval(tickGhostFrame, RAIL_TICK_MS);
}

/* Cheap inter-poll tick: just re-run the visible bus positions. Skips the
   heavy work (departures board, timeline rebuild, stats) — only nudges the
   rail bus markers and map ghosts forward along the route polyline. */
function tickGhostFrame() {
  if (document.hidden || prefs.ghost === false) return;
  if (!lastData) return;
  if (activeTab === 'routes') updateRailBusPositions();
  if (activeTab === 'map' && map && mapLayers) renderMap();
  if (activeTab === 'now')    updateNowGhosts();
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
    recordVehicleHistory();
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

/* All runs that should appear on a given line. For loop lines this returns
   runs from BOTH underlying directions, so the merged timeline shows every
   bus on the route — whether currently inbound or outbound. */
function runsForLine(lineKey) {
  const line = LINES.get(lineKey);
  if (!line) return [];
  if (line.isLoop) {
    const a = line.routeId + ':0', b = line.routeId + ':1';
    return runs.filter(r => r.lineKey === a || r.lineKey === b);
  }
  return runs.filter(r => r.lineKey === lineKey);
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
  renderFavStops();                          // refresh live-feed dots per poll
  if (activeTab === 'now')    renderNow();
  if (activeTab === 'routes') { renderDeparturesBoard(); renderTimelines(); }
  if (activeTab === 'map' && map) renderMap();
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

/* ── "Now" view ─────────────────────────────────────────────────────────── */
/* The redesigned primary view, mobile-first. Surfaces what someone using this
   for a real "do I need to leave?" check actually needs:
     1. A status banner if the feed is unhealthy (links into diagnostics).
     2. Big, glanceable arrival cards for the active stop group.
     3. A predicted-position chain per saved-stop-on-line, with a ghost dot
        for where the bus *should be right now* between GPS updates.
     4. One-line route reliability strips. */
function renderNow() {
  renderNowAlert();
  renderNowBoard();
  renderNowStatus();
  renderNowRoutes();
  renderNowLegend();
}

/* Tiny collapsible legend explaining the colour / live semantics. Rendered
   only once — its content is static, so we just check whether it exists. */
function renderNowLegend() {
  let host = document.getElementById('now-legend');
  if (!host) {
    host = document.createElement('details');
    host.id = 'now-legend';
    host.className = 'now-legend';
    document.querySelector('.tab-pane[data-tab="now"]').appendChild(host);
  }
  host.innerHTML = `
    <summary>What do the colours and icon mean?</summary>
    <div class="legend-rows">
      <div><span class="legend-eta now">due</span>
           the bus is within 45 seconds</div>
      <div><span class="legend-eta soon">soon</span>
           1–6 minutes away — start moving</div>
      <div><span class="legend-eta later">later</span>
           more than 6 minutes away</div>
      <div><span class="legend-icon">${liveIcon()}</span>
           live — a vehicle is reporting GPS for this trip and the
           ETA is GPS-informed</div>
      <div><span class="legend-icon legend-icon-blank"></span>
           no icon — the ETA is based on the schedule because no bus is yet
           assigned to the trip (or its GPS went stale)</div>
    </div>`;
}

function renderNowAlert() {
  const el = document.getElementById('now-alert');
  if (!lastData) { el.classList.add('hidden'); return; }
  const feedTs = Math.min(lastData.vp_ts || Infinity, lastData.tu_ts || Infinity);
  const age = isFinite(feedTs) ? serverNow() - feedTs : null;
  const feeds = lastData.feeds || {};
  let title = null, body = null, kind = 'warn';

  if ((feeds.vp && feeds.vp.source === 'missing') ||
      (feeds.tu && feeds.tu.source === 'missing')) {
    kind = 'bad';
    title = 'Upstream feed unavailable.';
    body = 'OC Transpo did not return a usable feed and the proxy has no cache to fall back to.';
  } else if ((feeds.vp && feeds.vp.source === 'stale_fallback') ||
             (feeds.tu && feeds.tu.source === 'stale_fallback')) {
    kind = 'bad';
    title = 'Upstream is failing — showing cached data.';
    body = 'Last error: ' + ((feeds.vp && feeds.vp.err) ||
                             (feeds.tu && feeds.tu.err) || 'unknown') + '.';
  } else if (age != null && age > 180) {
    kind = 'warn';
    title = 'OC Transpo\'s feed itself is stale.';
    body = 'The proxy is fetching cleanly, but the upstream header timestamp is '
         + fmtAgo(age) + '.';
  }

  if (!title) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = 'now-alert ' + kind;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div>
      <strong>${esc(title)}</strong>
      <div class="now-alert-body">${esc(body || '')}</div>
    </div>
    <button class="link-btn" id="now-alert-diag">Show details</button>`;
  document.getElementById('now-alert-diag').onclick = openDiag;
}

function renderNowBoard() {
  const host = document.getElementById('now-board');
  host.innerHTML = '';
  const now = serverNow();
  const stops = activeGroup().stopIds;

  if (stops.length === 0) {
    host.innerHTML = `
      <div class="now-empty">
        <p>No saved stops in <strong>${esc(activeGroup().name)}</strong> yet.</p>
        <p class="hint">Open <strong>Routes</strong>, expand a timeline, and tap ★
          on a stop. Or use <strong>Find stops near me</strong> in the menu.</p>
      </div>`;
    return;
  }

  for (const sid of stops) {
    const stop = GTFS.stops[sid];
    if (!stop) continue;

    const arrivals = [];
    for (const run of runs) {
      const t = run.etas.get(sid);
      if (t && t > now - 30) arrivals.push({ run, t, mins: (t - now) / 60 });
    }
    arrivals.sort((a, b) => a.t - b.t);

    const card = document.createElement('article');
    card.className = 'now-card';
    if (arrivals.length && arrivals[0].mins <= 6) card.classList.add('urgent');

    const head = `
      <header class="now-card-head">
        <div class="now-stop">
          <span class="now-stop-name">${esc(stop.name)}</span>
          <span class="stop-code-tag">#${esc(stop.code)}</span>
        </div>
        <button class="link-btn now-card-remove" title="Remove from this group">✕</button>
      </header>`;

    let body;
    if (arrivals.length === 0) {
      body = `<div class="now-none">No live arrivals approaching.</div>`;
    } else {
      const first = arrivals[0];
      const remaining = arrivals.slice(1, 4);
      body = `
        <div class="now-primary">
          ${badge(first.run)}
          <span class="now-headsign">${esc(first.run.headsign)}</span>
          ${nowEta(first.t, now, isRunLive(first.run, now))}
        </div>
        ${ghostStripFor(first.run, sid, now)}
        ${remaining.length ? `<div class="now-next">${
          remaining.map(a => `<div class="now-next-row">
            ${badge(a.run)}
            <span class="now-headsign">${esc(a.run.headsign)}</span>
            ${nowEta(a.t, now, isRunLive(a.run, now))}
          </div>`).join('')
        }</div>` : ''}`;
    }

    card.innerHTML = head + body;
    card.querySelector('.now-card-remove').onclick = () => toggleFav(sid);
    host.appendChild(card);
  }
}

/* A horizontal predicted-position strip for the next bus reaching a saved
   stop: the route polyline projected to a thin horizontal bar, with the bus's
   predicted position marked as a moving ghost dot between stations. Re-renders
   every poll; the dot itself is then nudged each tickGhostFrame. */
function ghostStripFor(run, savedSid, now) {
  if (prefs.ghost === false) return '';
  if (!run.line || !run.line.pattern) return '';
  const stops = run.line.pattern.stops;
  const savedIdx = stops.indexOf(savedSid);
  if (savedIdx < 0) return '';
  const pred = predictVehiclePosition(run);
  if (!pred) return '';
  const idx = run.line.pattern.shape && getShapeIndex(run.line.pattern.shape);
  if (!idx) return '';

  // Find the polyline offset for each stop just for the visible window
  // [savedIdx-3 .. savedIdx]. That keeps the strip readable.
  const lo = Math.max(0, savedIdx - 4);
  const hi = savedIdx;
  const stopOffsets = [];
  for (let i = lo; i <= hi; i++) {
    const s = GTFS.stops[stops[i]];
    if (!s) continue;
    const o = projectOnShape(idx, s.lat, s.lon).offset;
    stopOffsets.push({ idx: i, offset: o, name: s.name });
  }
  stopOffsets.sort((a, b) => a.offset - b.offset);
  if (stopOffsets.length < 2) return '';

  const o0 = stopOffsets[0].offset;
  const o1 = stopOffsets[stopOffsets.length - 1].offset;
  if (o1 <= o0) return '';

  // Bus offset (predicted now and last GPS fix).
  const busOffset = pred.predOffset != null ? pred.predOffset
    : projectOnShape(idx, pred.lat, pred.lon).offset;
  const fixOffset = pred.lastFix
    ? projectOnShape(idx, pred.lastFix.lat, pred.lastFix.lon).offset
    : busOffset;
  const pct = (o) => Math.max(0, Math.min(100, 100 * (o - o0) / (o1 - o0)));

  const stopMarkers = stopOffsets.map(s => `
    <span class="gs-stop ${s.idx === savedIdx ? 'saved' : ''}"
          style="left:${pct(s.offset).toFixed(1)}%"
          title="${esc(s.name)}"></span>`).join('');

  const fadeMs = pred.gpsAge > 60 ? 'pred-old' : '';
  const trail = (vehicleHistory.get(run.vehId) || [])
    .slice(-GHOST_TRAIL_LEN)
    .map(p => {
      const o = projectOnShape(idx, p.lat, p.lon).offset;
      return `<span class="gs-trail" style="left:${pct(o).toFixed(1)}%"></span>`;
    }).join('');

  return `
    <div class="ghost-strip" data-vid="${esc(run.vehId)}"
         data-shape="${esc(run.line.pattern.shape)}"
         data-o0="${o0}" data-o1="${o1}">
      <div class="gs-rail"></div>
      ${trail}
      ${stopMarkers}
      <span class="gs-fix" style="left:${pct(fixOffset).toFixed(1)}%"
            title="Last GPS fix · ${fmtAgo(pred.gpsAge)} ago"></span>
      <span class="gs-ghost ${fadeMs}" style="left:${pct(busOffset).toFixed(1)}%"
            title="Predicted position now (${pred.method || 'gps'})">
        <span class="gs-ghost-dot"></span>
      </span>
      ${pred.lost ? '<span class="gs-lost">tracking lost</span>' : ''}
    </div>`;
}

function nowEta(t, now, live) {
  const sec = t - now;
  const cls = sec < 45 ? 'now' : (sec < 6 * 60 ? 'soon' : 'later');
  return `<span class="now-eta ${cls}${live ? ' is-live' : ''}"
                 title="${live ? 'GPS-confirmed in the last 2½ min'
                              : 'Schedule-based prediction — no live GPS for this trip'}">
    <span class="eta-line">
      ${live ? liveIcon() : ''}
      <span class="now-eta-big">${fmtEta(sec)}</span>
    </span>
    <small>${fmtClock(t)}</small></span>`;
}

/* Is this run currently being tracked by GPS? A vehicle is "live" iff the
   trip update has a vehicle attached AND the position was reported within
   the staleness window. Schedule-only predictions (no vehicle yet) are
   distinguished visually so the user knows not to fully trust the ETA. */
function isRunLive(run, now) {
  if (!run.vehicle) return false;
  const ts = run.vehicle.ts || run.feedTs;
  if (!ts) return false;
  return (now - ts) < STALE_VEHICLE;
}

/* Compact RSS-style broadcast icon — a dot with two arcs that pulse outward,
   colour-inherited from .now-eta.is-live (green by default).  */
function liveIcon() {
  return `<svg class="live-rss" viewBox="0 0 16 16" aria-label="GPS-confirmed"
               role="img">
    <circle cx="3.5" cy="12.5" r="1.5" class="rss-base"/>
    <path d="M3 9 A 5 5 0 0 1 7 13" fill="none" stroke-width="1.6"
          stroke-linecap="round" class="rss-near"/>
    <path d="M3 5 A 9 9 0 0 1 11 13" fill="none" stroke-width="1.6"
          stroke-linecap="round" class="rss-far"/>
  </svg>`;
}

function renderNowStatus() {
  const el = document.getElementById('now-status');
  if (!lastData) { el.innerHTML = ''; return; }
  const feedTs = Math.min(lastData.vp_ts || Infinity, lastData.tu_ts || Infinity);
  const age = isFinite(feedTs) ? serverNow() - feedTs : null;
  const vp = lastData.feeds && lastData.feeds.vp;
  const tu = lastData.feeds && lastData.feeds.tu;
  const totBuses = (lastData.vehicles || []).length;
  el.innerHTML = `
    <div class="now-status-row">
      <span>${totBuses} bus${totBuses === 1 ? '' : 'es'} tracking</span>
      <span>·</span>
      <span>${age != null ? 'feed ' + fmtAgo(age) : 'feed —'}</span>
      ${vp ? `<span>·</span><span>VP <code>${esc(vp.source)}</code></span>` : ''}
      ${tu ? `<span>·</span><span>TU <code>${esc(tu.source)}</code></span>` : ''}
      <button class="link-btn" id="now-diag-link">details</button>
    </div>`;
  document.getElementById('now-diag-link').onclick = openDiag;
}

function renderNowRoutes() {
  const host = document.getElementById('now-routes');
  host.innerHTML = '';
  if (prefs.lines.length === 0) {
    host.innerHTML = `<div class="empty-mini">No routes selected — open the
      menu and pick at least one line.</div>`;
    return;
  }
  for (const key of prefs.lines) {
    const line = LINES.get(key);
    if (!line) continue;
    const lineRuns = runsForLine(key);
    const stats = statsByRoute[line.routeId];
    const today = stats && stats.available && stats.by_day && stats.by_day[0];
    const otp = today && today.measured > 0 ? today.on_time_pct : null;

    const row = document.createElement('div');
    row.className = 'now-route';
    row.innerHTML = `
      ${badge({ short: line.short, color: line.color })}
      <div class="now-route-title">${line.isLoop ? '↔' : '→'}
        ${esc(line.headsign)}</div>
      <div class="now-route-meta">
        ${lineRuns.length} bus${lineRuns.length === 1 ? '' : 'es'}
        ${otp != null ? ` · ${otp}% on time` : ''}
      </div>`;
    row.onclick = () => { activateTab('routes'); };
    host.appendChild(row);
  }
}

/* Update only the ghost-dot positions inside ghost-strips, without rebuilding
   the DOM. Called from tickGhostFrame at ~5Hz. */
function updateNowGhosts() {
  if (prefs.ghost === false) return;
  const strips = document.querySelectorAll('#now-board .ghost-strip');
  strips.forEach(strip => {
    const vid = strip.dataset.vid;
    const run = runs.find(r => r.vehId === vid);
    if (!run) return;
    const pred = predictVehiclePosition(run);
    if (!pred) return;
    const shapeId = strip.dataset.shape;
    const idx = shapeIndex.get(shapeId);
    if (!idx) return;
    const o0 = +strip.dataset.o0, o1 = +strip.dataset.o1;
    if (o1 <= o0) return;
    const o = pred.predOffset != null ? pred.predOffset
      : projectOnShape(idx, pred.lat, pred.lon).offset;
    const pct = Math.max(0, Math.min(100, 100 * (o - o0) / (o1 - o0)));
    const ghost = strip.querySelector('.gs-ghost');
    if (ghost) ghost.style.left = pct.toFixed(1) + '%';
  });
}

/* Same idea for the timeline rail: nudge the .bus-marker top offset between
   stops without re-rendering the whole timeline card. */
function updateRailBusPositions() {
  if (prefs.ghost === false) return;
  const H = rowH();
  document.querySelectorAll('.timeline-body[data-line]').forEach(body => {
    const lineKey = body.dataset.line;
    const line = LINES.get(lineKey);
    if (!line || !line.pattern) return;
    const stops = line.pattern.stops;
    const lineRuns = runsForLine(lineKey);
    const now = serverNow();
    lineRuns.forEach(run => {
      const marker = body.querySelector('.bus-marker[data-vid="' +
        cssEscape(run.vehId) + '"]');
      if (!marker) return;
      const pos = computeRailPosition(run, stops, now, line);
      if (pos == null) return;
      marker.style.top = (pos * H + H / 2) + 'px';
    });
  });
}

/* Where in `stops` does this run's next stop sit? For loop timelines we may
   have to search the second half (dir 1) explicitly — otherwise indexOf would
   return a dir-0 occurrence if both halves share a stop id. */
function stopIndexForRun(run, stops, line) {
  if (!run.nextStopId) return -1;
  if (line && line.isLoop && line.pattern && line.pattern.bridgeIdx != null &&
      run.line && run.line.dir === 1) {
    const i = stops.indexOf(run.nextStopId, line.pattern.bridgeIdx);
    if (i >= 0) return i;
  }
  return stops.indexOf(run.nextStopId);
}

/* Where on the rail (in fractional stop-row units) should this run draw? */
function computeRailPosition(run, stops, now, line) {
  let nextIdx = stopIndexForRun(run, stops, line);
  if (nextIdx < 0 && run.vehicle && run.vehicle.lat != null)
    nextIdx = nearestStopIndex(stops, run.vehicle.lat, run.vehicle.lon);
  if (nextIdx < 0) return null;
  const prevIdx = Math.max(0, nextIdx - 1);

  // If we have a shape + GPS, use the polyline projection (smooth across the
  // segment). Otherwise fall back to the haversine ratio.
  if (prefs.ghost !== false && run.line && run.line.pattern &&
      run.line.pattern.shape && run.vehicle && run.vehicle.lat != null) {
    const idx = getShapeIndex(run.line.pattern.shape);
    const a = GTFS.stops[stops[prevIdx]], b = GTFS.stops[stops[nextIdx]];
    if (idx && a && b) {
      const pred = predictVehiclePosition(run);
      const offset = pred && pred.predOffset != null ? pred.predOffset
        : projectOnShape(idx, run.vehicle.lat, run.vehicle.lon).offset;
      const oA = projectOnShape(idx, a.lat, a.lon).offset;
      const oB = projectOnShape(idx, b.lat, b.lon).offset;
      if (oB > oA) {
        const t = Math.max(0, Math.min(1, (offset - oA) / (oB - oA)));
        return prevIdx + t;
      }
    }
  }
  let frac = 0.55;
  if (run.vehicle && run.vehicle.lat != null && nextIdx > 0) {
    const a = GTFS.stops[stops[prevIdx]], b = GTFS.stops[stops[nextIdx]];
    if (a && b) {
      const dA = haversine(a.lat, a.lon, run.vehicle.lat, run.vehicle.lon);
      const dB = haversine(b.lat, b.lon, run.vehicle.lat, run.vehicle.lon);
      if (dA + dB > 0) frac = Math.min(0.95, Math.max(0.05, dA / (dA + dB)));
    }
  }
  return prevIdx + frac;
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, c =>
    '\\' + c.charCodeAt(0).toString(16) + ' ');
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

  const lineRuns = runsForLine(line.key);
  const expanded = expandedCards.has(line.key);

  const card = document.createElement('div');
  card.className = 'timeline-card' + (expanded ? ' expanded' : '');

  const head = document.createElement('div');
  head.className = 'timeline-head';
  const titlePrefix = line.isLoop ? '↔' : '→';
  head.innerHTML = `
    <span class="tl-chevron">▶</span>
    <span class="route-badge" style="background:${line.color};color:${line.text}">
      ${esc(line.short)}</span>
    <span class="tl-title">${titlePrefix} ${esc(line.headsign)}</span>
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
    busIdx = stopIndexForRun(bestRun, stops, line);
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
    ${buildMiniChain(busIdx, savedIdx, stops)}`;
  return strip;
}

/* The compact mini-chain visualises a slice of the route between the bus and
   the saved stop. We want it to show as MANY intermediate stops as will fit
   on a line — so the user can see "is the bus past Hurdman yet?" at a glance.
   Only when the gap exceeds available width do we collapse the middle with a
   ··· cluster, keeping the stops nearest the bus and nearest the saved stop
   both visible (since those are the contextual anchors). */
function buildMiniChain(busIdx, savedIdx, stops) {
  if (busIdx < 0) {
    return '<div class="mini-chain"><span class="chain-dot saved"></span></div>';
  }

  // How many dots will fit horizontally? Each dot reserves ~28px; the strip
  // sits inside a card whose inner width depends on viewport. This is a
  // viewport-based estimate — measuring DOM here would force layout.
  const maxSlots = miniChainSlotCount();

  const lo = Math.min(busIdx, savedIdx);
  const hi = Math.max(busIdx, savedIdx);
  const span = hi - lo + 1;

  const dot = (idx) => {
    const name = stops ? (GTFS.stops[stops[idx]] || {}).name : '';
    const cls = ['chain-dot'];
    if (idx === busIdx)   cls.push('bus-here');
    if (idx === savedIdx) cls.push('saved');
    const title = name ? ` title="${esc(name)}"` : '';
    return `<span class="${cls.join(' ')}"${title}></span>`;
  };

  let html = '<div class="mini-chain">';

  if (span <= maxSlots) {
    // Whole slice fits — show every stop between bus and saved.
    for (let i = lo; i <= hi; i++) html += dot(i);
  } else {
    // Need to condense. The cluster takes one slot; allocate the rest as
    // ⌈half⌉ near the bus and ⌊half⌋ near the saved stop. The bus is what
    // the user is tracking moment-to-moment, so it gets the extra slot.
    const headCount = Math.ceil((maxSlots - 1) / 2);
    const tailCount = (maxSlots - 1) - headCount;
    const hidden = span - headCount - tailCount;

    for (let i = 0; i < headCount; i++) html += dot(lo + i);
    html += `<span class="chain-skip" title="${hidden} stops hidden">` +
            '<span class="skip-dot"></span><span class="skip-dot"></span>' +
            '<span class="skip-dot"></span></span>';
    for (let i = tailCount - 1; i >= 0; i--) html += dot(hi - i);
  }

  html += '</div>';
  return html;
}

/* How many dot-slots fit in a mini-chain at the current viewport size?
   Tuned against the card's inner width (sidebar takes 312px on desktop). */
function miniChainSlotCount() {
  const w = window.innerWidth;
  // Card inner width ≈ viewport - sidebar(312 if desktop) - paddings(~32)
  const inner = w > 760 ? Math.max(280, w - 360) : Math.max(220, w - 80);
  // Each slot needs ~26-30px (dot + margins). Keep within a sensible range.
  return Math.max(6, Math.min(22, Math.floor(inner / 28)));
}

function buildBusStrip(run, line, now) {
  const stops = line.pattern.stops;
  let nextIdx = stopIndexForRun(run, stops, line);
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
  body.dataset.line = line.key;
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
    const marker = buildBusMarker(run, stops, now, H, line);
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

function buildBusMarker(run, stops, now, H, line) {
  const pos = computeRailPosition(run, stops, now, line);
  if (pos == null) return null;
  const top = Math.max(0, pos) * H + H / 2;
  const eta = run.nextStopId ? run.etas.get(run.nextStopId) : null;
  const old = run.feedTs && (now - run.feedTs > STALE_VEHICLE);

  const m = document.createElement('div');
  m.className = 'bus-marker' + (old ? ' faded' : '');
  m.dataset.vid = run.vehId;
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

/* ── Map (Leaflet) ──────────────────────────────────────────────────────── */
async function enableMap() {
  if (!map) {
    await loadLeaflet();
    map = L.map('map', { zoomControl: true }).setView([45.402, -75.642], 13);
    tileLayer = L.tileLayer(TILES[prefs.theme] || TILES.light, {
      maxZoom: 20, subdomains: 'abcd',
      attribution: '© OpenStreetMap, © CARTO',
    }).addTo(map);
    mapLayers = { shapes: L.layerGroup().addTo(map),
                  stops:  L.layerGroup().addTo(map),
                  trails: L.layerGroup().addTo(map),
                  buses:  L.layerGroup().addTo(map),
                  ghosts: L.layerGroup().addTo(map) };
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
  mapLayers.trails.clearLayers();
  mapLayers.ghosts.clearLayers();
  const now = serverNow();
  for (const run of runs) {
    const v = run.vehicle;
    if (!v || v.lat == null) continue;
    const pred = predictVehiclePosition(run);
    const eta = run.nextStopId ? run.etas.get(run.nextStopId) : null;
    const next = run.nextStopId && GTFS.stops[run.nextStopId]
      ? GTFS.stops[run.nextStopId].name : '—';

    // 1) Fading trail of recent GPS fixes (latest is most opaque).
    const hist = vehicleHistory.get(run.vehId) || [];
    if (hist.length >= 2) {
      for (let i = 1; i < hist.length; i++) {
        const a = hist[i - 1], b = hist[i];
        L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
          color: run.color, weight: 3,
          opacity: 0.18 + 0.7 * (i / hist.length),
          dashArray: i < hist.length - 1 ? '4,4' : null,
        }).addTo(mapLayers.trails);
      }
    }

    // 2) GPS-fix pin (always at the *last reported* position, not predicted).
    const fixIcon = L.divIcon({
      className: '', iconSize: [22, 22],
      html: `<div class="bus-pin fix" style="background:${run.color}">
               ${esc(run.short)}</div>`,
    });
    L.marker([v.lat, v.lon], { icon: fixIcon })
      .bindPopup(`<strong>Route ${esc(run.short)}</strong> → ${esc(run.headsign)}<br>
        Bus #${esc(v.id)}<br>
        GPS ${fmtAgo(now - (v.ts || now))} ago<br>
        Next: ${esc(next)}${eta ? ' · ' + fmtEta(eta - now) : ''}`)
      .addTo(mapLayers.buses);

    // 3) Predicted-now ghost (calculus along route polyline). Only when we
    //    actually advanced — skip when prediction == GPS.
    if (prefs.ghost !== false && pred && pred.predicted && !pred.lost) {
      const ghostIcon = L.divIcon({
        className: '', iconSize: [26, 26],
        html: `<div class="bus-pin ghost" style="border-color:${run.color}">
                 <span>${esc(run.short)}</span></div>`,
      });
      L.marker([pred.lat, pred.lon], { icon: ghostIcon, interactive: false })
        .addTo(mapLayers.ghosts);
      // Thin line from last GPS to predicted-now position.
      L.polyline([[v.lat, v.lon], [pred.lat, pred.lon]], {
        color: run.color, weight: 2, opacity: 0.6, dashArray: '2,4',
        interactive: false,
      }).addTo(mapLayers.ghosts);
    }
    if (pred && pred.lost) {
      // Faint X-ish marker so a "lost" bus is visible at all.
      const lostIcon = L.divIcon({
        className: '', iconSize: [22, 22],
        html: `<div class="bus-pin lost">${esc(run.short)}</div>`,
      });
      L.marker([v.lat, v.lon], { icon: lostIcon, interactive: false })
        .addTo(mapLayers.ghosts);
    }
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
    lbl.className = 'line-opt' + (line.isLoop ? ' line-opt-loop' : '');
    const prefix = line.isLoop ? '↔' : '→';
    lbl.innerHTML = `
      <input type="checkbox" ${selected.has(line.key) ? 'checked' : ''}>
      <span class="route-badge" style="background:${line.color};color:${line.text}">
        ${esc(line.short)}</span>
      <span class="ln-name">${prefix} ${esc(line.headsign)}</span>
      ${line.isLoop ? '<span class="ln-tag">loop view</span>' : ''}`;
    lbl.querySelector('input').onchange = async (e) => {
      if (e.target.checked) {
        if (!prefs.lines.includes(line.key)) prefs.lines.push(line.key);
        if (!prefs.compact) expandedCards.add(line.key);
        // Mutual exclusion between "<route>:loop" and the two directions —
        // having both on screen would render the same route twice.
        if (line.isLoop) {
          prefs.lines = prefs.lines.filter(k =>
            k !== line.routeId + ':0' && k !== line.routeId + ':1');
        } else {
          prefs.lines = prefs.lines.filter(k => k !== line.routeId + ':loop');
        }
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
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
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
