"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type Props = {
  shiftId: string;
  checkInMethod: "manual" | "qr" | "geofence" | "qr_geofence";
  /** Token z QR kódu, ak používateľ prišiel cez naskenovaný odkaz. */
  qrToken?: string | null;
  disabledReason?: string | null;
  autoStart?: boolean;
};

/**
 * Check-in čo najmenej krokmi (§63): jedno ťuknutie, prípadne povolenie GPS.
 * Retry pri slabom pripojení je bezpečný — server je idempotentný (§73).
 */
export function CheckInButton({ shiftId, checkInMethod, qrToken, disabledReason }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsQr, setNeedsQr] = useState(false);

  const needsLocation = checkInMethod === "geofence" || checkInMethod === "qr_geofence";
  const needsQrCode = checkInMethod === "qr" || checkInMethod === "qr_geofence";

  async function getPosition(): Promise<GeolocationPosition | null> {
    if (!("geolocation" in navigator)) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
      );
    });
  }

  async function checkIn() {
    setPending(true);
    setError(null);
    setNeedsQr(false);

    try {
      if (needsQrCode && !qrToken) {
        setNeedsQr(true);
        setError("Túto smenu treba odomknúť QR kódom priamo na mieste.");
        return;
      }

      let coords: { lat: number; lng: number; accuracy?: number } | undefined;
      if (needsLocation) {
        const position = await getPosition();
        if (!position) {
          setError("Nevieme zistiť tvoju polohu. Povoľ ju v prehliadači a skús to znova.");
          return;
        }
        coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
      }

      const response = await fetch("/api/attendance/check-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Kľúč je stabilný pre danú smenu a deň — retry nikdy nevytvorí duplicitu.
          "Idempotency-Key": `checkin-${shiftId}-${new Date().toISOString().slice(0, 10)}`,
        },
        body: JSON.stringify({ shiftId, qrToken: qrToken ?? undefined, ...coords }),
      });

      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) {
        setError(data.error ?? "Check-in sa nepodaril.");
        return;
      }

      toast.success("Si vnútri.");
      router.push("/portal?checkedIn=1");
      router.refresh();
    } catch {
      setError("Pripojenie je slabé. Skúsime to znova — nič sa nepokazí, dvojitý check-in nevznikne.");
    } finally {
      setPending(false);
    }
  }

  if (disabledReason) {
    return <InlineNotice tone="info">{disabledReason}</InlineNotice>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <InlineNotice tone={needsQr ? "info" : "danger"}>
          {error}
          {needsQr ? (
            <p className="mt-1.5">
              Naskenuj QR kód pri vstupe bežnou appkou fotoaparátu — otvorí sa ti rovno check-in.
            </p>
          ) : null}
        </InlineNotice>
      ) : null}

      <Button size="block" variant="dark" loading={pending} onClick={checkIn}>
        CHECK-IN
      </Button>

      {needsLocation ? (
        <p className="text-center text-[13px] text-muted">
          Pri check-ine overíme, že si na mieste. Polohu neukladáme nikam inam.
        </p>
      ) : null}
    </div>
  );
}
