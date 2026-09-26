import { addItem, createCart, listCategories, listProducts, SallaError, type SallaConfig } from './salla';

export interface Env {
  SALLA_STORE?: string;
  SALLA_TOKEN?: string;
  SALLA_APP_NAME?: string;
  SALLA_APP_VERSION?: string;
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
  env.SALLA_STORE && env.SALLA_TOKEN
    ? {
        store: env.SALLA_STORE,
        token: env.SALLA_TOKEN,
        appName: env.SALLA_APP_NAME ?? 'wiqar-backend',
        appVersion: env.SALLA_APP_VERSION ?? '0.1.0',
      }
    : null;

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

    if (pathname === '/health') {
      return json({ ok: true, configured: configFrom(env) !== null });
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
    let line: { identifier: number; quantity: number; options?: Array<{ name: string; value: string }> } | null =
      null;
    if (isItem) {
      const body = (await request.json().catch(() => ({}))) as {
        identifier?: unknown;
        quantity?: unknown;
        options?: Array<{ name: string; value: string }>;
      };

      if (typeof body.identifier !== 'number') {
        return json(
          {
            status: false,
            error: {
              code: 'validation_error',
              message: 'identifier must be a number',
              fields: { identifier: ['required'] },
            },
          },
          422
        );
      }

      line = {
        identifier: body.identifier,
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
            message: 'SALLA_STORE and SALLA_TOKEN are not set for this deployment.',
          },
        },
        503
      );
    }

    try {
      if (isCatalog) return json(await listProducts(config, Number(searchParams.get('page') ?? '1')));
      if (isCategories) return json(await listCategories(config));
      if (isCart) return json(await createCart(config));
      if (isItem && item && line) return json(await addItem(config, item[1], line));

      return json({ status: false, error: { code: 'not_found', message: 'No such route.' } }, 404);
    } catch (error) {
      return failure(error);
    }
  },
};
