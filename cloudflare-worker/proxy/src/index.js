/**
 * Cloudflare Worker — Binance API Reverse Proxy
 *
 * Routes:
 *   /fapi/*  → https://fapi.binance.com/*  (Futures API)
 *   /api/*   → https://api.binance.com/*   (Spot API)
 *
 * Purpose: Bypass Biznet ISP SSL interception and GitHub Actions US IP blocks.
 * CF Workers run on Cloudflare's global edge network (non-US IPs for Asia).
 *
 * Deploy:
 *   cd cloudflare-worker/proxy
 *   wrangler deploy
 *
 * Then set in GitHub Secrets:
 *   BINANCE_FAPI_BASE_URL  = https://crypto-binance-proxy.YOUR_SUBDOMAIN.workers.dev/fapi
 *   BINANCE_PROXY_BASE_URL = https://crypto-binance-proxy.YOUR_SUBDOMAIN.workers.dev/api
 */

// Allowed paths prefix → target base URL
const ROUTE_MAP = {
  '/fapi': 'https://fapi.binance.com',
  '/api':  'https://api.binance.com',
};

// Headers to strip from the incoming request before forwarding
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'cf-ray',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname, search } = url;

    // Find matching route
    let targetBase = null;
    let strippedPath = pathname;

    for (const [prefix, base] of Object.entries(ROUTE_MAP)) {
      if (pathname.startsWith(prefix)) {
        targetBase = base;
        strippedPath = pathname.slice(prefix.length) || '/';
        break;
      }
    }

    if (!targetBase) {
      return new Response(
        JSON.stringify({ error: 'Unknown route. Use /fapi/* or /api/*' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetUrl = `${targetBase}${strippedPath}${search}`;

    // Build forwarded headers (strip CF-specific ones)
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        forwardHeaders.set(key, value);
      }
    }

    // Forward the request
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'follow',
    });

    try {
      const response = await fetch(proxyRequest);

      // Forward response with CORS headers so browser-based calls also work
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Proxy fetch failed', detail: err.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
