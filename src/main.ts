#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import boxen from "boxen"; // Import boxen
import type {
  Config,
  ChunkInfo,
  ProcessingIssue,
  PipelineReport,
  CostBreakdown,
} from "./types.js";
import * as logger from "./utils/logger.js";
import { ensureDir } from "./utils/file_utils.js";
import { split } from "./splitter/index.js";
import { transcribe } from "./transcriber/index.js";
import { translate } from "./translator/index.js"; // Import the new translator function
import { finalize } from "./finalizer/index.js"; // Import finalizer
import { calculateCost, MODEL_COSTS } from "./config/models.js"; // Import cost data
import { getVideoDuration } from "./splitter/video_splitter.js"; // Need duration for cost/min

/**
 * Subtitle Pipeline main entry point
 */
async function main() {
  const program = new Command();

  program
    .name("subtitle-pipeline")
    .description("End-to-end subtitle translation pipeline")
    .version("1.0.0")
    .requiredOption("-v, --video <path>", "Path to video file")
    .option("-s, --srt <path>", "Path to reference SRT subtitle file")
    .option(
      "-o, --output <dir>",
      "Output directory for final subtitles",
      "./output"
    )
    .option(
      "-i, --intermediate <dir>",
      "Directory to store intermediate files",
      "./intermediate"
    )
    .option(
      "--source-languages <langs>",
      "Comma-separated source languages in video (e.g., ml,ta)"
    )
    .option(
      "-l, --target-language <lang>",
      "The target language (besides English)",
      "Korean"
    )
    .option(
      "-tm, --transcription-model <model>",
      "Model for transcription",
      "gemini-1.5-flash-latest"
    )
    .option(
      "-tl, --translation-model <model>",
      "Model for translation",
      "claude-3-5-sonnet-20240620" // Default translation model
    )
    .option(
      "--translation-prompt-template <path>", // Option for template
      "Path to custom translation prompt template file (uses default if not set)"
    )
    .option(
      "-d, --chunk-duration <seconds>",
      "Chunk duration in seconds",
      "1200"
    )
    .option("-o, --chunk-overlap <seconds>", "Chunk overlap in seconds", "300")
    .option("-f, --chunk-format <format>", "Chunk format (mp3 or mp4)", "mp3")
    .option("-c, --max-concurrent <number>", "Max concurrent processes", "5") // Default 5
    .option(
      "-r, --retries <number>",
      "Number of retries for general API calls (not transcription validation)",
      "2"
    )
    .option(
      "--transcription-retries <number>",
      "Number of retries for transcription validation failure",
      "1"
    )
    .option(
      "--force",
      "Force reprocessing even if intermediate files exist",
      false
    )
    .option(
      "--gemini-api-key <key>",
      "Gemini API key (or use GEMINI_API_KEY env var)"
    )
    .option(
      "--anthropic-api-key <key>",
      "Anthropic API key (or use ANTHROPIC_API_KEY env var)"
    )
    .option("--log-file <path>", "Path to log file")
    .option(
      "--log-level <level>",
      "Log level (debug, info, warn, error)",
      "info"
    )
    .option(
      "--no-timing-check",
      "Disable subtitle timing validation checks",
      false
    )
    .option("-P, --part <number>", "Process only a specific part number")
    .option(
      "--use-response-timings",
      "Use timings parsed from LLM instead of original SRT",
      false
    )
    .option(
      "--mark-fallbacks",
      "Add [Original] marker to fallback subtitles",
      true
    )
    .option(
      "--colors <eng,tgt>",
      "Set subtitle colors (hex, e.g., FFFFFF,00FFFF)"
    )
    .option(
      "--output-offset <seconds>",
      "Add offset (in seconds, can be negative) to final subtitle timings"
    )
    .option(
      "--input-offset <seconds>",
      "Apply offset (in seconds, can be negative) to input SRT timings"
    )
    .parse();

  const opts = program.opts();

  // Configure logger
  logger.configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    // Pass console level from CLI, default file level remains debug
    consoleLogLevel: opts.logLevel || "info",
    // fileLogLevel will default to 'debug' inside configureLogger if logToFile is true
  });

  try {
    // Parse colors
    let engColor: string | undefined;
    let tgtColor: string | undefined;
    if (opts.colors) {
      [engColor, tgtColor] = opts.colors
        .split(",")
        .map((c: string) => c.trim());
    }

    // Build configuration
    const config: Config = {
      videoPath: opts.video,
      srtPath: opts.srt,
      outputDir: opts.output,
      intermediateDir: opts.intermediate,
      sourceLanguages: opts.sourceLanguages
        ? opts.sourceLanguages.split(",").map((lang: string) => lang.trim())
        : undefined,
      targetLanguages: [opts.targetLanguage.trim()],
      translationPromptTemplatePath: opts.translationPromptTemplate,
      transcriptionModel: opts.transcriptionModel,
      translationModel: opts.translationModel,
      chunkDuration: parseInt(opts.chunkDuration),
      chunkOverlap: parseInt(opts.chunkOverlap),
      chunkFormat: opts.chunkFormat === "mp4" ? "mp4" : "mp3",
      maxConcurrent: parseInt(opts.maxConcurrent),
      retries: parseInt(opts.retries),
      transcriptionRetries: parseInt(opts.transcriptionRetries),
      force: opts.force,
      apiKeys: {
        gemini: opts.geminiApiKey || process.env.GEMINI_API_KEY,
        anthropic: opts.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
      },
      outputOffsetSeconds: opts.outputOffset
        ? parseFloat(opts.outputOffset)
        : 0,
      inputOffsetSeconds: opts.inputOffset ? parseFloat(opts.inputOffset) : 0,
      processOnlyPart: opts.part ? parseInt(opts.part) : undefined,
      disableTimingValidation: opts.noTimingCheck || false,
      useResponseTimings: opts.useResponseTimings || false,
      markFallbacks:
        opts.markFallbacks !== undefined ? opts.markFallbacks : true,
      subtitleColorEnglish: engColor,
      subtitleColorTarget: tgtColor,
    };

    // Validate configuration
    if (!existsSync(config.videoPath)) {
      logger.error(`Video file does not exist: ${config.videoPath}`);
      process.exit(1);
    }
    if (config.srtPath && !existsSync(config.srtPath)) {
      logger.warn(`Reference SRT file does not exist: ${config.srtPath}`);
    }
    if (!config.apiKeys.gemini) {
      logger.error(
        "Gemini API key is required for transcription. Provide via --gemini-api-key or GEMINI_API_KEY env var."
      );
      process.exit(1);
    }
    // Validate translation keys
    if (
      config.translationModel?.toLowerCase().includes("claude") &&
      !config.apiKeys?.anthropic
    ) {
      logger.error(
        "Anthropic API key is required for configured Claude translation model."
      );
      process.exit(1);
    }
    if (
      !config.translationModel?.toLowerCase().includes("claude") &&
      !config.apiKeys?.gemini
    ) {
      logger.error(
        "Gemini API key is required for configured non-Claude translation model."
      );
      process.exit(1);
    }

    // Create directories
    ensureDir(config.outputDir);
    ensureDir(config.intermediateDir);

    // Start the pipeline
    const pipelineStartTime = Date.now();
    logger.info("Starting subtitle translation pipeline");
    if (config.processOnlyPart !== undefined) {
      logger.info(
        chalk.magentaBright(
          `--- Processing ONLY Part ${config.processOnlyPart} ---`
        )
      );
    }
    logger.debug(
      `Configuration: ${JSON.stringify(
        { ...config, apiKeys: { gemini: "***", anthropic: "***" } },
        null,
        2
      )}`
    );
    let currentChunks: ChunkInfo[] = [];
    const allIssues: ProcessingIssue[] = [];
    let videoDuration: number | null = null; // Store video duration

    // --- Cost Tracking Initialization ---
    const costBreakdown: CostBreakdown = {
      totalCost: 0,
      transcriptionCost: 0,
      translationCost: 0,
      costPerModel: {},
      warnings: [],
    };

    // --- Step 1: Split ---
    logger.info(chalk.blueBright("--- Step 1: Splitting Inputs ---"));
    videoDuration = await getVideoDuration(config.videoPath);
    if (!videoDuration) {
      logger.warn(
        "Could not determine video duration. Cost per minute will be unavailable."
      );
    }
    const splitResult = await split({
      videoPath: config.videoPath,
      srtPath: config.srtPath,
      outputDir: config.intermediateDir,
      chunkDuration: config.chunkDuration,
      chunkOverlap: config.chunkOverlap,
      chunkFormat: config.chunkFormat,
      maxConcurrent: config.maxConcurrent,
      force: config.force,
      processOnlyPart: config.processOnlyPart,
    });
    currentChunks = splitResult.chunks;
    allIssues.push(...splitResult.issues);
    if (currentChunks.filter((c) => c.status !== "failed").length === 0) {
      logger.error("Splitting failed for all chunks. Aborting pipeline.");
      // TODO: Add final report generation here
      process.exit(1);
    }

    // Filter chunks early if processOnlyPart is set
    let relevantChunks = currentChunks;
    if (config.processOnlyPart !== undefined) {
      relevantChunks = currentChunks.filter(
        (c) => c.partNumber === config.processOnlyPart
      );
      if (relevantChunks.length === 0) {
        logger.error(
          `Specified part ${config.processOnlyPart} not found after splitting. Aborting.`
        );
        process.exit(1);
      }
      logger.info(
        `Focusing on ${relevantChunks.length} chunk(s) for part ${config.processOnlyPart}.`
      );
    }

    // --- Step 2: Transcribe & Adjust ---
    logger.info(
      chalk.blueBright("--- Step 2: Transcription & Timestamp Adjustment ---")
    );
    const transcribeResult = await transcribe(relevantChunks, config);
    allIssues.push(...transcribeResult.issues);
    // --- Merge Step 2 Results ---
    currentChunks = currentChunks.map((originalChunk) => {
      const updated = transcribeResult.chunks.find(
        (tc) => tc.partNumber === originalChunk.partNumber
      );
      return updated || originalChunk; // Return updated chunk if found, else original
    });
    // Update relevantChunks based on the *merged* currentChunks
    relevantChunks =
      config.processOnlyPart !== undefined
        ? currentChunks.filter((c) => c.partNumber === config.processOnlyPart)
        : currentChunks;
    // --- End Merge ---
    if (relevantChunks.filter((c) => c.status === "prompting").length === 0) {
      logger.error(
        "Transcription/Adjustment failed for all targeted chunks. Aborting pipeline."
      );
      process.exit(1);
    }

    // --- Calculate Transcription Costs ---
    logger.debug("Calculating transcription costs...");
    let transcriptionTokensFound = false;
    currentChunks.forEach((chunk) => {
      if (
        chunk.llmTranscriptionInputTokens !== undefined &&
        chunk.llmTranscriptionOutputTokens !== undefined
      ) {
        transcriptionTokensFound = true;
        const modelName = config.transcriptionModel;
        const cost = calculateCost(
          modelName,
          chunk.llmTranscriptionInputTokens,
          chunk.llmTranscriptionOutputTokens
        );
        costBreakdown.transcriptionCost += cost;
        costBreakdown.totalCost += cost;
        costBreakdown.costPerModel[modelName] =
          (costBreakdown.costPerModel[modelName] || 0) + cost;
      } else {
        if (
          relevantChunks.some(
            (rc) =>
              rc.partNumber === chunk.partNumber &&
              rc.status !== "splitting" &&
              rc.status !== "pending"
          )
        ) {
          const warnMsg = `Token count unavailable for transcription model: ${config.transcriptionModel}`;
          if (!costBreakdown.warnings.includes(warnMsg)) {
            costBreakdown.warnings.push(warnMsg);
          }
        }
      }
    });
    if (!transcriptionTokensFound && relevantChunks.length > 0) {
      logger.warn(
        "Could not find transcription token counts for any processed chunks."
      );
    }
    // --- End Cost Calculation ---
    relevantChunks =
      config.processOnlyPart !== undefined
        ? currentChunks.filter((c) => c.partNumber === config.processOnlyPart)
        : currentChunks;
    if (relevantChunks.filter((c) => c.status === "prompting").length === 0) {
      logger.error(
        "Transcription/Adjustment failed for all targeted chunks. Aborting pipeline."
      );
      process.exit(1);
    }

    // --- Step 3: Translate ---
    logger.info(chalk.blueBright("--- Step 3: Generating Translations ---"));
    const translateResult = await translate(relevantChunks, config);
    allIssues.push(...translateResult.issues);
    // --- Merge Step 3 Results ---
    currentChunks = currentChunks.map((originalChunk) => {
      const updated = translateResult.chunks.find(
        (tc) => tc.partNumber === originalChunk.partNumber
      );
      return updated || originalChunk; // Return updated chunk if found, else original
    });
    // Update relevantChunks based on the *merged* currentChunks
    relevantChunks =
      config.processOnlyPart !== undefined
        ? currentChunks.filter((c) => c.partNumber === config.processOnlyPart)
        : currentChunks;
    // --- End Merge ---
    // Check status on the potentially filtered relevantChunks
    if (relevantChunks.filter((c) => c.status === "completed").length === 0) {
      logger.error(
        "Translation/Validation failed for all targeted chunks. Aborting pipeline."
      );
      process.exit(1);
    }

    // --- Calculate Translation Costs ---
    logger.debug("Calculating translation costs...");
    let translationTokensFound = false;
    currentChunks.forEach((chunk) => {
      if (
        chunk.llmTranslationInputTokens !== undefined &&
        chunk.llmTranslationOutputTokens !== undefined
      ) {
        translationTokensFound = true;
        const modelName = config.translationModel;
        const cost = calculateCost(
          modelName,
          chunk.llmTranslationInputTokens,
          chunk.llmTranslationOutputTokens
        );
        costBreakdown.translationCost += cost;
        costBreakdown.totalCost += cost;
        costBreakdown.costPerModel[modelName] =
          (costBreakdown.costPerModel[modelName] || 0) + cost;
      } else {
        if (
          relevantChunks.some(
            (rc) =>
              rc.partNumber === chunk.partNumber &&
              rc.status !== "prompting" &&
              rc.status !== "pending"
          )
        ) {
          const warnMsg = `Token count unavailable for translation model: ${config.translationModel}`;
          if (!costBreakdown.warnings.includes(warnMsg)) {
            costBreakdown.warnings.push(warnMsg);
          }
        }
      }
    });
    if (!translationTokensFound && relevantChunks.length > 0) {
      logger.warn(
        "Could not find translation token counts for any processed chunks."
      );
    }
    // --- End Cost Calculation ---
    relevantChunks =
      config.processOnlyPart !== undefined
        ? currentChunks.filter((c) => c.partNumber === config.processOnlyPart)
        : currentChunks;
    if (relevantChunks.filter((c) => c.status === "completed").length === 0) {
      logger.error(
        "Translation/Validation failed for all targeted chunks. Aborting pipeline."
      );
      process.exit(1);
    }

    // --- Step 4: Finalize Subtitles ---
    logger.info(chalk.blueBright("--- Step 4: Finalizing Subtitles ---"));
    const finalizeResult = await finalize(currentChunks, config);
    allIssues.push(...finalizeResult.issues);
    const finalSrtPath = finalizeResult.finalSrtPath;

    // --- Pipeline Complete ---
    // Calculate final cost metrics
    if (videoDuration && videoDuration > 0) {
      costBreakdown.costPerMinute =
        (costBreakdown.totalCost / videoDuration) * 60;
    }

    // --- Final Report Output ---
    if (finalSrtPath) {
      logger.success(chalk.greenBright("Pipeline completed successfully!"));
      let reportContent = `Pipeline Summary:
`;
      reportContent += `- Final SRT: ${finalSrtPath}
`;
      reportContent += `- Intermediate Files: ${config.intermediateDir}
`;
      reportContent += `- Total Issues Logged: ${allIssues.length}
`;
      // Cost Report
      reportContent += `\n--- Estimated Cost Breakdown ---
`;
      reportContent += `- Total: $${costBreakdown.totalCost.toFixed(4)}
`;
      reportContent += `- Transcription: $${costBreakdown.transcriptionCost.toFixed(
        4
      )} (Model: ${config.transcriptionModel})
`;
      reportContent += `- Translation: $${costBreakdown.translationCost.toFixed(
        4
      )} (Model: ${config.translationModel})
`;
      if (costBreakdown.costPerMinute !== undefined) {
        reportContent += `- Cost Per Minute of Video: $${costBreakdown.costPerMinute.toFixed(
          4
        )}
`;
      }
      // Per-model breakdown if multiple distinct models were used
      if (Object.keys(costBreakdown.costPerModel).length > 1) {
        reportContent += `- Cost Per Model Details:
`;
        for (const [model, cost] of Object.entries(
          costBreakdown.costPerModel
        )) {
          reportContent += `    - ${model}: $${cost.toFixed(4)}
`;
        }
      }
      if (costBreakdown.warnings.length > 0) {
        reportContent += `\n- Cost Warnings:\n`;
        costBreakdown.warnings.forEach(
          (w: string) => (reportContent += `    - ${w}\n`)
        );
      }
      reportContent += `(Note: Costs are estimates based on token counts reported by APIs where available.)`;

      console.log(
        boxen(reportContent, {
          padding: 1,
          margin: 1,
          borderColor: "green",
          title: "Pipeline Summary",
        })
      );
    } else {
      logger.error(
        chalk.redBright(
          "Pipeline completed, but failed to generate final SRT file."
        )
      );
      console.log(
        boxen(
          `Final SRT generation failed.\nCheck logs and intermediate files: ${config.intermediateDir}\nTotal Issues Logged: ${allIssues.length}`,
          {
            padding: 1,
            margin: 1,
            borderColor: "red",
            title: "Pipeline Failed",
          }
        )
      );
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`Fatal pipeline error: ${err.message || err}`, err.stack);
    console.error(
      boxen(
        chalk.red(
          `Fatal Pipeline Error: ${err.message || err}\n${err.stack || ""}`
        ),
        { padding: 1, margin: 1, borderColor: "red" }
      )
    );
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url.replace("file://", "") === Bun.main) {
  main();
}

export { main };
