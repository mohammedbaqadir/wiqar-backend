import {
  addToCart,
  catalogueIndex,
  latestCart,
  listCategories,
  listProducts,
  SallaError,
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
  /** Sent to the storefront API as S-APP-VERSION. */
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
        appVersion: env.SALLA_APP_VERSION ?? '2.14.591',
        apiBase: env.SALLA_API_BASE ?? 'https://api.salla.dev',
        authBase: env.SALLA_AUTH_BASE ?? 'https://accounts.salla.sa',
        clientId: env.SALLA_CLIENT_ID,
        clientSecret: env.SALLA_CLIENT_SECRET,
      }
    : null;

const refreshContext = (config: SallaConfig): RefreshContext => ({
  authBase: config.authBase,
  clientId: config.clientId ?? '',
  clientSecret: config.clientSecret ?? '',
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

/* Short-lived, per-isolate copy of the public GETs: a hot loop on /catalog or
   /categories cannot spend the store token's rate budget upstream. Only
   successes are cached, and the map is capped so made-up page numbers cannot
   grow it. */
const responseCache = new Map<string, { at: number; payload: unknown }>();

const cached = async (key: string, ttlMs: number, load: () => Promise<unknown>): Promise<unknown> => {
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.payload;
  const payload = await load();
  if (responseCache.size >= 32) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { at: Date.now(), payload });
  return payload;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') return json({ status: true });

    /* The webhook runs before anything else is configured — it delivers the tokens. */
    if (pathname === '/webhooks/salla' && request.method === 'POST') {
      /* Refuse unsigned deliveries before the body is even read. */
      const secret = env.WEBHOOK_SECRET;
      const signature = request.headers.get('x-salla-signature') ?? '';
      if (!secret || !signature) {
        return json(
          { status: false, error: { code: 'unauthorized', message: 'Signature mismatch.' } },
          401
        );
      }

      const raw = await request.text();
      if (!(await signatureMatches(secret, raw, signature))) {
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
        /* 200 either way: a retry cannot fix an unusable payload. */
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
    let identifier: number | string | null = null;
    let quantity = 1;
    if (isItem) {
      const body = (await request.json().catch(() => ({}))) as {
        identifier?: unknown;
        quantity?: unknown;
      };

      const raw = body.identifier;
      identifier =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? raw.trim()
            : null;

      if (identifier === null) {
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

      if (typeof body.quantity === 'number' && Number.isFinite(body.quantity) && body.quantity > 0) {
        quantity = Math.min(Math.floor(body.quantity), 9999);
      }
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
      /* Every route below reads with the store's token — fetch it once. */
      const token = await freshAccessToken(env.TOKENS, env.SALLA_TOKEN, refreshContext(config));

      if (isCatalog) {
        const page = Number(searchParams.get('page') ?? '1');
        return json(await cached(`catalog:${page}`, 120_000, () => listProducts(config, token, page)));
      }
      if (isCategories) {
        return json(await cached('categories', 300_000, () => listCategories(config, token)));
      }
      if (isCart) {
        const index = await catalogueIndex(config, token);
        const cart = (await latestCart(config)) as {
          data?: { id?: unknown; cart?: { id?: unknown } };
        };
        /* Salla nests the cart id either at data.cart.id or data.id — take whichever arrived. */
        const cartId = cart?.data?.cart?.id ?? cart?.data?.id;
        if (cartId === undefined || cartId === null) return json(cart);
        return json({
          status: true,
          data: {
            id: cartId,
            checkout_url: index.storefrontBase
              ? `${index.storefrontBase}/checkout/${encodeURIComponent(String(cartId))}`
              : '',
          },
        });
      }
      if (isItem && item && identifier !== null) {
        const index = await catalogueIndex(config, token);
        const productId =
          typeof identifier === 'number' ? identifier : index.bySku.get(identifier.toUpperCase());
        if (productId === undefined) {
          return json(
            {
              status: false,
              error: {
                code: 'product_not_found',
                message: `لا يوجد منتج برقم الصنف ${identifier} في متجر سلة.`,
              },
            },
            404
          );
        }
        return json(await addToCart(config, item[1], productId, quantity));
      }
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
