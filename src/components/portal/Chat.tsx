"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { postMessage } from "@/app/actions/messaging";
import { RoundButton } from "@/components/ui/Button";
import { IconSend } from "@/components/ui/Icons";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";

export type ChatMessage = {
  id: string;
  body: string;
  kind: "text" | "system" | "attachment";
  createdAt: string;
  senderId: string | null;
  senderFirstName: string | null;
  senderLastName: string | null;
  isCoordinator: boolean;
};

export function Chat({
  conversationId,
  messages: initialMessages,
  currentUserId,
  timezone,
  canWrite,
  readOnlyReason,
}: {
  conversationId: string;
  messages: ChatMessage[];
  currentUserId: string;
  timezone: string;
  canWrite: boolean;
  readOnlyReason?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll na najnovšiu správu pri načítaní aj po každej novej správe.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [initialMessages.length]);

  // Realtime: nová správa v tejto konverzácii vyvolá refresh servera.
  useEffect(() => {
    const source = new EventSource(`/api/realtime?conversation=${conversationId}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type: string; senderId?: string | null };
        if (data.type === "message" && data.senderId !== currentUserId) router.refresh();
      } catch {
        /* ignorujeme neplatný payload */
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [conversationId, currentUserId, router]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    startTransition(async () => {
      const result = await postMessage({ conversationId, body });
      if (!result.ok) {
        setDraft(body);
        toast.error(result.message);
        return;
      }
      router.refresh();
    });
  }

  // Denné oddeľovače sa počítajú vopred — render tak ostáva čistý.
  const dayLabels = initialMessages.map((message) =>
    new Intl.DateTimeFormat("sk-SK", {
      day: "numeric",
      month: "long",
      timeZone: timezone,
    }).format(new Date(message.createdAt)),
  );
  const showDayAt = dayLabels.map((day, index) => index === 0 || dayLabels[index - 1] !== day);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-1 pb-4">
        {initialMessages.length === 0 ? (
          <p className="py-10 text-center text-[15px] text-muted">
            Zatiaľ žiadne správy. Napíš prvú.
          </p>
        ) : null}

        {initialMessages.map((message, index) => {
          const own = message.senderId === currentUserId;
          const day = dayLabels[index];
          const showDay = showDayAt[index];

          if (message.kind === "system") {
            return (
              <div key={message.id} className="self-center text-center">
                {showDay ? <p className="mb-2 text-xs text-faint">{day}</p> : null}
                <p className="rounded-full bg-subtle px-3 py-1.5 text-xs text-muted">
                  {message.body}
                </p>
              </div>
            );
          }

          return (
            <div key={message.id} className={cn("flex flex-col", own ? "items-end" : "items-start")}>
              {showDay ? (
                <p className="my-2 self-center text-xs text-faint">{day}</p>
              ) : null}

              <div className={cn("max-w-[78%]", own ? "items-end" : "items-start")}>
                {!own ? (
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
                    {message.senderFirstName ?? "CREW."}
                    {message.isCoordinator ? (
                      <span className="rounded-[5px] bg-accent px-1.5 py-0.5 text-[10px] font-bold tracking-[0.08em] text-ink uppercase">
                        Koordinátor
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <div
                  className={cn(
                    "px-4 py-3.5 text-[15px] leading-[1.45] whitespace-pre-wrap",
                    own
                      ? "rounded-[16px_16px_5px_16px] bg-ink text-white"
                      : "rounded-[16px_16px_16px_5px] border border-divider bg-surface",
                  )}
                >
                  {message.body}
                </div>

                <p className={cn("mt-1 text-[11px] text-faint", own && "text-right")}>
                  {formatTime(message.createdAt, timezone)}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {canWrite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="safe-bottom sticky bottom-0 flex items-center gap-2.5 border-t border-line bg-bg px-1 py-3"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Napíš správu…"
            aria-label="Text správy"
            enterKeyHint="send"
            className="min-h-11 flex-1 rounded-[22px] border border-line-strong bg-surface px-4 py-3 text-[15px] placeholder:text-faint focus:border-ink focus:outline-none"
          />
          <RoundButton
            type="submit"
            variant="dark"
            aria-label="Odoslať"
            disabled={pending || draft.trim().length === 0}
            className="disabled:opacity-50"
          >
            <IconSend width={18} height={18} />
          </RoundButton>
        </form>
      ) : (
        <div className="py-3">
          <InlineNotice tone="info">
            {readOnlyReason ?? "Do tejto konverzácie sa nedá odpovedať."}
          </InlineNotice>
        </div>
      )}
    </div>
  );
}
