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

  // Filter chunks that need processing
  const chunksToProcess = chunks.filter((c) => {
    // Define expected output path for adjusted transcript
    const adjustedPath = join(
      transcriptDir,
      `part${c.partNumber.toString().padStart(2, "0")}_adjusted.txt`
    );
    // Check if media exists, status allows processing, OR if the final output is missing
    return (
      c.mediaChunkPath &&
      (c.status === "transcribing" || // Never successfully transcribed
        c.status === "failed" || // Explicitly failed last time
        (c.status !== "completed" && !existsSync(adjustedPath))) // Not completed AND final output missing
    );
  });

  if (chunksToProcess.length === 0) {
    logger.info(
      "No chunks need transcription (or reprocessing based on missing files)."
    );
    return { chunks, issues };
  }

  if (!config.apiKeys.gemini) {
    logger.error(
      "Missing Gemini API key for transcription. Skipping transcription step."
    );
    issues.push({
      type: "TranscriptionError",
      severity: "error",
      message: "Missing Gemini API key",
    });
    chunksToProcess.forEach((c) => {
      c.status = "failed";
      c.error = "Missing Gemini API key";
    });
    return { chunks, issues };
  }

  logger.info(
    `Attempting to transcribe/reprocess ${chunksToProcess.length} chunks using ${config.transcriptionModel}...`
  );

  // Initialize Progress Bar
  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: `${chalk.cyan(
        "{bar}"
      )} | {percentage}% | {value}/{total} Chunks | ETA: {eta_formatted} | ${chalk.gray(
        "{task}"
      )}`,
    },
    cliProgress.Presets.shades_classic
  );
  const progressBar = multibar.create(chunksToProcess.length, 0, {
    task: "Starting transcription...",
  });
  logger.setActiveMultibar(multibar);

  // --- Refactored Concurrency Control ---
  const queue = [...chunksToProcess];
  const maxConcurrent =
    config.maxConcurrent > 0 ? config.maxConcurrent : queue.length;
  const activePromises: Promise<void>[] = [];
  let processedCount = 0;

  const startNextTranscribeTask = () => {
    if (queue.length === 0) return;
    const chunk = queue.shift();
    if (!chunk) return;

    // Reset status and error for this attempt
    chunk.status = "transcribing";
    chunk.error = undefined;
    chunk.rawTranscriptPath = undefined;
    chunk.adjustedTranscriptPath = undefined;
    chunk.failedTranscriptPath = undefined;

    progressBar.update(processedCount, {
      task: `Transcribing chunk ${chunk.partNumber}...`,
    });

    const taskPromise = (async () => {
      // Wrap core logic
      const { transcript: rawTranscript, issues: chunkIssues } =
        await transcribeChunk(chunk, config);
      issues.push(...chunkIssues);

      if (rawTranscript !== null) {
        const rawFileName = `part${chunk.partNumber
          .toString()
          .padStart(2, "0")}_raw.txt`;
        chunk.rawTranscriptPath = join(rawTranscriptDir, rawFileName);
        await writeToFile(chunk.rawTranscriptPath, rawTranscript);
        logger.debug(
          `[Chunk ${chunk.partNumber}] Saved raw transcript to ${chunk.rawTranscriptPath}`
        );

        const adjustedTranscript = adjustTranscriptTimestamps(
          rawTranscript,
          chunk.startTimeSeconds
        );
        const adjustedFileName = `part${chunk.partNumber
          .toString()
          .padStart(2, "0")}_adjusted.txt`;
        chunk.adjustedTranscriptPath = join(transcriptDir, adjustedFileName);
        await writeToFile(chunk.adjustedTranscriptPath, adjustedTranscript);
        logger.debug(
          `[Chunk ${chunk.partNumber}] Saved adjusted transcript to ${chunk.adjustedTranscriptPath}`
        );

        chunk.status = "prompting";
        logger.debug(`Successfully processed chunk ${chunk.partNumber}`);
      } else {
        chunk.status = "failed";
        chunk.error =
          chunk.error ||
          "Transcription/Validation failed after retries (check logs/failed file)";
        logger.warn(
          `[Chunk ${chunk.partNumber}] Failed transcription/validation.`
        );
      }
    })()
      .catch((error: any) => {
        // Catch unexpected errors
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

  // Start initial batch
  for (let i = 0; i < Math.min(maxConcurrent, queue.length); i++) {
    startNextTranscribeTask();
  }

  // Wait loop
  while (activePromises.length > 0 || queue.length > 0) {
    while (activePromises.length < maxConcurrent && queue.length > 0) {
      startNextTranscribeTask();
    }
    if (activePromises.length > 0) {
      await Promise.race(activePromises);
    }
  }

  // Cleanup
  progressBar.stop();
  multibar.stop();
  logger.setActiveMultibar(null);

  // --- Final Summary ---
  // Status 'prompting' indicates full success for this module
  const successCount = chunks.filter((c) => c.status === "prompting").length;
  logger.info(
    `Transcription & Adjustment complete: ${successCount} / ${chunksToProcess.length} chunks processed successfully.`
  );

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
