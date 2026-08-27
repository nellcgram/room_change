// Room Change - AI Design Review backend
//
// Runs on Cloudflare Workers. Keeps the Anthropic API key secret (set as the
// ANTHROPIC_API_KEY environment variable in the Worker's dashboard), takes a
// plain-text room description from the app, and returns a written critique.
//
// Deployment: paste this whole file into a new Cloudflare Worker, add the
// ANTHROPIC_API_KEY secret, and bind a KV namespace named RATE_LIMIT_KV (used
// to cap total requests per day so a stray/abused request can't run up a
// surprise bill). See the repo README for the full click-by-click steps.

const ALLOWED_ORIGIN = "https://nellcgram.github.io";
const DAILY_LIMIT = 100; // total analyses per day, across all visitors
const MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You are an imaginative interior designer reimagining a bedroom described in inches: room dimensions and doors, furniture with exact position/size/rotation and an assigned "job", zones like a reading nook, and a list of mechanically-detected issues.

Ignore floor space and door clearance as constraints - assume there is plenty of room for every piece of furniture, and that doors never block the bed. Do not flag overlaps or crowding as problems.

Give wildly creative, unconventional ideas for changing the room - unusual furniture arrangements, hanging or ceiling-mounted storage/seating/lighting, unexpected uses for existing pieces. Prioritize ideas that open up floor space and make the bed feel less dominant, while keeping its mattress size fixed (never suggest a smaller mattress).

Output ONLY a bullet list. Extremely concise - fragments, not full sentences, as few words as possible per bullet. No intro, no explanation, no markdown headers, no bold text.`;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405, origin);
    }
    if (origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: "Forbidden." }, 403, origin);
    }

    const today = new Date().toISOString().slice(0, 10);
    const countKey = `count-${today}`;
    const countStr = await env.RATE_LIMIT_KV.get(countKey);
    const count = countStr ? parseInt(countStr, 10) : 0;
    if (count >= DAILY_LIMIT) {
      return jsonResponse({ error: "Daily analysis limit reached - try again tomorrow." }, 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid request." }, 400, origin);
    }

    const roomDescription = typeof body.roomDescription === "string" ? body.roomDescription.slice(0, 8000) : "";
    if (!roomDescription) {
      return jsonResponse({ error: "Missing room description." }, 400, origin);
    }

    let anthropicResp;
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: roomDescription }],
          thinking: { type: "disabled" },
        }),
      });
    } catch {
      return jsonResponse({ error: "Could not reach the AI service. Try again in a bit." }, 502, origin);
    }

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text().catch(() => "");
      return jsonResponse(
        { error: `The AI service returned an error (status ${anthropicResp.status}): ${errText.slice(0, 300)}` },
        502,
        origin
      );
    }

    const data = await anthropicResp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    const feedback = textBlock
      ? textBlock.text
      : `No feedback returned. stop_reason: ${data.stop_reason}, content: ${JSON.stringify(data.content).slice(0, 300)}`;

    await env.RATE_LIMIT_KV.put(countKey, String(count + 1), { expirationTtl: 60 * 60 * 26 });

    return jsonResponse({ feedback }, 200, origin);
  },
};
