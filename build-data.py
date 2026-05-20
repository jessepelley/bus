#!/usr/bin/env python3
"""
build-data.py — Generate the bundled GTFS schedule for bus.jjjp.ca

OC Transpo updates its GTFS schedule roughly monthly. The realtime feeds
(vehicle positions, trip updates) only tell you where buses are and when
they'll arrive at *upcoming* stops — they do NOT give the full start-to-end
list of stops for a line. That comes from the static schedule.

This script reads the static GTFS export and writes a small JSON file
(data/gtfs-bus.json) containing, for the routes you care about:
  - route metadata (name, colour)
  - distinct stop patterns (ordered stop lists) per direction
  - a stop dictionary (code, name, lat/lon)
  - shape polylines (for the map)
  - a trip_id -> pattern map (so a live trip can be placed on the timeline)

Usage:
    python3 build-data.py                 # downloads the GTFS zip fresh
    python3 build-data.py /path/to/dir    # uses an already-extracted folder
    python3 build-data.py /path/to/GTFSExport.zip

Re-run it whenever OC Transpo publishes a new schedule (the feed_info
end date tells you when the current one expires), then commit the
updated data/gtfs-bus.json.
"""

import csv
import io
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from datetime import date

# ── Configuration ────────────────────────────────────────────────────────────
# Routes to include, by route_short_name. Add more here to extend the app.
ROUTES = ["45", "5"]

GTFS_URL = "https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip"

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "gtfs-bus.json")

# Allow very large CSV fields (stop_times.txt is ~230 MB).
csv.field_size_limit(10 * 1024 * 1024)


def log(msg):
    print(msg, file=sys.stderr)


def resolve_gtfs_dir(arg):
    """Return a directory containing the extracted GTFS .txt files."""
    if arg and os.path.isdir(arg):
        log(f"Using extracted GTFS folder: {arg}")
        return arg, None

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
    return tmp, tmp


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    gtfs_dir, _ = resolve_gtfs_dir(arg)

    def p(name):
        return os.path.join(gtfs_dir, name)

    # ── routes.txt ───────────────────────────────────────────────────────────
    routes = {}          # route_id -> meta
    want_route_ids = set()
    for r in read_csv(p("routes.txt")):
        if r["route_short_name"] in ROUTES:
            rid = r["route_id"]
            want_route_ids.add(rid)
            routes[rid] = {
                "short": r["route_short_name"],
                "long": r["route_long_name"],
                "color": r.get("route_color") or "0057B8",
                "text": r.get("route_text_color") or "FFFFFF",
                "patterns": [],
            }
    log(f"Routes matched: {sorted(want_route_ids)}")

    # ── trips.txt ────────────────────────────────────────────────────────────
    trips = {}           # trip_id -> {route, dir, headsign, shape}
    want_shapes = set()
    for t in read_csv(p("trips.txt")):
        if t["route_id"] in want_route_ids:
            trips[t["trip_id"]] = {
                "route": t["route_id"],
                "dir": int(t.get("direction_id") or 0),
                "headsign": t.get("trip_headsign", "").strip(),
                "shape": t.get("shape_id", "").strip(),
            }
            if t.get("shape_id"):
                want_shapes.add(t["shape_id"])
    log(f"Trips for these routes: {len(trips)}")

    # ── stop_times.txt — the big one; stream it ──────────────────────────────
    trip_stops = {}      # trip_id -> list of (seq, stop_id)
    used_stop_ids = set()
    for st in read_csv(p("stop_times.txt")):
        tid = st["trip_id"]
        if tid not in trips:
            continue
        trip_stops.setdefault(tid, []).append(
            (int(st["stop_sequence"]), st["stop_id"])
        )
        used_stop_ids.add(st["stop_id"])
    for tid in trip_stops:
        trip_stops[tid].sort()
    log(f"Stop-time rows collected for {len(trip_stops)} trips")

    # ── Build distinct patterns per route ────────────────────────────────────
    # A pattern = a distinct ordered sequence of stop_ids. Trips that share the
    # same stop sequence share a pattern. We pick a representative headsign and
    # shape from the first trip seen, and id them route-dir-index.
    patterns = {}        # signature -> pattern dict
    trip_patterns = {}   # trip_id -> pattern id
    per_route_dir_count = {}

    for tid, stops in trip_stops.items():
        meta = trips[tid]
        stop_ids = [s for _, s in stops]
        sig = (meta["route"], meta["dir"], tuple(stop_ids))
        if sig not in patterns:
            key = (meta["route"], meta["dir"])
            idx = per_route_dir_count.get(key, 0)
            per_route_dir_count[key] = idx + 1
            pid = f'{meta["route"]}-{meta["dir"]}-{idx}'
            patterns[sig] = {
                "id": pid,
                "route": meta["route"],
                "dir": meta["dir"],
                "headsign": meta["headsign"],
                "shape": meta["shape"],
                "stops": stop_ids,
                "trip_count": 0,
            }
        patterns[sig]["trip_count"] += 1
        trip_patterns[tid] = patterns[sig]["id"]

    # Attach patterns to routes, longest (most stops) first per direction.
    for pat in patterns.values():
        routes[pat["route"]]["patterns"].append(pat)
    for r in routes.values():
        r["patterns"].sort(key=lambda x: (x["dir"], -len(x["stops"])))
    log(f"Distinct patterns: {len(patterns)}")
    for rid, r in routes.items():
        for pat in r["patterns"]:
            log(f'  route {r["short"]:>3}  {pat["id"]:<10} '
                f'dir{pat["dir"]} {len(pat["stops"]):>3} stops  '
                f'{pat["trip_count"]:>4} trips  -> {pat["headsign"]}')

    # ── stops.txt — only the stops we use ────────────────────────────────────
    stops = {}
    for s in read_csv(p("stops.txt")):
        if s["stop_id"] in used_stop_ids:
            stops[s["stop_id"]] = {
                "code": s.get("stop_code", "").strip(),
                "name": s["stop_name"].strip(),
                "lat": round(float(s["stop_lat"]), 6),
                "lon": round(float(s["stop_lon"]), 6),
            }
    log(f"Stops: {len(stops)}")

    # ── shapes.txt — polylines for the map; stream it ────────────────────────
    shapes = {sid: [] for sid in want_shapes}
    for row in read_csv(p("shapes.txt")):
        sid = row["shape_id"]
        if sid in shapes:
            shapes[sid].append(
                (int(row["shape_pt_sequence"]),
                 round(float(row["shape_pt_lat"]), 6),
                 round(float(row["shape_pt_lon"]), 6))
            )
    for sid in shapes:
        shapes[sid].sort()
        shapes[sid] = [[lat, lon] for _, lat, lon in shapes[sid]]
    log(f"Shapes: {len(shapes)}")

    # ── Write output ─────────────────────────────────────────────────────────
    out = {
        "generated": date.today().isoformat(),
        "source": GTFS_URL,
        "routes": routes,
        "stops": stops,
        "shapes": shapes,
        "trip_patterns": trip_patterns,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) // 1024
    log(f"\nWrote {OUT_PATH}  ({size_kb} KB)")


if __name__ == "__main__":
    main()
