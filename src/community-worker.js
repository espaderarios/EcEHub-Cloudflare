import { handleCommunity } from './community.js';

function corsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const configured = String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (!origin || !configured.length) return '*';
  return configured.includes(origin) ? origin : null;
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

    if (origin === null) {
      return json({ error: 'CORS origin not allowed.' }, 403, '*');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'Content-Type, Authorization',
          'access-control-allow-credentials': 'true'
        }
      });
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
      const response = await handleCommunity(normalizedRequest(request), env, origin);
      return response || json({ error: 'Not found.' }, 404, origin);
    } catch (error) {
      console.error('Community worker error:', error);
      return json({
        error: error.message || 'Internal server error.'
      }, error.statusCode || 500, origin);
    }
  }
};
