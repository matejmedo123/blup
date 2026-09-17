import { supabase } from '@/lib/supabase';

/**
 * "Daj mi vedieť, keď sa uvoľní."
 *
 * A sold-out event is the strongest reason anybody will give you their address:
 * they are not subscribing to anything, they want that ticket. Nothing is
 * reserved when one comes back — we tell exactly as many people as there are
 * tickets, in the order they asked, and the mail says so. Promising a hold we
 * do not enforce would be worse than saying nothing.
 */
export interface WaitlistEntry {
  ticket_type_id: string;
  ticket_type: string;
  event_id: string;
  event_title: string;
  start_at: string;
  wanted: number;
  waiting: number;
  available: number;
  notified_at: string | null;
  joined_at: string;
}

export async function joinWaitlist(input: {
  ticketTypeId: string;
  wanted?: number;
  /** Required when signed out; ignored when the address is already known. */
  email?: string;
}): Promise<{ id: string; ticket_type: string; event_id: string; waiting: number }> {
  const { data, error } = await supabase.rpc('join_waitlist', {
    p_ticket_type_id: input.ticketTypeId,
    p_wanted: input.wanted ?? 1,
    p_email: input.email ?? null,
  });

  if (error) throw error;
  return data as { id: string; ticket_type: string; event_id: string; waiting: number };
}

export async function leaveWaitlist(ticketTypeId: string): Promise<void> {
  const { error } = await supabase.rpc('leave_waitlist', { p_ticket_type_id: ticketTypeId });
  if (error) throw error;
}

/** How many people want this one. Public — it is what makes somebody join. */
export async function getWaitlistSize(ticketTypeId: string): Promise<number> {
  const { data, error } = await supabase.rpc('waitlist_size', { p_ticket_type_id: ticketTypeId });
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function getMyWaitlist(): Promise<WaitlistEntry[]> {
  const { data, error } = await supabase.rpc('my_waitlist');
  if (error) throw error;
  return (data ?? []) as WaitlistEntry[];
}
