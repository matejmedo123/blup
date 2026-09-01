import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  applicationPositions,
  applications,
  availabilities,
  crewScores,
  eventMembers,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";

import { eventDayKey } from "@/lib/format";
import { ACTIVE_ASSIGNMENT_STATUSES, shiftDurationHours } from "./shifts";

export type Candidate = {
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  score: number;
  assignedHours: number;
  maxHours: number | null;
  prefersPosition: boolean;
  hasExperience: boolean;
  available: boolean;
  /** Prečo kandidát nemôže byť pridelený — prázdne pole znamená, že môže. */
  blockers: string[];
  fit: number;
};

export type Proposal = {
  shiftId: string;
  positionName: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  alreadyFilled: number;
  needed: number;
  picked: Candidate[];
  /** Kandidáti, ktorí sa nezmestili, ale sú použiteľní — admin ich vie doplniť. */
  alternates: Candidate[];
  shortfall: number;
};

/**
 * Váhy návrhu. Skóre je len jeden z faktorov — nikdy nie jediný (§23).
 * Preferencia pozície a dostupnosť vážia viac než skóre.
 */
const WEIGHTS = {
  positionPreference: 40,
  availability: 30,
  experience: 15,
  score: 20,
  /** Penalizácia za už naplánované hodiny — rozdeľuje prácu rovnomernejšie. */
  loadPenalty: 1.5,
};

type ScheduledInterval = { startsAt: Date; endsAt: Date; hours: number };

/**
 * Vytvorí návrh obsadenia. **Nič nezapisuje** — admin ho musí potvrdiť (§17).
 */
