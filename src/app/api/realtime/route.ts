import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/permissions";
import { channels, realtime, type RealtimeChannel, type RealtimeEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

/**
 * SSE most nad in-process event busom. Klient sa prihlási na kanály,
 * ku ktorým má prístup — nikdy nedostane cudzie správy.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const requested = url.searchParams.getAll("conversation");

  const subscribed: RealtimeChannel[] = [channels.user(session.user.id)];
  if (session.eventId && canAccessAdmin(session.actor)) {
    subscribed.push(channels.event(session.eventId));
  }
  for (const conversationId of requested.slice(0, 10)) {
    // Overenie členstva — bez neho by sa dalo odpočúvať cudziu konverzáciu.
    try {
      const { requireConversationMember } = await import("@/lib/domain/messaging");
      await requireConversationMember(conversationId, session.user.id);
      subscribed.push(channels.conversation(conversationId));
    } catch {
      // Nečlenské kanály jednoducho preskočíme.
    }
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: RealtimeEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Klient sa odpojil — upratovanie spraví `cancel`.
        }
      };

      send({ type: "ping" });
      unsubscribe = realtime.subscribe(subscribed, send);

      // Proxy servery zvyknú zabíjať nečinné spojenia — komentár ich udrží nažive.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          /* ignore */
        }
      }, 25_000);

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* už zatvorené */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
