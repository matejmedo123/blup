import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { Chat, type ChatMessage } from "@/components/portal/Chat";
import { RoundButton } from "@/components/ui/Button";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { eventMembers, shifts } from "@/db/schema";
import { requireStaff } from "@/lib/auth/guards";
import { getEventById } from "@/lib/domain/events";
import {
  conversationMemberList,
  conversationMessages,
  markConversationRead,
  requireConversationMember,
} from "@/lib/domain/messaging";

export const metadata: Metadata = { title: "Konverzácia" };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaff();
  const { id } = await params;

  let membership;
  try {
    membership = await requireConversationMember(id, session.user.id);
  } catch {
    notFound();
  }

  const [rows, members, event] = await Promise.all([
    conversationMessages(id),
    conversationMemberList(id),
    getEventById(membership.eventId),
  ]);

  // Koordinátori dostanú vizuálny odznak v bublinách.
  const db = await getDb();
  const coordinatorRows = await db
    .select({ userId: eventMembers.userId })
    .from(eventMembers)
    .where(
      and(eq(eventMembers.eventId, membership.eventId), eq(eventMembers.role, "coordinator")),
    );
  const adminRows = await db
    .select({ userId: eventMembers.userId })
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, membership.eventId), eq(eventMembers.role, "admin")));
  const staffLeads = new Set([
    ...coordinatorRows.map((r) => r.userId),
    ...adminRows.map((r) => r.userId),
  ]);

  let subtitle: string;
  if (membership.type === "shift" && membership.shiftId) {
    const [shift] = await db
      .select({ startsAt: shifts.startsAt })
      .from(shifts)
      .where(eq(shifts.id, membership.shiftId))
      .limit(1);
    subtitle = shift
      ? `${members.length} členov · ${new Intl.DateTimeFormat("sk-SK", {
          day: "numeric",
          month: "numeric",
          timeZone: event?.timezone ?? "Europe/Bratislava",
        }).format(shift.startsAt)}`
      : `${members.length} členov`;
  } else if (membership.type === "broadcast") {
    subtitle = `Hromadná správa · ${members.length} príjemcov`;
  } else {
    subtitle = members
      .filter((m) => m.userId !== session.user.id)
      .map((m) => m.firstName)
      .join(", ");
  }

  await markConversationRead(id, session.user.id);

  const messages: ChatMessage[] = rows.map((row) => ({
    id: row.id,
    body: row.body,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    senderId: row.senderId,
    senderFirstName: row.senderFirstName,
    senderLastName: row.senderLastName,
    isCoordinator: row.senderId ? staffLeads.has(row.senderId) : false,
  }));

  return (
    <div className="flex min-h-[calc(100dvh-14rem)] flex-col">
      <div className="sticky top-14 z-10 -mx-4 flex items-center gap-3 border-b border-line bg-bg px-4 py-3 lg:top-16 lg:mx-0 lg:px-0">
        <Link href="/portal/messages" aria-label="Späť na správy">
          <RoundButton aria-label="Späť">
            <IconChevronLeft />
          </RoundButton>
        </Link>
        <div className="min-w-0">
          <p className="truncate text-base font-bold tracking-[-0.02em]">
            {membership.title ?? subtitle}
          </p>
          <p className="truncate text-xs text-muted">{subtitle}</p>
        </div>
      </div>

      <Chat
        conversationId={id}
        messages={messages}
        currentUserId={session.user.id}
        timezone={event?.timezone ?? "Europe/Bratislava"}
        canWrite={membership.canWrite}
        readOnlyReason="Toto je hromadný oznam. Ak potrebuješ odpovedať, napíš priamo koordinátorovi."
      />
    </div>
  );
}
