/**
 * GET|POST /functions/v1/unsubscribe?t=<token>
 *
 * The link at the bottom of every marketing mail BLUP sends, and the target of
 * the List-Unsubscribe header that Gmail and Yahoo now require on bulk mail.
 *
 * Two things make this different from every other function here.
 *
 * It takes no session. The person clicking is in a mail client; many of them
 * never had a BLUP account, and an unsubscribe that demands a login is not an
 * unsubscribe. The token in the URL is the whole authority, which is why
 * `email_unsubscribe()` does exactly one thing — set a flag — and cannot read
 * an address, list anything, or touch an account.
 *
 * And it answers a POST with no confirmation page (RFC 8058 one-click), while
 * answering a GET with a human page, because the same URL is both the header
 * target and the link in the footer.
 *
 * It always says the same thing. A response that distinguished "unsubscribed"
 * from "no such token" would be an address checker with a nice stylesheet.
 */
import { adminClient, corsHeaders, handleOptions } from '../_shared/http.ts';

const page = (body: string) => `<!doctype html>
<html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Odhlásenie z e-mailov · Blup</title></head>
<body style="margin:0;background:#F2F5F8;font:400 16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#0A0D12">
<div style="max-width:520px;margin:12vh auto;padding:0 20px">
  <div style="font:900 30px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:-1.2px">Blup<span style="color:#0080FF">.</span></div>
  <div style="background:#fff;border-radius:16px;padding:28px;margin-top:22px">${body}</div>
</div></body></html>`;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const url = new URL(req.url);
  let token = url.searchParams.get('t') ?? '';

  // A one-click POST may put the token in the form body instead of the query.
  if (!token && req.method === 'POST') {
    try {
      const form = await req.formData();
      token = String(form.get('t') ?? '');
    } catch {
      // Some clients POST an empty body with the token still in the URL. That
      // case is already covered above; there is nothing to recover here.
    }
  }

  try {
    // Deliberately not checked for success: the answer is the same either way.
    await adminClient().rpc('email_unsubscribe', { p_token: token });
  } catch {
    // A database that is down must not turn into "your unsubscribe failed" —
    // the row will be caught by the same click tomorrow, and telling somebody
    // their unsubscribe did not work is how a complaint gets filed instead.
  }

  if (req.method === 'POST') {
    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  return new Response(
    page(`
      <div style="font:800 22px/1.3 -apple-system,Segoe UI,Roboto,sans-serif">Hotovo, viac ti nenapíšeme.</div>
      <p style="color:#5B6675">
        Odhlásili sme túto adresu z newsletterov a upozornení od organizátorov.
        Ak si od nás niekedy kúpiš vstupenku, tá ti príde aj tak — to nie je
        reklama, to je tvoja vstupenka.
      </p>
      <p style="color:#5B6675">
        Bola to chyba? Prihlás sa a v <em>Nastavenia → E-maily</em> si to zase zapneš.
      </p>
      <a href="https://blup.sk" style="display:inline-block;margin-top:8px;background:#0080FF;color:#fff;text-decoration:none;font:700 15px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 22px;border-radius:12px">Späť na Blup</a>
    `),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } },
  );
});
