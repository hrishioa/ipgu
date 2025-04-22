import { GoogleGenAI } from "@google/genai";
import type { Config, ChunkInfo } from "../types.js";
import * as logger from "../utils/logger.js";

/**
 * Result structure for Gemini calls, including tokens.
 */
export interface GeminiCallResult {
  responseText: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Sends a prompt to a Gemini model using generateContent
 * and returns the text response and token counts.
 */
export async function callGemini(
  prompt: string,
  config: Config,
  chunk: ChunkInfo
): Promise<GeminiCallResult | null> {
  const apiKey = config.apiKeys.gemini;
  if (!apiKey) {
    logger.error(`[Chunk ${chunk.partNumber}] Missing Gemini API key.`);
    return null;
  }

  const modelName = config.translationModel;
  logger.info(
    `[Chunk ${chunk.partNumber}] Calling Gemini model: ${modelName}...`
  );

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = ai.getGenerativeModel({ model: modelName });

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    // Extract token counts from usageMetadata if available
    const usageMetadata = response.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount;
    const outputTokens = usageMetadata?.candidatesTokenCount; // Often represents output
    const totalTokens = usageMetadata?.totalTokenCount;

    if (inputTokens !== undefined || outputTokens !== undefined) {
      logger.debug(
        `[Chunk ${chunk.partNumber}] Gemini Tokens - Input: ${
          inputTokens ?? "N/A"
        }, Output: ${outputTokens ?? "N/A"}, Total: ${totalTokens ?? "N/A"}`
      );
    }

    if (!text || text.trim().length === 0) {
      logger.warn(`[Chunk ${chunk.partNumber}] Gemini response was empty.`);
      // Return result object even if text is null, tokens might be present
      return { responseText: null, inputTokens, outputTokens, totalTokens };
    }
    logger.debug(
      `[Chunk ${chunk.partNumber}] Received Gemini response (Length: ${text.length}).`
    );
    return { responseText: text, inputTokens, outputTokens, totalTokens };
  } catch (error: any) {
    logger.error(
      `[Chunk ${chunk.partNumber}] Gemini API error: ${error.message || error}`
    );
    if (
      error.response?.candidates?.length &&
      error.response?.candidates[0]?.finishReason
    ) {
      logger.error(
        `[Chunk ${chunk.partNumber}] Gemini API Error Details: FinishReason=${
          error.response.candidates[0].finishReason
        }, SafetyRatings=${JSON.stringify(
          error.response.candidates[0].safetyRatings
        )}`
      );
    } else if (error.message?.includes("request failed")) {
      logger.error(
        `[Chunk ${chunk.partNumber}] Gemini API network/status error: ${error.message}`
      );
    }
    return null; // Fatal error
  }
}
