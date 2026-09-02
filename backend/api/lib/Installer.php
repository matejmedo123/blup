<?php
declare(strict_types=1);

/**
 * Vytvorenie tabuliek a naplnenie menu z dodaného balíka.
 * Spúšťa sa raz cez install.php, potom sa install.php zmaže.
 */
final class Installer
{
    public static function isInstalled(): bool
    {
        return Db::tableExists('users') && (int) (Db::value('SELECT COUNT(*) FROM users') ?? 0) > 0;
    }

    public static function migrate(): void
    {
        $file = __DIR__ . '/../sql/schema.' . (Db::driver() === 'sqlite' ? 'sqlite' : 'mysql') . '.sql';
        Db::runSqlFile($file);
    }

    /** Naplní nastavenia predvolenými hodnotami (existujúce neprepíše). */
    public static function seedSettings(): void
    {
        foreach (Settings::DEFAULTS as $key => $value) {
            $exists = Db::value('SELECT 1 FROM settings WHERE `key` = ?', [$key]);
            if (!$exists) {
                Db::run(
                    'INSERT INTO settings (`key`, `value`, updated_at) VALUES (?, ?, ?)',
                    [$key, (string) $value, date('Y-m-d H:i:s')]
                );
            }
        }
    }

    /**
     * Naplní menu z JSON súboru vygenerovaného z frontendu.
     * @return array{categories:int, products:int, extras:int}
     */
    public static function seedMenu(?string $jsonPath = null): array
    {
        $jsonPath ??= __DIR__ . '/../sql/menu-seed.json';
        $raw = file_get_contents($jsonPath);
        if ($raw === false) {
            throw new RuntimeException('Nenašiel som menu-seed.json');
        }
        /** @var array{categories:list<array<string,mixed>>, products:list<array<string,mixed>>} $data */
        $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        $now  = date('Y-m-d H:i:s');

        $catIds   = [];
        $extraIds = [];
        $counts   = ['categories' => 0, 'products' => 0, 'extras' => 0];

        Db::transaction(static function () use ($data, $now, &$catIds, &$extraIds, &$counts): void {
            /* ---- kategórie ---- */
            foreach ($data['categories'] as $c) {
                $id = Db::value('SELECT id FROM categories WHERE slug = ?', [$c['id']]);
                if ($id === null) {
                    $id = Db::insert('categories', [
                        'slug'      => $c['id'],
                        'label'     => $c['label'],
                        'title'     => $c['title'],
                        'caption'   => $c['caption'] ?? null,
                        'position'  => (int) ($c['position'] ?? 0),
                        'is_active' => 1,
                    ]);
                    $counts['categories']++;
                }
                $catIds[$c['id']] = (int) $id;
            }

            /* ---- doplnky (unikátne naprieč produktmi) ---- */
            $allExtras = [];
            foreach ($data['products'] as $p) {
                foreach ($p['extras'] ?? [] as $e) {
                    $allExtras[$e['id']] = $e;
                }
            }
            $pos = 0;
            foreach ($allExtras as $slug => $e) {
                $id = Db::value('SELECT id FROM extras WHERE slug = ?', [$slug]);
                if ($id === null) {
                    $id = Db::insert('extras', [
                        'slug'        => $slug,
                        'name'        => $e['name'],
                        'price_cents' => Money::fromFloat($e['price']),
                        'is_active'   => 1,
                        'position'    => $pos++,
                    ]);
                    $counts['extras']++;
                }
                $extraIds[$slug] = (int) $id;
            }

            /* ---- produkty ---- */
            foreach ($data['products'] as $p) {
                $existing = Db::value('SELECT id FROM products WHERE slug = ?', [$p['id']]);
                if ($existing !== null) {
                    continue;
                }
                $lid = $p['lid'] ?? null;
                $productId = Db::insert('products', [
                    'slug'         => $p['id'],
                    'category_id'  => $catIds[$p['category']],
                    'name'         => $p['name'],
                    'description'  => $p['description'] ?? null,
                    'price_cents'  => Money::fromFloat($p['price']),
                    'image'        => $p['image'] ?? null,
                    'image_alt'    => $p['imageAlt'] ?? null,
                    'badge'        => $p['badge'] ?? null,
                    'tags'         => isset($p['tags']) ? implode('|', $p['tags']) : null,
                    'lid_accent'   => $lid['accent'] ?? null,
                    'lid_line1'    => $lid['lines'][0] ?? null,
                    'lid_line2'    => $lid['lines'][1] ?? null,
                    'vat_group'    => $p['category'] === 'drinks' ? 'drinks' : 'food',
                    'is_available' => 1,
                    'position'     => (int) ($p['position'] ?? 0),
                    'created_at'   => $now,
                    'updated_at'   => $now,
                ]);
                $counts['products']++;

                $i = 0;
                foreach ($p['extras'] ?? [] as $e) {
                    Db::insert('product_extras', [
                        'product_id' => $productId,
                        'extra_id'   => $extraIds[$e['id']],
                        'position'   => $i++,
                    ]);
                }
            }
        });

        return $counts;
    }

    /** @return array{ok:bool,error:?string} */
    public static function createUser(string $name, string $email, string $password, string $role = Auth::ROLE_ADMIN): array
    {
        $email = strtolower(trim($email));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return ['ok' => false, 'error' => 'Zadaj platný e-mail.'];
        }
        if (mb_strlen($password) < 10) {
            return ['ok' => false, 'error' => 'Heslo musí mať aspoň 10 znakov.'];
        }
        if (Db::value('SELECT 1 FROM users WHERE email = ?', [$email])) {
            return ['ok' => false, 'error' => 'Používateľ s týmto e-mailom už existuje.'];
        }
        Db::insert('users', [
            'name'          => Validate::clean($name, 120) ?: 'Správca',
            'email'         => $email,
            'password_hash' => Auth::hash($password),
            'role'          => $role === Auth::ROLE_ADMIN ? Auth::ROLE_ADMIN : Auth::ROLE_STAFF,
            'is_active'     => 1,
            'created_at'    => date('Y-m-d H:i:s'),
        ]);
        return ['ok' => true, 'error' => null];
    }
}