export async function buildAssignmentProposals(
  eventId: string,
  shiftIds: string[],
): Promise<Proposal[]> {
  const db = await getDb();
  if (shiftIds.length === 0) return [];

  const shiftRows = await db
    .select({
      id: shifts.id,
      positionId: shifts.positionId,
      positionName: positions.name,
      positionSlug: positions.slug,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      capacity: shifts.capacity,
      requiredSkills: positions.requiredSkills,
    })
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(
      and(eq(shifts.eventId, eventId), inArray(shifts.id, shiftIds), isNull(shifts.deletedAt)),
    )
    .orderBy(shifts.startsAt);

  if (shiftRows.length === 0) return [];

  const crew = await db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      score: sql<number>`coalesce(${crewScores.score}, 70)::int`,
    })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .leftJoin(crewScores, and(eq(crewScores.userId, users.id), eq(crewScores.eventId, eventId)))
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.active, true),
        eq(eventMembers.role, "staff"),
        eq(users.status, "active"),
        isNull(users.deletedAt),
      ),
    );

  if (crew.length === 0) {
    return shiftRows.map((shift) => ({
      shiftId: shift.id,
      positionName: shift.positionName,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      capacity: shift.capacity,
      alreadyFilled: 0,
      needed: shift.capacity,
      picked: [],
      alternates: [],
      shortfall: shift.capacity,
    }));
  }

  const userIds = crew.map((c) => c.userId);

  const [preferenceRows, availabilityRows, existingAssignments] = await Promise.all([
    db
      .select({ userId: applications.userId, positionKey: applicationPositions.positionKey })
      .from(applicationPositions)
      .innerJoin(applications, eq(applications.id, applicationPositions.applicationId))
      .where(and(eq(applications.eventId, eventId), inArray(applications.userId, userIds))),
    db
      .select({
        userId: availabilities.userId,
        day: availabilities.day,
        timeFrom: availabilities.timeFrom,
        timeTo: availabilities.timeTo,
        maxHours: availabilities.maxHours,
      })
      .from(availabilities)
      .where(and(eq(availabilities.eventId, eventId), inArray(availabilities.userId, userIds))),
    db
      .select({
        userId: shiftAssignments.userId,
        shiftId: shifts.id,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
      })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .where(
        and(
          eq(shiftAssignments.eventId, eventId),
          inArray(shiftAssignments.status, ACTIVE_ASSIGNMENT_STATUSES),
          isNull(shifts.deletedAt),
        ),
      ),
  ]);

  const preferencesByUser = new Map<string, Set<string>>();
  for (const row of preferenceRows) {
    const set = preferencesByUser.get(row.userId) ?? new Set<string>();
    set.add(row.positionKey);
    preferencesByUser.set(row.userId, set);
  }

  const availabilityByUser = new Map<string, typeof availabilityRows>();
  const maxHoursByUser = new Map<string, number | null>();
  for (const row of availabilityRows) {
    const list = availabilityByUser.get(row.userId) ?? [];
    list.push(row);
    availabilityByUser.set(row.userId, list);
    if (row.maxHours != null) maxHoursByUser.set(row.userId, row.maxHours);
  }

  // Rozvrh sa v priebehu návrhu dopĺňa — druhá smena už vidí prvú.
  const scheduleByUser = new Map<string, ScheduledInterval[]>();
  const assignedByShift = new Map<string, Set<string>>();
  for (const row of existingAssignments) {
    const list = scheduleByUser.get(row.userId) ?? [];
    list.push({
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      hours: (row.endsAt.getTime() - row.startsAt.getTime()) / 3_600_000,
    });
    scheduleByUser.set(row.userId, list);

    const set = assignedByShift.get(row.shiftId) ?? new Set<string>();
    set.add(row.userId);
    assignedByShift.set(row.shiftId, set);
  }

  const proposals: Proposal[] = [];

  for (const shift of shiftRows) {
    const alreadyAssigned = assignedByShift.get(shift.id) ?? new Set<string>();
    const needed = Math.max(0, shift.capacity - alreadyAssigned.size);
    const duration = shiftDurationHours(shift);

    const candidates: Candidate[] = crew
      .filter((person) => !alreadyAssigned.has(person.userId))
      .map((person) => {
        const schedule = scheduleByUser.get(person.userId) ?? [];
        const assignedHours = schedule.reduce((sum, item) => sum + item.hours, 0);
        const maxHours = maxHoursByUser.get(person.userId) ?? null;

        const blockers: string[] = [];
        if (schedule.some((item) => overlaps(item, shift))) {
          blockers.push("časový konflikt s inou smenou");
        }
        if (maxHours != null && assignedHours + duration > maxHours) {
          blockers.push(`prekročí limit ${maxHours} h`);
        }

        const available = isAvailable(availabilityByUser.get(person.userId) ?? [], shift);
        const prefersPosition =
          preferencesByUser.get(person.userId)?.has(shift.positionSlug) ??
          preferencesByUser.get(person.userId)?.has(normaliseKey(shift.positionName)) ??
          false;
        const hasExperience = prefersPosition;

        const fit =
          (prefersPosition ? WEIGHTS.positionPreference : 0) +
          (available ? WEIGHTS.availability : 0) +
          (hasExperience ? WEIGHTS.experience : 0) +
          (Number(person.score) / 100) * WEIGHTS.score -
          assignedHours * WEIGHTS.loadPenalty;

        return {
          userId: person.userId,
          firstName: person.firstName,
          lastName: person.lastName,
          avatarUrl: person.avatarUrl,
          score: Number(person.score),
          assignedHours: Math.round(assignedHours * 10) / 10,
          maxHours,
          prefersPosition,
          hasExperience,
          available,
          blockers,
          fit: Math.round(fit * 10) / 10,
        };
      })
      .sort((a, b) => b.fit - a.fit);

    const eligible = candidates.filter((c) => c.blockers.length === 0);
    const picked = eligible.slice(0, needed);
    const alternates = eligible.slice(needed, needed + 5);

    // Vybraných zapíšeme do priebežného rozvrhu — ďalšia smena už s nimi ráta.
    for (const candidate of picked) {
      const list = scheduleByUser.get(candidate.userId) ?? [];
      list.push({ startsAt: shift.startsAt, endsAt: shift.endsAt, hours: duration });
      scheduleByUser.set(candidate.userId, list);
    }

    proposals.push({
      shiftId: shift.id,
      positionName: shift.positionName,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      capacity: shift.capacity,
      alreadyFilled: alreadyAssigned.size,
      needed,
      picked,
      alternates,
      shortfall: Math.max(0, needed - picked.length),
    });
  }

  return proposals;
}

function overlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}

function normaliseKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Dostupnosť je uložená po dňoch s časovým rozsahom v pásme eventu. */
function isAvailable(
  slots: { day: string; timeFrom: string; timeTo: string }[],
  shift: { startsAt: Date; endsAt: Date },
): boolean {
  if (slots.length === 0) return false;
  const day = eventDayKey(shift.startsAt);
  const slot = slots.find((s) => s.day === day);
  if (!slot) return false;

  const shiftStart = timeToMinutes(
    new Intl.DateTimeFormat("sv-SE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Europe/Bratislava",
    }).format(shift.startsAt),
  );
  const from = timeToMinutes(slot.timeFrom);
  const to = timeToMinutes(slot.timeTo);
  // Nočná smena (koniec po polnoci) — stačí, že začiatok padne do okna.
  return shiftStart >= from && shiftStart <= to;
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
