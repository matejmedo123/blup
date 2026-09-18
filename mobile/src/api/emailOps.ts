import { supabase } from '@/lib/supabase';

/**
 * Prevádzka e-mailov.
 *
 * Existuje preto, že e-mail, ktorý sa odošle a skončí v spame, vyzerá v našich
 * dátach presne ako e-mail, ktorý dorazil. Jediné, čo to odlíši skôr, než sa
 * ozvú ľudia, sú tieto čísla: koľko čaká vo fronte, koľko zlyháva a koľko adries
 * sa odrazilo.
 */

export interface EmailQueueStats {
  budget_per_hour: number;
  sent_last_hour: number;
  sent_today: number;
  waiting: number;
  /** Rows that gave up. Climbing means the provider or the domain, not one address. */
  dead: number;
  by_kind: Record<string, number>;
  contacts: number;
  unsubscribed: number;
  undeliverable: number;
}

export interface EmailHealthDay {
  day: string;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

export interface EmailHealth {
  days: EmailHealthDay[];
  errors: { reason: string; n: number }[];
  sent_7d: number;
  failed_7d: number;
  failure_rate_pct: number;
  bounced: number;
  complained: number;
  last_sent_at: string | null;
}

export async function getEmailQueueStats(): Promise<EmailQueueStats> {
  const { data, error } = await supabase.rpc('email_queue_stats');
  if (error) throw error;
  return data as EmailQueueStats;
}

export async function getEmailHealth(): Promise<EmailHealth> {
  const { data, error } = await supabase.rpc('email_health');
  if (error) throw error;
  return data as EmailHealth;
}

/**
 * Queues a test mail to the signed-in admin's own address.
 *
 * Returns the delivery id, not "sent": this only reaches the queue. Whether it
 * left is what the worker decides, which is the entire point of testing this
 * way instead of calling the provider directly.
 */
export async function sendTestEmail(): Promise<string> {
  const { data, error } = await supabase.rpc('send_test_email');
  if (error) throw error;
  return data as string;
}
