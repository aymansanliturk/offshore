// /functions/api/digest.js

export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY; // Set this in Cloudflare Dashboard -> Settings -> Variables
  const MODEL = "gemini-2.5-flash-preview-09-2025";

  const prompt = `Search for the latest news (last 48h) regarding offshore wind in Denmark.
  Analyze English and Danish sources.
  Categorize into: infrastructure, legislation, approvals, projects.
  Return a JSON object with a "date" string and arrays for each category.
  Each item in arrays must have: "title", "summary" (2 sentences), "source", and "url".`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ "google_search": {} }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              date: { type: "STRING" },
              infrastructure: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } },
              legislation:    { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } },
              approvals:      { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } },
              projects:       { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } }
            }
          }
        }
      })
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Gemini API error: ${response.status}` }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const result = await response.json();
    const data = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!data) {
      return new Response(JSON.stringify({ error: "Empty response from Gemini" }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    return new Response(data, {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
