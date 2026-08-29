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

  if (!requestOrigin) {
    return '';
  }

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

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';

  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }

  return null;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function base64UrlToBytes(value) {
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - value.length % 4) % 4);

  return Uint8Array.from(
    atob(padded),
    char => char.charCodeAt(0)
  );
}

async function verifySessionToken(token, secret) {
  if (!token || !secret) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload)
    );

    if (!valid) return null;

    const data = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload))
    );

    const maxAge = 60 * 60 * 24 * 30 * 1000;

    if (
      !data?.sub ||
      Date.now() - Number(data.iat || 0) > maxAge
    ) {
      return null;
    }

    return String(data.sub);
  } catch {
    return null;
  }
}

function clearGoogleStateCookie() {
  return [
    'ecehub_google_state=',
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=None'
  ].join('; ');
}

function setSessionCookie(token) {
  return [
    `ecehub_session=${token}`,
    'Path=/',
    'Max-Age=2592000',
    'HttpOnly',
    'Secure',
    'SameSite=None'
  ].join('; ');
}

function getFrontendOrigin(env) {
  const configured = String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return configured[0] || 'https://espaderarios.github.io/EcEHub/';
}

function googleRedirect(env, query = {}) {
  const url = new URL(getFrontendOrigin(env));

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function handleGoogleCallbackDirect(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: googleRedirect(env, {
          community_google_error: oauthError
        }),
        'Set-Cookie': clearGoogleStateCookie()
      }
    });
  }

  if (!code || !state) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: googleRedirect(env, {
          community_google_error: 'missing_google_callback_parameters'
        }),
        'Set-Cookie': clearGoogleStateCookie()
      }
    });
  }

  const storedState = getCookie(request, 'ecehub_google_state');
  if (!storedState || storedState !== state) {
    console.error('Google callback state mismatch.', {
      hasStoredState: Boolean(storedState),
      stateMatches: storedState === state
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: googleRedirect(env, {
          community_google_error: 'invalid_google_state'
        }),
        'Set-Cookie': clearGoogleStateCookie()
      }
    });
  }

  const sessionToken = getCookie(request, 'ecehub_session');
  const userId = await verifySessionToken(
    sessionToken,
    env.SESSION_SECRET
  );

  if (!userId) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: googleRedirect(env, {
          community_google_error: 'guest_session_missing'
        }),
        'Set-Cookie': clearGoogleStateCookie()
      }
    });
  }

  try {
    const redirectUri = env.GOOGLE_REDIRECT_URI ||
      `${url.origin}/api/auth/google/callback`;

    const tokenResponse = await fetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Google token exchange failed:', tokenData);

      return new Response(null, {
        status: 302,
        headers: {
          Location: googleRedirect(env, {
            community_google_error: 'google_token_exchange_failed'
          }),
          'Set-Cookie': clearGoogleStateCookie()
        }
      });
    }

    const userInfoResponse = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const googleUser = await userInfoResponse.json();

    if (!userInfoResponse.ok) {
      console.error('Google userinfo failed:', googleUser);

      return new Response(null, {
        status: 302,
        headers: {
          Location: googleRedirect(env, {
            community_google_error: 'google_userinfo_failed'
          }),
          'Set-Cookie': clearGoogleStateCookie()
        }
      });
    }

    const googleSub = String(googleUser.sub || '').trim().slice(0, 255);
    const googleEmail = String(googleUser.email || '').trim().slice(0, 320);
    const emailVerified = googleUser.email_verified === true;

    if (!googleSub || !googleEmail || !emailVerified) {
      const reason = !googleSub
        ? 'google_identity_missing'
        : !googleEmail
          ? 'google_email_missing'
          : 'google_email_not_verified';

      return new Response(null, {
        status: 302,
        headers: {
          Location: googleRedirect(env, {
            community_google_error: reason
          }),
          'Set-Cookie': clearGoogleStateCookie()
        }
      });
    }

    const db = env.DB;
    if (!db) throw new Error('D1 database binding DB is not configured.');

    const currentUser = await db.prepare(`
      SELECT id, google_sub, google_email
      FROM users
      WHERE id = ?
    `).bind(userId).first();

    if (!currentUser) {
      throw new Error('User session no longer exists.');
    }

    const existingGoogleUser = await db.prepare(`
      SELECT id
      FROM users
      WHERE google_sub = ?
    `).bind(googleSub).first();

    if (existingGoogleUser && existingGoogleUser.id !== userId) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: googleRedirect(env, {
            community_google_error: 'google_account_already_linked'
          }),
          'Set-Cookie': clearGoogleStateCookie()
        }
      });
    }

    const existingEmailUser = await db.prepare(`
      SELECT id
      FROM users
      WHERE google_email = ?
        AND id <> ?
    `).bind(googleEmail, userId).first();

    if (existingEmailUser) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: googleRedirect(env, {
            community_google_error: 'google_email_already_linked'
          }),
          'Set-Cookie': clearGoogleStateCookie()
        }
      });
    }

    const updateResult = await db.prepare(`
      UPDATE users
      SET
        google_sub = ?,
        google_email = ?,
        google_email_verified = 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      googleSub,
      googleEmail,
      userId
    ).run();

    const verify = await db.prepare(`
      SELECT
        id,
        username,
        display_name,
        avatar_url,
        bio,
        google_sub,
        google_email,
        google_email_verified,
        created_at,
        updated_at
      FROM users
      WHERE id = ?
    `).bind(userId).first();

    console.log('=== GOOGLE LINK DIRECT UPDATE ===');
    console.log({
      userId,
      googleSub,
      googleEmail,
      changes: updateResult.meta?.changes,
      verify
    });

    if (!verify || verify.google_sub !== googleSub) {
      throw new Error('Google link database update verification failed.');
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: googleRedirect(env, {
          community_google_linked: '1'
        }),
        'Set-Cookie': [
          setSessionCookie(sessionToken),
          clearGoogleStateCookie()
        ]
      }
    });

  } catch (error) {
    console.error('Direct Google linking failed:', error);

    return new Response(null, {
      status: 302,
      headers: {
        Location: googleRedirect(env, {
          community_google_error: 'google_link_failed'
        }),
        'Set-Cookie': clearGoogleStateCookie()
      }
    });
  }
}

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
      if (origin === null || !origin) {
        return new Response(
          JSON.stringify({ error: 'CORS origin not allowed.' }),
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
        JSON.stringify({ error: 'CORS origin not allowed.' }),
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
      }, 200, origin || null);
    }

    /*
     * Handle Google OAuth callback here, before community.js.
     * This guarantees the callback updates D1 and refreshes the
     * existing EcE Hub session instead of depending on the old
     * community.js callback implementation.
     */
    if (url.pathname === '/api/auth/google/callback') {
      return handleGoogleCallbackDirect(request, env);
    }

    try {
      const response = await handleCommunity(
        normalizedRequest(request),
        env,
        origin || null
      );

      return response || json(
        { error: 'Not found.' },
        404,
        origin || null
      );

    } catch (error) {
      console.error('Community worker error:', error);

      return json({
        error: error.message || 'Internal server error.'
      }, error.statusCode || 500, origin || null);
    }
  }
};