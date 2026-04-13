export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;

  // We cycle through these models to avoid the 404 error
  const MODELS = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro",
    "gemini-pro"
  ];

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

  async function callGemini(prompt, model, useSearch) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
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
      return new Response(JSON.stringify({ error: "Configuration Error", details: "API Key is missing in Cloudflare." }), { status: 500 });
    }

    let response;
    let successfulModel = null;
    let isFallback = false;
    let errors = [];

    // PASS 1: Attempt to find a working model WITH Google Search
    for (const model of MODELS) {
      try {
        response = await callGemini("Summarize latest offshore wind developments in Denmark from last 48h in English.", model, true);
        if (response.ok) {
          successfulModel = model;
          break;
        }
        // If it's a 404, we continue to the next model
        const errData = await response.json();
        errors.push({ model, status: response.status, data: errData });
      } catch (e) {
        errors.push({ model, error: e.message });
      }
    }

    // PASS 2: If Pass 1 failed (Quota or 404s), try WITHOUT Search
    if (!successfulModel) {
      isFallback = true;
      for (const model of MODELS) {
        try {
          response = await callGemini("List current major offshore wind projects in Denmark from your memory in English.", model, false);
          if (response.ok) {
            successfulModel = model;
            break;
          }
        } catch (e) { }
      }
    }

    if (!successfulModel) {
      return new Response(JSON.stringify({ 
        error: "Exhausted all Gemini models", 
        details: errors 
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    const result = await response.json();
    const jsonStr = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!jsonStr) throw new Error("API returned no content.");

    const data = JSON.parse(jsonStr);
    data.isFallback = isFallback;
    data.modelUsed = successfulModel;

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Worker Error", details: e.message }), { status: 500 });
  }
}
