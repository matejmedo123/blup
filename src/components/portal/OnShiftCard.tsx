"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/Button";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { formatMoney } from "@/lib/format";

/**
 * Živý časovač a zárobok — tiká každú sekundu od skutočného check-inu.
 * Hodiny sú externý zdroj, preto `useSyncExternalStore`: serverový snapshot
 * drží hydratáciu konzistentnú a klient prevezme skutočný čas hneď po pripojení.
 */
function subscribeToClock(onChange: () => void): () => void {
  const timer = setInterval(onChange, 1000);
  return () => clearInterval(timer);
}

function useElapsed(since: string, serverNow: number) {
  const now = useSyncExternalStore(
    subscribeToClock,
    // Zaokrúhlenie na sekundu drží snapshot referenčne stabilný medzi tikmi.
    () => Math.floor(Date.now() / 1000) * 1000,
    () => serverNow,
  );
  return Math.max(0, now - new Date(since).getTime());
}

function formatElapsed(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function OnShiftCard({
  shiftId,
  positionName,
  checkInAt,
  checkInLabel,
  rate,
  currency,
  coordinatorName,
  conversationHref,
  serverNow,
}: {
  shiftId: string;
  positionName: string;
  checkInAt: string;
  checkInLabel: string;
  rate: number;
  currency: string;
  coordinatorName: string | null;
  conversationHref: string | null;
  /** `Date.now()` v momente serverového renderu — kotva pre hydratáciu. */
  serverNow: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const elapsed = useElapsed(checkInAt, serverNow);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const earned = (elapsed / 3_600_000) * rate;

  async function checkOut() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/attendance/check-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Retry na slabom pripojení nesmie vytvoriť druhý zápis (§73).
          "Idempotency-Key": `checkout-${shiftId}-${new Date(checkInAt).getTime()}`,
        },
        body: JSON.stringify({ shiftId }),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) {
        setError(data.error ?? "Check-out sa nepodaril.");
        return;
      }
      toast.success("Smena je ukončená. Ďakujeme!");
      router.refresh();
    } catch {
      setError("Pripojenie je slabé. Skúsime to znova o chvíľu.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-20 bg-accent p-6 text-ink sm:p-[26px]">
      <div className="flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] uppercase">
        <span className="size-2 animate-(--animate-crew-pulse) rounded-full bg-ink" aria-hidden />
        Si na smene
      </div>

      <p className="mt-4 mb-1 text-[15px] font-semibold">
        {positionName} · check-in {checkInLabel}
      </p>

      <p className="nums text-[44px] leading-[1.05] font-extrabold tracking-[-0.05em] sm:text-[56px]">
        {formatElapsed(elapsed)}
      </p>
      <p className="nums mt-1.5 text-xl font-bold">{formatMoney(earned, currency)}</p>

      {error ? (
        <div className="mt-4">
          <InlineNotice tone="danger">{error}</InlineNotice>
        </div>
      ) : null}

      <Button
        size="block"
        variant="dark"
        className="mt-6"
        loading={pending}
        onClick={checkOut}
      >
        CHECK-OUT
      </Button>

      {coordinatorName && conversationHref ? (
        <p className="mt-4 text-[13px]">
          Koordinátor: <span className="font-semibold">{coordinatorName}</span> ·{" "}
          <a href={conversationHref} className="font-semibold underline underline-offset-4">
            napísať
          </a>
        </p>
      ) : null}
    </div>
  );
}
