#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";

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
const inputFile = "Downloaded-Sandhesam.eng.srt";
const content = readFileSync(inputFile, "utf-8");

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

// Define the time ranges
const timeRanges: TimeRange[] = [
  {
    start: timeToSeconds("00:00:00"),
    end: timeToSeconds("00:20:00"),
    filename: "Sandesham_audio_part1.srt",
  },
  {
    start: timeToSeconds("00:15:00"),
    end: timeToSeconds("00:35:00"),
    filename: "Sandesham_audio_part2.srt",
  },
  {
    start: timeToSeconds("00:30:00"),
    end: timeToSeconds("00:50:00"),
    filename: "Sandesham_audio_part3.srt",
  },
  {
    start: timeToSeconds("00:45:00"),
    end: timeToSeconds("01:05:00"),
    filename: "Sandesham_audio_part4.srt",
  },
  {
    start: timeToSeconds("01:00:00"),
    end: timeToSeconds("01:20:00"),
    filename: "Sandesham_audio_part5.srt",
  },
  {
    start: timeToSeconds("01:15:00"),
    end: timeToSeconds("01:35:00"),
    filename: "Sandesham_audio_part6.srt",
  },
  {
    start: timeToSeconds("01:30:00"),
    end: timeToSeconds("01:50:00"),
    filename: "Sandesham_audio_part7.srt",
  },
  {
    start: timeToSeconds("01:45:00"),
    end: timeToSeconds("02:05:00"),
    filename: "Sandesham_audio_part8.srt",
  },
  {
    start: timeToSeconds("02:00:00"),
    end: timeToSeconds("02:19:30"),
    filename: "Sandesham_audio_part9.srt",
  },
];

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
