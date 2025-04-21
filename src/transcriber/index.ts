#!/usr/bin/env bun

import { join, basename } from "path";
import { existsSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import cliProgress from "cli-progress";
import type { ChunkInfo, Config, ProcessingIssue } from "../types";
import * as logger from "../utils/logger";
import { ensureDir, writeToFile, readJsonFromFile } from "../utils/file_utils";
import { transcribeChunk } from "./gemini_transcriber";
import { adjustTranscriptTimestamps } from "../utils/transcript_utils";
import boxen from "boxen";

/**
 * Transcribes multiple media chunks based on ChunkInfo.
 *
 * @param chunks Array of ChunkInfo objects (from splitter).
 * @param config Pipeline configuration.
 * @returns Promise resolving to updated chunks and any issues encountered.
 */
export async function transcribe(
  chunks: ChunkInfo[],
  config: Config
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];

  // Define directory paths
  const transcriptDir = join(config.intermediateDir, "transcripts");
  const rawTranscriptDir = join(config.intermediateDir, "raw_llm_transcripts");
  ensureDir(transcriptDir); // For adjusted transcripts
  ensureDir(rawTranscriptDir); // For raw LLM output

  // --- Identify Chunks Requiring Actual Processing ---
  const chunksNeedingProcessing: ChunkInfo[] = [];
  const chunksToSkip: ChunkInfo[] = [];

  for (const chunk of chunks) {
    const mediaPath = chunk.mediaChunkPath;
    if (!mediaPath || !existsSync(mediaPath)) {
      logger.warn(
        `[Chunk ${chunk.partNumber}] Skipping transcription: Input media file missing (${mediaPath}).`
      );
      // Keep its existing status or mark as failed?
      if (chunk.status !== "failed") chunk.status = "failed"; // Mark failed if input missing
      chunk.error = `Input media missing: ${mediaPath}`;
      issues.push({
        type: "TranscriptionError",
        severity: "error",
        message: chunk.error,
        chunkPart: chunk.partNumber,
      });
      chunksToSkip.push(chunk); // Add to skip list for clarity
      continue; // Skip this chunk
    }

    if (config.force) {
      logger.debug(
        `[Chunk ${chunk.partNumber}] Force processing enabled for transcription.`
      );
      chunksNeedingProcessing.push(chunk);
      continue;
    }

    const adjustedPath =
      chunk.adjustedTranscriptPath ||
      join(
        transcriptDir,
        `part${chunk.partNumber.toString().padStart(2, "0")}_adjusted.txt`
      );

    if (existsSync(adjustedPath)) {
      if (chunk.status === "failed") {
        logger.debug(
          `[Chunk ${chunk.partNumber}] Output exists, but reprocessing due to failed status.`
        );
        chunksNeedingProcessing.push(chunk);
      } else {
        logger.debug(
          `[Chunk ${chunk.partNumber}] Skipping transcription: Adjusted transcript already exists (${adjustedPath}) and status is not 'failed'.`
        );
        // *** IMPORTANT: Populate path and set status ***
        chunk.adjustedTranscriptPath = adjustedPath;
        if (chunk.status !== "completed" && chunk.status !== "prompting") {
          chunk.status = "prompting"; // Assume successful if output exists and not failed
        }
        chunksToSkip.push(chunk); // Add to skip list
      }
    } else {
      logger.debug(
        `[Chunk ${chunk.partNumber}] Output adjusted transcript missing. Processing.`
      );
      chunksNeedingProcessing.push(chunk);
    }
  }

  // Filter based on processOnlyPart *after* initial checks
  let finalChunksToProcess = chunksNeedingProcessing;
  if (config.processOnlyPart !== undefined) {
    finalChunksToProcess = chunksNeedingProcessing.filter(
      (c) => c.partNumber === config.processOnlyPart
    );
    // Also filter skip list if only processing one part, though less critical
    // chunksToSkip = chunksToSkip.filter(c => c.partNumber === config.processOnlyPart);
  }

  if (finalChunksToProcess.length === 0) {
    logger.info(
      "No chunks require active transcription processing (based on status, file existence, and part filter)."
    );
    // Return the original chunks array, as its stati were updated for skipped items
    return { chunks, issues };
  }

  if (!config.apiKeys.gemini) {
    logger.error("Missing Gemini API key..."); /* ... */
    // Mark ONLY the chunks we were trying to process as failed
    finalChunksToProcess.forEach((c) => {
      c.status = "failed";
      c.error = "Missing Gemini API key";
    });
    return { chunks, issues }; // Return the full chunk list with updated stati
  }

  logger.info(
    `Attempting to transcribe/reprocess ${finalChunksToProcess.length} chunks using ${config.transcriptionModel}...`
  );

  // --- Progress Bar Setup (Based on count needing processing) ---
  const startTime = Date.now();
  let intervalId: Timer | null = null;
  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: `${chalk.cyan(
        "{bar}"
      )} | {percentage}% | {value}/{total} Chunks | ETA: {eta_formatted} | Elapsed: {elapsed}s | ${chalk.gray(
        "{task}"
      )}`,
    },
    cliProgress.Presets.shades_classic
  );
  const progressBar = multibar.create(finalChunksToProcess.length, 0, {
    task: "Starting transcription...",
    elapsed: "0.0",
  });
  logger.setActiveMultibar(multibar);

  // Update timer to 100ms
  intervalId = setInterval(() => {
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    progressBar.update({ elapsed: elapsedSeconds });
  }, 100);

  // --- Concurrency Control (Operate on finalChunksToProcess) ---
  const queue = [...finalChunksToProcess]; // Use the filtered list
  const maxConcurrent =
    config.maxConcurrent > 0 ? config.maxConcurrent : queue.length;
  const activePromises: Promise<void>[] = [];
  let processedCount = 0;

  const startNextTranscribeTask = () => {
    if (queue.length === 0) return;
    const chunk = queue.shift(); // Get chunk from the filtered queue
    if (!chunk) return;

    // Reset status for this attempt (important for retries)
    chunk.status = "transcribing";
    chunk.error = undefined;
    // Clear paths that will be reset on success/failure
    chunk.rawTranscriptPath = undefined;
    chunk.adjustedTranscriptPath = undefined;
    chunk.failedTranscriptPath = undefined;

    progressBar.update(processedCount, {
      task: `Transcribing chunk ${chunk.partNumber}...`,
    });

    const taskPromise = (async () => {
      // Call transcribeChunk, which handles validation/retries internally
      const { transcript: rawTranscript, issues: chunkIssues } =
        await transcribeChunk(chunk, config);
      issues.push(...chunkIssues); // Add issues from this specific chunk processing

      if (rawTranscript !== null) {
        // *** Success Path ***
        const rawFileName = `part${chunk.partNumber
          .toString()
          .padStart(2, "0")}_raw.txt`;
        chunk.rawTranscriptPath = join(rawTranscriptDir, rawFileName);
        await writeToFile(chunk.rawTranscriptPath, rawTranscript);
        // ... (Adjust timestamps) ...
        const adjustedTranscript = adjustTranscriptTimestamps(
          rawTranscript,
          chunk.startTimeSeconds
        );
        // ... (Save adjusted) ...
        const adjustedFileName = `part${chunk.partNumber
          .toString()
          .padStart(2, "0")}_adjusted.txt`;
        chunk.adjustedTranscriptPath = join(transcriptDir, adjustedFileName);
        await writeToFile(chunk.adjustedTranscriptPath, adjustedTranscript);
        chunk.status = "prompting";
        logger.debug(`Successfully processed chunk ${chunk.partNumber}`);
      } else {
        // *** Failure Path (API error or validation failure after retries) ***
        chunk.status = "failed";
        chunk.error =
          chunk.error || "Transcription/Validation failed after retries";
        logger.warn(
          `[Chunk ${chunk.partNumber}] Failed transcription/validation.`
        );
      }
    })()
      .catch((error: any) => {
        // ... (Catch unexpected errors, update chunk status/error) ...
        if (chunk) {
          chunk.status = "failed";
          chunk.error = `Unexpected error during chunk ${
            chunk.partNumber
          } transcription/adjustment: ${error.message || error}`;
          logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
          issues.push({
            type: "TranscriptionError",
            severity: "error",
            message: chunk.error,
            chunkPart: chunk.partNumber,
            context: error.stack,
          });
        } else {
          logger.error(
            `Unexpected error during transcription processing (chunk undefined): ${
              error.message || error
            }`
          );
          issues.push({
            type: "TranscriptionError",
            severity: "error",
            message: `Unexpected transcription error: ${
              error.message || error
            }`,
            context: error.stack,
          });
        }
      })
      .finally(() => {
        processedCount++;
        progressBar.update(processedCount, {
          // Use update instead of increment for clarity
          task:
            chunk.status === "failed"
              ? `Chunk ${chunk.partNumber} failed!`
              : `Chunk ${chunk.partNumber} done.`,
        });
        const index = activePromises.indexOf(taskPromise);
        if (index > -1) activePromises.splice(index, 1);
        if (activePromises.length < maxConcurrent) startNextTranscribeTask();
      });
    activePromises.push(taskPromise);
  };

  // --- Start processing loop ---
  for (let i = 0; i < Math.min(maxConcurrent, queue.length); i++) {
    startNextTranscribeTask();
  }
  while (activePromises.length > 0 || queue.length > 0) {
    while (activePromises.length < maxConcurrent && queue.length > 0) {
      startNextTranscribeTask();
    }
    if (activePromises.length > 0) {
      await Promise.race(activePromises);
    }
  }

  // --- Cleanup ---
  if (intervalId) clearInterval(intervalId); // Clear timer
  progressBar.stop();
  multibar.stop();
  logger.setActiveMultibar(null);

  // --- Final Summary ---
  const successCount = finalChunksToProcess.filter(
    (c) => c.status === "prompting"
  ).length; // Check against processed list
  logger.info(
    `Transcription & Adjustment complete: ${successCount} / ${finalChunksToProcess.length} chunks actively processed.`
  );

  // --- IMPORTANT: Return the original full chunks array, which has updated stati ---
  return { chunks, issues };
}

