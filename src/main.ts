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

// Define preset type
type PresetConfig = {
  transcriptionModel: string;
  translationModel: string;
  maxConcurrent: number;
  chunkDuration: number;
  chunkFormat: "mp3" | "mp4";
  chunkOverlap: number;
  logLevel: string;
  noTimingCheck: boolean;
  retries: number;
  transcriptionRetries: number;
  useResponseTimings: boolean;
};

// Define presets
const PRESETS: Record<string, PresetConfig> = {
  "2.5": {
    transcriptionModel: "gemini-2.5-pro-preview-03-25",
    translationModel: "gemini-2.5-pro-preview-03-25",
    maxConcurrent: 12,
    chunkDuration: 1200,
    chunkFormat: "mp3",
    chunkOverlap: 120,
    logLevel: "info",
    noTimingCheck: true,
    retries: 3,
    transcriptionRetries: 3,
    useResponseTimings: true,
  },
  "2.5-claude": {
    transcriptionModel: "gemini-2.5-pro-preview-03-25",
    translationModel: "claude-3-7-sonnet-latest",
    maxConcurrent: 3,
    chunkDuration: 600,
    chunkFormat: "mp3",
    chunkOverlap: 60,
    logLevel: "info",
    noTimingCheck: true,
    retries: 3,
    transcriptionRetries: 3,
    useResponseTimings: true,
  },
};

/**
 * Subtitle Pipeline main entry point
 */
