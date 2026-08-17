import { supabase } from '@/lib/supabase';
import type { AppNotification } from '@/types/models';

export async function getNotifications(limit = 50): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as AppNotification[];
}

export async function getUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .is('read_at', null);

  if (error) throw error;
  return count ?? 0;
}

export async function markAllRead(): Promise<number> {
  const { data, error } = await supabase.rpc('mark_notifications_read', { p_ids: null });
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function markRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids });
  if (error) throw error;
}

export async function deleteNotification(id: string): Promise<void> {
  const { error } = await supabase.from('notifications').delete().eq('id', id);
  if (error) throw error;
}

export interface NotificationPreferences {
  push_enabled: boolean;
  new_follower: boolean;
  friend_requests: boolean;
  event_reminders: boolean;
  friend_attending: boolean;
  ticket_updates: boolean;
  weekly_recommendations: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  push_enabled: true,
  new_follower: true,
  friend_requests: true,
  event_reminders: true,
  friend_attending: true,
  ticket_updates: true,
  weekly_recommendations: true,
};

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return DEFAULT_PREFERENCES;

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return { ...DEFAULT_PREFERENCES, ...(data ?? {}) } as NotificationPreferences;
}

export async function updateNotificationPreferences(
  patch: Partial<NotificationPreferences>,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });

  if (error) throw error;
}
