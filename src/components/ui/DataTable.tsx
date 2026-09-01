"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconChevronRight } from "./Icons";

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Vynechá stĺpec z mobilnej karty (na desktope ostáva). */
  hideOnCard?: boolean;
  align?: "left" | "right";
  width?: string;
};

export type DataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  getKey: (row: T) => string;
  /** Odkaz na detail — na mobile robí celú kartu klikateľnou. */
  href?: (row: T) => string;
  /** Vlastná mobilná karta; bez nej sa generuje z definície stĺpcov (§68). */
  card?: (row: T) => ReactNode;
  selection?: {
    selected: Set<string>;
    onToggle: (key: string) => void;
    onToggleAll: (keys: string[]) => void;
  };
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
};

export function DataTable<T>({
  rows,
  columns,
  getKey,
  href,
  card,
  selection,
  empty,
  rowClassName,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  const allKeys = rows.map(getKey);
  const allSelected = rows.length > 0 && allKeys.every((k) => selection?.selected.has(k));

  return (
    <>
      {/* Desktop: klasická tabuľka */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              {selection ? (
                <th scope="col" className="w-10 px-3 py-3.5">
                  <input
                    type="checkbox"
                    className="size-4 accent-ink"
                    checked={allSelected}
                    onChange={() => selection.onToggleAll(allKeys)}
                    aria-label="Označiť všetky riadky"
                  />
                </th>
              ) : null}
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    "px-3 py-3.5 text-xs font-semibold tracking-[0.08em] text-faint uppercase",
                    col.align === "right" && "text-right",
                  )}
                >
                  {col.header}
                </th>
              ))}
              {href ? <th scope="col" className="w-10 px-3 py-3.5" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {rows.map((row) => {
              const key = getKey(row);
              return (
                <tr key={key} className={cn("transition-colors duration-150 hover:bg-hover", rowClassName?.(row))}>
                  {selection ? (
                    <td className="px-3 py-4">
                      <input
                        type="checkbox"
                        className="size-4 accent-ink"
                        checked={selection.selected.has(key)}
                        onChange={() => selection.onToggle(key)}
                        aria-label="Označiť riadok"
                      />
                    </td>
                  ) : null}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn("px-3 py-4 align-middle text-sm", col.align === "right" && "text-right")}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                  {href ? (
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={href(row)}
                        className="inline-flex rounded-10 p-1.5 text-faint transition-colors hover:bg-subtle hover:text-ink"
                        aria-label="Otvoriť detail"
                      >
                        <IconChevronRight width={18} height={18} />
                      </Link>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobil: karty namiesto zmenšenej tabuľky (§68) */}
      <ul className="divide-y divide-divider md:hidden">
        {rows.map((row) => {
          const key = getKey(row);
          const content = card ? (
            card(row)
          ) : (
            <DefaultCard row={row} columns={columns.filter((c) => !c.hideOnCard)} />
          );
          return (
            <li key={key} className="relative">
              <div className="flex items-start gap-3 p-4">
                {selection ? (
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0 accent-ink"
                    checked={selection.selected.has(key)}
                    onChange={() => selection.onToggle(key)}
                    aria-label="Označiť položku"
                  />
                ) : null}
                <div className="min-w-0 flex-1">{content}</div>
                {href ? (
                  <Link
                    href={href(row)}
                    className="touch -m-2 flex items-center justify-center rounded-10 p-2 text-faint"
                    aria-label="Otvoriť detail"
                  >
                    <IconChevronRight />
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function DefaultCard<T>({ row, columns }: { row: T; columns: Column<T>[] }) {
  const [first, ...rest] = columns;
  return (
    <>
      <div className="text-[15px] font-semibold text-ink">{first?.cell(row)}</div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {rest.map((col) => (
          <div key={col.key} className="flex min-w-0 flex-col">
            <dt className="text-xs text-faint">{col.header}</dt>
            <dd className="truncate text-[13px] text-body">{col.cell(row)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
