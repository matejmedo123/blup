import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import type { CheckInSource } from "@/db/enums";
import {
  attendance,
  idempotencyKeys,
  positions,
  shiftAssignments,
  shifts,
} from "@/db/schema";
import { DomainError } from "@/lib/action-result";
import { writeAudit } from "@/lib/audit";
import { signShiftQr } from "@/lib/auth/tokens";
import { channels, realtime } from "@/lib/realtime";

import { applyScoreRule } from "./score";
import { refreshShiftStatus } from "./shifts";

/** Tolerancia pred začiatkom smeny — skorý príchod je v poriadku. */
const EARLY_CHECK_IN_MINUTES = 60;
/** Po tomto čase od začiatku sa check-in počíta ako meškanie. */
const LATE_THRESHOLD_MINUTES = 10;
/** Ako dlho po skončení smeny sa dá ešte checknúť. */
const LATE_CHECK_IN_GRACE_MINUTES = 120;

export type CheckInRequest = {
  shiftId: string;
  /** Koho sa check-in týka. Pri check-ine za iných je to iný človek než actor. */
  targetUserId: string;
  actorId: string;
  eventId: string;
  source: CheckInSource;
  lat?: number | null;
  lng?: number | null;
  qrToken?: string | null;
  device?: Record<string, string> | null;
  ip?: string | null;
  /** Ochrana pred dvojitým zápisom pri retry na slabom pripojení (§73). */
  idempotencyKey?: string | null;
};

export type CheckInResult = {
  attendanceId: string;
  checkInAt: string;
  late: boolean;
  lateMinutes: number;
  /** `true`, keď sa vracia uložená odpoveď na už spracovaný request. */
  replayed: boolean;
};

export type CheckOutResult = {
  attendanceId: string;
  checkOutAt: string;
  workedMinutes: number;
  replayed: boolean;
};

/** Vzdialenosť dvoch bodov na Zemi v metroch (haversine). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

async function replayIdempotent<T>(
  scope: string,
  key: string | null | undefined,
  userId: string,
): Promise<T | null> {
  if (!key) return null;
  const db = await getDb();
  const [row] = await db
    .select({ response: idempotencyKeys.response })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.scope, scope),
        eq(idempotencyKeys.key, key),
        eq(idempotencyKeys.userId, userId),
        sql`${idempotencyKeys.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return (row?.response as T) ?? null;
}

async function storeIdempotent(
  scope: string,
  key: string | null | undefined,
  userId: string,
  response: Record<string, unknown>,
): Promise<void> {
  if (!key) return;
  const db = await getDb();
  await db
    .insert(idempotencyKeys)
    .values({
      scope,
      key,
      userId,
      response,
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    })
    .onConflictDoNothing();
}

/**
 * Check-in na smenu. Validuje pridelenie, čas, QR podpis aj geofence.
 * Dvojitý check-in nie je možný — ani opakovaným requestom (Rule: idempotencia).
 */
