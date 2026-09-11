<?php
declare(strict_types=1);

/**
 * Prihlásenie do adminu. Heslá sú hashované, session je stiahnutá
 * na admin cestu a po istom čase nečinnosti vyprší.
 */
final class Auth
{
    public const ROLE_ADMIN  = 'admin';
    public const ROLE_EDITOR = 'editor';

    /** Po takomto čase nečinnosti sa prihlásenie zruší. */
    private const IDLE_TIMEOUT = 8 * 3600;

    public static function start(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        if (PHP_SAPI === 'cli') {
            // V testoch sa session nezakladá — stav držíme v $_SESSION priamo.
            $_SESSION ??= [];
            return;
        }
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

        session_name('majales_admin');
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'secure'   => $https,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    /** @return array<string,mixed>|null */
    public static function user(): ?array
    {
        self::start();
        $id = $_SESSION['uid'] ?? null;
        if (!is_int($id) && !is_string($id)) {
            return null;
        }
        $last = (int) ($_SESSION['seen'] ?? 0);
        if ($last > 0 && Clock::timestamp() - $last > self::IDLE_TIMEOUT) {
            self::logout();
            return null;
        }
        $user = Db::one('SELECT * FROM users WHERE id = ? AND active = 1', [(int) $id]);
        if ($user === null) {
            self::logout();
            return null;
        }
        $_SESSION['seen'] = Clock::timestamp();
        return $user;
    }

    public static function check(): bool
    {
        return self::user() !== null;
    }

    public static function isAdmin(): bool
    {
        $u = self::user();
        return $u !== null && $u['role'] === self::ROLE_ADMIN;
    }

    /** Prihlásenie menom a heslom. Vracia používateľa alebo null. */
    public static function attempt(string $username, string $password): ?array
    {
        $user = Db::one('SELECT * FROM users WHERE username = ? AND active = 1', [$username]);
        if ($user === null) {
            // Rovnaký čas odpovede aj pri neexistujúcom mene — nech sa nedá
            // z rýchlosti odpovede vyčítať, ktoré meno existuje.
            password_verify($password, '$2y$12$usarMKrJ1BVEZ9tP9dwZ7uWZUw5sgpUOmM.HuEt3o01AWFGvrUeK2');
            return null;
        }
        if (!password_verify($password, (string) $user['password_hash'])) {
            return null;
        }
        if (password_needs_rehash((string) $user['password_hash'], PASSWORD_DEFAULT)) {
            Db::update('users', (int) $user['id'], [
                'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            ]);
        }
        return $user;
    }

    /** @param array<string,mixed> $user */
    public static function login(array $user): void
    {
        self::start();
        if (PHP_SAPI !== 'cli') {
            session_regenerate_id(true);
        }
        $_SESSION['uid']  = (int) $user['id'];
        $_SESSION['seen'] = Clock::timestamp();
        Db::update('users', (int) $user['id'], ['last_login_at' => Clock::now()]);
    }

    public static function logout(): void
    {
        self::start();
        $_SESSION = [];
        if (PHP_SAPI !== 'cli' && session_status() === PHP_SESSION_ACTIVE) {
            session_destroy();
        }
    }

    /** Stráž na začiatku každej admin stránky. */
    public static function requireLogin(): array
    {
        $u = self::user();
        if ($u === null) {
            $back = $_SERVER['REQUEST_URI'] ?? '';
            header('Location: index.php?next=' . urlencode((string) $back));
            exit;
        }
        return $u;
    }

    /** Stráž na stránkach, kam smie len správca. */
    public static function requireAdmin(): array
    {
        $u = self::requireLogin();
        if ($u['role'] !== self::ROLE_ADMIN) {
            http_response_code(403);
            exit('Na túto stránku nemáš oprávnenie.');
        }
        return $u;
    }

    public static function createUser(string $username, string $password, string $role, string $displayName = ''): int
    {
        return Db::insert('users', [
            'username'      => $username,
            'display_name'  => $displayName !== '' ? $displayName : $username,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'role'          => $role,
            'active'        => 1,
            'created_at'    => Clock::now(),
        ]);
    }
}
