# wiqar-backend

The runtime behind the wiqar storefront — the only piece of the system trusted to talk to **Salla**
(products, stock, carts, orders, payments). It deploys independently of the storefront; the
storefront browses and builds without it, but buying runs through it.

**Live:** https://wiqar-backend.directed-countless.workers.dev

`TypeScript 7` (native compiler) · `Cloudflare Worker + KV` · `Bun` for toolchain and tests

## What it is

Salla's API refuses browsers (its responses carry no CORS headers), and its credentials must never
ship (anything a browser can see is public). So this Worker sits between the storefront and Salla: it
holds the credentials, speaks the API server-side, and exposes a deliberately tiny, well-guarded
surface.

## The API

| Route | Method | What it does |
|---|---|---|
| `/health` | GET | liveness; whether the store is configured and its tokens are in KV |
| `/catalog` | GET | the store's Salla catalogue as-is (`?page=`) — for reading and alignment, not the storefront build |
| `/categories` | GET | the store's categories |
| `/cart` | POST | mints a guest cart; answers `{status, data: {id, checkout_url}}` |
| `/cart/:id/items` | POST | adds one line — `{identifier, quantity}`; identifier is a SKU (string) or a product id (number) |
| `/webhooks/salla` | POST | verifies `X-Salla-Signature`; stores tokens on `app.store.authorize`, clears them on `app.uninstalled` |

`/catalog` and `/categories` answers are cached per-isolate for two to five minutes, so a hot loop
on the public GETs cannot spend the store token's rate budget upstream. There are deliberately **no
product-write routes**: this worker reads the catalogue and builds carts. When the real-store import
runs, write routes come back behind a shared secret.

## Auth and tokens

The signed `app.store.authorize` webhook delivers the OAuth pair; it lives in the `TOKENS` KV
namespace and never leaves the server. Access tokens last two weeks; refresh tokens are **single-use
and rotate on every refresh** — the new pair is persisted before it is used, and refreshes are
single-flight (`src/tokens.ts`), so two requests can never burn the same card twice. A dead refresh
chain means a reinstall, not a lost store.

Incoming webhooks are trusted only when the HMAC-SHA256 signature over the raw request body
verifies (constant-time compare). Unsigned or mismatched deliveries get a `401` before the body is
even read.

## The Salla surface it uses (verified against the live store)

| Purpose | Call | Notes |
|---|---|---|
| products / categories | `GET https://api.salla.dev/admin/v2/products` · `/categories` | `Authorization: Bearer <token>` |
| guest cart | `GET https://api.salla.dev/store/v1/cart/latest` | the storefront v1 API Salla's own themes use; no token needed |
| add a line | `POST https://api.salla.dev/store/v1/cart/{cart}/item/{product}/add` with `{id, quantity}` | by **product id** — the worker resolves SKU → id from the catalogue first |

Two hard-won facts:

- **`Store-Identifier` is the store's merchant number, not its username.** `943760928`, not
  `wiqar-store` — the username resolves to an empty face of the store, which is why early product
  lookups answered `المنتج غير موجود`.
- **The v2 checkout API (`/store/v2/checkout/…`) rejects items on this store.** Its product lookup
  fails even for freshly created products. The v1 storefront cart is what works — it is the API
  Salla's themes themselves use; don't re-walk the v2 path blindly.

## Store facts and findings

- The store's products match the storefront catalogue by SKU (`WQ-001` … `WQ-035`).
- **Demo stores cannot complete orders.** Salla blocks the final step with
  `لا يمكن إتمام الطلب من متجر تجريبي` — carts build, checkout refuses. Real orders wait on a real
  (non-demo) Salla store; when it exists, only `SALLA_STORE` here and a fresh app install there
  change.
- The Salla app ("واجهة وقار للمتجر", Easy Mode, signature webhooks) lives in the Partners Portal;
  its secrets never appear in this repository.

## Environment

Every credential, where it comes from, and its rotation consequence:

| Name | Where it comes from | What it is for | On rotation |
|---|---|---|---|
| `SALLA_CLIENT_ID` · `SALLA_CLIENT_SECRET` | Partners Portal → **واجهة وقار للمتجر** → App Keys | refreshing the store's access token, server-side | put both as Cloudflare secrets; a stale pair kills the refresh chain and the app needs reinstalling |
| `WEBHOOK_SECRET` | the same app → Webhooks (signature strategy) | verifying `X-Salla-Signature` on incoming events | `bunx wrangler secret put WEBHOOK_SECRET` with the new value, or every delivery answers 401 |
| `SALLA_STORE` | the store link's `identifier=` — the merchant number, not the username | the `Store-Identifier` header on storefront calls | lives in `wrangler.toml`, no secret |
| `SALLA_APP_VERSION` | the storefront version Salla's themes report | the `S-APP-VERSION` header | lives in `wrangler.toml` |
| `CLOUDFLARE_API_TOKEN` · `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → API tokens (each project has its own token; needs Workers Scripts: Edit) | `wrangler deploy`, `secret put`, KV checks | local `.env` only, never deployed |

In production the three Salla secrets live as Cloudflare secrets; locally `.dev.vars` mirrors the
names with mocks. `SALLA_API_BASE` / `SALLA_AUTH_BASE` can point at a mock to rehearse the whole flow.

## Commands

| Command | What it does |
|---|---|
| `bun install` | install dependencies |
| `bun run dev` | `wrangler dev` — note: workerd sockets are unreachable on some machines; the test suite below is the reliable local check |
| `bun run check` | the type gate — TypeScript 7 (native), strict + `noUncheckedIndexedAccess` |
| `bun test` | 10 tests against a recording mock of Salla — fully offline, under a second |
| `bun run deploy` | deploy the Worker — code only; secrets stay put |

## Quality and security

- **Tests prove the promises.** `src/index.test.ts` stands up a mock Salla and pins the behaviors
  that matter: the catalogue cache calls upstream once, quantities clamp, the webhook gate answers
  401 on unsigned and tampered deliveries and stores tokens on a signed one, and the cart mint
  composes the checkout link.
- **A review pass closed** the response caching for the public GETs, reading the webhook body only
  after a signature is present, a quantity clamp, and a guard so one malformed product URL cannot
  poison the cart index.
- **The repository holds no secrets.** Everything sensitive lives as Cloudflare secrets or in KV;
  `.env` and `.dev.vars` are git-ignored and never committed.

## Related

- **[wiqar-storefront](https://github.com/mohammedbaqadir/wiqar-storefront)** — the site this serves;
  its `src/lib/checkout.ts` is the buy seam on that side.

## Not in scope yet

Order reads and store webhooks (`order.created`, `product.*`) — they arrive when the shop needs
notifications.
