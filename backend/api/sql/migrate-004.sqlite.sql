-- ENZO — migrácia 004 (SQLite)
-- Prevádzka prestala robiť pizzu. Kategóriu ani položky nemažeme:
-- mohli byť v už vybavených objednávkach a doklad sa nesmie rozpadnúť.
-- Stačí ich skryť — z webu aj z pokladne zmiznú.

UPDATE products
   SET is_available = 0
 WHERE category_id IN (SELECT id FROM categories WHERE slug = 'pizza');

UPDATE categories SET is_active = 0 WHERE slug = 'pizza';
