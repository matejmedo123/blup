import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";

import { JoinConversationButton } from "@/components/admin/JoinConversationButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { Chat, type ChatMessage } from "@/components/portal/Chat";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { conversationMembers, conversations, eventMembers } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import {
  CONVERSATION_TYPE_LABELS,
  conversationMemberList,
  conversationMessages,
  markConversationRead,
} from "@/lib/domain/messaging";

export const metadata: Metadata = { title: "Konverzácia" };

export default async function AdminConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const db = await getDb();

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.eventId, context.eventId),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);
  if (!conversation) notFound();

  const [membership] = await db
    .select({ canWrite: conversationMembers.canWrite })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, id),
        eq(conversationMembers.userId, context.user.id),
      ),
    )
    .limit(1);

  const [members, rows, leadRows] = await Promise.all([
    conversationMemberList(id),
    membership ? conversationMessages(id) : Promise.resolve([]),
    db
      .select({ userId: eventMembers.userId, role: eventMembers.role })
      .from(eventMembers)
      .where(eq(eventMembers.eventId, context.eventId)),
  ]);

  const leads = new Set(
    leadRows.filter((r) => r.role !== "staff").map((r) => r.userId),
  );

  if (membership) await markConversationRead(id, context.user.id);

  const messages: ChatMessage[] = rows.map((row) => ({
    id: row.id,
    body: row.body,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    senderId: row.senderId,
    senderFirstName: row.senderFirstName,
    senderLastName: row.senderLastName,
    isCoordinator: row.senderId ? leads.has(row.senderId) : false,
  }));

  return (
    <>
      <Link
        href="/admin/messages"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na správy
      </Link>

      <PageHeader
        title={conversation.title ?? "Priama správa"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{CONVERSATION_TYPE_LABELS[conversation.type]}</Pill>
            <span>{members.map((m) => `${m.firstName} ${m.lastName}`).join(", ")}</span>
          </span>
        }
      />

      {!membership ? (
        <Card>
          <EmptyState
            title="Nie si členom tejto konverzácie"
            description="Obsah konverzácií je prístupný len ich členom — platí to aj pre adminov. Ak ju potrebuješ riešiť, pripoj sa."
            action={<JoinConversationButton conversationId={id} />}
          />
        </Card>
      ) : (
        <Card className="flex min-h-[60vh] flex-col p-4 sm:p-5">
          <Chat
            conversationId={id}
            messages={messages}
            currentUserId={context.user.id}
            timezone={context.event.timezone}
            canWrite={membership.canWrite}
            readOnlyReason="Táto konverzácia je len na čítanie."
          />
        </Card>
      )}
    </>
  );
}
