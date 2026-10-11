/**
 * The calls this service makes to Salla.
 *
 * Two surfaces, both verified against Salla's documentation and the live store:
 *   - Merchant API   /admin/v2       products, categories   (Bearer token)
 *   - Storefront API /store/v1/cart  the guest cart         (store-scoped)
 *
 * The cart side speaks the same v1 API Salla's own themes use, so the handoff
 * lands on a cart Salla's checkout knows. None of it can run in a browser:
 * Salla sends no CORS headers, and the token must never leave the server.
 * `apiBase` is overridable, so the whole flow can be rehearsed against a local
 * mock before it ever points at Salla.
 */

export interface SallaConfig {
  /** Store-Identifier — which store this service acts for. */
  store: string;
  /** Sent as S-APP-VERSION; the storefront version Salla's themes report. */
  appVersion: string;
  apiBase: string;
  authBase: string;
  clientId?: string;
  clientSecret?: string;
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
const storeBase = (config: SallaConfig): string => `${config.apiBase}/store/v1`;

const adminHeaders = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

/** The header set Salla's own storefront sends; verified against the live store. */
const storeHeaders = (config: SallaConfig): HeadersInit => ({
  'Store-Identifier': config.store,
  'S-SOURCE': 'twilight',
  'S-APP-VERSION': config.appVersion,
  'S-APP-OS': 'browser',
  'X-Requested-With': 'XMLHttpRequest',
  currency: 'SAR',
  'accept-language': 'ar',
  's-country': 'SA',
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

/** What a cart needs from the catalogue: lines resolve by SKU, links need the base. */
export interface CatalogueIndex {
  bySku: Map<string, number>;
  storefrontBase: string;
}

interface ProductRow {
  id?: unknown;
  sku?: unknown;
  urls?: { customer?: unknown; storefront?: unknown };
}

/** "…/غلاف-كتاب-جلد/p687595100" → "…/dev-nem6881yclgoebhs": drop slug and id. */
const storefrontBaseOf = (productUrl: string): string => {
  const url = new URL(productUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  segments.splice(-2);
  return segments.length > 0 ? `${url.origin}/${segments.join('/')}` : url.origin;
};

/* One index per isolate: a multi-line checkout reads the catalogue once, and a
   five-minute TTL keeps a price or copy edit from going stale all day. */
let cachedIndex: (CatalogueIndex & { at: number }) | null = null;

/** Read the catalogue: SKU → product id for cart lines, storefront base for links. */
export const catalogueIndex = async (config: SallaConfig, token: string): Promise<CatalogueIndex> => {
  if (cachedIndex && Date.now() - cachedIndex.at < 5 * 60 * 1000) return cachedIndex;

  const bySku = new Map<string, number>();
  let storefrontBase = '';
  let page = 1;
  let totalPages = 1;
  do {
    const payload = (await listProducts(config, token, page)) as {
      data?: ProductRow[];
      pagination?: { totalPages?: number };
    };
    for (const product of payload?.data ?? []) {
      const sku = typeof product.sku === 'string' ? product.sku.trim() : '';
      const id = Number(product.id);
      if (sku !== '' && Number.isFinite(id)) bySku.set(sku.toUpperCase(), id);
      const productUrl = product.urls?.customer ?? product.urls?.storefront;
      if (storefrontBase === '' && typeof productUrl === 'string') {
        storefrontBase = storefrontBaseOf(productUrl);
      }
    }
    totalPages = payload?.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= 10);

  cachedIndex = { bySku, storefrontBase, at: Date.now() };
  return cachedIndex;
};

/** The guest cart. `cart/latest` mints one when the caller has none. */
export const latestCart = async (config: SallaConfig): Promise<unknown> =>
  read(await fetch(`${storeBase(config)}/cart/latest`, { headers: storeHeaders(config) }));

/** Add one product, by numeric id — v1 addresses the product in the path. */
export const addToCart = async (
  config: SallaConfig,
  cartId: string,
  productId: number,
  quantity: number
): Promise<unknown> =>
  read(
    await fetch(
      `${storeBase(config)}/cart/${encodeURIComponent(cartId)}/item/${encodeURIComponent(productId)}/add`,
      { method: 'POST', headers: storeHeaders(config), body: JSON.stringify({ id: productId, quantity }) }
    )
  );

