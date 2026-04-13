// Models tried in order. First successful response wins.
// 400/404 → model unavailable/incompatible, skip to next.
// 429 → quota exhausted on this model, skip to next (each model has its own quota).
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;

  if (!API_KEY) {
    return json({ error: 'GEMINI_API_KEY is not configured. Set it in Cloudflare Dashboard → Settings → Environment Variables.' }, 500);
  }

  const prompt = `Search for the latest news (last 48 hours) about offshore wind energy in Denmark.
Scan English, Danish, German, and Dutch sources thoroughly.
Categorize every relevant item into exactly one of: infrastructure, legislation, approvals, projects.
For each item provide: a concise title, a 2–3 sentence summary in English, the source publication name, and the article URL.
Return today's date as the "date" field (ISO format: YYYY-MM-DD).
Return the response in the requested JSON format only — no markdown, no commentary.`;

  const itemSchema = {
    type: 'OBJECT',
    properties: {
      title:   { type: 'STRING' },
      summary: { type: 'STRING' },
      source:  { type: 'STRING' },
      url:     { type: 'STRING' },
    },
    required: ['title', 'summary', 'source', 'url'],
  };

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          date:           { type: 'STRING' },
          infrastructure: { type: 'ARRAY', items: itemSchema },
          legislation:    { type: 'ARRAY', items: itemSchema },
          approvals:      { type: 'ARRAY', items: itemSchema },
          projects:       { type: 'ARRAY', items: itemSchema },
        },
        required: ['date', 'infrastructure', 'legislation', 'approvals', 'projects'],
      },
    },
  };

  let lastSkipReason = null;
  let quotaRetryAfter = null; // set if any model returned 429

  for (const model of MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      // 400 = model exists but rejects this request body
      //       (e.g. google_search + responseSchema not supported together).
      // 404 = model not available on this API key.
      // Either way: try the next model.
      if (geminiRes.status === 400 || geminiRes.status === 404) {
        const errText = await geminiRes.text();
        lastSkipReason = `${model} skipped (HTTP ${geminiRes.status})`;
        continue;
      }

      // 429 = quota exhausted on this model. Each model has its own free-tier
      // quota, so try the next one — only give up when all are exhausted.
      if (geminiRes.status === 429) {
        const retryAfter = parseInt(geminiRes.headers.get('Retry-After') || '60', 10);
        if (quotaRetryAfter === null || retryAfter > quotaRetryAfter) {
          quotaRetryAfter = retryAfter; // track the longest wait needed
        }
        lastSkipReason = `${model} quota exhausted (429)`;
        continue;
      }

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return json({ error: `Gemini API error ${geminiRes.status} on model ${model}`, details: errText }, 502);
      }

      const result = await geminiRes.json();
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        return json({ error: `${model} returned an empty response. The model may be blocked or quota exceeded.` }, 502);
      }

      // Return the JSON string directly — it already matches our schema.
      return new Response(text, {
        headers: { 'Content-Type': 'application/json', 'X-Model-Used': model },
      });

    } catch (err) {
      return json({ error: `Function error calling ${model}: ${err.message}` }, 500);
    }
  }

  // All models were skipped. If any returned 429, tell the frontend to retry.
  if (quotaRetryAfter !== null) {
    return json({
      error: `All models quota-exhausted. Tried: ${MODELS.join(', ')}.`,
      retryAfter: quotaRetryAfter,
    }, 429);
  }

  return json({ error: `No working Gemini model found. Tried: ${MODELS.join(', ')}. Last reason: ${lastSkipReason}` }, 502);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
