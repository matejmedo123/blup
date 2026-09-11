<?php
declare(strict_types=1);

/**
 * Prihlásenie na odber noviniek z pätičky. Odpovedá JSON-om, keď o to
 * skript požiada, inak presmeruje späť na stránku s hláškou v adrese —
 * formulár tak funguje aj bez JavaScriptu.
 */

require __DIR__ . '/../lib/bootstrap.php';

$wantsJson = str_contains((string) ($_SERVER['HTTP_ACCEPT'] ?? ''), 'application/json')
    || strtolower((string) ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '')) === 'xmlhttprequest';

/** Odpoveď buď ako JSON, alebo presmerovaním späť do pätičky. */
$respond = static function (bool $ok, string $message, int $status = 200) use ($wantsJson): never {
    if ($wantsJson) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(
            $ok ? ['ok' => true, 'message' => $message] : ['ok' => false, 'error' => $message],
            JSON_UNESCAPED_UNICODE
        );
        exit;
    }
    $param = $ok ? 'odber=ok' : 'odber=chyba&sprava=' . urlencode($message);
    header('Location: ../index.php?' . $param . '#subscribe');
    exit;
};

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    $respond(false, 'Formulár treba odoslať.', 405);
}

if (!Settings::bool('newsletter_enabled', true)) {
    $respond(false, 'Odber noviniek je momentálne vypnutý.', 403);
}

$ip = RateLimit::clientIp();

// Z jednej adresy najviac 5 pokusov za 10 minút — bez toho by sa dala
// tabuľka odberateľov zaplaviť.
if (!RateLimit::attempt('subscribe', $ip, 5, 600)) {
    $wait = max(1, (int) ceil(RateLimit::retryAfter('subscribe', $ip) / 60));
    $respond(false, 'Priveľa pokusov. Skús to znova o ' . $wait . ' min.', 429);
}

// Pole, ktoré človek nevidí a nevyplní — robot áno. Tvárime sa, že
// odoslanie prešlo, nech si to robot neoverí.
if (trim((string) ($_POST['website'] ?? '')) !== '') {
    $respond(true, 'Ďakujeme! Ozveme sa s novinkami.');
}

$v     = new Validate($_POST);
$email = $v->email('email', 'E-mail');
if (!$v->ok()) {
    $respond(false, $v->firstError(), 422);
}

try {
    $result = Subscribers::subscribe($email, 'web');
} catch (Throwable $e) {
    error_log('Odber noviniek: ' . $e->getMessage());
    $respond(false, 'Prihlásenie sa nepodarilo. Skús to o chvíľu.', 500);
}

if ($result !== 'already') {
    // E-maily posielame až po uložení — keď pošta zlyhá, odber platí.
    Subscribers::sendWelcome($email);
    Subscribers::notifyOrganiser($email);
    AuditLog::write('subscribe', 'subscriber', $email, ['result' => $result]);
}

$respond(true, $result === 'already'
    ? 'Tento e-mail už novinky odoberá. Ďakujeme!'
    : 'Ďakujeme! Ozveme sa s novinkami.');