export async function performCheckIn(request: CheckInRequest): Promise<CheckInResult> {
  const replayed = await replayIdempotent<CheckInResult>(
    "check-in",
    request.idempotencyKey,
    request.targetUserId,
  );
  if (replayed) return { ...replayed, replayed: true };

  const db = await getDb();

  const [row] = await db
    .select({
      assignmentId: shiftAssignments.id,
      assignmentStatus: shiftAssignments.status,
      shiftId: shifts.id,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      status: shifts.status,
      checkInMethod: shifts.checkInMethod,
      geofenceRadiusM: shifts.geofenceRadiusM,
      lat: shifts.lat,
      lng: shifts.lng,
      qrSecret: shifts.qrSecret,
      positionName: positions.name,
      attendanceId: attendance.id,
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
    .where(
      and(
        eq(shiftAssignments.shiftId, request.shiftId),
        eq(shiftAssignments.userId, request.targetUserId),
        isNull(shifts.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new DomainError("Na túto smenu nie si pridelený. Ozvi sa koordinátorovi.");
  }
  if (row.status === "cancelled" || row.assignmentStatus === "cancelled") {
    throw new DomainError("Táto smena bola zrušená.");
  }
  if (row.assignmentStatus === "declined") {
    throw new DomainError("Túto smenu si odmietol. Ozvi sa koordinátorovi, ak chceš prísť.");
  }
  if (row.checkInAt) {
    // Rule: dvojitý check-in nie je možný.
    throw new DomainError("Na tejto smene už si checknutý.");
  }
  if (row.checkOutAt) {
    throw new DomainError("Táto smena je už ukončená.");
  }

  const now = new Date();
  const startsAt = row.startsAt;
  const minutesToStart = (startsAt.getTime() - now.getTime()) / 60_000;
  const minutesAfterEnd = (now.getTime() - row.endsAt.getTime()) / 60_000;

  if (minutesToStart > EARLY_CHECK_IN_MINUTES) {
    throw new DomainError(
      `Na check-in je ešte skoro. Otvorí sa hodinu pred začiatkom smeny.`,
    );
  }
  if (minutesAfterEnd > LATE_CHECK_IN_GRACE_MINUTES) {
    throw new DomainError("Smena už dávno skončila. Dochádzku musí doplniť koordinátor.");
  }

  const selfCheckIn = request.source === "self" || request.source === "qr" || request.source === "geofence";

  if (selfCheckIn) {
    if (row.checkInMethod === "qr" || row.checkInMethod === "qr_geofence") {
      if (!request.qrToken || request.qrToken !== signShiftQr(row.shiftId, row.qrSecret)) {
        throw new DomainError("Na túto smenu treba naskenovať QR kód priamo na mieste.");
      }
    }
    if (row.checkInMethod === "geofence" || row.checkInMethod === "qr_geofence") {
      if (row.lat == null || row.lng == null) {
        throw new DomainError("Smena nemá nastavenú polohu. Ozvi sa koordinátorovi.");
      }
      if (request.lat == null || request.lng == null) {
        throw new DomainError("Na check-in potrebujeme tvoju polohu. Povoľ ju v prehliadači.");
      }
      const distance = distanceMeters(
        { lat: Number(row.lat), lng: Number(row.lng) },
        { lat: request.lat, lng: request.lng },
      );
      if (distance > row.geofenceRadiusM) {
        throw new DomainError(
          `Si ${distance} m od miesta smeny. Check-in funguje do ${row.geofenceRadiusM} m — príď bližšie.`,
        );
      }
    }
  }

  const lateMinutes = Math.max(0, Math.round(-minutesToStart));
  const late = lateMinutes > LATE_THRESHOLD_MINUTES;

  const attendanceId = await db.transaction(async (tx) => {
    let id = row.attendanceId;

    if (id) {
      // Podmienka `check_in_at is null` chráni pred súbežným dvojitým zápisom.
      const updated = await tx
        .update(attendance)
        .set({
          status: late ? "late" : "checked_in",
          checkInAt: now,
          checkInSource: request.source,
          checkInBy: request.actorId,
          checkInLat: request.lat != null ? String(request.lat) : null,
          checkInLng: request.lng != null ? String(request.lng) : null,
          device: request.device ?? null,
          lateMinutes,
          updatedAt: new Date(),
        })
        .where(and(eq(attendance.id, id), isNull(attendance.checkInAt)))
        .returning({ id: attendance.id });
      if (updated.length === 0) throw new DomainError("Na tejto smene už si checknutý.");
    } else {
      const [created] = await tx
        .insert(attendance)
        .values({
          assignmentId: row.assignmentId,
          shiftId: row.shiftId,
          userId: request.targetUserId,
          eventId: request.eventId,
          status: late ? "late" : "checked_in",
          checkInAt: now,
          checkInSource: request.source,
          checkInBy: request.actorId,
          checkInLat: request.lat != null ? String(request.lat) : null,
          checkInLng: request.lng != null ? String(request.lng) : null,
          device: request.device ?? null,
          lateMinutes,
        })
        .returning({ id: attendance.id });
      id = created.id;
    }

    // Check-in potvrdzuje účasť — pridelenie prejde do `confirmed`.
    if (row.assignmentStatus !== "confirmed") {
      await tx
        .update(shiftAssignments)
        .set({ status: "confirmed", confirmedAt: now, updatedAt: new Date() })
        .where(eq(shiftAssignments.id, row.assignmentId));
    }

    await writeAudit(
      {
        eventId: request.eventId,
        actorId: request.actorId,
        action: "attendance.checked_in",
        entity: "attendance",
        entityId: id,
        after: {
          userId: request.targetUserId,
          shiftId: row.shiftId,
          at: now.toISOString(),
          source: request.source,
          late,
        },
        ip: request.ip,
      },
      tx,
    );

    return id;
  });

  await applyScoreRule({
    userId: request.targetUserId,
    eventId: request.eventId,
    ruleKey: late ? "late" : "on_time",
    reason: late ? `Meškanie ${lateMinutes} min · ${row.positionName}` : `Príchod načas · ${row.positionName}`,
    entityType: "attendance",
    entityId: attendanceId,
    actorId: request.actorId,
  });

  await refreshShiftStatus(row.shiftId);

  realtime.publish(
    [channels.event(request.eventId), channels.user(request.targetUserId)],
    {
      type: "attendance",
      eventId: request.eventId,
      userId: request.targetUserId,
      status: late ? "late" : "checked_in",
    },
  );

  const result: CheckInResult = {
    attendanceId,
    checkInAt: now.toISOString(),
    late,
    lateMinutes,
    replayed: false,
  };
  await storeIdempotent("check-in", request.idempotencyKey, request.targetUserId, { ...result });
  return result;
}

export type CheckOutRequest = Omit<CheckInRequest, "qrToken"> & { breakMinutes?: number };

/** Check-out. Nikdy nemôže nastať pred check-inom (Rule + DB constraint). */
export async function performCheckOut(request: CheckOutRequest): Promise<CheckOutResult> {
  const replayed = await replayIdempotent<CheckOutResult>(
    "check-out",
    request.idempotencyKey,
    request.targetUserId,
  );
  if (replayed) return { ...replayed, replayed: true };

  const db = await getDb();
  const [row] = await db
    .select({
      attendanceId: attendance.id,
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
      breakMinutes: attendance.breakMinutes,
      shiftId: shifts.id,
      positionName: positions.name,
      assignmentId: shiftAssignments.id,
    })
    .from(attendance)
    .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(shiftAssignments, eq(shiftAssignments.id, attendance.assignmentId))
    .where(
      and(eq(attendance.shiftId, request.shiftId), eq(attendance.userId, request.targetUserId)),
    )
    .limit(1);

  if (!row || !row.checkInAt) {
    throw new DomainError("Najprv sa musíš checknúť na smenu.");
  }
  if (row.checkOutAt) {
    throw new DomainError("Túto smenu si už ukončil.");
  }

  const now = new Date();
  if (now.getTime() < row.checkInAt.getTime()) {
    throw new DomainError("Check-out nemôže byť skôr ako check-in.");
  }

  const breakMinutes = request.breakMinutes ?? row.breakMinutes ?? 0;
  const workedMinutes = Math.max(
    0,
    Math.round((now.getTime() - row.checkInAt.getTime()) / 60_000) - breakMinutes,
  );

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(attendance)
      .set({
        status: "checked_out",
        checkOutAt: now,
        checkOutSource: request.source,
        checkOutBy: request.actorId,
        checkOutLat: request.lat != null ? String(request.lat) : null,
        checkOutLng: request.lng != null ? String(request.lng) : null,
        breakMinutes,
        workedMinutes,
        updatedAt: new Date(),
      })
      .where(and(eq(attendance.id, row.attendanceId), isNull(attendance.checkOutAt)))
      .returning({ id: attendance.id });
    if (updated.length === 0) throw new DomainError("Túto smenu si už ukončil.");

    await tx
      .update(shiftAssignments)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(shiftAssignments.id, row.assignmentId));

    await writeAudit(
      {
        eventId: request.eventId,
        actorId: request.actorId,
        action: "attendance.checked_out",
        entity: "attendance",
        entityId: row.attendanceId,
        after: {
          userId: request.targetUserId,
          shiftId: row.shiftId,
          at: now.toISOString(),
          workedMinutes,
          source: request.source,
        },
        ip: request.ip,
      },
      tx,
    );
  });

  await refreshShiftStatus(row.shiftId);

  realtime.publish(
    [channels.event(request.eventId), channels.user(request.targetUserId)],
    {
      type: "attendance",
      eventId: request.eventId,
      userId: request.targetUserId,
      status: "checked_out",
    },
  );

  const result: CheckOutResult = {
    attendanceId: row.attendanceId,
    checkOutAt: now.toISOString(),
    workedMinutes,
    replayed: false,
  };
  await storeIdempotent("check-out", request.idempotencyKey, request.targetUserId, { ...result });
  return result;
}

/** Označí neprítomných po skončení smeny — volá to cron (§18, §23). */
export async function markMissingAttendance(eventId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({
      assignmentId: shiftAssignments.id,
      userId: shiftAssignments.userId,
      shiftId: shifts.id,
      positionName: positions.name,
      attendanceId: attendance.id,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
    .where(
      and(
        eq(shiftAssignments.eventId, eventId),
        inArray(shiftAssignments.status, ["confirmed", "pending_confirmation", "invited"]),
        isNull(shifts.deletedAt),
        sql`${shifts.endsAt} < now()`,
        isNull(attendance.checkInAt),
      ),
    );

  let marked = 0;
  for (const row of rows) {
    if (row.attendanceId) {
      await db
        .update(attendance)
        .set({ status: "missing", updatedAt: new Date() })
        .where(eq(attendance.id, row.attendanceId));
    } else {
      await db.insert(attendance).values({
        assignmentId: row.assignmentId,
        shiftId: row.shiftId,
        userId: row.userId,
        eventId,
        status: "missing",
        workedMinutes: 0,
      });
    }
    await applyScoreRule({
      userId: row.userId,
      eventId,
      ruleKey: "no_show",
      reason: `Neprišiel na smenu · ${row.positionName}`,
      entityType: "shift",
      entityId: row.shiftId,
    });
    marked += 1;
  }
  return marked;
}
