/**
 * Application models — the shapes the app actually consumes.
 *
 * These mirror the SQL schema in supabase/migrations. Once you have a live
 * project you can also generate the exhaustive database types with:
 *   npx supabase gen types typescript --project-id <id> > src/types/database.ts
 * and layer them on top; these hand-written models stay the app-facing contract.
 */

export type AppRole = 'user' | 'moderator' | 'admin';
export type EventStatus = 'draft' | 'published' | 'cancelled' | 'completed';
export type EventVisibility = 'public' | 'followers' | 'private' | 'unlisted';
export type AttendeeStatus = 'going' | 'interested' | 'waitlist' | 'cancelled' | 'checked_in';
export type OrgRole = 'owner' | 'admin' | 'event_manager' | 'finance';
export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type PaymentStatus =
  | 'requires_payment' | 'processing' | 'succeeded' | 'failed' | 'refunded' | 'cancelled';
export type TicketStatus = 'valid' | 'used' | 'refunded' | 'cancelled';
export type PayoutStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled';
export type SubscriptionStatus =
  | 'active' | 'trialing' | 'grace_period' | 'expired' | 'cancelled' | 'revoked';
export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';

export type SignalType =
  | 'impression' | 'open_detail' | 'swipe_right' | 'swipe_left' | 'save' | 'unsave'
  | 'rsvp_going' | 'rsvp_interested' | 'rsvp_cancel' | 'like' | 'unlike' | 'comment'
  | 'share' | 'ticket_purchase' | 'attended';

export type NotificationType =
  | 'new_follower' | 'friend_request' | 'friend_accepted' | 'event_reminder'
  | 'event_starting_soon' | 'event_updated' | 'event_cancelled' | 'friend_attending'
  | 'ticket_purchased' | 'ticket_confirmed' | 'payout_update' | 'org_verified'
  | 'org_rejected' | 'weekly_recommendations' | 'new_comment' | 'event_full'
  | 'new_message' | 'badge_earned' | 'level_up';

export interface Profile {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  location_updated_at: string | null;
  app_role: AppRole;
  is_private: boolean;
  show_location: boolean;
  anonymous_mode: boolean;
  allow_dm: boolean;
  onboarding_completed: boolean;
  is_suspended: boolean;
  suspended_reason: string | null;
  locale: string;
  created_at: string;
  updated_at: string;
}

export interface Interest {
  id: string;
  slug: string;
  name: string;
  category: string;
  emoji: string | null;
  sort_order: number;
}

/** Row shape returned by events_nearby / search_events / recommend_events. */
export interface EventFeedItem {
  id: string;
  /** Readable address; null only for a row written before slugs existed. */
  slug: string | null;
  title: string;
  description: string | null;
  cover_image_url: string | null;
  category: string;
  tags: string[];
  latitude: number;
  longitude: number;
  address: string | null;
  venue_name: string | null;
  city: string | null;
  start_at: string;
  end_at: string | null;
  is_free: boolean;
  price_cents: number;
  currency: string;
  capacity: number | null;
  attendee_count: number;
  saved_count: number;
  like_count: number;
  comment_count: number;
  status: EventStatus;
  visibility: EventVisibility;
  creator_id: string;
  creator_username: string | null;
  creator_display_name: string | null;
  creator_avatar_url: string | null;
  organization_id: string | null;
  organization_name: string | null;
  organization_verified: boolean | null;
  distance_m: number | null;
  friends_going: number;
  is_saved: boolean;
  is_attending: boolean;
  score: number | null;
  score_breakdown: ScoreBreakdown | null;
  /** Added by the ai-recommendations function. */
  explanation?: string;
}

export interface ScoreBreakdown {
  engine: string;
  final_score: number;
  /** Which component carried the score — see reasonLabel() for the wording. */
  reason?: string;
  components: {
    interest_match: number;
    distance_score: number;
    social_relevance: number;
    past_behaviour: number;
    popularity: number;
    time_relevance: number;
    /** Paid visibility. Present only when a boost is live. */
    boost?: number;
  };
  weights: Record<string, number>;
  facts: {
    interest_hits: number;
    friends_going: number;
    follows_creator: boolean;
    distance_m: number;
    category_affinity: number;
    is_boosted?: boolean;
  };
}

export interface BlupEvent {
  id: string;
  /** Readable address; null only for a row written before slugs existed. */
  slug: string | null;
  /** Set when the event sells by sector or seat; null for everything else. */
  venue_map_id?: string | null;
  creator_id: string;
  organization_id: string | null;
  title: string;
  description: string | null;
  cover_image_url: string | null;
  category: string;
  tags: string[];
  latitude: number;
  longitude: number;
  address: string | null;
  venue_name: string | null;
  city: string | null;
  country: string | null;
  start_at: string;
  end_at: string | null;
  timezone: string;
  capacity: number | null;
  is_free: boolean;
  price_cents: number;
  currency: string;
  status: EventStatus;
  visibility: EventVisibility;
  attendee_count: number;
  interested_count: number;
  saved_count: number;
  like_count: number;
  comment_count: number;
  view_count: number;
  tickets_sold: number;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  cover_url: string | null;
  description: string | null;
  website: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  country: string | null;
  city: string | null;
  verification_status: VerificationStatus;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  platform_fee_bps: number;
  default_currency: string;
  created_by: string;
  created_at: string;
}

export interface OrganizationBalance {
  organization_id: string;
  currency: string;
  balance_cents: number;
  available_cents: number;
  pending_cents: number;
  gross_sales_cents: number;
  platform_fee_cents: number;
  paid_out_cents: number;
}

