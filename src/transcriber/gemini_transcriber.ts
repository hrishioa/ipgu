import { GoogleGenAI } from "@google/genai";
import { existsSync } from "fs";
import { basename, join } from "path";
import type { ChunkInfo, Config, ProcessingIssue } from "../types";
import * as logger from "../utils/logger";
import { validateTranscriptTimestamps } from "../utils/transcript_utils";
import { writeToFile } from "../utils/file_utils";

const MIN_TRANSCRIPT_DURATION_S = 900; // 15 minutes
const MIN_TRANSCRIPT_LINES = 5;

// Helper to generate language string for prompt
function getLanguagePromptString(languages?: string[]): string {
  if (!languages || languages.length === 0) {
    // Default if none specified
    return "in the original spoken language(s)";
  }
  if (languages.length === 1) {
    return `in ${languages[0]}`;
  }
  // Format like "likely lang1, maybe some lang2 or lang3"
  const lastLang = languages[languages.length - 1];
  const initialLangs = languages.slice(0, -1).join(", ");
  return `in the original spoken language(s) (likely ${initialLangs}, maybe some ${lastLang})`;
}

/**
 * Attempts to transcribe a chunk, validates the result, and retries if necessary.
 */
export async function transcribeChunk(
  chunk: ChunkInfo,
  config: Config,
  retriesRemaining?: number
): Promise<{ transcript: string | null; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];
  const effectiveRetries = retriesRemaining ?? config.transcriptionRetries ?? 1;

  const apiKey = config.apiKeys.gemini;
  if (!apiKey) {
    issues.push({
      type: "TranscriptionError",
      severity: "error",
      message: "Missing Gemini API key for transcription.",
      chunkPart: chunk.partNumber,
    });
    return { transcript: null, issues };
  }

  if (!chunk.mediaChunkPath || !existsSync(chunk.mediaChunkPath)) {
    issues.push({
      type: "TranscriptionError",
      severity: "error",
      message: `Media chunk file not found: ${chunk.mediaChunkPath}`,
      chunkPart: chunk.partNumber,
    });
    return { transcript: null, issues };
  }

  const ai = new GoogleGenAI({ apiKey });
  let uploadedFile;
  // Define path to the *raw* transcript directory
  const rawTranscriptDir = join(config.intermediateDir, "raw_llm_transcripts");

  try {
    logger.debug(
      `[Chunk ${chunk.partNumber}] Uploading ${chunk.mediaChunkPath} (Attempt ${
        (config.transcriptionRetries ?? 1) - effectiveRetries + 1
      })...`
    );
    uploadedFile = await ai.files.upload({ file: chunk.mediaChunkPath });
    logger.debug(
      `[Chunk ${chunk.partNumber}] Uploaded ${basename(
        chunk.mediaChunkPath
      )} as ${uploadedFile.uri}`
    );

    const modelName = config.transcriptionModel;
    const modelConfig = {
      responseMimeType: "text/plain",
    };

    // Generate language part of the prompt
    const languageInstruction = getLanguagePromptString(config.sourceLanguages);

    const contents = [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType,
            },
          },
          {
            text: `Here's part of a movie I want to subtitle. Can you give me the transcript ${languageInstruction} to the best of your ability with timestamps? Don't worry about getting the timestamps correct - but transcribe all that you can. Don't think too much - just start - it's about 20 minutes.

Use this format:
relative (mm:ss - mm:ss) - (line)`,
          },
        ],
      },
    ];

    logger.debug(
      `[Chunk ${chunk.partNumber}] Transcribing using ${modelName} (Attempt ${
        (config.transcriptionRetries ?? 1) - effectiveRetries + 1
      })...`
    );
    let fullTranscript = "";
    const response = await ai.models.generateContentStream({
      model: modelName,
      config: modelConfig,
      contents,
    });

    for await (const responseChunk of response) {
      fullTranscript += responseChunk.text;
    }

    logger.debug(
      `[Chunk ${chunk.partNumber}] Finished transcription stream. Length: ${fullTranscript.length}`
    );

    const validationResult = await validateTranscriptTimestamps(
      fullTranscript,
      chunk.srtChunkPath,
      MIN_TRANSCRIPT_DURATION_S,
      MIN_TRANSCRIPT_LINES
    );

    if (!validationResult.isValid) {
      logger.warn(
        `[Chunk ${chunk.partNumber}] Initial transcription failed validation: ${validationResult.message}`
      );
      const contextMessage = validationResult.referenceSrtSpanSeconds
        ? ` (LLM Span: ${validationResult.detectedLlmSpanSeconds?.toFixed(
            1
          )}s, Ref SRT Span: ${validationResult.referenceSrtSpanSeconds?.toFixed(
            1
          )}s)`
        : ` (LLM Span: ${validationResult.detectedLlmSpanSeconds?.toFixed(
            1
          )}s)`;
      issues.push({
        type: "TranscriptionError",
        severity: "warning",
        message: `Validation failed: ${validationResult.message}${contextMessage}`,
        chunkPart: chunk.partNumber,
      });

      try {
        const failedTranscriptFile = `part${chunk.partNumber
          .toString()
          .padStart(2, "0")}_raw_transcript_FAILED.txt`;
        // Use the raw transcript directory path
        const failedPath = join(rawTranscriptDir, failedTranscriptFile);
        await writeToFile(
          failedPath,
          `--- VALIDATION FAILED ---\nReason: ${
            validationResult.message
          }${contextMessage}\nAttempt: ${
            (config.transcriptionRetries ?? 1) - effectiveRetries + 1
          }\n--- RAW TRANSCRIPT ---\n${fullTranscript}`
        );
        chunk.failedTranscriptPath = failedPath;
        logger.debug(
          `[Chunk ${chunk.partNumber}] Saved failed transcript to ${failedPath}`
        );
      } catch (saveError: any) {
        logger.error(
          `[Chunk ${chunk.partNumber}] Failed to save failed transcript: ${
            saveError.message || saveError
          }`
        );
      }

      if (effectiveRetries > 0) {
        logger.info(
          `[Chunk ${chunk.partNumber}] Retrying transcription (${effectiveRetries} retries remaining)...`
        );
        if (uploadedFile && uploadedFile.name) {
          try {
            await ai.files.delete({ name: uploadedFile.name });
          } catch (e) {
            /* Ignore delete error on retry */
          }
          uploadedFile = null;
        }
        return await transcribeChunk(chunk, config, effectiveRetries - 1);
      } else {
        logger.error(
          `[Chunk ${chunk.partNumber}] Transcription failed validation after all retries.`
        );
        const existingIssueIndex = issues.findIndex(
          (i) =>
            i.chunkPart === chunk.partNumber &&
            i.message.startsWith("Validation failed:")
        );
        if (existingIssueIndex !== -1) {
          issues[existingIssueIndex].severity = "error";
          issues[existingIssueIndex].message = `Failed validation after ${
            config.transcriptionRetries ?? 1
          } attempts: ${validationResult.message}${contextMessage}`;
        } else {
          issues.push({
            type: "TranscriptionError",
            severity: "error",
            message: `Failed validation after ${
              config.transcriptionRetries ?? 1
            } attempts: ${validationResult.message}${contextMessage}`,
            chunkPart: chunk.partNumber,
          });
        }
        return { transcript: null, issues };
      }
    } else {
      logger.debug(
        `[Chunk ${chunk.partNumber}] Transcription passed validation: ${validationResult.message}`
      );
      chunk.failedTranscriptPath = undefined;
      if (!fullTranscript || fullTranscript.trim().length < 10) {
        logger.warn(
          `[Chunk ${chunk.partNumber}] Transcription passed validation but seems empty or very short.`
        );
        issues.push({
          type: "TranscriptionError",
          severity: "warning",
          message:
            "Transcription passed validation but result is empty or unexpectedly short.",
          chunkPart: chunk.partNumber,
        });
      }
      return { transcript: fullTranscript, issues };
    }
  } catch (error: any) {
    const attemptNum =
      (config.transcriptionRetries ?? 1) - effectiveRetries + 1;
    logger.error(
      `[Chunk ${
        chunk.partNumber
      }] API error during transcription (Attempt ${attemptNum}): ${
        error.message || error
      }`
    );
    issues.push({
      type: "TranscriptionError",
      severity: "error",
      message: `API error during attempt ${attemptNum}: ${
        error.message || error
      }`,
      chunkPart: chunk.partNumber,
      context: error.stack,
    });
    return { transcript: null, issues };
  } finally {
    if (uploadedFile && uploadedFile.name) {
      try {
        logger.debug(
          `[Chunk ${chunk.partNumber}] Deleting uploaded file: ${uploadedFile.uri}`
        );
        await ai.files.delete({ name: uploadedFile.name });
      } catch (deleteError: any) {
        logger.warn(
          `[Chunk ${chunk.partNumber}] Failed to delete uploaded file ${
            uploadedFile.name
          } (${uploadedFile.uri}): ${deleteError.message || deleteError}`
        );
      }
    }
  }
}
