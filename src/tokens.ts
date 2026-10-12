/**
 * Salla token custody.
 *
 * Easy Mode hands the app an access token (2 weeks) and a rotating refresh
 * token (1 month) through the `app.store.authorize` webhook. Refresh tokens
 * are SINGLE-USE: every refresh returns a new one and the old one dies —
 * reusing one revokes every token and forces a merchant reinstall. So the new
 * pair is always persisted before the access token is used.
 */

export interface SallaTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms, or null when unknown (env bootstrap). */
  expiresAt: number | null;
}

/** The slice of KV this file needs; absent in bare local runs. */
export interface TokenStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RefreshContext {
  authBase: string;
  clientId: string;
  clientSecret: string;
}

/** Thrown when no path to a working token exists — the app needs installing again. */
export class ReauthRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequired';
  }
}

const KEY = 'salla';
const SKEW_MS = 3 * 24 * 3600_000; // refresh three days before the two-week expiry

/** Last resort for a local, single-process run. */
let memory: SallaTokens | null = null;
/** One refresh at a time per isolate — parallel refreshes would kill the rotation. */
let refreshing: Promise<SallaTokens> | null = null;

export const loadTokens = async (
  store: TokenStore | undefined,
  seed?: string
): Promise<SallaTokens | null> => {
  if (store) {
    const raw = await store.get(KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as SallaTokens;
      } catch {
        /* fall through to the memory/seed paths */
      }
    }
  }
  if (memory) return memory;
  if (seed) return { accessToken: seed, refreshToken: null, expiresAt: null };
  return null;
};

export const saveTokens = async (
  store: TokenStore | undefined,
  tokens: SallaTokens
): Promise<void> => {
  memory = tokens;
  if (store) await store.put(KEY, JSON.stringify(tokens));
};

export const clearTokens = async (store: TokenStore | undefined): Promise<void> => {
  memory = null;
  if (store) await store.delete(KEY);
};

/** A usable access token: fresh if needed, refreshed single-file if stale. */
export const freshAccessToken = async (
  store: TokenStore | undefined,
  seed: string | undefined,
  context: RefreshContext
): Promise<string> => {
  const tokens = await loadTokens(store, seed);
  if (!tokens) throw new ReauthRequired('the app is not installed yet — no tokens are stored');

  /* An unknown expiry (env seed) counts as fresh; the webhook path sets real ones. */
  const fresh = tokens.expiresAt === null || Date.now() < tokens.expiresAt - SKEW_MS;
  if (fresh) return tokens.accessToken;
  if (!tokens.refreshToken) {
    throw new ReauthRequired('the access token expired and there is no refresh token — reinstall the app');
  }

  if (!context.clientId || !context.clientSecret) {
    throw new ReauthRequired('SALLA_CLIENT_ID / SALLA_CLIENT_SECRET are not set for this deployment');
  }

  if (!refreshing) {
    refreshing = refresh(tokens, context, store).finally(() => {
      refreshing = null;
    });
  }
  return (await refreshing).accessToken;
};

const refresh = async (
  tokens: SallaTokens,
  context: RefreshContext,
  store: TokenStore | undefined
): Promise<SallaTokens> => {
  const response = await fetch(`${context.authBase}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: context.clientId,
      client_secret: context.clientSecret,
      refresh_token: tokens.refreshToken,
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null;

  if (!response.ok || !payload?.access_token) {
    /* Salla answered and refused: the pairing is dead, drop it loudly. */
    if (payload?.error) {
      await clearTokens(store);
      throw new ReauthRequired(`token refresh refused (${payload.error}) — reinstall the app`);
    }
    throw new Error(`token refresh failed with ${response.status}`);
  }

  const next: SallaTokens = {
    accessToken: payload.access_token,
    /* Rotation: the response always carries the next refresh token. */
    refreshToken: payload.refresh_token ?? tokens.refreshToken,
    expiresAt:
      typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : null,
  };
  /* Persist before the caller uses the token — a lost refresh token is a dead app. */
  await saveTokens(store, next);
  return next;
};
