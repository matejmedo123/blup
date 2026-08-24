/**
 * GET /functions/v1/og?ref=<slug|uuid>&kind=event|org
 *
 * The link-preview card for a shared BLUP address.
 *
 * The web build is a static export: every page ships the same og:image and the
 * same description, because the tags are written at build time and the event is
 * only known in the browser. A crawler never runs that JavaScript, so pasting an
 * event into Instagram or WhatsApp produced the generic BLUP card — or nothing.
 *
 * This returns a tiny HTML document carrying that one event's title, its own
 * cover image and a real description. Only crawlers are sent here; a person
 * following the same link gets the app, untouched. The <meta refresh> and the
 * link in the body are for the case where a person does land here anyway.
 *
 * Public and unauthenticated by design — a preview card is public information —
 * so it only ever reads published, public events.
 */
import { adminClient } from '../_shared/http.ts';
import { optionalEnv } from '../_shared/env.ts';

const SITE = (optionalEnv('APP_PUBLIC_URL') ?? 'https://blup.sk').replace(/\/+$/, '');
const FALLBACK_IMAGE = `${SITE}/og.png`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escapes for an HTML attribute. Titles are user input and reach a page here. */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One line, no runaway length: a preview card shows about 160 characters. */
function summarise(text: string | null, limit = 180): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1).replace(/\s\S*$/, '')}…`;
}

function dateLine(startAt: string | null, city: string | null, venue: string | null): string {
  const parts: string[] = [];
  if (startAt) {
    parts.push(new Intl.DateTimeFormat('sk-SK', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Bratislava',
    }).format(new Date(startAt)));
  }
  if (venue) parts.push(venue);
  else if (city) parts.push(city);
  return parts.join(' · ');
}

function page(o: {
  title: string;
  description: string;
  image: string;
  url: string;
  type: string;
}): Response {
  const html = `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<title>${attr(o.title)}</title>
<meta name="description" content="${attr(o.description)}">
<meta property="og:type" content="${attr(o.type)}">
<meta property="og:site_name" content="Blup">
<meta property="og:locale" content="sk_SK">
<meta property="og:title" content="${attr(o.title)}">
<meta property="og:description" content="${attr(o.description)}">
<meta property="og:image" content="${attr(o.image)}">
<meta property="og:url" content="${attr(o.url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(o.title)}">
<meta name="twitter:description" content="${attr(o.description)}">
<meta name="twitter:image" content="${attr(o.image)}">
<link rel="canonical" href="${attr(o.url)}">
<meta http-equiv="refresh" content="0; url=${attr(o.url)}">
</head>
<body>
<p><a href="${attr(o.url)}">${attr(o.title)}</a></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Crawlers re-fetch; a short cache keeps a burst of shares off the database
      // without pinning a stale title for long after the organizer fixes it.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const ref = (url.searchParams.get('ref') ?? '').trim();
  const kind = url.searchParams.get('kind') === 'org' ? 'org' : 'event';

  const generic = {
    title: 'Blup — eventy okolo teba',
    description:
      'Nájdi, čo sa dnes deje v tvojom meste, kúp si lístok na jednom mieste a choď tam s ľuďmi, ktorých poznáš.',
    image: FALLBACK_IMAGE,
    url: SITE,
    type: 'website',
  };

  if (!ref) return page(generic);

  try {
    const db = adminClient();

    if (kind === 'org') {
      const { data } = await db
        .from('organizations')
        .select('id, slug, name, description, logo_url')
        .eq(UUID.test(ref) ? 'id' : 'slug', ref)
        .maybeSingle();

      if (!data) return page(generic);

      return page({
        title: `${data.name} — Blup`,
        description: summarise(data.description) || `Čo chystá ${data.name}. Pozri sa na Blupe.`,
        image: data.logo_url ?? FALLBACK_IMAGE,
        url: `${SITE}/org/${data.id}`,
        type: 'profile',
      });
    }

    const { data } = await db
      .from('events')
      .select('id, slug, title, description, cover_image_url, start_at, city, venue_name, status, visibility')
      .eq(UUID.test(ref) ? 'id' : 'slug', ref)
      .maybeSingle();

    // A private or unpublished event has no public card — the generic one is the
    // honest answer, not a leak of its title.
    if (!data || data.status !== 'published' || data.visibility !== 'public') {
      return page(generic);
    }

    const when = dateLine(data.start_at, data.city, data.venue_name);
    const body = summarise(data.description);

    return page({
      title: `${data.title} — Blup`,
      description: [when, body].filter(Boolean).join(' — ') || 'Pozri si tento event na Blupe.',
      image: data.cover_image_url ?? FALLBACK_IMAGE,
      url: `${SITE}/event/${data.slug ?? data.id}`,
      type: 'article',
    });
  } catch {
    // A preview that fails is a card that does not appear. The generic one is
    // always better than an error page in somebody's chat.
    return page(generic);
  }
});
