#!/usr/bin/env python3
"""
build-data.py — Generate the bundled data for bus.jjjp.ca

The app supports **every OC Transpo route**, so the schedule data is split
into small per-route files that the app and the NAS load on demand — rather
than one giant bundle that every visitor would have to download.

Produces, from the OC Transpo static GTFS export:

  data/index.json       — bundled with the static site. Every route's name,
                           colour and per-direction headsign. Small; loaded
                           once at app launch to populate the route picker.
  data/stops.json       — bundled. Every stop (id -> code/name/lat/lon).
                           Shared by all routes; powers "find stops near me".
  data/routes/<id>.json — bundled, one per route. Stop lists, shapes and the
                           trip->pattern map for that route's timeline. The
                           app fetches a route file only when that route is
                           actually shown.

  schedule-meta.json    — a NAS-side file (NOT served by the static site; it
                           is .gitignored). GTFS calendar — service days and
                           exceptions — shared by every route.
  schedule/<id>.json    — NAS-side, one per route. Scheduled arrival time of
                           every trip/stop. api.php reads the meta file plus
                           the one route file a stats request asks for, so the
                           reliability endpoint never decodes a huge blob.

OC Transpo republishes the schedule roughly monthly. Re-run this script when
the feed's end date passes, then commit data/ and copy schedule-meta.json and
the schedule/ folder to jjjp.ca/bus/ on the NAS.

Usage:
    python3 build-data.py                 # downloads the GTFS zip fresh
    python3 build-data.py /path/to/dir    # uses an already-extracted folder
    python3 build-data.py /path/to/GTFSExport.zip

To limit the build to a few routes (faster; smaller), set ROUTES below to a
list of route short names. Empty list = every route.
"""

import csv
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from datetime import date

# ── Configuration ────────────────────────────────────────────────────────────
ROUTES = []                                # route short names; [] = every route

GTFS_URL = "https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip"

HERE          = os.path.dirname(os.path.abspath(__file__))
DATA_DIR      = os.path.join(HERE, "data")
ROUTES_DIR    = os.path.join(DATA_DIR, "routes")
INDEX_OUT     = os.path.join(DATA_DIR, "index.json")
STOPS_OUT     = os.path.join(DATA_DIR, "stops.json")
SCHED_META    = os.path.join(HERE, "schedule-meta.json")
SCHED_DIR     = os.path.join(HERE, "schedule")

csv.field_size_limit(10 * 1024 * 1024)     # stop_times.txt is ~230 MB


def log(msg):
    print(msg, file=sys.stderr)


