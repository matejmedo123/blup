import Link from "next/link";

import { cn } from "@/lib/cn";

/** Tab strip s 2px podčiarknutím aktívnej položky (podľa prototypového draweru). */
export function DetailTabs({
  basePath,
  activeTab,
  tabs,
}: {
  basePath: string;
  activeTab: string;
  tabs: { value: string; label: string; count?: number }[];
}) {
  return (
    <div className="scrollbar-none -mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-[rgba(17,17,17,0.1)] px-4 lg:mx-0 lg:px-0">
      {tabs.map((tab) => {
        const active = tab.value === activeTab;
        return (
          <Link
            key={tab.value}
            href={tab.value === tabs[0].value ? basePath : `${basePath}?tab=${tab.value}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-3 text-sm whitespace-nowrap transition-colors",
              active
                ? "border-ink font-semibold text-ink"
                : "border-transparent font-medium text-faint hover:text-muted",
            )}
          >
            {tab.label}
            {tab.count != null ? (
              <span className={active ? "ml-1.5 text-muted" : "ml-1.5 text-faint"}>{tab.count}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
