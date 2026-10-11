# wiqar-backend

The runtime piece behind وقار's storefront. Salla is the store of record — products, stock,
carts, orders, payments. This worker is the only thing that talks to Salla:

- **Salla's API refuses browsers.** Its responses carry no CORS headers, so every call has to be
  server-to-server.
- **The token must never ship.** The app secret and the store's access token live here — in
  Cloudflare secrets and KV — and nowhere a browser can see.

A sibling of `wiqar-storefront` (github.com/mohammedbaqadir/wiqar-storefront): the storefront
builds and browses without it; buying runs through it.

## Routes

| route | method | what it does |
|---|---|---|
| `/health` | GET | liveness; whether the store is configured and its tokens are in KV |
| `/catalog` | GET | the store's Salla catalogue as-is (`?page=`) — for reading and alignment, not part of the storefront build |
| `/categories` | GET | the store's categories |
| `/cart` | POST | mints a guest cart; answers `{status, data: {id, checkout_url}}` |
| `/cart/:id/items` | POST | adds one line — `{identifier, quantity}`; identifier is a SKU (string) or a product id (number) |
| `/webhooks/salla` | POST | verifies `X-Salla-Signature`; stores tokens on `app.store.authorize`, clears them on `app.uninstalled` |

Without `SALLA_STORE`, everything except `/health` and the webhook answers `503` with a
machine-readable error. There are deliberately no product-write routes: this worker reads the
catalogue and builds carts. When the real-store import runs, write routes come back behind a
shared secret.

## The Salla surface it uses (verified against the live store)

| purpose | call | notes |
|---|---|---|
| products / categories | `GET https://api.salla.dev/admin/v2/products` · `/categories` | `Authorization: Bearer <token>` |
| guest cart | `GET https://api.salla.dev/store/v1/cart/latest` | the storefront v1 API Salla's own themes use; no token needed |
| add a line | `POST https://api.salla.dev/store/v1/cart/{cart}/item/{product}/add` with `{id, quantity}` | by **product id** — the worker resolves SKU → id from the catalogue first |

Two hard-won facts:

- **`Store-Identifier` is the store's merchant number, not its username.** `943760928`, not
  `wiqar-store` — the username resolves to an empty face of the store, which is why early
  product lookups answered `المنتج غير موجود`.
- **The v2 checkout API (`/store/v2/checkout/…`) rejects items on this store.** Its product
  lookup fails even for freshly created products. The v1 storefront cart is what works — it is
  the API Salla's themes themselves use; don't re-walk the v2 path blindly.

## Store facts and findings

- The store's products match the storefront catalogue by SKU (`WQ-001` … `WQ-035`).
- **Demo stores cannot complete orders.** Salla blocks the final step with
  `لا يمكن إتمام الطلب من متجر تجريبي` — carts build, checkout refuses. Real orders wait on a
  real (non-demo) Salla store; when it exists, only `SALLA_STORE` here and a fresh app install
  there change.
- The Salla app ("واجهة وقار للمتجر", Easy Mode, signature webhooks) lives in the Partners
  Portal; its secrets never appear in this repo.

## Tokens

The signed `app.store.authorize` webhook delivers the OAuth pair; it lives in the `TOKENS` KV
namespace. Access tokens last two weeks; refresh tokens are single-use and rotate on every
refresh — the new pair is persisted before use and refreshes are single-flight (`src/tokens.ts`).
A dead refresh chain means a reinstall, not a lost store.

## Environment

Every credential, where it comes from, and its rotation consequence:

| name | where it comes from | what it is for | on rotation |
|---|---|---|---|
| `SALLA_CLIENT_ID` · `SALLA_CLIENT_SECRET` | Partners Portal → **واجهة وقار للمتجر** → App Keys | refreshing the store's access token, server-side | put both as Cloudflare secrets; a stale pair kills the refresh chain and the app needs reinstalling |
| `WEBHOOK_SECRET` | the same app → Webhooks (signature strategy) | verifying `X-Salla-Signature` on incoming events | `bunx wrangler secret put WEBHOOK_SECRET` with the new value, or every delivery answers 401 |
| `SALLA_STORE` | the store link's `identifier=` — the merchant number, not the username | the `Store-Identifier` header on storefront calls | lives in `wrangler.toml`, no secret |
| `SALLA_APP_VERSION` | the storefront version Salla's themes report | the `S-APP-VERSION` header | lives in `wrangler.toml` |
| `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → API tokens (each project has its own token; needs Workers Scripts: Edit) | `wrangler deploy`, `secret put`, KV checks | local `.env` only, never deployed |

In production the three Salla secrets live as Cloudflare secrets; locally `.dev.vars` mirrors the
names with mocks. `SALLA_API_BASE` / `SALLA_AUTH_BASE` can point at a mock to rehearse the flow —
and note workerd's sockets are unreachable on this machine, so run the worker under Bun when
testing locally.

## Running it

```sh
bun install
bun run dev        # wrangler dev
bun run deploy     # wrangler deploy — Cloudflare Workers
```

## Not in scope yet

Order reads and store webhooks (`order.created`, `product.*`) — they arrive when the shop needs
notifications.
