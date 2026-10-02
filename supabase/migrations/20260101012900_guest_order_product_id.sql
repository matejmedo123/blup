-- ============================================================================
-- Hosťovská objednávka: pridať id typu lístka a eventu
-- ============================================================================
-- Kvôli meraniu konverzie, a kvôli tomu, čo sa doteraz posielalo namiesto neho.
--
-- Návratová stránka hlásila nákup reklamným systémom a ako identifikátor
-- produktu brala to jediné, čo mala poruke — `code` vstupenky. To je zle hneď
-- dvakrát:
--
--   Je to kód, ktorý sa skenuje pri vstupe. Nemá čo odísť Mete ani Googlu.
--
--   A ako „produkt" je nepoužiteľný: každý kus má vlastný kód, takže dva
--   predané lístky toho istého typu vyzerajú ako dva rôzne tovary. Nič sa z
--   toho nedá spočítať a katalóg sa na to nenapojí.
--
-- Objednávka je vždy na jeden typ lístka (`create_order` berie práve jeden),
-- takže stačí jedno id na objednávku. `event_id` je tu ako záloha pre prípad,
-- že by typ lístka medzitým niekto zmazal.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.guest_order_status(
  p_order_id uuid,
  p_token    text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  o  record;
  ev record;
begin
  if p_order_id is null or nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into o from public.orders
  where id = p_order_id and claim_token = btrim(p_token);

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  select title, start_at, venue_name, city into ev
  from public.events where id = o.event_id;

  return jsonb_build_object(
    'order_id',       o.id,
    'status',         o.payment_status,
    'quantity',       o.quantity,
    'total_cents',    o.total_cents,
    'currency',       o.currency,
    'guest_email',    o.guest_email,
    'guest_name',     o.guest_name,
    'event_id',       o.event_id,
    'ticket_type_id', o.ticket_type_id,
    'event_title',    ev.title,
    'event_start_at', ev.start_at,
    'venue_name',     ev.venue_name,
    'city',           ev.city,
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', t.code, 'qr_secret', t.qr_secret, 'status', t.status
      ) order by t.created_at)
      from public.tickets t where t.order_id = o.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.guest_order_status(uuid, text) from public;
grant execute on function public.guest_order_status(uuid, text) to anon, authenticated;
