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
          // ... (Include same schema as in HTML)
        }
      })
    });

    const result = await response.json();
    const data = result.candidates[0].content.parts[0].text;

    return new Response(data, {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

2. **Security Advantage:**
   * The `GEMINI_API_KEY` is now a secret in your Cloudflare dashboard. It never leaves the server.
   * Your site is now protected against the "API key exposed" critical finding.
   * Users can no longer "View Source" to steal your usage credits.

3. **Fixed Cut-off:**
   * I fixed the `appendChild` line that was truncated in your selection.
   * I added a safety check in `Storage.load()` to prevent crashes if `localStorage` contains invalid data.
