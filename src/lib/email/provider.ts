import "server-only";

/**
 * E-mailová vrstva je za rozhraním, aby sa provider dal vymeniť jednou
 * premennou `EMAIL_PROVIDER` bez zásahu do volajúceho kódu (§38).
 */

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ id: string }>;
}

/** Vývoj a testy — e-mail sa iba zaloguje, nič sa neodosiela. */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  async send(message: EmailMessage) {
    console.info(
      `\n📧 [CREW.] → ${message.to}\n   ${message.subject}\n${message.text
        .split("\n")
        .map((line) => `   ${line}`)
        .join("\n")}\n`,
    );
    return { id: `console-${Date.now()}` };
  }
}

/** Resend — HTTP API, žiadna ďalšia závislosť. */
class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(message: EmailMessage) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend odmietol e-mail (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as { id: string };
    return { id: data.id };
  }
}

/**
 * Generický webhook — pre SMTP relay alebo vlastnú odosielaciu službu.
 * `EMAIL_WEBHOOK_URL` dostane `{to, subject, html, text}` ako JSON.
 */
class WebhookEmailProvider implements EmailProvider {
  readonly name = "webhook";
  constructor(
    private url: string,
    private token?: string,
  ) {}

  async send(message: EmailMessage) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`E-mailový webhook zlyhal (${response.status}).`);
    return { id: `webhook-${Date.now()}` };
  }
}

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  const kind = process.env.EMAIL_PROVIDER ?? "console";
  const from = process.env.EMAIL_FROM ?? "CREW. <noreply@crew.local>";

  if (kind === "resend" && process.env.RESEND_API_KEY) {
    cached = new ResendEmailProvider(process.env.RESEND_API_KEY, from);
  } else if (kind === "webhook" && process.env.EMAIL_WEBHOOK_URL) {
    cached = new WebhookEmailProvider(process.env.EMAIL_WEBHOOK_URL, process.env.EMAIL_WEBHOOK_TOKEN);
  } else {
    cached = new ConsoleEmailProvider();
  }
  return cached;
}

/** Pre testy — nahradí providera zbernou implementáciou. */
export function setEmailProvider(provider: EmailProvider | null): void {
  cached = provider;
}

/** Odoslanie e-mailu nikdy nesmie zhodiť biznis operáciu. */
export async function sendEmailSafely(message: EmailMessage): Promise<boolean> {
  try {
    await getEmailProvider().send(message);
    return true;
  } catch (error) {
    console.error("Nepodarilo sa odoslať e-mail:", error);
    return false;
  }
}
