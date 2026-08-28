# EcE Hub AI Cloudflare Worker

This Worker replaces the Render Express service for AI flashcard generation.

## What it does

`POST /api/ai/flashcards/generate`

1. Accepts the Google Drive PDF URL from EcE Hub.
2. Downloads the PDF server-side.
3. Extracts PDF text with `unpdf`, which supports Cloudflare Workers.
4. Detects the requested chapter and extracts only that chapter's pages when possible.
5. Caps the source sent to Groq at 18,000 characters.
6. Caps generated cards at 20 per request and model output at 700 tokens.
7. Uses Groq JSON mode and returns the same `{ title, subject, description, cards }` structure expected by the frontend.

## Cloudflare setup

From this directory:

```powershell
npm.cmd install
npx.cmd wrangler login
npx.cmd wrangler secret put GROQ_API_KEY
npx.cmd wrangler secret put FRONTEND_ORIGIN
npx.cmd wrangler deploy
```

For `FRONTEND_ORIGIN`, use the exact frontend origin, for example:

```text
https://espaderarios.github.io
```

Optional model variable:

```powershell
npx.cmd wrangler secret put GROQ_MODEL
```

Recommended value:

```text
openai/gpt-oss-120b
```

The Worker also accepts the model through a normal Worker environment variable if configured in the Cloudflare dashboard.

## Local development

```powershell
npm.cmd install
npx.cmd wrangler dev
```

Then test:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:8787/api/ai/flashcards/generate" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"driveUrl":"YOUR_DRIVE_URL","chapters":"Chapter 1","cardCount":1,"difficulty":"medium","instructions":"Focus on important concepts."}'
```

## Important Cloudflare plan note

PDF.js extraction is CPU work. Cloudflare Workers Free has a 10 ms CPU limit per invocation, while Workers Paid supports substantially longer CPU execution. For real PDF parsing, use a Workers Paid plan rather than relying on the Free CPU limit.
