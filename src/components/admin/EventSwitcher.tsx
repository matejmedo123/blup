"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { switchEvent } from "@/app/actions/events";
import { cn } from "@/lib/cn";

export function EventSwitcher({
  events,
  activeEventId,
  tone = "light",
}: {
  events: { id: string; name: string }[];
  activeEventId: string | null;
  tone?: "light" | "dark";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (events.length === 0) return null;

  return (
    <label className="flex flex-col gap-1.5">
      <span
        className={cn(
          "text-[11px] font-semibold tracking-[0.12em] uppercase",
          tone === "dark" ? "text-white/40" : "text-faint",
        )}
      >
        Event
      </span>
      <select
        value={activeEventId ?? ""}
        disabled={pending || events.length < 2}
        onChange={(e) =>
          startTransition(async () => {
            await switchEvent(e.target.value);
            router.refresh();
          })
        }
        className={cn(
          "min-h-11 rounded-10 px-2.5 text-sm font-medium focus:outline-none",
          tone === "dark"
            ? "border border-white/12 bg-white/8 text-white disabled:opacity-70"
            : "border border-line bg-surface text-ink",
        )}
      >
        {events.map((event) => (
          <option key={event.id} value={event.id} className="text-ink">
            {event.name}
          </option>
        ))}
      </select>
    </label>
  );
}
