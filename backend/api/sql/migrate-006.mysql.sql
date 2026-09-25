-- ENZO — migrácia 006
--
-- Fotky sa menili pod tým istým názvom súboru, takže prehliadače, ktoré
-- ich už raz stiahli, ukazovali mesiac staré. Súbory majú nové názvy;
-- tu prepíšeme cesty v databáze. Meníme len tie, kde ešte stojí pôvodná
-- cesta — čo si prevádzka nahrala sama, nechávame na pokoji.

UPDATE products SET image = '/images/products/the-enzo-smash-2.webp' WHERE image = '/images/products/the-enzo-smash.webp';
UPDATE products SET image = '/images/products/junior-2.webp' WHERE image = '/images/products/junior.webp';
UPDATE products SET image = '/images/products/bacon-boy-2.webp' WHERE image = '/images/products/bacon-boy.webp';
UPDATE products SET image = '/images/products/double-cheeseburger-2.webp' WHERE image = '/images/products/double-cheeseburger.webp';
UPDATE products SET image = '/images/products/trippple-king-2.webp' WHERE image = '/images/products/trippple-king.webp';
UPDATE products SET image = '/images/products/crispy-chicken-burger-2.webp' WHERE image = '/images/products/crispy-chicken-burger.webp';
UPDATE products SET image = '/images/products/pulled-pork-burger-2.webp' WHERE image = '/images/products/pulled-pork-burger.webp';

UPDATE settings SET value = '/images/products/the-enzo-smash-2.webp' WHERE value = '/images/products/the-enzo-smash.webp';
UPDATE settings SET value = '/images/products/junior-2.webp' WHERE value = '/images/products/junior.webp';
UPDATE settings SET value = '/images/products/bacon-boy-2.webp' WHERE value = '/images/products/bacon-boy.webp';
UPDATE settings SET value = '/images/products/double-cheeseburger-2.webp' WHERE value = '/images/products/double-cheeseburger.webp';
UPDATE settings SET value = '/images/products/trippple-king-2.webp' WHERE value = '/images/products/trippple-king.webp';
UPDATE settings SET value = '/images/products/crispy-chicken-burger-2.webp' WHERE value = '/images/products/crispy-chicken-burger.webp';
UPDATE settings SET value = '/images/products/pulled-pork-burger-2.webp' WHERE value = '/images/products/pulled-pork-burger.webp';
UPDATE settings SET value = '/images/editorial/hero-burger-2.webp' WHERE value = '/images/editorial/hero-burger.webp';
UPDATE settings SET value = '/images/editorial/story-duo-2.webp' WHERE value = '/images/editorial/story-duo.webp';
UPDATE settings SET value = '/images/editorial/promo-combo-2.webp' WHERE value = '/images/editorial/promo-combo.webp';
