# OC Transpo Live — bus.jjjp.ca

A static web app that shows live OC Transpo bus locations and arrival times
as a **start-to-end route timeline**. Built for a desktop browser — the
"do I need to rush for my bus?" glance at the end of a shift.

Default view: **Route 45 → Rideau** and **Route 5 → Waller (downtown)**,
both passing the Ottawa Hospital – General Campus. Any route in the bundled
schedule can be shown; preferences are saved per browser in `localStorage`.

## How it works

```
bus.jjjp.ca (GitHub Pages, static)        jjjp.ca/bus/api.php (Synology NAS)
┌──────────────────────────────┐          ┌─────────────────────────────────┐
│ index.html / app.js / css    │          │ holds the OC Transpo API key    │
│ data/gtfs-bus.json  (schedule)│  fetch   │ fetches VehiclePositions +      │
│                               │ ───────> │   TripUpdates, caches ~12 s,    │
│ timeline + arrivals + map     │ <─────── │   filters to requested routes   │
└──────────────────────────────┘   JSON   └─────────────────────────────────┘
```

The API key must **never** ship in the static site, so the NAS proxy holds
it. The realtime feeds only report *upcoming* stops, so the full start-to-end
stop list comes from the bundled GTFS schedule (`data/gtfs-bus.json`).

## Repository contents

| File                 | Purpose                                                  |
|----------------------|----------------------------------------------------------|
| `index.html`         | App shell                                                |
| `app.js`             | All app logic (timeline, departures board, map, nearby)  |
| `styles.css`         | Styling                                                  |
| `auth.js`            | Optional jjjp.ca login (not required to use the app)     |
| `data/gtfs-bus.json` | Bundled stop lists / shapes for the chosen routes        |
| `build-data.py`      | Regenerates `data/gtfs-bus.json` from the GTFS export    |
| `manifest.json` / `favicon.svg` | PWA metadata / icon                           |
| `CNAME`              | GitHub Pages custom domain (`bus.jjjp.ca`)               |

The matching NAS file `api.php` lives in this folder set at
`jjjp.ca/bus/api.php` — copy it to your NAS web root (see below).

## Deploy — static site (GitHub Pages)

1. Create a repo and push everything in this `bus.jjjp.ca/` folder to it.
2. Repo **Settings → Pages** → deploy from the default branch, root.
3. The `CNAME` file already sets the domain. Add a DNS record:
   `bus` → `CNAME` → `<your-github-user>.github.io`.
4. Wait for HTTPS to provision. Visit `https://bus.jjjp.ca`.

## Deploy — NAS proxy

1. Copy `api.php` to `jjjp.ca/bus/api.php` on the Synology (so it answers at
   `https://jjjp.ca/bus/api.php`).
2. Confirm the key near the top is your OC Transpo subscription key
   (`OCT_KEY`). It is already set.
3. Make sure the directory is writable — the script creates a `.cache`
   folder beside itself for the ~12 s feed cache.
4. Test: `https://jjjp.ca/bus/api.php?action=ping` → `{"ok":true,...}`.

CORS is locked to `https://bus.jjjp.ca` (plus `localhost:8000` for local
dev). Add origins to `$allowedOrigins` in `api.php` if needed.

## Refresh the schedule (~monthly)

OC Transpo republishes its GTFS schedule roughly monthly. **This build
expires 2026-06-08** (the feed's `feed_end_date`). To refresh:

```bash
cd bus.jjjp.ca
python3 build-data.py            # downloads the latest GTFS export
git commit -am "Refresh GTFS schedule"
git push
```

`build-data.py` needs only Python 3 (standard library). To add more routes,
edit the `ROUTES` list at the top of the script and rebuild — the app picks
up whatever routes are in `data/gtfs-bus.json`.

## Optional: require login

The app is public by design. To gate it later:

1. In `app_token.php` on the NAS: add `'bus'` to `$allowedApps` and
   `'bus.jjjp.ca'` to `$allowedHosts`.
2. In `api.php`: set `REQUIRE_AUTH` to `true`.
3. The "Sign in with jjjp.ca" button (already in the sidebar) then drives
   the passkey flow; `app.js` sends the token as `X-API-Key`.

## Local development

Serve the folder and point the app at a local proxy:

```bash
python3 -m http.server 8000          # serves the static site
php -S 127.0.0.1:8787 -t ../jjjp.ca/bus   # serves api.php
```

In the browser console before reload, or via a temporary inline script:
`window.BUS_API_URL = 'http://127.0.0.1:8787/api.php'`.

---
Data © OC Transpo / City of Ottawa (GTFS & GTFS-Realtime). Not affiliated
with OC Transpo.
