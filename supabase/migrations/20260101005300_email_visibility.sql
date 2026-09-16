-- ============================================================================
-- BLUP · 0053 · A ticket e-mail that never leaves should be visible
-- ============================================================================
-- Everything about queueing a ticket e-mail is tested and works. What nothing
-- covered is the other half: the queue is drained by the `ticket-email` Edge
-- Function on a cron, and if that function is not deployed — or the schedule was
-- never created, or RESEND_API_KEY is missing — the rows simply sit there.
--
-- Nobody finds out. The buyer has the ticket in the app, the organizer sees the
-- sale, the ledger balances, and the e-mail that is somebody's only copy at the
-- door is in a table nobody looks at. This turns that into a number on the
-- admin dashboard and a one-line answer from a script.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.email_queue_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return (
    select jsonb_build_object(
      'pending',  count(*) filter (where status in ('pending', 'sending')),
      'sent',     count(*) filter (where status = 'sent'),
      'failed',   count(*) filter (where status = 'failed'),
      'skipped',  count(*) filter (where status = 'skipped'),
      -- How long the oldest unsent one has been waiting. A queue that is being
      -- drained never shows more than a minute or two here; hours means the
      -- worker is not running at all.
      'oldest_pending_minutes',
        coalesce(
          round(extract(epoch from (now() - min(created_at)
            filter (where status in ('pending', 'sending')))) / 60.0)::integer,
          0
        ),
      'last_sent_at', max(sent_at) filter (where status = 'sent'),
      'last_error',   (select last_error from public.email_deliveries
                       where last_error is not null
                       order by created_at desc limit 1)
    )
    from public.email_deliveries
  );
end;
$$;

revoke all on function public.email_queue_stats() from public, anon;
grant execute on function public.email_queue_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- And on the dashboard, where somebody will actually see it
-- ---------------------------------------------------------------------------
create or replace function public.admin_platform_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'suspended_users', (select count(*) from public.profiles where is_suspended),
    'events', (select count(*) from public.events),
    'published_events', (select count(*) from public.events where status = 'published'),
    'listed_events', (select count(*) from public.events where listed_by_platform),
    'organizations', (select count(*) from public.organizations),
    'pending_verifications', (select count(*) from public.organization_verification_requests where status = 'pending'),
    'pending_event_claims', (select count(*) from public.event_claims where status = 'pending'),
    'tickets', (select count(*) from public.tickets),
    'complimentary_tickets', (select count(*) from public.tickets where is_complimentary),
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from public.orders where payment_status = 'succeeded'), 0),
    'net_sales_cents', coalesce((select sum(net_cents) from public.orders where payment_status = 'succeeded'), 0),
    'commission_cents', coalesce((select sum(commission_cents) from public.orders where payment_status = 'succeeded'), 0),
    'archive_fee_cents', coalesce((select sum(archive_fee_cents) from public.orders where payment_status = 'succeeded'), 0),
    'boost_revenue_cents', coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'platform_revenue_cents',
      coalesce((select sum(blup_revenue_cents) from public.orders where payment_status = 'succeeded'), 0)
      + coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'pending_payouts', (select count(*) from public.payouts where status = 'pending'),
    'open_disputes', (select count(*) from public.payment_disputes where status = 'open'),
    'frozen_organizations',
      (select count(distinct organization_id) from public.payment_disputes where status = 'open'),
    -- Unsent ticket e-mails, and how long the oldest has waited. Both, because
    -- "12 waiting" is normal a few seconds after a sale and alarming after a day.
    'emails_pending',
      (select count(*) from public.email_deliveries where status in ('pending', 'sending')),
    'emails_oldest_minutes',
      coalesce((select round(extract(epoch from (now() - min(created_at))) / 60.0)::integer
                from public.email_deliveries where status in ('pending', 'sending')), 0),
    'emails_failed', (select count(*) from public.email_deliveries where status = 'failed'),
    'premium_users', (select count(distinct user_id) from public.premium_subscriptions
                      where status in ('active', 'trialing', 'grace_period')
                        and (expires_at is null or expires_at > now()))
  );
end;
$$;
