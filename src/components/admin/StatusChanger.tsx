"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { setVendorStatus, setVolunteerStatus } from "@/app/actions/admin-applicants";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/db/enums";
import { APPLICATION_STATUS_META } from "@/components/ui/Badge";

const OPTIONS: ApplicationStatus[] = ["reviewing", "approved", "waitlist", "rejected", "archived"];

export function StatusChanger({
  id,
  kind,
  current,
}: {
  id: string;
  kind: "volunteer" | "vendor";
  current: ApplicationStatus;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function run(status: ApplicationStatus) {
    startTransition(async () => {
      const result =
        kind === "volunteer"
          ? await setVolunteerStatus({ ids: [id], status })
          : await setVendorStatus({ ids: [id], status });
      if (result.ok) {
        toast.success(result.message ?? "Stav je zmenený.");
        router.refresh();
      } else toast.error(result.message);
    });
  }

  return (
    <div className="flex flex-wrap gap-2.5">
      {OPTIONS.filter((status) => APPLICATION_STATUSES.includes(status) && status !== current).map(
        (status) => (
          <Button
            key={status}
            size="sm"
            variant={status === "approved" ? "dark" : "outline"}
            disabled={pending}
            onClick={() => run(status)}
          >
            {APPLICATION_STATUS_META[status].label}
          </Button>
        ),
      )}
    </div>
  );
}
