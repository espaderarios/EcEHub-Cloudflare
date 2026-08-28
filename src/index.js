import { getDocumentProxy } from 'unpdf';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_AUTO_SCAN_PAGES = 120;
const MAX_CHAPTER_PAGES = 80;
const MAX_SOURCE_CHARS = 18000;
const MAX_INSTRUCTIONS_CHARS = 800;
const MAX_CHAPTER_QUERY_CHARS = 120;
const MAX_CARD_COUNT = 20;
const MAX_OUTPUT_TOKENS = 700;

const ALLOWED_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function json(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization'
    }
  });
}

function corsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const configured = String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  if (!origin || !configured.length) return '*';
  return configured.includes(origin) ? origin : null;
}

function errorResponse(message, status = 500, origin = '*', extra = {}) {
  return json({ error: message, ...extra }, status, origin);
}

function extractDriveFileId(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    throw Object.assign(new Error('Invalid Google Drive URL.'), { statusCode: 400 });
  }

  const allowedHosts = new Set([
    'drive.google.com',
    'www.drive.google.com',
    'docs.google.com',
    'drive.usercontent.google.com'
  ]);

  if (!allowedHosts.has(url.hostname)) {
    throw Object.assign(
      new Error('Only Google Drive PDF links are supported.'),
      { statusCode: 400 }
    );
  }

  const pathMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const queryId = url.searchParams.get('id');
  if (queryId) return queryId;

  throw Object.assign(
    new Error('Could not find a Google Drive file ID in the supplied URL.'),
    { statusCode: 400 }
  );
}

async function downloadGoogleDrivePdf(inputUrl) {
  const fileId = extractDriveFileId(inputUrl);
  const urls = [
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
  ];

  let lastError;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'EcE-Hub-Cloudflare-Worker/1.0' }
      });

      if (!response.ok) {
        throw new Error(`Google Drive returned HTTP ${response.status}.`);
      }

      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_PDF_BYTES) {
        throw Object.assign(
          new Error('PDF is too large. Maximum allowed size is 50 MB.'),
          { statusCode: 413 }
        );
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_PDF_BYTES) {
        throw Object.assign(
          new Error('PDF is too large. Maximum allowed size is 50 MB.'),
          { statusCode: 413 }
        );
      }

      const header = new TextDecoder().decode(buffer.slice(0, 5));
      if (header !== '%PDF-') {
        throw new Error(
          'Google Drive did not return a PDF. Make sure the file is shared so anyone with the link can view it.'
        );
      }

      return new Uint8Array(buffer);
    } catch (error) {
      lastError = error;
      console.warn('Drive download failed:', error.message);
    }
  }

  throw lastError || new Error('Unable to download the Google Drive PDF.');
}

function normalizePageText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseRequestedChapter(chapters) {
  const value = String(chapters).trim();
  const match = value.match(/(?:chapter\s*)?(\d{1,3})/i);
  return match ? Number(match[1]) : null;
}

function parseChapterHeading(text) {
  const normalized = normalizePageText(text);
  const firstLines = normalized.split('\n').slice(0, 18).join('\n');

  let match = firstLines.match(/(?:^|\n)\s*chapter\s+(\d{1,3})\b/i);
  if (match) return Number(match[1]);

  match = firstLines.match(/(?:^|\n)\s*chapter\s+([ivxlcdm]+)\b/i);
  if (!match) return null;

  const roman = match[1].toUpperCase();
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;

  for (let i = 0; i < roman.length; i++) {
    const current = values[roman[i]] || 0;
    const next = values[roman[i + 1]] || 0;
    total += current < next ? -current : current;
  }

  return total;
}

function parsePageRange(value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'object' && value !== null) {
    const start = Number(value.start ?? value.startPage ?? value.from);
    const end = Number(value.end ?? value.endPage ?? value.to);

    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) {
      return { startPage: start, endPage: end };
    }

    return null;
  }

  const match = String(value).trim().match(/^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/i);
  if (!match) return null;

  const startPage = Number(match[1]);
  const endPage = Number(match[2]);

  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
    return null;
  }

  return { startPage, endPage };
}

function parseExplicitPageRange(body) {
  return (
    parsePageRange(body.chapterPages) ||
    parsePageRange(body.pageRange) ||
    parsePageRange({
      start: body.chapterStartPage,
      end: body.chapterEndPage
    })
  );
}

async function getPageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();

  return normalizePageText(
    content.items
      .map(item => item?.str || '')
      .join(' ')
  );
}

