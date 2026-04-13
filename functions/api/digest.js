// Models tried in order. First successful response wins.
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

const SEARCH_PROMPT = `Search for the latest news (last 48 hours) about offshore wind energy in Denmark.
Scan English, Danish, German, and Dutch sources thoroughly.
Categorize every relevant item into exactly one of: infrastructure, legislation, approvals, projects.
For each item provide: a concise title, a 2–3 sentence summary, the source publication name, and the article URL.
IMPORTANT: All titles, summaries, and source names must be written in English regardless of the original source language.
Return today's date as the "date" field (ISO format: YYYY-MM-DD).
Return the response in the requested JSON format only — no markdown, no commentary.`;

const FALLBACK_PROMPT = `You are an offshore wind energy analyst. Based on your training knowledge, provide a structured report on Danish offshore wind energy developments. Cover: infrastructure construction and planning, legislation and policy, regulatory approvals, and notable projects.
For each item provide a concise title, a 2–3 sentence summary, the source or organisation name, and a URL if known (otherwise leave it empty).
IMPORTANT: All titles, summaries, and source names must be written in English regardless of the original source language.
Return today's date (${new Date().toISOString().slice(0, 10)}) as the "date" field.
Return the response in the requested JSON format only — no markdown, no commentary.`;

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title:   { type: 'STRING' },
    summary: { type: 'STRING' },
    source:  { type: 'STRING' },
    url:     { type: 'STRING' },
  },
  required: ['title', 'summary', 'source', 'url'],
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date:           { type: 'STRING' },
    infrastructure: { type: 'ARRAY', items: ITEM_SCHEMA },
    legislation:    { type: 'ARRAY', items: ITEM_SCHEMA },
    approvals:      { type: 'ARRAY', items: ITEM_SCHEMA },
    projects:       { type: 'ARRAY', items: ITEM_SCHEMA },
  },
  required: ['date', 'infrastructure', 'legislation', 'approvals', 'projects'],
};

function buildBody(prompt, useSearch) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
  if (useSearch) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * Try every model in MODELS with the given request body.
 * Any non-200 response skips to the next model — this lets Pass 1 (with
 * search) fall through entirely to Pass 2 (without search) on any error,
 * whether it's a quota limit (429), unsupported feature (400), model
 * unavailable (404), or a transient server error (503).
 *
 * Returns:
 *   { type: 'success', text, model }
 *   { type: 'quota',   retryAfter }   — all models returned 429
 *   { type: 'skip',    reason }       — all models returned other non-2xx
 */
async function tryModels(requestBody, apiKey) {
  let quotaRetryAfter = null;
  const skipReasons = [];

  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      skipReasons.push(`${model} (network error: ${err.message})`);
      continue;
    }

    if (!res.ok) {
      // Track the longest Retry-After seen across any 429.
      if (res.status === 429) {
        const after = parseInt(res.headers.get('Retry-After') || '60', 10);
        if (quotaRetryAfter === null || after > quotaRetryAfter) quotaRetryAfter = after;
      }
      skipReasons.push(`${model} (HTTP ${res.status})`);
      continue;
    }

    const result = await res.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      skipReasons.push(`${model} (empty response)`);
      continue;
    }

    return { type: 'success', text, model };
  }

  if (quotaRetryAfter !== null) return { type: 'quota', retryAfter: quotaRetryAfter };
  return { type: 'skip', reason: skipReasons.join('; ') };
}

export async function onRequest(context) {
  const API_KEY = context.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return json({ error: 'GEMINI_API_KEY is not configured. Set it in Cloudflare Dashboard → Settings → Environment Variables.' }, 500);
  }

  // ── Pass 1: with Google Search grounding ─────────────────────────────────
  const searchResult = await tryModels(buildBody(SEARCH_PROMPT, true), API_KEY);

  if (searchResult.type === 'success') {
    return respond(searchResult.text, false, searchResult.model);
  }

  // Pass 1 fully blocked (any combination of 400/404/429/5xx across all models).
  // ── Pass 2: AI knowledge fallback — no search tool ───────────────────────
  const fallbackResult = await tryModels(buildBody(FALLBACK_PROMPT, false), API_KEY);

  if (fallbackResult.type === 'success') {
    return respond(fallbackResult.text, true, fallbackResult.model);
  }

  // Both passes exhausted — all models are quota-limited.
  if (fallbackResult.type === 'quota') {
    return json({
      error: 'All Gemini models are quota-exhausted. Please wait before retrying.',
      retryAfter: fallbackResult.retryAfter,
    }, 429);
  }

  return json({ error: `No working Gemini model found. ${fallbackResult.reason}` }, 502);
}

/** Inject isFallback into the Gemini JSON text and return a Response. */
function respond(geminiText, isFallback, model) {
  try {
    const data = JSON.parse(geminiText);
    data.isFallback = isFallback;
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'X-Model-Used': model,
        'X-Search-Status': isFallback ? 'disabled' : 'enabled',
      },
    });
  } catch {
    // Extremely unlikely — schema-enforced response should always be valid JSON.
    return json({ error: 'Failed to parse Gemini response as JSON.' }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
