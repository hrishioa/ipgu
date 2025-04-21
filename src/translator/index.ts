#!/usr/bin/env bun

import { join } from "path";
import { existsSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import cliProgress from "cli-progress";
import boxen from "boxen";
import type { ChunkInfo, Config, ProcessingIssue } from "../types.js";
import * as logger from "../utils/logger.js";
import {
  ensureDir,
  writeToFile,
  readJsonFromFile,
  readFromFile,
} from "../utils/file_utils.js";
import { generateTranslationPrompt } from "./prompt_generator.js";
import { callGemini } from "./gemini_translator.js";
import { callClaude } from "./claude_translator.js";

// Helper function for exponential backoff
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Processes a single chunk: generates prompt, calls LLM, handles retries, saves results.
 */
async function processTranslationChunk(
  chunk: ChunkInfo,
  config: Config,
  issues: ProcessingIssue[] // Pass issues array to append directly
): Promise<void> {
  const llmLogsDir = join(config.intermediateDir, "llm_logs");
  const responsesDir = join(config.intermediateDir, "llm_responses");
  ensureDir(llmLogsDir);
  ensureDir(responsesDir);

  // 1. Generate Prompt
  const prompt = await generateTranslationPrompt(chunk, config);
  if (!prompt) {
    chunk.status = "failed";
    chunk.error = "Failed to generate translation prompt.";
    issues.push({
      type: "PromptGenError",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
    return;
  }
  // Log prompt generation
  const requestLogPath = join(
    llmLogsDir,
    `part${chunk.partNumber.toString().padStart(2, "0")}_request.json`
  );
  await writeToFile(requestLogPath, {
    timestamp: new Date().toISOString(),
    model: config.translationModel,
    prompt,
  });
  chunk.llmRequestLogPath = requestLogPath;

  // 2. Call LLM with Retries (for API errors)
  let rawResponse: string | null = null;
  let responseLog: any = null; // To store full response object if possible
  const maxRetries = config.retries ?? 2; // Use general retries config

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    chunk.status = "translating";
    logger.debug(
      `[Chunk ${chunk.partNumber}] Attempt ${attempt}/${
        maxRetries + 1
      } to call LLM ${config.translationModel}`
    );

    try {
      if (config.translationModel.toLowerCase().includes("claude")) {
        rawResponse = await callClaude(prompt, config, chunk);
        // Note: Claude response object is already captured in callClaude error logging if needed
      } else {
        // Assume Gemini otherwise
        rawResponse = await callGemini(prompt, config, chunk);
        // TODO: Enhance callGemini to optionally return the full response object for logging?
      }

      if (rawResponse !== null) {
        logger.debug(
          `[Chunk ${chunk.partNumber}] Received successful response on attempt ${attempt}.`
        );
        break; // Success, exit retry loop
      }
      // If rawResponse is null, it means the call function logged an API error
      logger.warn(
        `[Chunk ${chunk.partNumber}] LLM call failed on attempt ${attempt}. Response was null.`
      );
    } catch (error: any) {
      // Catch unexpected errors from the call functions themselves
      logger.error(
        `[Chunk ${
          chunk.partNumber
        }] Unexpected error during LLM call attempt ${attempt}: ${
          error.message || error
        }`
      );
      rawResponse = null; // Ensure it's null on unexpected error
      // We might not have a structured response to log here
    }

    // If failed and retries remain, wait and retry
    if (attempt <= maxRetries) {
      const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff (2s, 4s, 8s...)
      logger.info(
        `[Chunk ${chunk.partNumber}] Retrying LLM call in ${
          waitTime / 1000
        }s...`
      );
      await delay(waitTime);
    } else {
      logger.error(
        `[Chunk ${chunk.partNumber}] LLM call failed after ${
          maxRetries + 1
        } attempts.`
      );
    }
  }

  // 3. Handle Final Outcome
  if (rawResponse !== null) {
    // --- Success ---
    // Save raw text response
    const responseFileName = `part${chunk.partNumber
      .toString()
      .padStart(2, "0")}_response.txt`;
    chunk.responsePath = join(responsesDir, responseFileName);
    await writeToFile(chunk.responsePath, rawResponse);

    // Save structured response log (if we captured one, primarily for Claude errors now)
    if (responseLog) {
      const responseLogPath = join(
        llmLogsDir,
        `part${chunk.partNumber.toString().padStart(2, "0")}_response.json`
      );
      await writeToFile(responseLogPath, responseLog);
      chunk.llmResponseLogPath = responseLogPath;
    }

    chunk.status = "parsing"; // Ready for the next step
    logger.info(
      `[Chunk ${chunk.partNumber}] Successfully received LLM response.`
    );
  } else {
    // --- Failure ---
    chunk.status = "failed";
    chunk.error =
      chunk.error || `LLM translation failed after ${maxRetries + 1} attempts.`;
    issues.push({
      type: "TranslationError",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    // Error was already logged during attempts
  }
}

/**
 * Main function to orchestrate translation for all chunks.
 */
export async function translate(
  chunks: ChunkInfo[],
  config: Config
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];

  // Filter chunks ready for translation (status 'prompting') OR previously failed translation attempts
  const chunksToProcess = chunks.filter((c) => {
    const needsProcessing =
      c.status === "prompting" ||
      (c.status === "failed" && c.error?.includes("LLM translation failed"));
    // Also check required inputs exist
    const inputsExist =
      c.adjustedTranscriptPath && existsSync(c.adjustedTranscriptPath);
    if (needsProcessing && !inputsExist) {
      logger.warn(
        `[Chunk ${c.partNumber}] Marked for translation but missing adjusted transcript: ${c.adjustedTranscriptPath}. Skipping.`
      );
      // Optionally change status back or add specific issue
    }
    // Also check that EITHER we force processing OR the final output (responsePath) doesn't exist
    const shouldProcess =
      config.force || !c.responsePath || !existsSync(c.responsePath);

    return needsProcessing && inputsExist && shouldProcess;
  });

  if (chunksToProcess.length === 0) {
    logger.info("No chunks require translation.");
    return { chunks, issues };
  }

  logger.info(
    `Attempting to translate ${chunksToProcess.length} chunks using ${config.translationModel}...`
  );

  // --- Progress Bar Setup ---
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
    task: "Starting translation...",
  });
  logger.setActiveMultibar(multibar);

  // --- Concurrency Control ---
  const activePromises: Promise<void>[] = [];
  const queue = [...chunksToProcess];
  const maxConcurrent =
    config.maxConcurrent > 0 ? config.maxConcurrent : queue.length;
  let processedCount = 0;

  const runNext = async () => {
    if (queue.length === 0) return;
    const chunk = queue.shift();
    if (!chunk) return;

    progressBar.update(processedCount, {
      task: `Translating chunk ${chunk.partNumber}...`,
    });
    try {
      await processTranslationChunk(chunk, config, issues);
    } catch (error: any) {
      // Catch unexpected errors from processTranslationChunk
      chunk.status = "failed";
      chunk.error = `Unexpected error during chunk translation processing: ${
        error.message || error
      }`;
      logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
      issues.push({
        type: "TranslationError",
        severity: "error",
        message: chunk.error,
        chunkPart: chunk.partNumber,
        context: error.stack,
      });
    } finally {
      processedCount++;
      progressBar.increment(1, {
        task:
          chunk.status === "failed"
            ? `Chunk ${chunk.partNumber} failed!`
            : `Chunk ${chunk.partNumber} done.`,
      });
    }
  };

  // --- Start Processing ---
  const initialTasks = Array.from(
    { length: Math.min(maxConcurrent, queue.length) },
    runNext
  );
  await Promise.all(initialTasks);

  while (processedCount < chunksToProcess.length) {
    await runNext(); // Process remaining tasks as slots open
  }

  // --- Cleanup ---
  progressBar.stop();
  multibar.stop();
  logger.setActiveMultibar(null);

  const successCount = chunks.filter((c) => c.status === "parsing").length;
  logger.info(
    `Translation step complete: ${successCount} / ${chunksToProcess.length} chunks processed successfully for translation.`
  );

  return { chunks, issues };
}

// --- CLI Logic ---

interface TranslatorCliOptions {
  chunkInfoPath: string;
  intermediateDir: string;
  translationModel?: string;
  targetLanguage?: string;
  promptTemplate?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  maxConcurrent?: number;
  retries?: number;
  logFile?: string;
  logLevel?: string;
  force?: boolean;
}

async function cliMain() {
  const program = new Command();

  program
    .name("subtitle-translator")
    .description("Generate translations for subtitle chunks using LLMs")
    .requiredOption("-i, --input <path>", "Path to chunk_info.json file")
    .requiredOption(
      "-d, --intermediate-dir <path>",
      "Path to the intermediate directory"
    )
    .option(
      "-m, --model <name>",
      "LLM model for translation (e.g., gemini-1.5-flash-latest, claude-3-5-sonnet-20240620)"
    )
    .option(
      "-l, --language <lang>",
      "The target language (besides English)",
      "Korean"
    )
    .option("--prompt-template <path>", "Path to custom prompt template file")
    .option("--gemini-key <key>", "Gemini API Key (overrides env)")
    .option("--anthropic-key <key>", "Anthropic API Key (overrides env)")
    .option("-c, --concurrent <number>", "Max concurrent LLM calls")
    .option("-r, --retries <number>", "Max retries for API errors")
    .option("--log-file <path>", "Path to log file")
    .option("--log-level <level>", "Log level", "info")
    .option(
      "-f, --force",
      "Force reprocessing even if response files exist",
      false
    )
    .parse(process.argv);

  const opts = program.opts();

  logger.configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    minLogLevel: opts.logLevel || "info",
  });

  const cliOptions: TranslatorCliOptions = {
    chunkInfoPath: opts.input,
    intermediateDir: opts.intermediateDir,
    translationModel: opts.model,
    targetLanguage: opts.language,
    promptTemplate: opts.promptTemplate,
    geminiApiKey: opts.geminiKey,
    anthropicApiKey: opts.anthropicKey,
    maxConcurrent: opts.concurrent ? parseInt(opts.concurrent) : undefined,
    retries: opts.retries ? parseInt(opts.retries) : undefined,
    force: opts.force || false,
  };

  try {
    logger.info(chalk.blueBright("--- Starting Translation Step ---"));
    const chunks = await readJsonFromFile<ChunkInfo[]>(
      cliOptions.chunkInfoPath
    );
    if (!chunks) {
      logger.error(
        `Failed to load chunk info from ${cliOptions.chunkInfoPath}`
      );
      process.exit(1);
    }

    // Build partial config from CLI options
    const config: Partial<Config> = {
      intermediateDir: cliOptions.intermediateDir,
      translationModel:
        cliOptions.translationModel || "claude-3-5-sonnet-20240620", // Sensible default?
      targetLanguages: cliOptions.targetLanguage
        ? [cliOptions.targetLanguage.trim()]
        : ["Korean"],
      translationPromptTemplatePath: cliOptions.promptTemplate,
      maxConcurrent:
        cliOptions.maxConcurrent !== undefined ? cliOptions.maxConcurrent : 5,
      retries: cliOptions.retries !== undefined ? cliOptions.retries : 2,
      force: cliOptions.force,
      apiKeys: {
        gemini: cliOptions.geminiApiKey || process.env.GEMINI_API_KEY,
        anthropic: cliOptions.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
      },
      // Other config fields aren't strictly needed by this module if running standalone
    };

    // Validate necessary API keys based on model
    if (
      config.translationModel?.toLowerCase().includes("claude") &&
      !config.apiKeys?.anthropic
    ) {
      logger.error("Anthropic API key is required for Claude models.");
      process.exit(1);
    }
    if (
      !config.translationModel?.toLowerCase().includes("claude") &&
      !config.apiKeys?.gemini
    ) {
      logger.error("Gemini API key is required for non-Claude models.");
      process.exit(1);
    }

    // Run translation
    const { chunks: updatedChunks, issues } = await translate(
      chunks,
      config as Config
    );

    // --- Final Reporting ---
    logger.info(chalk.blueBright("--- Translation Report ---"));
    const successCount = updatedChunks.filter(
      (c) => c.status === "parsing"
    ).length;
    const failCount = updatedChunks.filter(
      (c) => c.status === "failed" && c.error?.includes("LLM translation")
    ).length;
    const totalProcessed = updatedChunks.filter(
      (c) =>
        c.status === "parsing" ||
        (c.status === "failed" && c.error?.includes("LLM translation"))
    ).length;

    let reportContent = "";
    reportContent += `${chalk.green("Successful Calls:")} ${successCount}
`;
    reportContent += `${chalk.red("Failed Calls:")}     ${failCount}
`;
    reportContent += `Total Attempted:    ${totalProcessed}
`;

    if (issues.length > 0) {
      reportContent += `\n${chalk.yellowBright("Issues Encountered:")} (${
        issues.length
      })\n`;
      issues.forEach((issue) => {
        const prefix =
          issue.severity === "error"
            ? chalk.red("ERROR")
            : chalk.yellow("WARN");
        reportContent += `- ${prefix}: [Chunk ${issue.chunkPart || "N/A"}] ${
          issue.message
        }\n`;
      });
    }
    console.log(
      boxen(reportContent, {
        title: "Translation Step Summary",
        padding: 1,
        margin: 1,
        borderStyle: "round",
        borderColor: "magenta",
      })
    );

    // Save updated chunk info
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
    logger.error(`Fatal translator error: ${err.message || err}`);
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
