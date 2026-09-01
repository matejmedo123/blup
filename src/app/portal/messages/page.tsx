import type { Metadata } from "next";

import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconMessage } from "@/components/ui/Icons";
import { requireStaff } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Správy" };

export default async function PortalMessagesPage() {
  await requireStaff();
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[30px]">
        Správy
      </h1>
      <Card>
        <EmptyState
          icon={<IconMessage width={26} height={26} />}
          title="Zatiaľ žiadne správy"
          description="Správy od koordinátora a chat k smene sa objavia tu."
        />
      </Card>
    </div>
  );
}
