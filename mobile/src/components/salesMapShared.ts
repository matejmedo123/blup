/**
 * Shared between SalesMap and SalesMap.web.
 *
 * In its own file because Metro resolves `./SalesMap` from inside
 * SalesMap.web.tsx back to SalesMap.web.tsx — a file importing itself, with
 * every export undefined. That has cost this project a whole screen once
 * already (see ImageCrop).
 */
export interface CityPoint {
  city: string;
  orders: number;
  tickets: number;
  gross_cents: number;
  latitude: number | null;
  longitude: number | null;
}
