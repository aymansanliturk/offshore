export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;
  
  // We will try these models in order if a 404 occurs
  const MODELS = ["gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-flash-001"];

  const searchPrompt = `Search for the latest news (last 48h) regarding offshore wind projects in Denmark. 
  Categories: infrastructure, legislation, approvals, and projects. 
  Return a strictly English JSON object.`;

  const fallbackPrompt = `Provide a detailed report on the most significant recent offshore wind energy developments in Denmark based on your internal knowledge. 
  Categories: infrastructure, legislation, approvals, and projects. 
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

  async function callGemini(text, useSearch, modelName) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text }] }],
      generationConfig: { 
        responseMimeType: "application/json", 
        responseSchema: schema,
        temperature: 0.1 
      }
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
      return new Response(JSON.stringify({ error: "Configuration Error", details: "GEMINI_API_KEY is missing." }), { status: 500 });
    }

    let response;
    let isFallback = false;
    let lastError = null;
    let successfulModel = null;

    // PASS 1: Try searching with models in sequence
    for (const model of MODELS) {
      response = await callGemini(searchPrompt, true, model);
      if (response.ok) {
        successfulModel = model;
        break;
      }
      // If quota (429) or forbidden (403/400), we skip to Fallback mode immediately
      if (response.status === 429 || response.status === 403 || response.status === 400) {
        break;
      }
    }

    // PASS 2: Fallback (Knowledge mode) if Pass 1 failed
    if (!response || !response.ok) {
      isFallback = true;
      for (const model of MODELS) {
        response = await callGemini(fallbackPrompt, false, model);
        if (response.ok) {
          successfulModel = model;
          break;
        }
      }
    }

    const result = await response.json();
    
    if (!response.ok) {
      return new Response(JSON.stringify({ 
        error: "Gemini API Failure", 
        details: `Status ${response.status}: ${JSON.stringify(result.error || result)}`,
        isFallback
      }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    }

    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonString) throw new Error("API returned empty content.");

    const data = JSON.parse(jsonString);
    data.isFallback = isFallback;
    data.modelUsed = successfulModel;

    return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Worker Error", details: e.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}
