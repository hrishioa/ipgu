#!/usr/bin/env bun

import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import type { Config, ChunkInfo, ProcessingIssue } from "./types";
import {
  configureLogger,
  info,
  warn,
  error,
  success,
  debug,
} from "./utils/logger";
import { ensureDir } from "./utils/file_utils";
import { split } from "./splitter";

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
      "-l, --languages <langs>",
      "Target languages (comma-separated, e.g., ko,ja)",
      "ko"
    )
    .option(
      "-tm, --transcription-model <model>",
      "Model for transcription",
      "gemini-1.5-flash-latest"
    )
    .option(
      "-tl, --translation-model <model>",
      "Model for translation",
      "claude-3-sonnet-20240229"
    )
    .option(
      "-d, --chunk-duration <seconds>",
      "Chunk duration in seconds",
      "1200"
    )
    .option("-o, --chunk-overlap <seconds>", "Chunk overlap in seconds", "300")
    .option("-f, --chunk-format <format>", "Chunk format (mp3 or mp4)", "mp3")
    .option("-c, --max-concurrent <number>", "Max concurrent processes", "3")
    .option("-r, --retries <number>", "Number of retries for API calls", "2")
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
      targetLanguages: opts.languages
        .split(",")
        .map((lang: string) => lang.trim()),
      transcriptionModel: opts.transcriptionModel,
      translationModel: opts.translationModel,
      chunkDuration: parseInt(opts.chunkDuration),
      chunkOverlap: parseInt(opts.chunkOverlap),
      chunkFormat: opts.chunkFormat === "mp4" ? "mp4" : "mp3",
      maxConcurrent: parseInt(opts.maxConcurrent),
      retries: parseInt(opts.retries),
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
      warn(`SRT file does not exist: ${config.srtPath}`);
    }

    if (!config.apiKeys.gemini) {
      error(
        "Gemini API key is required for transcription. Provide via --gemini-api-key or GEMINI_API_KEY env var."
      );
      process.exit(1);
    }

    if (
      !config.apiKeys.anthropic &&
      config.translationModel.includes("claude")
    ) {
      error(
        "Anthropic API key is required for Claude models. Provide via --anthropic-api-key or ANTHROPIC_API_KEY env var."
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

    // Step 1: Split video and SRT
    info("Step 1: Splitting video and subtitles");
    const mediaDir = join(config.intermediateDir, "media");
    const srtDir = join(config.intermediateDir, "srt");

    const { chunks, issues: splitIssues } = await split({
      videoPath: config.videoPath,
      srtPath: config.srtPath,
      outputDir: config.intermediateDir,
      chunkDuration: config.chunkDuration,
      chunkOverlap: config.chunkOverlap,
      chunkFormat: config.chunkFormat,
      maxConcurrent: config.maxConcurrent,
      force: config.force,
    });

    // TODO: Add the rest of the pipeline steps here:
    // 2. Transcribe audio/video chunks
    // 3. Adjust timestamps
    // 4. Generate translation prompts
    // 5. Translate using LLM
    // 6. Parse and validate responses
    // 7. Merge results
    // 8. Format and output final subtitles

    // For now, just print the split results
    if (splitIssues.length > 0) {
      warn(`Encountered ${splitIssues.length} issues during splitting:`);
      splitIssues.forEach((issue) => {
        const prefix =
          issue.severity === "error"
            ? chalk.red("ERROR")
            : issue.severity === "warning"
            ? chalk.yellow("WARN")
            : chalk.blue("INFO");
        console.log(`${prefix}: ${issue.message}`);
      });
    }

    success(
      `Split complete: Created ${
        chunks.filter((c) => c.status !== "failed").length
      } chunks`
    );
    info(
      "Next steps of the pipeline will be implemented in subsequent modules"
    );
  } catch (err) {
    error(`Fatal error: ${err}`);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === Bun.main) {
  main();
}

export { main };
