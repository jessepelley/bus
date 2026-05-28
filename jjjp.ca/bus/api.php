<?php
/**
 * OC Transpo realtime proxy + reliability stats — bus.jjjp.ca NAS backend.
 * Compatible with PHP 7.2+. Requires bus_lib.php beside it.
 *
 * Endpoints:
 *   GET ?action=realtime&routes=45,5  -> combined vehicles + trip updates
 *   GET ?action=stats&route=45&days=1 -> on-time / lateness / missed-trip stats
 *   GET ?action=ping                  -> health check
 *   GET ?action=whoami                -> reserved for future login
 *
 * There is no cron job. Each realtime request fetches the OC Transpo feeds
 * (or, within CACHE_TTL, serves the shared cache so concurrent visitors share
 * one fetch) and then records reliability samples from that same payload.
 * Reliability data is gathered only while real visitors are using the app.
 */

require_once __DIR__ . '/bus_lib.php';

header('Content-Type: application/json; charset=utf-8');

set_exception_handler(function ($e) {
    if (!headers_sent()) http_response_code(500);
    echo json_encode(['ok' => false, 'error' => BUS_DEBUG ? $e->getMessage() : 'Server error']);
});

// ── CORS ─────────────────────────────────────────────────────────────────────
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $GLOBALS['BUS_ALLOWED_ORIGINS'], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: X-API-Key, Content-Type');
header('Access-Control-Max-Age: 86400');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(200); exit; }

$action = $_GET['action'] ?? 'realtime';

// ── Optional auth gate (off by default) ──────────────────────────────────────
if (REQUIRE_AUTH && $action !== 'ping') {
    $key = $_SERVER['HTTP_X_API_KEY'] ?? ($_GET['key'] ?? '');
    if (bus_validate_token($key) === null) {
        http_response_code(401);
        echo json_encode(['ok' => false, 'error' => 'Unauthorized']);
        exit;
    }
}

switch ($action) {
    case 'ping':     echo json_encode(['ok' => true, 'time' => time()]); break;
    case 'whoami':   echo json_encode(['ok' => true, 'authenticated' => false]); break;
    case 'realtime': handleRealtime(); break;
    case 'stats':    handleStats(); break;
    case 'diag':     handleDiag(); break;
    default:
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Unknown action']);
}
exit;


