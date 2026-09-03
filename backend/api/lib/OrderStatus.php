<?php
declare(strict_types=1);

/**
 * Stavy objednávky a povolené prechody medzi nimi.
 *
 * Toto je jediné miesto, kde je napísané, čo po čom môže nasledovať.
 * Server prechod, ktorý tu nie je uvedený, odmietne — nech ho vyvolá
 * ktokoľvek, cez admin alebo cez API.
 *
 *                     ┌─→ rejected (koncový)
 *  received ─→ accepted ─→ preparing ─→ ready ─┬─→ delivering ─→ completed
 *      │           │           │          │    └─→ picked_up  ─→ completed
 *      └───────────┴───────────┴──────────┴─→ cancelled (koncový)
 */
final class OrderStatus
{
    public const RECEIVED   = 'received';
    public const ACCEPTED   = 'accepted';
    public const PREPARING  = 'preparing';
    public const READY      = 'ready';
    public const DELIVERING = 'delivering';
    public const PICKED_UP  = 'picked_up';
    public const COMPLETED  = 'completed';
    public const REJECTED   = 'rejected';
    public const CANCELLED  = 'cancelled';

    /** Z ktorého stavu sa dá kam. @var array<string,list<string>> */
    public const TRANSITIONS = [
        self::RECEIVED   => [self::ACCEPTED, self::REJECTED, self::CANCELLED],
        self::ACCEPTED   => [self::PREPARING, self::READY, self::CANCELLED],
        self::PREPARING  => [self::READY, self::CANCELLED],
        self::READY      => [self::DELIVERING, self::PICKED_UP, self::COMPLETED, self::CANCELLED],
        self::DELIVERING => [self::COMPLETED, self::CANCELLED],
        self::PICKED_UP  => [self::COMPLETED],
        self::COMPLETED  => [],
        self::REJECTED   => [],
        self::CANCELLED  => [],
    ];

    /** Stavy, ktoré dávajú zmysel len pri danom type objednávky. */
    private const ONLY_FOR_TYPE = [
        self::DELIVERING => 'delivery',
        self::PICKED_UP  => 'pickup',
    ];

    /** Stavy, z ktorých už niet cesty von. */
    public const TERMINAL = [self::COMPLETED, self::REJECTED, self::CANCELLED];

    /** Ako sa stav volá pre zákazníka. */
    public const LABEL = [
        self::RECEIVED   => 'Prijatá',
        self::ACCEPTED   => 'Potvrdená',
        self::PREPARING  => 'Pripravujeme',
        self::READY      => 'Pripravená',
        self::DELIVERING => 'Na ceste',
        self::PICKED_UP  => 'Vyzdvihnutá',
        self::COMPLETED  => 'Vybavená',
        self::REJECTED   => 'Odmietnutá',
        self::CANCELLED  => 'Zrušená',
    ];

    public static function isValid(string $status): bool
    {
        return isset(self::TRANSITIONS[$status]);
    }

    public static function isTerminal(string $status): bool
    {
        return in_array($status, self::TERMINAL, true);
    }

    /** Je prechod povolený pre daný typ objednávky? */
    public static function canTransition(string $from, string $to, ?string $orderType = null): bool
    {
        if (!self::isValid($from) || !self::isValid($to)) {
            return false;
        }
        if (!in_array($to, self::TRANSITIONS[$from], true)) {
            return false;
        }
        $requiredType = self::ONLY_FOR_TYPE[$to] ?? null;
        return $requiredType === null || $orderType === null || $orderType === $requiredType;
    }

    /** Čo sa dá s objednávkou v danom stave spraviť ďalej. @return list<string> */
    public static function nextStates(string $from, ?string $orderType = null): array
    {
        if (!self::isValid($from)) {
            return [];
        }
        return array_values(array_filter(
            self::TRANSITIONS[$from],
            static fn(string $to): bool => self::canTransition($from, $to, $orderType)
        ));
    }

    /**
     * Zrozumiteľné vysvetlenie, prečo prechod neprešiel — ide priamo
     * obsluhe na obrazovku, takže po slovensky a bez technického žargónu.
     */
    public static function explainRefusal(string $from, string $to, ?string $orderType = null): string
    {
        if (!self::isValid($to)) {
            return 'Neznámy stav objednávky.';
        }
        if (self::isTerminal($from)) {
            return sprintf(
                'Objednávka je už %s — jej stav sa nedá ďalej meniť.',
                mb_strtolower(self::LABEL[$from])
            );
        }
        $requiredType = self::ONLY_FOR_TYPE[$to] ?? null;
        if ($requiredType !== null && $orderType !== null && $orderType !== $requiredType) {
            return $requiredType === 'delivery'
                ? 'Tento stav je len pre objednávky na rozvoz.'
                : 'Tento stav je len pre objednávky na osobný odber.';
        }
        return sprintf(
            'Z „%s“ sa nedá prejsť rovno na „%s“.',
            self::LABEL[$from],
            self::LABEL[$to]
        );
    }
}
