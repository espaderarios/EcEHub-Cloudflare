const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;

const MAX_TITLE = 120;
const MAX_SUBJECT = 120;
const MAX_DESCRIPTION = 1000;
const MAX_CARDS = 200;
const MAX_QUESTION = 2000;
const MAX_ANSWER = 4000;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const GOOGLE_STATE_COOKIE = 'ecehub_google_state';
const GOOGLE_STATE_MAX_AGE = 600;

const SESSION_COOKIE = 'ecehub_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const ALLOWED_ORIGINS = new Set([
  'https://espaderarios.github.io',
  'http://127.0.0.1:5500',
  'http://localhost:5500'
]);

function corsOrigin(request, env) {
  const requestOrigin = request.headers.get('Origin') || '';
  const configuredOrigin = String(env.FRONTEND_ORIGIN || '').trim();

  if (configuredOrigin) {
    ALLOWED_ORIGINS.add(configuredOrigin);
  }

  return ALLOWED_ORIGINS.has(requestOrigin)
    ? requestOrigin
    : null;
}

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

function json(data, status = 200, origin = null, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
      ...extraHeaders
    }
  });
}

function errorResponse(message, status = 400, origin = null) {
  return json(
    { error: message },
    status,
    origin
  );
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function cleanString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';

  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');

    if (key === name) {
      return value.join('=');
    }
  }

  return null;
}

function bytesToBase64Url(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function base64UrlToBytes(value) {
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - value.length % 4) % 4);

  const binary = atob(padded);

  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign', 'verify']
  );

  return crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value)
  );
}

async function createSession(userId, secret) {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        sub: userId,
        iat: Date.now()
      })
    )
  );

  const signature = bytesToBase64Url(
    new Uint8Array(await hmac(secret, payload))
  );

  return `${payload}.${signature}`;
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET) {
    throw Object.assign(
      new Error('SESSION_SECRET is not configured in Cloudflare.'),
      { statusCode: 500 }
    );
  }

  const token = getCookie(request, SESSION_COOKIE);

  if (!token) {
    return null;
  }

  const [payload, signature] = token.split('.');

  if (!payload || !signature) {
    return null;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['verify']
  );

  let valid = false;

  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload)
    );
  } catch {
    return null;
  }

  if (!valid) {
    return null;
  }

  try {
    const data = JSON.parse(
      new TextDecoder().decode(
        base64UrlToBytes(payload)
      )
    );

    if (
      !data.sub ||
      Date.now() - Number(data.iat || 0) >
        SESSION_MAX_AGE * 1000
    ) {
      return null;
    }

    return String(data.sub);
  } catch {
    return null;
  }
}

