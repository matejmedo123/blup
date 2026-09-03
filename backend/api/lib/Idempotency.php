<?php
declare(strict_types=1);

/**
 * Idempotencia vytvorenia objednávky.
 *
 * Zákazník na mobile klikne „Objednať“, spojenie sa zasekne, on klikne
 * znova — a prevádzke pristanú dve rovnaké objednávky. Tomu bránime
 * kľúčom, ktorý si prehliadač vygeneruje pred prvým odoslaním a pri
 * opakovaní pošle ten istý.
 *
 * Postup:
 *  1. `begin()` sa pokúsi kľúč vložiť. Unikátny index v databáze
 *     rozhodne, kto bol prvý — nie kontrola v PHP, ktorú by dva súbežné
 *     procesy prešli obidva.
 *  2. Keď vloženie prejde, požiadavka je nová a spracuje sa.
 *  3. Keď neprejde, kľúč už existuje:
 *     - rovnaké telo a hotová objednávka → vrátime pôvodnú odpoveď,
 *     - rovnaké telo a ešte sa spracúva → povieme, nech chvíľu počká,
 *     - iné telo → kľúč sa recykluje na niečo iné, to je chyba klienta.
 */
final class Idempotency
{
    /** Ako dlho si kľúče pamätáme (hodiny). */
    private const TTL_HOURS = 24;

    public const NEW_REQUEST = 'new';
    public const REPLAY      = 'replay';
    public const IN_FLIGHT   = 'in_flight';
    public const CONFLICT    = 'conflict';

    /**
     * @param array<string,mixed> $payload telo požiadavky
     * @return array{state:string, response?:array<string,mixed>, orderId?:int}
     */
    public static function begin(string $key, array $payload, string $scope = 'order'): array
    {
        $key = self::normalize($key);
        if ($key === '') {
            // Bez kľúča ochranu ponúknuť nevieme — staršieho klienta
            // ale nechceme zablokovať, tak požiadavku pustíme ďalej.
            return ['state' => self::NEW_REQUEST];
        }

        self::purgeOld();
        $hash = self::hash($payload);

        try {
            Db::insert('idempotency_keys', [
                'idem_key'     => $key,
                'scope'        => $scope,
                'request_hash' => $hash,
                'order_id'     => null,
                'response'     => null,
                'created_at'   => date('Y-m-d H:i:s'),
            ]);
            return ['state' => self::NEW_REQUEST];
        } catch (Throwable) {
            // Kľúč tam už je — pozrime sa, čo s ním.
        }

        $row = Db::one('SELECT * FROM idempotency_keys WHERE idem_key = ?', [$key]);
        if ($row === null) {
            // Medzitým vypršal; ber to ako novú požiadavku.
            return ['state' => self::NEW_REQUEST];
        }

        if ((string) $row['request_hash'] !== $hash) {
            return ['state' => self::CONFLICT];
        }

        if (!empty($row['response'])) {
            $decoded = json_decode((string) $row['response'], true);
            if (is_array($decoded)) {
                return [
                    'state'    => self::REPLAY,
                    'response' => $decoded,
                    'orderId'  => (int) $row['order_id'],
                ];
            }
        }

        return ['state' => self::IN_FLIGHT];
    }

    /** Zapamätá si odpoveď, aby sa dala pri opakovaní vrátiť. */
    public static function complete(string $key, int $orderId, array $response): void
    {
        $key = self::normalize($key);
        if ($key === '') {
            return;
        }
        Db::update(
            'idempotency_keys',
            ['order_id' => $orderId, 'response' => json_encode($response, JSON_UNESCAPED_UNICODE)],
            'idem_key = :k',
            ['k' => $key]
        );
    }

    /**
     * Uvoľní kľúč po neúspechu, nech zákazník po oprave údajov
     * nenaráža na „už spracúvame“.
     */
    public static function release(string $key): void
    {
        $key = self::normalize($key);
        if ($key === '') {
            return;
        }
        Db::run('DELETE FROM idempotency_keys WHERE idem_key = ? AND order_id IS NULL', [$key]);
    }

    /** Kľúč z hlavičky alebo z tela požiadavky. */
    public static function keyFromRequest(array $body): string
    {
        $header = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? $_SERVER['HTTP_X_IDEMPOTENCY_KEY'] ?? '';
        return self::normalize((string) ($header !== '' ? $header : ($body['idempotencyKey'] ?? '')));
    }

    /* ------------------------------------------------------------------ */

    private static function normalize(string $key): string
    {
        $key = trim($key);
        // Cudzí vstup ide do unikátneho indexu — držme ho v bezpečnej abecede.
        if ($key === '' || !preg_match('/^[A-Za-z0-9._:-]{8,120}$/', $key)) {
            return '';
        }
        return $key;
    }

    /**
     * Odtlačok požiadavky. Zaujíma nás, čo si zákazník objednal a kam —
     * poradie kľúčov v JSON-e ani drobnosti okolo nie.
     *
     * @param array<string,mixed> $payload
     */
    private static function hash(array $payload): string
    {
        $canonical = [
            'orderType'     => (string) ($payload['orderType'] ?? ''),
            'paymentMethod' => (string) ($payload['paymentMethod'] ?? ''),
            'coupon'        => mb_strtoupper(trim((string) ($payload['coupon'] ?? ''))),
            'customer'      => self::sortDeep((array) ($payload['customer'] ?? [])),
            'items'         => array_map(
                static function ($i): array {
                    $i = (array) $i;
                    $extras = array_map(
                        static fn($e): string => (string) (is_array($e) ? ($e['id'] ?? '') : $e),
                        (array) ($i['extras'] ?? [])
                    );
                    sort($extras);
                    return [
                        'productId' => (string) ($i['productId'] ?? ''),
                        'quantity'  => (int) ($i['quantity'] ?? 0),
                        'note'      => (string) ($i['note'] ?? ''),
                        'extras'    => $extras,
                    ];
                },
                (array) ($payload['items'] ?? [])
            ),
        ];

        return hash('sha256', json_encode($canonical, JSON_UNESCAPED_UNICODE) ?: '');
    }

    /** @param array<string,mixed> $a @return array<string,mixed> */
    private static function sortDeep(array $a): array
    {
        ksort($a);
        foreach ($a as $k => $v) {
            if (is_array($v)) {
                $a[$k] = self::sortDeep($v);
            }
        }
        return $a;
    }

    private static function purgeOld(): void
    {
        try {
            Db::run(
                'DELETE FROM idempotency_keys WHERE created_at < ?',
                [date('Y-m-d H:i:s', time() - self::TTL_HOURS * 3600)]
            );
        } catch (Throwable $e) {
            error_log('idempotency purge: ' . $e->getMessage());
        }
    }
}
