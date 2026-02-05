export interface Env {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string; // optional
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function safeJsonParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/summarize") {
      return new Response("Not Found", { status: 404, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
    }

    const body = await request.json().catch(() => null) as any;
    const transcript = (body?.transcript ?? "").toString().trim();
    const preferred = body?.preferred_language === "pt" || body?.preferred_language === "en" ? body.preferred_language : null;

    if (!transcript) {
      return new Response("Missing transcript", { status: 400, headers: corsHeaders() });
    }

    const schema = {
      title: "string",
      one_liner: "string",
      key_points: ["string"],
      action_items: [{ task: "string", owner: "string|null", due_date: "YYYY-MM-DD|null", priority: "low|medium|high|null" }],
      decisions: ["string"],
      open_questions: ["string"],
      tags: ["string"],
      language: "pt|en"
    };

    const system = `
You are an assistant that converts transcripts into a strict JSON summary.
Return ONLY valid JSON. No markdown. No extra keys.
If owner/due date are unclear, use null.
Language: If preferred_language is provided, use it; otherwise match the transcript language (pt or en).
JSON schema example (types): ${JSON.stringify(schema)}
`.trim();

    const user = `
preferred_language: ${preferred ?? "auto"}
TRANSCRIPT:
${transcript}
`.trim();

    const model = env.GEMINI_MODEL || "gemini-1.5-flash";

    // Gemini REST call
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const payload = {
      contents: [
        { role: "user", parts: [{ text: system + "\n\n" + user }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 700
      }
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text();
      return new Response(t, { status: 500, headers: corsHeaders() });
    }

    const data = await r.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = safeJsonParse(text);

    // If model returned non-JSON, do one repair attempt:
    if (!parsed) {
      const repairPayload = {
        contents: [
          { role: "user", parts: [{ text: `Fix this into valid JSON ONLY (no markdown):\n${text}` }] }
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 700 }
      };

      const rr = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(repairPayload)
      });

      const rt = await rr.text();
      const repairedData = safeJsonParse(
        (safeJsonParse(rt)?.candidates?.[0]?.content?.parts?.[0]?.text) ?? ""
      );

      if (!repairedData) {
        return new Response("Model did not return valid JSON.", { status: 500, headers: corsHeaders() });
      }

      return new Response(JSON.stringify(repairedData), {
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    return new Response(JSON.stringify(parsed), {
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  },
};
