-- ---------------------------------------------------------------------------
-- VAT on ticket prices.
--
-- A ticket price in BLUP is what the buyer pays — gross. An organizer who is a
-- VAT payer still has to know the split, because that is what goes on the
-- invoice and into their books. The rate belongs to the organization (an
-- organizer either is registered or is not) and defaults to the Slovak base
-- rate, so the number is right for almost everyone without being asked.
--
-- Nothing here changes what anybody is charged: gross stays gross.
-- ---------------------------------------------------------------------------

alter table public.organizations
  add column if not exists is_vat_payer boolean not null default false;

alter table public.organizations
  add column if not exists vat_rate_bps integer not null default 2300;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_vat_rate_bps_check'
  ) then
    alter table public.organizations
      add constraint organizations_vat_rate_bps_check
      check (vat_rate_bps between 0 and 10000);
  end if;
end;
$$;

comment on column public.organizations.is_vat_payer is
  'Whether this organizer is registered for VAT. Drives the gross/net split shown on prices and reports.';
comment on column public.organizations.vat_rate_bps is
  'VAT rate in basis points (2300 = 23%). Applied to gross ticket prices.';

-- The net/VAT split of a gross amount, in cents. Rounds VAT to the cent and
-- derives net from it, so net + vat is always exactly gross — no lost cent.
create or replace function public.vat_split(
  p_gross_cents integer,
  p_rate_bps    integer
)
returns jsonb
language sql
immutable
as $$
  with v as (
    select round(
      coalesce(p_gross_cents, 0)::numeric
      * coalesce(p_rate_bps, 0)::numeric
      / (10000 + coalesce(p_rate_bps, 0))::numeric
    )::integer as vat_cents
  )
  select jsonb_build_object(
    'gross_cents', coalesce(p_gross_cents, 0),
    'vat_cents',   v.vat_cents,
    'net_cents',   coalesce(p_gross_cents, 0) - v.vat_cents,
    'rate_bps',    coalesce(p_rate_bps, 0)
  )
  from v;
$$;

grant execute on function public.vat_split(integer, integer) to anon, authenticated;
