import "server-only";

import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { crewScores, scoreRules, scoreTransactions } from "@/db/schema";

export const STARTING_SCORE = 70;
export const MIN_SCORE = 0;
export const MAX_SCORE = 100;

/** Predvolené pravidlá — admin ich môže meniť v `/admin/score` (§23). */
export const DEFAULT_SCORE_RULES = [
  { key: "on_time", label: "Príchod načas", delta: 10 },
  { key: "shift_confirmed", label: "Potvrdenie smeny", delta: 5 },
  { key: "positive_rating", label: "Pozitívne hodnotenie", delta: 5 },
  { key: "late", label: "Neskorý príchod", delta: -10 },
  { key: "no_show", label: "Neprišiel na smenu", delta: -20 },
  { key: "late_cancel", label: "Zrušenie na poslednú chvíľu", delta: -5 },
  { key: "incident_high", label: "Vážny incident", delta: -15 },
] as const;

export type ScoreRuleKey = (typeof DEFAULT_SCORE_RULES)[number]["key"] | (string & {});

export async function ensureScoreRules(eventId: string, tx?: Database): Promise<void> {
  const db = tx ?? (await getDb());
  const existing = await db
    .select({ key: scoreRules.key })
    .from(scoreRules)
    .where(eq(scoreRules.eventId, eventId));
  const known = new Set(existing.map((r) => r.key));
  const missing = DEFAULT_SCORE_RULES.filter((rule) => !known.has(rule.key));
  if (missing.length === 0) return;
  await db.insert(scoreRules).values(missing.map((rule) => ({ ...rule, eventId })));
}

export async function getScoreRules(eventId: string) {
  const db = await getDb();
  return db
    .select()
    .from(scoreRules)
    .where(eq(scoreRules.eventId, eventId))
    .orderBy(desc(scoreRules.delta));
}

export async function getCrewScore(userId: string, eventId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ score: crewScores.score })
    .from(crewScores)
    .where(and(eq(crewScores.userId, userId), eq(crewScores.eventId, eventId)))
    .limit(1);
  return row?.score ?? STARTING_SCORE;
}

export async function ensureCrewScore(
  userId: string,
  eventId: string,
  tx?: Database,
): Promise<void> {
  const db = tx ?? (await getDb());
  const [existing] = await db
    .select({ id: crewScores.id })
    .from(crewScores)
    .where(and(eq(crewScores.userId, userId), eq(crewScores.eventId, eventId)))
    .limit(1);
  if (existing) return;
  await db.insert(crewScores).values({ userId, eventId, score: STARTING_SCORE });
}

/**
 * Aplikuje pravidlo skóre. Vždy vytvorí `score_transactions` záznam
 * a udrží výsledné skóre v rozsahu 0–100.
 */
export async function applyScoreRule(args: {
  userId: string;
  eventId: string;
  ruleKey: ScoreRuleKey;
  reason?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string | null;
  /** Prebije `delta` z pravidla (manuálna korekcia adminom). */
  overrideDelta?: number;
  tx?: Database;
}): Promise<{ delta: number; score: number } | null> {
  const db = args.tx ?? (await getDb());

  let delta = args.overrideDelta;
  if (delta === undefined) {
    const [rule] = await db
      .select({ delta: scoreRules.delta, active: scoreRules.active })
      .from(scoreRules)
      .where(and(eq(scoreRules.eventId, args.eventId), eq(scoreRules.key, args.ruleKey)))
      .limit(1);
    if (!rule) {
      const fallback = DEFAULT_SCORE_RULES.find((r) => r.key === args.ruleKey);
      if (!fallback) return null;
      delta = fallback.delta;
    } else {
      if (!rule.active) return null;
      delta = rule.delta;
    }
  }

  await ensureCrewScore(args.userId, args.eventId, db);

  const [current] = await db
    .select({ score: crewScores.score })
    .from(crewScores)
    .where(and(eq(crewScores.userId, args.userId), eq(crewScores.eventId, args.eventId)))
    .limit(1);

  const previous = current?.score ?? STARTING_SCORE;
  const next = Math.max(MIN_SCORE, Math.min(MAX_SCORE, previous + delta));
  const effectiveDelta = next - previous;

  await db
    .update(crewScores)
    .set({ score: next, updatedAt: new Date() })
    .where(and(eq(crewScores.userId, args.userId), eq(crewScores.eventId, args.eventId)));

  await db.insert(scoreTransactions).values({
    userId: args.userId,
    eventId: args.eventId,
    ruleKey: args.ruleKey,
    delta: effectiveDelta,
    reason: args.reason ?? null,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
    actorId: args.actorId ?? null,
  });

  return { delta: effectiveDelta, score: next };
}

export async function scoreHistory(userId: string, eventId: string) {
  const db = await getDb();
  return db
    .select()
    .from(scoreTransactions)
    .where(and(eq(scoreTransactions.userId, userId), eq(scoreTransactions.eventId, eventId)))
    .orderBy(desc(scoreTransactions.createdAt))
    .limit(50);
}
