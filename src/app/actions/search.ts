"use server";

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  applications,
  eventMembers,
  positions,
  shifts,
  users,
  vendorApplications,
  volunteerApplications,
} from "@/db/schema";
import { assertSession } from "@/lib/auth/guards";
import { canAccessAdmin } from "@/lib/permissions";

export type SearchHit = {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  group: "Ľudia" | "Smeny" | "Prihlášky" | "Stánkari" | "Dobrovoľníci";
};

/** Globálne admin vyhľadávanie (§21) — meno, e-mail, telefón, mesto, pozícia, smena. */
export async function globalSearch(query: string): Promise<SearchHit[]> {
  const session = await assertSession();
  if (!canAccessAdmin(session.actor)) return [];
  const eventId = session.eventId;
  if (!eventId) return [];

  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;

  const db = await getDb();
  const hits: SearchHit[] = [];

  const people = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      city: users.city,
      role: eventMembers.role,
    })
    .from(users)
    .innerJoin(eventMembers, eq(eventMembers.userId, users.id))
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        isNull(users.deletedAt),
        or(
          ilike(users.firstName, like),
          ilike(users.lastName, like),
          ilike(users.email, like),
          ilike(users.phone, like),
          ilike(users.city, like),
          sql`lower(${users.firstName} || ' ' || ${users.lastName}) like lower(${like})`,
        ),
      ),
    )
    .limit(6);

  for (const person of people) {
    hits.push({
      id: person.id,
      title: `${person.firstName} ${person.lastName}`,
      subtitle: [person.city, person.email].filter(Boolean).join(" · "),
      href: `/admin/staff/${person.id}`,
      group: "Ľudia",
    });
  }

  const shiftRows = await db
    .select({
      id: shifts.id,
      startsAt: shifts.startsAt,
      location: shifts.location,
      positionName: positions.name,
    })
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(
      and(
        eq(shifts.eventId, eventId),
        isNull(shifts.deletedAt),
        or(ilike(positions.name, like), ilike(shifts.location, like), ilike(shifts.title, like)),
      ),
    )
    .orderBy(desc(shifts.startsAt))
    .limit(5);

  for (const shift of shiftRows) {
    hits.push({
      id: shift.id,
      title: shift.positionName,
      subtitle: [
        new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "short" }).format(shift.startsAt),
        shift.location,
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/admin/shifts/${shift.id}`,
      group: "Smeny",
    });
  }

  const applicantRows = await db
    .select({
      id: applications.id,
      firstName: users.firstName,
      lastName: users.lastName,
      city: users.city,
      status: applications.status,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .where(
      and(
        eq(applications.eventId, eventId),
        or(
          ilike(users.firstName, like),
          ilike(users.lastName, like),
          ilike(users.email, like),
          sql`lower(${users.firstName} || ' ' || ${users.lastName}) like lower(${like})`,
        ),
      ),
    )
    .limit(4);

  for (const applicant of applicantRows) {
    hits.push({
      id: applicant.id,
      title: `${applicant.firstName} ${applicant.lastName}`,
      subtitle: [applicant.city, applicant.status].filter(Boolean).join(" · "),
      href: `/admin/applicants/${applicant.id}`,
      group: "Prihlášky",
    });
  }

  const vendorRows = await db
    .select({
      id: vendorApplications.id,
      contactName: vendorApplications.contactName,
      companyName: vendorApplications.companyName,
    })
    .from(vendorApplications)
    .where(
      and(
        eq(vendorApplications.eventId, eventId),
        or(
          ilike(vendorApplications.contactName, like),
          ilike(vendorApplications.companyName, like),
          ilike(vendorApplications.email, like),
        ),
      ),
    )
    .limit(3);

  for (const vendor of vendorRows) {
    hits.push({
      id: vendor.id,
      title: vendor.companyName || vendor.contactName,
      subtitle: vendor.companyName ? vendor.contactName : "Stánok",
      href: `/admin/vendors/${vendor.id}`,
      group: "Stánkari",
    });
  }

  const volunteerRows = await db
    .select({
      id: volunteerApplications.id,
      firstName: volunteerApplications.firstName,
      lastName: volunteerApplications.lastName,
      city: volunteerApplications.city,
    })
    .from(volunteerApplications)
    .where(
      and(
        eq(volunteerApplications.eventId, eventId),
        or(
          ilike(volunteerApplications.firstName, like),
          ilike(volunteerApplications.lastName, like),
          ilike(volunteerApplications.email, like),
        ),
      ),
    )
    .limit(3);

  for (const volunteer of volunteerRows) {
    hits.push({
      id: volunteer.id,
      title: `${volunteer.firstName} ${volunteer.lastName}`,
      subtitle: volunteer.city ?? "Dobrovoľník",
      href: `/admin/volunteers/${volunteer.id}`,
      group: "Dobrovoľníci",
    });
  }

  return hits;
}
