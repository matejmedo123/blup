/**
 * POST /functions/v1/ticket-email
 *
 * Drains the ticket-email queue: renders each pending delivery as an HTML mail
 * with a PDF attachment (one page per ticket, QR included) and sends it.
 *
 * Called three ways, all of them safe to overlap:
 *   · by stripe-webhook right after an order is fulfilled — the fast path
 *   · by cron, to retry what failed and catch anything the webhook missed
 *   · by the app, when someone taps "send it to me again"
 *
 * `claim_email_deliveries()` marks rows 'sending' with `for update skip locked`,
 * so two concurrent runs can never grab the same delivery and nobody gets their
 * ticket twice.
 *
 * Body (all optional): { order_id?: string, limit?: number }
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, readJson, requireUser,
} from '../_shared/http.ts';
import { ConfigurationError, emailConfigured, sendEmail, toBase64 } from '../_shared/email.ts';
import { ticketPdf, type TicketPdfInput } from '../_shared/pdf.ts';
import { env } from '../_shared/env.ts';

interface Body {
  order_id?: string;
  limit?: number;
}

interface Delivery {
  id: string;
  order_id: string | null;
  to_email: string;
  subject: string;
}

interface Payload {
  order_id: string;
  order_reference: string;
  quantity: number;
  currency: string;
  total_cents: number;
  archive_fee_cents: number;
  buyer_name: string;
  organizer: string;
  event: {
    id: string; title: string; start_at: string; end_at: string | null;
    venue_name: string | null; address: string | null; category: string | null;
  };
  tickets: { id: string; code: string; qr_secret: string; type: string; price_cents: number }[];
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('sk-SK', { style: 'currency', currency }).format(cents / 100);

const whenLabel = (iso: string) =>
  new Intl.DateTimeFormat('sk-SK', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bratislava',
  }).format(new Date(iso));

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The mail body. Deliberately table-based and inline-styled: every clever
 * layout technique of the last decade is unsupported by at least one client
 * people actually read mail in, and a broken ticket email is a support ticket.
 */
