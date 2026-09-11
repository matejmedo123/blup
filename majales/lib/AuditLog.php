<?php
declare(strict_types=1);

/**
 * Kto čo v admine zmenil. Pri viacerých ľuďoch v tíme je to jediný
 * spôsob, ako dohľadať, kedy sa obsah zmenil a kým.
 */
final class AuditLog
{
    public static function write(string $action, string $entity = '', string|int $entityId = '', mixed $detail = null): void
    {
        $user = null;
        try {
            $user = Auth::user();
        } catch (Throwable) {
            // Zápis do denníka nikdy nesmie zhodiť samotnú operáciu.
        }

        try {
            Db::insert('audit_log', [
                'user_id'    => $user !== null ? (int) $user['id'] : null,
                'username'   => $user !== null ? (string) $user['username'] : 'system',
                'action'     => mb_substr($action, 0, 60),
                'entity'     => mb_substr($entity, 0, 60),
                'entity_id'  => mb_substr((string) $entityId, 0, 60),
                'detail'     => $detail === null ? null : mb_substr(json_encode($detail, JSON_UNESCAPED_UNICODE) ?: '', 0, 4000),
                'ip'         => RateLimit::clientIp(),
                'created_at' => Clock::now(),
            ]);
        } catch (Throwable $e) {
            error_log('Audit log: ' . $e->getMessage());
        }
    }

    /** @return list<array<string,mixed>> */
    public static function recent(int $limit = 100, int $offset = 0): array
    {
        $limit  = max(1, min(500, $limit));
        $offset = max(0, $offset);
        return Db::all("SELECT * FROM audit_log ORDER BY id DESC LIMIT $limit OFFSET $offset");
    }

    public static function count(): int
    {
        return (int) Db::value('SELECT COUNT(*) FROM audit_log');
    }

    /** Denník sa nemaže po kúskoch — len sa oreže to, čo je staršie. */
    public static function pruneOlderThanDays(int $days): int
    {
        $st = Db::run('DELETE FROM audit_log WHERE created_at < ?', [Clock::at(-$days * 86400)]);
        return $st->rowCount();
    }
}
