import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Neuhádnuteľný token pre session / e-mailové odkazy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** V DB nikdy neukladáme surový token — iba jeho SHA-256. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Deterministický podpis QR kódu smeny — token sa dá overiť bez ďalšieho zápisu. */
export function signShiftQr(shiftId: string, secret: string): string {
  return createHash("sha256").update(`${shiftId}:${secret}`).digest("base64url").slice(0, 24);
}
