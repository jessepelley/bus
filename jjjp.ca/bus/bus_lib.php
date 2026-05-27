<?php
/**
 * bus_lib.php — shared config + helpers for the bus.jjjp.ca NAS backend.
 * Required by api.php — the only backend script. Compatible with PHP 7.2+.
 *
 * Deploy bus_lib.php and api.php into the same folder, served at jjjp.ca/bus/.
 * The folder must be writable — api.php creates a .cache/ folder and a
 * bus-stats.db SQLite file beside them.
 *
 * There is no cron job. api.php fetches the OC Transpo feeds when visitors
 * use the app, caches them briefly so concurrent visitors share one fetch,
 * and records reliability samples from that same traffic. Reliability data is
 * therefore gathered only while the app is actually being used.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
define('OCT_KEY',  '34a1dacfc633463f89767ce742da2d1a');   // OC Transpo subscription key
define('OCT_BASE', 'https://nextrip-public-api.azure-api.net/octranspo');
define('VP_PATH',  'gtfs-rt-vp/beta/v1/VehiclePositions');
define('TU_PATH',  'gtfs-rt-tp/beta/v1/TripUpdates');

define('CACHE_DIR', __DIR__ . '/.cache');
// How long a fetched feed is reused before api.php fetches again. A visitor's
// poll within this window is served from cache and makes no upstream call, so
// many concurrent visitors still produce only ~one fetch per CACHE_TTL. Keep
// it near the feed's own update cadence (~20-30 s) — fresh enough for users,
// while still collapsing bursts of traffic into a single upstream request.
define('CACHE_TTL', 30);
define('UPSTREAM_TIMEOUT', 8);

define('DB_PATH',        __DIR__ . '/bus-stats.db');
define('SCHED_META_PATH', __DIR__ . '/schedule-meta.json');   // shared calendar
define('SCHED_DIR',       __DIR__ . '/schedule');             // per-route schedule files

// History retention for the samples table.
define('SAMPLE_RETENTION_DAYS', 90);

define('BUS_DEBUG', false);

$GLOBALS['BUS_ALLOWED_ORIGINS'] = [
    'https://bus.jjjp.ca',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
];

// Future login (off by default — transit data is public). See api.php.
define('REQUIRE_AUTH', false);
define('AUTH_DB_PATH', '/volume3/web/jjjp.ca/src/posts.db');
// ─────────────────────────────────────────────────────────────────────────────

if (BUS_DEBUG) { ini_set('display_errors', 1); error_reporting(E_ALL); }
else           { ini_set('display_errors', 0); error_reporting(0); }


/** HTTP GET, returns body string or null on failure. */
function bus_http_get($url, array $headers)
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => UPSTREAM_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return ($body !== false && $code >= 200 && $code < 300) ? $body : null;
    }
    $ctx = stream_context_create(['http' => [
        'method' => 'GET', 'header' => implode("\r\n", $headers),
        'timeout' => UPSTREAM_TIMEOUT,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body === false ? null : $body;
}

/**
 * Fetch one GTFS-RT feed as a decoded array, with a shared on-disk cache.
 *   $maxAge — serve the cache if it is younger than this many seconds.
 *             api.php passes CACHE_TTL so a burst of visitors shares one fetch.
 * Returns ['data'=>array|null, 'age'=>int, 'stale'=>bool].
 */
function bus_fetch_feed($path, $maxAge)
{
    if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0775, true);
    $cacheFile = CACHE_DIR . '/' . md5($path) . '.json';

    if ($maxAge > 0 && is_file($cacheFile)) {
        $age = time() - filemtime($cacheFile);
        if ($age < $maxAge) {
            return ['data' => json_decode(file_get_contents($cacheFile), true),
                    'age' => $age, 'stale' => false];
        }
    }

    $raw = bus_http_get(OCT_BASE . '/' . $path . '?format=json',
                        ['Ocp-Apim-Subscription-Key: ' . OCT_KEY]);
    if ($raw !== null) {
        $data = json_decode($raw, true);
        if (is_array($data)) {
            file_put_contents($cacheFile, $raw, LOCK_EX);
            return ['data' => $data, 'age' => 0, 'stale' => false];
        }
    }

    // Upstream failed — fall back to stale cache if we have any.
    if (is_file($cacheFile)) {
        return ['data' => json_decode(file_get_contents($cacheFile), true),
                'age' => time() - filemtime($cacheFile), 'stale' => true];
    }
    return ['data' => null, 'age' => -1, 'stale' => true];
}

/** Open (and, on first use, create) the reliability database. */
function bus_open_db()
{
    $db = new SQLite3(DB_PATH);
    $db->busyTimeout(5000);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA synchronous=NORMAL');
    $db->exec(
        'CREATE TABLE IF NOT EXISTS samples (
            sdate    TEXT NOT NULL,
            trip     TEXT NOT NULL,
            stop     TEXT NOT NULL,
            seq      INTEGER,
            route    TEXT,
            pred     INTEGER,
            first_at INTEGER,
            last_at  INTEGER,
            PRIMARY KEY (sdate, trip, stop)
        )'
    );
    $db->exec('CREATE INDEX IF NOT EXISTS ix_samples_route ON samples (sdate, route)');
    // Heartbeats: one row per minute the app was in use. The stats endpoint
    // turns these into "coverage spans" so a trip is only judged ran/missed
    // when the app was actually being used around its scheduled time.
    $db->exec(
        'CREATE TABLE IF NOT EXISTS collector_runs (
            ran_at   INTEGER PRIMARY KEY,
            feed_ts  INTEGER,
            n_trips  INTEGER,
            n_veh    INTEGER,
            ok       INTEGER
        )'
    );
    return $db;
}

