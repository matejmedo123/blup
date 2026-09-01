import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconAlert, IconWarning } from "./Icons";

/** Prázdny stav — vždy s konkrétnym textom a akciou, nikdy generický (§43). */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon ? (
        <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-subtle text-faint">
          {icon}
        </div>
      ) : null}
      <h3 className="text-lg font-bold tracking-[-0.02em] text-ink">{title}</h3>
      {description ? <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Nepodarilo sa načítať dáta",
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-bad-bg text-bad-fg">
        <IconWarning width={26} height={26} />
      </div>
      <h3 className="text-lg font-bold tracking-[-0.02em] text-ink">{title}</h3>
      {description ? <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function InlineNotice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    info: "bg-info-bg text-info-fg",
    warning: "bg-warn-bg text-warn-fg",
    danger: "bg-bad-bg text-bad-fg",
    success: "bg-ok-bg text-ok-fg",
  };
  return (
    <div className={cn("flex gap-3 rounded-14 p-4 text-sm", tones[tone])}>
      <IconAlert className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-10", className)} aria-hidden />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-20 border border-line bg-surface p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-32" />
      <Skeleton className="mt-2 h-3 w-40" />
    </div>
  );
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-divider" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-6 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
