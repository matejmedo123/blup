<?php
declare(strict_types=1);

/**
 * Záznam citlivých operácií v admine.
 *
 * Keď sa niekto pýta „kto zmenil cenu burgra“ alebo „prečo je tá
 * objednávka zrušená“, odpoveď musí byť v systéme, nie v pamäti ľudí.
 *
 * Zapisujeme *čo sa stalo*, nie celý obsah — do audit logu nepatria
 * telefónne čísla, adresy ani nič, čo tam nemusí byť.
 */
final class AuditLog
{
    /**
     * @param array<string,mixed>|null $user prihlásený používateľ
     */
    public static function record(
        ?array $user,
        string $action,
        string $entity,
        ?string $entityId = null,
        ?string $summary = null
    ): void {
        if (!Db::tableExists('audit_log')) {
            return;
        }
        try {
            Db::insert('audit_log', [
                'user_id'    => $user['id'] ?? null,
                'user_label' => mb_substr((string) ($user['name'] ?? 'systém'), 0, 120),
                'action'     => mb_substr($action, 0, 60),
                'entity'     => mb_substr($entity, 0, 40),
                'entity_id'  => $entityId !== null ? mb_substr($entityId, 0, 60) : null,
                'summary'    => $summary !== null ? mb_substr($summary, 0, 255) : null,
                'ip'         => Response::clientIp(),
                'created_at' => date('Y-m-d H:i:s'),
            ]);
        } catch (Throwable $e) {
            // Audit nesmie zhodiť samotnú operáciu — radšej zapíšeme do logu.
            error_log('audit: ' . $e->getMessage());
        }
    }

    /**
     * Zmena hodnoty s pôvodným aj novým stavom — „8,90 → 9,90“.
     * Presne toto sa pri spätnom dohľadávaní hľadá najčastejšie.
     */
    public static function change(
        ?array $user,
        string $entity,
        string $entityId,
        string $what,
        string $from,
        string $to
    ): void {
        if ($from === $to) {
            return;
        }
        self::record($user, 'update', $entity, $entityId, "$what: $from → $to");
    }

    /** @return list<array<string,mixed>> */
    public static function recent(int $limit = 100, int $offset = 0): array
    {
        if (!Db::tableExists('audit_log')) {
            return [];
        }
        return Db::all(
            'SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
            [max(1, min(500, $limit)), max(0, $offset)]
        );
    }

    public static function count(): int
    {
        if (!Db::tableExists('audit_log')) {
            return 0;
        }
        return (int) (Db::value('SELECT COUNT(*) FROM audit_log') ?? 0);
    }

    /** Ako sa akcia volá po slovensky. */
    public static function label(string $action): string
    {
        return match ($action) {
            'create'      => 'vytvorenie',
            'update'      => 'zmena',
            'delete'      => 'zmazanie',
            'deactivate'  => 'vypnutie',
            'login'       => 'prihlásenie',
            'login_failed'=> 'neúspešné prihlásenie',
            'logout'      => 'odhlásenie',
            'status'      => 'zmena stavu',
            'export'      => 'export',
            default       => $action,
        };
    }
}
