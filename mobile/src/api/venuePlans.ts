import { supabase } from '@/lib/supabase';

/**
 * Žiadosť o plán sály.
 *
 * Seating plans are drawn by BLUP, not by the organizer. That is not
 * gatekeeping for its own sake: a sector ten pixels wrong sells the wrong seat,
 * a sector pointed at the wrong ticket type sells the wrong price, and a stand
 * regenerated mid-sale used to wipe the seat off tickets people had paid for.
 * It is also a couple of hours of careful work with a floor plan open beside
 * you. So the organizer describes the room and we draw it — a support request
 * with a table behind it rather than an e-mail somebody forgets.
 */
export type PlanRequestStatus = 'open' | 'in_progress' | 'done' | 'rejected';

export const PLAN_STATUS_LABEL: Record<PlanRequestStatus, string> = {
  open: 'Čaká na nás',
  in_progress: 'Kreslíme',
  done: 'Hotové',
  rejected: 'Zamietnuté',
};

export interface PlanRequestState {
  id: string;
  status: PlanRequestStatus;
  note: string;
  admin_note: string | null;
  created_at: string;
}

/** What the organizer sees on their own event. Null when they never asked. */
export async function getPlanRequest(eventId: string): Promise<PlanRequestState | null> {
  const { data, error } = await supabase.rpc('venue_plan_request_for_event', { p_event_id: eventId });
  if (error) throw error;
  return (data as PlanRequestState) ?? null;
}

export async function requestVenuePlan(input: {
  eventId: string;
  note: string;
  imageUrl?: string | null;
}): Promise<PlanRequestState> {
  const { data, error } = await supabase.rpc('request_venue_plan', {
    p_event_id: input.eventId,
    p_note: input.note,
    p_image_url: input.imageUrl ?? null,
  });

  if (error) throw error;
  return data as PlanRequestState;
}

export interface PlanQueueRow {
  id: string;
  event_id: string;
  event_title: string;
  start_at: string;
  organization: string | null;
  requested_by: string | null;
  note: string;
  image_url: string | null;
  status: PlanRequestStatus;
  admin_note: string | null;
  /** Whether the event already has a plan attached — the point of the queue. */
  has_plan: boolean;
  created_at: string;
}

export async function getPlanQueue(status?: PlanRequestStatus): Promise<PlanQueueRow[]> {
  const { data, error } = await supabase.rpc('venue_plan_queue', { p_status: status ?? null });
  if (error) throw error;
  return (data ?? []) as PlanQueueRow[];
}

export async function setPlanRequest(
  id: string,
  status: PlanRequestStatus,
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_venue_plan_request', {
    p_id: id,
    p_status: status,
    p_note: note ?? null,
  });

  if (error) throw error;
}
