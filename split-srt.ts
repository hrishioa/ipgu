#!/usr/bin/env bun

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { parseArgs } from "util";

// Define types
interface TimeRange {
  start: number;
  end: number;
  filename: string;
}

interface SubtitleBlock {
  id: string;
  content: string;
}

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: {
      type: "string",
      short: "o",
      default: ".",
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
  allowPositionals: true,
});

// Show help if requested or if no input file is provided
if (values.help || positionals.length === 0) {
  console.log(`
Usage: bun split-srt.ts [options] <srt-file>

Options:
  -o, --output <directory>  Output directory for SRT chunks (default: current directory)
  -h, --help                Show this help message
  `);
  process.exit(values.help ? 0 : 1);
}

const inputFile = positionals[0];
const outputDir = values.output as string;

// Create output directory if it doesn't exist
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// Parse SRT timestamp to seconds
function timeToSeconds(time: string): number {
  const [hours, minutes, seconds] = time.split(":").map((part) => {
    if (part.includes(",")) {
      const [sec, ms] = part.split(",");
      return parseFloat(`${sec}.${ms}`);
    }
    return parseInt(part);
  });

  return hours * 3600 + minutes * 60 + seconds;
}

// Format seconds back to SRT timestamp
function secondsToTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const sec = Math.floor(seconds);
  const ms = Math.round((seconds - sec) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${sec.toString().padStart(2, "0")},${ms
    .toString()
    .padStart(3, "0")}`;
}

// Read the original SRT file
console.log(`Reading SRT file: ${inputFile}`);
const content = readFileSync(inputFile, "utf-8");

// Get base filename without extension for output files
const baseFileName = basename(inputFile, ".srt").replace(/\.[^/.]+$/, "");

// Parse the SRT content
const subtitleBlocks: SubtitleBlock[] = [];
let currentBlock: string[] = [];
let currentId: string = "";
let inSubtitle: boolean = false;

content.split("\n").forEach((line) => {
  line = line.trim();

  // If we encounter a number at the start of a block
  if (!isNaN(Number(line)) && !inSubtitle) {
    inSubtitle = true;
    currentId = line;
    currentBlock = [line];
  } else if (line === "" && inSubtitle) {
    // End of a subtitle block
    if (currentBlock.length > 0) {
      subtitleBlocks.push({
        id: currentId,
        content: currentBlock.join("\n"),
      });
    }
    inSubtitle = false;
    currentBlock = [];
    currentId = "";
  } else if (inSubtitle) {
    currentBlock.push(line);
  }
});

// Add the last block if it exists
if (currentBlock.length > 0) {
  subtitleBlocks.push({
    id: currentId,
    content: currentBlock.join("\n"),
  });
}

console.log(`Parsed ${subtitleBlocks.length} subtitle blocks`);

// Define the time ranges with 20 minute chunks and 5 minute overlaps
const timeRanges: TimeRange[] = [];
let startTime = 0;
let partIndex = 1;

// Calculate total duration from the last subtitle block
const lastBlock = subtitleBlocks[subtitleBlocks.length - 1];
const lastBlockLines = lastBlock.content.split("\n");
const lastTimelineLine = lastBlockLines[1];
const lastEndTime = timeToSeconds(lastTimelineLine.split(" --> ")[1]);
const totalDuration = Math.ceil(lastEndTime / 60) * 60; // Round up to nearest minute

while (startTime < totalDuration) {
  const endTime = Math.min(startTime + 20 * 60, totalDuration); // 20 minute chunks
  timeRanges.push({
    start: startTime,
    end: endTime,
    filename: join(outputDir, `${baseFileName}_part${partIndex}.srt`),
  });

  startTime = endTime - 5 * 60; // 5 minute overlap
  partIndex++;

  // Break if we've reached the end
  if (endTime >= totalDuration) break;
}

console.log(`Generated ${timeRanges.length} time ranges`);

// Process each time range
timeRanges.forEach((range) => {
  const filteredBlocks: SubtitleBlock[] = [];

  subtitleBlocks.forEach((block) => {
    const lines = block.content.split("\n");
    const timelineLine = lines[1];

    if (timelineLine && timelineLine.includes(" --> ")) {
      const [startTime, endTime] = timelineLine.split(" --> ");
      const startSeconds = timeToSeconds(startTime);
      const endSeconds = timeToSeconds(endTime);

      // Check if this subtitle falls within the current time range
      // Include if there's any overlap with the range
      if (
        (startSeconds >= range.start && startSeconds < range.end) ||
        (endSeconds > range.start && endSeconds <= range.end) ||
        (startSeconds <= range.start && endSeconds >= range.end)
      ) {
        filteredBlocks.push(block);
      }
    }
  });

  // Write blocks to file with original numbering
  let output = "";
  filteredBlocks.forEach((block) => {
    output += block.content + "\n\n";
  });

  // Write the output file
  if (output.trim()) {
    writeFileSync(range.filename, output.trim() + "\n");
    console.log(
      `Created ${range.filename} with ${filteredBlocks.length} subtitles`
    );
  } else {
    console.log(`No subtitles found for time range in ${range.filename}`);
  }
});

console.log("SRT splitting complete!");
