import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconMessage } from "@/components/ui/Icons";
import { requireStaff } from "@/lib/auth/guards";
import { getEventById } from "@/lib/domain/events";
import { portalConversations } from "@/lib/domain/portal";
import { formatRelative, initials } from "@/lib/format";

export const metadata: Metadata = { title: "Správy" };

export default async function PortalMessagesPage() {
  const session = await requireStaff();
  if (!session.eventId) return null;

  const [conversations, event] = await Promise.all([
    portalConversations(session.user.id, session.eventId),
    getEventById(session.eventId),
  ]);
  const tz = event?.timezone ?? "Europe/Bratislava";

  return (
    <div className="animate-(--animate-crew-up) flex flex-col gap-5">
      <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[30px]">
        Správy
      </h1>

      {conversations.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconMessage width={26} height={26} />}
            title="Zatiaľ žiadne správy"
            description="Keď ti napíše koordinátor alebo ťa pridá do chatu k smene, nájdeš to tu."
          />
        </Card>
      ) : (
        <ul className="flex flex-col">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <Link
                href={`/portal/messages/${conversation.id}`}
                className="flex items-center gap-3.5 border-b border-divider px-1 py-4 transition-colors hover:bg-hover"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-avatar text-sm font-bold">
                  {conversation.type === "shift"
                    ? conversation.title.slice(0, 2).toUpperCase()
                    : initials(
                        conversation.title.split(" ")[0] ?? "C",
                        conversation.title.split(" ")[1] ?? "",
                      )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[15px] font-bold">{conversation.title}</span>
                    <span className="shrink-0 text-xs text-faint">
                      {conversation.lastMessageAt
                        ? formatRelative(conversation.lastMessageAt, tz)
                        : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-muted">
                    {conversation.preview
                      ? `${conversation.preview.isOwn ? "Ty" : conversation.preview.senderName}: ${conversation.preview.body}`
                      : conversation.type === "shift"
                        ? `${conversation.memberCount} členov`
                        : "Žiadne správy"}
                  </span>
                </span>

                {conversation.unread > 0 ? (
                  <span
                    className="size-2 shrink-0 rounded-full bg-accent-deep"
                    aria-label={`${conversation.unread} neprečítaných`}
                  />
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
