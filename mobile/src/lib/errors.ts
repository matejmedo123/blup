import { FunctionError } from './supabase';

/**
 * Turns any thrown value into a message a user can act on.
 *
 * The database raises stable error codes (SOLD_OUT, ORGANIZATION_NOT_VERIFIED,
 * …) and the Edge Functions forward them, so the app can explain what happened
 * instead of showing "something went wrong".
 */
const MESSAGES: Record<string, string> = {
  // auth
  'Invalid login credentials': 'That email and password combination is not right.',
  'Email not confirmed': 'Confirm your email first — check your inbox for the link.',
  'User already registered': 'That email already has an account. Try signing in.',
  UNAUTHENTICATED: 'Your session expired. Please sign in again.',

  // events
  EVENT_AT_CAPACITY: 'This event is full.',
  EVENT_NOT_AVAILABLE: 'This event is no longer available.',
  PAID_EVENT_REQUIRES_ORGANIZATION:
    'Selling tickets needs an organizer account. Create one in Profile → Organizer.',
  ORGANIZATION_NOT_VERIFIED:
    'Your organization must be verified by BLUP before you can sell tickets.',

  // ticketing
  SOLD_OUT: 'These tickets are sold out.',
  QUANTITY_ABOVE_LIMIT: 'That is more tickets than this event allows per order.',
  SALES_ENDED: 'Ticket sales for this event have ended.',
  SALES_NOT_STARTED: 'Ticket sales have not started yet.',
  TICKET_TYPE_INACTIVE: 'This ticket is no longer on sale.',
  AMOUNT_MISMATCH: 'The payment amount did not match the order. You were not charged.',

  // payouts
  INSUFFICIENT_AVAILABLE_BALANCE: 'That is more than your available balance.',
  PAYOUTS_NOT_ENABLED: 'Finish payout onboarding before withdrawing.',

  // configuration
  PAYMENT_PROVIDER_NOT_CONFIGURED:
    'Payments are not configured on this deployment yet. Add your Stripe keys to enable checkout.',
  APPLE_IAP_NOT_CONFIGURED:
    'Premium purchases are not configured on this deployment yet.',
  AI_NOT_CONFIGURED:
    'The AI explanation service is not configured. Recommendations still work — they use the built-in ranker.',
  SUPABASE_NOT_CONFIGURED: 'The backend is not configured for this build.',

  // generic
  NOT_AUTHORIZED: 'You do not have permission to do that.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  CREW_FULL: 'This crew is already full.',
  NETWORK: 'No connection. Check your internet and try again.',
};

export function messageFor(error: unknown): string {
  if (!error) return 'Something went wrong.';

  if (error instanceof FunctionError) {
    return MESSAGES[error.code] ?? error.message ?? 'Something went wrong.';
  }

  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : ((error as { message?: string }).message ?? '');

  // Exact match first, then substring (Postgres wraps codes in a longer message).
  if (MESSAGES[raw]) return MESSAGES[raw];

  for (const [code, message] of Object.entries(MESSAGES)) {
    if (raw.includes(code)) return message;
  }

  if (/network request failed|fetch failed/i.test(raw)) return MESSAGES.NETWORK;

  return raw || 'Something went wrong.';
}

/** True when the failure is "this deployment has no credentials for that". */
export function isConfigurationError(error: unknown): boolean {
  const code = error instanceof FunctionError ? error.code : String((error as Error)?.message ?? '');
  return code.includes('NOT_CONFIGURED');
}
