/**
 * Transactional email.
 *
 * One provider (Resend) behind a small interface, because the only thing the
 * rest of the codebase should know is "send this, with this attachment". A
 * missing API key is a first-class state — the queue records the send as
 * skipped and the ticket still exists in the app, exactly as with every other
 * unconfigured integration.
 */
import { ConfigurationError, optionalEnv, requireEnv } from './env.ts';

export interface Attachment {
  filename: string;
  /** Base64, without a data: prefix. */
  content: string;
  contentType?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
}

export const emailConfigured = (): boolean => Boolean(optionalEnv('RESEND_API_KEY'));

const fromAddress = () => optionalEnv('EMAIL_FROM') ?? 'Blup <tickets@blup.sk>';

/** Base64 for arbitrary bytes, chunked so a large PDF cannot blow the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface SendResult {
  id: string;
  provider: 'resend';
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const apiKey = requireEnv('RESEND_API_KEY', 'EMAIL_NOT_CONFIGURED');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.replyTo,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        content_type: a.contentType,
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`EMAIL_SEND_FAILED: ${response.status} ${detail.slice(0, 300)}`);
  }

  const body = await response.json() as { id?: string };
  return { id: body.id ?? 'unknown', provider: 'resend' };
}

export { ConfigurationError };
