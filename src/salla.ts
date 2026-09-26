/**
 * The calls this service makes to Salla.
 *
 * Two surfaces, both verified against Salla's documentation:
 *   - Merchant API   /admin/v2            products, categories   (Bearer token)
 *   - Checkout APIs  /store/v2/checkout   cart lifecycle         (store-scoped)
 *
 * None of it can run in a browser: Salla sends no CORS headers, and the token
 * must never leave the server.
 */

const ADMIN = 'https://api.salla.dev/admin/v2';
const CHECKOUT = 'https://api.salla.dev/store/v2/checkout';

export interface SallaConfig {
  /** Store-Identifier — which store this service acts for. */
  store: string;
  /** Bearer token minted when the app was installed. */
  token: string;
  appName: string;
  appVersion: string;
}

export interface CartLine {
  identifier: number;
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

const adminHeaders = (config: SallaConfig): HeadersInit => ({
  Authorization: `Bearer ${config.token}`,
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
export const listProducts = async (config: SallaConfig, page = 1): Promise<unknown> =>
  read(await fetch(`${ADMIN}/products?page=${page}`, { headers: adminHeaders(config) }));

/** Categories. Scope: categories.read */
export const listCategories = async (config: SallaConfig): Promise<unknown> =>
  read(await fetch(`${ADMIN}/categories`, { headers: adminHeaders(config) }));

/** A guest cart. The response carries its id and the checkout_url to hand over. */
export const createCart = async (config: SallaConfig): Promise<unknown> =>
  read(await fetch(`${CHECKOUT}/generate`, { method: 'POST', headers: checkoutHeaders(config) }));

/** Add a line to an existing cart, identified by Salla's product id. */
export const addItem = async (
  config: SallaConfig,
  cartId: string,
  line: CartLine
): Promise<unknown> =>
  read(
    await fetch(`${CHECKOUT}/${encodeURIComponent(cartId)}/items`, {
      method: 'POST',
      headers: checkoutHeaders(config),
      body: JSON.stringify({
        identifier_type: 'id',
        identifier: line.identifier,
        quantity: line.quantity,
        options: line.options,
      }),
    })
  );
