/**
 * The calls this service makes to Salla.
 *
 * Two surfaces, both verified against Salla's documentation:
 *   - Merchant API   /admin/v2            products, categories   (Bearer token)
 *   - Checkout APIs  /store/v2/checkout   cart lifecycle         (store-scoped)
 *
 * None of it can run in a browser: Salla sends no CORS headers, and the token
 * must never leave the server. `apiBase` is overridable, so the whole flow can
 * be rehearsed against a local mock before it ever points at Salla.
 */

export interface SallaConfig {
  /** Store-Identifier — which store this service acts for. */
  store: string;
  appName: string;
  appVersion: string;
  apiBase: string;
  authBase: string;
  clientId?: string;
  clientSecret?: string;
}

/** A line as the Checkout API wants it: identity, count, chosen options. */
export interface CartLine {
  identifier_type: 'id' | 'sku';
  identifier: number | string;
  quantity: number;
  options?: Array<{ name: string; value: string }>;
}

/** Salla's error envelope, surfaced so callers get a machine-readable failure. */
export class SallaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: unknown
  ) {
    super(message);
    this.name = 'SallaError';
  }
}

interface Envelope {
  error?: { code?: string; message?: string; fields?: unknown };
}

const adminBase = (config: SallaConfig): string => `${config.apiBase}/admin/v2`;
const checkoutBase = (config: SallaConfig): string => `${config.apiBase}/store/v2/checkout`;

const adminHeaders = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

/** Every Checkout API call carries the store and the calling app. */
const checkoutHeaders = (config: SallaConfig): HeadersInit => ({
  'Store-Identifier': config.store,
  's-source': 'app',
  's-app-name': config.appName,
  's-app-version': config.appVersion,
  'content-type': 'application/json',
});

const read = async (response: Response): Promise<unknown> => {
  const payload = (await response.json().catch(() => null)) as Envelope | null;

  if (!response.ok) {
    throw new SallaError(
      response.status,
      payload?.error?.code ?? 'http_error',
      payload?.error?.message ?? response.statusText,
      payload?.error?.fields
    );
  }
  return payload;
};

/** Products, paginated (`data[]` plus pagination). Scope: products.read */
export const listProducts = async (
  config: SallaConfig,
  token: string,
  page = 1
): Promise<unknown> =>
  read(await fetch(`${adminBase(config)}/products?page=${page}`, { headers: adminHeaders(token) }));

/** Categories. Scope: categories.read */
export const listCategories = async (config: SallaConfig, token: string): Promise<unknown> =>
  read(await fetch(`${adminBase(config)}/categories`, { headers: adminHeaders(token) }));

/** A guest cart. The response carries its id and the checkout_url to hand over. */
export const createCart = async (config: SallaConfig): Promise<unknown> =>
  read(await fetch(`${checkoutBase(config)}/generate`, { method: 'POST', headers: checkoutHeaders(config) }));

/** Add one line to an existing cart, by product id or sku. Mutations echo the cart. */
export const addItem = async (
  config: SallaConfig,
  cartId: string,
  line: CartLine
): Promise<unknown> =>
  read(
    await fetch(`${checkoutBase(config)}/${encodeURIComponent(cartId)}/items`, {
      method: 'POST',
      headers: checkoutHeaders(config),
      body: JSON.stringify(line),
    })
  );
