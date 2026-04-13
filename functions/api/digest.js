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

    // List of model IDs to try in order to avoid 404 errors on v1beta
    const MODELS = [
      "gemini-1.5-flash-latest",
      "gemini-1.5-flash",
      "gemini-1.5-pro-latest",
      "gemini-1.5-pro"
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

    const callGemini = async (prompt, model, useSearch) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 }
      };
      if (useSearch) payload.tools = [{ google_search: {} }];

      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    };

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
        const errJson = await response.json().catch(() => ({}));
        errors.push({ model, status: response.status, details: errJson });
        
        // If it's a 429 (Quota) or 403 (Forbidden), we don't cycle models for Search, 
        // we just move to the knowledge fallback to save time.
        if (response.status === 429 || response.status === 403 || response.status === 400) break;
      } catch (e) {
        errors.push({ model, error: e.message });
      }
    }

    // PASS 2: If Pass 1 failed entirely, attempt WITHOUT Google Search (Internal Knowledge)
    if (!successfulModel) {
      isFallback = true;
      for (const model of MODELS) {
        try {
          response = await callGemini("Report on major offshore wind energy projects in Denmark from your knowledge in English.", model, false);
          if (response.ok) {
            successfulModel = model;
            break;
          }
          const errJson = await response.json().catch(() => ({}));
          errors.push({ fallback_model: model, status: response.status, details: errJson });
        } catch (e) {
          errors.push({ fallback_model: model, error: e.message });
        }
      }
    }

    if (!successfulModel) {
      return new Response(JSON.stringify({ 
        error: "All Gemini Models Failed", 
        details: errors 
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const result = await response.json();
    const jsonStr = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!jsonStr) throw new Error(`API returned empty content for model ${successfulModel}`);

    const data = JSON.parse(jsonStr);
    data.isFallback = isFallback;
    data.modelUsed = successfulModel;

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
