"use client";

import type { ReactNode } from "react";

/** Akčný pruh nad výberom riadkov (§42). Na mobile sa lepí na spodok obrazovky. */
export function BulkActionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface p-3 lg:static lg:mb-4 lg:rounded-16 lg:border lg:p-3.5">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-2.5">
        <span className="text-sm font-semibold">
          Označené: {count}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="cursor-pointer text-[13px] font-semibold text-muted underline underline-offset-4 hover:text-ink"
        >
          Zrušiť výber
        </button>
        <div className="ml-auto flex flex-wrap gap-2">{children}</div>
      </div>
    </div>
  );
}
