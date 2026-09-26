-- ============================================================================
-- Riziko predajcu spadlo vždy, keď malo naozaj niečo povedať
-- ============================================================================
-- `reasons := reasons || 'vysoký podiel sporov'` vyzerá ako pripojenie prvku
-- k poľu. Postgres to ale rieši ako `anyarray || anyarray`, teda skúsi ten
-- text preložiť na pole textov — a spadne na „malformed array literal".
--
-- Zákerné je na tom to, KEDY sa to prejaví. Kým je predajca čistý, žiadny
-- dôvod sa nepripája a funkcia beží. Spadne až pri prvom človeku, ktorý má
-- spor — čiže presne vtedy, keď ju niekto potrebuje. A keďže ju volá
-- `swap_admin_disputes`, spadla by celá obrazovka sporov v momente, keď je
-- na nej čo riešiť.
--
-- `array_append` je tá istá operácia bez dvojznačnosti. Odhalil to test_58,
-- ktorý prejde celý spor od otvorenia po rozhodnutie.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.resale_seller_risk(p_seller uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  disputes_total integer;
  disputes_lost  integer;
  sales_total    integer;
  external_share numeric;
  account_age    interval;
  level          text := 'low';
  reasons        text[] := '{}';
begin
  select count(*) into sales_total
  from public.resale_orders where seller_id = p_seller and payment_status = 'succeeded';

  select count(*) into disputes_total
  from public.resale_disputes d
  join public.resale_orders o on o.id = d.resale_order_id
  where o.seller_id = p_seller;

  select count(*) into disputes_lost
  from public.resale_disputes d
  join public.resale_orders o on o.id = d.resale_order_id
  where o.seller_id = p_seller and d.status = 'resolved' and d.resolution = 'refunded';

  select coalesce(
    count(*) filter (where source = 'external')::numeric / nullif(count(*), 0), 0)
  into external_share
  from public.resale_orders where seller_id = p_seller and payment_status = 'succeeded';

  select now() - created_at into account_age from public.profiles where id = p_seller;

  if disputes_lost >= 2 then
    level := 'high';
    reasons := array_append(reasons, 'dva a viac prehratých sporov');
  elsif disputes_total > 0 and sales_total > 0
        and disputes_total::numeric / sales_total > 0.25 then
    level := 'high';
    reasons := array_append(reasons, 'vysoký podiel sporov');
  elsif disputes_total > 0 then
    level := 'medium';
    reasons := array_append(reasons, 'má za sebou spor');
  end if;

  -- Nový účet, ktorý rovno predáva vstupenky, ktorých pravosť nevieme overiť,
  -- je presne ten tvar, ktorý stojí za pozretie.
  if level <> 'high' and account_age < interval '7 days' and external_share > 0.5
     and sales_total >= 3 then
    level := 'medium';
    reasons := array_append(reasons, 'nový účet a samé externé vstupenky');
  end if;

  if exists (select 1 from public.profiles where id = p_seller and is_suspended) then
    level := 'high';
    reasons := array_append(reasons, 'zablokovaný účet');
  end if;

  return jsonb_build_object(
    'seller_id', p_seller,
    'level', level,
    'reasons', to_jsonb(reasons),
    'sales', sales_total,
    'disputes', disputes_total,
    'disputes_lost', disputes_lost
  );
end;
$$;

revoke execute on function public.resale_seller_risk(uuid) from public;
grant execute on function public.resale_seller_risk(uuid) to authenticated;
