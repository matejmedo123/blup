<?php
declare(strict_types=1);

/** Načítanie menu z databázy do tvaru, ktorému rozumie frontend. */
final class MenuRepo
{
    /** @return array{categories:list<array<string,mixed>>, products:list<array<string,mixed>>, version:string} */
    public static function publicMenu(): array
    {
        $categories = [];
        foreach (Db::all('SELECT * FROM categories WHERE is_active = 1 ORDER BY position, id') as $c) {
            $categories[] = [
                'id'      => $c['slug'],
                'label'   => $c['label'],
                'title'   => $c['title'],
                'caption' => $c['caption'] ?? '',
            ];
        }

        // doplnky pre všetky produkty naraz — bez N+1 dotazov
        $extrasByProduct = [];
        foreach (Db::all(
            'SELECT pe.product_id, e.slug, e.name, e.price_cents
             FROM product_extras pe
             JOIN extras e ON e.id = pe.extra_id
             WHERE e.is_active = 1
             ORDER BY pe.position, e.id'
        ) as $row) {
            $extrasByProduct[(int) $row['product_id']][] = [
                'id'    => $row['slug'],
                'name'  => $row['name'],
                'price' => Money::toFloat((int) $row['price_cents']),
            ];
        }

        $products = [];
        foreach (Db::all(
            'SELECT p.*, c.slug AS category_slug
             FROM products p
             JOIN categories c ON c.id = p.category_id
             WHERE c.is_active = 1
             ORDER BY p.position, p.id'
        ) as $p) {
            $item = [
                'id'          => $p['slug'],
                'name'        => $p['name'],
                'description' => (string) ($p['description'] ?? ''),
                'price'       => Money::toFloat((int) $p['price_cents']),
                'category'    => $p['category_slug'],
                'available'   => (int) $p['is_available'] === 1,
            ];
            if (!empty($p['image'])) {
                $item['image']    = $p['image'];
                $item['imageAlt'] = $p['image_alt'] ?? $p['name'];
            }
            if (!empty($p['badge'])) {
                $item['badge'] = $p['badge'];
            }
            if (!empty($p['tags'])) {
                $item['tags'] = array_values(array_filter(explode('|', (string) $p['tags'])));
            }
            if (!empty($p['lid_accent'])) {
                $item['lid'] = [
                    'accent' => $p['lid_accent'],
                    'lines'  => [(string) ($p['lid_line1'] ?? ''), (string) ($p['lid_line2'] ?? '')],
                ];
            }
            $extras = $extrasByProduct[(int) $p['id']] ?? [];
            if ($extras !== []) {
                $item['extras'] = $extras;
            }
            $products[] = $item;
        }

        return [
            'categories' => $categories,
            'products'   => $products,
            'version'    => self::version(),
        ];
    }

    /** Zmení sa pri každej úprave menu — frontend podľa nej vie, či má dáta obnoviť. */
    public static function version(): string
    {
        $stamp = (string) (Db::value('SELECT MAX(updated_at) FROM products') ?? '');
        $count = (string) (Db::value('SELECT COUNT(*) FROM products') ?? '0');
        return substr(md5($stamp . '|' . $count), 0, 12);
    }
}