async function requireUser(request, env, db) {
  const userId = await readSession(request, env);

  if (!userId) {
    throw Object.assign(
      new Error('Authentication required.'),
      { statusCode: 401 }
    );
  }

  const user = await db.prepare(`
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

  if (!user) {
    throw Object.assign(
      new Error(
        'Your session no longer exists. Please create a new session.'
      ),
      { statusCode: 401 }
    );
  }

  return user;
}

function getUserById(db, userId) { return db.prepare(` SELECT id, username, display_name, avatar_url, bio, google_sub, google_email, google_email_verified, created_at, updated_at FROM users WHERE id = ? `).bind(userId).first(); }

async function ensureUniqueUsername(
  db,
  username,
  exceptUserId = null
) {
  const query = exceptUserId
    ? `
      SELECT id
      FROM users
      WHERE username = ? COLLATE NOCASE
      AND id <> ?
    `
    : `
      SELECT id
      FROM users
      WHERE username = ? COLLATE NOCASE
    `;

  const result = exceptUserId
    ? await db.prepare(query)
        .bind(username, exceptUserId)
        .first()
    : await db.prepare(query)
        .bind(username)
        .first();

  return !result;
}

function userPublic(user) { return { id: user.id, username: user.username, displayName: user.display_name, avatarUrl: user.avatar_url, bio: user.bio, /* * A user is considered linked only when Google OAuth * has supplied a Google subject identifier. */ googleLinked: Boolean(user.google_sub), googleEmail: user.google_email || '', googleEmailVerified: Boolean(user.google_email_verified), createdAt: user.created_at, updatedAt: user.updated_at }; }

function setSessionCookie(token) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
    'HttpOnly',
    'Secure',
    'SameSite=None'
  ].join('; ');
}

function clearCookie(name) {
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=None'
  ].join('; ');
}

function setGoogleStateCookie(state) { return `ecehub_google_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=None`; }
function getGoogleStateCookie(request) { return getCookie(request, 'ecehub_google_state'); }
function clearGoogleStateCookie() { return 'ecehub_google_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None'; }

function getGoogleRedirectUri(request, env) { if (env.GOOGLE_REDIRECT_URI) { return env.GOOGLE_REDIRECT_URI; } const url = new URL(request.url); return `${url.origin}/api/auth/google/callback`; }

function googleErrorRedirect(request, env, error) {
  const url = new URL(getFrontendOrigin(env, request));
  url.searchParams.set('community_google_error', error);
  return Response.redirect(url.toString(), 302);
}

function googleSuccessRedirect(request, env) {
  const url = new URL(getFrontendOrigin(env, request));
  url.searchParams.set('community_google_linked', '1');
  return Response.redirect(url.toString(), 302);
}

function getFrontendOrigin(env, request) {
  const configured = String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (configured.length) return configured[0];

  return new URL(request.url).origin;
}


async function createAnonymousSession( request, env, db, origin ) { /* * If the browser already has a valid session, * keep using it. */ const existingId = await readSession(request, env); if (existingId) { const existing = await getUserById(db, existingId); if (existing) { return json( { user: userPublic(existing), existing: true }, 200, origin ); } } /* * Create a local/guest account. * * This account is NOT linked to Google. * Its data can remain local until the user * voluntarily links a Google account. */ const userId = randomId('usr'); let username = `user_${crypto.randomUUID().slice(0, 8)}`; while (!(await ensureUniqueUsername(db, username))) { username = `user_${crypto.randomUUID().slice(0, 8)}`; } await db.prepare(` INSERT INTO users ( id, username, display_name ) VALUES (?, ?, ?) `).bind( userId, username, username ).run(); const token = await createSession( userId, env.SESSION_SECRET ); const user = await getUserById( db, userId ); return json( { user: userPublic(user), existing: false }, 201, origin, { 'Set-Cookie': setSessionCookie(token) } ); }

async function handleGoogleStart(request, env, db) {
  if (request.method !== 'GET') {
    return errorResponse('Method not allowed.', 405);
  }

  if (!env.GOOGLE_CLIENT_ID) {
    return errorResponse('GOOGLE_CLIENT_ID is not configured.', 500);
  }

  if (!env.GOOGLE_CLIENT_SECRET) {
    return errorResponse('GOOGLE_CLIENT_SECRET is not configured.', 500);
  }

  const userId = await readSession(request, env);

  if (!userId) {
    return errorResponse('Authentication required.', 401);
  }

  const user = await db.prepare(`
    SELECT
      id,
      google_sub
    FROM users
    WHERE id = ?
  `).bind(userId).first();

  if (!user) {
    return errorResponse('User session no longer exists.', 401);
  }

  if (user.google_sub) {
    return errorResponse('Google account is already linked.', 409);
  }

  const state = bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(32))
  );

  const redirectUri = getGoogleRedirectUri(request);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    include_granted_scopes: 'true'
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GOOGLE_AUTH_URL}?${params.toString()}`,
      'Set-Cookie': setGoogleStateCookie(state)
    }
  });
}

