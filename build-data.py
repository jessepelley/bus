#!/usr/bin/env python3
"""
build-data.py — Generate the bundled data for bus.jjjp.ca

Produces two files from the OC Transpo static GTFS export:

  data/gtfs-bus.json   — bundled with the static site. Stop lists, shapes and
                         a trip->pattern map for the start-to-end timeline.

  schedule.json        — a NAS-side file (NOT served by the static site; it is
                         .gitignored). The reliability collector on the NAS
                         needs the *scheduled* arrival time of every trip/stop
                         to measure lateness — the realtime feed doesn't carry
                         a usable delay value. Copy this to jjjp.ca/bus/ on the
                         NAS after each rebuild.

OC Transpo republishes the schedule roughly monthly. Re-run this script when
the feed's end date passes, then commit data/gtfs-bus.json and copy the new
schedule.json to the NAS.

Usage:
    python3 build-data.py                 # downloads the GTFS zip fresh
    python3 build-data.py /path/to/dir    # uses an already-extracted folder
    python3 build-data.py /path/to/GTFSExport.zip
"""

import csv
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from datetime import date

# ── Configuration ────────────────────────────────────────────────────────────
ROUTES = ["45", "5"]                       # routes to include, by short name

GTFS_URL = "https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip"

HERE          = os.path.dirname(os.path.abspath(__file__))
GTFS_OUT      = os.path.join(HERE, "data", "gtfs-bus.json")
SCHEDULE_OUT  = os.path.join(HERE, "schedule.json")

csv.field_size_limit(10 * 1024 * 1024)     # stop_times.txt is ~230 MB


def log(msg):
    print(msg, file=sys.stderr)


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
    routes = {}
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
    trips = {}
    want_shapes = set()
    for t in read_csv(p("trips.txt")):
        if t["route_id"] in want_route_ids:
            trips[t["trip_id"]] = {
                "route": t["route_id"],
                "service": t.get("service_id", "").strip(),
                "dir": int(t.get("direction_id") or 0),
                "headsign": t.get("trip_headsign", "").strip(),
                "shape": t.get("shape_id", "").strip(),
            }
            if t.get("shape_id"):
                want_shapes.add(t["shape_id"])
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
    patterns = {}
    trip_patterns = {}
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

    for pat in patterns.values():
        routes[pat["route"]]["patterns"].append(pat)
    for r in routes.values():
        r["patterns"].sort(key=lambda x: (x["dir"], -len(x["stops"])))
    log(f"Distinct patterns: {len(patterns)}")
    for r in routes.values():
        for pat in r["patterns"]:
            log(f'  route {r["short"]:>3}  {pat["id"]:<10} dir{pat["dir"]} '
                f'{len(pat["stops"]):>3} stops {pat["trip_count"]:>4} trips '
                f'-> {pat["headsign"]}')

    # ── stops.txt ────────────────────────────────────────────────────────────
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

    # ── Write the static-site bundle ─────────────────────────────────────────
    gtfs_out = {
        "generated": date.today().isoformat(),
        "source": GTFS_URL,
        "routes": routes, "stops": stops, "shapes": shapes,
        "trip_patterns": trip_patterns,
    }
    os.makedirs(os.path.dirname(GTFS_OUT), exist_ok=True)
    with open(GTFS_OUT, "w", encoding="utf-8") as f:
        json.dump(gtfs_out, f, ensure_ascii=False, separators=(",", ":"))
    log(f"\nWrote {GTFS_OUT}  ({os.path.getsize(GTFS_OUT) // 1024} KB)")

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

    # ── Write the NAS-side schedule (scheduled arrival times) ────────────────
    # trip_id -> [route, service_id, start_secs, [[stop_id, seq, secs], ...]]
    sched_trips = {}
    for tid, stops_list in trip_stops.items():
        meta = trips[tid]
        seq_stops = [[s, seq, secs] for seq, s, secs in stops_list]
        start_secs = next((x[2] for x in seq_stops if x[2] is not None), 0)
        sched_trips[tid] = [meta["route"], meta["service"], start_secs, seq_stops]

    schedule_out = {
        "generated": date.today().isoformat(),
        "tz": "America/Toronto",
        "routes": ROUTES,
        "services": services,
        "exceptions": exceptions,
        "trips": sched_trips,
    }
    with open(SCHEDULE_OUT, "w", encoding="utf-8") as f:
        json.dump(schedule_out, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {SCHEDULE_OUT}  ({os.path.getsize(SCHEDULE_OUT) // 1024} KB)"
        f"  — copy this to jjjp.ca/bus/ on the NAS")


if __name__ == "__main__":
    main()
