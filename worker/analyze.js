// Room Change - AI backend (design review + AI-driven room editing)
//
// Runs on Cloudflare Workers. Keeps the Anthropic API key secret (set as the
// ANTHROPIC_API_KEY environment variable in the Worker's dashboard).
//
// Two request shapes, chosen by the app:
//   { roomDescription: "..." }                      -> written critique (review mode)
//   { instruction: "...", room: {...} }              -> structured furniture edits (edit mode)

const ALLOWED_ORIGIN = "https://nellcgram.github.io";
const DAILY_LIMIT = 100; // total requests per day, across both modes and all visitors
const MODEL = "claude-opus-5";

const REVIEW_SYSTEM_PROMPT = `You are an imaginative interior designer reimagining a bedroom described in inches: room dimensions and doors, furniture with exact position/size/rotation and an assigned "job", zones like a reading nook, and a list of mechanically-detected issues.

Ignore floor space and door clearance as constraints - assume there is plenty of room for every piece of furniture, and that doors never block the bed. Do not flag overlaps or crowding as problems.

Give wildly creative, unconventional ideas for changing the room - unusual furniture arrangements, hanging or ceiling-mounted storage/seating/lighting, unexpected uses for existing pieces. Prioritize ideas that open up floor space and make the bed feel less dominant, while keeping its mattress size fixed (never suggest a smaller mattress).

Output ONLY a bullet list. Extremely concise - fragments, not full sentences, as few words as possible per bullet. No intro, no explanation, no markdown headers, no bold text. Do not include internal or system XML tags in your response.`;

const EDIT_SYSTEM_PROMPT = `You edit a bedroom furniture layout based on a person's plain-English instruction.

You'll receive the room (width, length in inches) and the current furniture list, each with: name, w (width in), d (depth in), job (one of: unassigned, seating, storage, surface, light, footrest, decorative, other), cx/cy (center position in inches from the room's top-left corner), rotation (degrees).

Given the instruction, output ONLY a JSON object (no prose, no markdown fences, no code blocks) with exactly this shape:
{"summary": "one short sentence describing what you changed", "operations": [ ... ]}

Each operation is one of:
{"op": "add", "name": "...", "w": <inches>, "d": <inches>, "job": "<one of the job values above>", "cx": <inches>, "cy": <inches>, "rotation": <degrees>}
{"op": "remove", "match": "<existing item name, case-insensitive partial match>"}
{"op": "update", "match": "<existing item name>", "name"?: "...", "w"?: <inches>, "d"?: <inches>, "job"?: "...", "cx"?: <inches>, "cy"?: <inches>, "rotation"?: <degrees>}

Rules:
- For "add": invent reasonable real-world furniture dimensions in inches if not given, and place it (cx, cy) inside the room bounds (0 to width, 0 to length) in a spot that doesn't obviously overlap existing furniture.
- For "update": include only the fields that actually change.
- "job" must be exactly one of: unassigned, seating, storage, surface, light, footrest, decorative, other.
- If the instruction needs no furniture change, return {"summary": "...", "operations": []}.
- Output ONLY the JSON object, nothing before or after it.`;

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

async function callClaude(apiKey, system, userContent, maxTokens) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
      thinking: { type: "disabled" },
    }),
  });
  return resp;
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
      return jsonResponse({ error: "Daily limit reached - try again tomorrow." }, 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid request." }, 400, origin);
    }

    const isEdit = typeof body.instruction === "string" && body.room && typeof body.room === "object";
    const isReview = typeof body.roomDescription === "string";

    if (!isEdit && !isReview) {
      return jsonResponse({ error: "Missing roomDescription or instruction/room." }, 400, origin);
    }

    let anthropicResp;
    try {
      if (isEdit) {
        const instruction = body.instruction.slice(0, 2000);
        const roomJson = JSON.stringify(body.room).slice(0, 8000);
        anthropicResp = await callClaude(
          env.ANTHROPIC_API_KEY,
          EDIT_SYSTEM_PROMPT,
          `Room and current furniture:\n${roomJson}\n\nInstruction: ${instruction}`,
          1500
        );
      } else {
        const roomDescription = body.roomDescription.slice(0, 8000);
        anthropicResp = await callClaude(env.ANTHROPIC_API_KEY, REVIEW_SYSTEM_PROMPT, roomDescription, 2048);
      }
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

    await env.RATE_LIMIT_KV.put(countKey, String(count + 1), { expirationTtl: 60 * 60 * 26 });

    if (!textBlock) {
      return jsonResponse(
        { error: `No response returned. stop_reason: ${data.stop_reason}, content: ${JSON.stringify(data.content).slice(0, 300)}` },
        502,
        origin
      );
    }

    if (isEdit) {
      let parsed;
      try {
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textBlock.text);
      } catch {
        return jsonResponse({ error: "The AI's response wasn't valid JSON. Try rephrasing your instruction." }, 502, origin);
      }
      if (!Array.isArray(parsed.operations)) {
        return jsonResponse({ error: "The AI's response was missing an operations list." }, 502, origin);
      }
      return jsonResponse({ summary: parsed.summary || "", operations: parsed.operations }, 200, origin);
    }

    return jsonResponse({ feedback: textBlock.text }, 200, origin);
  },
};
