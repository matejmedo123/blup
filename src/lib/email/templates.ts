import "server-only";

import type { EmailMessage } from "./provider";

const BRAND = { accent: "#C7F36B", ink: "#111111", muted: "#6B6B66", line: "#E6E6E1" };

function appUrl(path = ""): string {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}${path}`;
}

function layout(opts: {
  preheader: string;
  heading: string;
  body: string[];
  cta?: { label: string; href: string };
  footnote?: string;
}): string {
  const paragraphs = opts.body
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${BRAND.ink};">${p}</p>`,
    )
    .join("");
  const cta = opts.cta
    ? `<a href="${opts.cta.href}" style="display:inline-block;margin-top:10px;background:${BRAND.ink};color:#fff;text-decoration:none;border-radius:12px;padding:14px 22px;font-size:15px;font-weight:600;">${opts.cta.label}</a>`
    : "";
  const footnote = opts.footnote
    ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${opts.footnote}</p>`
    : "";

  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#F7F7F5;font-family:Inter,-apple-system,Segoe UI,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid ${BRAND.line};border-radius:20px;">
<tr><td style="padding:28px 28px 0;">
<span style="font-size:20px;font-weight:800;letter-spacing:-0.04em;color:${BRAND.ink};">CREW<span style="color:#9DBF52;">.</span></span>
</td></tr>
<tr><td style="padding:22px 28px 28px;">
<h1 style="margin:0 0 16px;font-size:26px;line-height:1.15;letter-spacing:-0.03em;font-weight:800;color:${BRAND.ink};">${opts.heading}</h1>
${paragraphs}${cta}${footnote}
</td></tr>
</table>
<p style="max-width:560px;margin:18px auto 0;font-size:12px;line-height:1.6;color:${BRAND.muted};text-align:center;">
CREW. · eventová crew platforma<br>Tento e-mail ti prišiel, lebo si sa prihlásil cez crew.sk.
</p>
</td></tr></table></body></html>`;
}

function plain(heading: string, body: string[], cta?: { label: string; href: string }): string {
  const lines = [heading, "", ...body.map((p) => p.replace(/<[^>]+>/g, ""))];
  if (cta) lines.push("", `${cta.label}: ${cta.href}`);
  return lines.join("\n");
}

