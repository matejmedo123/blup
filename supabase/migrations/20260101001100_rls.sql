-- ============================================================================
-- BLUP · 0011 · Row Level Security
-- ============================================================================
-- Everything is deny-by-default. The anon/authenticated roles reach the data
-- exclusively through these policies; the service role (Edge Functions) bypasses
-- RLS and is therefore the only path that can write payments, tickets,
-- subscriptions and ledger rows.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
alter table public.profiles                            enable row level security;
alter table public.interests                           enable row level security;
alter table public.user_interests                      enable row level security;
alter table public.follows                             enable row level security;
alter table public.friendships                         enable row level security;
alter table public.organizations                       enable row level security;
alter table public.organization_members                enable row level security;
alter table public.organization_verification_requests  enable row level security;
alter table public.events                              enable row level security;
alter table public.event_images                        enable row level security;
alter table public.event_attendees                     enable row level security;
alter table public.saved_events                        enable row level security;
alter table public.event_likes                         enable row level security;
alter table public.event_views                         enable row level security;
alter table public.communities                         enable row level security;
alter table public.community_members                   enable row level security;
alter table public.event_crews                         enable row level security;
alter table public.event_crew_members                  enable row level security;
alter table public.posts                               enable row level security;
alter table public.post_likes                          enable row level security;
alter table public.comments                            enable row level security;
alter table public.notifications                       enable row level security;
alter table public.push_tokens                         enable row level security;
alter table public.notification_preferences            enable row level security;
alter table public.ticket_types                        enable row level security;
alter table public.orders                              enable row level security;
alter table public.payments                            enable row level security;
alter table public.webhook_events                      enable row level security;
alter table public.tickets                             enable row level security;
alter table public.ledger_entries                      enable row level security;
alter table public.payouts                             enable row level security;
alter table public.premium_subscriptions               enable row level security;
alter table public.subscription_events                 enable row level security;
alter table public.user_event_signals                  enable row level security;
alter table public.ai_recommendation_runs              enable row level security;
alter table public.ai_recommendation_items             enable row level security;
alter table public.ai_requests                         enable row level security;
alter table public.reports                             enable row level security;
alter table public.admin_audit_log                     enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    id = auth.uid()
    or public.is_admin()
    or (not is_suspended and (not is_private or public.is_following(id, auth.uid())))
  );

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- Insert is normally done by the handle_new_user trigger; allow self-insert as
-- a fallback so a missing profile can be repaired by the owner.
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());

-- Nobody can escalate their own app_role: block role changes from the client.
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_full_admin() then
    new.app_role := old.app_role;
    new.is_suspended := old.is_suspended;
    new.suspended_reason := old.suspended_reason;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on public.profiles;
create trigger profiles_protect_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ---------------------------------------------------------------------------
-- interests (public catalogue, admin-managed)
-- ---------------------------------------------------------------------------
drop policy if exists interests_select on public.interests;
create policy interests_select on public.interests for select using (true);

drop policy if exists interests_admin_write on public.interests;
create policy interests_admin_write on public.interests
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists user_interests_select on public.user_interests;
create policy user_interests_select on public.user_interests for select using (true);

drop policy if exists user_interests_write on public.user_interests;
create policy user_interests_write on public.user_interests
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- follows / friendships
-- ---------------------------------------------------------------------------
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select using (true);

drop policy if exists follows_insert on public.follows;
create policy follows_insert on public.follows
  for insert with check (follower_id = auth.uid());

drop policy if exists follows_delete on public.follows;
create policy follows_delete on public.follows
  for delete using (follower_id = auth.uid());

drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select using (requester_id = auth.uid() or addressee_id = auth.uid() or public.is_admin());

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert with check (requester_id = auth.uid());

drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update using (addressee_id = auth.uid() or requester_id = auth.uid())
  with check (addressee_id = auth.uid() or requester_id = auth.uid());

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete using (requester_id = auth.uid() or addressee_id = auth.uid());

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select using (true);

drop policy if exists organizations_insert on public.organizations;
create policy organizations_insert on public.organizations
  for insert with check (created_by = auth.uid());

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update using (public.is_org_member(id, array['owner', 'admin']::org_role[]) or public.is_admin())
  with check (public.is_org_member(id, array['owner', 'admin']::org_role[]) or public.is_admin());

drop policy if exists organizations_delete on public.organizations;
create policy organizations_delete on public.organizations
  for delete using (public.is_org_member(id, array['owner']::org_role[]) or public.is_full_admin());

