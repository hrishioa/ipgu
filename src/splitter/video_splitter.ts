import { spawn } from "child_process";
import { join, basename } from "path";
// Use type-only import for types
import type { ChunkInfo, ProcessingIssue, Config } from "../types.js";
// Import secondsToTimestamp value, and TimeChunk type
import { secondsToTimestamp, type TimeChunk } from "../utils/time_utils.js";
import { ensureDir } from "../utils/file_utils.js";
import * as logger from "../utils/logger.js";
import cliProgress from "cli-progress";
import chalk from "chalk";
import { existsSync } from "fs";

/**
 * Get the duration of a video file using ffprobe
 * @param videoPath Path to the video file
 * @returns Promise resolving to duration in seconds, or null if error
 */
export async function getVideoDuration(
  videoPath: string
): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ];

    logger.debug(`Running ffprobe to get duration of ${videoPath}`);
    const ffprobe = spawn("ffprobe", args);
    let output = "";
    let errorOutput = "";

    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        logger.error(`ffprobe exited with code ${code}: ${errorOutput}`);
        resolve(null);
        return;
      }

      const duration = parseFloat(output.trim());
      if (isNaN(duration)) {
        logger.error(`Could not parse duration from ffprobe output: ${output}`);
        resolve(null);
        return;
      }

      logger.debug(`Video duration: ${duration} seconds`);
      resolve(duration);
    });
  });
}

/**
 * Create a media chunk using ffmpeg
 * @param videoPath Source video path
 * @param outputPath Output path for chunk
 * @param startTime Start time in seconds
 * @param endTime End time in seconds
 * @param format Output format ('mp3' or 'mp4')
 * @returns Promise resolving to true if successful, false if error
 */
export async function createMediaChunk(
  videoPath: string,
  outputPath: string,
  startTime: number,
  endTime: number,
  format: "mp3" | "mp4"
): Promise<boolean> {
  return new Promise((resolve) => {
    const duration = endTime - startTime;
    const formattedStart = secondsToTimestamp(startTime).replace(",", ".");

    // Basic args for both formats
    const args = [
      "-y", // Overwrite output files
      "-i",
      videoPath,
      "-ss",
      formattedStart,
      "-t",
      duration.toString(),
    ];

    // Format-specific settings
    if (format === "mp3") {
      args.push(
        "-vn", // No video
        "-acodec",
        "libmp3lame",
        "-ar",
        "44100",
        "-ab",
        "192k",
        "-f",
        "mp3"
      );
    } else {
      args.push(
        "-c:v",
        "libx264", // Video codec
        "-crf",
        "28", // Quality (higher number = lower quality)
        "-preset",
        "fast",
        "-vf",
        "scale=640:360", // 360p
        "-c:a",
        "aac",
        "-b:a",
        "128k"
      );
    }

    // Output path
    args.push(outputPath);

    logger.debug(
      `Running ffmpeg to create ${format} chunk from ${formattedStart} to ${secondsToTimestamp(
        endTime
      ).replace(",", ".")}`
    );
    const ffmpeg = spawn("ffmpeg", args);
    let errorOutput = "";

    ffmpeg.stderr.on("data", (data) => {
      // ffmpeg outputs progress info to stderr
      const msg = data.toString();
      logger.debug(`[ffmpeg stderr] ${msg.trim()}`); // Log ffmpeg stderr at debug level

      // Only accumulate actual errors
      if (
        msg.includes("Error") ||
        msg.includes("error") ||
        msg.includes("failed") ||
        msg.includes("Cannot")
      ) {
        errorOutput += msg;
      }
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        logger.error(
          `ffmpeg exited with code ${code} for chunk ${outputPath}. Error: ${errorOutput}`
        );
        resolve(false);
        return;
      }

      logger.debug(`Successfully created ${format} chunk: ${outputPath}`);
      resolve(true);
    });
  });
}

/**
 * Split a video into chunks based on pre-calculated time ranges.
 */