// --- CLI Logic ---

interface TranscriberCliOptions {
  chunkInfoPath: string;
  intermediateDir: string; // Needed to construct transcript output path
  transcriptionModel?: string;
  geminiApiKey?: string;
  maxConcurrent?: number;
  transcriptionRetries?: number; // Add retry option
  logFile?: string;
  logLevel?: string;
  processOnlyPart?: number; // Add part option
}

async function cliMain() {
  const program = new Command();

  program
    .name("subtitle-transcriber")
    .description("Transcribe media chunks using Gemini API")
    .requiredOption(
      "-i, --input <path>",
      "Path to chunk_info.json file generated by the splitter"
    )
    .requiredOption(
      "-d, --intermediate-dir <path>",
      "Path to the intermediate directory (used for transcript output)"
    )
    .option(
      "-m, --model <name>",
      "Gemini model for transcription (overrides config)"
    )
    .option("-k, --api-key <key>", "Gemini API Key (overrides env)")
    .option(
      "-c, --concurrent <number>",
      "Max concurrent transcriptions (overrides config)"
    )
    .option("-r, --retries <number>", "Max validation retries per chunk", "1") // Add retry option
    .option("--log-file <path>", "Path to log file")
    .option(
      "--log-level <level>",
      "Log level (debug, info, warn, error)",
      "info"
    )
    .option("-P, --part <number>", "Process only a specific part number") // Add CLI option
    .parse(process.argv);

  const opts = program.opts();

  // Configure logger
  logger.configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    minLogLevel: opts.logLevel || "info",
  });

  const cliOptions: TranscriberCliOptions = {
    chunkInfoPath: opts.input,
    intermediateDir: opts.intermediateDir,
    transcriptionModel: opts.model,
    geminiApiKey: opts.apiKey,
    maxConcurrent: opts.concurrent ? parseInt(opts.concurrent) : undefined,
    transcriptionRetries: opts.retries ? parseInt(opts.retries) : undefined, // Parse retry option
    processOnlyPart: opts.part ? parseInt(opts.part) : undefined, // Parse CLI option
  };

  try {
    logger.info(chalk.blueBright("--- Starting Transcription ---"));

    // Load chunks
    const chunks = await readJsonFromFile<ChunkInfo[]>(
      cliOptions.chunkInfoPath
    );
    if (!chunks) {
      logger.error(
        `Failed to load chunk info from ${cliOptions.chunkInfoPath}`
      );
      process.exit(1);
    }
    logger.info(
      `Loaded info for ${chunks.length} chunks from ${cliOptions.chunkInfoPath}`
    );

    // Build config
    const config: Partial<Config> = {
      intermediateDir: cliOptions.intermediateDir,
      transcriptionModel:
        cliOptions.transcriptionModel || "gemini-1.5-flash-latest",
      maxConcurrent:
        cliOptions.maxConcurrent !== undefined ? cliOptions.maxConcurrent : 5,
      transcriptionRetries:
        cliOptions.transcriptionRetries !== undefined
          ? cliOptions.transcriptionRetries
          : 1, // Use CLI value or default
      apiKeys: {
        gemini: cliOptions.geminiApiKey || process.env.GEMINI_API_KEY,
      },
      processOnlyPart: cliOptions.processOnlyPart, // Pass option to config
    };

    // Check API key before proceeding
    if (!config.apiKeys?.gemini) {
      logger.error(
        "Gemini API key not found. Provide via --api-key or GEMINI_API_KEY env var."
      );
      process.exit(1);
    }

    // Run the transcription process
    // Note: Progress bar is handled *inside* the transcribe function
    const { chunks: updatedChunks, issues } = await transcribe(
      chunks,
      config as Config
    );

    // --- Final Reporting ---
    logger.info(chalk.blueBright("--- Transcription Report ---"));

    const successCount = updatedChunks.filter(
      (c) => c.status === "prompting"
    ).length;
    const failCount = updatedChunks.filter(
      (c) => c.status === "failed" && c.error?.includes("Transcription")
    ).length; // Count specific transcription failures
    const skippedCount = chunks.length - successCount - failCount;

    let reportContent = "";
    reportContent += `${chalk.green("Successful:")} ${successCount}
`;
    reportContent += `${chalk.red("Failed:")}    ${failCount}
`;
    if (skippedCount > 0) {
      reportContent += `${chalk.yellow(
        "Skipped:"
      )}   ${skippedCount} (Already processed or missing media)
`;
    }

    if (issues.length > 0) {
      reportContent += `\n${chalk.yellowBright("Issues Encountered:")} (${
        issues.length
      })\n`;
      issues.forEach((issue) => {
        const prefix =
          issue.severity === "error"
            ? chalk.red("ERROR")
            : issue.severity === "warning"
            ? chalk.yellow("WARN")
            : chalk.blue("INFO");
        reportContent += `- ${prefix}: [Chunk ${issue.chunkPart || "N/A"}] ${
          issue.message
        }\n`;
        if (
          issue.severity === "error" &&
          issue.context &&
          opts.logLevel === "debug"
        ) {
          reportContent += `  ${chalk.gray(issue.context.split("\n")[0])}\n`; // Show first line of context in debug
        }
      });
    }

    console.log(
      boxen(reportContent, {
        title: "Transcription Summary",
        padding: 1,
        margin: 1,
        borderStyle: "round",
        borderColor: "cyan",
      })
    );

    // Save the updated chunk info
    const saveSuccess = await writeToFile(
      cliOptions.chunkInfoPath,
      updatedChunks
    );
    if (saveSuccess) {
      logger.success(
        `Updated chunk info saved to: ${cliOptions.chunkInfoPath}`
      );
    } else {
      logger.error(
        `Failed to save updated chunk info to: ${cliOptions.chunkInfoPath}`
      );
    }

    process.exit(issues.some((i) => i.severity === "error") ? 1 : 0);
  } catch (err: any) {
    logger.error(`Fatal transcriber error: ${err.message || err}`);
    console.error(
      boxen(chalk.red(`Fatal Error: ${err.message || err}`), {
        padding: 1,
        margin: 1,
        borderColor: "red",
      })
    );
    process.exit(1);
  }
}

// Run main if called directly
if (import.meta.url.replace("file://", "") === Bun.main) {
  cliMain();
}
