/**
 * Web Push (RFC 8030 / 8291 / 8292), on Web Crypto alone.
 *
 * The browser gives us a push endpoint and two keys; delivering a notification
 * means encrypting the payload so that only that browser can read it, then
 * proving to the push service that we are who we said we were when the
 * subscription was created. Both are standards, and both are short enough to
 * write directly rather than pull in a library that would have to be vendored
 * into the function bundle anyway.
 *
 *   aes128gcm (RFC 8188/8291) — ECDH to a shared secret, HKDF to a key and a
 *   nonce, AES-GCM over the payload. The push service forwards ciphertext it
 *   cannot read; only the subscribed browser holds the other half of the ECDH.
 *
 *   VAPID (RFC 8292) — an ES256 JWT naming the push service as audience, so a
 *   stolen endpoint cannot be used by anyone but us.
 */

// --- base64url ----------------------------------------------------------------
export function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// --- HKDF ---------------------------------------------------------------------
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// --- keys ---------------------------------------------------------------------
/** A P-256 public key as the uncompressed 65-byte point browsers hand out. */
function jwkFromPublicBytes(bytes: Uint8Array): JsonWebKey {
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('WEBPUSH_BAD_PUBLIC_KEY');
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(bytes.slice(1, 33)),
    y: bytesToB64url(bytes.slice(33, 65)),
    ext: true,
  };
}

async function importPublicKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwkFromPublicBytes(bytes),
    { name: usages.includes('verify') ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    usages,
  );
}

/**
 * The VAPID key pair as `web-push generate-vapid-keys` prints it: the public
 * key is the 65-byte point, the private key is the raw 32-byte scalar. Web
 * Crypto wants a JWK, and a JWK needs the public coordinates too — which is why
 * both halves are required to sign.
 */
async function importVapidPrivateKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicKey);
  const jwk = { ...jwkFromPublicBytes(pub), d: bytesToB64url(b64urlToBytes(privateKey)) };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// --- VAPID --------------------------------------------------------------------
export async function vapidHeader(params: {
  endpoint: string;
  publicKey: string;
  privateKey: string;
  subject: string;
  ttlSeconds?: number;
}): Promise<string> {
  const audience = new URL(params.endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    // Twelve hours: long enough that clock skew is irrelevant, short enough
    // that a leaked token is not a standing key.
    exp: Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 12 * 60 * 60),
    sub: params.subject,
  };

  const signingInput =
    `${bytesToB64url(utf8(JSON.stringify(header)))}.${bytesToB64url(utf8(JSON.stringify(claims)))}`;

  const key = await importVapidPrivateKey(params.publicKey, params.privateKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(signingInput),
  );

  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
  return `vapid t=${jwt}, k=${params.publicKey}`;
}

// --- payload encryption --------------------------------------------------------
export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Encrypts `payload` for one subscription, producing an aes128gcm body.
 *
 * `salt` and `ephemeral` are injectable so the round-trip test can pin them;
 * production always uses fresh random values, because reusing either would let
 * an observer correlate two notifications to the same key.
 */
export async function encryptPayload(
  subscription: PushSubscription,
  payload: string,
  overrides?: { salt?: Uint8Array; ephemeral?: CryptoKeyPair },
): Promise<Uint8Array> {
  const clientPublicBytes = b64urlToBytes(subscription.keys.p256dh);
  const authSecret = b64urlToBytes(subscription.keys.auth);

  const ephemeral = overrides?.ephemeral ?? await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const serverPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );

  const clientKey = await importPublicKey(clientPublicBytes, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256),
  );

  // RFC 8291 §3.4: the auth secret salts the first HKDF, and the info string
  // binds the derived key to both parties' public keys.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(utf8('WebPush: info\0'), clientPublicBytes, serverPublicBytes),
    32,
  );

  const salt = overrides?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);

  // 0x02 is the "last record" delimiter; without it the browser rejects the
  // message as truncated.
  const plaintext = concat(utf8(payload), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext),
  );

  // Header: salt(16) | record size(4) | key id length(1) | key id(65)
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);

  return concat(
    salt,
    recordSize,
    new Uint8Array([serverPublicBytes.length]),
    serverPublicBytes,
    ciphertext,
  );
}

// --- sending -------------------------------------------------------------------
export interface WebPushResult {
  ok: boolean;
  status: number;
  /** True when the subscription is gone for good and should be deleted. */
  expired: boolean;
  error?: string;
}

export async function sendWebPush(
  subscription: PushSubscription,
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  options: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
): Promise<WebPushResult> {
  const body = await encryptPayload(subscription, payload);
  const authorization = await vapidHeader({
    endpoint: subscription.endpoint,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    subject: vapid.subject,
  });

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl ?? 24 * 60 * 60),
      Urgency: options.urgency ?? 'normal',
    },
    body,
  });

  // 404/410 mean the browser threw the subscription away — the row is dead and
  // retrying it forever only wastes quota.
  const expired = response.status === 404 || response.status === 410;

  return {
    ok: response.ok,
    status: response.status,
    expired,
    error: response.ok ? undefined : (await response.text()).slice(0, 300),
  };
}
