#!/usr/bin/env bun

import { join } from "path";
import { existsSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import type { ChunkInfo, ProcessingIssue } from "../types.js";
import {
  configureLogger,
  info,
  warn,
  error,
  success,
} from "../utils/logger.js";
import { ensureDir } from "../utils/file_utils.js";
import { splitVideo, getVideoDuration } from "./video_splitter.js";
import { splitSrt } from "./srt_splitter.js";
import { calculateChunks, type TimeChunk } from "../utils/time_utils.js";

interface SplitterOptions {
  videoPath: string;
  srtPath?: string;
  outputDir: string;
  chunkDuration: number;
  chunkOverlap: number;
  chunkFormat: "mp3" | "mp4";
  maxConcurrent: number;
  force: boolean;
  processOnlyPart?: number;
  inputOffsetSeconds?: number;
}

/**
 * Main function to split media and optionally SRT
 */
export async function split(
  options: SplitterOptions
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const {
    videoPath,
    srtPath,
    outputDir,
    chunkDuration,
    chunkOverlap,
    chunkFormat,
    maxConcurrent,
    force,
    processOnlyPart,
    inputOffsetSeconds,
  } = options;

  // Validate inputs
  if (!existsSync(videoPath)) {
    error(`Video file does not exist: ${videoPath}`);
    return {
      chunks: [],
      issues: [
        {
          type: "SplitError",
          severity: "error",
          message: "Video file not found",
        },
      ],
    };
  }

  if (srtPath && !existsSync(srtPath)) {
    warn(`SRT file does not exist: ${srtPath}`);
  }

  // Create output directories
  const mediaDir = join(outputDir, "media");
  const srtDir = join(outputDir, "srt");

  ensureDir(mediaDir);
  if (srtPath) {
    ensureDir(srtDir);
  }

  // Split video
  info(`Splitting video: ${videoPath}`);
  info(
    `Chunk settings: ${chunkDuration}s duration, ${chunkOverlap}s overlap, ${chunkFormat} format`
  );

  // Get duration first to calculate chunks
  const duration = await getVideoDuration(videoPath);
  if (!duration) {
    error(`Failed to get video duration for ${videoPath}`);
    return {
      chunks: [],
      issues: [
        {
          type: "SplitError",
          severity: "error",
          message: "Failed to get video duration",
        },
      ],
    };
  }

  // Calculate ALL potential time chunks
  const allTimeChunks = calculateChunks(duration, chunkDuration, chunkOverlap);
  let timeChunksToProcess: TimeChunk[] = allTimeChunks;
  info(`Calculated ${allTimeChunks.length} potential chunks.`);

  // Filter time chunks if only processing a specific part
  if (processOnlyPart !== undefined) {
    timeChunksToProcess = allTimeChunks.filter(
      (tc: TimeChunk) => tc.partNumber === processOnlyPart
    );
    if (timeChunksToProcess.length === 0) {
      error(
        `Part number ${processOnlyPart} is out of the calculated range (1-${allTimeChunks.length}).`
      );
      return {
        chunks: [],
        issues: [
          {
            type: "SplitError",
            severity: "error",
            message: `Invalid part number ${processOnlyPart}`,
          },
        ],
      };
    }
    info(`Filtering to process only part ${processOnlyPart}.`);
  }

  // Now call splitVideo with the potentially filtered timeChunks (or all if no specific part)
  const { chunks, issues } = await splitVideo(
    videoPath,
    mediaDir,
    chunkFormat,
    maxConcurrent,
    timeChunksToProcess,
    { force: force }
  );

  // If we have an SRT file, split it too
  if (srtPath && existsSync(srtPath)) {
    info(`Splitting SRT: ${srtPath}`);
    // Log the actual value to help debug
    info(
      `Using input offset: ${
        inputOffsetSeconds !== undefined ? inputOffsetSeconds : 0
      }s`
    );
    const srtResult = await splitSrt(
      srtPath,
      chunks,
      srtDir,
      force,
      inputOffsetSeconds ?? 0
    );
    issues.push(...srtResult.issues);
  }

  // Log summary
  const successCount = chunks.filter((c) => c.status !== "failed").length;
  const failCount = timeChunksToProcess.length - successCount;

  if (failCount === 0) {
    success(
      `Splitting complete: ${successCount} chunk(s) created successfully for part ${
        processOnlyPart ?? "all"
      }`
    );
  } else {
    warn(
      `Splitting complete with issues: ${successCount} successful, ${failCount} failed for part ${
        processOnlyPart ?? "all"
      }`
    );
  }

  return { chunks, issues };
}

/**
 * CLI entry point
 */
async function main() {
  const program = new Command();

  program
    .name("subtitle-splitter")
    .description("Split video and subtitle files into chunks")
    .version("1.0.0")
    .requiredOption("-v, --video <path>", "Path to video file")
    .option("-s, --srt <path>", "Path to SRT subtitle file")
    .option("-o, --output <dir>", "Output directory", "./output")
    .option("-d, --duration <seconds>", "Chunk duration in seconds", "1200")
    .option("-l, --overlap <seconds>", "Chunk overlap in seconds", "300")
    .option("-f, --format <format>", "Chunk format (mp3 or mp4)", "mp3")
    .option("-c, --concurrent <number>", "Max concurrent processes", "5")
    .option("--force", "Force overwrite existing files", false)
    .option("--log-file <path>", "Path to log file")
    .option(
      "--log-level <level>",
      "Log level (debug, info, warn, error)",
      "info"
    )
    .option("-P, --part <number>", "Process only a specific part number")
    .option(
      "--input-offset <seconds>",
      "Apply offset (in seconds, can be negative) to input SRT timings"
    )
    .parse();

  const opts = program.opts();

  // Configure logger
  configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    consoleLogLevel: opts.logLevel || "info",
  });

  try {
    const options: SplitterOptions = {
      videoPath: opts.video,
      srtPath: opts.srt,
      outputDir: opts.output,
      chunkDuration: parseInt(opts.duration),
      chunkOverlap: parseInt(opts.overlap),
      chunkFormat: opts.format === "mp4" ? "mp4" : "mp3",
      maxConcurrent: parseInt(opts.concurrent),
      force: opts.force,
      processOnlyPart: opts.part ? parseInt(opts.part) : undefined,
      inputOffsetSeconds: opts.inputOffset
        ? parseFloat(opts.inputOffset)
        : undefined,
    };

    const { chunks, issues } = await split(options);

    // Log issues
    if (issues.length > 0) {
      warn(`Encountered ${issues.length} issues:`);
      issues.forEach((issue) => {
        const prefix =
          issue.severity === "error"
            ? chalk.red("ERROR")
            : chalk.yellow("WARNING");
        console.log(`${prefix}: ${issue.message}`);
      });
    }

    // Save chunk info for downstream processing
    const outputInfoPath = join(options.outputDir, "chunk_info.json");
    const fs = await import("fs/promises");
    await fs.writeFile(outputInfoPath, JSON.stringify(chunks, null, 2));
    info(`Chunk info saved to: ${outputInfoPath}`);

    process.exit(issues.some((i) => i.severity === "error") ? 1 : 0);
  } catch (err: any) {
    error(`Fatal error: ${err.message || err}`, err.stack);
    process.exit(1);
  }
}

// Run main if called directly
const isMain = import.meta.url.replace("file://", "") === Bun.main;

if (isMain) {
  main();
}
