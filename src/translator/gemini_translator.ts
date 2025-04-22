import { GoogleGenAI } from "@google/genai";
import type { Config, ChunkInfo } from "../types.js";
import * as logger from "../utils/logger.js";
import { calculateCost } from "../config/models.js";

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
    const genAI = new GoogleGenAI({ apiKey });
    const result = await genAI.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    // Get text from the first candidate's content
    let text: string | null = null;
    if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
      text = result.candidates[0].content.parts[0].text;
    }

    // Extract token counts from usageMetadata if available
    const usageMetadata = result.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount;
    const outputTokens = usageMetadata?.candidatesTokenCount;
    const totalTokens = usageMetadata?.totalTokenCount;

    // Calculate and log cost if tokens are available
    if (inputTokens !== undefined && outputTokens !== undefined) {
      const cost = calculateCost(modelName, inputTokens, outputTokens);

      // Store tokens and cost for this attempt
      if (!chunk.allTranslationAttempts) {
        chunk.allTranslationAttempts = [];
      }

      chunk.allTranslationAttempts.push({
        inputTokens,
        outputTokens,
        cost,
      });

      // Calculate total translation cost
      chunk.totalTranslationCost = chunk.allTranslationAttempts.reduce(
        (sum, attempt) => sum + attempt.cost,
        0
      );

      // Set the current attempt's values (for backward compatibility)
      chunk.llmTranslationInputTokens = inputTokens;
      chunk.llmTranslationOutputTokens = outputTokens;
      chunk.cost = cost;

      // Calculate total cost
      chunk.totalCost =
        (chunk.totalTranscriptionCost || 0) + (chunk.totalTranslationCost || 0);

      logger.debug(
        `[Chunk ${chunk.partNumber}] Gemini Tokens - Input: ${
          inputTokens ?? "N/A"
        }, Output: ${outputTokens ?? "N/A"}, Total: ${
          totalTokens ?? "N/A"
        }, Estimated Cost: $${cost.toFixed(
          6
        )}, Total Translation Cost: $${chunk.totalTranslationCost.toFixed(6)}`
      );
    } else if (inputTokens !== undefined || outputTokens !== undefined) {
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