// ════════════════════════════════════════════════════════════════════════════
function handleRealtime()
{
    $routesParam = trim($_GET['routes'] ?? '');
    $filter = $routesParam === ''
        ? null : array_flip(array_map('trim', explode(',', $routesParam)));

    $vp = bus_fetch_feed(VP_PATH, CACHE_TTL);
    $tu = bus_fetch_feed(TU_PATH, CACHE_TTL);

    // Record this caller as a visitor (anonymous, daily-bucketed). Cheap;
    // safe to run even when filter is null.
    bus_record_visit();

    $out = [
        'ok' => true, 'fetched' => time(),
        'stale' => ($vp['stale'] || $tu['stale']),
        'vp_age' => $vp['age'], 'tu_age' => $tu['age'],
        'vp_ts' => null, 'tu_ts' => null,
        // Surface the per-feed source + any upstream error so the client's
        // diagnostics panel can explain a stale view without a second round-trip.
        'feeds' => [
            'vp' => ['source' => $vp['source'], 'age' => $vp['age'],
                     'http'   => $vp['http'],   'err' => $vp['err'],
                     'ms'     => $vp['ms']],
            'tu' => ['source' => $tu['source'], 'age' => $tu['age'],
                     'http'   => $tu['http'],   'err' => $tu['err'],
                     'ms'     => $tu['ms']],
        ],
        'vehicles' => [], 'trips' => [],
    ];

    if ($vp['data']) {
        $out['vp_ts'] = $vp['data']['Header']['Timestamp'] ?? null;
        foreach ($vp['data']['Entity'] ?? [] as $e) {
            $v = $e['Vehicle'] ?? null;
            if (!$v) continue;
            $trip = $v['Trip'] ?? null;
            $route = $trip['RouteId'] ?? null;
            if ($filter !== null && ($route === null || !isset($filter[$route]))) continue;
            $pos = $v['Position'] ?? [];
            $out['vehicles'][] = [
                'id'    => $v['Vehicle']['Id'] ?? null,
                'trip'  => $trip['TripId'] ?? null,
                'route' => $route,
                'dir'   => $trip['DirectionId'] ?? null,
                'start' => $trip['StartTime'] ?? null,
                'lat'   => $pos['Latitude'] ?? null,
                'lon'   => $pos['Longitude'] ?? null,
                'bearing' => ($pos['HasBearing'] ?? false) ? $pos['Bearing'] : null,
                'speed' => ($pos['HasSpeed'] ?? false) ? $pos['Speed'] : null,
                'occ'   => ($v['HasOccupancyStatus'] ?? false) ? $v['OccupancyStatus'] : null,
                'ts'    => $v['Timestamp'] ?? null,
            ];
        }
    }
    if ($tu['data']) {
        $out['tu_ts'] = $tu['data']['Header']['Timestamp'] ?? null;
        foreach ($tu['data']['Entity'] ?? [] as $e) {
            $t = $e['TripUpdate'] ?? null;
            if (!$t) continue;
            $trip = $t['Trip'] ?? [];
            $route = $trip['RouteId'] ?? null;
            if ($filter !== null && ($route === null || !isset($filter[$route]))) continue;
            $stops = [];
            foreach ($t['StopTimeUpdate'] ?? [] as $s) {
                $stops[] = [
                    'seq'  => $s['StopSequence'] ?? null,
                    'stop' => $s['StopId'] ?? null,
                    'arr'  => ($s['Arrival']['HasTime'] ?? false)   ? $s['Arrival']['Time']   : null,
                    'dep'  => ($s['Departure']['HasTime'] ?? false) ? $s['Departure']['Time'] : null,
                    'rel'  => $s['ScheduleRelationship'] ?? 0,
                ];
            }
            $out['trips'][] = [
                'trip' => $trip['TripId'] ?? null, 'route' => $route,
                'dir' => $trip['DirectionId'] ?? null, 'start' => $trip['StartTime'] ?? null,
                'vehicle' => $t['Vehicle']['Id'] ?? null,
                'ts' => $t['Timestamp'] ?? null, 'stu' => $stops,
            ];
        }
    }

    // Send the response first, then record reliability samples — visitors
    // never wait on the database write.
    echo json_encode($out);
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

    // Gather reliability data from this visitor's traffic. Scoped to the
    // routes the app asked for, so the DB only ever holds routes people use.
    if ($filter !== null) {
        bus_record_samples($tu['data'], $vp['data'], $filter);
    }
}

// ════════════════════════════════════════════════════════════════════════════
/**
 * Reliability stats for one route. Built from the samples recorded during
 * visitor traffic: the "actual" arrival at a stop is taken as the last
 * predicted arrival seen before the bus passed it, compared against the GTFS
 * schedule. On-time window: -1 min (early) .. +5 min (late). Cancellations are
 * INFERRED — a scheduled trip that never appeared in the feed — and only while
 * the app was actually being used around that trip's scheduled time.
 */
