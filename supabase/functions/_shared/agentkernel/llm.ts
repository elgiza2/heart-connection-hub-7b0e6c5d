/**
 * Server-only LLM bridge for the agent kernel.
 *
 * The kernel runs from cron ticks where there is no user JWT, so it cannot go
 * through the user-facing chat function. It talks to the same Alibaba (Qwen)
 * models directly, using an active key from `alibaba_keys` (service-role read).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const BASE =
  Deno.env.get("ALIBABA_API_BASE") ||
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const MODEL = Deno.env.get("AGENT_KERNEL_MODEL") || "qwen-plus";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Every active text-capable key, least-recently-used first, plus the env key. */
async function apiKeys(supabase: SupabaseClient): Promise<Array<{ id?: string; key: string }>> {
  const { data } = await supabase
    .from("alibaba_keys")
    .select("id,api_key,category")
    .eq("status", "active")
    .in("category", ["qwen", "memory", "text"])
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .limit(6);
  const out: Array<{ id?: string; key: string }> = [];
  for (const row of (data ?? []) as { id?: string; api_key?: string }[]) {
    const key = row.api_key?.trim();
    if (key) out.push({ id: row.id, key });
  }
  const envKey = Deno.env.get("ALIBABA_API_KEY")?.trim();
  if (envKey) out.push({ key: envKey });
  if (!out.length) throw new Error("no_model_key");
  return out;
}

/**
 * One non-streaming completion. Returns "" on any failure so the caller can
 * degrade gracefully instead of killing a long run.
 *
 * No artificial timeout: reasoning replies routinely take a while and aborting
 * would throw away work that still gets billed.
 */
export async function askModel(
  supabase: SupabaseClient,
  system: string,
  user: string,
): Promise<string> {
  let keys: Array<{ id?: string; key: string }>;
  try {
    keys = await apiKeys(supabase);
  } catch (error) {
    console.error("agentkernel llm has no usable key", error);
    return "";
  }

  // Try each active key in turn: a rejected key is a real, recoverable failure,
  // so it is retired instead of stalling every future tick on the same 401.
  for (const entry of keys) {
    try {
      const response = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${entry.key}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ] satisfies LlmMessage[],
          temperature: 0.2,
        }),
      });
      if (response.status === 401 || response.status === 403) {
        console.error(`agentkernel llm key rejected [${response.status}] — retiring key`);
        if (entry.id) {
          await supabase
            .from("alibaba_keys")
            .update({ status: "invalid" })
            .eq("id", entry.id);
        }
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        console.error(`agentkernel llm transient [${response.status}] — trying next key`);
        continue;
      }
      if (!response.ok) {
        console.error(`agentkernel llm [${response.status}]: ${await response.text()}`);
        return "";
      }
      const data = (await response.json().catch(() => null)) as
        | { choices?: { message?: { content?: string } }[] }
        | null;
      const text = data?.choices?.[0]?.message?.content ?? "";
      if (entry.id) {
        await supabase
          .from("alibaba_keys")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", entry.id);
      }
      return text;
    } catch (error) {
      console.error("agentkernel llm failed", error);
    }
  }
  return "";
}

/** Same call, parsing the first JSON object/array in the reply. */
export async function askJson<T>(
  supabase: SupabaseClient,
  system: string,
  user: string,
): Promise<T | null> {
  return extractJson<T>(await askModel(supabase, system, user));
}

export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
