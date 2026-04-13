export async function onRequest(context) {
  // We use a global try-catch and return status 200 for errors 
  // to bypass Cloudflare's 502/504 HTML error pages.
  try {
    const env = context.env || {};
    const API_KEY = env.GEMINI_API_KEY;

    if (!API_KEY) {
      return new Response(JSON.stringify({ 
        error: "Configuration Error", 
        details: "GEMINI_API_KEY is not detected. Please check Cloudflare Dashboard -> Settings -> Variables." 
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const MODEL = "gemini-1.5-flash";
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

    const callGemini = async (prompt, useSearch) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 }
      };
      if (useSearch) payload.tools = [{ google_search: {} }];

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return res;
    };

    // Attempt 1: Search
    let response = await callGemini("Summarize latest offshore wind developments in Denmark from last 48h in English.", true);
    let isFallback = false;

    // Fallback if anything goes wrong with search (429, 400, 403, 404)
    if (!response.ok) {
      isFallback = true;
      response = await callGemini("Report on major offshore wind energy projects in Denmark from your knowledge in English.", false);
    }

    const result = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ 
        error: "Gemini API Error", 
        details: JSON.stringify(result.error || result) 
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const jsonStr = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonStr) throw new Error("API returned no content.");

    const data = JSON.parse(jsonStr);
    data.isFallback = isFallback;

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ 
      error: "Worker Logic Crash", 
      details: err.message 
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
}
