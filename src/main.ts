#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import boxen from "boxen"; // Import boxen
import type { Config, ChunkInfo, ProcessingIssue } from "./types.js";
import {
  configureLogger,
  info,
  warn,
  error,
  success,
  debug,
} from "./utils/logger.js";
import { ensureDir } from "./utils/file_utils.js";
import { split } from "./splitter/index.js";
import { transcribe } from "./transcriber/index.js";
import { translate } from "./translator/index.js"; // Import the new translator function

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
    .parse();

  const opts = program.opts();

  // Configure logger
  configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    minLogLevel: opts.logLevel,
  });

  try {
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
    };

    // Validate configuration
    if (!existsSync(config.videoPath)) {
      error(`Video file does not exist: ${config.videoPath}`);
      process.exit(1);
    }
    if (config.srtPath && !existsSync(config.srtPath)) {
      warn(`Reference SRT file does not exist: ${config.srtPath}`);
    }
    if (!config.apiKeys.gemini) {
      error(
        "Gemini API key is required for transcription. Provide via --gemini-api-key or GEMINI_API_KEY env var."
      );
      process.exit(1);
    }
    // Validate translation keys
    if (
      config.translationModel?.toLowerCase().includes("claude") &&
      !config.apiKeys?.anthropic
    ) {
      error(
        "Anthropic API key is required for configured Claude translation model."
      );
      process.exit(1);
    }
    if (
      !config.translationModel?.toLowerCase().includes("claude") &&
      !config.apiKeys?.gemini
    ) {
      error(
        "Gemini API key is required for configured non-Claude translation model."
      );
      process.exit(1);
    }

    // Create directories
    ensureDir(config.outputDir);
    ensureDir(config.intermediateDir);

    // Start the pipeline
    info("Starting subtitle translation pipeline");
    debug(
      `Configuration: ${JSON.stringify(
        { ...config, apiKeys: { gemini: "***", anthropic: "***" } },
        null,
        2
      )}`
    );
    let currentChunks: ChunkInfo[] = [];
    const allIssues: ProcessingIssue[] = [];

    // --- Step 1: Split ---
    info(chalk.blueBright("--- Step 1: Splitting Inputs ---"));
    const splitResult = await split({
      videoPath: config.videoPath,
      srtPath: config.srtPath,
      outputDir: config.intermediateDir, // Splitter outputs to intermediate
      chunkDuration: config.chunkDuration,
      chunkOverlap: config.chunkOverlap,
      chunkFormat: config.chunkFormat,
      maxConcurrent: config.maxConcurrent, // Use main concurrency for ffmpeg
      force: config.force,
    });
    currentChunks = splitResult.chunks;
    allIssues.push(...splitResult.issues);
    if (currentChunks.filter((c) => c.status !== "failed").length === 0) {
      error("Splitting failed for all chunks. Aborting pipeline.");
      // TODO: Add final report generation here
      process.exit(1);
    }

    // --- Step 2: Transcribe & Adjust ---
    info(
      chalk.blueBright("--- Step 2: Transcription & Timestamp Adjustment ---")
    );
    const transcribeResult = await transcribe(currentChunks, config);
    currentChunks = transcribeResult.chunks;
    allIssues.push(...transcribeResult.issues);
    if (currentChunks.filter((c) => c.status === "prompting").length === 0) {
      error(
        "Transcription/Adjustment failed for all processable chunks. Aborting pipeline."
      );
      // TODO: Add final report generation here
      process.exit(1);
    }

    // --- Step 3: Translate ---
    info(chalk.blueBright("--- Step 3: Generating Translations ---"));
    const translateResult = await translate(currentChunks, config); // Call translate
    currentChunks = translateResult.chunks;
    allIssues.push(...translateResult.issues);
    if (currentChunks.filter((c) => c.status === "parsing").length === 0) {
      error(
        "Translation failed for all processable chunks. Aborting pipeline."
      );
      // TODO: Add final report generation here
      process.exit(1);
    }

    // --- Subsequent Steps ---
    // TODO: Add steps 4-6: Parse, Validate, Merge, Format

    success(
      chalk.greenBright(
        "Pipeline finished preliminary steps (Split, Transcribe, Translate)."
      )
    );
    // TODO: Final report generation using allIssues and final chunk status
    console.log(
      boxen(
        `Pipeline Complete (Up to Translation Step)\nSee intermediate directory: ${config.intermediateDir}\nTotal Issues: ${allIssues.length}`,
        { padding: 1, margin: 1, borderColor: "green" }
      )
    );
  } catch (err: any) {
    error(`Fatal pipeline error: ${err.message || err}`);
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