export interface TicketType {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  quantity_total: number;
  quantity_sold: number;
  max_per_order: number;
  sales_start_at: string | null;
  sales_end_at: string | null;
  is_active: boolean;
}

export interface Ticket {
  id: string;
  order_id: string | null;
  event_id: string;
  ticket_type_id: string | null;
  buyer_id: string;
  holder_name: string | null;
  code: string;
  qr_secret: string;
  status: TicketStatus;
  price_cents: number;
  currency: string;
  checked_in_at: string | null;
  created_at: string;
}

export interface TicketWithEvent extends Ticket {
  event: Pick<BlupEvent, 'id' | 'title' | 'start_at' | 'venue_name' | 'address' | 'cover_image_url'> | null;
}

export interface Order {
  id: string;
  event_id: string;
  organization_id: string | null;
  ticket_type_id: string;
  buyer_id: string;
  quantity: number;
  unit_price_cents: number;
  /** List price × quantity, before any discount. */
  subtotal_cents: number;
  discount_cents: number;
  /** subtotal − discount: the ticket revenue the sale is actually worth. */
  net_cents: number;
  /** BLUP's percentage of `net_cents`. */
  commission_cents: number;
  /** BLUP's per-ticket fee. Free tickets carry none. */
  archive_fee_cents: number;
  archive_fee_payer: 'buyer' | 'organizer';
  /** What is deducted from the organizer — commission, plus the archive fee
   *  only when the organizer is the one carrying it. */
  platform_fee_cents: number;
  /** commission + archive fee, whoever was billed for them. */
  blup_revenue_cents: number;
  /** What the buyer is charged. */
  total_cents: number;
  currency: string;
  payment_status: PaymentStatus;
  created_at: string;
}

export interface Payout {
  id: string;
  organization_id: string;
  amount_cents: number;
  currency: string;
  status: PayoutStatus;
  provider_transfer_id: string | null;
  requested_at: string;
  processed_at: string | null;
  failure_reason: string | null;
}

export interface AppNotification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  actor_id: string | null;
  event_id: string | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface Comment {
  id: string;
  user_id: string;
  event_id: string | null;
  body: string;
  is_deleted: boolean;
  created_at: string;
  author?: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_url'> | null;
}

export interface PeopleMatch {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  shared_interests: number;
  shared_interest_names: string[];
  mutual_events: number;
  mutual_follows: number;
  same_event: boolean;
  distance_m: number | null;
  score: number;
  score_breakdown: Record<string, unknown>;
}

export interface PremiumStatus {
  is_premium: boolean;
  status: string;
  platform?: string;
  product_id?: string;
  expires_at?: string | null;
  auto_renew?: boolean;
}

export interface EventAnalytics {
  event_id: string;
  title: string;
  is_free: boolean;
  /** Not free, and at least one active ticket type exists. */
  sells_tickets: boolean;
  /** Has sold before — keeps the money section for an event whose sale is over. */
  has_sales: boolean;
  views: number;
  unique_viewers: number;
  saves: number;
  likes: number;
  comments: number;
  rsvp_going: number;
  rsvp_interested: number;
  checked_in: number;
  tickets_sold: number;
  conversion_rate: number;
  /** List price of everything sold, before promo discounts. */
  gross_revenue_cents: number;
  discount_cents: number;
  /** gross − discounts: what the tickets were actually sold for. */
  net_revenue_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  /** Deducted from the organizer. Excludes a buyer-paid archive fee. */
  platform_fee_cents: number;
  organizer_net_cents: number;
  /** Everything the buyers handed over, archive fee included. */
  buyers_paid_cents: number;
  currency: string;
}

export interface PlatformStats {
  users: number;
  suspended_users: number;
  events: number;
  published_events: number;
  organizations: number;
  pending_verifications: number;
  tickets: number;
  open_reports: number;
  gross_sales_cents: number;
  /** Ticket revenue after promo discounts. */
  net_sales_cents: number;
  /** BLUP's percentage of ticket sales. */
  commission_cents: number;
  /** BLUP's per-ticket archive fee. */
  archive_fee_cents: number;
  boost_revenue_cents: number;
  /** commission + archive fees + boosts */
  platform_revenue_cents: number;
  pending_payouts: number;
  premium_users: number;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

// --- messaging --------------------------------------------------------------

export type ConversationKind = 'direct' | 'event';

/** One row of the inbox, as returned by my_conversations(). */
export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  event_id: string | null;
  title: string | null;
  last_message_at: string | null;
  last_message: string | null;
  last_sender_id: string | null;
  unread_count: number;
  muted: boolean;
  other_user_id: string | null;
  other_name: string | null;
  other_username: string | null;
  other_avatar_url: string | null;
  participant_count: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  body: string | null;
  attachment_url: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  sender?: {
    id: string;
    display_name: string | null;
    username: string | null;
    avatar_url: string | null;
  } | null;
}

export interface ConversationParticipant {
  conversation_id: string;
  user_id: string;
  joined_at: string;
  last_read_at: string;
  muted: boolean;
  left_at: string | null;
  profile?: Profile | null;
}

// --- gamification -----------------------------------------------------------

export interface EarnedBadge {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  tier: number;
  awarded_at: string;
}

/** The shape returned by gamification_for(). */
export interface Gamification {
  user_id: string;
  xp: number;
  level: number;
  level_floor: number;
  level_ceiling: number;
  events_created: number;
  events_attended: number;
  check_ins: number;
  blups_saved: number;
  streak_days: number;
  longest_streak: number;
  badges: EarnedBadge[];
}

export interface BadgeProgress {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  tier: number;
  threshold: number;
  metric: string;
  progress: number;
  earned: boolean;
  awarded_at: string | null;
}
