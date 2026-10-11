/**
 * Salla webhook intake.
 *
 * Easy Mode delivers `app.store.authorize` here with the store's tokens.
 * The signature strategy signs the RAW request body with HMAC-SHA256 keyed
 * by the app's webhook secret; the digest arrives hex-encoded in
 * `X-Salla-Signature` (docs.salla.dev/webhooks).
 */

import type { SallaTokens } from './tokens';

const encoder = new TextEncoder();

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** HMAC-SHA256(secret, rawBody) as hex, compared in constant time. */
export const signatureMatches = async (
  secret: string,
  rawBody: string,
  signature: string
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
  const expected = Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, signature.trim().toLowerCase());
};

/** What the authorize event wants stored. Null when the payload is unusable. */
export const tokensFromAuthorize = (data: unknown): SallaTokens | null => {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const access = typeof record.access_token === 'string' && record.access_token !== '' ? record.access_token : null;
  if (!access) return null;
  return {
    accessToken: access,
    refreshToken:
      typeof record.refresh_token === 'string' && record.refresh_token !== ''
        ? record.refresh_token
        : null,
    /* `expires` arrives as a unix timestamp in seconds for this event. */
    expiresAt: typeof record.expires === 'number' ? record.expires * 1000 : null,
  };
};
