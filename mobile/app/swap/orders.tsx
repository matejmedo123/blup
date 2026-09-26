import React from 'react';
import { Screen } from '@/components/ui';
import { SwapNav } from '@/swap/SwapNav';
import { MySwapOrders } from '@/components/MySwapOrders';

/**
 * Čo som na SWAPe kúpil.
 *
 * Tá istá komponenta, ktorá visí aj pod „Moje vstupenky" — zámerne, lebo je
 * to tá istá vec. Kto kúpil vstupenku, hľadá ju medzi vstupenkami; kto rieši
 * svoj SWAP, hľadá ju tu. Dve kópie by sa rozišli pri prvej zmene.
 */
export default function SwapOrdersScreen() {
  return (
    <Screen scroll>
      <SwapNav active="/swap/orders" />
      <MySwapOrders showEmpty />
    </Screen>
  );
}
