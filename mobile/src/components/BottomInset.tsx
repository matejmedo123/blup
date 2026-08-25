import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * How much of the bottom of the screen a page has already claimed.
 *
 * Floating things — the basket bubble, and anything else that ends up down
 * there — have no idea what a screen has put in that corner. Home has a
 * "Vytvor event" button; the map adds a card that can be four events tall.
 * Without somewhere to say so, they are all drawn on top of each other, which
 * is exactly what happened.
 *
 * A screen reports the height it occupies and the floating layer sits above it.
 * Reporting `0` (or unmounting) gives the corner back.
 */
const BottomInsetContext = createContext<{
  inset: number;
  report: (key: string, height: number) => void;
}>({ inset: 0, report: () => {} });

export function BottomInsetProvider({ children }: { children: React.ReactNode }) {
  const [claims, setClaims] = useState<Record<string, number>>({});

  const value = useMemo(() => ({
    // The tallest claim wins: two things in the same corner overlap each other
    // already, so stacking their heights would leave a gap, not a fix.
    inset: Math.max(0, ...Object.values(claims)),
    report: (key: string, height: number) =>
      setClaims((current) => {
        if ((current[key] ?? 0) === height) return current;
        const next = { ...current };
        if (height > 0) next[key] = height;
        else delete next[key];
        return next;
      }),
  }), [claims]);

  return <BottomInsetContext.Provider value={value}>{children}</BottomInsetContext.Provider>;
}

/** What a floating element has to clear. */
export function useBottomInset(): number {
  return useContext(BottomInsetContext).inset;
}

/** Claims the bottom of the screen while this component is mounted. */
export function useClaimBottom(key: string, height: number): void {
  const { report } = useContext(BottomInsetContext);

  useEffect(() => {
    report(key, height);
    return () => report(key, 0);
  }, [key, height, report]);
}
