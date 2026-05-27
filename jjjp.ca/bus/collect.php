<?php
/**
 * collect.php — OC Transpo reliability collector for bus.jjjp.ca
 * Compatible with PHP 7.2+. Requires bus_lib.php beside it.
 *
 * Run on a schedule by Synology Task Scheduler (a "user-defined script"):
 *
 *     php /volume1/web/jjjp.ca/bus/collect.php
 *
 * Recommended interval: every 1 minute (set CACHE_TTL in bus_lib.php a little
 * above your interval). Each run makes exactly two OC Transpo requests, so a
 * 1-minute schedule is ~2 calls/min — and because it refreshes the shared
 * cache, the live proxy makes no upstream calls of its own. The collector is
 * the single API client no matter how many people use the app.
 *
 * What it does each run:
 *   1. Fetches TripUpdates + VehiclePositions (refreshing the proxy's cache).
 *   2. For every tracked trip/stop, upserts the latest predicted arrival into
 *      the samples table. Once a bus passes a stop, that stop stops updating,
 *      so the final stored value approximates the actual arrival time.
 *   3. Records a heartbeat and prunes old rows.
 *
 * It never throws to the caller — a failed run is logged as ok=0 so the cron
 * job stays quiet.
 */

require_once __DIR__ . '/bus_lib.php';

$now    = time();
$ok     = 0;
$nTrips = 0;
$nVeh   = 0;
$feedTs = null;
$note   = '';

try {
    // Force-fetch both feeds (maxAge 0) — this also refreshes the cache the
    // live proxy serves from, so api.php needn't call OC Transpo itself.
    $tu = bus_fetch_feed(TU_PATH, 0);
    $vp = bus_fetch_feed(VP_PATH, 0);

    $db    = bus_open_db();
    $track = TRACK_ROUTES;
    $tz    = new DateTimeZone('America/Toronto');
    $today = (new DateTime('now', $tz))->format('Ymd');

    if (is_array($vp['data'])) $nVeh = count($vp['data']['Entity'] ?? []);
    if (is_array($tu['data'])) $feedTs = $tu['data']['Header']['Timestamp'] ?? null;

    if (is_array($tu['data'])) {
        $ins = $db->prepare(
            'INSERT OR IGNORE INTO samples
               (sdate, trip, stop, seq, route, pred, first_at, last_at)
             VALUES (:d, :t, :s, :q, :r, :p, :n, :n)');
        $upd = $db->prepare(
            'UPDATE samples SET pred = :p, seq = :q, last_at = :n
             WHERE sdate = :d AND trip = :t AND stop = :s');

        $db->exec('BEGIN');
        foreach ($tu['data']['Entity'] ?? [] as $e) {
            $t = $e['TripUpdate'] ?? null;
            if (!$t) continue;
            $trip  = $t['Trip'] ?? [];
            $tid   = $trip['TripId'] ?? null;
            $route = $trip['RouteId'] ?? null;
            if (!$tid || !$route) continue;
            if (!empty($track) && !in_array($route, $track, true)) continue;
            $sdate = $trip['StartDate'] ?? $today;
            $nTrips++;

            foreach ($t['StopTimeUpdate'] ?? [] as $s) {
                $stop = $s['StopId'] ?? null;
                if (!$stop) continue;
                $pred = ($s['Arrival']['HasTime'] ?? false)   ? $s['Arrival']['Time']
                      : (($s['Departure']['HasTime'] ?? false) ? $s['Departure']['Time'] : null);
                if (!$pred) continue;
                $seq = $s['StopSequence'] ?? null;

                foreach ([$ins, $upd] as $st) {
                    $st->bindValue(':d', $sdate, SQLITE3_TEXT);
                    $st->bindValue(':t', $tid,   SQLITE3_TEXT);
                    $st->bindValue(':s', $stop,  SQLITE3_TEXT);
                    $st->bindValue(':q', $seq,   SQLITE3_INTEGER);
                    $st->bindValue(':p', $pred,  SQLITE3_INTEGER);
                    $st->bindValue(':n', $now,   SQLITE3_INTEGER);
                }
                $ins->bindValue(':r', $route, SQLITE3_TEXT);
                $ins->execute(); $ins->reset();
                $upd->execute(); $upd->reset();
            }
        }
        $db->exec('COMMIT');
        $ok = 1;
    } else {
        $note = 'TripUpdates feed unavailable';
    }

    // Heartbeat.
    $hb = $db->prepare(
        'INSERT OR REPLACE INTO collector_runs (ran_at, feed_ts, n_trips, n_veh, ok)
         VALUES (:a, :f, :t, :v, :o)');
    $hb->bindValue(':a', $now,    SQLITE3_INTEGER);
    $hb->bindValue(':f', $feedTs, SQLITE3_INTEGER);
    $hb->bindValue(':t', $nTrips, SQLITE3_INTEGER);
    $hb->bindValue(':v', $nVeh,   SQLITE3_INTEGER);
    $hb->bindValue(':o', $ok,     SQLITE3_INTEGER);
    $hb->execute();

    // Prune old data (cheap; uses the route index for the date prefix).
    $cutoff = (new DateTime('-' . SAMPLE_RETENTION_DAYS . ' days', $tz))->format('Ymd');
    $db->exec("DELETE FROM samples WHERE sdate < '" . SQLite3::escapeString($cutoff) . "'");
    $db->exec('DELETE FROM collector_runs WHERE ran_at < ' . ($now - 7 * 86400));

    $db->close();
} catch (Exception $e) {
    $note = 'error: ' . $e->getMessage();
    // Best-effort failure heartbeat.
    try {
        $db = bus_open_db();
        $db->exec("INSERT OR REPLACE INTO collector_runs (ran_at, feed_ts, n_trips, n_veh, ok)
                   VALUES ($now, NULL, 0, 0, 0)");
        $db->close();
    } catch (Exception $e2) { /* give up quietly */ }
}

echo date('c', $now) . "  ok=$ok  trips=$nTrips  vehicles=$nVeh"
   . ($note ? "  $note" : '') . "\n";
