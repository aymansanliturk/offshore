// Cloudflare Pages Function — functions/api/digest.js
//
// Two-pass strategy to handle "limit: 0" search grounding quota:
//   Pass 1 — call Gemini WITH Google Search tool (real-time data)
//   Pass 2 — call Gemini WITHOUT search tool (AI knowledge fallback)
//
// Each pass tries every model in MODELS in order until one succeeds.
// Any non-200 from a model skips to the next; only when every model
// in a pass fails does we move to the next pass.

const MODELS = [
  'gemini-2.5-flash',   // preferred — newest
  'gemini-2.0-flash',   // stable fallback
  'gemini-1.5-flash',   // last resort
];

// ── Prompts ───────────────────────────────────────────────────────────────────

const SEARCH_PROMPT = `
Search for the latest news from the past 48 hours about offshore wind energy in Denmark.
Scan English, Danish, German, and Dutch sources.
Categorize each item into exactly one of: infrastructure, legislation, approvals, projects.
For every item include: a concise title, a 2–3 sentence summary, the source publication name, and the article URL.
IMPORTANT: All output — titles, summaries, and source names — must be in English regardless of the original language.
Return today's date as the "date" field (format: Month DD, YYYY — e.g. "April 13, 2026").
Return valid JSON only. No markdown, no prose outside the JSON.
`.trim();

const FALLBACK_PROMPT = `
You are a senior offshore wind energy analyst. Based solely on your training knowledge, produce a structured briefing on Danish offshore wind developments.
Cover all four areas: infrastructure (construction & planning), legislation (policy & regulation), approvals (permits & consents), projects (announcements & progress).
For every item include: a concise title, a 2–3 sentence summary, the source or organisation name, and a URL if you know one (empty string if not).
IMPORTANT: All output — titles, summaries, and source names — must be in English regardless of the original language.
Return today's date as the "date" field (format: Month DD, YYYY — e.g. "${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}").
Return valid JSON only. No markdown, no prose outside the JSON.
`.trim();

// ── Schema ────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 *
 * Any non-200 response skips to the next model.
 * This means a 429 on search quota will fall through to the next model
 * (different quota bucket), and if all models fail, to Pass 2 (no search).
 *
 * Returns one of:
 *   { type: 'success', text, model }
 *   { type: 'quota',   retryAfter }  — every model returned 429
 *   { type: 'skip',    reason }      — every model returned other non-2xx
 */
async function tryModels(requestBody, apiKey) {
  let maxRetryAfter = null;
  const reasons = [];

  for (const model of MODELS) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      reasons.push(`${model}: network error (${err.message})`);
      continue;
    }

    if (!res.ok) {
      if (res.status === 429) {
        const after = parseInt(res.headers.get('Retry-After') || '60', 10);
        if (maxRetryAfter === null || after > maxRetryAfter) maxRetryAfter = after;
      }
      reasons.push(`${model}: HTTP ${res.status}`);
      continue;
    }

    const result = await res.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      reasons.push(`${model}: empty response`);
      continue;
    }

    return { type: 'success', text, model };
  }

  if (maxRetryAfter !== null) return { type: 'quota', retryAfter: maxRetryAfter };
  return { type: 'skip', reason: reasons.join('; ') };
}

/**
 * Parse Gemini's JSON text, inject isFallback, and return a Response.
 * isFallback is included in the body (not just a header) so it survives
 * localStorage caching and is available without re-fetching.
 */
function respond(geminiText, isFallback, model) {
  try {
    const data = JSON.parse(geminiText);
    data.isFallback = isFallback;
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'X-Model-Used': model,
      },
    });
  } catch {
    return jsonResponse(
      { error: 'Failed to parse Gemini response. The model may have returned malformed JSON.' },
      502,
    );
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const API_KEY = context.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return jsonResponse({
      error: 'GEMINI_API_KEY is not set. Add it in Cloudflare Dashboard → Pages project → Settings → Environment Variables.',
    }, 500);
  }

  // Pass 1: real-time data via Google Search grounding.
  const pass1 = await tryModels(buildBody(SEARCH_PROMPT, true), API_KEY);

  if (pass1.type === 'success') {
    return respond(pass1.text, false, pass1.model);
  }

  // Pass 1 blocked (search quota limit:0, 400, 404, or 5xx on all models).
  // Pass 2: AI knowledge — no search tool, higher chance of success.
  const pass2 = await tryModels(buildBody(FALLBACK_PROMPT, false), API_KEY);

  if (pass2.type === 'success') {
    return respond(pass2.text, true, pass2.model);
  }

  // Both passes exhausted — base model quota is also depleted.
  if (pass2.type === 'quota') {
    return jsonResponse({
      error: 'All Gemini models are temporarily quota-exhausted. Please try again shortly.',
      retryAfter: pass2.retryAfter,
    }, 429);
  }

  return jsonResponse({
    error: `No working Gemini model found. Details: ${pass2.reason}`,
  }, 502);
}
