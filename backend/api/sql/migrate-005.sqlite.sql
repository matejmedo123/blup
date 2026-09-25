-- ENZO — migrácia 005 (SQLite)
--
-- Pizza ide preč načisto, nie len skryť. Doklady tým neutrpia:
-- `order_items` má názov aj cenu odložené vo vlastných stĺpcoch a na
-- tabuľku `products` sa neviaže cudzím kľúčom, takže staré objednávky
-- ostávajú čitateľné aj bez položky v cenníku.

DELETE FROM products
 WHERE category_id IN (SELECT id FROM categories WHERE slug = 'pizza');

DELETE FROM categories WHERE slug = 'pizza';

-- Prevádzka dostala nové telefónne číslo. Prepíšeme len vtedy, keď tam
-- ešte stojí pôvodné — ručne zadané číslo nechávame na pokoji.
UPDATE settings
   SET value = '0918 637 602', updated_at = CURRENT_TIMESTAMP
 WHERE "key" = 'shop_phone' AND value = '0948 238 346';