function handleStats()
{
    $route = trim($_GET['route'] ?? '');
    $days  = max(1, min(7, (int) ($_GET['days'] ?? 1)));
    if ($route === '') { echo json_encode(['ok' => false, 'error' => 'route required']); return; }

    // Filename-safe slug — same rule as build-data.py's slug(). Replacing (not
    // stripping) disallowed characters means the slug can never contain '/' or
    // '.', so it cannot escape SCHED_DIR. $route itself stays raw: it is only
    // ever used as a bound SQL parameter and an in-memory id match.
    $slug = preg_replace('/[^A-Za-z0-9_-]/', '_', $route);

    // Short result cache so repeated views don't re-scan the DB.
    $cacheFile = CACHE_DIR . '/stats-' . md5($route . '|' . $days) . '.json';
    if (is_file($cacheFile) && time() - filemtime($cacheFile) < 300) {
        echo file_get_contents($cacheFile);
        return;
    }

    $schedFile = SCHED_DIR . '/' . $slug . '.json';
    if (!is_file(SCHED_META_PATH) || !is_file($schedFile)) {
        echo json_encode(['ok' => true, 'available' => false,
            'reason' => 'schedule not deployed to the NAS for this route']);
        return;
    }
    if (!is_file(DB_PATH)) {
        echo json_encode(['ok' => true, 'available' => false,
            'reason' => 'no data yet — no one has used the app for this route']);
        return;
    }

    $meta       = json_decode(file_get_contents(SCHED_META_PATH), true);
    $services   = $meta['services'] ?? [];
    $exceptions = $meta['exceptions'] ?? [];
    $routeSched = json_decode(file_get_contents($schedFile), true);
    $schedTrips = $routeSched['trips'] ?? [];

    $db  = bus_open_db();
    $now = time();
    $tz  = new DateTimeZone($meta['tz'] ?? 'America/Toronto');

    $ON_EARLY = -60;     // earlier than 1 min  -> "early"
    $ON_LATE  = 300;     // later than 5 min    -> "late"

    // Trip counts (ran / missed) are only trustworthy while the app was
    // actually in use. GAP_TOL is the largest heartbeat gap we still treat as
    // "covered"; a trip is only judged if its whole window sat inside coverage.
    $GAP_TOL  = 600;
    $WIN_PRE  = 300;     // a trip is "judgeable" from 5 min before its start
    $WIN_POST = 2400;    // ...to 40 min after — enough to have sampled it

    $tot = ['measured' => 0, 'on_time' => 0, 'early' => 0, 'late' => 0,
            'delay_sum' => 0, 'scheduled' => 0, 'observed' => 0, 'missed' => 0];
    $byDay = [];
    $monitoredFrom = null;

    for ($i = 0; $i < $days; $i++) {
        $d = new DateTime('now', $tz);
        $d->modify("-$i day");
        $dateStr  = $d->format('Ymd');
        $weekday  = (int) $d->format('N') - 1;                 // 0=Mon .. 6=Sun
        $midnight = (new DateTime($dateStr . ' 000000', $tz))->getTimestamp();

        // ── App-usage coverage spans for this day ───────────────────────────
        $hbs = [];
        $hq = $db->prepare('SELECT ran_at FROM collector_runs
                            WHERE ok = 1 AND ran_at BETWEEN :a AND :b ORDER BY ran_at');
        $hq->bindValue(':a', $midnight - 700, SQLITE3_INTEGER);
        $hq->bindValue(':b', $midnight + 86400 + 700, SQLITE3_INTEGER);
        $hr = $hq->execute();
        while ($h = $hr->fetchArray(SQLITE3_NUM)) $hbs[] = (int) $h[0];
        $spans = [];
        if ($hbs) {
            $start = $prev = $hbs[0];
            foreach ($hbs as $h) {
                if ($h - $prev > $GAP_TOL) { $spans[] = [$start, $prev]; $start = $h; }
                $prev = $h;
            }
            $spans[] = [$start, $prev];
        }
        if ($i === 0 && $spans) $monitoredFrom = $spans[0][0];

        // ── Stop-level lateness from the samples table ──────────────────────
        $day = ['date' => $dateStr, 'measured' => 0, 'on_time' => 0,
                'early' => 0, 'late' => 0, 'delay_sum' => 0,
                'scheduled' => 0, 'observed' => 0, 'missed' => 0];
        $seen = [];
        $stmt = $db->prepare('SELECT trip, stop, pred FROM samples
                              WHERE sdate = :d AND route = :r');
        $stmt->bindValue(':d', $dateStr, SQLITE3_TEXT);
        $stmt->bindValue(':r', $route, SQLITE3_TEXT);
        $res = $stmt->execute();
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $seen[$row['trip']] = true;
            if ($row['pred'] === null || $row['pred'] > $now - 60) continue;  // not passed yet
            $secs = schedStopSecs($schedTrips, $row['trip'], $row['stop']);
            if ($secs === null) continue;
            $delay = $row['pred'] - ($midnight + $secs);
            if (abs($delay) > 7200) continue;                  // discard glitches
            $day['measured']++;
            $day['delay_sum'] += $delay;
            if      ($delay < $ON_EARLY) $day['early']++;
            elseif  ($delay > $ON_LATE)  $day['late']++;
            else                         $day['on_time']++;
        }

        // ── Scheduled vs observed trips (cancellations inferred) ────────────
        // Only trips whose whole window fell inside app-usage coverage are
        // judged — otherwise an absent trip just means no one was watching.
        foreach ($schedTrips as $tid => $info) {
            if ($info[0] !== $route) continue;
            if (!serviceActive($info[1], $dateStr, $weekday, $services, $exceptions)) continue;
            $startUnix = $midnight + (int) $info[2];
            $w0 = $startUnix - $WIN_PRE;
            $w1 = $startUnix + $WIN_POST;
            if ($w1 > $now) continue;                          // window not finished
            $covered = false;
            foreach ($spans as $sp) {
                if ($sp[0] <= $w0 && $sp[1] >= $w1) { $covered = true; break; }
            }
            if (!$covered) continue;                           // not judgeable
            $day['scheduled']++;
            if (isset($seen[$tid])) $day['observed']++;
            else                    $day['missed']++;
        }

        $byDay[] = dayStats($day);
        foreach ($tot as $k => $_) $tot[$k] += $day[$k];
    }

    $out = ['ok' => true, 'available' => true, 'route' => $route,
            'days' => $days, 'generated' => $now] + dayStats($tot);
    $out['monitored_from'] = $monitoredFrom;   // unix; null if not used today
    $out['by_day'] = $byDay;

    // When the app was last in use (informational — not an error if idle).
    $last = $db->querySingle('SELECT MAX(ran_at) FROM collector_runs');
    $out['monitor'] = ['last_seen' => $last ? (int) $last : null];
    $db->close();

    $json = json_encode($out);
    @file_put_contents($cacheFile, $json, LOCK_EX);
    echo $json;
}

// ════════════════════════════════════════════════════════════════════════════
/**
 * Diagnostics — surfaced to the client so the user can troubleshoot a stale
 * view without SSH. Reports on cache state, recent upstream attempts, sample
 * DB size, and anonymous visitor counts (daily / 7-day).
 */
function handleDiag()
{
    $now = time();
    $vpFile = CACHE_DIR . '/' . md5(VP_PATH) . '.json';
    $tuFile = CACHE_DIR . '/' . md5(TU_PATH) . '.json';
    $cacheState = function ($file) {
        if (!is_file($file)) return ['present' => false];
        return ['present' => true,
                'age'     => time() - filemtime($file),
                'bytes'   => filesize($file)];
    };

    $out = [
        'ok'         => true,
        'time'       => $now,
        'cache_ttl'  => CACHE_TTL,
        'timeout'    => UPSTREAM_TIMEOUT,
        'cache'      => [
            'vp' => $cacheState($vpFile),
            'tu' => $cacheState($tuFile),
        ],
    ];

    // Recent upstream fetches (success and failure both — useful context).
    $recent = []; $errors = []; $byPath = [];
    if (is_file(DB_PATH)) {
        try {
            $db = bus_open_db();

            $r = $db->query('SELECT at, path, http_code, ms, err FROM fetch_log
                             ORDER BY at DESC LIMIT 30');
            while ($row = $r->fetchArray(SQLITE3_ASSOC)) {
                $recent[] = $row;
                if ($row['err'] !== '' && count($errors) < 6) $errors[] = $row;
            }

            // Per-path: success/fail counts for the last 1h.
            $cutoff = $now - 3600;
            $s = $db->query("SELECT path,
                                    SUM(CASE WHEN err = '' THEN 1 ELSE 0 END) AS ok,
                                    SUM(CASE WHEN err <> '' THEN 1 ELSE 0 END) AS fail,
                                    MAX(at) AS last_at,
                                    MAX(CASE WHEN err = '' THEN at END) AS last_ok_at,
                                    MAX(CASE WHEN err <> '' THEN at END) AS last_fail_at
                             FROM fetch_log WHERE at >= $cutoff GROUP BY path");
            while ($row = $s->fetchArray(SQLITE3_ASSOC)) $byPath[] = $row;

            // Sample / heartbeat / visitor counts.
            $tz = new DateTimeZone('America/Toronto');
            $today = (new DateTime('now', $tz))->format('Y-m-d');
            $weekAgo = (new DateTime('-6 days', $tz))->format('Y-m-d');

            $out['samples'] = [
                'total' => (int) $db->querySingle('SELECT COUNT(*) FROM samples'),
                'today' => (int) $db->querySingle(
                    "SELECT COUNT(*) FROM samples WHERE sdate = '" .
                    str_replace('-', '', $today) . "'"),
                'last_at' => (int) $db->querySingle('SELECT MAX(last_at) FROM samples'),
            ];

            $heartbeatLast = (int) $db->querySingle('SELECT MAX(ran_at) FROM collector_runs');
            $out['heartbeat'] = [
                'last_at' => $heartbeatLast,
                'age'     => $heartbeatLast ? $now - $heartbeatLast : null,
                'minutes_24h' => (int) $db->querySingle(
                    'SELECT COUNT(*) FROM collector_runs WHERE ran_at > ' . ($now - 86400)),
            ];

            // Visitors — today, yesterday, last 7 days, plus a tiny per-day series.
            $vToday = (int) $db->querySingle(
                "SELECT COUNT(*) FROM daily_visits WHERE day = '" .
                SQLite3::escapeString($today) . "'");
            $hitsToday = (int) $db->querySingle(
                "SELECT COALESCE(SUM(hits),0) FROM daily_visits WHERE day = '" .
                SQLite3::escapeString($today) . "'");
            $vWeek = (int) $db->querySingle(
                "SELECT COUNT(*) FROM daily_visits WHERE day >= '" .
                SQLite3::escapeString($weekAgo) . "'");
            $series = [];
            $sq = $db->query("SELECT day, COUNT(*) AS v, SUM(hits) AS h
                              FROM daily_visits
                              WHERE day >= '" . SQLite3::escapeString($weekAgo) . "'
                              GROUP BY day ORDER BY day");
            while ($row = $sq->fetchArray(SQLITE3_ASSOC)) $series[] = $row;
            $out['visitors'] = [
                'today'       => $vToday,
                'hits_today'  => $hitsToday,
                'week'        => $vWeek,
                'series'      => $series,
            ];

            $db->close();
        } catch (Exception $e) {
            $out['db_error'] = BUS_DEBUG ? $e->getMessage() : 'db error';
        }
    } else {
        $out['db_error'] = 'database not present yet';
    }

    $out['recent_fetches'] = $recent;
    $out['recent_errors']  = $errors;
    $out['fetch_summary']  = $byPath;

    echo json_encode($out);
}

/** Add derived percentages/averages to a counts array. */
function dayStats($s)
{
    $m = $s['measured'];
    $s['on_time_pct']   = $m ? round(100 * $s['on_time'] / $m) : null;
    $s['avg_delay_sec'] = $m ? (int) round($s['delay_sum'] / $m) : null;
    unset($s['delay_sum']);
    return $s;
}

/** Scheduled seconds-after-midnight for a (trip, stop), or null. */
function schedStopSecs($schedTrips, $trip, $stop)
{
    static $cache = [];
    if (!isset($cache[$trip])) {
        $map = [];
        if (isset($schedTrips[$trip])) {
            foreach ($schedTrips[$trip][3] as $st) $map[$st[0]] = $st[2];
        }
        $cache[$trip] = $map;
    }
    return $cache[$trip][$stop] ?? null;
}

/** Is a GTFS service running on a given date? Applies calendar_dates. */
function serviceActive($svc, $dateStr, $weekday, $services, $exceptions)
{
    $active = false;
    if (isset($services[$svc])) {
        $s = $services[$svc];
        if ($dateStr >= $s[7] && $dateStr <= $s[8] && (int) $s[$weekday] === 1) {
            $active = true;
        }
    }
    if (isset($exceptions[$dateStr])) {
        foreach ($exceptions[$dateStr] as $ex) {
            if ($ex[0] === $svc) $active = ((int) $ex[1] === 1);
        }
    }
    return $active;
}
