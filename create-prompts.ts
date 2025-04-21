#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";
import { parseArgs } from "util";

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    malayalam: {
      type: "string",
      short: "m",
      default: "./videos/adjusted_transcripts",
    },
    english: {
      type: "string",
      short: "e",
      default: "./videos/audio_chunks",
    },
    output: {
      type: "string",
      short: "o",
      default: "./videos/prompts",
    },
    pattern: {
      type: "string",
      short: "t",
      default: "_adjusted.txt",
    },
    englishpattern: {
      type: "string",
      short: "E",
      default: "Sandesham_audio_part{PART}.srt",
    },
    part: {
      type: "string",
      short: "p",
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
Usage: bun create-prompts.ts [options]

Options:
  -m, --malayalam <directory>    Directory with adjusted Malayalam transcripts (default: "./videos/adjusted_transcripts")
  -e, --english <directory>      Directory with English SRT files (default: "./videos/audio_chunks")
  -o, --output <directory>       Output directory for prompt files (default: "./videos/prompts")
  -t, --pattern <suffix>         File pattern to look for in Malayalam directory (default: "_adjusted.txt")
  -E, --englishpattern <pattern> Pattern for English SRT files, use {PART} for part number (default: "Sandesham_audio_part{PART}.srt")
  -p, --part <number>            Process only a specific part number (e.g. 1 for part1)
  -f, --force                    Force recreation of prompt files even if they already exist
  -h, --help                     Show this help message
  `);
  process.exit(0);
}

const ADJUSTED_TRANSCRIPTS_DIR = values.malayalam as string;
const ENGLISH_SRT_DIR = values.english as string;
const PROMPTS_DIR = values.output as string;
const FILE_PATTERN = values.pattern as string;
const ENGLISH_FILE_PATTERN = values.englishpattern as string;
const SPECIFIC_PART = values.part ? parseInt(values.part as string, 10) : null;
const FORCE_REPROCESS = values.force as boolean;

// Template for the prompt
const PROMPT_TEMPLATE = `<malayalam_subs>
{MALAYALAM_SUBS}
</malayalam_subs>

<english_subs>
{ENGLISH_SUBS}
</english_subs>

So I have these english subs which are great for timing but the translation needs a lot of work. I have the malayalam subs I made which are great to understand the context, the honorifics, the deeper meaning.
Can you go line by line and make me new subs using the timings from the eng sub, but completely new english and korean translations using the meanings and story from the malayalam sub? Think about the key tones, preserving the humor and so on before writing.
The subtitles don't match up by line number - they were done independently. Focus on the numbering of the eng subs and the timings, and for each line look at the whole malayalam sub to figure out what the translation should be. You can do the korean subtitles - do your best! If you don't have a matching malayalam line, do your best or keep the english line.
Here's how I want you to respond (don't put sublines in individual markdown blocks, and make sure to close tags properly):
<subline>
<original_number>XXX</original_number>
<original_line>XXX</original_line>
<original_timing>XXX</original_timing>
<better_english_translation>XXXX</better_english_translation>
<korean_translation>XXXXXX</korean_translation>
</subline>`;

async function processFile(
  malayalamFile: string,
  partNumber: number
): Promise<boolean> {
  // Check if output file already exists
  const promptFileName = `prompt_part${partNumber}.txt`;
  const promptFilePath = join(PROMPTS_DIR, promptFileName);

  if (!FORCE_REPROCESS && existsSync(promptFilePath)) {
    console.log(
      `Skipping part ${partNumber} - prompt file already exists at ${promptFilePath}`
    );
    console.log(`Use --force flag to recreate this prompt`);
    return false;
  }

  try {
    // Read the adjusted transcript file
    const malayalamFilePath = join(ADJUSTED_TRANSCRIPTS_DIR, malayalamFile);
    const malayalamContent = await readFile(malayalamFilePath, "utf-8");
    console.log(`✓ Read Malayalam transcript: ${malayalamFilePath}`);

    // Determine the corresponding English SRT file using the pattern
    const englishSrtFileName = ENGLISH_FILE_PATTERN.replace(
      "{PART}",
      partNumber.toString()
    );
    const englishSrtFilePath = join(ENGLISH_SRT_DIR, englishSrtFileName);

    // Check if the English SRT file exists
    let englishContent = "";
    let englishFileFound = false;
    try {
      englishContent = await readFile(englishSrtFilePath, "utf-8");
      englishFileFound = true;
      console.log(`✓ Read English SRT: ${englishSrtFilePath}`);
    } catch (error) {
      console.warn(
        `⚠️ Warning: English SRT file ${englishSrtFileName} not found. Creating prompt with empty English section.`
      );
    }

    // Create the prompt content
    const promptContent = PROMPT_TEMPLATE.replace(
      "{MALAYALAM_SUBS}",
      malayalamContent
    ).replace("{ENGLISH_SUBS}", englishContent);

    // Create the prompt file
    await writeFile(promptFilePath, promptContent);

    // Log success details
    console.log(`✅ Created prompt file: ${promptFilePath}`);
    console.log(`   - Source Malayalam: ${malayalamFile}`);
    console.log(
      `   - Source English: ${
        englishFileFound ? englishSrtFileName : "Not found"
      }`
    );
    console.log(`   - Part number: ${partNumber}`);
    console.log("-----------------------------------------------------");

    return true;
  } catch (error) {
    console.error(`❌ Error processing ${malayalamFile}:`, error);
    return false;
  }
}

async function main() {
  try {
    // Validate input directories exist
    if (!existsSync(ADJUSTED_TRANSCRIPTS_DIR)) {
      console.error(
        `Error: Malayalam transcripts directory ${ADJUSTED_TRANSCRIPTS_DIR} does not exist`
      );
      process.exit(1);
    }

    if (!existsSync(ENGLISH_SRT_DIR)) {
      console.warn(
        `Warning: English SRT directory ${ENGLISH_SRT_DIR} does not exist`
      );
      console.warn(`Prompts will be created with empty English sections`);
    }

    // Create prompts directory if it doesn't exist
    if (!existsSync(PROMPTS_DIR)) {
      await mkdir(PROMPTS_DIR, { recursive: true });
      console.log(`Created directory: ${PROMPTS_DIR}`);
    }

    console.log(`Using directories:`);
    console.log(`- Malayalam transcripts: ${ADJUSTED_TRANSCRIPTS_DIR}`);
    console.log(`- English SRTs: ${ENGLISH_SRT_DIR}`);
    console.log(`- Output prompts: ${PROMPTS_DIR}`);
    console.log(`- Malayalam file pattern: ${FILE_PATTERN}`);
    console.log(`- English file pattern: ${ENGLISH_FILE_PATTERN}`);
    console.log(`- Force reprocessing: ${FORCE_REPROCESS ? "Yes" : "No"}`);

    if (SPECIFIC_PART !== null) {
      console.log(`Processing only part ${SPECIFIC_PART}`);
    }

    // Get all adjusted transcript files
    const files = await readdir(ADJUSTED_TRANSCRIPTS_DIR);
    const adjustedFiles = files.filter((file) => file.endsWith(FILE_PATTERN));

    if (adjustedFiles.length === 0) {
      console.log(
        `No transcript files ending with "${FILE_PATTERN}" found in ${ADJUSTED_TRANSCRIPTS_DIR}`
      );
      return;
    }

    console.log(
      `Found ${adjustedFiles.length} transcript files matching pattern`
    );

    // Keep track of successfully created prompt files
    const createdFiles: string[] = [];

    // Process files
    for (const file of adjustedFiles) {
      // Extract part number from filename - handle both format types
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

      // Skip if not the specified part (if a specific part was requested)
      if (SPECIFIC_PART !== null && partNumber !== SPECIFIC_PART) {
        continue;
      }

      const success = await processFile(file, partNumber);
      if (success) {
        createdFiles.push(`prompt_part${partNumber}.txt`);
      }
    }

    // Print summary
    if (createdFiles.length > 0) {
      console.log("\n📋 Summary of created prompt files:");
      createdFiles.forEach((file, index) => {
        console.log(`${index + 1}. ${file}`);
      });
      console.log(
        `\n✨ Successfully created ${createdFiles.length} prompt files in ${PROMPTS_DIR}`
      );
    } else {
      console.log("⚠️ No prompt files were created.");
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

main();
