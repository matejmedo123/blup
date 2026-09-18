-- ============================================================================
-- Indexy na cudzích kľúčoch
--
-- „nech stranka nespadne" — a toto je ten druh chyby, ktorý sa objaví až vtedy,
-- keď je na čo spadnúť. Postgres pri cudzom kľúči index nevyrobí sám, a pokiaľ
-- má tabuľka pár stoviek riadkov, nič to nestojí. Pri desiatkach tisíc to
-- vyzerá inak: každé zmazanie alebo zmena rodiča prelezie celú detskú tabuľku,
-- drží pritom zámok, ďalšie požiadavky čakajú na spojenie — a to, čo človek
-- vidí, je „stránka nejde".
--
-- Zmazanie eventu takto prechádzalo cez tickets, orders, notifications,
-- email_deliveries, cart_items, checkouts aj event_views naraz.
--
-- Indexov je tu 69, teda všetky, ktoré chýbali. Zámerne bez výnimiek: zoznam
-- „tieto netreba, lebo tabuľka je malá" časom prestane platiť a nikto si to
-- nevšimne. Index na malej tabuľke stojí prakticky nič; chýbajúci index na
-- veľkej stojí výpadok.
--
-- Kontrolu robí supabase/tests/_index_audit.sql pri každom verify-db.
-- ============================================================================
set search_path = public, extensions;

create index if not exists organizations_created_by_idx
  on public.organizations (created_by);

create index if not exists organization_verification_requests_submitted_by_idx
  on public.organization_verification_requests (submitted_by);

create index if not exists organization_verification_requests_reviewer_id_idx
  on public.organization_verification_requests (reviewer_id);

create index if not exists event_views_user_id_idx
  on public.event_views (user_id);

create index if not exists communities_created_by_idx
  on public.communities (created_by);

create index if not exists event_crews_created_by_idx
  on public.event_crews (created_by);

create index if not exists event_crew_members_user_id_idx
  on public.event_crew_members (user_id);

create index if not exists post_likes_user_id_idx
  on public.post_likes (user_id);

create index if not exists comments_parent_id_idx
  on public.comments (parent_id);

create index if not exists notifications_actor_id_idx
  on public.notifications (actor_id);

create index if not exists notifications_event_id_idx
  on public.notifications (event_id);

create index if not exists admin_audit_log_admin_id_idx
  on public.admin_audit_log (admin_id);

create index if not exists orders_ticket_type_id_idx
  on public.orders (ticket_type_id);

create index if not exists payments_user_id_idx
  on public.payments (user_id);

create index if not exists tickets_order_id_idx
  on public.tickets (order_id);

create index if not exists tickets_ticket_type_id_idx
  on public.tickets (ticket_type_id);

create index if not exists tickets_checked_in_by_idx
  on public.tickets (checked_in_by);

create index if not exists ledger_entries_event_id_idx
  on public.ledger_entries (event_id);

create index if not exists payouts_requested_by_idx
  on public.payouts (requested_by);

create index if not exists ledger_entries_payout_id_idx
  on public.ledger_entries (payout_id);

create index if not exists subscription_events_user_id_idx
  on public.subscription_events (user_id);

create index if not exists ai_recommendation_items_event_id_idx
  on public.ai_recommendation_items (event_id);

create index if not exists reports_reporter_id_idx
  on public.reports (reporter_id);

create index if not exists reports_reviewer_id_idx
  on public.reports (reviewer_id);

create index if not exists conversations_created_by_idx
  on public.conversations (created_by);

create index if not exists messages_sender_id_idx
  on public.messages (sender_id);

create index if not exists user_badges_badge_id_idx
  on public.user_badges (badge_id);

create index if not exists promo_codes_created_by_idx
  on public.promo_codes (created_by);

create index if not exists promo_redemptions_order_id_idx
  on public.promo_redemptions (order_id);

create index if not exists promo_redemptions_user_id_idx
  on public.promo_redemptions (user_id);

create index if not exists event_reviews_user_id_idx
  on public.event_reviews (user_id);

create index if not exists event_boosts_organization_id_idx
  on public.event_boosts (organization_id);

create index if not exists event_boosts_order_id_idx
  on public.event_boosts (order_id);

create index if not exists event_boosts_created_by_idx
  on public.event_boosts (created_by);

create index if not exists orders_promo_code_id_idx
  on public.orders (promo_code_id);

create index if not exists event_boosts_package_code_idx
  on public.event_boosts (package_code);

create index if not exists event_boosts_buyer_id_idx
  on public.event_boosts (buyer_id);

create index if not exists platform_settings_updated_by_idx
  on public.platform_settings (updated_by);

create index if not exists email_deliveries_user_id_idx
  on public.email_deliveries (user_id);

create index if not exists email_deliveries_order_id_idx
  on public.email_deliveries (order_id);

create index if not exists email_deliveries_event_id_idx
  on public.email_deliveries (event_id);

create index if not exists cart_items_event_id_idx
  on public.cart_items (event_id);

create index if not exists checkouts_event_id_idx
  on public.checkouts (event_id);

create index if not exists checkouts_organization_id_idx
  on public.checkouts (organization_id);

create index if not exists checkouts_promo_code_id_idx
  on public.checkouts (promo_code_id);

create index if not exists marketing_settings_updated_by_idx
  on public.marketing_settings (updated_by);

create index if not exists legal_acceptances_countersigned_by_idx
  on public.legal_acceptances (countersigned_by);

create index if not exists venue_maps_created_by_idx
  on public.venue_maps (created_by);

create index if not exists events_venue_map_id_idx
  on public.events (venue_map_id);

create index if not exists boost_credits_boost_id_idx
  on public.boost_credits (boost_id);

create index if not exists boost_credits_event_id_idx
  on public.boost_credits (event_id);

create index if not exists organizations_payout_tier_idx
  on public.organizations (payout_tier);

create index if not exists organizations_payout_tier_override_idx
  on public.organizations (payout_tier_override);

create index if not exists payment_disputes_event_id_idx
  on public.payment_disputes (event_id);

create index if not exists payouts_event_id_idx
  on public.payouts (event_id);

create index if not exists event_claims_organization_id_idx
  on public.event_claims (organization_id);

create index if not exists event_claims_claimed_by_idx
  on public.event_claims (claimed_by);

create index if not exists event_claims_decided_by_idx
  on public.event_claims (decided_by);

create index if not exists tickets_issued_by_idx
  on public.tickets (issued_by);

create index if not exists tickets_deactivated_by_idx
  on public.tickets (deactivated_by);

create index if not exists connect_dismissals_dismissed_id_idx
  on public.connect_dismissals (dismissed_id);

create index if not exists profile_views_viewer_id_idx
  on public.profile_views (viewer_id);

create index if not exists venue_maps_updated_by_idx
  on public.venue_maps (updated_by);

create index if not exists email_campaigns_event_id_idx
  on public.email_campaigns (event_id);

create index if not exists email_campaigns_created_by_idx
  on public.email_campaigns (created_by);

create index if not exists ticket_waitlist_user_id_idx
  on public.ticket_waitlist (user_id);

create index if not exists venue_plan_requests_organization_id_idx
  on public.venue_plan_requests (organization_id);

create index if not exists venue_plan_requests_requested_by_idx
  on public.venue_plan_requests (requested_by);

create index if not exists venue_plan_requests_handled_by_idx
  on public.venue_plan_requests (handled_by);
