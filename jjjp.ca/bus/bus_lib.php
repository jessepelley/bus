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
// Retention for the upstream-fetch log + daily visits (small tables, just trim).
define('FETCH_LOG_RETENTION_DAYS', 14);
define('VISITS_RETENTION_DAYS', 365);
// Salt used to hash IPs into per-day visitor ids. Rotate to invalidate history.
define('VISITS_SALT', 'busjjjp-v1');

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
 * HTTP GET with detailed status — returns body + http code + curl/transport error.
 * Same semantics as bus_http_get() but always reports the failure reason so the
 * diagnostics endpoint can show *why* an upstream fetch did not return a body.
 * Also captures Content-Type and a length so we can diagnose "200 but wrong body".
 */
function bus_http_get_detail($url, array $headers)
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        $respHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => UPSTREAM_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_HEADERFUNCTION => function ($ch, $h) use (&$respHeaders) {
                if (preg_match('/^([^:]+):\s*(.+?)\s*$/i', $h, $m))
                    $respHeaders[strtolower($m[1])] = $m[2];
                return strlen($h);
            },
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = $body === false ? curl_error($ch) : '';
        $total = curl_getinfo($ch, CURLINFO_TOTAL_TIME);
        curl_close($ch);
        return [
            'body' => ($body !== false && $code >= 200 && $code < 300) ? $body : null,
            'code' => $code,
            'err'  => $err ?: ($body === false ? 'transport failure' :
                              ($code >= 400 ? 'HTTP ' . $code : '')),
            'ms'   => (int) round(($total ?: 0) * 1000),
            'ctype' => $respHeaders['content-type'] ?? '',
            'len'   => $body === false ? 0 : strlen($body),
        ];
    }
    $ctx = stream_context_create(['http' => [
        'method' => 'GET', 'header' => implode("\r\n", $headers),
        'timeout' => UPSTREAM_TIMEOUT, 'ignore_errors' => true,
    ]]);
    $t0 = microtime(true);
    $body = @file_get_contents($url, false, $ctx);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    $code = 0; $ctype = '';
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) $code = (int) $m[1];
        elseif (stripos($h, 'content-type:') === 0)
            $ctype = trim(substr($h, strlen('content-type:')));
    }
    return [
        'body' => ($body !== false && $code >= 200 && $code < 300) ? $body : null,
        'code' => $code,
        'err'  => $body === false ? 'transport failure'
                 : ($code >= 400 ? 'HTTP ' . $code : ''),
        'ms'   => $ms,
        'ctype' => $ctype,
        'len'   => $body === false ? 0 : strlen($body),
    ];
}

/** Last ~80 chars of the body, control chars escaped. If the body is
 *  truncated mid-object the tail won't be the proper closing braces. */
function bus_body_tail($body)
{
    if ($body === null || $body === '') return '';
    $tail = substr($body, -96);
    return preg_replace_callback('/[\x00-\x1F\x7F]/',
        function ($m) { return sprintf('\\x%02x', ord($m[0])); },
        $tail);
}

/** Compact, log-safe representation of an unexpected response body —
 *  helps tell "HTML error page" from "binary protobuf" from "truncated json". */
function bus_describe_body($body, $ctype)
{
    if ($body === null || $body === false || $body === '') return 'empty';
    $len = strlen($body);
    $head = substr($body, 0, 96);
    $printable = preg_replace('/[^\x20-\x7E]/', '.', $head);
    $isBinary = strlen(preg_replace('/[^\x09\x0A\x0D\x20-\x7E]/', '', $head)) < strlen($head) * 0.85;
    $shape = $isBinary ? 'binary' : 'text';
    if (!$isBinary) {
        if (preg_match('/^\s*<!doctype html|^\s*<html|^\s*<\?xml/i', $head)) $shape = 'html/xml';
        elseif (preg_match('/^\s*[\{\[]/', $head)) $shape = 'json-ish';
    }
    return sprintf(
        '%s · %s · %d bytes · head=%s%s',
        $shape,
        $ctype !== '' ? $ctype : 'no content-type',
        $len,
        substr($printable, 0, 64),
        $len > 64 ? '…' : ''
    );
}

