import { supabase } from '@/lib/supabase';
import type { BadgeProgress, Gamification } from '@/types/models';

/**
 * XP, levels, streaks and badges.
 *
 * Everything here is read-only from the app's side: points are written by
 * database triggers on the rows that prove the action happened. The one call
 * that writes is touch_activity(), and all it records is "this account was
 * open today" — the streak logic and its daily cap live in SQL.
 */

export async function getGamification(userId?: string): Promise<Gamification> {
  const { data, error } = await supabase.rpc('gamification_for', {
    p_user: userId ?? undefined,
  });
  if (error) throw error;
  return data as Gamification;
}

/**
 * Re-checks which badges are earned, then returns the catalogue.
 *
 * The check runs first because most of the newer badges — reviews written,
 * people followed, communities joined, cities you have actually been to — are
 * counted from real rows rather than from a column on user_stats, so nothing
 * on those paths triggers an evaluation. Without this the badge would appear
 * only at the next unrelated bit of activity, which reads as it never arriving.
 *
 * It cannot award a badge somebody has not earned: the thresholds are checked
 * by the same database function as always.
 */
export async function checkMyBadges(): Promise<number> {
  const { data, error } = await supabase.rpc('check_my_badges');
  if (error) throw error;
  return Number(data ?? 0);
}

export async function getBadgeProgress(): Promise<BadgeProgress[]> {
  // Deliberately swallowed: a failed re-check must never be the reason the
  // badge screen shows nothing. The catalogue below is still the truth, just
  // possibly one activity behind.
  try {
    await checkMyBadges();
  } catch {
    // See above.
  }

  const { data, error } = await supabase.rpc('badge_progress');
  if (error) throw error;
  return (data ?? []) as BadgeProgress[];
}

/**
 * Records today's visit and returns the streak. Safe to call on every launch —
 * the database counts a day only once.
 */
export async function touchActivity(): Promise<{ streak: number; xp_awarded: number } | null> {
  const { data, error } = await supabase.rpc('touch_activity');
  if (error) throw error;

  const rows = (data ?? []) as { streak: number; xp_awarded: number }[];
  return rows[0] ?? null;
}

/** How far through the current level, 0–1. */
export function levelProgress(state: Gamification | undefined | null): number {
  if (!state) return 0;
  const span = state.level_ceiling - state.level_floor;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (state.xp - state.level_floor) / span));
}

/** XP still needed for the next level. */
export function xpToNextLevel(state: Gamification | undefined | null): number {
  if (!state) return 0;
  return Math.max(0, state.level_ceiling - state.xp);
}

/** The Slovak name shown next to a level. Cosmetic, derived from the level. */
export function levelTitle(level: number): string {
  if (level >= 20) return 'Legenda';
  if (level >= 15) return 'Ikona scény';
  if (level >= 10) return 'Stálica';
  if (level >= 7) return 'Domáci';
  if (level >= 5) return 'Skúsený';
  if (level >= 3) return 'Objaviteľ';
  if (level >= 2) return 'Nováčik';
  return 'Prvý krok';
}
