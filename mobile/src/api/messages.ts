import { supabase } from '@/lib/supabase';
import type { ConversationSummary, Message } from '@/types/models';

/**
 * Messaging.
 *
 * Reads go straight to the tables (RLS restricts them to threads you are in);
 * every write goes through a database function, because the client is not
 * allowed to insert into public.messages at all — that is what stops a forged
 * sender_id.
 */

export async function getConversations(limit = 50): Promise<ConversationSummary[]> {
  const { data, error } = await supabase.rpc('my_conversations', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as ConversationSummary[];
}

export async function getUnreadMessageCount(): Promise<number> {
  const { data, error } = await supabase.rpc('unread_message_count');
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function getMessages(conversationId: string, limit = 100): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(
      '*, sender:profiles!messages_sender_id_fkey (id, display_name, username, avatar_url),'
      // The quoted message comes with the reply, so the bubble can show it
      // without a second round trip per message.
      + ' reply_to:messages!messages_reply_to_id_fkey (id, body, attachment_url, sender_id, deleted_at)',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  // Oldest first for rendering; the query is newest-first so the limit keeps
  // the most recent page.
  return ((data ?? []) as unknown as Message[]).slice().reverse();
}

export async function getConversation(conversationId: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, event:events (id, title, cover_image_url, start_at)')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getParticipants(conversationId: string) {
  const { data, error } = await supabase
    .from('conversation_participants')
    .select('*, profile:profiles (id, display_name, username, avatar_url)')
    .eq('conversation_id', conversationId)
    .is('left_at', null);

  if (error) throw error;
  return data ?? [];
}

/** Opens (or reuses) the 1:1 thread with someone and returns its id. */
export async function startDirectConversation(targetUserId: string): Promise<string> {
  const { data, error } = await supabase.rpc('start_direct_conversation', {
    p_target: targetUserId,
  });
  if (error) throw error;
  return data as string;
}

/** Opens the group chat of an event. Only attendees and the host may. */
export async function joinEventConversation(eventId: string): Promise<string> {
  const { data, error } = await supabase.rpc('join_event_conversation', { p_event: eventId });
  if (error) throw error;
  return data as string;
}

export async function sendMessage(params: {
  conversationId: string;
  body?: string;
  attachmentUrl?: string;
  /** The message being answered. Must be in the same conversation — checked server-side. */
  replyToId?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('send_message', {
    p_conversation: params.conversationId,
    p_body: params.body ?? null,
    p_attachment: params.attachmentUrl ?? null,
    p_reply_to: params.replyToId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_conversation_read', {
    p_conversation: conversationId,
  });
  if (error) throw error;
}

export async function setConversationMuted(
  conversationId: string,
  muted: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('set_conversation_muted', {
    p_conversation: conversationId,
    p_muted: muted,
  });
  if (error) throw error;
}

export async function leaveConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('leave_conversation', { p_conversation: conversationId });
  if (error) throw error;
}

export async function deleteMessage(messageId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_message', { p_message: messageId });
  if (error) throw error;
}