function renderHtml(payload: Payload): string {
  const { event, tickets } = payload;
  const place = [event.venue_name, event.address].filter(Boolean).join(', ');
  const appUrl = env.appUrl();

  const rows = tickets.map((ticket, i) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #E6EAF0;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0D12">
        ${escapeHtml(ticket.type)} <span style="color:#7E8A9C;font-weight:400">· ${i + 1}/${tickets.length}</span>
      </td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid #E6EAF0;font:600 13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#0080FF">
        ${escapeHtml(ticket.code)}
      </td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(event.title)}</title></head>
<body style="margin:0;padding:0;background:#F2F5F8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F5F8">
  <tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">

      <tr><td style="background:#0A0D12;padding:22px 26px">
        <div style="font:900 26px/1 -apple-system,Segoe UI,Roboto,sans-serif;color:#ffffff;letter-spacing:-1px">Blup<span style="color:#0080FF">.</span></div>
        <div style="font:700 11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#9AA6B6;letter-spacing:1.5px;margin-top:6px">TVOJA VSTUPENKA</div>
      </td></tr>

      <tr><td style="padding:26px">
        <div style="font:800 21px/1.25 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0D12">${escapeHtml(event.title)}</div>
        <div style="font:400 15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#5B6675;margin-top:8px">${escapeHtml(whenLabel(event.start_at))}</div>
        ${place ? `<div style="font:400 15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#5B6675">${escapeHtml(place)}</div>` : ''}
        <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#7E8A9C;margin-top:8px">Organizuje ${escapeHtml(payload.organizer)}</div>

        <div style="margin:22px 0;padding:16px;background:#F2F5F8;border-radius:12px">
          <div style="font:700 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0D12">
            ${tickets.length === 1 ? 'Vstupenka je v prílohe' : `${tickets.length} vstupenky sú v prílohe`}
          </div>
          <div style="font:400 13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#5B6675;margin-top:5px">
            Otvor PDF a ukáž QR kód pri vstupe — stačí z telefónu, nemusíš nič tlačiť.
            Rovnaké vstupenky nájdeš aj v aplikácii.
          </div>
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
          <tr><td style="font:400 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#5B6675;padding:4px 0">Zaplatené</td>
              <td align="right" style="font:700 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0D12;padding:4px 0">${money(payload.total_cents, payload.currency)}</td></tr>
          <tr><td style="font:400 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#7E8A9C;padding:4px 0">Objednávka</td>
              <td align="right" style="font:400 13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7E8A9C;padding:4px 0">${escapeHtml(payload.order_reference)}</td></tr>
        </table>

        <div style="margin-top:24px">
          <a href="${appUrl}/tickets" style="display:inline-block;background:#0080FF;color:#ffffff;text-decoration:none;font:700 15px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 22px;border-radius:12px">Otvoriť v Blupe</a>
        </div>

        <div style="font:400 12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#9AA6B6;margin-top:22px">
          Každý QR kód je jednorazový — po načítaní pri vstupe už druhýkrát neprejde.
          Ak si vstupenku nekupoval ty, napíš nám a objednávku zrušíme.
        </div>
      </td></tr>

      <tr><td style="background:#F2F5F8;padding:16px 26px;font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#9AA6B6">
        Blup · eventy okolo teba
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function renderText(payload: Payload): string {
  const { event, tickets } = payload;
  const place = [event.venue_name, event.address].filter(Boolean).join(', ');
  return [
    `TVOJA VSTUPENKA — ${event.title}`,
    whenLabel(event.start_at),
    place,
    '',
    ...tickets.map((t, i) => `${i + 1}. ${t.type} — ${t.code}`),
    '',
    `Zaplatené: ${money(payload.total_cents, payload.currency)}`,
    `Objednávka: ${payload.order_reference}`,
    '',
    'Vstupenky sú v priloženom PDF. Ukáž QR kód pri vstupe.',
    `Nájdeš ich aj v aplikácii: ${env.appUrl()}/tickets`,
  ].filter(Boolean).join('\n');
}

function buildPdf(payload: Payload): Uint8Array {
  const pages: TicketPdfInput[] = payload.tickets.map((ticket, i) => ({
    eventTitle: payload.event.title,
    whenLabel: whenLabel(payload.event.start_at),
    venue: [payload.event.venue_name, payload.event.address].filter(Boolean).join(', '),
    ticketType: ticket.type,
    holder: payload.buyer_name,
    code: ticket.code,
    qrPayload: `blup://t/${ticket.code}/${ticket.qr_secret}`,
    priceLabel: money(ticket.price_cents, payload.currency),
    orderReference: payload.order_reference,
    index: i + 1,
    total: payload.tickets.length,
  }));
  return ticketPdf(pages);
}

async function deliver(db: ReturnType<typeof adminClient>, delivery: Delivery): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    if (!delivery.order_id) throw new Error('DELIVERY_HAS_NO_ORDER');

    const { data, error } = await db.rpc('ticket_email_payload', { p_order_id: delivery.order_id });
    if (error) throw new Error(error.message);

    const payload = data as Payload;
    if (!payload?.tickets?.length) {
      // Every ticket refunded before we got here: there is nothing to send, and
      // retrying will not change that.
      await db.rpc('mark_email_failed', {
        p_id: delivery.id, p_error: 'NO_TICKETS_TO_SEND', p_skipped: true,
      });
      return 'skipped';
    }

    const pdf = buildPdf(payload);
    const result = await sendEmail({
      to: delivery.to_email,
      subject: delivery.subject,
      html: renderHtml(payload),
      text: renderText(payload),
      replyTo: env.emailReplyTo(),
      attachments: [{
        filename: `blup-vstupenka-${payload.order_reference}.pdf`,
        content: toBase64(pdf),
        contentType: 'application/pdf',
      }],
    });

    await db.rpc('mark_email_sent', {
      p_id: delivery.id, p_provider: result.provider, p_message_id: result.id,
    });
    return 'sent';
  } catch (error) {
    // A deployment with no mail provider is not a failure to retry — it is a
    // deployment that has not wired email up yet. Everything else backs off.
    const skipped = error instanceof ConfigurationError;
    await db.rpc('mark_email_failed', {
      p_id: delivery.id,
      p_error: error instanceof Error ? error.message : 'Unknown error',
      p_skipped: skipped,
    });
    return skipped ? 'skipped' : 'failed';
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const body = req.method === 'POST' ? await readJson<Body>(req).catch(() => ({} as Body)) : {};
    const db = adminClient();

    // A request naming one order is a person pressing "send it again"; it needs
    // a session. A bare drain is the cron sweep and runs on the service key.
    if (body.order_id) {
      await requireUser(req);
    }

    if (body.order_id) {
      const { error } = await db.rpc('queue_ticket_email', { p_order_id: body.order_id });
      if (error) throw new Error(error.message);
    }

    const { data, error } = await db.rpc('claim_email_deliveries', {
      p_limit: Math.min(Math.max(Number(body.limit) || 25, 1), 100),
    });
    if (error) throw new Error(error.message);

    const deliveries = (data ?? []) as Delivery[];
    const counts = { sent: 0, skipped: 0, failed: 0 };

    for (const delivery of deliveries) {
      counts[await deliver(db, delivery)] += 1;
    }

    return json({
      email_configured: emailConfigured(),
      claimed: deliveries.length,
      ...counts,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
