-- ============================================================================
-- BLUP · 0027 · What a ticket has to say
-- ============================================================================
-- The PDF is a document a person shows at a door and, for a paid event, a proof
-- of purchase. That means it has to name the *seller* — which is the organizer,
-- not BLUP. BLUP is the platform the sale happened on; the contract is between
-- the buyer and the organizer, and a ticket that says otherwise is wrong about
-- who owes the buyer a refund if the event does not happen.
--
-- The legal identity is already collected: it is what the organization sent in
-- to be verified. This adds it to the ticket payload, together with the fee
-- split and the moment of purchase, so the PDF can state:
--
--   who sold it, under what registration and VAT number, at what address
--   what was bought, for how much, and what part of that was the archive fee
--   when it was issued, and which ticket of how many this is
--
-- Nothing new is stored. The payload function simply stops leaving out things
-- the ticket needs.
-- ============================================================================

set search_path = public, extensions;

create or replace function public.ticket_email_payload(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  o      public.orders;
  ev     public.events;
  org    public.organizations;
  buyer  public.profiles;
  legal  record;
  result jsonb;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  select * into ev from public.events where id = o.event_id;
  select * into org from public.organizations where id = o.organization_id;
  select * into buyer from public.profiles where id = o.buyer_id;

  -- The seller's legal identity, as approved. An unverified organization cannot
  -- sell paid tickets at all, so for a paid order this row exists.
  select r.legal_name, r.registration_number, r.vat_number, r.address, r.contact_email
    into legal
  from public.organization_verification_requests r
  where r.organization_id = o.organization_id
    and r.status = 'verified'
  order by r.reviewed_at desc nulls last, r.created_at desc
  limit 1;

  select jsonb_build_object(
    'order_id',        o.id,
    'order_reference', coalesce(o.provider_reference, left(o.id::text, 8)),
    'quantity',        o.quantity,
    'currency',        o.currency,
    'total_cents',     o.total_cents,
    'unit_price_cents', o.unit_price_cents,
    'subtotal_cents',  o.subtotal_cents,
    'discount_cents',  o.discount_cents,
    'archive_fee_cents', o.archive_fee_cents,
    'archive_fee_payer', o.archive_fee_payer,
    'purchased_at',    coalesce(o.paid_at, o.created_at),
    'buyer_name',      coalesce(buyer.display_name, buyer.username, 'Host'),
    'event', jsonb_build_object(
      'id',         ev.id,
      'title',      ev.title,
      'start_at',   ev.start_at,
      'end_at',     ev.end_at,
      'venue_name', ev.venue_name,
      'address',    ev.address,
      'city',       ev.city,
      'category',   ev.category
    ),
    'organizer', coalesce(org.name, 'Blup'),
    'seller', jsonb_build_object(
      'name',           coalesce(legal.legal_name, org.name),
      'registration_number', legal.registration_number,
      'vat_number',     legal.vat_number,
      'address',        coalesce(legal.address, org.city),
      'email',          coalesce(legal.contact_email::text, org.contact_email::text)
    ),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',        t.id,
               'code',      t.code,
               'qr_secret', t.qr_secret,
               'type',      tt.name,
               'price_cents', t.price_cents
             ) order by t.created_at, t.id)
      from public.tickets t
      join public.ticket_types tt on tt.id = t.ticket_type_id
      where t.order_id = o.id and t.status <> 'refunded'
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- CREATE OR REPLACE keeps the existing privileges, and 0024 already revoked
-- this one from PUBLIC. Asserted rather than assumed: it hands out QR secrets.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.ticket_email_payload(uuid)', 'execute')
  then
    raise exception 'FUNCTION_STILL_EXPOSED: ticket_email_payload';
  end if;
end
$$;
