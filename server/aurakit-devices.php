<?php
/* AuraKit: records the iPhones that opened the page in the AuraClip App Clip.
 *
 * Put this file next to your page, on a PHP host (Hostinger shared hosting works), and call
 * AuraKit.registerDevice() from the page. Each phone gets one file, devices_appcliped/<id>.json,
 * updated on every launch (first_seen, last_seen, launches, model, iOS, tag, page...).
 * Each file has "status": "on" (new phones) or "off": set it to "off" by hand and AuraKit.checkDevice()
 * sends that phone to another page. GET ?id=<id> answers the status.
 *
 * The folder is created next to this file, with an .htaccess that keeps it private on Apache/LiteSpeed.
 * Reference: docs/API.md, section "Recording App Clip phones". */
declare(strict_types=1);

const DEVICES_DIR = __DIR__ . '/devices_appcliped';
const MAX_BODY = 16384;          // bytes
const ALLOWED_ORIGINS = [];      // other sites allowed to post here, e.g. ['https://other.example.com']; same site is always allowed

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function reply(int $code, array $data): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function text($v, int $max = 200): ?string {
    if (!is_string($v) && !is_int($v) && !is_float($v)) return null;
    $s = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', (string)$v) ?? '');
    if ($s === '') return null;
    return function_exists('mb_substr') ? mb_substr($s, 0, $max) : substr($s, 0, $max);
}

// Requests from another site: allowed only when listed (browsers send Origin with a POST).
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    $host = parse_url($origin, PHP_URL_HOST);
    $sameSite = $host !== null && strcasecmp((string)$host, explode(':', $_SERVER['HTTP_HOST'] ?? '')[0]) === 0;
    if (!$sameSite && !in_array($origin, ALLOWED_ORIGINS, true)) reply(403, ['ok' => false, 'error' => 'origin not allowed']);
    if (!$sameSite) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: POST');
        header('Access-Control-Allow-Headers: Content-Type');
    }
}
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'OPTIONS') { http_response_code(204); exit; }

function valid_id($v): string {
    $id = strtolower(is_string($v) ? $v : '');
    if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id)) {
        reply(400, ['ok' => false, 'error' => 'invalid id']);
    }
    return $id;
}

// "on" lets the phone in, "off" sends it to the page set in AuraKit.checkDevice(). Edit the file to change it.
function status_of($record): string {
    return is_array($record) && strtolower(trim((string)($record['status'] ?? 'on'))) === 'off' ? 'off' : 'on';
}

// GET ?id=<id>: the phone's status, for AuraKit.checkDevice(). Changes nothing.
if ($method === 'GET') {
    $id = valid_id($_GET['id'] ?? '');
    $file = DEVICES_DIR . '/' . $id . '.json';
    $record = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;
    if (!is_array($record)) reply(200, ['ok' => true, 'id' => $id, 'found' => false, 'status' => null]);
    reply(200, ['ok' => true, 'id' => $id, 'found' => true, 'status' => status_of($record)]);
}

if ($method !== 'POST') reply(405, ['ok' => false, 'error' => 'GET or POST only']);

$raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($raw === false || $raw === '') reply(400, ['ok' => false, 'error' => 'empty body']);
if (strlen($raw) > MAX_BODY) reply(413, ['ok' => false, 'error' => 'body too large']);
$in = json_decode($raw, true);
if (!is_array($in)) reply(400, ['ok' => false, 'error' => 'invalid JSON']);

$id = valid_id($in['id'] ?? '');

if (!is_dir(DEVICES_DIR) && !@mkdir(DEVICES_DIR, 0755, true) && !is_dir(DEVICES_DIR)) {
    reply(500, ['ok' => false, 'error' => 'cannot create devices_appcliped/ (check folder permissions)']);
}
if (!file_exists(DEVICES_DIR . '/.htaccess')) {
    @file_put_contents(DEVICES_DIR . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\n  Deny from all\n</IfModule>\n");
}
if (!file_exists(DEVICES_DIR . '/index.html')) @file_put_contents(DEVICES_DIR . '/index.html', '');

$file = DEVICES_DIR . '/' . $id . '.json';
$fh = @fopen($file, 'c+');
if (!$fh) reply(500, ['ok' => false, 'error' => 'cannot write devices_appcliped/ (check folder permissions)']);
flock($fh, LOCK_EX);
$old = json_decode(stream_get_contents($fh) ?: '', true);
$isNew = !is_array($old);
if ($isNew) $old = [];

$now = gmdate('c');
$extra = $in['extra'] ?? null;
if (!is_array($extra) && !is_scalar($extra)) $extra = null;

$record = [
    'id'               => $id,
    'status'           => $isNew ? 'on' : status_of($old),
    'first_seen'       => $old['first_seen'] ?? $now,
    'last_seen'        => $now,
    'launches'         => (int)($old['launches'] ?? 0) + 1,
    'app_clip'         => !empty($in['appClip']),
    'tag'              => text($in['tag'] ?? null),
    'page'             => text($in['page'] ?? null, 500),
    'model'            => text($in['model'] ?? null),
    'model_identifier' => text($in['modelIdentifier'] ?? null),
    'model_name'       => text($in['modelName'] ?? null),
    'system_name'      => text($in['systemName'] ?? null),
    'system_version'   => text($in['systemVersion'] ?? null),
    'language'         => text($in['language'] ?? null, 20),
    'region'           => text($in['region'] ?? null, 20),
    'time_zone'        => text($in['timeZone'] ?? null, 60),
    'screen'           => text($in['screen'] ?? null, 20),
    'user_agent'       => text($_SERVER['HTTP_USER_AGENT'] ?? null, 300),
    'extra'            => $extra,
];

ftruncate($fh, 0);
rewind($fh);
fwrite($fh, json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
fflush($fh);
flock($fh, LOCK_UN);
fclose($fh);

reply(200, [
    'ok'         => true,
    'id'         => $id,
    'new'        => $isNew,
    'status'     => $record['status'],
    'launches'   => $record['launches'],
    'first_seen' => $record['first_seen'],
    'last_seen'  => $record['last_seen'],
]);
