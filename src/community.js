const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
const MAX_TITLE = 120;
const MAX_SUBJECT = 120;
const MAX_DESCRIPTION = 1000;
const MAX_CARDS = 200;
const MAX_QUESTION = 2000;
const MAX_ANSWER = 4000;
const SESSION_COOKIE = 'ecehub_session';

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

function errorResponse(message, status = 400, origin = '*') {
  return json({ error: message }, status, origin);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
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
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
}

async function createSession(userId, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    sub: userId,
    iat: Date.now()
  })));
  const signature = bytesToBase64Url(new Uint8Array(await hmac(secret, payload)));
  return `${payload}.${signature}`;
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET) {
    throw Object.assign(new Error('SESSION_SECRET is not configured in Cloudflare.'), { statusCode: 500 });
  }

  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
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

  if (!valid) return null;

  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!data.sub || Date.now() - Number(data.iat || 0) > 1000 * 60 * 60 * 24 * 30) return null;
    return String(data.sub);
  } catch {
    return null;
  }
}

async function requireUser(request, env, db) {
  const userId = await readSession(request, env);
  if (!userId) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 });
  const user = await db.prepare(
    'SELECT id, username, display_name, avatar_url, bio, created_at, updated_at FROM users WHERE id = ?'
  ).bind(userId).first();
  if (!user) throw Object.assign(new Error('Your session no longer exists. Please create a new session.'), { statusCode: 401 });
  return user;
}

function cleanString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

async function ensureUniqueUsername(db, username, exceptUserId = null) {
  const query = exceptUserId
    ? 'SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?'
    : 'SELECT id FROM users WHERE username = ? COLLATE NOCASE';
  const result = exceptUserId
    ? await db.prepare(query).bind(username, exceptUserId).first()
    : await db.prepare(query).bind(username).first();
  return !result;
}

function userPublic(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    bio: user.bio,
    createdAt: user.created_at
  };
}

function setSessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=None`;
}

async function createAnonymousSession(request, env, db, origin) {
  const existingId = await readSession(request, env);
  if (existingId) {
    const existing = await db.prepare(
      'SELECT id, username, display_name, avatar_url, bio, created_at, updated_at FROM users WHERE id = ?'
    ).bind(existingId).first();
    if (existing) return json({ user: userPublic(existing), existing: true }, 200, origin);
  }

  const userId = randomId('usr');
  let username = `user_${crypto.randomUUID().slice(0, 8)}`;

  while (!(await ensureUniqueUsername(db, username))) {
    username = `user_${crypto.randomUUID().slice(0, 8)}`;
  }

  await db.prepare(
    'INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)'
  ).bind(userId, username, username).run();

  const token = await createSession(userId, env.SESSION_SECRET);
  const user = await db.prepare(
    'SELECT id, username, display_name, avatar_url, bio, created_at, updated_at FROM users WHERE id = ?'
  ).bind(userId).first();

  return json(
    { user: userPublic(user), existing: false },
    201,
    origin,
    { 'Set-Cookie': setSessionCookie(token) }
  );
}

async function handleProfile(request, env, db, origin) {
  const user = await requireUser(request, env, db);

  if (request.method === 'GET') {
    return json({ user: userPublic(user) }, 200, origin);
  }

  if (request.method !== 'PATCH') return errorResponse('Method not allowed.', 405, origin);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Request body must be valid JSON.', 400, origin); }

  const username = cleanString(body.username, 24);
  const displayName = cleanString(body.displayName, 80);
  const avatarUrl = cleanString(body.avatarUrl, 500);
  const bio = cleanString(body.bio, 500);

  if (username && !USERNAME_PATTERN.test(username)) {
    return errorResponse('Username must be 3-24 characters and contain only letters, numbers, and underscores.', 400, origin);
  }

  if (username && !(await ensureUniqueUsername(db, username, user.id))) {
    return errorResponse('That username is already taken.', 409, origin);
  }

  const nextUsername = username || user.username;
  const nextDisplayName = body.displayName !== undefined ? displayName : user.display_name;
  const nextAvatarUrl = body.avatarUrl !== undefined ? avatarUrl : user.avatar_url;
  const nextBio = body.bio !== undefined ? bio : user.bio;

  await db.prepare(`
    UPDATE users
    SET username = ?, display_name = ?, avatar_url = ?, bio = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(nextUsername, nextDisplayName, nextAvatarUrl, nextBio, user.id).run();

  const updated = await db.prepare(
    'SELECT id, username, display_name, avatar_url, bio, created_at, updated_at FROM users WHERE id = ?'
  ).bind(user.id).first();

  return json({ user: userPublic(updated) }, 200, origin);
}

async function handleUsernameAvailability(request, env, db, origin) {
  if (request.method !== 'GET') return errorResponse('Method not allowed.', 405, origin);
  const username = cleanString(new URL(request.url).searchParams.get('username'), 24);
  if (!USERNAME_PATTERN.test(username)) return json({ available: false, reason: 'invalid' }, 200, origin);
  const currentUserId = await readSession(request, env);
  return json({
    available: await ensureUniqueUsername(db, username, currentUserId),
    username
  }, 200, origin);
}