async function main() {
  const program = new Command();

  program
    .name("subtitle-pipeline")
    .description("End-to-end subtitle translation pipeline")
    .version("1.0.0")
    .option(
      "--preset <name>",
      "Use a preset configuration: '2.5' (Gemini 2.5 for all), '2.5-claude' (Gemini 2.5 + Claude 3.7). Individual parameters still override presets."
    )
    .requiredOption("-v, --video <path>", "Path to video file")
    .option("-s, --srt <path>", "Path to reference SRT subtitle file")
    .option(
      "-o, --output <dir>",
      "Output directory for final subtitles",
      "./output"
    )
    .option(
      "-i, --intermediate <dir>",
      "Directory to store intermediate files (defaults to {outputDir}/intermediates if not specified)"
    )
    .option(
      "--source-languages <langs>",
      "Comma-separated source languages in video (e.g., ml,ta)"
    )
    .option(
      "-l, --target-language <lang>",
      "The target language (besides English)"
    )
    .option("-tm, --transcription-model <model>", "Model for transcription")
    .option("-tl, --translation-model <model>", "Model for translation")
    .option(
      "--translation-prompt-template <path>", // Option for template
      "Path to custom translation prompt template file (uses default if not set)"
    )
    .option("-d, --chunk-duration <seconds>", "Chunk duration in seconds")
    .option("-o, --chunk-overlap <seconds>", "Chunk overlap in seconds")
    .option("-f, --chunk-format <format>", "Chunk format (mp3 or mp4)")
    .option("-c, --max-concurrent <number>", "Max concurrent processes")
    .option(
      "-r, --retries <number>",
      "Number of retries for general API calls (not transcription validation)"
    )
    .option(
      "--transcription-retries <number>",
      "Number of retries for transcription validation failure"
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
    .option(
      "--log-file <path>",
      "Path to log file (defaults to {intermediateDir}/pipeline.log if not specified)"
    )
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
    .addHelpText(
      "after",
      `
Examples:
  # Use the Gemini 2.5 preset (fast, high-concurrency)
  bun start --preset 2.5 --video movie.mp4 --srt subtitles.srt --output ./output
  # Intermediate files will be stored in ./output/intermediates
  # Debug logs will be saved to ./output/intermediates/pipeline.log

  # Use the Gemini+Claude preset (higher quality translation, slower)
  bun start --preset 2.5-claude --video movie.mp4 --srt subtitles.srt --output ./output

  # Specify a custom intermediate directory
  bun start --preset 2.5 --video movie.mp4 --output ./output --intermediate ./custom_intermediates

  # Specify a custom log file location
  bun start --preset 2.5 --video movie.mp4 --log-file ./custom_logs/pipeline.log

  # Use a preset but override specific parameters
  bun start --preset 2.5 --video movie.mp4 --max-concurrent 6 --chunk-duration 900
    `
    )
    .parse();

  const opts = program.opts();

  try {
    // Parse colors
    let engColor: string | undefined;
    let tgtColor: string | undefined;
    if (opts.colors) {
      [engColor, tgtColor] = opts.colors
        .split(",")
        .map((c: string) => c.trim());
    }

    // Apply preset if specified
    let presetOptions: Partial<PresetConfig> = {};
    if (opts.preset) {
      const preset = PRESETS[opts.preset];
      if (!preset) {
        logger.warn(
          `Unknown preset "${opts.preset}". Available presets: ${Object.keys(
            PRESETS
          ).join(", ")}`
        );
      } else {
        logger.info(
          `Applying "${opts.preset}" preset. Individual parameters will override preset values.`
        );
        presetOptions = preset;

        // Log the preset configuration for user reference
        logger.info(`Preset values:
  - transcription: ${preset.transcriptionModel}
  - translation: ${preset.translationModel}
  - concurrent: ${preset.maxConcurrent}
  - chunks: ${preset.chunkDuration}s with ${preset.chunkOverlap}s overlap
  - retries: ${preset.retries} (translation), ${
          preset.transcriptionRetries
        } (transcription)
  - format: ${preset.chunkFormat}, timing checks: ${
          preset.noTimingCheck ? "disabled" : "enabled"
        }`);
      }
    }

    // Configure logger
    const intermediatesDir =
      opts.intermediate || join(opts.output || "./output", "intermediates");
    // Default log file path if not specified
    const defaultLogPath = join(intermediatesDir, "pipeline.log");

    logger.configureLogger({
      logToFile: true, // Always log to file
      logFilePath: opts.logFile || defaultLogPath,
      // Pass console level from CLI or preset, default file level to debug
      consoleLogLevel:
        opts.logLevel || (presetOptions.logLevel as any) || "info",
      fileLogLevel: "debug", // Always use debug level for file logging
    });

    // Build configuration, allowing CLI options to override preset values
    const config: Config = {
      // Always required parameters
      videoPath: opts.video,
      srtPath: opts.srt,
      outputDir: opts.output || "./output",
      // Make intermediate default to a subfolder of output when not specified
      intermediateDir:
        opts.intermediate || join(opts.output || "./output", "intermediates"),

      // Parameters with preset defaults that can be overridden
      transcriptionModel:
        opts.transcriptionModel ||
        presetOptions.transcriptionModel ||
        "gemini-1.5-flash-latest",
      translationModel:
        opts.translationModel ||
        presetOptions.translationModel ||
        "claude-3-5-sonnet-20240620",
      chunkDuration: opts.chunkDuration
        ? parseInt(opts.chunkDuration)
        : presetOptions.chunkDuration || 1200,
      chunkOverlap: opts.chunkOverlap
        ? parseInt(opts.chunkOverlap)
        : presetOptions.chunkOverlap || 300,
      chunkFormat: opts.chunkFormat
        ? opts.chunkFormat === "mp4"
          ? "mp4"
          : "mp3"
        : presetOptions.chunkFormat || "mp3",
      maxConcurrent: opts.maxConcurrent
        ? parseInt(opts.maxConcurrent)
        : presetOptions.maxConcurrent || 5,
      retries: opts.retries
        ? parseInt(opts.retries)
        : presetOptions.retries || 2,
      transcriptionRetries: opts.transcriptionRetries
        ? parseInt(opts.transcriptionRetries)
        : presetOptions.transcriptionRetries || 1,
      disableTimingValidation:
        opts.noTimingCheck !== undefined
          ? opts.noTimingCheck
          : presetOptions.noTimingCheck || false,
      useResponseTimings:
        opts.useResponseTimings !== undefined
          ? opts.useResponseTimings
          : presetOptions.useResponseTimings || false,

      // Other parameters that aren't in presets but can still be specified
      sourceLanguages: opts.sourceLanguages
        ? opts.sourceLanguages.split(",").map((lang: string) => lang.trim())
        : undefined,
      targetLanguages: [opts.targetLanguage || "Korean"],
      translationPromptTemplatePath: opts.translationPromptTemplate,
      force: opts.force || false,
      apiKeys: {
        gemini: opts.geminiApiKey || process.env.GEMINI_API_KEY,
        anthropic: opts.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
      },
      outputOffsetSeconds: opts.outputOffset
        ? parseFloat(opts.outputOffset)
        : 0,
      inputOffsetSeconds:
        opts.inputOffset !== undefined ? parseFloat(opts.inputOffset) : 0,
      processOnlyPart: opts.part ? parseInt(opts.part) : undefined,
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
      inputOffsetSeconds: config.inputOffsetSeconds,
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
      // Check for comprehensive cost tracking first
      if (chunk.totalTranscriptionCost !== undefined) {
        transcriptionTokensFound = true;
        const modelName = config.transcriptionModel;
        costBreakdown.transcriptionCost += chunk.totalTranscriptionCost;
        costBreakdown.totalCost += chunk.totalTranscriptionCost;
        costBreakdown.costPerModel[modelName] =
          (costBreakdown.costPerModel[modelName] || 0) +
          chunk.totalTranscriptionCost;
      }
      // Fall back to single attempt cost if comprehensive tracking isn't available
      else if (
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
      // Check for comprehensive cost tracking first
      if (chunk.totalTranslationCost !== undefined) {
        translationTokensFound = true;
        const modelName = config.translationModel;
        costBreakdown.translationCost += chunk.totalTranslationCost;
        costBreakdown.totalCost += chunk.totalTranslationCost;
        costBreakdown.costPerModel[modelName] =
          (costBreakdown.costPerModel[modelName] || 0) +
          chunk.totalTranslationCost;
      }
      // Fall back to single attempt cost if comprehensive tracking isn't available
      else if (
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
