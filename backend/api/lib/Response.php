<?php
declare(strict_types=1);

/** Jednotné JSON odpovede a CORS. */
final class Response
{
    public static function cors(array $allowedOrigins): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin');
            header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type');
            header('Access-Control-Max-Age: 86400');
        }
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function ok(mixed $data = null): never
    {
        self::json(['ok' => true, 'data' => $data]);
    }

    /** @param array<string,string> $fields */
    public static function fail(string $message, int $status = 400, array $fields = []): never
    {
        self::json(['ok' => false, 'error' => $message, 'fields' => $fields], $status);
    }

    /**
     * Chyba s kódom — frontend podľa neho vie zareagovať inak než len
     * vypísaním textu. HTTP číslo sa odvodí z kódu, ak ho nezadáme.
     *
     * @param array<string,string> $fields
     */
    public static function failCode(
        string $code,
        string $message,
        array $fields = [],
        ?int $status = null
    ): never {
        self::json(
            ['ok' => false, 'code' => $code, 'error' => $message, 'fields' => $fields],
            $status ?? ErrorCode::httpStatus($code)
        );
    }

    /** @return array<string,mixed> */
    public static function jsonBody(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        $data = json_decode($raw, true);
        return is_array($data) ? $data : [];
    }

    public static function requireMethod(string $method): void
    {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
            self::failCode(ErrorCode::METHOD_NOT_ALLOWED, 'Nepovolená metóda.');
        }
    }

    public static function clientIp(): string
    {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $key) {
            if (!empty($_SERVER[$key])) {
                $ip = trim(explode(',', (string) $_SERVER[$key])[0]);
                if (filter_var($ip, FILTER_VALIDATE_IP)) {
                    return $ip;
                }
            }
        }
        return '0.0.0.0';
    }
}