-- Only an admin may flip verification/payout flags. Organizers can edit branding.
create or replace function public.protect_organization_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.verification_status := old.verification_status;
    new.payouts_enabled := old.payouts_enabled;
    new.charges_enabled := old.charges_enabled;
    new.platform_fee_bps := old.platform_fee_bps;
    new.stripe_account_id := old.stripe_account_id;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_protect_privileges on public.organizations;
create trigger organizations_protect_privileges
  before update on public.organizations
  for each row execute function public.protect_organization_privileges();

drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members
  for select using (true);

drop policy if exists organization_members_write on public.organization_members;
create policy organization_members_write on public.organization_members
  for all using (public.is_org_member(organization_id, array['owner', 'admin']::org_role[]) or public.is_admin())
  with check (public.is_org_member(organization_id, array['owner', 'admin']::org_role[]) or public.is_admin());

drop policy if exists org_verification_select on public.organization_verification_requests;
create policy org_verification_select on public.organization_verification_requests
  for select using (public.is_org_member(organization_id, null) or public.is_admin());

drop policy if exists org_verification_insert on public.organization_verification_requests;
create policy org_verification_insert on public.organization_verification_requests
  for insert with check (
    submitted_by = auth.uid()
    and public.is_org_member(organization_id, array['owner', 'admin']::org_role[])
  );

drop policy if exists org_verification_admin_update on public.organization_verification_requests;
create policy org_verification_admin_update on public.organization_verification_requests
  for update using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select using (
    creator_id = auth.uid()
    or public.is_admin()
    or (organization_id is not null and public.is_org_member(organization_id, null))
    or (
      status = 'published'
      and (
        visibility in ('public', 'unlisted')
        or (visibility = 'followers' and public.is_following(creator_id, auth.uid()))
      )
    )
  );

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert with check (
    creator_id = auth.uid()
    and (
      organization_id is null
      or public.is_org_member(organization_id, array['owner', 'admin', 'event_manager']::org_role[])
    )
  );

drop policy if exists events_update on public.events;
create policy events_update on public.events
  for update using (
    creator_id = auth.uid()
    or (organization_id is not null
        and public.is_org_member(organization_id, array['owner', 'admin', 'event_manager']::org_role[]))
    or public.is_admin()
  )
  with check (
    creator_id = auth.uid()
    or (organization_id is not null
        and public.is_org_member(organization_id, array['owner', 'admin', 'event_manager']::org_role[]))
    or public.is_admin()
  );

drop policy if exists events_delete on public.events;
create policy events_delete on public.events
  for delete using (
    creator_id = auth.uid()
    or (organization_id is not null and public.is_org_member(organization_id, array['owner', 'admin']::org_role[]))
    or public.is_admin()
  );

-- Clients must never write denormalised counters.
create or replace function public.protect_event_counters()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.attendee_count   := old.attendee_count;
    new.interested_count := old.interested_count;
    new.saved_count      := old.saved_count;
    new.like_count       := old.like_count;
    new.comment_count    := old.comment_count;
    new.view_count       := old.view_count;
    new.tickets_sold     := old.tickets_sold;
  end if;
  return new;
end;
$$;

drop trigger if exists events_protect_counters on public.events;
create trigger events_protect_counters
  before update on public.events
  for each row execute function public.protect_event_counters();

drop policy if exists event_images_select on public.event_images;
create policy event_images_select on public.event_images
  for select using (public.can_view_event(event_id));

drop policy if exists event_images_write on public.event_images;
create policy event_images_write on public.event_images
  for all using (
    exists (select 1 from public.events e where e.id = event_id
            and (e.creator_id = auth.uid()
                 or (e.organization_id is not null
                     and public.is_org_member(e.organization_id, array['owner','admin','event_manager']::org_role[]))))
  )
  with check (
    exists (select 1 from public.events e where e.id = event_id
            and (e.creator_id = auth.uid()
                 or (e.organization_id is not null
                     and public.is_org_member(e.organization_id, array['owner','admin','event_manager']::org_role[]))))
  );

-- ---------------------------------------------------------------------------
-- RSVP / saves / likes / views
-- ---------------------------------------------------------------------------
drop policy if exists event_attendees_select on public.event_attendees;
create policy event_attendees_select on public.event_attendees
  for select using (public.can_view_event(event_id));

