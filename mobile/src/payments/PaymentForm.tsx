import React from 'react';

/**
 * Natívna náhrada za webový platobný formulár.
 *
 * Na telefóne sa karta nevypĺňa v stránke — otvorí sa Stripe PaymentSheet,
 * ktorý prinesie Apple Pay aj Google Pay. Tento súbor existuje iba preto, aby
 * sa `import { PaymentForm }` dal preložiť aj v natívnom builde; obrazovka
 * pokladne si podľa platformy vyberie sama a tu nikdy nezavíta.
 *
 * Zámerne nevykresľuje „tlačidlo, ktoré nič nerobí": vracia null, takže ak by
 * sa sem niekedy natívny kód predsa dostal, nebude to falošná ponuka zaplatiť.
 */

export interface IntentHandles {
  clientSecret: string;
  returnUrl: string;
}

export interface PaymentFormProps {
  amountCents: number;
  currency: string;
  payLabel: string;
  disabled?: boolean;
  createIntent: () => Promise<IntentHandles>;
  onAuthorized: () => void;
  onError: (message: string) => void;
}

export function PaymentForm(_props: PaymentFormProps): React.ReactElement | null {
  return null;
}
