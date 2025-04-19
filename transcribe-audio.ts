#!/usr/bin/env bun

import { GoogleGenAI } from "@google/genai";
import { readdir, writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { parseArgs } from "util";
import { existsSync } from "fs";

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: {
      type: "string",
      short: "i",
      default: "./videos/audio_chunks",
    },
    output: {
      type: "string",
      short: "o",
      default: "./videos/transcripts",
    },
    key: {
      type: "string",
      short: "k",
    },
    concurrent: {
      type: "string",
      short: "c",
      default: "0", // 0 means process all in parallel
    },
    file: {
      type: "string",
      short: "f",
    },
    force: {
      type: "boolean",
      short: "F",
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
Usage: bun transcribe-audio.ts [options]

Options:
  -i, --input <directory>     Input directory with MP3 files (default: "./videos/audio_chunks")
  -o, --output <directory>    Output directory for transcripts (default: "./videos/transcripts")
  -k, --key <api-key>         Gemini API key (fallback to GEMINI_API_KEY env var if not provided)
  -c, --concurrent <number>   Maximum number of concurrent transcriptions (default: 0, process all in parallel)
  -f, --file <filename>       Process only the specified MP3 file
  -F, --force                 Force reprocessing even if output file already exists
  -h, --help                  Show this help message
  `);
  process.exit(0);
}

const AUDIO_DIR = values.input as string;
const OUTPUT_DIR = values.output as string;
const MAX_CONCURRENT = parseInt(values.concurrent as string, 10) || 0;
const SPECIFIC_FILE = values.file as string;
const FORCE_REPROCESS = values.force as boolean;

async function transcribeAudio(
  audioPath: string,
  apiKey: string
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
  });

  console.log(`Uploading ${audioPath}...`);
  const file = await ai.files.upload({ file: audioPath });

  const config = {
    responseMimeType: "text/plain",
  };

  const model = "gemini-2.5-pro-preview-03-25";
  const contents = [
    {
      role: "user",
      parts: [
        {
          fileData: {
            fileUri: file.uri,
            mimeType: file.mimeType,
          },
        },
        {
          text: `Here's part of a movie I want to subtitle. Can you give me the transcript in malayalam to the best of your ability with timestamps? Don't worry about getting the timestamps correct - but transcribe all that you can. Don't think too much - just start - it's about 20 minutes.

Use this format:
relative (mm:ss - mm:ss) - (line)`,
        },
      ],
    },
  ];

  console.log(`Transcribing ${basename(audioPath)}...`);
  let fullTranscript = "";
  const response = await ai.models.generateContentStream({
    model,
    config,
    contents,
  });

  for await (const chunk of response) {
    fullTranscript += chunk.text;
    // Print a dot for progress indication
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  return fullTranscript;
}

// Process files with controlled concurrency
async function processWithConcurrency(
  audioFiles: string[],
  apiKey: string
): Promise<void> {
  if (MAX_CONCURRENT <= 0 || MAX_CONCURRENT >= audioFiles.length) {
    // Process all in parallel
    const tasks = audioFiles.map((file) => processFile(file, apiKey));
    await Promise.all(tasks);
  } else {
    // Process with concurrency limit
    console.log(`Processing with concurrency limit of ${MAX_CONCURRENT}`);

    // Process files in batches
    for (let i = 0; i < audioFiles.length; i += MAX_CONCURRENT) {
      const batch = audioFiles.slice(i, i + MAX_CONCURRENT);
      const tasks = batch.map((file) => processFile(file, apiKey));

      await Promise.all(tasks);
      console.log(
        `Completed batch ${Math.floor(i / MAX_CONCURRENT) + 1}/${Math.ceil(
          audioFiles.length / MAX_CONCURRENT
        )}`
      );
    }
  }
}

// Process a single file
async function processFile(file: string, apiKey: string): Promise<void> {
  const audioPath = join(AUDIO_DIR, file);
  const outputFileName = `${file.replace(".mp3", "")}_auto_transcribed.txt`;
  const outputPath = join(OUTPUT_DIR, outputFileName);

  // Check if output file already exists
  if (!FORCE_REPROCESS && existsSync(outputPath)) {
    console.log(
      `Skipping ${file} - output file already exists at ${outputPath}`
    );
    console.log(`Use --force flag to reprocess this file`);
    return;
  }

  try {
    const transcript = await transcribeAudio(audioPath, apiKey);
    await writeFile(outputPath, transcript);
    console.log(`Successfully transcribed ${file} to ${outputPath}`);
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
  }
}

async function main() {
  // Get API key from command line or environment variable
  const apiKey = (values.key as string) || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error(
      "Error: Gemini API key not provided. Use --key option or set GEMINI_API_KEY environment variable"
    );
    process.exit(1);
  }

  try {
    // Create output directory if it doesn't exist
    if (!existsSync(OUTPUT_DIR)) {
      await mkdir(OUTPUT_DIR, { recursive: true });
      console.log(`Created output directory: ${OUTPUT_DIR}`);
    }

    // Process specific file if provided
    if (SPECIFIC_FILE) {
      if (!SPECIFIC_FILE.endsWith(".mp3")) {
        console.error("Error: Specified file must have .mp3 extension");
        process.exit(1);
      }

      const filePath = join(AUDIO_DIR, SPECIFIC_FILE);
      if (!existsSync(filePath)) {
        console.error(`Error: File ${filePath} does not exist`);
        process.exit(1);
      }

      console.log(`Processing single file: ${SPECIFIC_FILE}`);
      await processFile(SPECIFIC_FILE, apiKey);
      console.log("Processing completed!");
      return;
    }

    // Otherwise process all files
    const files = await readdir(AUDIO_DIR);
    const audioFiles = files.filter((file) => file.endsWith(".mp3"));

    if (audioFiles.length === 0) {
      console.log(`No MP3 files found in ${AUDIO_DIR}`);
      return;
    }

    console.log(
      `Found ${audioFiles.length} audio files to transcribe in ${AUDIO_DIR}`
    );
    console.log(`Transcripts will be saved to ${OUTPUT_DIR}`);
    console.log(
      `${
        FORCE_REPROCESS
          ? "Will force reprocessing of all files"
          : "Skipping files that already have transcripts"
      }`
    );

    // Process files with controlled concurrency
    await processWithConcurrency(audioFiles, apiKey);

    console.log("All transcription tasks completed!");
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