function normalizeCards(cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > MAX_CARDS) {
    throw Object.assign(new Error(`cards must contain 1-${MAX_CARDS} flashcards.`), { statusCode: 400 });
  }

  return cards.map((card, index) => {
    const question = cleanString(card?.question, MAX_QUESTION);
    const answer = cleanString(card?.answer, MAX_ANSWER);
    if (!question || !answer) throw Object.assign(new Error(`Flashcard ${index + 1} must have both a question and an answer.`), { statusCode: 400 });
    return { question, answer, position: index };
  });
}

async function getSetById(db, setId, includeCards = true) {
  const set = await db.prepare(`
    SELECT
      s.id, s.title, s.subject, s.description, s.visibility,
      s.card_count, s.created_at, s.updated_at,
      u.id AS author_id, u.username AS author_username,
      u.display_name AS author_display_name, u.avatar_url AS author_avatar_url
    FROM flashcard_sets s
    JOIN users u ON u.id = s.author_id
    WHERE s.id = ?
  `).bind(setId).first();

  if (!set) return null;

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
      avatarUrl: set.author_avatar_url
    }
  };

  if (includeCards) {
    const cards = await db.prepare(`
      SELECT id, question, answer, position
      FROM flashcards
      WHERE set_id = ?
      ORDER BY position ASC
    `).bind(setId).all();
    result.cards = cards.results || [];
  }

  return result;
}

