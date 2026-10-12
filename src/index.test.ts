/**
 * The worker's logic, pinned. Runs entirely offline: a recording mock stands in
 * for Salla, so cache, clamps, the webhook gate and the cart handoff are proven
 * without a network or a real store.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import worker, { type Env } from './index';

const upstream: Array<{ path: string; body?: unknown }> = [];
let mock: ReturnType<typeof Bun.serve>;

const env: Env = {
  SALLA_STORE: '999',
  SALLA_TOKEN: 'seed-token',
  WEBHOOK_SECRET: 'test-secret',
};

beforeAll(() => {
  mock = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const entry: { path: string; body?: unknown } = { path: url.pathname + url.search };
      if (url.pathname.endsWith('/add')) entry.body = await request.json().catch(() => null);
      upstream.push(entry);

      if (url.pathname === '/admin/v2/products') {
        return Response.json({
          data: [{ id: 1, sku: 'WQ-001', urls: { customer: 'https://shop.example/dev/product-slug/p1' } }],
          pagination: { totalPages: 1 },
        });
      }
      if (url.pathname === '/admin/v2/categories') {
        return Response.json({ data: [{ id: 1, name: 'عطور' }] });
      }
      if (url.pathname === '/store/v1/cart/latest') {
        return Response.json({ data: { cart: { id: 'cart-9' } } });
      }
      return Response.json({ status: true });
    },
  });
  env.SALLA_API_BASE = `http://127.0.0.1:${mock.port}`;
  env.SALLA_AUTH_BASE = env.SALLA_API_BASE;
});

afterAll(() => mock.stop(true));

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request('http://local' + path, init), env);

const sign = async (body: string): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode('test-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('public GETs', () => {
  test('catalog caches per page', async () => {
    upstream.length = 0;
    const first = await call('/catalog');
    const second = await call('/catalog');
    expect(upstream.length).toBe(1);
    expect(await second.json()).toEqual(await first.json());

    await call('/catalog?page=2');
    expect(upstream.length).toBe(2);
    expect(upstream[1]?.path).toBe('/admin/v2/products?page=2');
  });

  test('categories cache', async () => {
    upstream.length = 0;
    await call('/categories');
    await call('/categories');
    expect(upstream.length).toBe(1);
  });
});

describe('cart', () => {
  test('mint composes the checkout link from the envelope', async () => {
    const payload = (await (await call('/cart', { method: 'POST' })).json()) as {
      data: { id: string; checkout_url: string };
    };
    expect(payload.data.id).toBe('cart-9');
    expect(payload.data.checkout_url).toBe('https://shop.example/dev/checkout/cart-9');
  });

  test('quantity clamps to 9999', async () => {
    upstream.length = 0;
    const response = await call('/cart/cart-9/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 42, quantity: 1e15 }),
    });
    expect(response.status).toBe(200);
    const sent = upstream.find((entry) => entry.path.endsWith('/add'));
    expect((sent?.body as { quantity?: number } | undefined)?.quantity).toBe(9999);
  });

  test('identifier is required', async () => {
    const response = await call('/cart/cart-9/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(422);
  });
});

describe('the webhook gate', () => {
  test('unsigned is refused', async () => {
    const response = await call('/webhooks/salla', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  test('a signed authorize stores tokens', async () => {
    const body = JSON.stringify({
      event: 'app.store.authorize',
      data: { access_token: 'at', refresh_token: 'rt', expires: 9999999999 },
    });
    const response = await call('/webhooks/salla', {
      method: 'POST',
      headers: { 'x-salla-signature': await sign(body) },
      body,
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: boolean }).toMatchObject({ status: true });
  });

  test('a wrong signature is refused', async () => {
    const response = await call('/webhooks/salla', {
      method: 'POST',
      headers: { 'x-salla-signature': '00'.repeat(32) },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });
});

describe('health', () => {
  test('reports configuration honestly', async () => {
    const payload = (await (await call('/health')).json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.configured).toBe(true);
    expect(payload.authorized).toBe(true);
  });
});
