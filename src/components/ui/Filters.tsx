"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconChevronLeft, IconChevronRight, IconFilter, IconSearch, IconX } from "./Icons";
import { Spinner } from "./Button";

/** Zmení jeden query parameter a resetuje stránkovanie. */
function useQueryUpdater() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return useCallback(
    (updates: Record<string, string | null>, options?: { keepPage?: boolean }) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!options?.keepPage) next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
}

/** Vyhľadávanie s debounce (§21). */
export function SearchInput({
  placeholder = "Hľadať…",
  paramName = "q",
  className,
}: {
  placeholder?: string;
  paramName?: string;
  className?: string;
}) {
  const params = useSearchParams();
  const update = useQueryUpdater();
  const [value, setValue] = useState(params.get(paramName) ?? "");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setValue(params.get(paramName) ?? "");
  }, [params, paramName]);

  useEffect(() => {
    const current = params.get(paramName) ?? "";
    if (value === current) return;
    const timer = setTimeout(() => {
      startTransition(() => update({ [paramName]: value || null }));
    }, 300);
    return () => clearTimeout(timer);
  }, [value, params, paramName, update]);

  return (
    <div className={cn("relative", className)}>
      <IconSearch className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-11 w-full rounded-12 border border-line bg-surface pr-10 pl-10 text-[15px] text-ink placeholder:text-faint focus:border-ink focus:outline-none"
      />
      {pending ? (
        <Spinner className="absolute top-1/2 right-3 -translate-y-1/2 text-faint" />
      ) : value ? (
        <button
          type="button"
          onClick={() => setValue("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-faint hover:bg-subtle"
          aria-label="Vymazať hľadanie"
        >
          <IconX width={16} height={16} />
        </button>
      ) : null}
    </div>
  );
}

export function FilterSelect({
  paramName,
  label,
  options,
  allLabel = "Všetko",
}: {
  paramName: string;
  label: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  const params = useSearchParams();
  const update = useQueryUpdater();
  const value = params.get(paramName) ?? "";

  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-semibold text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => update({ [paramName]: e.target.value || null })}
        className="h-11 rounded-12 border border-line bg-surface px-3 text-sm text-ink focus:border-ink focus:outline-none"
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Na mobile sú filtre v bottom sheete, na desktope v riadku (§69). */
export function FilterBar({ children, activeCount }: { children: ReactNode; activeCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="hidden flex-wrap items-end gap-3 lg:flex">{children}</div>

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="touch inline-flex cursor-pointer items-center gap-2 rounded-12 border border-line-strong bg-surface px-4 text-sm font-semibold text-ink lg:hidden"
      >
        <IconFilter width={18} height={18} />
        Filtre
        {activeCount > 0 ? (
          <span className="rounded-full bg-accent px-1.5 text-xs font-bold text-ink">{activeCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ink/28"
            onClick={() => setOpen(false)}
            aria-label="Zavrieť filtre"
          />
          <div className="safe-bottom absolute inset-x-0 bottom-0 max-h-[80vh] animate-(--animate-crew-up) overflow-y-auto rounded-t-20 bg-surface p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-extrabold tracking-[-0.03em]">Filtre</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="touch cursor-pointer rounded-10 p-2 text-muted"
                aria-label="Zavrieť"
              >
                <IconX />
              </button>
            </div>
            <div className="flex flex-col gap-4">{children}</div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-5 h-12 w-full cursor-pointer rounded-12 bg-ink font-semibold text-white"
            >
              Zobraziť výsledky
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}) {
  const update = useQueryUpdater();
  if (pageCount <= 1) {
    return (
      <p className="px-4 py-3 text-sm text-muted">
        {total} {total === 1 ? "záznam" : total < 5 ? "záznamy" : "záznamov"}
      </p>
    );
  }
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <p className="text-sm text-muted">
        {from}–{to} z {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => update({ page: String(page - 1) }, { keepPage: true })}
          className="touch flex cursor-pointer items-center justify-center rounded-10 border border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Predchádzajúca strana"
        >
          <IconChevronLeft width={18} height={18} />
        </button>
        <span className="px-2 text-sm font-medium tabular-nums">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => update({ page: String(page + 1) }, { keepPage: true })}
          className="touch flex cursor-pointer items-center justify-center rounded-10 border border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Ďalšia strana"
        >
          <IconChevronRight width={18} height={18} />
        </button>
      </div>
    </div>
  );
}

export function SortSelect({
  options,
  paramName = "sort",
}: {
  options: { value: string; label: string }[];
  paramName?: string;
}) {
  return <FilterSelect paramName={paramName} label="Zoradiť" options={options} allLabel="Predvolené" />;
}
