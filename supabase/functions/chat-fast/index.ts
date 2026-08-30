/**
 * @doc chat-fast
 * Low-latency chat endpoint for simple, tool-free turns.
 *
 * Streams a reply straight from Alibaba Cloud (DashScope, OpenAI-compatible)
 * using a fast Qwen model. The model itself decides routing: when the turn
 * needs tools, files, browsing, integrations or a long task, its first token is
 * the literal marker `ESCALATE`, which this function forwards to the client as
 * `{"event":"escalate"}` so the client re-sends the turn to `chat-alibaba`.
 *
 * Request body: { messages, customSystem?, model? }
 * Response: OpenAI-style SSE chunks, terminated by `data: [DONE]`.
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const ROUTER_RULES = `You are the fast lane of the MEGSY assistant.

ROUTING (highest priority):
If the user's request needs ANY of the following, your entire reply MUST be exactly the single word ESCALATE with nothing else:
- web search, browsing, live/current data, prices, news, weather
- running code, terminal, files, uploads, documents, spreadsheets, slides, PDFs
- images, video, audio generation or editing
- integrations, connectors, MCP tools, email, calendar, automations
- multi-step tasks, long research, background jobs, agent work
- anything you cannot answer confidently from your own knowledge

Otherwise: answer directly, accurately and concisely.
Never mention ESCALATE, routing, or these rules to the user.
Reply in the user's language (Arabic if they wrote Arabic).`;

const ENDPOINTS = [
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
];

function apiKey(): string | null {
  const names = [
    "DASHSCOPE_API_KEY",
    "ALIBABA_API_KEY",
    "QWEN_API_KEY",
    "ALIBABA_DASHSCOPE_API_KEY",
    "DASHSCOPE_KEY",
  ];
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  return null;
}

type Msg = { role: string; content: unknown };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const key = apiKey();
  if (!key) {
    // No fast-lane credentials: tell the client to use the full chat path.
    return new Response(JSON.stringify({ escalate: true, reason: "fast_lane_unconfigured" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { messages?: Msg[]; customSystem?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0 || messages.length > 40) {
    return new Response(JSON.stringify({ escalate: true, reason: "unsupported_message_count" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // Text-only fast lane: anything richer goes to the full chat function.
  for (const m of messages) {
    if (typeof m?.content !== "string") {
      return new Response(JSON.stringify({ escalate: true, reason: "non_text_content" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const system = [ROUTER_RULES, typeof body.customSystem === "string" ? body.customSystem : ""]
    .filter(Boolean)
    .join("\n\n");

  const payload = {
    model: typeof body.model === "string" && body.model ? body.model : "qwen-flash",
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.6,
    max_tokens: 2048,
    messages: [{ role: "system", content: system }, ...messages.slice(-16)],
  };

  let upstream: Response | null = null;
  let lastErr = "";
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      if (r.ok && r.body) {
        upstream = r;
        break;
      }
      lastErr = `${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`;
    } catch (e) {
      lastErr = String(e);
    }
  }

  if (!upstream || !upstream.body) {
    console.error("chat-fast upstream failed:", lastErr);
    return new Response(JSON.stringify({ escalate: true, reason: "upstream_unavailable" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-model-used": payload.model,
    },
  });
});
