/**
 * Meta Conversions API — nákup nahlásený zo servera.
 *
 * Pixel v prehliadači stráca nákupy a nie je to jeho chyba: blokovače reklám,
 * Safari, zatvorená karta skôr, než sa stihla odoslať posledná udalosť. Server
 * o nákupe vie vždy, lebo sa to dozvie od Stripu.
 *
 * Tri veci, na ktorých to celé stojí:
 *
 *   DEDUPLIKÁCIA. Prehliadač aj server posielajú ten istý `event_id` — u nás
 *   `purchase_<id objednávky>`. Meta podľa neho pozná, že je to jeden nákup, a
 *   nezapočíta ho dvakrát. Bez toho by sa tržby v Ads Manageri zdvojnásobili a
 *   každé rozhodnutie o rozpočte by stálo na vymyslenom čísle.
 *
 *   SÚHLAS. Posiela sa len to, čo `marketing_purchase_payload` pustí — a tá
 *   funkcia vráti null všade, kde človek marketing odmietol. Server sa nemá ako
 *   opýtať, takže sa pýta prehliadač a odpoveď sa ukladá k objednávke.
 *
 *   HAŠOVANIE. E-mail odchádza ako SHA-256, nikdy v čitateľnej podobe — tak to
 *   Meta aj vyžaduje. Normalizuje sa pred hašovaním (orezať, malé písmená),
 *   lebo „Jana@Example.com " a „jana@example.com" musia dať ten istý haš, inak
 *   sa nespárujú.
 *
 * Nenastavený token = funkcia mlčí a vráti `skipped`. Nákup to nepokazí.
 */
import { env } from './env.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface PurchasePayload {
  value_cents: number;
  currency: string;
  event_id: string | null;
  quantity: number;
  content_ids: (string | null)[];
  email: string | null;
  fbp: string | null;
  fbc: string | null;
  ip: string | null;
  ua: string | null;
}

export type CapiResult =
  | { status: 'sent'; received: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/** SHA-256 v hexe — tvar, v ktorom Meta očakáva osobné údaje. */
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Nahlási nákup.
 *
 * `orderId` je to, čo spája túto správu s tou z prehliadača. Musí to byť presne
 * to isté id, aké použila stránka — inak deduplikácia nefunguje a je to horšie,
 * než keby sa neposielalo nič.
 */
export async function reportPurchase(
  pixelId: string | null,
  orderId: string,
  payload: PurchasePayload,
): Promise<CapiResult> {
  const token = env.metaCapiToken();
  if (!token) return { status: 'skipped', reason: 'META_CAPI_NOT_CONFIGURED' };
  if (!pixelId) return { status: 'skipped', reason: 'NO_PIXEL_ID' };

  const user: Record<string, unknown> = {};
  if (payload.email) user.em = [await sha256(payload.email.trim().toLowerCase())];
  // `_fbp` a `_fbc` sa neHAŠUJÚ — sú to vlastné identifikátory Mety, nie
  // osobné údaje, a zahašované by jej nepovedali nič.
  if (payload.fbp) user.fbp = payload.fbp;
  if (payload.fbc) user.fbc = payload.fbc;
  if (payload.ip) user.client_ip_address = payload.ip;
  if (payload.ua) user.client_user_agent = payload.ua;

  // Bez jediného párovacieho údaja Meta udalosť prijme a zahodí. Radšej to
  // povedať rovno, než si do grafu kresliť odoslané správy, ktoré nikam nešli.
  if (Object.keys(user).length === 0) {
    return { status: 'skipped', reason: 'NO_MATCH_KEYS' };
  }

  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      // Rovnaké id ako v prehliadači. Toto je celá deduplikácia.
      event_id: `purchase_${orderId}`,
      action_source: 'website',
      event_source_url: `${env.appUrl().replace(/\/+$/, '')}/checkout/return`,
      user_data: user,
      custom_data: {
        currency: (payload.currency || 'EUR').toUpperCase(),
        value: (payload.value_cents ?? 0) / 100,
        content_type: 'product',
        content_ids: payload.content_ids.filter(Boolean),
        num_items: payload.quantity ?? 1,
      },
    }],
    ...(env.metaCapiTestCode() ? { test_event_code: env.metaCapiTestCode() } : {}),
  };

  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(pixelId)}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Správu od Mety áno, telo požiadavky nie: je v ňom zahašovaný e-mail a
      // IP, a to nemá čo ležať v logu.
      return {
        status: 'failed',
        reason: String(result?.error?.message ?? `HTTP ${response.status}`).slice(0, 200),
      };
    }
    return { status: 'sent', received: Number(result?.events_received ?? 0) };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message.slice(0, 200) : 'FETCH_FAILED' };
  }
}
