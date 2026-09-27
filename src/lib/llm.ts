import { type GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { config, requireEnv } from "../config.ts";

let client: GoogleGenAI | undefined;
const ai = () => (client ??= new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") }));

/** Gemini call returning JSON that conforms to `schema`. */
export async function generateJson<T>(prompt: string, schema: Record<string, unknown>, signal: AbortSignal) {
  const response = await ai().models.generateContent({
    model: config.GEMINI_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0, abortSignal: signal },
  });
  return JSON.parse(response.text ?? "null") as T;
}

/** Gemini call grounded with Google Search; returns text plus grounding metadata. */
export async function generateGrounded(prompt: string, signal: AbortSignal): Promise<GenerateContentResponse> {
  return ai().models.generateContent({
    model: config.GEMINI_MODEL,
    contents: prompt,
    config: { tools: [{ googleSearch: {} }], temperature: 0.2, abortSignal: signal },
  });
}