async function handleGoogleCallback(request, env, db) {
  const url = new URL(request.url);

  const error = url.searchParams.get('error');

  if (error) {
    return googleErrorRedirect(request, env, error);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return googleErrorRedirect(
      request,
      env,
      'missing_google_callback_parameters'
    );
  }

  const storedState = getCookie(request, GOOGLE_STATE_COOKIE);

  if (!storedState || storedState !== state) {
    return googleErrorRedirect(
      request,
      env,
      'invalid_google_state'
    );
  }

  const userId = await readSession(request, env);

  if (!userId) {
    return googleErrorRedirect(
      request,
      env,
      'guest_session_missing'
    );
  }

  const user = await db.prepare(`
    SELECT
      id,
      google_sub,
      google_email
    FROM users
    WHERE id = ?
  `).bind(userId).first();

  if (!user) {
    return googleErrorRedirect(
      request,
      env,
      'user_not_found'
    );
  }

  try {
    const redirectUri = getGoogleRedirectUri(request);

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
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
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('Google token exchange failed:', tokenData);

      return googleErrorRedirect(
        request,
        env,
        'google_token_exchange_failed'
      );
    }

    const userInfoResponse = await fetch(
      GOOGLE_USERINFO_URL,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const googleUser = await userInfoResponse.json();

    if (!userInfoResponse.ok) {
      console.error('Google userinfo failed:', googleUser);

      return googleErrorRedirect(
        request,
        env,
        'google_userinfo_failed'
      );
    }

    const googleSub = cleanString(googleUser.sub, 255);
    const googleEmail = cleanString(googleUser.email, 320);
    const emailVerified = googleUser.email_verified === true;

    if (!googleSub) {
      return googleErrorRedirect(
        request,
        env,
        'google_identity_missing'
      );
    }

    if (!googleEmail) {
      return googleErrorRedirect(
        request,
        env,
        'google_email_missing'
      );
    }

    if (!emailVerified) {
      return googleErrorRedirect(
        request,
        env,
        'google_email_not_verified'
      );
    }

    const existingGoogleUser = await db.prepare(`
      SELECT
        id,
        username,
        display_name
      FROM users
      WHERE google_sub = ?
    `).bind(googleSub).first();

    if (existingGoogleUser && existingGoogleUser.id !== userId) {
      return googleErrorRedirect(
        request,
        env,
        'google_account_already_linked'
      );
    }

    const existingEmailUser = await db.prepare(`
      SELECT
        id,
        google_sub
      FROM users
      WHERE google_email = ?
        AND id <> ?
    `).bind(googleEmail, userId).first();

    if (existingEmailUser) {
      return googleErrorRedirect(
        request,
        env,
        'google_email_already_linked'
      );
    }

    await db.prepare(`
      UPDATE users
      SET
        google_sub = ?,
        google_email = ?,
        google_email_verified = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      googleSub,
      googleEmail,
      emailVerified ? 1 : 0,
      userId
    ).run();

    return new Response(null, {
      status: 302,
      headers: {
        Location: getFrontendOrigin(env, request),
        'Set-Cookie': clearGoogleStateCookie()
      }
    });

  } catch (err) {
    console.error('Google linking error:', err);

    return googleErrorRedirect(
      request,
      env,
      'google_link_failed'
    );
  }
}

async function handleProfile( request, env, db, origin ) { const user = await requireUser( request, env, db ); if (request.method === 'GET') { return json( { user: userPublic(user) }, 200, origin ); } if (request.method !== 'PATCH') { return errorResponse( 'Method not allowed.', 405, origin ); } let body; try { body = await request.json(); } catch { return errorResponse( 'Request body must be valid JSON.', 400, origin ); } /* * Username is still editable for guest users, * but Google identity fields are NEVER accepted * from this endpoint. */ const username = cleanString( body.username, 24 ); const displayName = cleanString( body.displayName, 80 ); const avatarUrl = cleanString( body.avatarUrl, 500 ); const bio = cleanString( body.bio, 500 ); if ( username && !USERNAME_PATTERN.test(username) ) { return errorResponse( 'Username must be 3-24 characters and contain only letters, numbers, and underscores.', 400, origin ); } if ( username && !(await ensureUniqueUsername( db, username, user.id )) ) { return errorResponse( 'That username is already taken.', 409, origin ); } const nextUsername = username || user.username; const nextDisplayName = body.displayName !== undefined ? displayName : user.display_name; const nextAvatarUrl = body.avatarUrl !== undefined ? avatarUrl : user.avatar_url; const nextBio = body.bio !== undefined ? bio : user.bio; /* * IMPORTANT: * * Do NOT update: * google_sub * google_email * google_email_verified * * Those fields are controlled exclusively * by the Google OAuth flow. */ await db.prepare(` UPDATE users SET username = ?, display_name = ?, avatar_url = ?, bio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? `).bind( nextUsername, nextDisplayName, nextAvatarUrl, nextBio, user.id ).run(); const updated = await getUserById( db, user.id ); return json( { user: userPublic(updated) }, 200, origin ); }

async function handleUsernameAvailability(
  request,
  env,
  db,
  origin
) {
  if (request.method !== 'GET') {
    return errorResponse(
      'Method not allowed.',
      405,
      origin
    );
  }

  const username =
    cleanString(
      new URL(request.url)
        .searchParams
        .get('username'),
      24
    );

  if (
    !USERNAME_PATTERN.test(username)
  ) {
    return json(
      {
        available: false,
        reason: 'invalid'
      },
      200,
      origin
    );
  }

  const currentUserId =
    await readSession(
      request,
      env
    );

  return json(
    {
      available:
        await ensureUniqueUsername(
          db,
          username,
          currentUserId
        ),
      username
    },
    200,
    origin
  );
}

/*
 * FLASHCARDS
 */

function normalizeCards(cards) {
  if (
    !Array.isArray(cards) ||
    !cards.length ||
    cards.length > MAX_CARDS
  ) {
    throw Object.assign(
      new Error(
        `cards must contain 1-${MAX_CARDS} flashcards.`
      ),
      {
        statusCode: 400
      }
    );
  }

  return cards.map(
    (card, index) => {
      const question =
        cleanString(
          card?.question,
          MAX_QUESTION
        );

      const answer =
        cleanString(
          card?.answer,
          MAX_ANSWER
        );

      if (!question || !answer) {
        throw Object.assign(
          new Error(
            `Flashcard ${index + 1} must have both a question and an answer.`
          ),
          {
            statusCode: 400
          }
        );
      }

      return {
        question,
        answer,
        position: index
      };
    }
  );
}

async function getSetById(
  db,
  setId,
  includeCards = true
) {
  const set =
    await db.prepare(`
      SELECT
        s.id,
        s.title,
        s.subject,
        s.description,
        s.visibility,
        s.card_count,
        s.created_at,
        s.updated_at,
        u.id AS author_id,
        u.username AS author_username,
        u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url,
        u.google_sub AS author_google_sub
      FROM flashcard_sets s
      JOIN users u
        ON u.id = s.author_id
      WHERE s.id = ?
    `)
      .bind(setId)
      .first();

  if (!set) {
    return null;
  }

  const result = {
    id: set.id,
    title: set.title,
    subject: set.subject,
    description: set.description,
    visibility: set.visibility,
    cardCount: set.card_count,
    createdAt: set.created_at,
    updatedAt: set.updated_at,

    author: {
      id: set.author_id,
      username: set.author_username,
      displayName: set.author_display_name,
      avatarUrl: set.author_avatar_url,

      accountType:
        set.author_google_sub
          ? 'google'
          : 'guest'
    }
  };

  if (includeCards) {
    const cards =
      await db.prepare(`
        SELECT
          id,
          question,
          answer,
          position
        FROM flashcards
        WHERE set_id = ?
        ORDER BY position ASC
      `)
        .bind(setId)
        .all();

    result.cards =
      cards.results || [];
  }

  return result;
}

async function handleFlashcardSets(
  request,
  env,
  db,
  origin,
  pathParts
) {
  /*
   * Public list.
   */

  if (
    request.method === 'GET' &&
    pathParts.length === 1
  ) {
    const url =
      new URL(request.url);

    const query =
      cleanString(
        url.searchParams.get('q'),
        100
      );

    const subject =
      cleanString(
        url.searchParams.get('subject'),
        120
      );

    const limit =
      Math.min(
        50,
        Math.max(
          1,
          Number(
            url.searchParams.get(
              'limit'
            ) || 20
          )
        )
      );

    let sql = `
      SELECT
        s.id,
        s.title,
        s.subject,
        s.description,
        s.card_count,
        s.created_at,
        s.updated_at,
        u.id AS author_id,
        u.username AS author_username,
        u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url,
        u.google_sub AS author_google_sub
      FROM flashcard_sets s
      JOIN users u
        ON u.id = s.author_id
      WHERE s.visibility = 'public'
    `;

    const params = [];

    if (query) {
      sql += `
        AND (
          s.title LIKE ?
          OR s.subject LIKE ?
          OR s.description LIKE ?
          OR u.username LIKE ?
          OR u.display_name LIKE ?
        )
      `;

      const like = `%${query}%`;

      params.push(
        like,
        like,
        like,
        like,
        like
      );
    }

    if (subject) {
      sql +=
        ' AND s.subject LIKE ?';

      params.push(
        `%${subject}%`
      );
    }

    sql +=
      ' ORDER BY s.created_at DESC LIMIT ?';

    params.push(limit);

    const rows =
      await db.prepare(sql)
        .bind(...params)
        .all();

    return json(
      {
        sets:
          (rows.results || [])
            .map(row => ({
              id: row.id,
              title: row.title,
              subject: row.subject,
              description:
                row.description,
              cardCount:
                row.card_count,
              createdAt:
                row.created_at,
              updatedAt:
                row.updated_at,

              author: {
                id:
                  row.author_id,
                username:
                  row.author_username,
                displayName:
                  row.author_display_name,
                avatarUrl:
                  row.author_avatar_url,

                accountType:
                  row.author_google_sub
                    ? 'google'
                    : 'guest'
              }
            }))
      },
      200,
      origin
    );
  }

  /*
   * Create flashcard set.
   */

  if (
    request.method === 'POST' &&
    pathParts.length === 1
  ) {
    const user =
      await requireUser(
        request,
        env,
        db
      );

    let body;

    try {
      body =
        await request.json();
    } catch {
      return errorResponse(
        'Request body must be valid JSON.',
        400,
        origin
      );
    }

    const title =
      cleanString(
        body.title,
        MAX_TITLE
      );

    const subject =
      cleanString(
        body.subject,
        MAX_SUBJECT
      );

    const description =
      cleanString(
        body.description,
        MAX_DESCRIPTION
      );

    const visibility =
      body.visibility === 'private'
        ? 'private'
        : 'public';

    if (!title) {
      return errorResponse(
        'title is required.',
        400,
        origin
      );
    }

    let cards;

    try {
      cards =
        normalizeCards(
          body.cards
        );
    } catch (error) {
      return errorResponse(
        error.message,
        error.statusCode || 400,
        origin
      );
    }

    const setId =
      randomId('fcset');

    await db.prepare(`
      INSERT INTO flashcard_sets
        (
          id,
          author_id,
          title,
          subject,
          description,
          visibility,
          card_count
        )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        setId,
        user.id,
        title,
        subject,
        description,
        visibility,
        cards.length
      )
      .run();

    const statements =
      cards.map(card =>
        db.prepare(`
          INSERT INTO flashcards
            (
              id,
              set_id,
              question,
              answer,
              position
            )
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(
            randomId('fc'),
            setId,
            card.question,
            card.answer,
            card.position
          )
      );

    await db.batch(
      statements
    );

    const created =
      await getSetById(
        db,
        setId,
        true
      );

    return json(
      {
        set: created
      },
      201,
      origin
    );
  }

  /*
   * Individual set.
   */

  const setId =
    pathParts[1];

  const set =
    await getSetById(
      db,
      setId,
      true
    );

  if (!set) {
    return errorResponse(
      'Flashcard set not found.',
      404,
      origin
    );
  }

  if (
    request.method === 'GET' &&
    pathParts.length === 2
  ) {
    if (
      set.visibility !== 'public'
    ) {
      const userId =
        await readSession(
          request,
          env
        );

      if (
        userId !==
        set.author.id
      ) {
        return errorResponse(
          'Flashcard set not found.',
          404,
          origin
        );
      }
    }

    return json(
      {
        set
      },
      200,
      origin
    );
  }

  if (
    request.method === 'PATCH' &&
    pathParts.length === 2
  ) {
    const user =
      await requireUser(
        request,
        env,
        db
      );

    if (
      user.id !==
      set.author.id
    ) {
      return errorResponse(
        'Only the author can edit this flashcard set.',
        403,
        origin
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return errorResponse(
        'Request body must be valid JSON.',
        400,
        origin
      );
    }

    const title =
      body.title !== undefined
        ? cleanString(
            body.title,
            MAX_TITLE
          )
        : set.title;

    const subject =
      body.subject !== undefined
        ? cleanString(
            body.subject,
            MAX_SUBJECT
          )
        : set.subject;

    const description =
      body.description !== undefined
        ? cleanString(
            body.description,
            MAX_DESCRIPTION
          )
        : set.description;

    const visibility =
      body.visibility === 'private'
        ? 'private'
        : (
          body.visibility === 'public'
            ? 'public'
            : set.visibility
        );

    if (!title) {
      return errorResponse(
        'title is required.',
        400,
        origin
      );
    }

    if (
      body.cards !== undefined
    ) {
      let cards;

      try {
        cards =
          normalizeCards(
            body.cards
          );
      } catch (error) {
        return errorResponse(
          error.message,
          error.statusCode || 400,
          origin
        );
      }

      await db.prepare(`
        UPDATE flashcard_sets
        SET
          title = ?,
          subject = ?,
          description = ?,
          visibility = ?,
          card_count = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .bind(
          title,
          subject,
          description,
          visibility,
          cards.length,
          set.id
        )
        .run();

      await db.prepare(
        'DELETE FROM flashcards WHERE set_id = ?'
      )
        .bind(set.id)
        .run();

      await db.batch(
        cards.map(card =>
          db.prepare(`
            INSERT INTO flashcards
              (
                id,
                set_id,
                question,
                answer,
                position
              )
            VALUES (?, ?, ?, ?, ?)
          `)
            .bind(
              randomId('fc'),
              set.id,
              card.question,
              card.answer,
              card.position
            )
        )
      );
    } else {
      await db.prepare(`
        UPDATE flashcard_sets
        SET
          title = ?,
          subject = ?,
          description = ?,
          visibility = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .bind(
          title,
          subject,
          description,
          visibility,
          set.id
        )
        .run();
    }

    return json(
      {
        set:
          await getSetById(
            db,
            set.id,
            true
          )
      },
      200,
      origin
    );
  }

  if (
    request.method === 'DELETE' &&
    pathParts.length === 2
  ) {
    const user =
      await requireUser(
        request,
        env,
        db
      );

    if (
      user.id !==
      set.author.id
    ) {
      return errorResponse(
        'Only the author can delete this flashcard set.',
        403,
        origin
      );
    }

    await db.prepare(
      'DELETE FROM flashcard_sets WHERE id = ?'
    )
      .bind(set.id)
      .run();

    return json(
      {
        ok: true
      },
      200,
      origin
    );
  }

  return errorResponse(
    'Method not allowed.',
    405,
    origin
  );
}

/*
 * WORKSPACE
 */

async function handleWorkspace(
  request,
  env,
  db,
  origin,
  pathParts
) {
  const user =
    await requireUser(
      request,
      env,
      db
    );

  if (
    request.method === 'GET' &&
    pathParts.length === 1
  ) {
    const rows =
      await db.prepare(`
        SELECT
          s.id,
          s.title,
          s.subject,
          s.description,
          s.card_count,
          s.created_at,
          w.added_at,
          u.username AS author_username,
          u.display_name AS author_display_name,
          u.avatar_url AS author_avatar_url,
          u.google_sub AS author_google_sub
        FROM workspace_sets w
        JOIN flashcard_sets s
          ON s.id = w.flashcard_set_id
        JOIN users u
          ON u.id = s.author_id
        WHERE w.user_id = ?
        ORDER BY w.added_at DESC
      `)
        .bind(user.id)
        .all();

    return json(
      {
        sets:
          (rows.results || [])
            .map(row => ({
              id: row.id,
              title: row.title,
              subject: row.subject,
              description:
                row.description,
              cardCount:
                row.card_count,
              createdAt:
                row.created_at,
              addedAt:
                row.added_at,

              author: {
                username:
                  row.author_username,
                displayName:
                  row.author_display_name,
                avatarUrl:
                  row.author_avatar_url,

                accountType:
                  row.author_google_sub
                    ? 'google'
                    : 'guest'
              }
            }))
      },
      200,
      origin
    );
  }

  if (
    request.method === 'POST' &&
    pathParts.length === 2
  ) {
    const setId =
      pathParts[1];

    const set =
      await db.prepare(`
        SELECT id
        FROM flashcard_sets
        WHERE id = ?
        AND visibility = 'public'
      `)
        .bind(setId)
        .first();

    if (!set) {
      return errorResponse(
        'Public flashcard set not found.',
        404,
        origin
      );
    }

    await db.prepare(`
      INSERT INTO workspace_sets
        (
          user_id,
          flashcard_set_id
        )
      VALUES (?, ?)
      ON CONFLICT(
        user_id,
        flashcard_set_id
      )
      DO NOTHING
    `)
      .bind(
        user.id,
        setId
      )
      .run();

    return json(
      {
        ok: true,
        flashcardSetId: setId
      },
      200,
      origin
    );
  }

  if (
    request.method === 'DELETE' &&
    pathParts.length === 2
  ) {
    await db.prepare(`
      DELETE FROM workspace_sets
      WHERE user_id = ?
      AND flashcard_set_id = ?
    `)
      .bind(
        user.id,
        pathParts[1]
      )
      .run();

    return json(
      {
        ok: true
      },
      200,
      origin
    );
  }

  return errorResponse(
    'Method not allowed.',
    405,
    origin
  );
}

/*
 * MAIN ROUTER
 */

export async function handleCommunity(request, env, origin) {

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin)
    });
  }

  if (!env.DB) {
    return errorResponse(
      'Cloudflare D1 binding DB is not configured.',
      500,
      origin
    );
  }

  const db = env.DB;
  const url =
    new URL(request.url);

  const parts =
    url.pathname
      .split('/')
      .filter(Boolean);

  /*
   * Guest session.
   */

  if (url.pathname === '/api/auth/session') {
    if (request.method !== 'POST') {
      return errorResponse('Method not allowed.', 405, origin);
    }

    return createAnonymousSession(
      request,
      env,
      db,
      origin
    );
  }

  if (url.pathname === '/api/auth/google') {
    return handleGoogleStart(request, env, db);
  }

  if (url.pathname === '/api/auth/google/callback') {
    return handleGoogleCallback(request, env, db);
  }

  if (url.pathname === '/api/users/me') {
    return handleProfile(request, env, db, origin);
  }

  if (
    url.pathname ===
    '/api/users/check-username'
  ) {
    return handleUsernameAvailability(
      request,
      env,
      db,
      origin
    );
  }

  /*
   * Flashcards.
   */

  if (
    parts[0] === 'api' &&
    parts[1] === 'flashcards'
  ) {
    return handleFlashcardSets(
      request,
      env,
      db,
      origin,
      parts.slice(2)
    );
  }

  /*
   * Workspace.
   */

  if (
    parts[0] === 'api' &&
    parts[1] === 'workspace'
  ) {
    return handleWorkspace(
      request,
      env,
      db,
      origin,
      parts.slice(2)
    );
  }

  return null;
}
