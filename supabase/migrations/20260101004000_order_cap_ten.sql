-- ---------------------------------------------------------------------------
-- One order tops out at ten tickets.
--
-- Twenty was a guess; ten is the operator's decision. The cap lives in
-- platform_settings so it stays changeable without a deploy — this migration
-- moves both the column default and the row that is already there, and the
-- fallback inside cart_limits() so a deployment with no settings row behaves
-- the same as one that has it.
-- ---------------------------------------------------------------------------

alter table public.platform_settings
  alter column max_tickets_per_order set default 10;

-- Only the untouched default is moved. An operator who has deliberately set
-- some other number keeps it.
update public.platform_settings
   set max_tickets_per_order = 10
 where max_tickets_per_order = 20;

create or replace function public.cart_limits()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'max_tickets_per_order', coalesce(s.max_tickets_per_order, 10),
    'hold_minutes',          coalesce(s.cart_hold_minutes, 15)
  )
  from (select * from public.platform_settings where id limit 1) s;
$$;

grant execute on function public.cart_limits() to anon, authenticated;
