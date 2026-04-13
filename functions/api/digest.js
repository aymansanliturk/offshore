export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;
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
    if (!API_KEY) {
      return new Response(JSON.stringify({ error: "Missing GEMINI_API_KEY environment variable" }), { status: 500 });
    }

    // Try with Search
    let response = await callGemini("Summarize the latest offshore wind news in Denmark from the last 48 hours in English.", true);
    let isFallback = false;

    // Fallback if 429 (Quota) or 400 (Bad Request/Restricted Tool)
    if (response.status !== 200) {
      isFallback = true;
      response = await callGemini("Summarize current major offshore wind developments in Denmark from your knowledge in English.", false);
    }

    const result = await response.json();
    
    if (!response.ok) {
      return new Response(JSON.stringify({ 
        error: "Gemini API Failure", 
        details: JSON.stringify(result.error || result) 
      }), { status: response.status });
    }

    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonString) throw new Error("Empty response from Gemini");

    const data = JSON.parse(jsonString);
    data.isFallback = isFallback;

    return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Worker Error", details: e.message }), { status: 500 });
  }
}