export const emailTemplates = {
  applicationReceived(args: { to: string; firstName: string; eventName: string }): EmailMessage {
    const heading = "Prihlášku máme.";
    const body = [
      `Ahoj ${args.firstName}, tvoju prihlášku na <strong>${args.eventName}</strong> sme prijali.`,
      "Prejdeme si ju a ozveme sa ti e-mailom. Väčšinou to trvá 2–3 dni.",
    ];
    const cta = { label: "Pozrieť stav prihlášky", href: appUrl("/prihlaska/stav") };
    return {
      to: args.to,
      subject: `Prihláška na ${args.eventName} — prijatá`,
      html: layout({ preheader: "Prihlášku sme prijali.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  applicationApproved(args: { to: string; firstName: string; eventName: string }): EmailMessage {
    const heading = "Si v crew.";
    const body = [
      `Ahoj ${args.firstName}, tvoja prihláška na <strong>${args.eventName}</strong> je schválená.`,
      "Prihlás sa do portálu — nájdeš tam svoje smeny, sadzbu, check-in aj správy od koordinátora.",
      "Smenu ti pridelíme podľa tvojich preferencií a dostupnosti. Vždy ju budeš musieť potvrdiť.",
    ];
    const cta = { label: "Otvoriť portál", href: appUrl("/portal") };
    return {
      to: args.to,
      subject: `Vitaj v crew — ${args.eventName}`,
      html: layout({ preheader: "Prihláška schválená.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  applicationRejected(args: {
    to: string;
    firstName: string;
    eventName: string;
    reason?: string | null;
  }): EmailMessage {
    const heading = "Tentokrát to nevyšlo.";
    const body = [
      `Ahoj ${args.firstName}, na <strong>${args.eventName}</strong> sme ťa tentokrát nezaradili.`,
      args.reason ? `Dôvod: ${args.reason}` : "Kapacita býva naplnená rýchlo, nie je to o tebe.",
      "Tvoj profil ostáva uložený — na ďalší event stačí jeden klik.",
    ];
    return {
      to: args.to,
      subject: `Prihláška na ${args.eventName}`,
      html: layout({ preheader: "Rozhodnutie o prihláške.", heading, body }),
      text: plain(heading, body),
    };
  },

  shiftAssigned(args: {
    to: string;
    firstName: string;
    positionName: string;
    when: string;
    location: string;
    rate: string;
    shiftId: string;
  }): EmailMessage {
    const heading = "Máš novú smenu.";
    const body = [
      `Ahoj ${args.firstName}, pridelili sme ti smenu <strong>${args.positionName}</strong>.`,
      `${args.when}<br>${args.location}<br>${args.rate}`,
      "Prosím potvrď ju v portáli, aby koordinátor vedel, že s tebou ráta.",
    ];
    const cta = { label: "Potvrdiť smenu", href: appUrl(`/portal/shifts/${args.shiftId}`) };
    return {
      to: args.to,
      subject: `Nová smena: ${args.positionName} · ${args.when}`,
      html: layout({ preheader: "Nová smena čaká na potvrdenie.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  shiftUpdated(args: {
    to: string;
    firstName: string;
    positionName: string;
    when: string;
    shiftId: string;
    change: string;
  }): EmailMessage {
    const heading = "Smena sa zmenila.";
    const body = [
      `Ahoj ${args.firstName}, na smene <strong>${args.positionName}</strong> (${args.when}) nastala zmena.`,
      args.change,
    ];
    const cta = { label: "Pozrieť smenu", href: appUrl(`/portal/shifts/${args.shiftId}`) };
    return {
      to: args.to,
      subject: `Zmena smeny: ${args.positionName}`,
      html: layout({ preheader: "Zmena na tvojej smene.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  shiftReminder(args: {
    to: string;
    firstName: string;
    positionName: string;
    when: string;
    location: string;
    coordinator: string;
    shiftId: string;
  }): EmailMessage {
    const heading = "Zajtra máš smenu.";
    const body = [
      `Ahoj ${args.firstName}, pripomíname ti smenu <strong>${args.positionName}</strong>.`,
      `${args.when}<br>${args.location}<br>Koordinátor: ${args.coordinator}`,
      "Ak by si nemohol prísť, daj vedieť čo najskôr — nájdeme náhradu.",
    ];
    const cta = { label: "Zobraziť smenu", href: appUrl(`/portal/shifts/${args.shiftId}`) };
    return {
      to: args.to,
      subject: `Pripomienka: ${args.positionName} · ${args.when}`,
      html: layout({ preheader: "Pripomienka zajtrajšej smeny.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  shiftConfirmationRequired(args: {
    to: string;
    firstName: string;
    positionName: string;
    when: string;
    shiftId: string;
  }): EmailMessage {
    const heading = "Potvrď zajtrajšiu smenu.";
    const body = [
      `Ahoj ${args.firstName}, koordinátor potrebuje vedieť, či prídeš.`,
      `<strong>${args.positionName}</strong><br>${args.when}`,
    ];
    const cta = { label: "Potvrdiť smenu", href: appUrl(`/portal/shifts/${args.shiftId}`) };
    return {
      to: args.to,
      subject: `Potvrď smenu: ${args.positionName} · ${args.when}`,
      html: layout({ preheader: "Potrebujeme potvrdenie smeny.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  shiftCancelled(args: {
    to: string;
    firstName: string;
    positionName: string;
    when: string;
  }): EmailMessage {
    const heading = "Smena je zrušená.";
    const body = [
      `Ahoj ${args.firstName}, smena <strong>${args.positionName}</strong> (${args.when}) bola zrušená.`,
      "Ospravedlňujeme sa. Ďalšie voľné smeny nájdeš v portáli.",
    ];
    const cta = { label: "Pozrieť smeny", href: appUrl("/portal/shifts") };
    return {
      to: args.to,
      subject: `Zrušená smena: ${args.positionName}`,
      html: layout({ preheader: "Smena bola zrušená.", heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  newMessage(args: {
    to: string;
    firstName: string;
    senderName: string;
    preview: string;
    conversationId: string;
  }): EmailMessage {
    const heading = "Nová správa.";
    const body = [
      `Ahoj ${args.firstName}, <strong>${args.senderName}</strong> ti napísal:`,
      `„${args.preview}“`,
    ];
    const cta = { label: "Odpovedať", href: appUrl(`/portal/messages/${args.conversationId}`) };
    return {
      to: args.to,
      subject: `Nová správa od ${args.senderName}`,
      html: layout({ preheader: args.preview, heading, body, cta }),
      text: plain(heading, body, cta),
    };
  },

  emailVerification(args: { to: string; firstName: string; token: string }): EmailMessage {
    const heading = "Over si e-mail.";
    const href = appUrl(`/auth/overenie?token=${args.token}`);
    const body = [
      `Ahoj ${args.firstName}, potvrď prosím svoju e-mailovú adresu.`,
      "Odkaz platí 24 hodín.",
    ];
    const cta = { label: "Overiť e-mail", href };
    return {
      to: args.to,
      subject: "Over si e-mail — CREW.",
      html: layout({ preheader: "Overenie e-mailu.", heading, body, cta, footnote: href }),
      text: plain(heading, body, cta),
    };
  },

  passwordReset(args: { to: string; firstName: string; token: string }): EmailMessage {
    const heading = "Obnovenie hesla.";
    const href = appUrl(`/auth/reset-hesla?token=${args.token}`);
    const body = [
      `Ahoj ${args.firstName}, klikni na tlačidlo a nastav si nové heslo.`,
      "Odkaz platí 60 minút. Ak si o obnovu nežiadal, tento e-mail ignoruj.",
    ];
    const cta = { label: "Nastaviť nové heslo", href };
    return {
      to: args.to,
      subject: "Obnovenie hesla — CREW.",
      html: layout({ preheader: "Obnovenie hesla.", heading, body, cta, footnote: href }),
      text: plain(heading, body, cta),
    };
  },
};
