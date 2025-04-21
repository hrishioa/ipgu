#!/usr/bin/env bun

console.log("--- Splitter script starting ---");

import { join } from "path";
import { existsSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import type { ChunkInfo, ProcessingIssue } from "../types";
import { configureLogger, info, warn, error, success } from "../utils/logger";
import { ensureDir } from "../utils/file_utils";
import { splitVideo } from "./video_splitter";
import { splitSrt } from "./srt_splitter";

interface SplitterOptions {
  videoPath: string;
  srtPath?: string;
  outputDir: string;
  chunkDuration: number;
  chunkOverlap: number;
  chunkFormat: "mp3" | "mp4";
  maxConcurrent: number;
  force: boolean;
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

  const { chunks, issues } = await splitVideo(
    videoPath,
    mediaDir,
    chunkDuration,
    chunkOverlap,
    chunkFormat,
    maxConcurrent
  );

  // If we have an SRT file, split it too
  if (srtPath && existsSync(srtPath)) {
    info(`Splitting SRT: ${srtPath}`);
    const srtResult = await splitSrt(srtPath, chunks, srtDir);

    // Combine issues
    issues.push(...srtResult.issues);
  }

  // Log summary
  const successCount = chunks.filter((c) => c.status !== "failed").length;
  const failCount = chunks.length - successCount;

  if (failCount === 0) {
    success(`Splitting complete: ${successCount} chunks created successfully`);
  } else {
    warn(
      `Splitting complete with issues: ${successCount} successful, ${failCount} failed`
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
    .parse();

  const opts = program.opts();

  // Configure logger
  configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    minLogLevel: opts.logLevel,
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
  } catch (err) {
    error(`Fatal error: ${err}`);
    process.exit(1);
  }
}

// Run main if called directly
const isMain = import.meta.url.replace("file://", "") === Bun.main;

if (isMain) {
  main();
}