drop policy if exists event_attendees_write on public.event_attendees;
create policy event_attendees_write on public.event_attendees
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid());

drop policy if exists saved_events_select on public.saved_events;
create policy saved_events_select on public.saved_events
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists saved_events_write on public.saved_events;
create policy saved_events_write on public.saved_events
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists event_likes_select on public.event_likes;
create policy event_likes_select on public.event_likes for select using (true);

drop policy if exists event_likes_write on public.event_likes;
create policy event_likes_write on public.event_likes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists event_views_insert on public.event_views;
create policy event_views_insert on public.event_views
  for insert with check (user_id = auth.uid() or user_id is null);

drop policy if exists event_views_select on public.event_views;
create policy event_views_select on public.event_views
  for select using (
    public.is_admin()
    or exists (select 1 from public.events e where e.id = event_id
               and (e.creator_id = auth.uid()
                    or (e.organization_id is not null and public.is_org_member(e.organization_id, null))))
  );

-- ---------------------------------------------------------------------------
-- communities / crews
-- ---------------------------------------------------------------------------
drop policy if exists communities_select on public.communities;
create policy communities_select on public.communities
  for select using (not is_private or public.is_community_member(id) or public.is_admin());

drop policy if exists communities_insert on public.communities;
create policy communities_insert on public.communities
  for insert with check (created_by = auth.uid());

drop policy if exists communities_update on public.communities;
create policy communities_update on public.communities
  for update using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists community_members_select on public.community_members;
create policy community_members_select on public.community_members for select using (true);

drop policy if exists community_members_write on public.community_members;
create policy community_members_write on public.community_members
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid());

drop policy if exists event_crews_select on public.event_crews;
create policy event_crews_select on public.event_crews
  for select using (public.can_view_event(event_id));

drop policy if exists event_crews_insert on public.event_crews;
create policy event_crews_insert on public.event_crews
  for insert with check (created_by = auth.uid() and public.can_view_event(event_id));

drop policy if exists event_crews_update on public.event_crews;
create policy event_crews_update on public.event_crews
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists event_crew_members_select on public.event_crew_members;
create policy event_crew_members_select on public.event_crew_members for select using (true);

drop policy if exists event_crew_members_write on public.event_crew_members;
create policy event_crew_members_write on public.event_crew_members
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- posts / comments
-- ---------------------------------------------------------------------------
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select using (
    not is_deleted
    and (event_id is null or public.can_view_event(event_id))
    and (community_id is null or public.is_community_member(community_id)
         or exists (select 1 from public.communities c where c.id = community_id and not c.is_private))
  );

drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts
  for insert with check (author_id = auth.uid());

drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts
  for update using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts
  for delete using (author_id = auth.uid() or public.is_admin());

drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes for select using (true);

drop policy if exists post_likes_write on public.post_likes;
create policy post_likes_write on public.post_likes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select using (event_id is null or public.can_view_event(event_id));

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert with check (
    user_id = auth.uid()
    and (event_id is null or public.can_view_event(event_id))
  );

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- notifications / push
-- ---------------------------------------------------------------------------
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select using (user_id = auth.uid());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete using (user_id = auth.uid());

drop policy if exists push_tokens_write on public.push_tokens;
create policy push_tokens_write on public.push_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notification_preferences_write on public.notification_preferences;
create policy notification_preferences_write on public.notification_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- ticketing & money — read-only for users, writes only via service role
-- ---------------------------------------------------------------------------
drop policy if exists ticket_types_select on public.ticket_types;
create policy ticket_types_select on public.ticket_types
  for select using (public.can_view_event(event_id));

drop policy if exists ticket_types_write on public.ticket_types;
create policy ticket_types_write on public.ticket_types
  for all using (
    exists (select 1 from public.events e where e.id = event_id
            and e.organization_id is not null
            and public.is_org_member(e.organization_id, array['owner','admin','event_manager']::org_role[]))
    or public.is_admin()
  )
  with check (
    exists (select 1 from public.events e where e.id = event_id
            and e.organization_id is not null
            and public.is_org_member(e.organization_id, array['owner','admin','event_manager']::org_role[]))
    or public.is_admin()
  );

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select using (
    buyer_id = auth.uid()
    or (organization_id is not null and public.is_org_member(organization_id, array['owner','admin','finance']::org_role[]))
    or public.is_admin()
  );
