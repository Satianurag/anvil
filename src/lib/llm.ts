import { ApiError, type GenerateContentParameters, type GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { config, requireEnv } from "../config.ts";

let client: GoogleGenAI | undefined;
const ai = () => (client ??= new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") }));

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Tries each comma-separated model in order, falling through on overload / quota errors. */
async function generate(models: string, params: Omit<GenerateContentParameters, "model">) {
  const list = models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  for (const [i, model] of list.entries()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await ai().models.generateContent({ ...params, model });
      } catch (err) {
        if (!(err instanceof ApiError && RETRYABLE.has(err.status))) throw err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
          continue;
        }
        if (i === list.length - 1) throw err;
        console.warn(`gemini ${model} HTTP ${err.status}, falling back to ${list[i + 1]}`);
      }
    }
  }
  throw new Error("no Gemini model configured");
}

/** Gemini call returning JSON that conforms to `schema`. */
export async function generateJson<T>(prompt: string, schema: Record<string, unknown>, signal: AbortSignal) {
  const response = await generate(config.GEMINI_MODEL, {
    contents: prompt,
    config: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0, abortSignal: signal },
  });
  return JSON.parse(response.text ?? "null") as T;
}

/** Gemini call grounded with Google Search; returns text plus grounding metadata. */
export async function generateGrounded(prompt: string, signal: AbortSignal): Promise<GenerateContentResponse> {
  return generate(config.GEMINI_SEARCH_MODEL, {
    contents: prompt,
    config: { tools: [{ googleSearch: {} }], temperature: 0.2, abortSignal: signal },
  });
}
