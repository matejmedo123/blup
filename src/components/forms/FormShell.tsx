import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Spoločný rám verejných formulárov — tmavý úvod + biela karta s obsahom. */
export function FormPage({
  eyebrow,
  title,
  lead,
  children,
  aside,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <>
      <section className="bg-ink px-5 pt-12 pb-14 text-white lg:px-8 lg:pt-16 lg:pb-20">
        <div className="mx-auto max-w-[1240px]">
          <p className="mb-5 text-xs font-semibold tracking-[0.16em] text-accent uppercase">
            {eyebrow}
          </p>
          <h1 className="max-w-[16ch] text-[34px] leading-[1.02] font-extrabold tracking-[-0.04em] sm:text-[44px] lg:text-[56px]">
            {title}
          </h1>
          {lead ? (
            <p className="mt-5 max-w-[520px] text-[17px] leading-[1.55] text-white/62">{lead}</p>
          ) : null}
        </div>
      </section>

      <section className="px-5 pb-16 lg:px-8 lg:pb-24">
        <div
          className={cn(
            "mx-auto -mt-8 max-w-[1240px] gap-6 lg:-mt-10",
            aside ? "grid lg:grid-cols-[minmax(0,1fr)_320px]" : "",
          )}
        >
          <div className="rounded-20 border border-line bg-surface p-5 sm:p-8">{children}</div>
          {aside ? <div className="flex flex-col gap-4">{aside}</div> : null}
        </div>
      </section>
    </>
  );
}

/** „Krok 2 z 6“ — progres viackrokového formulára. */
export function StepProgress({
  step,
  total,
  labels,
}: {
  step: number;
  total: number;
  labels: string[];
}) {
  return (
    <div className="mb-7">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-semibold text-muted">
          Krok {step} z {total}
        </p>
        <p className="truncate text-[13px] text-faint">{labels[step - 1]}</p>
      </div>
      <div
        className="flex gap-1.5"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={`Krok ${step} z ${total}: ${labels[step - 1]}`}
      >
        {labels.map((label, i) => (
          <span
            key={label}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors duration-200",
              i < step ? "bg-ink" : "bg-track",
            )}
          />
        ))}
      </div>
    </div>
  );
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-8 last:mb-0">
      <h2 className="text-[22px] font-bold tracking-[-0.03em]">{title}</h2>
      {description ? <p className="mt-1.5 text-[15px] text-muted">{description}</p> : null}
      <div className="mt-5 flex flex-col gap-4">{children}</div>
    </div>
  );
}

/** Úspešná obrazovka po odoslaní prihlášky. */
export function SubmittedState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[520px] py-8 text-center">
      <div className="mx-auto mb-6 flex size-[76px] items-center justify-center rounded-full border-2 border-ink bg-accent text-3xl">
        ✓
      </div>
      <h2 className="text-[32px] leading-tight font-extrabold tracking-[-0.04em]">{title}</h2>
      <div className="mt-4 text-[15px] leading-[1.6] text-muted">{children}</div>
      {action ? <div className="mt-8 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </div>
  );
}