-- No INSERT/UPDATE policy on purpose: orders are created by create_order()
-- through the checkout Edge Function (service role) only.

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists webhook_events_admin on public.webhook_events;
create policy webhook_events_admin on public.webhook_events
  for select using (public.is_full_admin());

drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select using (
    buyer_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.events e where e.id = event_id
               and (e.creator_id = auth.uid()
                    or (e.organization_id is not null and public.is_org_member(e.organization_id, null))))
  );

drop policy if exists ledger_select on public.ledger_entries;
create policy ledger_select on public.ledger_entries
  for select using (
    public.is_org_member(organization_id, array['owner','admin','finance']::org_role[])
    or public.is_admin()
  );

drop policy if exists payouts_select on public.payouts;
create policy payouts_select on public.payouts
  for select using (
    public.is_org_member(organization_id, array['owner','admin','finance']::org_role[])
    or public.is_admin()
  );
-- Payout creation goes through request_payout() which enforces balance + role.

-- ---------------------------------------------------------------------------
-- premium
-- ---------------------------------------------------------------------------
drop policy if exists premium_select on public.premium_subscriptions;
create policy premium_select on public.premium_subscriptions
  for select using (user_id = auth.uid() or public.is_admin());
-- Writes: service role only (receipt verification functions).

drop policy if exists subscription_events_select on public.subscription_events;
create policy subscription_events_select on public.subscription_events
  for select using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- AI / signals
-- ---------------------------------------------------------------------------
drop policy if exists signals_insert on public.user_event_signals;
create policy signals_insert on public.user_event_signals
  for insert with check (user_id = auth.uid());

drop policy if exists signals_select on public.user_event_signals;
create policy signals_select on public.user_event_signals
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists ai_runs_select on public.ai_recommendation_runs;
create policy ai_runs_select on public.ai_recommendation_runs
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists ai_items_select on public.ai_recommendation_items;
create policy ai_items_select on public.ai_recommendation_items
  for select using (
    exists (select 1 from public.ai_recommendation_runs r
            where r.id = run_id and (r.user_id = auth.uid() or public.is_admin()))
  );

drop policy if exists ai_requests_select on public.ai_requests;
create policy ai_requests_select on public.ai_requests
  for select using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- moderation
-- ---------------------------------------------------------------------------
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert with check (reporter_id = auth.uid());

drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists reports_admin_update on public.reports;
create policy reports_admin_update on public.reports
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists audit_log_select on public.admin_audit_log;
create policy audit_log_select on public.admin_audit_log
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Function execution grants
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function
      public.events_nearby(double precision, double precision, double precision, timestamptz, timestamptz, text[], boolean, integer, integer),
      public.search_events(text, double precision, double precision, double precision, timestamptz, timestamptz, text[], boolean, integer, text, integer, integer),
      public.recommend_events(uuid, double precision, double precision, double precision, integer, integer),
      public.recommend_people(uuid, uuid, integer),
      public.record_signal(uuid, signal_type, numeric, jsonb),
      public.log_recommendation_run(text, jsonb, jsonb),
      public.mark_notifications_read(uuid[]),
      public.check_in_ticket(text, text, uuid),
      public.request_payout(uuid, integer),
      public.event_analytics(uuid),
      public.my_premium_status(),
      public.is_premium(uuid),
      public.admin_platform_stats(),
      public.admin_suspend_user(uuid, boolean, text),
      public.admin_set_event_status(uuid, event_status, text),
      public.admin_review_organization(uuid, boolean, text),
      public.admin_resolve_report(uuid, report_status, text),
      public.admin_update_payout_status(uuid, payout_status, text, text)
    to authenticated;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function
      public.events_nearby(double precision, double precision, double precision, timestamptz, timestamptz, text[], boolean, integer, integer),
      public.search_events(text, double precision, double precision, double precision, timestamptz, timestamptz, text[], boolean, integer, text, integer, integer)
    to anon;
  end if;
end
$$;

-- create_order / fulfill_order / refund_order / upsert_premium_subscription are
-- deliberately NOT granted to authenticated: they are service-role only.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function
      public.create_order(uuid, uuid, integer),
      public.fulfill_order(uuid, payment_provider, text, integer),
      public.fail_order(uuid, text),
      public.refund_order(uuid, text),
      public.mark_payout_failed(uuid, text),
      public.upsert_premium_subscription(uuid, subscription_platform, text, subscription_status, text, text, timestamptz, timestamptz, boolean, text, jsonb)
    from authenticated, anon;
  end if;
end
$$;
