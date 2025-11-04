import { Anthropic } from "@anthropic-ai/sdk";
import type { Config, ChunkInfo } from "../types.js";
import * as logger from "../utils/logger.js";

/**
 * Result structure for Claude calls, including tokens.
 */
export interface ClaudeCallResult {
  responseText: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Sends a prompt to a Claude model using streaming and returns the text response and token counts.
 *
 * @param prompt The complete prompt string.
 * @param config Pipeline configuration (for API key and model name).
 * @param chunk The current chunk (for logging context).
 * @returns A promise resolving to a ClaudeCallResult object or null if a fatal error occurs.
 */
export async function callClaude(
  prompt: string,
  config: Config,
  chunk: ChunkInfo
): Promise<ClaudeCallResult | null> {
  const apiKey = config.apiKeys.anthropic;
  if (!apiKey) {
    logger.error(`[Chunk ${chunk.partNumber}] Missing Anthropic API key.`);
    return null;
  }

  const modelName = config.translationModel;
  logger.info(
    `[Chunk ${chunk.partNumber}] Calling Claude model (stream): ${modelName}...`
  );

  let responseText = "";
  let inputTokens: number | undefined = undefined;
  let outputTokens: number | undefined = undefined;

  try {
    const client = new Anthropic({ apiKey });

    const stream = client.messages.stream({
      model: modelName,
      max_tokens: 64000, // Increased from typical 4096 to allow longer outputs
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      thinking: {
        type: "enabled",
        budget_tokens: 10000, // Increased thinking budget
      },
      // Beta features like 'thinking' might not be available/needed for the standard stream,
      // omit them unless specifically required and tested with the stream endpoint.
    });

    // Listen for text delta events to build the response
    stream.on("text", (textDelta) => {
      responseText += textDelta;
      // Optional: Indicate progress (e.g., logger.debug incremental length)
    });

    // Remove intermediate token listeners
    // stream.on('messageStart', (message) => { /* ... */ });
    // stream.on('messageStop', (message) => { /* ... */ });

    stream.on("error", (error) => {
      logger.error(
        `[Chunk ${chunk.partNumber}] Claude stream error event: ${
          error.message || error
        }`
      );
      // This might trigger the outer catch block anyway
    });

    // Wait for the stream to complete and get the final message object
    const finalMessage = await stream.finalMessage();

    // Extract final token counts from finalMessage.usage
    if (finalMessage.usage) {
      if (finalMessage.usage.input_tokens)
        inputTokens = finalMessage.usage.input_tokens;
      if (finalMessage.usage.output_tokens)
        outputTokens = finalMessage.usage.output_tokens;
      logger.debug(
        `[Chunk ${chunk.partNumber}] Claude Final Tokens - Input: ${inputTokens}, Output: ${outputTokens}`
      );
    }

    if (!responseText || responseText.trim().length === 0) {
      logger.warn(
        `[Chunk ${chunk.partNumber}] Claude stream response was empty.`
      );
      // Return empty response but potentially with token counts
      return { responseText: null, inputTokens, outputTokens };
    }

    logger.debug(
      `[Chunk ${chunk.partNumber}] Received Claude stream response (Length: ${responseText.length}).`
    );
    return { responseText, inputTokens, outputTokens };
  } catch (error: any) {
    logger.error(
      `[Chunk ${
        chunk.partNumber
      }] Claude API error during stream setup or finalization: ${
        error.message || error
      }`
    );
    if (error.error?.message) {
      logger.error(
        `[Chunk ${chunk.partNumber}] Claude API Error Details: ${JSON.stringify(
          error.error
        )}`
      );
    }
    return null; // Indicate fatal error
  }
}