async function locateChapterPages(pdf, requestedChapter) {
  const pageCount = pdf.numPages;
  const scanLimit = Math.min(pageCount, MAX_AUTO_SCAN_PAGES);

  for (let pageNumber = 1; pageNumber <= scanLimit; pageNumber++) {
    const pageText = await getPageText(pdf, pageNumber);
    const chapterNumber = parseChapterHeading(pageText);

    if (chapterNumber === requestedChapter) {
      let endPage = Math.min(pageCount, pageNumber + MAX_CHAPTER_PAGES - 1);

      // Search only within the maximum chapter extraction window. This avoids
      // walking hundreds of pages after the requested chapter is found.
      for (let nextPage = pageNumber + 1; nextPage <= endPage; nextPage++) {
        const nextText = await getPageText(pdf, nextPage);
        const nextChapter = parseChapterHeading(nextText);

        if (nextChapter !== null && nextChapter !== requestedChapter) {
          endPage = nextPage - 1;
          break;
        }
      }

      return {
        startPage: pageNumber,
        endPage,
        pageCount: endPage - pageNumber + 1,
        detection: 'automatic'
      };
    }
  }

  return null;
}

async function extractSelectedPages(pdf, startPage, endPage) {
  const pageCount = pdf.numPages;

  if (startPage < 1 || startPage > pageCount) {
    throw Object.assign(
      new Error(`Chapter start page ${startPage} is outside the PDF (1-${pageCount}).`),
      { statusCode: 400 }
    );
  }

  if (endPage < startPage) {
    throw Object.assign(new Error('Chapter end page must be greater than or equal to the start page.'), {
      statusCode: 400
    });
  }

  const actualEnd = Math.min(endPage, startPage + MAX_CHAPTER_PAGES - 1, pageCount);
  const pages = [];

  for (let pageNumber = startPage; pageNumber <= actualEnd; pageNumber++) {
    const text = await getPageText(pdf, pageNumber);
    if (text) pages.push(`[PDF page ${pageNumber}]\n${text}`);
  }

  let combined = pages.join('\n\n');
  let truncatedText = false;

  if (combined.length > MAX_SOURCE_CHARS) {
    combined = combined.slice(0, MAX_SOURCE_CHARS) +
      '\n\n[Chapter text truncated by the AI backend.]';
    truncatedText = true;
  }

  return {
    text: combined,
    pages: pages.length,
    startPage,
    endPage: actualEnd,
    truncatedPages: endPage > actualEnd,
    truncatedText
  };
}

async function extractChapterText(pdfBytes, chapterQuery, explicitRange = null) {
  const pdf = await getDocumentProxy(pdfBytes);
  const requestedNumber = parseRequestedChapter(chapterQuery);

  if (requestedNumber === null) {
    throw Object.assign(
      new Error('Please specify a chapter number, for example "Chapter 1".'),
      { statusCode: 400 }
    );
  }

  let location;

  if (explicitRange) {
    if (explicitRange.startPage > pdf.numPages || explicitRange.endPage > pdf.numPages) {
      throw Object.assign(
        new Error(`The requested chapter pages ${explicitRange.startPage}-${explicitRange.endPage} exceed this PDF's ${pdf.numPages} pages.`),
        { statusCode: 400 }
      );
    }

    location = {
      ...explicitRange,
      detection: 'explicit'
    };
  } else {
    location = await locateChapterPages(pdf, requestedNumber);
  }

  if (!location) {
    throw Object.assign(
      new Error(
        `Could not automatically locate Chapter ${requestedNumber} within the first ${MAX_AUTO_SCAN_PAGES} PDF pages. Provide chapterStartPage/chapterEndPage (or chapterPages: "start-end") so the Worker can extract the chapter directly without scanning the entire textbook.`
      ),
      { statusCode: 422 }
    );
  }

  const extracted = await extractSelectedPages(
    pdf,
    location.startPage,
    location.endPage
  );

  return {
    ...extracted,
    detectedChapter: requestedNumber,
    totalPdfPages: pdf.numPages,
    chapterStartPage: location.startPage,
    chapterEndPage: location.endPage,
    detection: location.detection
  };
}

function buildPrompt({ text, chapters, cardCount, difficulty, instructions }) {
  return `You are EcE Hub's flashcard specialist. Create high-quality study flashcards ONLY from the supplied textbook chapter excerpt.

Requested chapter: ${chapters}
Difficulty: ${difficulty}
Number of cards: ${cardCount}
Additional instructions: ${instructions || 'None'}

Rules:
- Stay strictly inside the supplied chapter excerpt.
- Do not invent facts, examples, formulas, definitions, or terminology.
- Questions must test meaningful concepts, not trivial wording.
- Answers must be concise but complete enough to study from.
- Avoid duplicate questions.
- Prefer definitions, principles, relationships, formulas, mechanisms, and important distinctions.
- Match the requested difficulty.
- Return valid JSON only.

JSON format:
{
  "title": "Chapter title",
  "subject": "Electronics Engineering",
  "description": "Short description",
  "cards": [
    {"question":"...","answer":"..."}
  ]
}

SOURCE EXCERPT:
${text}`;
}

