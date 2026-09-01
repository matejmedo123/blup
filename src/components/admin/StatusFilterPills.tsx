"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { APPLICATION_STATUS_META } from "@/components/ui/Badge";
import { TabPills } from "@/components/admin/PageHeader";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/db/enums";

const SHOWN: ApplicationStatus[] = ["pending", "reviewing", "approved", "waitlist", "rejected"];

export function StatusFilterPills({
  counts,
  total,
  paramName = "status",
}: {
  counts: Partial<Record<ApplicationStatus, number>>;
  total: number;
  paramName?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = params.get(paramName) ?? "";

  function select(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(paramName, value);
    else next.delete(paramName);
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <TabPills
      activeValue={active}
      onSelect={select}
      items={[
        { value: "", label: "Všetky", count: total },
        ...SHOWN.filter((status) => APPLICATION_STATUSES.includes(status)).map((status) => ({
          value: status,
          label: APPLICATION_STATUS_META[status].label,
          count: counts[status] ?? 0,
        })),
      ]}
    />
  );
}
