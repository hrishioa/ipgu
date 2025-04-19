#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const TRANSCRIPTS_DIR = "./videos/transcripts";
const OUTPUT_DIR = "./videos/adjusted_transcripts";

// Define the time offsets for each part (in seconds)
const offsets: Record<number, number> = {
  1: 0, // 00:00:00
  2: 15 * 60, // 00:15:00
  3: 30 * 60, // 00:30:00
  4: 45 * 60, // 00:45:00
  5: 60 * 60, // 01:00:00
  6: 75 * 60, // 01:15:00
  7: 90 * 60, // 01:30:00
  8: 105 * 60, // 01:45:00
  9: 120 * 60, // 02:00:00
};

// Convert mm:ss format to seconds
function timeToSeconds(time: string): number {
  const [minutes, seconds] = time.split(":").map(Number);
  return minutes * 60 + seconds;
}

// Format seconds to hh:mm:ss format
function secondsToTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// Adjust timestamps in the given content
function adjustTimestamps(content: string, offsetInSeconds: number): string {
  // Regular expression to match timestamp patterns like "mm:ss - mm:ss"
  const timestampRegex = /(\d{1,2}):(\d{2}) - (\d{1,2}):(\d{2})/g;

  return content.replace(
    timestampRegex,
    (match, startMin, startSec, endMin, endSec) => {
      const startTimeInSeconds = timeToSeconds(`${startMin}:${startSec}`);
      const endTimeInSeconds = timeToSeconds(`${endMin}:${endSec}`);

      const adjustedStartTime = startTimeInSeconds + offsetInSeconds;
      const adjustedEndTime = endTimeInSeconds + offsetInSeconds;

      return `${secondsToTime(adjustedStartTime)} - ${secondsToTime(
        adjustedEndTime
      )}`;
    }
  );
}

async function main() {
  try {
    // Create output directory if it doesn't exist
    if (!existsSync(OUTPUT_DIR)) {
      await mkdir(OUTPUT_DIR, { recursive: true });
    }

    // Get all transcript files
    const files = await readdir(TRANSCRIPTS_DIR);
    const transcriptFiles = files.filter((file) =>
      file.endsWith("_auto_transcribed.txt")
    );

    if (transcriptFiles.length === 0) {
      console.log(`No transcript files found in ${TRANSCRIPTS_DIR}`);
      return;
    }

    console.log(`Found ${transcriptFiles.length} transcript files to process`);

    // Process each file
    for (const file of transcriptFiles) {
      try {
        // Extract part number from filename
        const partMatch = file.match(/part(\d+)/);
        if (!partMatch) {
          console.log(`Could not determine part number for ${file}, skipping`);
          continue;
        }

        const partNumber = parseInt(partMatch[1], 10);
        const offsetInSeconds = offsets[partNumber] || 0;

        // Read the transcript file
        const filePath = join(TRANSCRIPTS_DIR, file);
        const content = await readFile(filePath, "utf-8");

        // Adjust timestamps
        const adjustedContent = adjustTimestamps(content, offsetInSeconds);

        // Write adjusted content to output file
        const outputFileName = file.replace(
          "_auto_transcribed.txt",
          "_adjusted.txt"
        );
        const outputPath = join(OUTPUT_DIR, outputFileName);
        await writeFile(outputPath, adjustedContent);

        console.log(
          `Processed ${file} → ${outputFileName} (offset: ${secondsToTime(
            offsetInSeconds
          )})`
        );
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }

    console.log("All transcripts processed!");
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
