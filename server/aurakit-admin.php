<?php
/* AuraKit: admin page for the phones recorded by aurakit-devices.php.
 *
 * Put this file next to aurakit-devices.php and set ADMIN_PASSWORD below. Open it in a browser to see every
 * phone in devices_appcliped/ and turn them "off" (AuraKit.checkDevice() then redirects them) or back "on",
 * one by one, a selection, or all at once.
 * Reference: docs/API.md, section "Admin page". */
declare(strict_types=1);

const ADMIN_PASSWORD = '';                 // REQUIRED: choose a long password. The page refuses to open while it is empty.
const DEVICES_DIR = __DIR__ . '/devices_appcliped';
const DISPLAY_TIME_ZONE = 'Europe/Paris';

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'");

session_set_cookie_params([
    'lifetime' => 0, 'path' => strtok($_SERVER['REQUEST_URI'] ?? '/', '?') ?: '/',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off', 'httponly' => true, 'samesite' => 'Strict',
]);
session_name('aurakit_admin');
session_start();

function h($v): string { return htmlspecialchars((string)$v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function self_url(array $q = []): string {
    $path = strtok($_SERVER['REQUEST_URI'] ?? '', '?') ?: basename(__FILE__);
    return $q ? $path . '?' . http_build_query($q) : $path;
}
function valid_id($v): ?string {
    $id = strtolower(is_string($v) ? $v : '');
    return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id) ? $id : null;
}
function status_of(array $r): string { return strtolower(trim((string)($r['status'] ?? 'on'))) === 'off' ? 'off' : 'on'; }

/** Every recorded phone, most recent first. */
function load_devices(): array {
    $out = [];
    foreach (glob(DEVICES_DIR . '/*.json') ?: [] as $file) {
        $id = valid_id(basename($file, '.json'));
        if (!$id) continue;
        $r = json_decode((string)@file_get_contents($file), true);
        if (!is_array($r)) continue;
        $r['id'] = $id;
        $r['status'] = status_of($r);
        $out[] = $r;
    }
    usort($out, fn($a, $b) => strcmp((string)($b['last_seen'] ?? ''), (string)($a['last_seen'] ?? '')));
    return $out;
}

/** Sets one phone's status, under the same lock as aurakit-devices.php. */
function set_status(string $id, string $status): bool {
    $file = DEVICES_DIR . '/' . $id . '.json';
    if (!is_file($file)) return false;
    $fh = @fopen($file, 'c+');
    if (!$fh) return false;
    flock($fh, LOCK_EX);
    $r = json_decode(stream_get_contents($fh) ?: '', true);
    $ok = false;
    if (is_array($r)) {
        $r['status'] = $status;
        ftruncate($fh, 0);
        rewind($fh);
        $ok = fwrite($fh, json_encode($r, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n") !== false;
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    return $ok;
}

function fmt_date($iso): string {
    if (!is_string($iso) || $iso === '') return '—';
    try {
        $d = new DateTime($iso);
        $d->setTimezone(new DateTimeZone(DISPLAY_TIME_ZONE));
        return $d->format('d/m/Y H:i');
    } catch (Exception $e) { return h($iso); }
}

function page_start(string $title): void {
    echo '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
        . '<title>' . h($title) . '</title><style>
        :root { color-scheme: dark; }
        body { font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #000; color: #f2f2f7; margin: 0; padding: 20px; }
        h1 { font-size: 22px; margin: 0 0 4px; } .muted { color: #8e8e93; }
        .card { background: #1c1c1e; border-radius: 14px; padding: 16px; margin: 16px 0; }
        button, input, select { font: inherit; }
        button { border: 0; border-radius: 10px; padding: 8px 14px; cursor: pointer; background: #2c2c2e; color: #f2f2f7; }
        button.off { background: #ff453a; color: #fff; } button.on { background: #30d158; color: #000; }
        button:disabled { opacity: .4; cursor: default; }
        input[type=password], select { background: #2c2c2e; color: #f2f2f7; border: 0; border-radius: 10px; padding: 8px 12px; }
        .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 10px 8px; border-top: 1px solid #2c2c2e; vertical-align: top; }
        th { color: #8e8e93; font-weight: 500; font-size: 13px; border-top: 0; }
        .pill { display: inline-block; border-radius: 99px; padding: 2px 10px; font-size: 13px; font-weight: 600; }
        .pill.on { background: #30d15833; color: #30d158; } .pill.off { background: #ff453a33; color: #ff453a; }
        tr.off td { opacity: .7; } code { font-size: 12px; color: #8e8e93; word-break: break-all; }
        .msg { background: #0a84ff33; color: #64d2ff; border-radius: 10px; padding: 10px 14px; } .err { background: #ff453a33; color: #ff6961; }
        a { color: #0a84ff; } @media (max-width: 700px) { .wide { display: none; } }
        </style></head><body>';
}

// ------------------------------------------------------------------ Not configured
if (ADMIN_PASSWORD === '') {
    page_start('AuraKit · appareils');
    echo '<div class="card"><h1>Page non configurée</h1><p>Ouvre <code>' . h(basename(__FILE__))
        . '</code> sur le serveur et choisis un mot de passe dans <code>ADMIN_PASSWORD</code>.</p></div></body></html>';
    exit;
}

// ------------------------------------------------------------------ Login / logout
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
$csrfOk = $method === 'POST' && hash_equals($_SESSION['csrf'], (string)($_POST['csrf'] ?? ''));

if ($method === 'POST' && ($_POST['action'] ?? '') === 'login') {
    if ($csrfOk && hash_equals(ADMIN_PASSWORD, (string)($_POST['password'] ?? ''))) {
        session_regenerate_id(true);
        $_SESSION['admin'] = true;
        header('Location: ' . self_url());
        exit;
    }
    sleep(2);                              // slows down password guessing
    $_SESSION['flash'] = ['err', 'Mot de passe incorrect.'];
    header('Location: ' . self_url());
    exit;
}
if ($method === 'POST' && ($_POST['action'] ?? '') === 'logout' && $csrfOk) {
    $_SESSION = [];
    session_destroy();
    header('Location: ' . self_url());
    exit;
}

$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);

if (empty($_SESSION['admin'])) {
    page_start('AuraKit · connexion');
    echo '<div class="card" style="max-width:360px;margin:60px auto"><h1>Appareils App Clip</h1>';
    if ($flash) echo '<p class="msg ' . h($flash[0]) . '">' . h($flash[1]) . '</p>';
    echo '<form method="post" class="bar" style="margin-top:12px"><input type="hidden" name="action" value="login">'
        . '<input type="hidden" name="csrf" value="' . h($_SESSION['csrf']) . '">'
        . '<input type="password" name="password" placeholder="Mot de passe" autofocus required style="flex:1">'
        . '<button class="on">Entrer</button></form></div></body></html>';
    exit;
}

// ------------------------------------------------------------------ Actions
$pageFilter = is_string($_GET['page'] ?? null) ? $_GET['page'] : '';

if ($method === 'POST') {
    $back = self_url($pageFilter !== '' ? ['page' => $pageFilter] : []);
    if (!$csrfOk) {
        $_SESSION['flash'] = ['err', 'Session expirée, recommence.'];
        header('Location: ' . $back);
        exit;
    }
    $action = (string)($_POST['action'] ?? '');
    $status = ($_POST['status'] ?? '') === 'off' ? 'off' : 'on';
    $ids = [];
    if ($action === 'one') {
        $ids = [valid_id($_POST['id'] ?? '')];
    } elseif ($action === 'selected') {
        $ids = array_map('valid_id', is_array($_POST['ids'] ?? null) ? $_POST['ids'] : []);
    } elseif ($action === 'all') {
        foreach (load_devices() as $d) {
            if ($pageFilter === '' || ($d['page'] ?? '') === $pageFilter) $ids[] = $d['id'];
        }
    }
    $ids = array_values(array_unique(array_filter($ids)));
    $done = 0;
    foreach ($ids as $id) if (set_status($id, $status)) $done++;
    $_SESSION['flash'] = $ids
        ? ['msg', $done . ' appareil' . ($done > 1 ? 's' : '') . ' passé' . ($done > 1 ? 's' : '') . ' en ' . $status . '.'
            . ($done < count($ids) ? ' ' . (count($ids) - $done) . ' n’ont pas pu être modifiés (droits du dossier ?).' : '')]
        : ['err', 'Aucun appareil sélectionné.'];
    header('Location: ' . $back);
    exit;
}

// ------------------------------------------------------------------ List
$all = load_devices();
$pages = array_values(array_unique(array_filter(array_map(fn($d) => (string)($d['page'] ?? ''), $all))));
sort($pages);
$devices = $pageFilter === '' ? $all : array_values(array_filter($all, fn($d) => ($d['page'] ?? '') === $pageFilter));
$countOff = count(array_filter($devices, fn($d) => $d['status'] === 'off'));
$csrf = h($_SESSION['csrf']);

page_start('AuraKit · appareils');
echo '<div class="bar" style="justify-content:space-between"><div><h1>Appareils App Clip</h1><div class="muted">'
    . count($devices) . ' appareil' . (count($devices) > 1 ? 's' : '') . ' · ' . (count($devices) - $countOff) . ' on · ' . $countOff . ' off</div></div>'
    . '<form method="post"><input type="hidden" name="action" value="logout"><input type="hidden" name="csrf" value="' . $csrf . '">'
    . '<button>Déconnexion</button></form></div>';
if ($flash) echo '<p class="msg ' . h($flash[0]) . '">' . h($flash[1]) . '</p>';

if (count($pages) > 1) {
    echo '<form method="get" class="bar card"><label class="muted" for="page">Page</label><select id="page" name="page" onchange="this.form.submit()">'
        . '<option value="">Toutes les pages</option>';
    foreach ($pages as $p) echo '<option value="' . h($p) . '"' . ($p === $pageFilter ? ' selected' : '') . '>' . h($p) . '</option>';
    echo '</select><noscript><button>Filtrer</button></noscript></form>';
}

if (!$devices) {
    echo '<div class="card muted">Aucun appareil enregistré' . ($pageFilter !== '' ? ' pour cette page' : '')
        . '. Les téléphones apparaissent ici après un lancement de l’App Clip sur une page qui appelle <code>AuraKit.registerDevice()</code>.</div></body></html>';
    exit;
}

$scope = $pageFilter === '' ? 'tous les appareils' : 'tous les appareils de cette page';
echo '<div class="card"><div class="bar">'
    . '<form method="post" onsubmit="return confirm(\'Passer ' . h($scope) . ' en off ?\')"><input type="hidden" name="action" value="all">'
    . '<input type="hidden" name="status" value="off"><input type="hidden" name="csrf" value="' . $csrf . '"><button class="off">Tout passer en off</button></form>'
    . '<form method="post" onsubmit="return confirm(\'Passer ' . h($scope) . ' en on ?\')"><input type="hidden" name="action" value="all">'
    . '<input type="hidden" name="status" value="on"><input type="hidden" name="csrf" value="' . $csrf . '"><button class="on">Tout passer en on</button></form>'
    . '<span class="muted" style="margin-left:auto" id="selCount"></span>'
    . '<button class="off" form="sel" name="status" value="off" data-sel disabled>Sélection en off</button>'
    . '<button class="on" form="sel" name="status" value="on" data-sel disabled>Sélection en on</button>'
    . '</div></div>';

echo '<form method="post" id="sel"><input type="hidden" name="action" value="selected"><input type="hidden" name="csrf" value="' . $csrf . '"></form>';
echo '<div class="card" style="padding:4px 8px"><table><thead><tr><th><input type="checkbox" id="checkAll" aria-label="Tout sélectionner"></th>'
    . '<th>Statut</th><th>Appareil</th><th>Dernier lancement</th><th class="wide">Lancements</th><th class="wide">Premier lancement</th>'
    . ($pageFilter === '' && count($pages) > 1 ? '<th class="wide">Page</th>' : '') . '<th></th></tr></thead><tbody>';
foreach ($devices as $d) {
    $off = $d['status'] === 'off';
    $model = trim((string)($d['model_name'] ?? $d['model_identifier'] ?? $d['model'] ?? 'iPhone'));
    $system = trim(($d['system_name'] ?? '') . ' ' . ($d['system_version'] ?? ''));
    $extra = isset($d['extra']) && $d['extra'] !== null ? json_encode($d['extra'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '';
    echo '<tr class="' . ($off ? 'off' : 'on') . '">'
        . '<td><input type="checkbox" name="ids[]" value="' . h($d['id']) . '" form="sel" aria-label="Sélectionner"></td>'
        . '<td><span class="pill ' . ($off ? 'off' : 'on') . '">' . ($off ? 'off' : 'on') . '</span></td>'
        . '<td>' . h($model ?: 'iPhone') . ($system !== '' ? ' <span class="muted">· ' . h($system) . '</span>' : '')
        . '<br><code>' . h($d['id']) . '</code>' . ($extra !== '' ? '<br><code>' . h($extra) . '</code>' : '') . '</td>'
        . '<td>' . fmt_date($d['last_seen'] ?? null) . '</td>'
        . '<td class="wide">' . (int)($d['launches'] ?? 0) . '</td>'
        . '<td class="wide">' . fmt_date($d['first_seen'] ?? null) . '</td>'
        . ($pageFilter === '' && count($pages) > 1 ? '<td class="wide"><code>' . h($d['page'] ?? '') . '</code></td>' : '')
        . '<td><form method="post"><input type="hidden" name="action" value="one"><input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<input type="hidden" name="id" value="' . h($d['id']) . '"><input type="hidden" name="status" value="' . ($off ? 'on' : 'off') . '">'
        . '<button class="' . ($off ? 'on' : 'off') . '">Passer en ' . ($off ? 'on' : 'off') . '</button></form></td></tr>';
}
echo '</tbody></table></div>';
?>
<script>
  const boxes = [...document.querySelectorAll('input[name="ids[]"]')];
  const all = document.getElementById('checkAll');
  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    document.querySelectorAll('[data-sel]').forEach((b) => { b.disabled = !n; });
    document.getElementById('selCount').textContent = n ? n + ' sélectionné' + (n > 1 ? 's' : '') : '';
    all.checked = n && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length;
  };
  all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); update(); });
  boxes.forEach((b) => b.addEventListener('change', update));
  update();
</script>
</body></html>
