-- ============================================================================
-- BLUP · 0010 · Reports, moderation, admin actions & audit log
-- ============================================================================

create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  target_type  report_target not null,
  target_id    uuid not null,
  reason       text not null,
  details      text,
  status       report_status not null default 'open',
  reviewer_id  uuid references public.profiles (id) on delete set null,
  review_notes text,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz,
  constraint reports_reason_len check (char_length(reason) between 2 and 120)
);

create index if not exists reports_status_idx on public.reports (status, created_at desc);
create index if not exists reports_target_idx on public.reports (target_type, target_id);

create table if not exists public.admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists admin_audit_log_idx on public.admin_audit_log (created_at desc);

create or replace function public.log_admin_action(
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_meta jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.admin_audit_log (admin_id, action, target_type, target_id, meta)
  values (auth.uid(), p_action, p_target_type, p_target_id, coalesce(p_meta, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- Admin operations (all check is_admin() internally)
-- ---------------------------------------------------------------------------
create or replace function public.admin_suspend_user(
  p_user_id uuid,
  p_suspend boolean,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.profiles
  set is_suspended = p_suspend,
      suspended_reason = case when p_suspend then p_reason else null end
  where id = p_user_id;

  perform public.log_admin_action(
    case when p_suspend then 'suspend_user' else 'unsuspend_user' end,
    'user', p_user_id, jsonb_build_object('reason', p_reason)
  );
end;
$$;

create or replace function public.admin_set_event_status(
  p_event_id uuid,
  p_status   event_status,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.events set status = p_status where id = p_event_id;

  perform public.log_admin_action('set_event_status', 'event', p_event_id,
    jsonb_build_object('status', p_status, 'reason', p_reason));
end;
$$;

create or replace function public.admin_review_organization(
  p_request_id uuid,
  p_approve    boolean,
  p_notes      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into req from public.organization_verification_requests where id = p_request_id;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;

  update public.organization_verification_requests
  set status = case when p_approve then 'verified'::verification_status else 'rejected'::verification_status end,
      reviewer_id = auth.uid(),
      review_notes = p_notes,
      reviewed_at = now()
  where id = p_request_id;

  update public.organizations
  set verification_status = case when p_approve then 'verified'::verification_status
                                 else 'rejected'::verification_status end
  where id = req.organization_id;

  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id,
         case when p_approve then 'org_verified'::notification_type else 'org_rejected'::notification_type end,
         case when p_approve then 'Organization verified' else 'Verification rejected' end,
         coalesce(p_notes, case when p_approve
              then 'You can now create ticketed events.'
              else 'Please review the submitted details and try again.' end),
         jsonb_build_object('organization_id', req.organization_id)
  from public.organization_members m
  where m.organization_id = req.organization_id and m.role in ('owner', 'admin');

  perform public.log_admin_action('review_organization', 'organization', req.organization_id,
    jsonb_build_object('approved', p_approve, 'notes', p_notes));
end;
$$;

create or replace function public.admin_resolve_report(
  p_report_id uuid,
  p_status    report_status,
  p_notes     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.reports
  set status = p_status, reviewer_id = auth.uid(), review_notes = p_notes, reviewed_at = now()
  where id = p_report_id;

  perform public.log_admin_action('resolve_report', 'report', p_report_id,
    jsonb_build_object('status', p_status, 'notes', p_notes));
end;
$$;

create or replace function public.admin_update_payout_status(
  p_payout_id uuid,
  p_status    payout_status,
  p_provider_transfer_id text default null,
  p_failure_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  po record;
begin
  if not public.is_full_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into po from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'PAYOUT_NOT_FOUND';
  end if;

  update public.payouts
  set status = p_status,
      provider_transfer_id = coalesce(p_provider_transfer_id, provider_transfer_id),
      failure_reason = p_failure_reason,
      processed_at = case when p_status in ('paid', 'failed', 'cancelled') then now() else processed_at end
  where id = p_payout_id;

  -- A failed/cancelled payout returns the money to the organizer balance.
  if p_status in ('failed', 'cancelled') and po.status not in ('failed', 'cancelled') then
    insert into public.ledger_entries (organization_id, payout_id, type, amount_cents, currency, description, available_at)
    values (po.organization_id, po.id, 'adjustment', po.amount_cents, po.currency,
            'Payout reversal: ' || coalesce(p_failure_reason, p_status::text), now());
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select m.user_id, 'payout_update', 'Payout ' || p_status::text,
         coalesce(p_failure_reason, 'Your payout status changed.'),
         jsonb_build_object('payout_id', po.id, 'status', p_status)
  from public.organization_members m
  where m.organization_id = po.organization_id and m.role in ('owner', 'finance');

  perform public.log_admin_action('update_payout', 'payout', p_payout_id,
    jsonb_build_object('status', p_status));
end;
$$;

-- Platform-wide stats for the admin dashboard.
create or replace function public.admin_platform_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
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
    'organizations', (select count(*) from public.organizations),
    'pending_verifications', (select count(*) from public.organization_verification_requests where status = 'pending'),
    'tickets', (select count(*) from public.tickets),
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from public.orders where payment_status = 'succeeded'), 0),
    'platform_revenue_cents', coalesce((select sum(platform_fee_cents) from public.orders where payment_status = 'succeeded'), 0),
    'pending_payouts', (select count(*) from public.payouts where status = 'pending'),
    'premium_users', (select count(distinct user_id) from public.premium_subscriptions
                      where status in ('active', 'trialing', 'grace_period')
                        and (expires_at is null or expires_at > now()))
  );
end;
$$;
