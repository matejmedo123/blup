import { supabase } from '@/lib/supabase';

/**
 * Pozvánky.
 *
 * The rule that makes this worth having rather than a bounty on making
 * accounts: nothing is paid for a signup. An invite counts when the invited
 * person has confirmed their address and has actually done something — bought a
 * ticket, or turned up. Ten a month, per inviter.
 */
export interface InviteSummary {
  code: string | null;
  invited: number;
  /** How many of them actually arrived — the number that was paid for. */
  arrived: number;
  xp_each: number;
  people: {
    name: string | null;
    username: string | null;
    avatar_url: string | null;
    arrived: boolean;
    joined_at: string;
  }[];
  /** Who invited you, if anybody did. */
  came_from: string | null;
}

export async function getMyInvites(): Promise<InviteSummary> {
  const { data, error } = await supabase.rpc('my_invites');
  if (error) throw error;
  return data as InviteSummary;
}

/** Makes the code on first use, so an unused one is never allocated. */
export async function getMyInviteCode(): Promise<string> {
  const { data, error } = await supabase.rpc('my_invite_code');
  if (error) throw error;
  return data as string;
}

export async function claimInvite(code: string): Promise<{ inviter: string | null }> {
  const { data, error } = await supabase.rpc('claim_invite', { p_code: code });
  if (error) throw error;
  return data as { inviter: string | null };
}

/** The link that goes in a message. The code is also typeable, for a screenshot. */
export function inviteLink(code: string): string {
  return `https://blup.sk/pozvanka/${encodeURIComponent(code)}`;
}
