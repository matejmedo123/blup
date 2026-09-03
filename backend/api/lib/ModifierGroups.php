<?php
declare(strict_types=1);

/**
 * Skupiny doplnkov — varianty s pravidlami.
 *
 * Plochý zoznam doplnkov („pridaj syr“) nestačí na veci ako veľkosť
 * pizze, kde si zákazník musí vybrať práve jednu možnosť. Skupina preto
 * vie povedať:
 *  - `is_required` … bez výberu sa nedá objednať (veľkosť),
 *  - `min_select`  … najmenej toľko možností,
 *  - `max_select`  … najviac toľko (0 = koľko chce).
 *
 * Doplnok môže patriť do skupiny aj byť voľne priradený k produktu —
 * skupina je len pravidlo navrchu, ceny zostávajú v `extras`.
 *
 * Pravidlá kontroluje server pri každej objednávke. To, že ich frontend
 * ukázal, nič neznamená.
 */
final class ModifierGroups
{
    /**
     * Skupiny pre zoznam produktov naraz — bez dotazu na každý produkt.
     *
     * @param list<int> $productIds
     * @return array<int, list<array<string,mixed>>>
     */
    public static function forProducts(array $productIds): array
    {
        if ($productIds === [] || !Db::tableExists('modifier_groups')) {
            return [];
        }
        $in   = implode(',', array_fill(0, count($productIds), '?'));
        $rows = Db::all(
            "SELECT pmg.product_id, g.id, g.slug, g.name, g.hint, g.is_required,
                    g.min_select, g.max_select, pmg.position
             FROM product_modifier_groups pmg
             JOIN modifier_groups g ON g.id = pmg.group_id
             WHERE pmg.product_id IN ($in) AND g.is_active = 1
             ORDER BY pmg.position, g.position, g.id",
            $productIds
        );
        if ($rows === []) {
            return [];
        }

        $groupIds = array_values(array_unique(array_map(
            static fn (array $r): int => (int) $r['id'],
            $rows
        )));
        $options = self::optionsFor($groupIds);

        $out = [];
        foreach ($rows as $r) {
            $gid = (int) $r['id'];
            $out[(int) $r['product_id']][] = [
                'id'        => (string) $r['slug'],
                'name'      => (string) $r['name'],
                'hint'      => (string) ($r['hint'] ?? ''),
                'required'  => (int) $r['is_required'] === 1,
                'minSelect' => (int) $r['min_select'],
                'maxSelect' => (int) $r['max_select'],
                'options'   => $options[$gid] ?? [],
            ];
        }
        return $out;
    }

    /**
     * Overí výber doplnkov proti pravidlám skupín produktu.
     *
     * @param list<string> $chosenSlugs slugy doplnkov, ktoré si zákazník vybral
     * @throws OrderException keď výber pravidlám nevyhovuje
     */
    public static function validateSelection(int $productId, string $productName, array $chosenSlugs): void
    {
        $groups = self::forProducts([$productId])[$productId] ?? [];
        if ($groups === []) {
            return;
        }

        $chosen = array_flip($chosenSlugs);

        foreach ($groups as $group) {
            $inGroup = 0;
            foreach ($group['options'] as $option) {
                if (isset($chosen[$option['id']])) {
                    $inGroup++;
                }
            }

            $min = $group['required'] ? max(1, $group['minSelect']) : $group['minSelect'];
            $max = $group['maxSelect'];

            if ($min > 0 && $inGroup < $min) {
                throw new OrderException(
                    ErrorCode::INVALID_MODIFIER,
                    $min === 1
                        ? sprintf('Pri položke „%s“ si vyber %s.', $productName, mb_strtolower($group['name']))
                        : sprintf('Pri položke „%s“ vyber aspoň %d možnosti v skupine %s.', $productName, $min, $group['name'])
                );
            }
            if ($max > 0 && $inGroup > $max) {
                throw new OrderException(
                    ErrorCode::INVALID_MODIFIER,
                    $max === 1
                        ? sprintf('Pri položke „%s“ sa dá vybrať len jedna možnosť v skupine %s.', $productName, $group['name'])
                        : sprintf('Pri položke „%s“ sa dá vybrať najviac %d možností v skupine %s.', $productName, $max, $group['name'])
                );
            }
        }
    }

    /** @return list<array<string,mixed>> */
    public static function all(): array
    {
        if (!Db::tableExists('modifier_groups')) {
            return [];
        }
        $groups = Db::all('SELECT * FROM modifier_groups ORDER BY position, id');
        $ids    = array_map(static fn (array $g): int => (int) $g['id'], $groups);
        $opts   = self::optionsFor($ids);

        foreach ($groups as &$g) {
            $g['options'] = $opts[(int) $g['id']] ?? [];
        }
        return $groups;
    }

    /* ------------------------------------------------------------------ */

    /**
     * Doplnky v skupinách. Väzba ide cez `extras.group_id`, ktorý sa
     * dopĺňa migráciou — doplnok bez skupiny funguje ako doteraz.
     *
     * @param list<int> $groupIds
     * @return array<int, list<array<string,mixed>>>
     */
    private static function optionsFor(array $groupIds): array
    {
        if ($groupIds === [] || !Db::columnExists('extras', 'group_id')) {
            return [];
        }
        $in   = implode(',', array_fill(0, count($groupIds), '?'));
        $rows = Db::all(
            "SELECT id, group_id, slug, name, price_cents
             FROM extras
             WHERE group_id IN ($in) AND is_active = 1
             ORDER BY position, id",
            $groupIds
        );

        $out = [];
        foreach ($rows as $r) {
            $out[(int) $r['group_id']][] = [
                'id'    => (string) $r['slug'],
                'name'  => (string) $r['name'],
                'price' => Money::toFloat((int) $r['price_cents']),
            ];
        }
        return $out;
    }
}