async function handleFlashcardSets(request, env, db, origin, pathParts) {
  if (request.method === 'GET' && pathParts.length === 1) {
    const url = new URL(request.url);
    const query = cleanString(url.searchParams.get('q'), 100);
    const subject = cleanString(url.searchParams.get('subject'), 120);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));

    let sql = `
      SELECT
        s.id, s.title, s.subject, s.description, s.card_count,
        s.created_at, s.updated_at,
        u.id AS author_id, u.username AS author_username,
        u.display_name AS author_display_name, u.avatar_url AS author_avatar_url
      FROM flashcard_sets s
      JOIN users u ON u.id = s.author_id
      WHERE s.visibility = 'public'
    `;
    const params = [];

    if (query) {
      sql += ` AND (
        s.title LIKE ? OR s.subject LIKE ? OR s.description LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?
      )`;
      const like = `%${query}%`;
      params.push(like, like, like, like, like);
    }

    if (subject) {
      sql += ' AND s.subject LIKE ?';
      params.push(`%${subject}%`);
    }

    sql += ' ORDER BY s.created_at DESC LIMIT ?';
    params.push(limit);

    const rows = await db.prepare(sql).bind(...params).all();
    return json({
      sets: (rows.results || []).map(row => ({
        id: row.id,
        title: row.title,
        subject: row.subject,
        description: row.description,
        cardCount: row.card_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        author: {
          id: row.author_id,
          username: row.author_username,
          displayName: row.author_display_name,
          avatarUrl: row.author_avatar_url
        }
      }))
    }, 200, origin);
  }

  if (request.method === 'POST' && pathParts.length === 1) {
    const user = await requireUser(request, env, db);
    let body;
    try { body = await request.json(); } catch { return errorResponse('Request body must be valid JSON.', 400, origin); }

    const title = cleanString(body.title, MAX_TITLE);
    const subject = cleanString(body.subject, MAX_SUBJECT);
    const description = cleanString(body.description, MAX_DESCRIPTION);
    const visibility = body.visibility === 'private' ? 'private' : 'public';

    if (!title) return errorResponse('title is required.', 400, origin);

    let cards;
    try { cards = normalizeCards(body.cards); } catch (error) { return errorResponse(error.message, error.statusCode || 400, origin); }

    const setId = randomId('fcset');
    await db.prepare(`
      INSERT INTO flashcard_sets
        (id, author_id, title, subject, description, visibility, card_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(setId, user.id, title, subject, description, visibility, cards.length).run();

    const statements = cards.map(card => db.prepare(`
      INSERT INTO flashcards (id, set_id, question, answer, position)
      VALUES (?, ?, ?, ?, ?)
    `).bind(randomId('fc'), setId, card.question, card.answer, card.position));

    await db.batch(statements);

    const created = await getSetById(db, setId, true);
    return json({ set: created }, 201, origin);
  }

  const setId = pathParts[1];
  const set = await getSetById(db, setId, true);
  if (!set) return errorResponse('Flashcard set not found.', 404, origin);

  if (request.method === 'GET' && pathParts.length === 2) {
    if (set.visibility !== 'public') {
      const userId = await readSession(request, env);
      if (userId !== set.author.id) return errorResponse('Flashcard set not found.', 404, origin);
    }
    return json({ set }, 200, origin);
  }

  if (request.method === 'PATCH' && pathParts.length === 2) {
    const user = await requireUser(request, env, db);
    if (user.id !== set.author.id) return errorResponse('Only the author can edit this flashcard set.', 403, origin);

    let body;
    try { body = await request.json(); } catch { return errorResponse('Request body must be valid JSON.', 400, origin); }

    const title = body.title !== undefined ? cleanString(body.title, MAX_TITLE) : set.title;
    const subject = body.subject !== undefined ? cleanString(body.subject, MAX_SUBJECT) : set.subject;
    const description = body.description !== undefined ? cleanString(body.description, MAX_DESCRIPTION) : set.description;
    const visibility = body.visibility === 'private' ? 'private' : (body.visibility === 'public' ? 'public' : set.visibility);

    if (!title) return errorResponse('title is required.', 400, origin);

    if (body.cards !== undefined) {
      let cards;
      try { cards = normalizeCards(body.cards); } catch (error) { return errorResponse(error.message, error.statusCode || 400, origin); }

      await db.prepare(`
        UPDATE flashcard_sets
        SET title = ?, subject = ?, description = ?, visibility = ?, card_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(title, subject, description, visibility, cards.length, set.id).run();

      await db.prepare('DELETE FROM flashcards WHERE set_id = ?').bind(set.id).run();
      await db.batch(cards.map(card => db.prepare(`
        INSERT INTO flashcards (id, set_id, question, answer, position)
        VALUES (?, ?, ?, ?, ?)
      `).bind(randomId('fc'), set.id, card.question, card.answer, card.position)));
    } else {
      await db.prepare(`
        UPDATE flashcard_sets
        SET title = ?, subject = ?, description = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(title, subject, description, visibility, set.id).run();
    }

    return json({ set: await getSetById(db, set.id, true) }, 200, origin);
  }

  if (request.method === 'DELETE' && pathParts.length === 2) {
    const user = await requireUser(request, env, db);
    if (user.id !== set.author.id) return errorResponse('Only the author can delete this flashcard set.', 403, origin);
    await db.prepare('DELETE FROM flashcard_sets WHERE id = ?').bind(set.id).run();
    return json({ ok: true }, 200, origin);
  }

  return errorResponse('Method not allowed.', 405, origin);
}

async function handleWorkspace(request, env, db, origin, pathParts) {
  const user = await requireUser(request, env, db);

  if (request.method === 'GET' && pathParts.length === 1) {
    const rows = await db.prepare(`
      SELECT
        s.id, s.title, s.subject, s.description, s.card_count,
        s.created_at, w.added_at,
        u.username AS author_username, u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url
      FROM workspace_sets w
      JOIN flashcard_sets s ON s.id = w.flashcard_set_id
      JOIN users u ON u.id = s.author_id
      WHERE w.user_id = ?
      ORDER BY w.added_at DESC
    `).bind(user.id).all();

    return json({
      sets: (rows.results || []).map(row => ({
        id: row.id,
        title: row.title,
        subject: row.subject,
        description: row.description,
        cardCount: row.card_count,
        createdAt: row.created_at,
        addedAt: row.added_at,
        author: {
          username: row.author_username,
          displayName: row.author_display_name,
          avatarUrl: row.author_avatar_url
        }
      }))
    }, 200, origin);
  }

  if (request.method === 'POST' && pathParts.length === 2) {
    const setId = pathParts[1];
    const set = await db.prepare('SELECT id FROM flashcard_sets WHERE id = ? AND visibility = \'public\'').bind(setId).first();
    if (!set) return errorResponse('Public flashcard set not found.', 404, origin);

    await db.prepare(`
      INSERT INTO workspace_sets (user_id, flashcard_set_id)
      VALUES (?, ?)
      ON CONFLICT(user_id, flashcard_set_id) DO NOTHING
    `).bind(user.id, setId).run();

    return json({ ok: true, flashcardSetId: setId }, 200, origin);
  }

  if (request.method === 'DELETE' && pathParts.length === 2) {
    await db.prepare(
      'DELETE FROM workspace_sets WHERE user_id = ? AND flashcard_set_id = ?'
    ).bind(user.id, pathParts[1]).run();
    return json({ ok: true }, 200, origin);
  }

  return errorResponse('Method not allowed.', 405, origin);
}

export async function handleCommunity(request, env, origin) {
  if (!env.DB) return errorResponse('Cloudflare D1 binding DB is not configured.', 500, origin);

  const db = env.DB;
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/api/auth/session') {
    if (request.method !== 'POST') return errorResponse('Method not allowed.', 405, origin);
    return createAnonymousSession(request, env, db, origin);
  }

  if (url.pathname === '/api/users/me') {
    return handleProfile(request, env, db, origin);
  }

  if (url.pathname === '/api/users/check-username') {
    return handleUsernameAvailability(request, env, db, origin);
  }

  if (parts[0] === 'api' && parts[1] === 'flashcards') {
    return handleFlashcardSets(request, env, db, origin, parts.slice(2));
  }

  if (parts[0] === 'api' && parts[1] === 'workspace') {
    return handleWorkspace(request, env, db, origin, parts.slice(2));
  }

  return null;
}
