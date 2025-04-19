#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { parseArgs } from "util";

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: {
      type: "string",
      short: "i",
      default: "./videos/transcripts",
    },
    output: {
      type: "string",
      short: "o",
      default: "./videos/adjusted_transcripts",
    },
    pattern: {
      type: "string",
      short: "p",
      default: "_auto_transcribed.txt",
    },
    outputsuffix: {
      type: "string",
      short: "s",
      default: "_adjusted.txt",
    },
    part: {
      type: "string",
      short: "P",
    },
    offsets: {
      type: "string",
      short: "O",
    },
    force: {
      type: "boolean",
      short: "f",
      default: false,
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
  allowPositionals: true,
});

// Show help if requested
if (values.help) {
  console.log(`
Usage: bun adjust-timestamps.ts [options]

Options:
  -i, --input <directory>      Input directory with transcript files (default: "./videos/transcripts")
  -o, --output <directory>     Output directory for adjusted transcripts (default: "./videos/adjusted_transcripts")
  -p, --pattern <suffix>       File pattern to look for in input directory (default: "_auto_transcribed.txt")
  -s, --outputsuffix <suffix>  Suffix for output files (default: "_adjusted.txt")
  -P, --part <number>          Process only a specific part number
  -O, --offsets <json>         Custom time offsets in JSON format (e.g. '{"1":0,"2":900}')
  -f, --force                  Force reprocessing even if output file already exists
  -h, --help                   Show this help message
  `);
  process.exit(0);
}

const TRANSCRIPTS_DIR = values.input as string;
const OUTPUT_DIR = values.output as string;
const FILE_PATTERN = values.pattern as string;
const OUTPUT_SUFFIX = values.outputsuffix as string;
const SPECIFIC_PART = values.part ? parseInt(values.part as string, 10) : null;
const FORCE_REPROCESS = values.force as boolean;

// Define the time offsets for each part (in seconds)
let offsets: Record<number, number> = {
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

// Apply custom offsets if provided
if (values.offsets) {
  try {
    const customOffsets = JSON.parse(values.offsets as string);
    offsets = { ...offsets, ...customOffsets };
    console.log("Using custom time offsets:", offsets);
  } catch (error) {
    console.error("Error parsing custom offsets. Using default offsets.");
    console.error(error);
  }
}

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

// Process a single file
async function processFile(file: string, partNumber: number): Promise<boolean> {
  const offsetInSeconds = offsets[partNumber] || 0;

  // Determine output filename
  const outputFileName = file.replace(FILE_PATTERN, OUTPUT_SUFFIX);
  const outputPath = join(OUTPUT_DIR, outputFileName);

  // Check if output file already exists
  if (!FORCE_REPROCESS && existsSync(outputPath)) {
    console.log(
      `Skipping ${file} - output file already exists at ${outputPath}`
    );
    console.log(`Use --force flag to reprocess this file`);
    return false;
  }

  try {
    // Read the transcript file
    const filePath = join(TRANSCRIPTS_DIR, file);
    const content = await readFile(filePath, "utf-8");

    // Adjust timestamps
    const adjustedContent = adjustTimestamps(content, offsetInSeconds);

    // Write adjusted content to output file
    await writeFile(outputPath, adjustedContent);

    console.log(
      `Processed ${file} → ${outputFileName} (offset: ${secondsToTime(
        offsetInSeconds
      )})`
    );
    return true;
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
    return false;
  }
}

async function main() {
  try {
    // Validate input directory exists
    if (!existsSync(TRANSCRIPTS_DIR)) {
      console.error(`Error: Input directory ${TRANSCRIPTS_DIR} does not exist`);
      process.exit(1);
    }

    // Create output directory if it doesn't exist
    if (!existsSync(OUTPUT_DIR)) {
      await mkdir(OUTPUT_DIR, { recursive: true });
      console.log(`Created output directory: ${OUTPUT_DIR}`);
    }

    console.log(`Using directories:`);
    console.log(`- Input transcripts: ${TRANSCRIPTS_DIR}`);
    console.log(`- Output adjusted transcripts: ${OUTPUT_DIR}`);
    console.log(`- Input file pattern: ${FILE_PATTERN}`);
    console.log(`- Output file suffix: ${OUTPUT_SUFFIX}`);
    console.log(`- Force reprocessing: ${FORCE_REPROCESS ? "Yes" : "No"}`);

    if (SPECIFIC_PART !== null) {
      console.log(`Processing only part ${SPECIFIC_PART}`);
    }

    // Get all transcript files
    const files = await readdir(TRANSCRIPTS_DIR);
    const transcriptFiles = files.filter((file) => file.endsWith(FILE_PATTERN));

    if (transcriptFiles.length === 0) {
      console.log(
        `No transcript files ending with "${FILE_PATTERN}" found in ${TRANSCRIPTS_DIR}`
      );
      return;
    }

    console.log(`Found ${transcriptFiles.length} transcript files to process`);

    // Keep track of successfully processed files
    const processedFiles: string[] = [];

    // Process each file
    for (const file of transcriptFiles) {
      try {
        // Extract part number from filename - handle both formats
        // For part1, part2, etc.
        let partMatch = file.match(/part(\d+)/);

        // For segment_001, segment_002, etc.
        if (!partMatch) {
          partMatch = file.match(/segment_0*(\d+)/);
        }

        if (!partMatch) {
          console.log(`Could not determine part number for ${file}, skipping`);
          continue;
        }

        const partNumber = parseInt(partMatch[1], 10);

        // Skip if not the specified part
        if (SPECIFIC_PART !== null && partNumber !== SPECIFIC_PART) {
          continue;
        }

        const success = await processFile(file, partNumber);
        if (success) {
          processedFiles.push(file);
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }

    // Print summary
    if (processedFiles.length > 0) {
      console.log(`\n✅ Successfully processed ${processedFiles.length} files`);
    } else {
      console.log("⚠️ No files were processed.");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
