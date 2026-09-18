import { supabase } from '@/lib/supabase';

/**
 * Is the database as new as this build?
 *
 * Four bug reports in a row were the same thing wearing different clothes: the
 * web build had been uploaded and the migrations had not. Chat died on a
 * missing column, Blup Connect showed nobody, the waitlist and the invites were
 * simply absent — each looked like its own broken feature, and each was one
 * un-run migration.
 *
 * The app owns this list because the app is the thing that needs the objects.
 * The database only answers what it has.
 */
export interface FeatureNeed {
  key: string;
  label: string;
  /** What to run to get it. */
  migration: string;
  functions?: string[];
  tables?: string[];
  /** "table.column" */
  columns?: string[];
}

export const FEATURES: FeatureNeed[] = [
  {
    key: 'replies',
    label: 'Odpovede v chate',
    migration: '20260101006000_message_replies',
    functions: ['send_message', 'event_trip_pitch'],
    columns: ['messages.reply_to_id'],
  },
  {
    key: 'premium_perks',
    label: 'Premium — farba, pozadie chatu, odznak, dvojnásobné body',
    migration: '20260101006100_premium_perks',
    functions: ['set_premium_look', 'my_look', 'my_profile_views'],
    columns: ['profiles.accent_color', 'profiles.premium_until'],
  },
  {
    key: 'boost',
    label: 'Reklamný systém — rozpočet, rozloženie, report',
    migration: '20260101006200_boost_delivery',
    functions: ['sponsored_events', 'record_boost_event', 'boost_report', 'claim_free_boost'],
    tables: ['boost_events', 'boost_credits'],
  },
  {
    key: 'connect',
    label: 'Blup Connect — ľudia, ktorých naozaj poznáš',
    migration: '20260101006400_connect_v2',
    functions: ['recommend_people', 'community_people_you_may_know', 'dismiss_person'],
    tables: ['connect_dismissals'],
  },
  {
    key: 'seating',
    label: 'Sedenie — miesto zostane na vstupenke',
    migration: '20260101006500_seating_v2',
    functions: ['seat_claims', 'section_seats', 'suggest_seats', 'cart_hold_seats'],
    columns: ['orders.venue_seat_id', 'venue_seats.kind'],
  },
  {
    key: 'mailing',
    label: 'E-maily — súhlas, odhlásenie, rozposielanie',
    migration: '20260101006600_mailing',
    functions: ['can_email', 'email_unsubscribe', 'send_campaign', 'email_queue_stats'],
    tables: ['email_contacts', 'email_campaigns'],
  },
  {
    key: 'waitlist',
    label: 'Čakačka na vypredané a pozvánky',
    migration: '20260101006800_waitlist_and_invites',
    functions: ['join_waitlist', 'notify_waitlists', 'claim_invite', 'my_invites'],
    tables: ['ticket_waitlist', 'invites'],
  },
  {
    key: 'venues',
    label: 'Plány sál — VIP sektory, žiadosti, klonovanie',
    migration: '20260101007000_venue_admin',
    functions: ['request_venue_plan', 'venue_plan_queue', 'clone_venue_map', 'my_seat_holds'],
    tables: ['venue_plan_requests'],
    columns: ['venue_sections.kind'],
  },
  {
    key: 'admin_premium',
    label: 'Admin má Premium; plán sály sa dá zmazať',
    migration: '20260101007100_admin_premium_and_plan_delete',
    functions: ['clear_venue_map_image', 'delete_venue_map'],
  },
];

export interface FeatureStatus extends FeatureNeed {
  ok: boolean;
  missing: string[];
}

export interface DeploymentStatus {
  /** False when the database is older than this build. */
  ready: boolean;
  features: FeatureStatus[];
  /** Set when even the check itself is missing — the database is far behind. */
  checkMissing: boolean;
}

export async function getDeploymentStatus(): Promise<DeploymentStatus> {
  const functions = [...new Set(FEATURES.flatMap((f) => f.functions ?? []))];
  const tables = [...new Set(FEATURES.flatMap((f) => f.tables ?? []))];
  const columns = [...new Set(FEATURES.flatMap((f) => f.columns ?? []))];

  const { data, error } = await supabase.rpc('objects_present', {
    p_functions: functions,
    p_tables: tables,
    p_columns: columns,
  });

  if (error) {
    // The check itself only arrived in 0072. Not finding it is the clearest
    // possible answer to "is the database as new as the app".
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
      return {
        ready: false,
        checkMissing: true,
        features: FEATURES.map((f) => ({ ...f, ok: false, missing: ['—'] })),
      };
    }
    throw error;
  }

  const present = data as {
    functions: Record<string, boolean>;
    tables: Record<string, boolean>;
    columns: Record<string, boolean>;
  };

  const features = FEATURES.map((feature) => {
    const missing = [
      ...(feature.functions ?? []).filter((n) => !present.functions?.[n]).map((n) => `${n}()`),
      ...(feature.tables ?? []).filter((n) => !present.tables?.[n]),
      ...(feature.columns ?? []).filter((n) => !present.columns?.[n]),
    ];
    return { ...feature, ok: missing.length === 0, missing };
  });

  return {
    ready: features.every((f) => f.ok),
    checkMissing: false,
    features,
  };
}
