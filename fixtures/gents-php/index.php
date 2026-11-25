<?php

declare(strict_types=1);

require __DIR__ . '/staff-store.php';

$directory = getenv('GENTS_FIXTURE_DATA');
$password = getenv('GENTS_FIXTURE_PASSWORD');
if (!$directory || !$password || !is_dir($directory) || !is_writable($directory)) {
    http_response_code(503);
    exit('Staging fixture is unconfigured.');
}

session_start(['cookie_secure' => true, 'cookie_httponly' => true, 'cookie_samesite' => 'Strict']);
header('Cache-Control: no-store');
header("Content-Security-Policy: default-src 'none'; form-action 'self'; frame-ancestors 'none'");

$_SESSION['form_token'] ??= bin2hex(random_bytes(32));
$token = $_SESSION['form_token'];
$record = 'MyDev Test Barber';
$branch = 'Pilot branch';
$escape = static fn(string $text): string => htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
$redirect = static function (): never {
    header('Location: ./', true, 303);
    exit;
};

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $submitted = $_POST['token'] ?? null;
    if (!is_string($submitted) || !hash_equals($token, $submitted)) {
        http_response_code(403);
        exit('Invalid session.');
    }
    if (($_POST['action'] ?? '') === 'sign-in') {
        $submittedPassword = $_POST['password'] ?? null;
        if (($_POST['account'] ?? '') !== 'mydev-staff-test' || !is_string($submittedPassword) || !hash_equals($password, $submittedPassword)) {
            http_response_code(403);
            exit('Test sign-in was rejected.');
        }
        session_regenerate_id(true);
        $_SESSION['signed_in'] = true;
        $redirect();
    }
    if (!($_SESSION['signed_in'] ?? false) || ($_POST['record'] ?? '') !== $record) {
        http_response_code(403);
        exit('The named staging test account and record are required.');
    }
    if (($_POST['action'] ?? '') === 'save') {
        if (($_POST['branch'] ?? '') !== $branch) {
            http_response_code(400);
            exit('Use the named test branch.');
        }
        $assigned = $record . ' · ' . $branch;
        if (getenv('GENTS_FIXTURE_MODE') === 'lost') {
            $_SESSION['last_added'] = $assigned;
        } elseif (!saveStaff($directory, $assigned)) {
            http_response_code(500);
            exit('The fixture could not store the record.');
        }
        $redirect();
    }
    if (($_POST['action'] ?? '') === 'cleanup') {
        $file = $directory . '/staff.txt';
        if (is_file($file) && !unlink($file)) {
            http_response_code(500);
            exit('The fixture could not clear the record.');
        }
        unset($_SESSION['last_added']);
        $redirect();
    }
    http_response_code(400);
    exit('Invalid fixture action.');
}

?><!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>The Gents PHP staging fixture</title></head>
<body>
<?php if (!($_SESSION['signed_in'] ?? false)): ?>
<h1>Staging test sign-in</h1>
<form method="post">
  <input type="hidden" name="token" value="<?= $escape($token) ?>">
  <label>Test account <input id="test-account" name="account" required></label>
  <label>Test password <input id="test-password" name="password" type="password" required></label>
  <button id="test-sign-in" name="action" value="sign-in">Sign in</button>
</form>
<?php else: ?>
<h1 id="signed-in">Staff workspace</h1>
<form method="post">
  <input type="hidden" name="token" value="<?= $escape($token) ?>">
  <label>Staff name <input id="staff-name" name="record" required></label>
  <label>Branch <input id="staff-branch" name="branch" required></label>
  <button id="save-staff" name="action" value="save">Save</button>
</form>
<div id="staff-list"><?= $escape(savedStaff($directory) ?: ($_SESSION['last_added'] ?? 'No test record')) ?></div>
<form method="post">
  <input type="hidden" name="token" value="<?= $escape($token) ?>">
  <input type="hidden" name="record" value="<?= $escape($record) ?>">
  <button id="remove-staff" name="action" value="cleanup">Remove test record</button>
</form>
<?php endif; ?>
</body></html>
