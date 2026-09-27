import React from 'react';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { EmptyState, LoadingState, Screen } from '@/components/ui';

/**
 * Účet treba až vtedy, keď niečo robíš.
 *
 * Do SWAPu sa dá vojsť bez prihlásenia a pozrieť si celú ponuku — ceny,
 * pravosť aj rozpis pokladne. Burza, do ktorej sa nedá nakuknúť, nemá komu
 * predať: človek príde z Googlu na vypredaný koncert a keby prvé, čo uvidí,
 * bola prihlasovacia obrazovka, odíde.
 *
 * Účet sa pýta až pri tom, čo sa bez neho spraviť nedá — vstupenku treba niekam
 * priradiť, peniaze niekam poslať a spor s niekým viesť. Tieto obrazovky
 * (moje ponuky, predané, nakúpené, peniaze, predaj) sú presne tie; nemajú čo
 * ukázať, kým nevieme komu.
 *
 * Nie je to bezpečnostné opatrenie a netvári sa tak — databáza tieto volania
 * neprihlásenému odmietne sama (`test_61_swap_guest.sql`). Toto je len to, aby
 * sa človek dozvedel prečo, namiesto chybovej hlášky.
 */
export function SwapGuestGate({ what }: { what: string }) {
  return (
    <Screen scroll>
      {/* Bez vlastného nadpisu — hlavička obrazovky už hovorí, kde si, a
          „BLUP SWAP" druhýkrát pod ňou je ten istý text dvakrát. */}
      <EmptyState
        emoji="🔐"
        title="Na toto treba účet"
        body={`${what} Pozerať ponuku môžeš aj bez neho — účet treba až vtedy, keď má byť vstupenka tvoja.`}
        actionLabel="Zaregistrovať sa"
        onAction={() => router.push('/(auth)/sign-up')}
        secondaryLabel="Už mám účet"
        onSecondary={() => router.push('/(auth)/sign-in')}
      />
    </Screen>
  );
}

/**
 * Obal pre obrazovku, ktorá bez účtu nemá čo ukázať.
 *
 * Nie je to `if` vnútri obrazovky, ale obal okolo nej — a to zámerne. Vnútri
 * by sa musel skorý `return` dostať nad `useQuery`, čo React zakazuje, alebo
 * pod ne, a to by znamenalo, že sa dotazy neprihláseného aj tak odošlú a
 * vrátia chybu. Takto sa obrazovka jednoducho nezmontuje.
 *
 *   export default swapAccountRoute('Tu budú tvoje ponuky.', SellerScreen);
 */
export function swapAccountRoute(what: string, Inner: React.ComponentType) {
  return function SwapAccountRoute() {
    const { isGuest, initializing } = useAuth();
    // Kým sa uložené prihlásenie obnovuje, nikto nie je hosť. Bez tohto by
    // človek s účtom na chvíľu uvidel výzvu na registráciu.
    if (initializing) return <Screen><LoadingState label="Moment…" /></Screen>;
    if (isGuest) return <SwapGuestGate what={what} />;
    return <Inner />;
  };
}
