// Thin wrapper around the Anthropic Messages API -- the one call in this
// app that costs real money per use (see the optional ANTHROPIC_API_KEY
// binding in index.ts, and routes/letters.ts which is the only caller).
// A plain fetch rather than the SDK: a Worker doesn't need anything the
// SDK adds beyond bundle size for a single-shot text completion.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export interface AiModelOption {
  id: string;
  label: string;
  // Anthropic's published USD price per million tokens -- used only to
  // compute Admin's own estimated-cost ledger (routes/letters.ts's
  // /usage), never sent to Anthropic itself. Update these if Anthropic's
  // pricing changes.
  inputPricePerMTok: number;
  outputPricePerMTok: number;
}

export const AI_MODELS: AiModelOption[] = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fast & economical", inputPricePerMTok: 1, outputPricePerMTok: 5 },
  { id: "claude-sonnet-5", label: "Sonnet 5 — higher quality", inputPricePerMTok: 2, outputPricePerMTok: 10 },
];

export const DEFAULT_MODEL = AI_MODELS[0].id;

export function isValidAiModel(id: unknown): id is string {
  return typeof id === "string" && AI_MODELS.some((m) => m.id === id);
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClaudeResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

// Takes a message array rather than a single string so the same helper
// covers both a genuine multi-turn conversation (Correspondence's
// drafting chat) and a one-shot call (the compliance review, which just
// wraps its input as a single-message array) without two code paths.
export async function callClaude(
  apiKey: string,
  model: string,
  system: string,
  messages: ChatMessage[],
): Promise<ClaudeResult> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
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
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}
