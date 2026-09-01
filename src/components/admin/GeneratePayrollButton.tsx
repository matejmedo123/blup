"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { generatePayroll } from "@/app/actions/admin-payroll";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export function GeneratePayrollButton() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await generatePayroll();
          if (result.ok) {
            toast.success(result.message ?? "Hotovo.");
            router.refresh();
          } else toast.error(result.message);
        })
      }
    >
      Vygenerovať mzdové záznamy
    </Button>
  );
}
