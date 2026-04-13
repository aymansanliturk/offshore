// Models tried in order. First successful response wins.
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

const SEARCH_PROMPT = `Search for the latest news (last 48 hours) about offshore wind energy in Denmark.
Scan English, Danish, German, and Dutch sources thoroughly.
Categorize every relevant item into exactly one of: infrastructure, legislation, approvals, projects.
For each item provide: a concise title, a 2–3 sentence summary in English, the source publication name, and the article URL.
Return today's date as the "date" field (ISO format: YYYY-MM-DD).
Return the response in the requested JSON format only — no markdown, no commentary.`;

const FALLBACK_PROMPT = `You are an offshore wind energy analyst. Based on your training knowledge, provide a structured summary of Danish offshore wind energy developments. Cover: infrastructure construction and planning, legislation and policy, regulatory approvals, and notable projects. For each item provide a concise title, a 2–3 sentence summary in English, the source or organisation name, and a URL if you know one (otherwise leave it empty). Return today's date (${new Date().toISOString().slice(0, 10)}) as the "date" field. Return the response in the requested JSON format only.`;

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
 * Returns:
 *   { type: 'success', text, model }
 *   { type: 'quota',   retryAfter }
 *   { type: 'skip',    reason }      — all models were 400/404
 *   { type: 'error',   status, message }
 */
async function tryModels(requestBody, apiKey) {
  let quotaRetryAfter = null;
  let skipReasons = [];

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
      return { type: 'error', status: 500, message: `Network error on ${model}: ${err.message}` };
    }

    // 400/404 — model unavailable or doesn't support this feature combo. Try next.
    if (res.status === 400 || res.status === 404) {
      skipReasons.push(`${model} (HTTP ${res.status})`);
      continue;
    }

    // 429 — quota on this model. Record and try next (each model has its own quota).
    if (res.status === 429) {
      const after = parseInt(res.headers.get('Retry-After') || '60', 10);
      if (quotaRetryAfter === null || after > quotaRetryAfter) quotaRetryAfter = after;
      skipReasons.push(`${model} (429 quota)`);
      continue;
    }

    // Any other non-OK response is a hard error — surface it immediately.
    if (!res.ok) {
      const errText = await res.text();
      return { type: 'error', status: 502, message: `Gemini API error ${res.status} on ${model}: ${errText}` };
    }

    const result = await res.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { type: 'error', status: 502, message: `${model} returned an empty response.` };
    }

    return { type: 'success', text, model };
  }

  if (quotaRetryAfter !== null) return { type: 'quota', retryAfter: quotaRetryAfter };
  return { type: 'skip', reason: `All models skipped: ${skipReasons.join(', ')}` };
}

export async function onRequest(context) {
  const API_KEY = context.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return json({ error: 'GEMINI_API_KEY is not configured. Set it in Cloudflare Dashboard → Settings → Environment Variables.' }, 500);
  }

  // ── Pass 1: with Google Search grounding ─────────────────────────────────
  const searchResult = await tryModels(buildBody(SEARCH_PROMPT, true), API_KEY);

  if (searchResult.type === 'success') {
    return new Response(searchResult.text, {
      headers: { 'Content-Type': 'application/json', 'X-Search-Status': 'enabled', 'X-Model-Used': searchResult.model },
    });
  }

  if (searchResult.type === 'error') {
    return json({ error: searchResult.message }, searchResult.status);
  }

  // Pass 1 failed (quota or all models skipped). Try without search.
  // ── Pass 2: AI knowledge fallback (no search tool) ───────────────────────
  const fallbackResult = await tryModels(buildBody(FALLBACK_PROMPT, false), API_KEY);

  if (fallbackResult.type === 'success') {
    return new Response(fallbackResult.text, {
      headers: { 'Content-Type': 'application/json', 'X-Search-Status': 'disabled', 'X-Model-Used': fallbackResult.model },
    });
  }

  if (fallbackResult.type === 'error') {
    return json({ error: fallbackResult.message }, fallbackResult.status);
  }

  // Both passes exhausted.
  if (fallbackResult.type === 'quota') {
    return json({
      error: 'All Gemini models are quota-exhausted. Please wait before retrying.',
      retryAfter: fallbackResult.retryAfter,
    }, 429);
  }

  return json({ error: `No working Gemini model found. ${fallbackResult.reason}` }, 502);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
