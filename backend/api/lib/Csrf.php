<?php
declare(strict_types=1);

/** Ochrana admin formulárov pred odoslaním z cudzej stránky. */
final class Csrf
{
    public static function token(): string
    {
        Auth::start();
        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        return $_SESSION['csrf'];
    }

    public static function field(): string
    {
        return '<input type="hidden" name="_csrf" value="' . htmlspecialchars(self::token(), ENT_QUOTES) . '">';
    }

    public static function verify(?string $token = null): bool
    {
        Auth::start();
        $token ??= $_POST['_csrf'] ?? '';
        return !empty($_SESSION['csrf']) && is_string($token) && hash_equals($_SESSION['csrf'], $token);
    }

    public static function require(): void
    {
        if (!self::verify()) {
            http_response_code(419);
            exit('Formulár vypršal. Obnov stránku a skús to znova.');
        }
    }
}
