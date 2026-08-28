import { handleCommunity } from './community.js';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function corsOrigin(request, env) {
  const requestOrigin = request.headers.get('Origin') || '';

  const allowedOrigins = new Set([
    'https://espaderarios.github.io',
    'http://127.0.0.1:5500',
    'http://localhost:5500'
  ]);

  const configuredOrigins = String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  for (const configuredOrigin of configuredOrigins) {
    allowedOrigins.add(configuredOrigin);
  }

  if (allowedOrigins.has(requestOrigin)) {
    return requestOrigin;
  }

  return null;
}

function json(data, status = 200, origin = '*', extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
      'access-control-allow-credentials': 'true',
      ...extraHeaders
    }
  });
}

// community.js uses a two-level path internally for item routes and a one-level
// path for collection routes. Keep the public API clean while adapting the
// incoming URL before handing it to the router.
function normalizedRequest(request) {
  const url = new URL(request.url);

  for (const resource of ['flashcards', 'workspace']) {
    const prefix = `/api/${resource}`;
    if (url.pathname === prefix) {
      url.pathname = `${prefix}/__collection__`;
      return new Request(url, request);
    }

    if (url.pathname.startsWith(`${prefix}/`)) {
      const rest = url.pathname.slice(`${prefix}/`.length);
      if (rest && !rest.includes('/')) {
        url.pathname = `${prefix}/__item__/${rest}`;
        return new Request(url, request);
      }
    }
  }

  return request;
}

export default {
  async fetch(request, env) {
    const origin = corsOrigin(request, env);

    if (request.method === 'OPTIONS') {
      if (origin === null) {
        return new Response(
          JSON.stringify({
            error: 'CORS origin not allowed.'
          }),
          {
            status: 403,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Vary': 'Origin'
            }
          }
        );
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    if (origin === null) {
      return new Response(
        JSON.stringify({
          error: 'CORS origin not allowed.'
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Vary': 'Origin'
          }
        }
      );
    }

    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'ecehub-community-cloudflare-worker',
        database: Boolean(env.DB)
      }, 200, origin);
    }

    try {
      const response = await handleCommunity(
        normalizedRequest(request),
        env,
        origin
      );

      return response || json(
        { error: 'Not found.' },
        404,
        origin
      );

    } catch (error) {
      console.error('Community worker error:', error);

      return json({
        error: error.message || 'Internal server error.'
      }, error.statusCode || 500, origin);
    }
  }
};