<?php
declare(strict_types=1);

/** Prihlásenie do adminu — session + bcrypt, bez závislostí. */
final class Auth
{
    public const ROLE_ADMIN = 'admin';
    public const ROLE_STAFF = 'staff';

    public static function start(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'secure'   => $https,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_name('enzo_admin');
        session_start();
    }

    /** @return array{ok:bool,error:?string} */
    public static function attempt(string $email, string $password): array
    {
        $email = strtolower(trim($email));
        $user  = Db::one('SELECT * FROM users WHERE email = ? AND is_active = 1', [$email]);

        // rovnaký čas odpovede aj pri neexistujúcom používateľovi
        $hash = $user['password_hash'] ?? '$2y$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
        if (!password_verify($password, $hash) || $user === null) {
            // Zapisujeme len e-mail, nikdy zadané heslo.
            AuditLog::record(null, 'login_failed', 'user', $email, 'Neúspešné prihlásenie');
            return ['ok' => false, 'error' => 'Nesprávny e-mail alebo heslo.'];
        }

        session_regenerate_id(true);
        $_SESSION['user_id']   = (int) $user['id'];
        $_SESSION['user_role'] = $user['role'];
        $_SESSION['user_name'] = $user['name'];
        Db::run('UPDATE users SET last_login_at = ? WHERE id = ?', [date('Y-m-d H:i:s'), $user['id']]);
        AuditLog::record(
            ['id' => (int) $user['id'], 'name' => (string) $user['name']],
            'login',
            'user',
            (string) $user['id'],
            'Prihlásenie do adminu'
        );

        return ['ok' => true, 'error' => null];
    }

    public static function logout(): void
    {
        self::start();
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
        }
        session_destroy();
    }

    /** @return array<string,mixed>|null */
    public static function user(): ?array
    {
        self::start();
        if (empty($_SESSION['user_id'])) {
            return null;
        }
        return [
            'id'   => (int) $_SESSION['user_id'],
            'name' => (string) ($_SESSION['user_name'] ?? ''),
            'role' => (string) ($_SESSION['user_role'] ?? self::ROLE_STAFF),
        ];
    }

    public static function check(): bool
    {
        return self::user() !== null;
    }

    public static function isAdmin(): bool
    {
        return (self::user()['role'] ?? '') === self::ROLE_ADMIN;
    }

    /** Presmeruje na prihlásenie, ak používateľ nie je prihlásený. */
    public static function requireLogin(string $loginUrl = 'index.php'): array
    {
        $user = self::user();
        if ($user === null) {
            $target = $_SERVER['REQUEST_URI'] ?? '';
            header('Location: ' . $loginUrl . '?next=' . rawurlencode($target));
            exit;
        }
        return $user;
    }

    public static function requireAdmin(): array
    {
        return self::requireRole(self::ROLE_ADMIN);
    }

    /**
     * Vpustí len používateľa s danou rolou.
     *
     * Skryť odkaz v menu nestačí — kto pozná adresu, otvorí si stránku
     * priamo, takže sa práva kontrolujú tu, na serveri.
     *
     * @return array<string,mixed>
     */
    public static function requireRole(string $role): array
    {
        $user = self::requireLogin();
        if ($role === self::ROLE_ADMIN && $user['role'] !== self::ROLE_ADMIN) {
            http_response_code(403);
            // Admin stránky majú vlastnú hlášku v layoute; API vrstva ho
            // načítaný nemá, tak tam vypíšeme jednoduchý text.
            if (function_exists('layout_denied')) {
                layout_denied();
            }
            exit('Na túto sekciu potrebuješ oprávnenie správcu.');
        }
        return $user;
    }

    /** Čo smie daná rola. Jediné miesto, kde je to napísané. */
    public static function can(?array $user, string $ability): bool
    {
        if ($user === null) {
            return false;
        }
        $role = (string) ($user['role'] ?? self::ROLE_STAFF);

        // Obsluha vybavuje objednávky; meniť ponuku, ceny, nastavenia
        // a používateľov smie len správca.
        $adminOnly = [
            'menu.edit', 'settings.edit', 'users.manage',
            'zones.edit', 'hours.edit', 'coupons.edit',
            'accounting.view', 'audit.view', 'orders.cancel',
        ];

        if ($role === self::ROLE_ADMIN) {
            return true;
        }
        return !in_array($ability, $adminOnly, true);
    }

    public static function hash(string $password): string
    {
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
    }
}
