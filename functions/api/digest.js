export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;
  const MODEL = 'gemini-1.5-flash';

  if (!API_KEY) {
    return json({ error: 'GEMINI_API_KEY is not configured. Set it in Cloudflare Dashboard → Settings → Environment Variables.' }, 500);
  }

  const prompt = `Search for the latest news (last 48 hours) about offshore wind energy in Denmark.
Scan English, Danish, German, and Dutch sources thoroughly.
Categorize every relevant item into exactly one of: infrastructure, legislation, approvals, projects.
For each item provide: a concise title, a 2–3 sentence summary in English, the source publication name, and the article URL.
Return today's date as the "date" field (ISO format: YYYY-MM-DD).
Return the response in the requested JSON format only — no markdown, no commentary.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

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

  const body = {
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

  try {
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (geminiRes.status === 429) {
      const retryAfter = parseInt(geminiRes.headers.get('Retry-After') || '60', 10);
      const errBody = await geminiRes.text();
      return json({ error: 'Gemini quota exceeded — free-tier rate limit reached.', details: errBody, retryAfter }, 429);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return json({ error: `Gemini API error ${geminiRes.status}`, details: errText }, 502);
    }

    const result = await geminiRes.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return json({ error: 'Gemini returned an empty response. The model may have been blocked or quota exceeded.' }, 502);
    }

    // text is already a JSON string matching our schema — return it directly.
    return new Response(text, {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return json({ error: `Function error: ${err.message}` }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
