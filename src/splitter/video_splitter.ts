import { spawn } from "child_process";
import { join } from "path";
import type { ChunkInfo, ProcessingIssue } from "../types";
import { calculateChunks, secondsToTimestamp } from "../utils/time_utils";
import { ensureDir } from "../utils/file_utils";
import * as logger from "../utils/logger";
import cliProgress from "cli-progress";
import chalk from "chalk";

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
 * Split a video into chunks based on configuration
 * @param videoPath Path to the video file
 * @param outputDir Directory to save chunks
 * @param chunkDuration Duration of each chunk in seconds
 * @param overlapDuration Overlap duration in seconds
 * @param format Output format ('mp3' or 'mp4')
 * @param maxConcurrent Maximum concurrent ffmpeg processes
 * @returns Promise resolving to chunk info and issues
 */
export async function splitVideo(
  videoPath: string,
  outputDir: string,
  chunkDuration: number,
  overlapDuration: number,
  format: "mp3" | "mp4",
  maxConcurrent: number = 3
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];
  const chunks: ChunkInfo[] = [];

  // Create output directory
  if (!ensureDir(outputDir)) {
    issues.push({
      type: "SplitError",
      severity: "error",
      message: `Failed to create output directory: ${outputDir}`,
    });
    return { chunks, issues };
  }

  // Get video duration
  const duration = await getVideoDuration(videoPath);
  if (!duration) {
    issues.push({
      type: "SplitError",
      severity: "error",
      message: "Failed to get video duration",
    });
    return { chunks, issues };
  }

  // Calculate chunks
  const timeChunks = calculateChunks(duration, chunkDuration, overlapDuration);
  logger.info(`Splitting video into ${timeChunks.length} chunks`);

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

  const progressBar = multibar.create(timeChunks.length, 0, {
    task: "Splitting video...",
  });
  logger.setActiveMultibar(multibar); // Tell logger about the multibar

  // Create ChunkInfo objects
  for (const { startTimeSeconds, endTimeSeconds, partNumber } of timeChunks) {
    const mediaChunkPath = join(
      outputDir,
      `part${partNumber.toString().padStart(2, "0")}.${format}`
    );

    chunks.push({
      partNumber,
      startTimeSeconds,
      endTimeSeconds,
      mediaChunkPath,
      status: "pending",
    });
  }

  // Process chunks with concurrency limit
  const activePromises: Promise<void>[] = [];
  const queue = [...chunks];
  let processedCount = 0;

  const processNext = async () => {
    if (queue.length === 0) return; // No more chunks to process

    const chunk = queue.shift();
    if (!chunk) return;

    // Mark as splitting
    chunk.status = "splitting";
    progressBar.update(processedCount, {
      task: `Processing chunk ${chunk.partNumber}...`,
    });

    try {
      const success = await createMediaChunk(
        videoPath,
        chunk.mediaChunkPath!,
        chunk.startTimeSeconds,
        chunk.endTimeSeconds,
        format
      );

      if (success) {
        chunk.status = "transcribing"; // Next stage
        logger.info(`Successfully split part ${chunk.partNumber}`);
      } else {
        chunk.status = "failed";
        chunk.error = "Failed to create media chunk";
        issues.push({
          type: "SplitError",
          severity: "error",
          message: `Failed to create media chunk for part ${chunk.partNumber}`,
          chunkPart: chunk.partNumber,
        });
        logger.error(`Failed to split part ${chunk.partNumber}`);
      }
    } catch (err) {
      chunk.status = "failed";
      chunk.error = `Error during chunk creation: ${err}`;
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
    } finally {
      processedCount++;
      progressBar.update(processedCount, {
        task:
          chunk.status === "failed"
            ? `Chunk ${chunk.partNumber} failed`
            : `Chunk ${chunk.partNumber} done`,
      });
    }
  };

  // Fill the initial concurrent queue
  const initialTasks = Array.from(
    { length: Math.min(maxConcurrent, queue.length) },
    () => processNext()
  );
  await Promise.all(initialTasks);

  // Continue processing as tasks complete
  while (processedCount < chunks.length) {
    await processNext();
  }

  // Cleanup
  progressBar.stop();
  multibar.stop();
  logger.setActiveMultibar(null); // Clear the multibar from the logger

  const successCount = chunks.filter((c) => c.status !== "failed").length;
  logger.info(
    `Video splitting complete: ${successCount} / ${chunks.length} chunks created successfully`
  );

  return { chunks, issues };
}
