/**
 * Rows to a CSV a spreadsheet will open without being argued with.
 *
 * Three things that go wrong every time and are handled here once:
 *
 *   * Excel reads a bare UTF-8 file as Windows-1250 and turns "Košice" into
 *     "KoÅ¡ice". A byte-order mark is what stops that, and it is invisible in
 *     everything else.
 *   * A semicolon, not a comma: on a Slovak or German locale Excel splits on
 *     the semicolon, and a comma-separated file lands entirely in column A.
 *   * A value starting with =, +, - or @ is a formula to Excel. Quoting is not
 *     enough — the leading apostrophe is. This is how a CSV export becomes a
 *     way to run something on somebody else's machine.
 */
export function toCsv(
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
  { separator = ';' }: { separator?: string } = {},
): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (text.includes('"') || text.includes(separator) || /[\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const header = columns.map((column) => escape(column.label)).join(separator);
  const body = rows.map(
    (row) => columns.map((column) => escape(row[column.key])).join(separator),
  );

  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/** Cents as a decimal a spreadsheet will treat as a number, in the local style. */
export function csvMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}
