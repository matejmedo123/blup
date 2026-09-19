import { supabase } from '@/lib/supabase';
import { withOptionalEmbed } from '@/lib/optionalEmbed';
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

const SENDER = 'sender:profiles!messages_sender_id_fkey (id, display_name, username, avatar_url)';

// The quoted message comes with the reply, so the bubble can show it without a
// second round trip per message. It is also the one part of this query that can
// be missing — `messages.reply_to_id` arrived in a later migration, and a
// project that has the new web build but not the new schema cannot resolve it.
// Chat must not go blank over a quote, so the query degrades instead.
const QUOTED =
  'reply_to:messages!messages_reply_to_id_fkey (id, body, attachment_url, sender_id, deleted_at)';

/**
 * Fills in the quoted messages when the embed could not.
 *
 * An embed needs a foreign key PostgREST knows about; fetching the same rows by
 * id needs nothing at all. So when the relationship is missing, the quotes are
 * not lost — they are fetched in one extra query and stitched on here.
 *
 * This matters more than it looks. Without it every reply fell through to the
 * bubble's "the quoted message is gone" branch and rendered **Správa bola
 * zmazaná** — for messages nobody had deleted. The app was stating something
 * untrue, and it was indistinguishable from a real deletion.
 */
async function attachQuotes(messages: Message[]): Promise<Message[]> {
  const wanted = [...new Set(
    messages.filter((m) => m.reply_to_id && !m.reply_to).map((m) => m.reply_to_id as string),
  )];
  if (wanted.length === 0) return messages;

  const { data, error } = await supabase
    .from('messages')
    .select('id, body, attachment_url, sender_id, deleted_at')
    .in('id', wanted);

  // Deliberately swallowed. A quote is worth a second query, not a broken
  // screen — and the bubble already says honestly when it has no quote to show.
  if (error) return messages;

  const byId = new Map((data ?? []).map((row) => [(row as { id: string }).id, row]));
  return messages.map((message) => (
    message.reply_to_id && !message.reply_to && byId.has(message.reply_to_id)
      ? { ...message, reply_to: byId.get(message.reply_to_id) as Message['reply_to'] }
      : message
  ));
}

export async function getMessages(conversationId: string, limit = 100): Promise<Message[]> {
  const rows = (fields: string) => supabase
    .from('messages')
    .select(fields)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  const data = await withOptionalEmbed(
    () => rows(`*, ${SENDER}, ${QUOTED}`),
    () => rows(`*, ${SENDER}`),
  );
  // Oldest first for rendering; the query is newest-first so the limit keeps
  // the most recent page.
  const messages = ((data ?? []) as unknown as Message[]).slice().reverse();
  return attachQuotes(messages);
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
