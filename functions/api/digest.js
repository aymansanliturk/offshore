// Models tried in order. First one that isn't a 404 wins.
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
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

  let lastError = null;

  for (const model of MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      // 404 = model not available on this API key — try the next one.
      if (geminiRes.status === 404) {
        lastError = `Model ${model} not available (404)`;
        continue;
      }

      // 429 = quota exceeded — surface immediately, no point trying other models.
      if (geminiRes.status === 429) {
        const retryAfter = parseInt(geminiRes.headers.get('Retry-After') || '60', 10);
        const errBody = await geminiRes.text();
        return json({ error: `Quota exceeded on ${model} — free-tier rate limit reached.`, details: errBody, retryAfter }, 429);
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

  // All models returned 404.
  return json({ error: `No available Gemini model found. Tried: ${MODELS.join(', ')}. Details: ${lastError}` }, 502);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
