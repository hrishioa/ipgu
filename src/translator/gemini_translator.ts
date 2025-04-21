import { GoogleGenAI } from "@google/genai";
import type { Config, ChunkInfo } from "../types.js";
import * as logger from "../utils/logger.js";

/**
 * Sends a prompt to a Gemini model using the generateContentStream method
 * and returns the raw text response.
 *
 * @param prompt The complete prompt string.
 * @param config Pipeline configuration (for API key and model name).
 * @param chunk The current chunk (for logging context).
 * @returns A promise resolving to the raw text response or null if an error occurs.
 */
export async function callGemini(
  prompt: string,
  config: Config,
  chunk: ChunkInfo
): Promise<string | null> {
  const apiKey = config.apiKeys.gemini;
  if (!apiKey) {
    logger.error(`[Chunk ${chunk.partNumber}] Missing Gemini API key.`);
    return null;
  }

  const modelName = config.translationModel;
  logger.info(
    `[Chunk ${chunk.partNumber}] Calling Gemini model (stream): ${modelName}...`
  );

  try {
    const ai = new GoogleGenAI({ apiKey });

    // Construct the contents array, mimicking process-prompts.ts structure
    const contents = [
      {
        role: "user",
        parts: [{ text: prompt }], // Pass the prompt text here
      },
    ];

    // Use generateContentStream as in process-prompts.ts
    const responseStream = await ai.models.generateContentStream({
      model: modelName,
      contents, // Pass the structured contents
      // config object is part of the top-level options here, if needed
      // generationConfig: { maxOutputTokens: ..., temperature: ... } // Example if needed
    });

    // Collect the streamed response
    let fullResponse = "";
    for await (const chunk of responseStream) {
      // Ensure chunk.text exists and is a string
      if (chunk.text && typeof chunk.text === "string") {
        fullResponse += chunk.text;
      }
    }

    if (!fullResponse || fullResponse.trim().length === 0) {
      logger.warn(
        `[Chunk ${chunk.partNumber}] Gemini stream response was empty.`
      );
      return null;
    }
    logger.debug(
      `[Chunk ${chunk.partNumber}] Received Gemini stream response (Length: ${fullResponse.length}).`
    );
    return fullResponse;
  } catch (error: any) {
    logger.error(
      `[Chunk ${chunk.partNumber}] Gemini API error (stream): ${
        error.message || error
      }`
    );
    // Attempt to log more details from the error structure if possible
    try {
      logger.error(
        `[Chunk ${chunk.partNumber}] Gemini Error Details: ${JSON.stringify(
          error
        )}`
      );
    } catch (jsonError) {
      /* Ignore if error cannot be stringified */
    }
    return null;
  }
}
