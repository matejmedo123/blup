/**
 * POST /functions/v1/resale-payout
 *
 * Pošle predajcovi peniaze, na ktoré mu už vznikol nárok.
 *
 * Volá sa z cronu, nie z appky. Appka o výplatu požiada cez
 * `request_seller_payout()`, ktorá sumu určí z knihy a založí záznam v stave
 * `pending`; táto funkcia potom tie záznamy vezme a skutočne prevedie peniaze.
 *
 * Suma sa odtiaľto nikdy neberie z requestu. Keby sa brala, dalo by sa vypýtať
 * viac, než človeku patrí — a to je presne ten druh chyby, ktorá sa zistí až
 * pri mesačnej uzávierke.
 *
 * Prevod je idempotentný cez kľúč `payout_<id>`: ak cron zbehne dvakrát alebo
 * spadne medzi prevodom a zápisom, Stripe druhý prevod nespraví a vráti ten
 * pôvodný.
 */
import { ApiError, adminClient, errorResponse, handleOptions, json } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';
import { stripe } from '../_shared/stripe.ts';

interface PayoutRow {
  id: string;
  seller_id: string;
  amount_cents: number;
  currency: string;
  held_reason: string | null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);
    }
    // Len service-role: toto je cieľ pre cron, nie koncový bod pre appku.
    // Keby sa dal zavolať s bežným tokenom, ktokoľvek by vedel spustiť
    // odosielanie peňazí.
    const auth = req.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${env.serviceRoleKey()}`) {
      return json({ error: 'FORBIDDEN' }, 403);
    }

    const db = adminClient();

    const { data: queued, error } = await db
      .from('seller_payouts')
      .select('id, seller_id, amount_cents, currency, held_reason')
      .eq('status', 'pending')
      // Zadržaná výplata sa neposiela. `held_reason` nastavuje otvorený spor,
      // zrušený event alebo vyššie riziko — a všetky tri majú prejsť cez
      // človeka, nie cez cron.
      .is('held_reason', null)
      .order('requested_at', { ascending: true })
      .limit(50);

    if (error) throw error;

    const rows = (queued ?? []) as PayoutRow[];
    const sent: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const payout of rows) {
      const { data: account } = await db
        .from('seller_accounts')
        .select('provider_account_id, payouts_enabled')
        .eq('user_id', payout.seller_id)
        .maybeSingle();

      if (!account?.provider_account_id || !account.payouts_enabled) {
        // Nie je to chyba výplaty, je to chýbajúci účet. Zostáva `pending` a
        // odíde, keď si človek účet dokončí.
        failed.push({ id: payout.id, reason: 'PAYOUT_ACCOUNT_NOT_READY' });
        continue;
      }

      try {
        await db
          .from('seller_payouts')
          .update({ status: 'processing' })
          .eq('id', payout.id)
          .eq('status', 'pending');

        const transfer = await stripe.createPayout({
          accountId: account.provider_account_id,
          amountCents: payout.amount_cents,
          currency: payout.currency,
          payoutId: payout.id,
        });

        await db
          .from('seller_payouts')
          .update({
            status: 'paid',
            provider_transfer_id: transfer.id,
            processed_at: new Date().toISOString(),
          })
          .eq('id', payout.id);

        await db.rpc('notify_user', {
          p_user_id: payout.seller_id,
          p_type: 'payout_update',
          p_title: 'Peniaze sú na ceste',
          p_body: 'Výplata odišla na tvoj účet.',
        });

        sent.push(payout.id);
      } catch (caught) {
        const reason = caught instanceof Error ? caught.message : 'TRANSFER_FAILED';
        // Späť na `pending`, nie na `failed`: dočasný výpadok poskytovateľa
        // nemá zmazať nárok človeka na peniaze. Kniha si mínus drží tak či tak.
        await db
          .from('seller_payouts')
          .update({ status: 'pending', failure_reason: reason })
          .eq('id', payout.id);
        failed.push({ id: payout.id, reason });
      }
    }

    return json({ considered: rows.length, sent: sent.length, failed });
  } catch (error) {
    return errorResponse(error);
  }
});