/**
 * Record reliability samples from a decoded TripUpdates feed, plus a heartbeat.
 * Called by api.php on every realtime request — so the data is gathered from
 * real visitor traffic instead of a cron job.
 *
 *   $tuData   — decoded TripUpdates feed (or null).
 *   $vpData   — decoded VehiclePositions feed (or null) — for the heartbeat count.
 *   $routeSet — assoc array (route id => true) to record, or null for all.
 *
 * Each tracked trip/stop upserts the latest predicted arrival into `samples`.
 * Once a bus passes a stop that stop stops updating, so the final stored value
 * approximates the actual arrival time. Never throws.
 */
function bus_record_samples($tuData, $vpData, $routeSet)
{
    $now = time();
    try {
        $db     = bus_open_db();
        $tz     = new DateTimeZone('America/Toronto');
        $today  = (new DateTime('now', $tz))->format('Ymd');
        $nTrips = 0;
        $nVeh   = is_array($vpData) ? count($vpData['Entity'] ?? []) : 0;
        $feedTs = is_array($tuData) ? ($tuData['Header']['Timestamp'] ?? null) : null;
        $ok     = is_array($tuData) ? 1 : 0;

        if (is_array($tuData)) {
            $ins = $db->prepare(
                'INSERT OR IGNORE INTO samples
                   (sdate, trip, stop, seq, route, pred, first_at, last_at)
                 VALUES (:d, :t, :s, :q, :r, :p, :n, :n)');
            $upd = $db->prepare(
                'UPDATE samples SET pred = :p, seq = :q, last_at = :n
                 WHERE sdate = :d AND trip = :t AND stop = :s');

            $db->exec('BEGIN');
            foreach ($tuData['Entity'] ?? [] as $e) {
                $t = $e['TripUpdate'] ?? null;
                if (!$t) continue;
                $trip  = $t['Trip'] ?? [];
                $tid   = $trip['TripId'] ?? null;
                $route = $trip['RouteId'] ?? null;
                if (!$tid || !$route) continue;
                if ($routeSet !== null && !isset($routeSet[$route])) continue;
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
        }

        // Heartbeat — keyed to the minute so concurrent visitors collapse to
        // one row (and the table stays small).
        $minute = $now - ($now % 60);
        $hb = $db->prepare(
            'INSERT OR REPLACE INTO collector_runs (ran_at, feed_ts, n_trips, n_veh, ok)
             VALUES (:a, :f, :t, :v, :o)');
        $hb->bindValue(':a', $minute, SQLITE3_INTEGER);
        $hb->bindValue(':f', $feedTs, SQLITE3_INTEGER);
        $hb->bindValue(':t', $nTrips, SQLITE3_INTEGER);
        $hb->bindValue(':v', $nVeh,   SQLITE3_INTEGER);
        $hb->bindValue(':o', $ok,     SQLITE3_INTEGER);
        $hb->execute();

        // Prune old data occasionally (roughly 1 run in 200 — cheap upkeep).
        if (mt_rand(1, 200) === 1) {
            $cutoff = (new DateTime('-' . SAMPLE_RETENTION_DAYS . ' days', $tz))->format('Ymd');
            $db->exec("DELETE FROM samples WHERE sdate < '" . SQLite3::escapeString($cutoff) . "'");
            $db->exec('DELETE FROM collector_runs WHERE ran_at < ' . ($now - 14 * 86400));
        }
        $db->close();
    } catch (Exception $e) {
        // Sampling is best-effort — never let it break the realtime response.
    }
}

/** Validate a token against the shared APP_TOKENS table (app = 'bus'). */
function bus_validate_token($token)
{
    if (empty($token)) return null;
    try {
        $db = new SQLite3(AUTH_DB_PATH, SQLITE3_OPEN_READONLY);
        $stmt = $db->prepare("SELECT USER_ID FROM APP_TOKENS WHERE APP='bus' AND TOKEN=:t");
        $stmt->bindValue(':t', $token, SQLITE3_TEXT);
        $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
        $db->close();
        return $row ? (int) $row['USER_ID'] : null;
    } catch (Exception $e) {
        return null;
    }
}