/**
 * Fetch one GTFS-RT feed as a decoded array, with a shared on-disk cache.
 *   $maxAge — serve the cache if it is younger than this many seconds.
 *             api.php passes CACHE_TTL so a burst of visitors shares one fetch.
 * Returns ['data'=>array|null, 'age'=>int, 'stale'=>bool, 'source'=>'cache|fresh|stale_fallback|missing',
 *          'http'=>int, 'err'=>string, 'ms'=>int].
 *
 * Logs every upstream attempt (success or failure) into the fetch_log table so
 * the diagnostics endpoint can surface "why is data delayed right now".
 */
function bus_fetch_feed($path, $maxAge)
{
    if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0775, true);
    $cacheFile = CACHE_DIR . '/' . md5($path) . '.json';

    if ($maxAge > 0 && is_file($cacheFile)) {
        $age = time() - filemtime($cacheFile);
        if ($age < $maxAge) {
            return ['data' => json_decode(file_get_contents($cacheFile), true),
                    'age' => $age, 'stale' => false, 'source' => 'cache',
                    'http' => 0, 'err' => '', 'ms' => 0];
        }
    }

    $res = bus_http_get_detail(OCT_BASE . '/' . $path . '?format=json',
                               ['Ocp-Apim-Subscription-Key: ' . OCT_KEY,
                                'Accept: application/json']);
    if ($res['body'] !== null) {
        $data = json_decode($res['body'], true);
        if (is_array($data)) {
            file_put_contents($cacheFile, $res['body'], LOCK_EX);
            bus_log_fetch($path, $res['code'] ?: 200, $res['ms'], '');
            return ['data' => $data, 'age' => 0, 'stale' => false,
                    'source' => 'fresh', 'http' => $res['code'] ?: 200,
                    'err' => '', 'ms' => $res['ms']];
        }
        // Strict parse failed. Capture *what* json_decode complained about so
        // the diag modal can show it.
        $whyStrict = json_last_error_msg();

        // Recovery cascade. Each step tries one tolerant strategy; whichever
        // succeeds first is what we serve, and the diag modal records which.
        //
        //   1. UTF-8 substitute       — one rogue byte in a stop name.
        //   2. Strip ASCII control chars (except \t\n\r) — OC Transpo's JSON
        //      sometimes ships unescaped NUL/VT inside string values, which
        //      is spec-noncompliant and breaks json_decode by design.
        //   3. Both at once           — belt and braces.
        $tol = json_decode($res['body'], true, 512, JSON_INVALID_UTF8_SUBSTITUTE);
        $recoveryStep = $tol !== null ? 'utf8' : '';

        if ($tol === null) {
            $stripped = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $res['body']);
            $tol = json_decode($stripped, true);
            if (is_array($tol)) $recoveryStep = 'stripped';
        }
        if ($tol === null) {
            $stripped = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', '', $res['body']);
            $tol = json_decode($stripped, true, 512, JSON_INVALID_UTF8_SUBSTITUTE);
            if (is_array($tol)) $recoveryStep = 'stripped+utf8';
        }

        if (is_array($tol)) {
            // Cache the ORIGINAL body so the next request can also try the
            // strict parse first (in case the issue was transient).
            file_put_contents($cacheFile, $res['body'], LOCK_EX);
            $note = 'recovered (' . $recoveryStep . ') · ' . $whyStrict;
            bus_log_fetch($path, $res['code'] ?: 200, $res['ms'], $note);
            return ['data' => $tol, 'age' => 0, 'stale' => false,
                    'source' => 'fresh', 'http' => $res['code'] ?: 200,
                    'err' => $note, 'ms' => $res['ms']];
        }

        // Still no good after every tolerance step — record everything we
        // know so the cause is unambiguous (control char vs. truncation).
        $res['err'] = 'json parse failed · ' . $whyStrict . ' · ' .
                      bus_describe_body($res['body'], $res['ctype'] ?? '') .
                      ' · tail=' . bus_body_tail($res['body']);
    }

    bus_log_fetch($path, $res['code'], $res['ms'], $res['err'] ?: 'no body');

    // Upstream failed — fall back to stale cache if we have any.
    if (is_file($cacheFile)) {
        return ['data' => json_decode(file_get_contents($cacheFile), true),
                'age' => time() - filemtime($cacheFile), 'stale' => true,
                'source' => 'stale_fallback', 'http' => $res['code'],
                'err' => $res['err'], 'ms' => $res['ms']];
    }
    return ['data' => null, 'age' => -1, 'stale' => true,
            'source' => 'missing', 'http' => $res['code'],
            'err' => $res['err'], 'ms' => $res['ms']];
}