export async function splitVideo(
  videoPath: string,
  outputDir: string,
  format: "mp3" | "mp4",
  maxConcurrent: number,
  timeChunks: TimeChunk[],
  config: Pick<Config, "force">
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];
  // No longer calculating chunks here

  // --- Start Processing ---
  logger.info(
    `Processing ${timeChunks.length} specified chunk(s) for splitting...`
  );

  // --- Progress Bar Setup ---
  const startTime = Date.now(); // Record start time
  let intervalId: Timer | null = null; // Timer ID
  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      // Remove token placeholders, keep elapsed time
      format: `${chalk.cyan(
        "{bar}"
      )} | {percentage}% | {value}/{total} Chunks | ETA: {eta_formatted} | Elapsed: {elapsed}s | ${chalk.gray(
        "{task}"
      )}`,
    },
    cliProgress.Presets.shades_classic
  );
  const progressBar = multibar.create(timeChunks.length, 0, {
    task: "Splitting video...",
    elapsed: "0.0",
  });
  logger.setActiveMultibar(multibar);

  // Update timer to 100ms (10 times per second)
  intervalId = setInterval(() => {
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    progressBar.update({ elapsed: elapsedSeconds });
  }, 100); // Update interval to 100ms

  // Create ChunkInfo objects *only* for the chunks we are processing
  const chunksToProcess: ChunkInfo[] = timeChunks.map((tc: TimeChunk) => {
    const mediaChunkPath = join(
      outputDir,
      `part${tc.partNumber.toString().padStart(2, "0")}.${format}`
    );
    return {
      partNumber: tc.partNumber,
      startTimeSeconds: tc.startTimeSeconds,
      endTimeSeconds: tc.endTimeSeconds,
      mediaChunkPath,
      status: "pending", // Initial status for processing
    };
  });

  // --- Refactored Concurrency Control ---
  const queue = [...chunksToProcess];
  const activePromises: Promise<void>[] = [];
  let processedCount = 0;

  const startNextSplitTask = () => {
    if (queue.length === 0) return;
    const chunk = queue.shift();
    if (!chunk) return;
    const taskPromise = (async () => {
      chunk.status = "splitting";
      progressBar.update(processedCount, {
        task: `Splitting chunk ${chunk.partNumber}...`,
      });

      // Check if output file already exists and force is not enabled
      if (
        !config.force &&
        chunk.mediaChunkPath &&
        existsSync(chunk.mediaChunkPath)
      ) {
        logger.debug(
          `[Chunk ${chunk.partNumber}] Media chunk ${basename(
            chunk.mediaChunkPath
          )} already exists. Skipping ffmpeg.`
        );
        chunk.status = "transcribing"; // Mark as ready for next step
        // We still count this as "processed" for the progress bar logic below
        // Note: We assume if the media chunk exists, the corresponding SRT chunk
        // (if applicable) should also exist or be recreated by srt_splitter if needed.
      } else {
        // --- Run ffmpeg ---
        try {
          const success = await createMediaChunk(
            videoPath,
            chunk.mediaChunkPath!,
            chunk.startTimeSeconds,
            chunk.endTimeSeconds,
            format
          );
          if (success) {
            chunk.status = "transcribing";
            logger.debug(`Successfully split part ${chunk.partNumber}`);
          } else {
            chunk.status = "failed";
            chunk.error = "Failed to create media chunk via ffmpeg";
            issues.push({
              type: "SplitError",
              severity: "error",
              message: `ffmpeg failed for part ${chunk.partNumber}`,
              chunkPart: chunk.partNumber,
            });
            logger.error(`Failed to split part ${chunk.partNumber}`);
          }
        } catch (err: any) {
          chunk.status = "failed";
          chunk.error = `Error during chunk creation: ${err.message || err}`;
          issues.push({
            type: "SplitError",
            severity: "error",
            message: `Unhandled error creating media chunk for part ${chunk.partNumber}`,
            chunkPart: chunk.partNumber,
            context: String(err),
          });
          logger.error(
            `Unhandled error splitting part ${chunk.partNumber}: ${err}`
          );
        }
        // --- End ffmpeg ---
      }
    })();

    taskPromise
      .catch((error: any) => {
        if (chunk) {
          chunk.status = "failed";
          chunk.error = `Unexpected error during chunk ${
            chunk.partNumber
          } split processing: ${error.message || error}`;
          logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
          issues.push({
            type: "SplitError",
            severity: "error",
            message: chunk.error,
            chunkPart: chunk.partNumber,
            context: error.stack,
          });
        } else {
          logger.error(
            `Unexpected error during split processing (chunk undefined): ${
              error.message || error
            }`
          );
          issues.push({
            type: "SplitError",
            severity: "error",
            message: `Unexpected split error: ${error.message || error}`,
            context: error.stack,
          });
        }
      })
      .finally(() => {
        processedCount++;
        progressBar.update(processedCount, {
          task:
            chunk.status === "failed"
              ? `Chunk ${chunk.partNumber} failed!`
              : `Chunk ${chunk.partNumber} done.`,
        });
        const index = activePromises.indexOf(taskPromise);
        if (index > -1) activePromises.splice(index, 1);
        if (activePromises.length < maxConcurrent) startNextSplitTask();
      });
    activePromises.push(taskPromise);
  };

  // Start initial batch
  for (let i = 0; i < Math.min(maxConcurrent, queue.length); i++) {
    startNextSplitTask();
  }

  // Wait loop
  while (activePromises.length > 0 || queue.length > 0) {
    while (activePromises.length < maxConcurrent && queue.length > 0) {
      startNextSplitTask();
    }
    if (activePromises.length > 0) {
      await Promise.race(activePromises);
    }
  }

  // --- Cleanup ---
  if (intervalId) clearInterval(intervalId); // Ensure timer is cleared
  progressBar.stop();
  multibar.stop();
  logger.setActiveMultibar(null);

  // Return the processed chunks (potentially only one if filtered)
  // Need to map back to include any errors/status updates
  const finalChunks = chunksToProcess; // These have been updated in place
  const successCount = finalChunks.filter((c) => c.status !== "failed").length;
  logger.info(
    `Video splitting complete: ${successCount} / ${finalChunks.length} specified chunk(s) created successfully`
  );

  return { chunks: finalChunks, issues };
}
