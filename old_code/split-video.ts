#!/usr/bin/env bun

import { parseArgs } from "util";
import { spawn } from "child_process";
import { dirname, basename, join } from "path";
import { mkdir } from "fs/promises";

// Define types
interface TimeRange {
  start: number;
  end: number;
  outputFile: string;
}

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: {
      type: "string",
      short: "o",
      default: "output",
    },
    help: {
      type: "boolean",
      short: "h",
    },
    concurrent: {
      type: "string",
      short: "c",
      default: "1",
    },
  },
  allowPositionals: true,
});

// Show help if requested or if no input file is provided
if (values.help || positionals.length === 0) {
  console.log(`
Usage: bun split-video.ts [options] <video-file>

Options:
  -o, --output <directory>  Output directory for MP3 chunks (default: "output")
  -c, --concurrent <number> Number of concurrent ffmpeg processes (default: "1")
  -h, --help                Show this help message
  `);
  process.exit(values.help ? 0 : 1);
}

const inputFile = positionals[0];
const outputDir = values.output as string;
const maxConcurrent = parseInt(values.concurrent as string, 10) || 1;

// Format seconds to HH:MM:SS format for ffmpeg
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// Generate time ranges with 20-minute chunks and 5-minute overlaps
function generateTimeRanges(
  durationInSeconds: number,
  inputFileName: string
): TimeRange[] {
  const chunkDuration = 20 * 60; // 20 minutes in seconds
  const overlap = 5 * 60; // 5 minutes in seconds
  const ranges: TimeRange[] = [];

  const fileBaseName = basename(inputFileName, ".mp4").replace(/\.[^/.]+$/, "");

  let start = 0;
  let chunkIndex = 1;

  while (start < durationInSeconds) {
    const end = Math.min(start + chunkDuration, durationInSeconds);
    const outputFile = join(outputDir, `${fileBaseName}_part${chunkIndex}.mp3`);

    ranges.push({
      start,
      end,
      outputFile,
    });

    start = end - overlap;
    chunkIndex++;

    // If the next chunk would be completely past the end, break
    if (start >= durationInSeconds) {
      break;
    }
  }

  return ranges;
}

// Execute ffmpeg command to extract audio chunk
async function extractAudioChunk(range: TimeRange): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = formatTime(range.start);
    const duration = formatTime(range.end - range.start);

    console.log(
      `Extracting chunk from ${startTime} for duration ${duration} to ${range.outputFile}`
    );

    const ffmpeg = spawn("ffmpeg", [
      "-i",
      inputFile,
      "-ss",
      startTime,
      "-t",
      duration,
      "-vn", // Disable video
      "-acodec",
      "libmp3lame",
      "-q:a",
      "2", // High quality audio (0-9, lower is better)
      "-y", // Overwrite output files
      "-progress",
      "pipe:1", // Output progress information to stdout
      range.outputFile,
    ]);

    let lastProgress = 0;
    const totalDuration = range.end - range.start;

    // Handle progress information
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();

      // Extract time information from ffmpeg output
      const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseFloat(timeMatch[3]);

        const currentTime = hours * 3600 + minutes * 60 + seconds;
        const progressPercent = Math.floor((currentTime / totalDuration) * 100);

        // Only update if progress changed by at least 5%
        if (progressPercent >= lastProgress + 5) {
          process.stdout.write(
            `\r[${range.outputFile}] Progress: ${progressPercent}%`
          );
          lastProgress = progressPercent;
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        process.stdout.write(`\r[${range.outputFile}] Progress: 100%\n`);
        console.log(`Successfully created ${range.outputFile}`);
        resolve();
      } else {
        console.error(
          `Error processing ${range.outputFile}, exit code: ${code}`
        );
        reject(new Error(`ffmpeg process exited with code ${code}`));
      }
    });

    ffmpeg.on("error", (error) => {
      console.error(`ffmpeg spawn error: ${error.message}`);
      reject(error);
    });
  });
}

// Process chunks with limited concurrency
async function processChunksWithConcurrency(
  ranges: TimeRange[]
): Promise<void> {
  const totalChunks = ranges.length;
  let completedChunks = 0;

  console.log(
    `Processing ${totalChunks} chunks with max ${maxConcurrent} concurrent processes`
  );

  // Process chunks in batches
  for (let i = 0; i < ranges.length; i += maxConcurrent) {
    const batch = ranges.slice(i, i + maxConcurrent);
    const promises = batch.map((range) =>
      extractAudioChunk(range)
        .then(() => {
          completedChunks++;
          console.log(
            `Progress: ${completedChunks}/${totalChunks} chunks complete`
          );
        })
        .catch((error) => {
          console.error(
            `Failed to process chunk ${range.outputFile}: ${error.message}`
          );
          throw error;
        })
    );

    // Wait for all processes in this batch to complete
    await Promise.all(promises);

    // Small delay between batches to allow system resources to stabilize
    if (i + maxConcurrent < ranges.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Main function
async function main() {
  try {
    // Create output directory if it doesn't exist
    await mkdir(outputDir, { recursive: true });
    console.log(`Chunks will be saved to: ${outputDir}`);

    // Get video duration using ffprobe
    const duration = await getVideoDuration(inputFile);
    console.log(`Video duration: ${formatTime(duration)}`);

    // Generate time ranges
    const timeRanges = generateTimeRanges(duration, inputFile);
    console.log(`Generated ${timeRanges.length} chunks`);

    // Process chunks with concurrency control
    await processChunksWithConcurrency(timeRanges);

    console.log(`Audio extraction complete! All files saved to: ${outputDir}`);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Get video duration using ffprobe
async function getVideoDuration(videoFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoFile,
    ]);

    let output = "";

    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        resolve(duration);
      } else {
        reject(new Error(`ffprobe process exited with code ${code}`));
      }
    });

    ffprobe.on("error", (error) => {
      reject(error);
    });
  });
}

// Run the main function
main();
