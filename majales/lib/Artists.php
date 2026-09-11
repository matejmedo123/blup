<?php
declare(strict_types=1);

/** Interpreti v lineupe. Jeden z nich môže byť headliner. */
final class Artists extends Repo
{
    public static function table(): string
    {
        return 'artists';
    }

    public static function fillable(): array
    {
        return [
            'slug', 'name', 'tag', 'bio', 'media_id', 'is_headliner', 'badge',
            'url_facebook', 'url_instagram', 'url_spotify', 'url_youtube',
        ];
    }

    public static function orderBy(): string
    {
        return 'is_headliner DESC, sort_order, id';
    }

    /** @return array<string,mixed>|null interpret v hlavnom pruhu */
    public static function headliner(): ?array
    {
        return Db::one('SELECT * FROM artists WHERE active = 1 AND is_headliner = 1 ORDER BY sort_order, id');
    }

    /** @return list<array<string,mixed>> ostatní interpreti do mriežky */
    public static function grid(): array
    {
        return Db::all('SELECT * FROM artists WHERE active = 1 AND is_headliner = 0 ORDER BY sort_order, id');
    }

    /**
     * Headliner je na stránke len jeden — keď sa označí nový,
     * predchádzajúci sa automaticky odznačí.
     */
    public static function setHeadliner(int $id): void
    {
        Db::transaction(static function () use ($id): void {
            Db::run('UPDATE artists SET is_headliner = 0 WHERE is_headliner = 1 AND id <> ?', [$id]);
            Db::run('UPDATE artists SET is_headliner = 1, updated_at = ? WHERE id = ?', [Clock::now(), $id]);
        });
        Settings::bumpContentVersion();
    }

    /**
     * Adresa sa odvodí z mena, keď ju volajúci nedodá. Bez nej by sa
     * interpret nedal uložiť a invariant patrí sem, nie do formulára.
     *
     * @param array<string,mixed> $data
     */
    public static function create(array $data): int
    {
        if (trim((string) ($data['slug'] ?? '')) === '') {
            $data['slug'] = self::uniqueSlug((string) ($data['name'] ?? ''));
        }
        return parent::create($data);
    }

    /**
     * Pri úprave sa prázdna adresa nezapisuje — inak by sa pri uložení
     * jediného políčka stratila adresa, na ktorú už môžu viesť odkazy.
     *
     * @param array<string,mixed> $data
     */
    public static function save(int $id, array $data): void
    {
        if (array_key_exists('slug', $data) && trim((string) $data['slug']) === '') {
            unset($data['slug']);
        }
        parent::save($id, $data);
    }

    /** Adresa musí byť jedinečná — pri zhode sa pridá číslo. */
    public static function uniqueSlug(string $base, ?int $exceptId = null): string
    {
        $slug = Validate::slug($base);
        $try  = $slug;
        $i    = 2;
        while (true) {
            $row = $exceptId === null
                ? Db::one('SELECT id FROM artists WHERE slug = ?', [$try])
                : Db::one('SELECT id FROM artists WHERE slug = ? AND id <> ?', [$try, $exceptId]);
            if ($row === null) {
                return $try;
            }
            $try = $slug . '-' . $i++;
        }
    }

    /** @param array<string,mixed> $artist @return list<array{0:string,1:string}> */
    public static function socials(array $artist): array
    {
        $out = [];
        foreach (['facebook', 'instagram', 'spotify', 'youtube'] as $net) {
            $url = Html::safeUrl((string) ($artist['url_' . $net] ?? ''));
            if ($url !== '') {
                $out[] = [$net, $url];
            }
        }
        return $out;
    }
}