def slug(route_id):
    """Filename-safe form of a route id (used for data/routes/ and schedule/).
       app.js and api.php sanitise the route the same way — keep them in sync.
       Dots are excluded so a route id can never form a '..' path segment."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", route_id)


def gtfs_secs(t):
    """GTFS 'HH:MM:SS' (hours may exceed 24) -> seconds after midnight, or None."""
    t = (t or "").strip()
    if not t:
        return None
    try:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except ValueError:
        return None


def resolve_gtfs_dir(arg):
    if arg and os.path.isdir(arg):
        log(f"Using extracted GTFS folder: {arg}")
        return arg

    tmp = tempfile.mkdtemp(prefix="gtfs-")
    if arg and os.path.isfile(arg):
        zip_path = arg
        log(f"Using local zip: {zip_path}")
    else:
        zip_path = os.path.join(tmp, "GTFSExport.zip")
        log(f"Downloading GTFS export from {GTFS_URL} ...")
        urllib.request.urlretrieve(GTFS_URL, zip_path)
        log(f"Downloaded {os.path.getsize(zip_path) // (1024 * 1024)} MB")
    log("Extracting ...")
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp)
    return tmp


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    gtfs_dir = resolve_gtfs_dir(arg)

    def p(name):
        return os.path.join(gtfs_dir, name)

    # ── routes.txt ───────────────────────────────────────────────────────────
    # The GTFS-Realtime feed identifies a route by its SHORT NAME ("5"), not
    # its GTFS route_id ("1-350"). The short name is therefore the canonical
    # id used everywhere — in the bundle, on the NAS and in the realtime feed.
    routes = {}                            # route_short_name -> route dict
    rid_to_short = {}                      # GTFS route_id -> short name
    for r in read_csv(p("routes.txt")):
        short = (r.get("route_short_name") or "").strip()
        if not short:
            continue                       # un-numbered route — not in the RT feed
        if ROUTES and short not in ROUTES:
            continue
        rid_to_short[r["route_id"]] = short
        routes[short] = {
            "short": short,
            "long": r["route_long_name"],
            "color": r.get("route_color") or "0057B8",
            "text": r.get("route_text_color") or "FFFFFF",
            "patterns": [],
        }
    log(f"Routes matched: {len(routes)}")

    # Guard against two route names collapsing to the same on-disk filename.
    seen_slugs = {}
    for short in routes:
        s = slug(short)
        if s in seen_slugs:
            log(f"WARNING: routes {seen_slugs[s]!r} and {short!r} both map to "
                f"file slug {s!r} — one will overwrite the other.")
        seen_slugs[s] = short

    # ── trips.txt ────────────────────────────────────────────────────────────
    trips = {}
    for t in read_csv(p("trips.txt")):
        short = rid_to_short.get(t["route_id"])
        if short:
            trips[t["trip_id"]] = {
                "route": short,
                "service": t.get("service_id", "").strip(),
                "dir": int(t.get("direction_id") or 0),
                "headsign": t.get("trip_headsign", "").strip(),
                "shape": t.get("shape_id", "").strip(),
            }
    log(f"Trips for these routes: {len(trips)}")

    # ── stop_times.txt — the big one; stream it ──────────────────────────────
    # trip_id -> sorted list of (seq, stop_id, scheduled_secs)
    trip_stops = {}
    used_stop_ids = set()
    for st in read_csv(p("stop_times.txt")):
        tid = st["trip_id"]
        if tid not in trips:
            continue
        trip_stops.setdefault(tid, []).append(
            (int(st["stop_sequence"]), st["stop_id"], gtfs_secs(st.get("arrival_time")))
        )
        used_stop_ids.add(st["stop_id"])
    for tid in trip_stops:
        trip_stops[tid].sort()
    log(f"Stop-time rows collected for {len(trip_stops)} trips")

    # ── Build distinct patterns per route ────────────────────────────────────
    patterns = {}                          # signature -> pattern dict
    trip_patterns = {}                     # trip_id  -> pattern id
    want_shapes = set()
    per_route_dir_count = {}
    for tid, stops in trip_stops.items():
        meta = trips[tid]
        stop_ids = [s for _, s, _ in stops]
        sig = (meta["route"], meta["dir"], tuple(stop_ids))
        if sig not in patterns:
            key = (meta["route"], meta["dir"])
            idx = per_route_dir_count.get(key, 0)
            per_route_dir_count[key] = idx + 1
            patterns[sig] = {
                "id": f'{meta["route"]}-{meta["dir"]}-{idx}',
                "route": meta["route"], "dir": meta["dir"],
                "headsign": meta["headsign"], "shape": meta["shape"],
                "stops": stop_ids, "trip_count": 0,
            }
        patterns[sig]["trip_count"] += 1
        trip_patterns[tid] = patterns[sig]["id"]
        if patterns[sig]["shape"]:
            want_shapes.add(patterns[sig]["shape"])

    for pat in patterns.values():
        routes[pat["route"]]["patterns"].append(pat)
    for r in routes.values():
        r["patterns"].sort(key=lambda x: (x["dir"], -len(x["stops"])))
    log(f"Distinct patterns: {len(patterns)}")

    # ── stops.txt ────────────────────────────────────────────────────────────
    # Which route short names serve each stop — so "find stops near me" can
    # label every stop even though the app only loads a few route files.
    stop_routes = {}
    for pat in patterns.values():
        short = routes[pat["route"]]["short"]
        for sid in pat["stops"]:
            stop_routes.setdefault(sid, set()).add(short)

    stops = {}
    for s in read_csv(p("stops.txt")):
        if s["stop_id"] in used_stop_ids:
            stops[s["stop_id"]] = {
                "code": s.get("stop_code", "").strip(),
                "name": s["stop_name"].strip(),
                "lat": round(float(s["stop_lat"]), 6),
                "lon": round(float(s["stop_lon"]), 6),
                "r": sorted(stop_routes.get(s["stop_id"], [])),
            }
    log(f"Stops: {len(stops)}")

    # ── shapes.txt — polylines for the map ───────────────────────────────────
    shapes = {sid: [] for sid in want_shapes}
    for row in read_csv(p("shapes.txt")):
        sid = row["shape_id"]
        if sid in shapes:
            shapes[sid].append((int(row["shape_pt_sequence"]),
                                round(float(row["shape_pt_lat"]), 6),
                                round(float(row["shape_pt_lon"]), 6)))
    for sid in shapes:
        shapes[sid].sort()
        shapes[sid] = [[lat, lon] for _, lat, lon in shapes[sid]]
    log(f"Shapes: {len(shapes)}")

    # ── calendar.txt / calendar_dates.txt — for no-show detection ────────────
    services = {}
    for c in read_csv(p("calendar.txt")):
        services[c["service_id"]] = [
            int(c["monday"]), int(c["tuesday"]), int(c["wednesday"]),
            int(c["thursday"]), int(c["friday"]), int(c["saturday"]),
            int(c["sunday"]), c["start_date"], c["end_date"],
        ]
    exceptions = {}
    if os.path.isfile(p("calendar_dates.txt")):
        for c in read_csv(p("calendar_dates.txt")):
            exceptions.setdefault(c["date"], []).append(
                [c["service_id"], int(c["exception_type"])])

    today = date.today().isoformat()

    # ── Write the static-site files ──────────────────────────────────────────
    # Recreate data/routes/ from scratch so dropped routes don't linger.
    if os.path.isdir(ROUTES_DIR):
        shutil.rmtree(ROUTES_DIR)
    os.makedirs(ROUTES_DIR, exist_ok=True)

    def dump(path, obj):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        return os.path.getsize(path)

    # index.json — every route, light metadata only.
    index_routes = {}
    for short, r in routes.items():
        dirs = {}
        for pat in r["patterns"]:          # patterns are sorted longest-first per dir
            dirs.setdefault(pat["dir"], pat["headsign"])
        index_routes[short] = {
            "short": r["short"], "long": r["long"],
            "color": r["color"], "text": r["text"],
            "file": slug(short),
            "dirs": [{"dir": d, "headsign": h} for d, h in sorted(dirs.items())],
        }
    sz = dump(INDEX_OUT, {
        "generated": today, "source": GTFS_URL, "tz": "America/Toronto",
        "routes": index_routes,
    })
    log(f"Wrote {INDEX_OUT}  ({sz // 1024} KB, {len(index_routes)} routes)")

    sz = dump(STOPS_OUT, stops)
    log(f"Wrote {STOPS_OUT}  ({sz // 1024} KB, {len(stops)} stops)")

    # data/routes/<id>.json — patterns, shapes and trip->pattern map per route.
    total = 0
    for short, r in routes.items():
        route_shapes = {pat["shape"]: shapes.get(pat["shape"], [])
                        for pat in r["patterns"] if pat["shape"]}
        route_tp = {tid: pid for tid, pid in trip_patterns.items()
                    if trips[tid]["route"] == short}
        total += dump(os.path.join(ROUTES_DIR, slug(short) + ".json"), {
            "route": short, "patterns": r["patterns"],
            "shapes": route_shapes, "trip_patterns": route_tp,
        })
    log(f"Wrote {len(routes)} files to {ROUTES_DIR}  ({total // 1024} KB total)")

    # ── Write the NAS-side schedule ──────────────────────────────────────────
    # schedule-meta.json — calendar, shared by every route.
    sz = dump(SCHED_META, {
        "generated": today, "tz": "America/Toronto",
        "services": services, "exceptions": exceptions,
    })
    log(f"Wrote {SCHED_META}  ({sz // 1024} KB)  — copy this to jjjp.ca/bus/")

    # schedule/<id>.json — trip_id -> [route, service, start_secs, stops] per route.
    if os.path.isdir(SCHED_DIR):
        shutil.rmtree(SCHED_DIR)
    os.makedirs(SCHED_DIR, exist_ok=True)
    total = 0
    for short in routes:
        sched_trips = {}
        for tid, stops_list in trip_stops.items():
            if trips[tid]["route"] != short:
                continue
            meta = trips[tid]
            seq_stops = [[s, seq, secs] for seq, s, secs in stops_list]
            start_secs = next((x[2] for x in seq_stops if x[2] is not None), 0)
            sched_trips[tid] = [short, meta["service"], start_secs, seq_stops]
        total += dump(os.path.join(SCHED_DIR, slug(short) + ".json"),
                      {"route": short, "trips": sched_trips})
    log(f"Wrote {len(routes)} files to {SCHED_DIR}  ({total // 1024} KB total)"
        f"  — copy this folder to jjjp.ca/bus/ on the NAS")


if __name__ == "__main__":
    main()
