-- ENZO — migrácia 003
-- Zjednotenie stavov so state machine: pôvodný „confirmed“ zodpovedá
-- prijatej objednávke s potvrdeným časom prípravy.

UPDATE orders SET status = 'accepted' WHERE status = 'confirmed';

-- Objednávkam z čias pred históriou stavov doplníme aspoň prvý záznam,
-- aby ich detail nevyzeral, že sa s nimi nikdy nič nedialo.
INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, actor, reason, created_at)
SELECT o.id, NULL, 'received', NULL, 'system', 'Doplnené pri aktualizácii', o.created_at
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id);
