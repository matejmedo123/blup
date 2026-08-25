/**
 * Slovak labels for the database enums. The database keeps English identifiers
 * (they are part of the API contract); this file is the only place that turns
 * them into something a person reads, so a wording change is one edit.
 */
import type {
  AttendeeStatus, EventStatus, EventVisibility, OrgRole, PayoutStatus, ReportStatus,
  SubscriptionStatus, TicketStatus, VerificationStatus,
} from '@/types/models';

export const ticketStatusLabel: Record<TicketStatus, string> = {
  valid: 'platná',
  used: 'použitá',
  refunded: 'vrátená',
  cancelled: 'zrušená',
};

export const eventStatusLabel: Record<EventStatus, string> = {
  draft: 'koncept',
  published: 'zverejnený',
  cancelled: 'zrušený',
  completed: 'ukončený',
};

export const visibilityLabel: Record<EventVisibility, string> = {
  public: 'Verejný',
  followers: 'Pre sledujúcich',
  private: 'Súkromný',
  unlisted: 'Cez odkaz',
};

export const attendeeStatusLabel: Record<AttendeeStatus, string> = {
  going: 'idem',
  interested: 'zaujíma ma',
  waitlist: 'čakačka',
  cancelled: 'zrušené',
  checked_in: 'na mieste',
};

export const verificationStatusLabel: Record<VerificationStatus, string> = {
  unverified: 'neoverená',
  pending: 'čaká na overenie',
  verified: 'overená',
  rejected: 'zamietnutá',
};

export const payoutStatusLabel: Record<PayoutStatus, string> = {
  pending: 'čaká',
  processing: 'spracúva sa',
  paid: 'vyplatené',
  failed: 'zlyhalo',
  cancelled: 'zrušené',
};

export const subscriptionStatusLabel: Record<SubscriptionStatus, string> = {
  active: 'aktívne',
  trialing: 'skúšobné obdobie',
  grace_period: 'odklad platby',
  expired: 'vypršalo',
  cancelled: 'zrušené',
  revoked: 'odobraté',
};

export const reportStatusLabel: Record<ReportStatus, string> = {
  open: 'otvorené',
  reviewing: 'v riešení',
  actioned: 'vybavené',
  dismissed: 'zamietnuté',
};

export const orgRoleLabel: Record<OrgRole, string> = {
  owner: 'majiteľ',
  admin: 'admin',
  event_manager: 'event manažér',
  finance: 'financie',
};

/** Looks a label up without blowing up on a value the app does not know yet. */
export function labelOf<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value;
}

/**
 * Why the ranker picked this one, in Slovak.
 *
 * The AI function writes a sentence when a key is configured; the ranker always
 * emits a reason code, so a card can say why it is there whether or not anyone
 * is paying an LLM. Both come from the same score, so they cannot disagree.
 */
const REASON_LABELS: Record<string, string> = {
  friends: 'Idú tvoje kruhy',
  follows: 'Od koho sleduješ',
  interests: 'Podľa tvojich záujmov',
  behaviour: 'Chodievaš na podobné',
  nearby: 'Kúsok od teba',
  soon: 'Už čoskoro',
  popular: 'Chodí tam veľa ľudí',
  promoted: 'Propagované',
  discover: 'Objav niečo nové',
};

export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON_LABELS[reason] ?? null;
}
