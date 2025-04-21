import { Anthropic } from "@anthropic-ai/sdk";
import type { Config, ChunkInfo } from "../types.js";
import * as logger from "../utils/logger.js";

/**
 * Sends a prompt to a Claude model and returns the raw text response.
 *
 * @param prompt The complete prompt string.
 * @param config Pipeline configuration (for API key and model name).
 * @param chunk The current chunk (for logging context).
 * @returns A promise resolving to the raw text response or null if an error occurs.
 */
export async function callClaude(
  prompt: string,
  config: Config,
  chunk: ChunkInfo
): Promise<string | null> {
  const apiKey = config.apiKeys.anthropic;
  if (!apiKey) {
    logger.error(`[Chunk ${chunk.partNumber}] Missing Anthropic API key.`);
    return null;
  }

  // Use the model name directly from the config
  const modelName = config.translationModel;
  logger.info(
    `[Chunk ${chunk.partNumber}] Calling Claude model: ${modelName}...`
  );

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: modelName,
      max_tokens: 4096, // Max output tokens for Claude 3.5 Sonnet
      temperature: 0.7, // Adjust temperature as needed
      messages: [
        {
          role: "user",
          content: prompt, // Pass the generated prompt directly
        },
      ],
    });

    // Extract text content - handles potential non-text blocks gracefully
    let responseText = "";
    if (message.content && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") {
          responseText += block.text;
        }
      }
    }

    if (!responseText || responseText.trim().length === 0) {
      logger.warn(`[Chunk ${chunk.partNumber}] Claude response was empty.`);
      return null; // Treat empty response as failure
    }

    logger.debug(
      `[Chunk ${chunk.partNumber}] Received Claude response (Length: ${responseText.length}).`
    );
    return responseText;
  } catch (error: any) {
    logger.error(
      `[Chunk ${chunk.partNumber}] Claude API error: ${error.message || error}`
    );
    // Log the detailed error structure if possible
    if (error.error?.message) {
      logger.error(
        `[Chunk ${chunk.partNumber}] Claude API Error Details: ${JSON.stringify(
          error.error
        )}`
      );
    }
    return null;
  }
}
