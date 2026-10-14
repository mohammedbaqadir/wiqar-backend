# wiqar-backend

The backend for the wiqar storefront. It is the only part of the system that holds Salla credentials
and talks to Salla (products, stock, carts, orders, payments). It deploys on its own. The storefront
works without it; buying does not.

**Live:** https://wiqar-backend.directed-countless.workers.dev

`TypeScript 7` (native compiler) · `Cloudflare Worker + KV` · `Bun` for toolchain and tests

## What it is

Salla's API can't be called from a browser (its responses carry no CORS headers), and the
credentials must never reach the browser (anything a browser can see is public). So this Worker sits
between the storefront and Salla: it holds the credentials, calls Salla from the server, and exposes
a small API with checks on it.

## The API

| Route | Method | What it does |
|---|---|---|
| `/health` | GET | a health check: is the store configured, are the tokens in KV |
| `/catalog` | GET | the Salla catalogue as it comes (`?page=`) — for reading and comparing, not for the site build |
| `/categories` | GET | the store's categories |
| `/cart` | POST | creates a guest cart; returns `{status, data: {id, checkout_url}}` |
| `/cart/:id/items` | POST | adds one item — `{identifier, quantity}`; identifier is a SKU (string) or a product id (number) |
| `/webhooks/salla` | POST | checks `X-Salla-Signature`; saves tokens on `app.store.authorize`, clears them on `app.uninstalled` |

`/catalog` and `/categories` answers are cached for two to five minutes per Worker instance, so
repeated calls don't burn the store token's rate limit. The worker never writes to Salla — it reads
the catalogue and builds carts.

## Tokens

Salla sends the OAuth token pair through a signed webhook. The pair is stored in the `TOKENS` KV
namespace and never leaves the server. The access token lasts about two weeks. Refresh tokens are
**single-use**: each refresh returns a new pair and the old one dies. So the code saves the new pair
before using it, and only one refresh runs at a time (`src/tokens.ts`). If the refresh chain breaks,
the app must be reinstalled — the store itself is not affected.

Incoming webhooks are only trusted if the HMAC-SHA256 signature matches the raw request body
(compared in constant time). An unsigned or wrong-signature delivery gets a `401` — and the body is
never read.

## The Salla surface it uses (verified against the live store)

| Purpose | Call | Notes |
|---|---|---|
| products / categories | `GET https://api.salla.dev/admin/v2/products` · `/categories` | `Authorization: Bearer <token>` |
| guest cart | `GET https://api.salla.dev/store/v1/cart/latest` | the storefront v1 API Salla's own themes use; no token needed |
| add an item | `POST https://api.salla.dev/store/v1/cart/{cart}/item/{product}/add` with `{id, quantity}` | by **product id** — the worker resolves SKU → id from the catalogue first |

Two facts that took real debugging:

- **`Store-Identifier` is the store's merchant number, not its username.** `943760928`, not
  `wiqar-store` — the username points to an empty side of the store, which is why early product
  lookups answered `المنتج غير موجود`.
- **The v2 checkout API (`/store/v2/checkout/…`) does not work with this store.** Its product
  lookup fails even for brand-new products. The v1 storefront cart works — it is the API Salla's
  own themes use. Don't go down the v2 path again.

## Store facts

- Products match the storefront catalogue by SKU (`WQ-001` … `WQ-035`).
- **A demo store cannot complete orders.** Salla blocks the last step with
  `لا يمكن إتمام الطلب من متجر تجريبي`. Carts build, checkout refuses. Real orders need a real
  (non-demo) Salla store. When you have one, only `SALLA_STORE` here and a fresh app install there
  change.
- The Salla app ("واجهة وقار للمتجر", Easy Mode, signature webhooks) lives in the Partners Portal.
  Its secrets are not in this repository.

## Environment

Every credential, where it comes from, and what happens when it changes:

| Name | Where it comes from | What it is for | On rotation |
|---|---|---|---|
| `SALLA_CLIENT_ID` · `SALLA_CLIENT_SECRET` | Partners Portal → **واجهة وقار للمتجر** → App Keys | refreshing the store's access token, server-side | put both as Cloudflare secrets; an old pair breaks the refresh and the app has to be reinstalled |
| `WEBHOOK_SECRET` | the same app → Webhooks (signature strategy) | checking `X-Salla-Signature` on incoming events | `bunx wrangler secret put WEBHOOK_SECRET` with the new value, or every delivery answers 401 |
| `SALLA_STORE` | the store link's `identifier=` — the merchant number, not the username | the `Store-Identifier` header on storefront calls | lives in `wrangler.toml`, no secret |
| `SALLA_APP_VERSION` | the storefront version Salla's themes report | the `S-APP-VERSION` header | lives in `wrangler.toml` |
| `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → API tokens (each project has its own token; needs Workers Scripts: Edit) | `wrangler deploy`, `secret put`, KV checks | local `.env` only, never deployed |

In production, the three Salla secrets live as Cloudflare secrets; locally, `.dev.vars` mirrors the
names with mocks. `SALLA_API_BASE` / `SALLA_AUTH_BASE` can point at a mock to rehearse the whole
flow.

## Commands

| Command | What it does |
|---|---|
| `bun install` | install dependencies |
| `bun run dev` | runs `wrangler dev` — note: on some machines workerd sockets don't work; the tests below are the reliable local check |
| `bun run check` | type checking — TypeScript 7 (native), strict, with `noUncheckedIndexedAccess` |
| `bun test` | runs the 10 tests against a recorded mock of Salla — offline, under a second |
| `bun run deploy` | deploys the Worker — code only; the secrets stay in place |

## Tests and security

- **The tests check the real behaviors.** `src/index.test.ts` runs a mock Salla and checks: the
  catalogue is fetched once, quantities are clamped, the webhook answers 401 for unsigned or
  changed deliveries and saves tokens for a signed one, and the cart endpoint builds the right
  checkout link.
- **A security review found and fixed** four things: caching for the public reads, reading the
  webhook body only after the signature check, a quantity clamp, and a guard so one bad product URL
  can't break the cart index.
- **The repo holds no secrets.** Everything sensitive lives in Cloudflare secrets or KV. `.env` and
  `.dev.vars` are git-ignored and were never committed.

## Related

- **[wiqar-storefront](https://github.com/mohammedbaqadir/wiqar-storefront)** — the website this
  serves. Its `src/lib/checkout.ts` calls this backend.

## Not built yet

Reading orders and store webhooks (`order.created`, `product.*`). They come when the shop needs
notifications.
