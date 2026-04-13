export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;

  // Most reliable model sequence
  const MODELS = ["gemini-1.5-flash", "gemini-1.5-flash-latest"];

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

  async function callGemini(prompt, modelName, useSearch) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { 
        responseMimeType: "application/json", 
        responseSchema: schema,
        temperature: 0.2
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
      return new Response(JSON.stringify({ error: "Missing API Key", details: "GEMINI_API_KEY is not set in Cloudflare dashboard." }), { status: 500, headers: {'Content-Type': 'application/json'} });
    }

    let response;
    let successfulModel = null;
    let isFallback = false;

    // PASS 1: Attempt search with available models
    for (const model of MODELS) {
      try {
        response = await callGemini("Summarize latest offshore wind news in Denmark from last 48h in English.", model, true);
        if (response.ok) {
          successfulModel = model;
          break;
        }
      } catch (e) {}
    }

    // PASS 2: Fallback (Knowledge mode) if Pass 1 failed (429/404/400)
    if (!successfulModel) {
      isFallback = true;
      for (const model of MODELS) {
        try {
          response = await callGemini("Report on major offshore wind developments in Denmark using your internal data in English.", model, false);
          if (response.ok) {
            successfulModel = model;
            break;
          }
        } catch (e) {}
      }
    }

    if (!successfulModel) {
      const errorText = response ? await response.text() : "No response from Google API";
      return new Response(JSON.stringify({ 
        error: "All Models Failed", 
        details: errorText.slice(0, 500) 
      }), { status: 502, headers: {'Content-Type': 'application/json'} });
    }

    const result = await response.json();
    const jsonStr = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!jsonStr) throw new Error("AI returned no content parts.");

    const data = JSON.parse(jsonStr);
    data.isFallback = isFallback;

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Worker Internal Error", details: e.message }), { status: 500, headers: {'Content-Type': 'application/json'} });
  }
}
