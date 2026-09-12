// Thin wrapper around the Anthropic Messages API -- the one call in this
// app that costs real money per use (see the optional ANTHROPIC_API_KEY
// binding in index.ts, and routes/letters.ts which is the only caller).
// A plain fetch rather than the SDK: a Worker doesn't need anything the
// SDK adds beyond bundle size for a single-shot text completion.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Takes a message array rather than a single string so the same helper
// covers both a genuine multi-turn conversation (Correspondence's
// drafting chat) and a one-shot call (the compliance review, which just
// wraps its input as a single-message array) without two code paths.
export async function callClaude(apiKey: string, system: string, messages: ChatMessage[]): Promise<string> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status})`);
  }

  const data = await res.json<AnthropicResponse>();
  const text = data.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("Anthropic API returned no text content");
  }
  return text;
}
