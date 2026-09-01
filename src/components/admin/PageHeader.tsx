import type { ReactNode } from "react";

/** Hlavička admin stránky — H1 34px/800 + podnadpis + akcie vpravo. */
export function PageHeader({
  title,
  subtitle,
  action,
  size = "md",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1
          className={
            size === "lg"
              ? "text-[32px] leading-tight font-extrabold tracking-[-0.04em] lg:text-[42px]"
              : "text-[28px] leading-tight font-extrabold tracking-[-0.04em] lg:text-[34px]"
          }
        >
          {title}
        </h1>
        {subtitle ? <p className="mt-1.5 text-[15px] text-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2.5">{action}</div> : null}
    </div>
  );
}

/** Filtračné pilulky nad tabuľkami (§13 prototypu). */
export function TabPills({
  items,
  activeValue,
  onSelect,
}: {
  items: { value: string; label: string; count?: number }[];
  activeValue: string;
  onSelect?: (value: string) => void;
}) {
  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
      {items.map((item) => {
        const active = item.value === activeValue;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onSelect?.(item.value)}
            aria-pressed={active}
            className={
              "min-h-10 shrink-0 cursor-pointer rounded-full px-3.5 text-[13px] font-semibold transition-colors duration-150 " +
              (active
                ? "bg-ink text-white"
                : "border border-line-strong bg-surface text-muted hover:bg-hover")
            }
          >
            {item.label}
            {item.count != null ? (
              <span className={active ? "ml-1.5 text-white/60" : "ml-1.5 text-faint"}>
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