/** Append one fetch attempt to the log. Best-effort — never throws. */
function bus_log_fetch($path, $httpCode, $ms, $err)
{
    try {
        $db = bus_open_db();
        $stmt = $db->prepare(
            'INSERT INTO fetch_log (at, path, http_code, ms, err)
             VALUES (:a, :p, :c, :m, :e)');
        $stmt->bindValue(':a', time(),     SQLITE3_INTEGER);
        $stmt->bindValue(':p', $path,      SQLITE3_TEXT);
        $stmt->bindValue(':c', (int)$httpCode, SQLITE3_INTEGER);
        $stmt->bindValue(':m', (int)$ms,   SQLITE3_INTEGER);
        $stmt->bindValue(':e', (string)$err, SQLITE3_TEXT);
        $stmt->execute();
        $db->close();
    } catch (Exception $e) { /* best-effort */ }
}

/**
 * Record one anonymised visitor for today. The IP is hashed with the date and
 * a private salt so the same visitor counts once per day but raw IPs are never
 * stored. UNIQUE(day, hash) collapses repeat hits into a single row.
 */
function bus_record_visit()
{
    try {
        $ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '';
        if ($ip === '') return;
        $ip = trim(explode(',', $ip)[0]);
        $tz = new DateTimeZone('America/Toronto');
        $day = (new DateTime('now', $tz))->format('Y-m-d');
        $hash = substr(hash('sha256', VISITS_SALT . '|' . $day . '|' . $ip), 0, 16);
        $db = bus_open_db();
        $stmt = $db->prepare(
            'INSERT OR IGNORE INTO daily_visits (day, hash, first_at, hits)
             VALUES (:d, :h, :t, 1)');
        $stmt->bindValue(':d', $day, SQLITE3_TEXT);
        $stmt->bindValue(':h', $hash, SQLITE3_TEXT);
        $stmt->bindValue(':t', time(), SQLITE3_INTEGER);
        $stmt->execute();
        // Bump hits even if the row already existed — useful to spot real activity.
        $bump = $db->prepare(
            'UPDATE daily_visits SET hits = hits + 1
             WHERE day = :d AND hash = :h');
        $bump->bindValue(':d', $day, SQLITE3_TEXT);
        $bump->bindValue(':h', $hash, SQLITE3_TEXT);
        $bump->execute();
        $db->close();
    } catch (Exception $e) { /* best-effort */ }
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
    // Every upstream fetch attempt — for the diagnostics modal.
    $db->exec(
        'CREATE TABLE IF NOT EXISTS fetch_log (
            at        INTEGER NOT NULL,
            path      TEXT    NOT NULL,
            http_code INTEGER,
            ms        INTEGER,
            err       TEXT
        )'
    );
    $db->exec('CREATE INDEX IF NOT EXISTS ix_fetch_log_at ON fetch_log (at)');
    // Anonymised daily visitor counts (hash(salt|day|ip), so same visitor
    // counts once/day but the raw IP is never stored).
    $db->exec(
        'CREATE TABLE IF NOT EXISTS daily_visits (
            day       TEXT    NOT NULL,
            hash      TEXT    NOT NULL,
            first_at  INTEGER,
            hits      INTEGER DEFAULT 1,
            PRIMARY KEY (day, hash)
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
            $db->exec('DELETE FROM fetch_log WHERE at < ' . ($now - FETCH_LOG_RETENTION_DAYS * 86400));
            $visCutoff = (new DateTime('-' . VISITS_RETENTION_DAYS . ' days', $tz))->format('Y-m-d');
            $db->exec("DELETE FROM daily_visits WHERE day < '" . SQLite3::escapeString($visCutoff) . "'");
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
