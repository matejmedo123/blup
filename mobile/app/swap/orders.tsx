import React from 'react';
import { Screen } from '@/components/ui';
import { SwapNav } from '@/swap/SwapNav';
import { MySwapOrders } from '@/components/MySwapOrders';
import { swapAccountRoute } from '@/swap/SwapGuestGate';

/**
 * Čo som na SWAPe kúpil.
 *
 * Tá istá komponenta, ktorá visí aj pod „Moje vstupenky" — zámerne, lebo je
 * to tá istá vec. Kto kúpil vstupenku, hľadá ju medzi vstupenkami; kto rieši
 * svoj SWAP, hľadá ju tu. Dve kópie by sa rozišli pri prvej zmene.
 */
function SwapOrdersScreen() {
  return (
    <Screen scroll>
      <SwapNav active="/swap/orders" />
      <MySwapOrders showEmpty />
    </Screen>
  );
}

export default swapAccountRoute(
  'Tu budú vstupenky, ktoré si na SWAPe kúpil.',
  SwapOrdersScreen,
);
