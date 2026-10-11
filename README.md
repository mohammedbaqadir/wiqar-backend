# wiqar-backend

The runtime piece behind the **وقار** storefront. Salla is the store of record — products, stock,
carts, orders, payments. This service is the only thing that talks to Salla's API, because:

- **Salla's API refuses browsers.** Its preflight response carries no `Access-Control-Allow-Origin`,
  so a page cannot call it. The call has to be server-to-server.
- **The token must never ship.** Anything sent to a browser is public. The app secret and the
  store's access token live here, in environment variables, and nowhere else.

It exists as its own repository on purpose: the storefront does not depend on it structurally, so
this implementation can be developed, replaced, or abandoned without touching the shop.

## Routes

| route | method | what it does |
|---|---|---|
| `/health` | GET | liveness, and whether Salla credentials are configured |
| `/catalog` | GET | the store's products, straight from Salla (`?page=` supported) |
| `/cart` | POST | creates a guest cart; the response carries Salla's `checkout_url` |
| `/cart/:id/items` | POST | adds a line — `{ identifier, quantity, options? }`, identified by product id (number) or sku (string) |
| `/webhooks/salla` | POST | Salla's events; verifies `X-Salla-Signature` and stores or clears the store's tokens |

Without `SALLA_STORE` every route except `/health` and the webhook answers `503` with a
machine-readable error. The store's tokens arrive via the `app.store.authorize` webhook
(Easy Mode), live in KV, and refresh themselves three days before the two-week expiry.

## The Salla surface it uses (verified against Salla's docs)

| purpose | call | notes |
|---|---|---|
| products | `GET https://api.salla.dev/admin/v2/products` | paginated `data[]`, scope `products.read`, `Authorization: Bearer <token>` |
| categories | `GET https://api.salla.dev/admin/v2/categories` | scope `categories.read` |
| create a cart | `POST https://api.salla.dev/store/v2/checkout/generate` | guest cart; no token needed, but store-scoped |
| add a line | `POST /store/v2/checkout/{cart}/items` | identify by `id`, `variant_id` or `sku` + `quantity` |

Required headers on the checkout calls: `Store-Identifier`, `s-source: app`, `s-app-name`,
`s-app-version`. Errors follow Salla's envelope (`error.code`, `error.message`, `error.fields`).

## Running it

```sh
bun install
bun run dev        # wrangler dev — serves locally, no account needed
bun run deploy     # wrangler deploy — Cloudflare Workers, free tier is plenty
```

Environment (`.env.example`):

```
SALLA_STORE=your-store-identifier
SALLA_TOKEN=the app's access token
SALLA_APP_NAME=wiqar-backend
SALLA_APP_VERSION=0.1.0
```

In production these are Cloudflare secrets, never committed and never sent to a browser.

## Open questions — do not assume these

1. **Does a free Salla plan allow installing an app and taking online payments?** If it does not,
   this service is moot until the plan changes. Unverified.
2. **Token lifetime and refresh.** Answered: access tokens last 2 weeks; refresh tokens are
   single-use and rotate on every refresh (1 month life; reuse revokes everything and forces a
   reinstall). Implemented in `src/tokens.ts` — the new pair is persisted before use, refreshes
   are single-flight.
3. **Checkout handoff details.** The cart response carries a `checkout_url`; the storefront sends
   the shopper there. Whether the cart survives that hop on the store's own plan is verified on
   the demo store during setup.

## Not in scope yet

Order reads and anything customer-level. Token refresh and the app webhooks are in; store
webhooks (`order.created`, `product.*`) arrive when the shop needs notifications.
