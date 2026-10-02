-- ============================================================================
-- Meranie zo servera: čo si k objednávke odložiť, aby sa dal nákup nahlásiť
-- ============================================================================
-- Pixel v prehliadači stráca značnú časť nákupov — blokovače, iOS, zatvorená
-- karta skôr, než sa udalosť stihla odoslať. Meta Conversions API to rieši
-- tak, že ten istý nákup nahlási aj server. Aby sa nezapočítal dvakrát, obe
-- hlásenia nesú rovnaké `event_id`; tým je u nás id objednávky, lebo ho pozná
-- prehliadač aj webhook.
--
-- Server ale o súhlase nevie nič. Webhook beží hodinu po tom, čo človek klikol
-- na „Zaplatiť", a prichádza od Stripu, nie z prehliadača. Keby sme hlásili
-- všetko, poslali by sme Mete údaje aj o ľuďoch, ktorí marketing odmietli — a
-- to by bol presne ten únik, pred ktorým má súhlas chrániť.
--
-- Preto sa odpoveď ukladá k objednávke v okamihu, keď vzniká. Nie ako „čo si
-- myslíme", ale ako to, čo človek naozaj klikol.
--
-- A preto sa tu ukladá aj to ostatné: `_fbp` a `_fbc` sú cookies, ktoré Mete
-- hovoria, z ktorej reklamy človek prišiel, a IP s prehliadačom sú to, čím sa
-- nákup páruje na človeka. V prehliadači sú dostupné, vo webhooku už nie. Bez
-- súhlasu sa neukladá nič z toho — v stĺpci ostane iba `{"consent": false}`.
-- ============================================================================
set search_path = public, extensions;

alter table public.orders    add column if not exists marketing jsonb;
alter table public.checkouts add column if not exists marketing jsonb;

comment on column public.orders.marketing is
  'Súhlas s marketingom v čase objednávky a kontext na Conversions API. Bez súhlasu iba {"consent": false}.';
comment on column public.checkouts.marketing is
  'To isté pre košík — jedna platba za viac objednávok má jednu odpoveď.';

-- --- čo webhook potrebuje poslať --------------------------------------------
--
-- Jedna funkcia pre obe cesty: objednávka aj košík. Vracia už iba to, čo ide
-- Mete — súhlas, suma, mena, identifikátory produktov a e-mail na zahašovanie.
-- Hašovanie robí Edge Function, nie databáza: čistý e-mail sa tak nikdy
-- neobjaví v odpovedi, ktorá by mohla skončiť v logu.
create or replace function public.marketing_purchase_payload(
  p_order_id    uuid default null,
  p_checkout_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  ctx       jsonb;
  total     integer;
  curr      text;
  ev        uuid;
  buyer     uuid;
  mail      text;
  items     jsonb;
  qty       integer;
begin
  if p_checkout_id is not null then
    select c.marketing, c.total_cents, c.currency, c.event_id, c.buyer_id, c.quantity
      into ctx, total, curr, ev, buyer, qty
    from public.checkouts c where c.id = p_checkout_id;

    select coalesce(jsonb_agg(distinct o.ticket_type_id), '[]'::jsonb)
      into items
    from public.orders o where o.checkout_id = p_checkout_id;
  elsif p_order_id is not null then
    select o.marketing, o.total_cents, o.currency, o.event_id, o.buyer_id,
           o.guest_email, to_jsonb(array[o.ticket_type_id]), o.quantity
      into ctx, total, curr, ev, buyer, mail, items, qty
    from public.orders o where o.id = p_order_id;
  else
    return null;
  end if;

  if ctx is null or coalesce((ctx->>'consent')::boolean, false) is not true then
    -- Odmietol, alebo sme sa nestihli opýtať. Nič sa neposiela a nič sa o tom
    -- nedozvie ani volajúci — `null` je tu celá odpoveď.
    return null;
  end if;

  -- E-mail: hosť ho má pri objednávke, prihlásený v účte.
  if mail is null and buyer is not null then
    select u.email into mail from auth.users u where u.id = buyer;
  end if;

  return jsonb_build_object(
    'value_cents', coalesce(total, 0),
    'currency',    coalesce(curr, 'EUR'),
    'event_id',    ev,
    'quantity',    coalesce(qty, 1),
    'content_ids', coalesce(items, '[]'::jsonb),
    'email',       lower(nullif(btrim(coalesce(mail, '')), '')),
    'fbp',         ctx->>'fbp',
    'fbc',         ctx->>'fbc',
    'ip',          ctx->>'ip',
    'ua',          ctx->>'ua'
  );
end;
$$;

-- Volá to iba webhook cez service_role. Pre anon ani authenticated to nemá
-- zmysel a e-mail v odpovedi je dôvod, prečo to tak musí zostať.
revoke all on function public.marketing_purchase_payload(uuid, uuid) from public;
grant execute on function public.marketing_purchase_payload(uuid, uuid) to service_role;
