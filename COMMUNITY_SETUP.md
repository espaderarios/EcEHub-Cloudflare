# EcE Hub Community Flashcards

This adds the first backend layer for public/community flashcards, user profiles, unique usernames, workspace references, sharing IDs, and search using Cloudflare D1.

## 1. Create the D1 database

From the repository root:

```powershell
npx.cmd wrangler d1 create ecehub-community
```

Cloudflare will return a `database_id`. Put that ID into `wrangler.community.jsonc` in place of:

```text
REPLACE_WITH_D1_DATABASE_ID
```

## 2. Create the session secret

The community Worker uses a signed, HttpOnly cookie for its current browser session.

```powershell
npx.cmd wrangler secret put SESSION_SECRET --config wrangler.community.jsonc
```

Use a long random value. Do not commit it to Git.

## 3. Configure the frontend origin

```powershell
npx.cmd wrangler secret put FRONTEND_ORIGIN --config wrangler.community.jsonc
```

For local development this can be the exact frontend origin, for example:

```text
http://127.0.0.1:5500
```

For production, use the actual EcE Hub frontend origin.

## 4. Apply the migration

For the deployed D1 database:

```powershell
npx.cmd wrangler d1 migrations apply ecehub-community --remote --config wrangler.community.jsonc
```

For local development:

```powershell
npx.cmd wrangler d1 migrations apply ecehub-community --local --config wrangler.community.jsonc
```

## 5. Deploy the community Worker

```powershell
npx.cmd wrangler deploy --config wrangler.community.jsonc
```

The existing AI Worker remains separate. This keeps community CRUD independent from Groq and the AI generation workload.

## API

### Session

`POST /api/auth/session`

Creates or restores the browser's EcE Hub community identity.

### Profile

`GET /api/users/me`

`PATCH /api/users/me`

Example:

```json
{
  "username": "espaderos",
  "displayName": "Rosario Espadera",
  "avatarUrl": "https://example.com/avatar.jpg",
  "bio": "Electronics Engineering student"
}
```

`GET /api/users/check-username?username=espaderos`

The database also enforces `UNIQUE` username semantics, so a race between two clients cannot create duplicate usernames.

### Public flashcards

`GET /api/flashcards`

`GET /api/flashcards?q=semiconductor`

`GET /api/flashcards?subject=Electronics%20Engineering`

`GET /api/flashcards/:id`

### Create a set

`POST /api/flashcards`

```json
{
  "title": "Chapter 1 Flashcards",
  "subject": "Electronics Engineering",
  "description": "Important concepts from Chapter 1.",
  "visibility": "public",
  "cards": [
    {
      "question": "What is a semiconductor?",
      "answer": "A material whose electrical conductivity lies between that of a conductor and an insulator."
    }
  ]
}
```

### Edit/delete

`PATCH /api/flashcards/:id`

`DELETE /api/flashcards/:id`

Only the author can modify or delete the set.

### Workspace

`GET /api/workspace`

`POST /api/workspace/:flashcardSetId`

`DELETE /api/workspace/:flashcardSetId`

Adding a community set stores a relationship in `workspace_sets`; it does not duplicate the original set.

## Identity note

The first implementation uses a signed 30-day browser session rather than email/password or OAuth. This gives the frontend a real server-side identity and makes username ownership enforceable in D1, while keeping the project simple during the first rollout. A full account/authentication provider can be added later without changing the flashcard schema.

## Storage note

Flashcard text and profile metadata are stored in D1. `avatarUrl` is currently URL-based. If users need actual image uploads, the next storage layer should be Cloudflare R2 rather than putting image binaries into D1.
