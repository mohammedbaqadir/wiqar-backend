import {
  addItem,
  createCart,
  listCategories,
  listProducts,
  SallaError,
  type CartLine,
  type SallaConfig,
} from './salla';
import {
  clearTokens,
  freshAccessToken,
  loadTokens,
  saveTokens,
  ReauthRequired,
  type RefreshContext,
  type TokenStore,
} from './tokens';
import { signatureMatches, tokensFromAuthorize } from './webhooks';

export interface Env {
  SALLA_STORE?: string;
  /** Bootstrap token for a quick local run; the webhook supersedes it. */
  SALLA_TOKEN?: string;
  SALLA_CLIENT_ID?: string;
  SALLA_CLIENT_SECRET?: string;
  SALLA_APP_NAME?: string;
  SALLA_APP_VERSION?: string;
  /** Overridable so the flow can be rehearsed against a local mock. */
  SALLA_API_BASE?: string;
  SALLA_AUTH_BASE?: string;
  WEBHOOK_SECRET?: string;
  /** KV holding the store's tokens in production; absent in bare local runs. */
  TOKENS?: TokenStore;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* The storefront is a different origin; this is the CORS Salla itself does not send. */
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  });

const configFrom = (env: Env): SallaConfig | null =>
  env.SALLA_STORE
    ? {
        store: env.SALLA_STORE,
        appName: env.SALLA_APP_NAME ?? 'wiqar-backend',
        appVersion: env.SALLA_APP_VERSION ?? '0.1.0',
        apiBase: env.SALLA_API_BASE ?? 'https://api.salla.dev',
        authBase: env.SALLA_AUTH_BASE ?? 'https://accounts.salla.sa',
        clientId: env.SALLA_CLIENT_ID,
        clientSecret: env.SALLA_CLIENT_SECRET,
      }
    : null;

const refreshContext = (env: Env, config: SallaConfig): RefreshContext => ({
  authBase: config.authBase,
  clientId: env.SALLA_CLIENT_ID ?? '',
  clientSecret: env.SALLA_CLIENT_SECRET ?? '',
});

const failure = (error: unknown): Response => {
  if (error instanceof SallaError) {
    return json(
      { status: false, error: { code: error.code, message: error.message, fields: error.fields } },
      error.status
    );
  }
  return json(
    { status: false, error: { code: 'upstream_error', message: error instanceof Error ? error.message : 'Unknown failure' } },
    502
  );
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') return json({ status: true });

    /* The webhook runs before anything else is configured — it delivers the tokens. */
    if (pathname === '/webhooks/salla' && request.method === 'POST') {
      const raw = await request.text();
      const secret = env.WEBHOOK_SECRET;
      const signature = request.headers.get('x-salla-signature') ?? '';
      if (!secret || !signature || !(await signatureMatches(secret, raw, signature))) {
        return json(
          { status: false, error: { code: 'unauthorized', message: 'Signature mismatch.' } },
          401
        );
      }

      let body: { event?: unknown; data?: unknown } | null = null;
      try {
        body = JSON.parse(raw) as { event?: unknown; data?: unknown };
      } catch {
        return json({ status: false, error: { code: 'bad_request', message: 'Body is not JSON.' } }, 400);
      }

      const event = String(body?.event ?? '');
      if (event === 'app.store.authorize') {
        const tokens = tokensFromAuthorize(body?.data);
        if (tokens) await saveTokens(env.TOKENS, tokens);
        console.log(`app.store.authorize: ${tokens ? 'tokens stored' : 'payload unusable'}`);
        return json({ status: Boolean(tokens) });
      }
      if (event === 'app.uninstalled') {
        await clearTokens(env.TOKENS);
        console.log('app.uninstalled: tokens cleared');
        return json({ status: true });
      }
      console.log(`webhook ignored: ${event}`);
      return json({ status: true });
    }

    if (pathname === '/health') {
      return json({
        ok: true,
        configured: configFrom(env) !== null,
        authorized: (await loadTokens(env.TOKENS, env.SALLA_TOKEN)) !== null,
        refreshable: Boolean(env.SALLA_CLIENT_ID && env.SALLA_CLIENT_SECRET),
      });
    }

    const item = pathname.match(/^\/cart\/([^/]+)\/items$/);

    /* Which routes exist, before anything about configuration. */
    const isCatalog = pathname === '/catalog' && request.method === 'GET';
    const isCategories = pathname === '/categories' && request.method === 'GET';
    const isCart = pathname === '/cart' && request.method === 'POST';
    const isItem = item !== null && request.method === 'POST';

    if (!isCatalog && !isCategories && !isCart && !isItem) {
      return json({ status: false, error: { code: 'not_found', message: 'No such route.' } }, 404);
    }

    /* A malformed request is the caller's problem, not the configuration's. */
    let line: CartLine | null = null;
    if (isItem) {
      const body = (await request.json().catch(() => ({}))) as {
        identifier?: unknown;
        quantity?: unknown;
        options?: Array<{ name: string; value: string }>;
      };

      const identifier = body.identifier;
      const identifierType =
        typeof identifier === 'number'
          ? ('id' as const)
          : typeof identifier === 'string' && identifier.trim() !== ''
            ? ('sku' as const)
            : null;

      if (!identifierType) {
        return json(
          {
            status: false,
            error: {
              code: 'validation_error',
              message: 'identifier must be a product id (number) or a sku (string)',
              fields: { identifier: ['required'] },
            },
          },
          422
        );
      }

      line = {
        identifier_type: identifierType,
        identifier: identifier as number | string,
        quantity: typeof body.quantity === 'number' ? body.quantity : 1,
        options: body.options,
      };
    }

    const config = configFrom(env);
    if (!config) {
      /* Loud and specific: a misconfigured deploy should say so, not pretend. */
      return json(
        {
          status: false,
          error: {
            code: 'not_configured',
            message: 'SALLA_STORE is not set for this deployment.',
          },
        },
        503
      );
    }

    try {
      if (isCatalog) {
        const token = await freshAccessToken(env.TOKENS, env.SALLA_TOKEN, refreshContext(env, config));
        return json(await listProducts(config, token, Number(searchParams.get('page') ?? '1')));
      }
      if (isCategories) {
        const token = await freshAccessToken(env.TOKENS, env.SALLA_TOKEN, refreshContext(env, config));
        return json(await listCategories(config, token));
      }
      if (isCart) return json(await createCart(config));
      if (isItem && item && line) return json(await addItem(config, item[1], line));

      return json({ status: false, error: { code: 'not_found', message: 'No such route.' } }, 404);
    } catch (error) {
      if (error instanceof ReauthRequired) {
        return json(
          { status: false, error: { code: 'not_authorized', message: error.message } },
          503
        );
      }
      return failure(error);
    }
  },
};
