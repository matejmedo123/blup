<?php
declare(strict_types=1);

/**
 * Spoločný základ pre zoznamy, ktoré sa v admine spravujú rovnako:
 * pridať, upraviť, zapnúť/vypnúť, posunúť v poradí, zmazať.
 * Konkrétne tabuľky sa líšia len stĺpcami, nie správaním.
 */
abstract class Repo
{
    /** Názov tabuľky. */
    abstract public static function table(): string;

    /** Stĺpce, ktoré smie formulár nastaviť. */
    abstract public static function fillable(): array;

    /** Ako sa zoznam radí na webe aj v admine. */
    public static function orderBy(): string
    {
        return 'sort_order, id';
    }

    /** @return list<array<string,mixed>> položky pre verejný web */
    public static function published(): array
    {
        return Db::all(sprintf(
            'SELECT * FROM %s WHERE active = 1 ORDER BY %s',
            static::table(),
            static::orderBy()
        ));
    }

    /** @return list<array<string,mixed>> položky pre admin, aj vypnuté */
    public static function listAll(): array
    {
        return Db::all(sprintf('SELECT * FROM %s ORDER BY %s', static::table(), static::orderBy()));
    }

    /** @return array<string,mixed>|null */
    public static function find(int $id): ?array
    {
        return Db::one(sprintf('SELECT * FROM %s WHERE id = ?', static::table()), [$id]);
    }

    public static function count(bool $onlyActive = false): int
    {
        $sql = sprintf('SELECT COUNT(*) FROM %s', static::table());
        if ($onlyActive) {
            $sql .= ' WHERE active = 1';
        }
        return (int) Db::value($sql);
    }

    /** @param array<string,mixed> $data */
    public static function create(array $data): int
    {
        $row = self::onlyFillable($data);
        $row['sort_order'] = $row['sort_order'] ?? self::nextSort();
        $row['active']     = $row['active'] ?? 1;
        $row['created_at'] = Clock::now();
        $row['updated_at'] = Clock::now();
        $id = Db::insert(static::table(), $row);
        Settings::bumpContentVersion();
        return $id;
    }

    /** @param array<string,mixed> $data */
    public static function save(int $id, array $data): void
    {
        $row = self::onlyFillable($data);
        $row['updated_at'] = Clock::now();
        Db::update(static::table(), $id, $row);
        Settings::bumpContentVersion();
    }

    public static function setActive(int $id, bool $active): void
    {
        Db::update(static::table(), $id, ['active' => $active ? 1 : 0, 'updated_at' => Clock::now()]);
        Settings::bumpContentVersion();
    }

    public static function remove(int $id): void
    {
        Db::delete(static::table(), $id);
        Settings::bumpContentVersion();
    }

    /**
     * Posunie položku o jedno miesto hore alebo dole. Poradie sa vymení
     * so susedom, aby čísla ostali husté a bez dier.
     */
    public static function move(int $id, string $direction): void
    {
        $table = static::table();
        Db::transaction(static function () use ($table, $id, $direction): void {
            $rows = Db::all(sprintf('SELECT id FROM %s ORDER BY %s', $table, static::orderBy()));
            $ids  = array_map(static fn (array $r): int => (int) $r['id'], $rows);
            $pos  = array_search($id, $ids, true);
            if ($pos === false) {
                return;
            }
            $target = $direction === 'up' ? $pos - 1 : $pos + 1;
            if ($target < 0 || $target >= count($ids)) {
                return;
            }
            [$ids[$pos], $ids[$target]] = [$ids[$target], $ids[$pos]];
            foreach ($ids as $i => $rid) {
                Db::run(sprintf('UPDATE %s SET sort_order = ? WHERE id = ?', $table), [$i + 1, $rid]);
            }
        });
        Settings::bumpContentVersion();
    }

    protected static function nextSort(): int
    {
        $max = Db::value(sprintf('SELECT MAX(sort_order) FROM %s', static::table()));
        return ((int) $max) + 1;
    }

    /**
     * Prepustí len stĺpce, ktoré trieda označila za meniteľné. Vďaka
     * tomu sa cez formulár nedá prepísať napríklad `id` ani `created_at`.
     *
     * @param array<string,mixed> $data
     * @return array<string,mixed>
     */
    protected static function onlyFillable(array $data): array
    {
        $allowed = array_flip(array_merge(static::fillable(), ['sort_order', 'active']));
        return array_intersect_key($data, $allowed);
    }
}
