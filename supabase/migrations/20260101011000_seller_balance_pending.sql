-- ============================================================================
-- „Čaká na event" musí počítať aj to, čo je predané a ešte nezaúčtované
-- ============================================================================
-- Zostatok sa rátal výhradne z knihy. Kniha je správne miesto — zápis do nej
-- vzniká až po evente, lebo dovtedy nevieme, či sa kupujúci naozaj dostal dnu.
-- Lenže pre predajcu to znamenalo, že vstupenku predal za 24 €, na obrazovke
-- videl tri nuly a nič mu nepovedalo, že peniaze niekde sú.
--
-- To nie je chyba účtovania, je to chyba čísla, ktoré sa ukazuje. „Čaká na
-- event" má znamenať „toto ti už patrí, len na to ešte nie je čas" — a presne
-- taká je zaplatená objednávka pred eventom.
--
-- Kniha sa nemení. Mení sa len to, čo sa spočíta do `pending_cents`: k
-- nedostupným zápisom pribudne očakávaný podiel z objednávok, ktoré sú
-- zaplatené a nárok im ešte nevznikol. Do `available_cents` sa nedostane nič —
-- vyplatiť sa stále dá len to, čo je v knihe a má svoj čas.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.seller_balance(p_seller uuid default auth.uid())
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with book as (
    select
      coalesce(sum(amount_cents), 0)                                         as total,
      coalesce(sum(amount_cents) filter (where available_at <= now()), 0)    as ready,
      coalesce(sum(amount_cents) filter (where available_at >  now()), 0)    as later,
      coalesce(sum(amount_cents) filter (where type = 'sale'), 0)            as sales,
      coalesce(-sum(amount_cents) filter (where type = 'platform_fee'), 0)   as fees,
      coalesce(-sum(amount_cents) filter (where type = 'payout'), 0)         as paid,
      min(currency)                                                          as currency
    from public.seller_ledger_entries
    where seller_id = p_seller
  ),
  -- Predané a zaplatené, ale nárok ešte nevznikol: event sa neodohral, alebo
  -- kupujúci pri externej vstupenke ešte nepotvrdil. Peniaze sú u nás.
  coming as (
    select
      coalesce(sum(o.seller_net_cents), 0) as amount,
      min(o.currency)                      as currency
    from public.resale_orders o
    where o.seller_id = p_seller
      and o.payment_status = 'succeeded'
      and o.order_status not in ('refunded', 'cancelled')
      and not exists (
        select 1 from public.seller_ledger_entries l
        where l.resale_order_id = o.id and l.type = 'sale'
      )
  )
  select jsonb_build_object(
    'seller_id',       p_seller,
    'currency',        coalesce(book.currency, coming.currency,
                                (select default_currency from public.platform_settings where id)),
    'balance_cents',   book.total + coming.amount,
    -- Vyplatiť sa dá stále len to, čo je v knihe a má svoj čas. Očakávané
    -- peniaze sem nepatria a nesmú sa dať vybrať skôr, než na ne vznikne nárok.
    'available_cents', book.ready,
    'pending_cents',   book.later + coming.amount,
    'sales_cents',     book.sales,
    'fees_cents',      book.fees,
    'paid_out_cents',  book.paid,
    'payouts_enabled', coalesce((select a.payouts_enabled from public.seller_accounts a
                                  where a.user_id = p_seller), false)
  )
  from book, coming;
$$;

revoke execute on function public.seller_balance(uuid) from public;
grant execute on function public.seller_balance(uuid) to authenticated;