async function generateFlashcards(env, args) {
  if (!env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured in Cloudflare.');
  }

  const prompt = buildPrompt(args);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: 'You produce accurate educational flashcards from supplied source text and return JSON only.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: Math.min(MAX_OUTPUT_TOKENS, 150 + args.cardCount * 90),
      response_format: { type: 'json_object' }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data?.error?.message || `Groq returned HTTP ${response.status}.`;
    throw Object.assign(
      new Error(message),
      { statusCode: response.status === 429 || response.status === 413 ? 429 : 502 }
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned an empty response.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI returned invalid JSON.');
  }

  const cards = Array.isArray(parsed.cards)
    ? parsed.cards
        .map(card => ({
          question: String(card?.question || '').trim(),
          answer: String(card?.answer || '').trim()
        }))
        .filter(card => card.question && card.answer)
        .slice(0, args.cardCount)
    : [];

  if (!cards.length) throw new Error('AI did not generate any usable flashcards.');

  return {
    title: String(parsed.title || args.chapters || 'AI Generated Flashcards').trim(),
    subject: String(parsed.subject || 'Electronics Engineering').trim(),
    description: String(parsed.description || `Flashcards generated from ${args.chapters}.`).trim(),
    cards
  };
}

async function handleFlashcards(request, env, origin) {
  if (request.method !== 'POST') return errorResponse('Method not allowed.', 405, origin);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Request body must be valid JSON.', 400, origin);
  }

  const driveUrl = String(body.driveUrl || '').trim();
  const chapters = String(body.chapters || '').trim().slice(0, MAX_CHAPTER_QUERY_CHARS);
  const instructions = String(body.instructions || '').trim().slice(0, MAX_INSTRUCTIONS_CHARS);
  const cardCount = Number(body.cardCount || 20);
  const difficulty = String(body.difficulty || 'medium').toLowerCase();
  const explicitPageRange = parseExplicitPageRange(body);

  if (!driveUrl) return errorResponse('driveUrl is required.', 400, origin);
  if (!chapters) return errorResponse('chapters is required.', 400, origin);
  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > MAX_CARD_COUNT) {
    return errorResponse(`cardCount must be an integer from 1 to ${MAX_CARD_COUNT}.`, 400, origin);
  }
  if (!ALLOWED_DIFFICULTIES.has(difficulty)) {
    return errorResponse('difficulty must be easy, medium, or hard.', 400, origin);
  }

  const hasPartialPageInput =
    body.chapterStartPage !== undefined ||
    body.chapterEndPage !== undefined;

  if (hasPartialPageInput && !explicitPageRange) {
    return errorResponse(
      'Both chapterStartPage and chapterEndPage must be valid page numbers, or provide chapterPages as "start-end".',
      400,
      origin
    );
  }

  console.log('AI flashcard request', {
    chapters,
    cardCount,
    difficulty,
    explicitPageRange
  });

  const pdfBytes = await downloadGoogleDrivePdf(driveUrl);
  const extracted = await extractChapterText(pdfBytes, chapters, explicitPageRange);

  if (!extracted.text.trim()) {
    return errorResponse('No extractable text was found in the requested chapter pages.', 422, origin);
  }

  console.log('Chapter-specific extraction', {
    requestedChapter: extracted.detectedChapter,
    totalPdfPages: extracted.totalPdfPages,
    chapterStartPage: extracted.chapterStartPage,
    chapterEndPage: extracted.chapterEndPage,
    extractedPages: extracted.pages,
    extractedChars: extracted.text.length,
    truncatedPages: extracted.truncatedPages,
    truncatedText: extracted.truncatedText,
    detection: extracted.detection
  });

  const result = await generateFlashcards(env, {
    text: extracted.text,
    chapters,
    cardCount,
    difficulty,
    instructions
  });

  return json({
    ...result,
    source: {
      requestedChapter: extracted.detectedChapter,
      pdfPages: extracted.totalPdfPages,
      chapterPages: `${extracted.chapterStartPage}-${extracted.chapterEndPage}`,
      extractedPages: extracted.pages,
      truncated: extracted.truncatedPages || extracted.truncatedText,
      detection: extracted.detection
    }
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = corsOrigin(request, env);

    if (origin === null) {
      return errorResponse('CORS origin not allowed.', 403, '*');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'Content-Type, Authorization'
        }
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({
          ok: true,
          service: 'ecehub-ai-cloudflare-worker',
          chapterExtraction: {
            automaticScanLimit: MAX_AUTO_SCAN_PAGES,
            maxChapterPages: MAX_CHAPTER_PAGES,
            maxSourceChars: MAX_SOURCE_CHARS
          }
        }, 200, origin);
      }

      if (url.pathname === '/api/ai/flashcards/generate') {
        return await handleFlashcards(request, env, origin);
      }

      return errorResponse('Not found.', 404, origin);
    } catch (error) {
      console.error('Worker error:', error);
      return errorResponse(
        error.message || 'Internal server error.',
        error.statusCode || 500,
        origin
      );
    }
  }
};
