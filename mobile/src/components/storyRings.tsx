import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getStoryRings, type StoryRing } from '@/api/stories';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Kto má živý príbeh — raz pre celú appku.
 *
 * Krúžok okolo profilovky nemá zmysel len nad feedom. Ak niekto niečo pridal,
 * má to byť vidieť všade, kde je jeho tvár — v správach, pod eventom,
 * v zozname ľudí — a má sa to dať odtiaľ rovno pozrieť. To znamená, že o
 * príbehoch musí vedieť sám `Avatar`, nie každá obrazovka zvlášť.
 *
 * Preto je to kontext a jeden dotaz. Keby si to ťahala každá obrazovka sama,
 * tridsaťpäť avatarov v appke by bolo tridsaťpäť dotazov — a každý by
 * odpovedal o kúsok inak, takže ten istý človek by mal krúžok na jednej
 * obrazovke a na druhej nie.
 *
 * Súbor je zámerne bez UI. `ui.tsx` z neho číta, a keby sa odtiaľ dalo
 * dostať späť do `ui.tsx`, import by sa zacyklil.
 */

interface StoryRingsValue {
  /** Živý príbeh toho človeka, alebo nič. */
  ringFor: (userId?: string | null) => StoryRing | null;
  /** Otvorí ho na celú obrazovku. */
  open: (ring: StoryRing) => void;
  /** Čo je práve otvorené — číta to prehrávač zavesený v koreni appky. */
  opened: StoryRing | null;
  close: () => void;
}

const Ctx = createContext<StoryRingsValue>({
  ringFor: () => null,
  open: () => {},
  opened: null,
  close: () => {},
});

export function StoryRingsProvider({ children }: { children: React.ReactNode }) {
  const { isGuest } = useAuth();
  const [opened, setOpened] = useState<StoryRing | null>(null);

  const rings = useQuery({
    queryKey: ['stories', 'rings'],
    queryFn: () => getStoryRings(60),
    // A guest follows nobody and has nothing of their own, so there is
    // nothing to ask about — and asking would be a 401 on every screen.
    enabled: !isGuest,
    // A story is a 24-hour object; a minute of staleness is not worth a
    // request every time a list re-renders.
    staleTime: 60_000,
  });

  const byId = useMemo(() => {
    const map = new Map<string, StoryRing>();
    for (const ring of rings.data ?? []) map.set(ring.author_id, ring);
    return map;
  }, [rings.data]);

  const ringFor = useCallback(
    (userId?: string | null) => (userId ? byId.get(userId) ?? null : null),
    [byId],
  );

  const value = useMemo<StoryRingsValue>(
    () => ({ ringFor, open: setOpened, opened, close: () => setOpened(null) }),
    [ringFor, opened],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStoryRings(): StoryRingsValue {
  return useContext(Ctx);
}

/**
 * Krúžok pre jednu tvár.
 *
 * Vracia niečo len vtedy, keď je v ňom niečo NEPOZRETÉ. Pozretý príbeh krúžok
 * nemá — to je celý zmysel krúžku — a keďže bez krúžku niet čoho sa dotknúť,
 * avatar sa vtedy správa presne ako predtým a nekradne ťuknutie riadku, v
 * ktorom sedí.
 */
export function useStoryRing(userId?: string | null): StoryRing | null {
  const { ringFor } = useStoryRings();
  const ring = ringFor(userId);
  return ring && ring.unseen_count > 0 ? ring : null;
}
