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
import { callGemini, type GeminiCallResult } from "./gemini_translator.js";
import { callClaude, type ClaudeCallResult } from "./claude_translator.js";
import { parseTranslationResponse } from "../parser/response_parser.js";
import { validateTranslations } from "../validator/translation_validator.js";

// Helper function for exponential backoff
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Structure to hold data across retries
interface FailedAttemptData {
  attemptNum: number;
  responseText: string;
  validationIssues: ProcessingIssue[];
  parsingIssues: ProcessingIssue[];
}

/**
 * Processes a single chunk: generates prompt, calls LLM, handles retries (API & Validation), parses, validates, saves results.
 * Includes special handling for the last chunk on final validation attempt.
 */
async function processTranslationChunk(
  chunk: ChunkInfo,
  config: Config,
  issues: ProcessingIssue[],
  isLastChunk: boolean,
  // Pass accumulated failed data through recursive calls
  failedAttemptsData: FailedAttemptData[] = [],
  attemptNum: number = 1
): Promise<void> {
  const llmLogsDir = join(config.intermediateDir, "llm_logs");
  const responsesDir = join(config.intermediateDir, "llm_responses");
  const parsedDir = join(config.intermediateDir, "parsed_data");
  ensureDir(llmLogsDir);
  ensureDir(responsesDir);
  ensureDir(parsedDir);

  // 1. Generate Prompt (Only needs to happen once per chunk unless retrying the LLM call)
  // Store prompt locally in case we need to retry the LLM call
  let prompt: string | null = null;
  if (attemptNum === 1) {
    // Only generate on first attempt
    prompt = await generateTranslationPrompt(chunk, config);
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
    const requestLogPath = join(
      llmLogsDir,
      `part${chunk.partNumber
        .toString()
        .padStart(2, "0")}_request_attempt${attemptNum}.json`
    );
    await writeToFile(requestLogPath, {
      timestamp: new Date().toISOString(),
      model: config.translationModel,
      prompt,
    });
    chunk.llmRequestLogPath = requestLogPath; // Store latest request path
  } else {
    // On retry, try to reload the previously generated prompt
    const previousRequestPath = join(
      llmLogsDir,
      `part${chunk.partNumber
        .toString()
        .padStart(2, "0")}_request_attempt1.json`
    );
    if (existsSync(previousRequestPath)) {
      try {
        const reqData = await readJsonFromFile<any>(previousRequestPath);
        prompt = reqData?.prompt;
      } catch (e) {
        /* ignore if read fails */
      }
    }
    if (!prompt) {
      chunk.status = "failed";
      chunk.error = "Failed to retrieve prompt for retry.";
      issues.push({
        type: "PromptGenError",
        severity: "error",
        message: chunk.error,
        chunkPart: chunk.partNumber,
      });
      logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
      return;
    }
    logger.info(
      `[Chunk ${chunk.partNumber}] Using previously generated prompt for validation retry.`
    );
  }

  // 2. Call LLM with API Retries (Use general config.retries)
  let callResult: ClaudeCallResult | GeminiCallResult | null = null; // Updated type
  const maxApiRetries = config.retries ?? 2;
  for (let apiAttempt = 1; apiAttempt <= maxApiRetries + 1; apiAttempt++) {
    chunk.status = "translating";
    logger.debug(
      `[Chunk ${chunk.partNumber}] LLM Call Attempt ${apiAttempt}/${
        maxApiRetries + 1
      }`
    );
    let currentRawResponse: string | null = null;
    chunk.llmTranslationInputTokens = undefined; // Reset tokens for this attempt
    chunk.llmTranslationOutputTokens = undefined;

    try {
      if (config.translationModel.toLowerCase().includes("claude")) {
        callResult = await callClaude(prompt!, config, chunk);
        if (callResult) {
          currentRawResponse = callResult.responseText;
          chunk.llmTranslationInputTokens = callResult.inputTokens;
          chunk.llmTranslationOutputTokens = callResult.outputTokens;
        } else {
          currentRawResponse = null; // Ensure null if callClaude returns null
        }
      } else {
        callResult = await callGemini(prompt!, config, chunk);
        if (callResult) {
          currentRawResponse = callResult.responseText;
          chunk.llmTranslationInputTokens = callResult.inputTokens;
          chunk.llmTranslationOutputTokens = callResult.outputTokens;
        } else {
          currentRawResponse = null; // Ensure null if callGemini returns null
        }
      }

      if (currentRawResponse !== null) {
        // Check if we got text
        logger.debug(
          `[Chunk ${chunk.partNumber}] Received successful response text on attempt ${apiAttempt}.`
        );
        break; // Success, exit retry loop
      }
      logger.warn(
        `[Chunk ${chunk.partNumber}] LLM call attempt ${apiAttempt} failed (returned null text).`
      );
    } catch (error: any) {
      logger.error(
        `[Chunk ${
          chunk.partNumber
        }] Unexpected error during LLM call attempt ${apiAttempt}: ${
          error.message || error
        }`
      );
      callResult = null; // Ensure null on unexpected error
    }
    if (apiAttempt <= maxApiRetries) {
      const waitTime = Math.pow(2, apiAttempt) * 1000;
      logger.info(
        `[Chunk ${chunk.partNumber}] Retrying LLM call in ${
          waitTime / 1000
        }s...`
      );
      await delay(waitTime);
    } else {
      logger.error(
        `[Chunk ${chunk.partNumber}] LLM call failed after ${
          maxApiRetries + 1
        } API attempts.`
      );
    }
  }

  // 3. Handle LLM Call Outcome (check callResult for overall success)
  if (callResult === null || callResult.responseText === null) {
    chunk.status = "failed";
    chunk.error =
      chunk.error || `LLM call failed after ${maxApiRetries + 1} attempts.`;
    issues.push({
      type: "TranslationError",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    return; // Cannot proceed without a response
  }

  const rawResponse = callResult.responseText; // We have a valid response text now

  // --- Save raw response ---
  const responseFileName = `part${chunk.partNumber
    .toString()
    .padStart(2, "0")}_response_attempt${attemptNum}.txt`;
  chunk.responsePath = join(responsesDir, responseFileName);
  await writeToFile(chunk.responsePath, rawResponse);
  // TODO: Log structured response if possible (callResult might contain more for Claude)

  // 4. Parse Response
  logger.info(
    `[Chunk ${chunk.partNumber}] Parsing LLM response (Attempt ${attemptNum})...`
  );
  const { entries: parsedEntries, issues: parsingIssues } =
    parseTranslationResponse(
      rawResponse,
      chunk.partNumber,
      config.targetLanguages
    );
  // Add parsing issues to the main list AND store them for this attempt
  issues.push(...parsingIssues);
  const currentAttemptParsingIssues = parsingIssues;

  // 5. Validate Parsed Response
  logger.info(
    `[Chunk ${chunk.partNumber}] Validating parsed response (Attempt ${attemptNum})...`
  );
  const maxValidationRetries = config.retries ?? 1;
  const isFinalValidationAttempt = attemptNum >= maxValidationRetries + 1;
  const { isValid: isTranslationValid, validationIssues } =
    await validateTranslations(
      chunk.partNumber,
      parsedEntries,
      currentAttemptParsingIssues,
      chunk.srtChunkPath,
      config,
      isLastChunk,
      isFinalValidationAttempt // Pass flag indicating if this is the last chance
    );
  // Add validation issues to the main list AND store them for this attempt
  issues.push(...validationIssues);
  const currentAttemptValidationIssues = validationIssues;

  // 6. Handle Validation Outcome & Validation Retries
  if (isTranslationValid) {
    // --- Validation Success ---
    logger.info(
      `[Chunk ${chunk.partNumber}] Translation passed validation (Attempt ${attemptNum}).`
    );
    // Save parsed data
    const parsedFileName = `part${chunk.partNumber
      .toString()
      .padStart(2, "0")}_parsed.json`;
    chunk.parsedDataPath = join(parsedDir, parsedFileName);
    const saveSuccess = await writeToFile(chunk.parsedDataPath, parsedEntries);
    if (saveSuccess) {
      chunk.status = "completed";
    } else {
      chunk.status = "failed";
      chunk.error = `Failed to save parsed data to ${chunk.parsedDataPath}`;
      // Ensure this critical save failure is logged as an error issue
      const saveErrorIssue: ProcessingIssue = {
        type: "FormatError",
        severity: "error",
        message: chunk.error,
        chunkPart: chunk.partNumber,
      };
      issues.push(saveErrorIssue);
      logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
    }
  } else {
    // --- Validation Failure (at least one error severity issue found) ---
    // Log the specific validation errors that caused the failure
    const errorMessages = validationIssues
      .filter((vi) => vi.severity === "error")
      .map((vi) => vi.message)
      .join("; ");
    logger.warn(
      `[Chunk ${
        chunk.partNumber
      }] Translation failed validation on attempt ${attemptNum}. Reason(s): ${
        errorMessages || "See logs"
      }`
    );

    // Store the current attempt's data for potential fallback
    failedAttemptsData.push({
      attemptNum,
      responseText: rawResponse,
      validationIssues: currentAttemptValidationIssues,
      parsingIssues: currentAttemptParsingIssues,
    });

    if (attemptNum > maxValidationRetries) {
      // All validation retries exhausted
      logger.error(
        `[Chunk ${chunk.partNumber}] Translation failed validation after ${attemptNum} attempts.`
      );

      // Special handling for last chunk - use the longest response if this is the last chunk
      if (isLastChunk && failedAttemptsData.length > 0) {
        logger.warn(
          `[Chunk ${chunk.partNumber}] This is the last chunk and all validation attempts failed. Finding longest usable response...`
        );

        // Find the response with the most successfully parsed entries
        let bestAttempt = failedAttemptsData[0];
        let maxEntryCount = parsedEntries.length;

        for (const attempt of failedAttemptsData) {
          const attemptEntries = parseTranslationResponse(
            attempt.responseText,
            chunk.partNumber,
            config.targetLanguages
          ).entries;

          if (attemptEntries.length > maxEntryCount) {
            maxEntryCount = attemptEntries.length;
            bestAttempt = attempt;
          }
        }

        logger.info(
          `[Chunk ${chunk.partNumber}] Using best failed attempt (attempt ${bestAttempt.attemptNum}) with ${maxEntryCount} entries as fallback.`
        );

        // Re-parse the best attempt
        const bestParsedResponse = parseTranslationResponse(
          bestAttempt.responseText,
          chunk.partNumber,
          config.targetLanguages
        );

        // Save the best attempt's parsed data
        const parsedFileName = `part${chunk.partNumber
          .toString()
          .padStart(2, "0")}_parsed.json`;
        chunk.parsedDataPath = join(parsedDir, parsedFileName);
        const saveSuccess = await writeToFile(
          chunk.parsedDataPath,
          bestParsedResponse.entries
        );

        if (saveSuccess) {
          chunk.status = "completed";
          logger.info(
            `[Chunk ${chunk.partNumber}] Saved fallback response for the last chunk.`
          );
        } else {
          chunk.status = "failed";
          chunk.error = `Failed to save parsed data to ${chunk.parsedDataPath}`;
          issues.push({
            type: "FormatError",
            severity: "error",
            message: chunk.error,
            chunkPart: chunk.partNumber,
          });
          logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
        }
      } else {
        // Not the last chunk or no failed attempts data available
        chunk.status = "failed";
        chunk.error =
          chunk.error ||
          `Validation failed after ${attemptNum} attempts: ${
            errorMessages || "Unknown"
          }`;
        // Ensure a final error issue is present if somehow missed
        if (
          !issues.some(
            (i) =>
              i.chunkPart === chunk.partNumber &&
              i.severity === "error" &&
              i.type === "ValidationError"
          )
        ) {
          issues.push({
            type: "ValidationError",
            severity: "error",
            message: chunk.error,
            chunkPart: chunk.partNumber,
          });
        }
      }
    } else {
      logger.info(
        `[Chunk ${
          chunk.partNumber
        }] Retrying translation LLM call due to validation failure (${
          maxValidationRetries - attemptNum + 1
        } total attempts, ${
          maxValidationRetries - attemptNum
        } retries remaining)...`
      );
      // Recursive call - MAKE SURE TO PASS isLastChunk ALONG!
      await processTranslationChunk(
        chunk,
        config,
        issues,
        isLastChunk,
        failedAttemptsData,
        attemptNum + 1
      );
    }
  }
}

/**
 * Main orchestrator function for the translation step.
 */
export async function translate(
  chunks: ChunkInfo[],
  config: Config
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];
  const parsedDataDir = join(config.intermediateDir, "parsed_data");

  let chunksToProcess = chunks.filter((c) => {
    // --- Filter Logic Re-Refined ---

    // 1. Check required inputs (essential)
    const inputsExist =
      c.adjustedTranscriptPath && existsSync(c.adjustedTranscriptPath);
    if (!inputsExist) {
      logger.warn(
        `[Chunk ${c.partNumber}] Missing adjusted transcript: ${c.adjustedTranscriptPath}. Skipping translation.`
      );
      return false;
    }

    // 2. If forced, process regardless of output existence
    if (config.force) {
      logger.debug(
        `[Chunk ${c.partNumber}] Force processing enabled for translation.`
      );
      // Still check if status is valid to start from
      if (c.status === "prompting" || c.status === "failed") {
        return true;
      } else {
        logger.warn(
          `[Chunk ${c.partNumber}] Force processing enabled, but chunk status is ${c.status} (expected prompting/failed). Skipping.`
        );
        return false;
      }
    }

    // 3. If not forced, check if final output (parsed data) already exists
    const parsedPath =
      c.parsedDataPath ||
      join(
        parsedDataDir,
        `part${c.partNumber.toString().padStart(2, "0")}_parsed.json`
      );
    if (existsSync(parsedPath)) {
      logger.debug(
        `[Chunk ${c.partNumber}] Skipping translation: Output parsed file already exists (${parsedPath}) and force not enabled.`
      );
      // Ensure status reflects completion if skipped
      if (c.status !== "completed") {
        c.status = "completed"; // Mark as completed if output exists
      }
      return false;
    }

    // 4. If not forced and output missing, check status is ready for processing
    const needsProcessingStatus =
      c.status === "prompting" ||
      (c.status === "failed" && c.error?.includes("LLM translation")) ||
      (c.status === "failed" &&
        c.error?.includes("Translation validation failed"));

    if (needsProcessingStatus) {
      logger.debug(
        `[Chunk ${c.partNumber}] Output missing and status (${c.status}) indicates processing needed.`
      );
      return true; // Process
    } else {
      logger.warn(
        `[Chunk ${c.partNumber}] Output missing, but status is ${c.status} (expected prompting or failed). Skipping.`
      );
      return false; // Skip if status isn't ready
    }
  });

  // Further filter if processOnlyPart is specified (applied after main filter)
  if (config.processOnlyPart !== undefined) {
    const originalCount = chunksToProcess.length;
    chunksToProcess = chunksToProcess.filter(
      (c) => c.partNumber === config.processOnlyPart
    );
    logger.debug(
      `Filtered down to ${chunksToProcess.length} chunk(s) based on --part ${config.processOnlyPart} (from ${originalCount}).`
    );
  }

  if (chunksToProcess.length === 0) {
    logger.info(
      "No chunks require translation (based on status, file existence, and part filter)."
    );
    return { chunks, issues };
  }

  logger.info(
    `Attempting to translate ${chunksToProcess.length} chunks using ${config.translationModel}...`
  );

  // --- Progress Bar Setup ---
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
  const progressBar = multibar.create(chunksToProcess.length, 0, {
    task: "Starting translation...",
    elapsed: "0.0",
  });
  logger.setActiveMultibar(multibar);

  // Update timer to 100ms
  intervalId = setInterval(() => {
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    progressBar.update({ elapsed: elapsedSeconds });
  }, 100);

  // --- Refactored Concurrency Control ---
  const queue = [...chunksToProcess]; // Copy chunks to process into a queue
  const maxConcurrent =
    config.maxConcurrent > 0 ? config.maxConcurrent : queue.length;
  const activePromises: Promise<void>[] = [];
  let processedCount = 0;

  // --- Determine Last Chunk Number ---
  const lastChunkNumber =
    chunksToProcess.length > 0
      ? Math.max(...chunksToProcess.map((c) => c.partNumber))
      : -1; // Handle edge case of no chunks to process
  logger.debug(
    `Last chunk number identified for processing: ${lastChunkNumber}`
  );

  // Function to start the next task from the queue
  const startNextTask = () => {
    if (queue.length === 0) return;
    const chunk = queue.shift();
    if (!chunk) return;

    // Determine if this is the last chunk *being processed in this run*
    const isLast = chunk.partNumber === lastChunkNumber;

    // Pass isLast flag to processTranslationChunk
    const taskPromise = processTranslationChunk(
      chunk,
      config,
      issues,
      isLast,
      [],
      1
    ).finally(() => {
      processedCount++;
      progressBar.update(processedCount, {
        task:
          chunk.status === "failed"
            ? `Chunk ${chunk.partNumber} failed!`
            : `Chunk ${chunk.partNumber} done.`,
      });
      const index = activePromises.indexOf(taskPromise);
      if (index > -1) activePromises.splice(index, 1);
      if (activePromises.length < maxConcurrent) startNextTask();
    });
    activePromises.push(taskPromise);
  };

  // Start initial batch of workers
  for (let i = 0; i < Math.min(maxConcurrent, queue.length); i++) {
    startNextTask();
  }

  // Wait for all promises to settle (this replaces the old loop)
  // We need a mechanism to wait until queue is empty AND activePromises is empty
  while (activePromises.length > 0 || queue.length > 0) {
    // If there's capacity and items in queue, start more tasks
    while (activePromises.length < maxConcurrent && queue.length > 0) {
      startNextTask();
    }
    // If no capacity or queue empty, wait for *any* active task to finish
    if (activePromises.length > 0) {
      await Promise.race(activePromises);
    }
    // Loop continues, checking capacity and queue again
  }
  // At this point, queue is empty and all active promises have resolved/rejected

  // --- Cleanup ---
  if (intervalId) clearInterval(intervalId); // Clear timer
  progressBar.stop();
  multibar.stop();
  logger.setActiveMultibar(null);

  // Status 'completed' indicates success for this module now
  const successCount = chunks.filter((c) => c.status === "completed").length;
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
  processOnlyPart?: number;
  disableTimingValidation?: boolean;
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
    .option(
      "-r, --retries <number>",
      "Max retries for API errors AND validation failures",
      "2"
    )
    .option("--log-file <path>", "Path to log file")
    .option("--log-level <level>", "Log level", "info")
    .option(
      "-f, --force",
      "Force reprocessing even if parsed data files exist",
      false
    )
    .option(
      "--no-timing-check",
      "Disable subtitle timing validation checks",
      false
    )
    .option("-P, --part <number>", "Process only a specific part number")
    .parse(process.argv);

  const opts = program.opts();

  logger.configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    consoleLogLevel: opts.logLevel || "info",
    // fileLogLevel defaults to debug if logToFile is true
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
    processOnlyPart: opts.part ? parseInt(opts.part) : undefined,
    disableTimingValidation: opts.noTimingCheck || false,
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
      disableTimingValidation: cliOptions.disableTimingValidation,
      apiKeys: {
        gemini: cliOptions.geminiApiKey || process.env.GEMINI_API_KEY,
        anthropic: cliOptions.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
      },
      processOnlyPart: cliOptions.processOnlyPart,
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
    const { chunks: updatedChunksFromRun, issues: runIssues } = await translate(
      chunks,
      config as Config
    );

    // --- Filter results for reporting based on what was *intended* to run ---
    const targetedChunks =
      config.processOnlyPart !== undefined
        ? updatedChunksFromRun.filter(
            (c) => c.partNumber === config.processOnlyPart
          )
        : updatedChunksFromRun;

    const targetedChunkNumbers = targetedChunks.map((c) => c.partNumber);

    // Filter issues relevant to the processed chunks
    const relevantIssues = runIssues.filter(
      (i) =>
        i.chunkPart === undefined || targetedChunkNumbers.includes(i.chunkPart)
    );

    // --- Final Reporting (Based on targeted chunks) ---
    logger.info(chalk.blueBright("--- Translation Step Report ---"));
    const successCount = targetedChunks.filter(
      (c) => c.status === "completed"
    ).length;
    const failCount = targetedChunks.filter(
      (c) => c.status === "failed"
    ).length;
    const totalProcessed = targetedChunks.length; // Count only those filtered by --part if applicable

    let reportContent = "";
    reportContent += `${chalk.green(
      "Successful Chunks:"
    )} ${successCount} / ${totalProcessed}
`;
    reportContent += `${chalk.red(
      "Failed Chunks:"
    )}     ${failCount} / ${totalProcessed}
`;
    reportContent += `\n${chalk.yellowBright(
      "Issues Encountered During This Run:"
    )} (${relevantIssues})\n`;

    if (relevantIssues.length > 0) {
      reportContent += `\n${chalk.yellowBright(
        "Issues Encountered During This Run:"
      )} (${relevantIssues.length})\n`;
      relevantIssues.forEach((issue) => {
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

    // Save the *full* updated chunk info array (includes state of non-processed chunks)
    const saveSuccess = await writeToFile(
      cliOptions.chunkInfoPath,
      updatedChunksFromRun
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

    // Determine exit code based on the success/failure of *targeted* chunks
    const targetedFailed = targetedChunks.some((c) => c.status === "failed");
    process.exit(targetedFailed ? 1 : 0);
  } catch (err: any) {
    logger.error(`Fatal translator error: ${err.message || err}`, err.stack);
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
