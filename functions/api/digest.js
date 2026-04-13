export async function onRequest(context) {
  const { env } = context;
  const API_KEY = env.GEMINI_API_KEY;

  // Google bazen farklı isimleri kabul ediyor, sırayla deneyeceğiz.
  const MODELS = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
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
      return new Response(JSON.stringify({ error: "Config Error", details: "API Key not found in Environment Variables." }), { status: 500 });
    }

    let response;
    let successfulModel = null;
    let isFallback = false;

    // AŞAMALI DENEME: Önce Arama Özelliği ile dene
    for (const model of MODELS) {
      try {
        response = await callGemini("Summarize latest offshore wind news in Denmark from last 48h in English.", model, true);
        if (response.ok) {
          successfulModel = model;
          break;
        }
      } catch (e) { console.error(e); }
    }

    // FALLBACK: Eğer arama başarısızsa (429/404/400), aramayı Kapatıp tekrar dene
    if (!successfulModel) {
      isFallback = true;
      for (const model of MODELS) {
        try {
          response = await callGemini("Provide a report on current major offshore wind developments in Denmark from your knowledge in English.", model, false);
          if (response.ok) {
            successfulModel = model;
            break;
          }
        } catch (e) { console.error(e); }
      }
    }

    if (!successfulModel) {
      const errorData = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({ 
        error: "All Models Failed", 
        details: JSON.stringify(errorData.error || errorData),
        status: response?.status 
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    const result = await response.json();
    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!jsonText) throw new Error("AI returned empty content");

    const data = JSON.parse(jsonText);
    data.isFallback = isFallback;
    data.model = successfulModel;

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Function Error", details: e.message }), { status: 500 });
  }
}
