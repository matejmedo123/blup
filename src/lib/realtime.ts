/**
 * In-process event bus + SSE most.
 *
 * Rozhranie `RealtimeBus` je zámerne minimálne, aby sa dalo nahradiť
 * Redis pub/sub alebo Postgres LISTEN/NOTIFY bez zmeny volajúceho kódu.
 */

export type RealtimeChannel = `user:${string}` | `event:${string}` | `conversation:${string}`;

export type RealtimeEvent =
  | { type: "message"; conversationId: string; messageId: string; senderId: string | null }
  | { type: "notification"; userId: string; notificationId: string }
  | { type: "attendance"; eventId: string; userId: string; status: string }
  | { type: "shift"; eventId: string; shiftId: string; action: "created" | "updated" | "cancelled" }
  | { type: "ping" };

type Listener = (event: RealtimeEvent) => void;

export interface RealtimeBus {
  publish(channels: RealtimeChannel[], event: RealtimeEvent): void;
  subscribe(channels: RealtimeChannel[], listener: Listener): () => void;
}

class MemoryRealtimeBus implements RealtimeBus {
  private listeners = new Map<string, Set<Listener>>();

  publish(channels: RealtimeChannel[], event: RealtimeEvent): void {
    for (const channel of new Set(channels)) {
      for (const listener of this.listeners.get(channel) ?? []) {
        try {
          listener(event);
        } catch {
          // Odpojený klient nesmie zhodiť publikáciu ostatným.
        }
      }
    }
  }

  subscribe(channels: RealtimeChannel[], listener: Listener): () => void {
    for (const channel of channels) {
      const set = this.listeners.get(channel) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(channel, set);
    }
    return () => {
      for (const channel of channels) {
        const set = this.listeners.get(channel);
        set?.delete(listener);
        if (set && set.size === 0) this.listeners.delete(channel);
      }
    };
  }
}

const globalForBus = globalThis as typeof globalThis & { __crewBus?: RealtimeBus };
export const realtime: RealtimeBus = (globalForBus.__crewBus ??= new MemoryRealtimeBus());

export const channels = {
  user: (id: string) => `user:${id}` as RealtimeChannel,
  event: (id: string) => `event:${id}` as RealtimeChannel,
  conversation: (id: string) => `conversation:${id}` as RealtimeChannel,
};
