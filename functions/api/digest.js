export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;
  const MODEL = "gemini-1.5-flash"; 

  const searchPrompt = `Search for the latest news (last 48h) regarding offshore wind projects in Denmark. 
  Categorize into: infrastructure, legislation, approvals, and projects. 
  Return a strictly English JSON object.`;

  const fallbackPrompt = `Provide a detailed report on the most significant recent offshore wind energy developments in Denmark using your internal knowledge. 
  Categorize into: infrastructure, legislation, approvals, and projects. 
  Return a strictly English JSON object.`;

  const schema = {
    type: "OBJECT",
    properties: {
      date: { type: "STRING" },
      infrastructure: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } },
      legislation:    { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } },
      approvals:      { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } },
      projects:       { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" }, source: { type: "STRING" }, url: { type: "STRING" } } } }
    },
    required: ["date", "infrastructure", "legislation", "approvals", "projects"]
  };

  async function callGemini(text, useSearch) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema }
    };
    if (useSearch) payload.tools = [{ google_search: {} }];

    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  try {
    if (!API_KEY) throw new Error("GEMINI_API_KEY is not set in Cloudflare environment variables.");

    // Pass 1: Attempt search
    let response = await callGemini(searchPrompt, true);
    let isFallback = false;

    // IF 429 (Quota) OR 400 (Tool Error) -> IMMEDIATELY TRY FALLBACK
    if (response.status === 429 || response.status === 400) {
      response = await callGemini(fallbackPrompt, false);
      isFallback = true;
    }

    const result = await response.json();
    if (!response.ok) return new Response(JSON.stringify({ error: "Gemini Failure", details: result }), { status: response.status });

    const data = JSON.parse(result.candidates[0].content.parts[0].text);
    data.isFallback = isFallback;

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
