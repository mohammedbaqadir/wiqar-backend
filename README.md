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
| `/cart/:id/items` | POST | adds a line — `{ identifier, quantity, options? }` |

Without `SALLA_STORE` and `SALLA_TOKEN` set, every route except `/health` answers `503`
with a machine-readable error, so a misconfigured deploy fails loudly instead of quietly.

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
2. **Token lifetime and refresh.** Salla access tokens expire; this service will have to refresh
   them, or the app will need re-authorization. Not implemented yet.
3. **Checkout handoff details.** The cart response carries a `checkout_url`; the storefront should
   send the shopper there. Whether the cart survives that hop on a free plan is unverified.

## Not in scope yet

Token refresh, webhooks, order reads, and anything customer-level. Add them when the store needs
them, not before.
