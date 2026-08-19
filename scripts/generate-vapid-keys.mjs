#!/usr/bin/env node
/**
 * Generates a VAPID key pair for Web Push (RFC 8292).
 *
 *   node scripts/generate-vapid-keys.mjs
 *
 * Prints the two values to set. The public key is safe to ship to browsers —
 * it identifies BLUP to the push service and cannot send anything on its own.
 * The private key signs the request that proves we are that sender, so it lives
 * only in the Edge Function environment.
 *
 * Generate them once. Rotating the public key invalidates every existing
 * subscription, and every browser has to be asked for permission again.
 */
import { webcrypto as crypto } from 'node:crypto';

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log(`
VAPID keys generated.

  Edge Functions   supabase secrets set \\
                     VAPID_PUBLIC_KEY=${publicKey} \\
                     VAPID_PRIVATE_KEY=${jwk.d} \\
                     VAPID_SUBJECT=mailto:hello@blup.app

  Web client       EXPO_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}

The public key goes in both places; the private key goes only in the first.
`);
