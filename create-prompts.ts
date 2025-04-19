#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const ADJUSTED_TRANSCRIPTS_DIR = "./videos/adjusted_transcripts";
const ENGLISH_SRT_DIR = "./videos/audio_chunks";
const PROMPTS_DIR = "./videos/prompts";

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
Here's how I want you to respond:
<subline>
<original_number>XXX</original_number>
<original_line>XXX</original_line>
<original_timing>XXX</original_timing>
<better_english_translation>XXXX</better_english_translation>
<korean_translation>XXXXXX</korean_translation>
</subline>`;

async function main() {
  try {
    // Create prompts directory if it doesn't exist
    if (!existsSync(PROMPTS_DIR)) {
      await mkdir(PROMPTS_DIR, { recursive: true });
      console.log(`Created directory: ${PROMPTS_DIR}`);
    }

    // Get all adjusted transcript files
    const files = await readdir(ADJUSTED_TRANSCRIPTS_DIR);
    const adjustedFiles = files.filter((file) =>
      file.endsWith("_adjusted.txt")
    );

    if (adjustedFiles.length === 0) {
      console.log(
        `No adjusted transcript files found in ${ADJUSTED_TRANSCRIPTS_DIR}`
      );
      return;
    }

    console.log(
      `Found ${adjustedFiles.length} adjusted transcript files to process`
    );

    // Keep track of successfully created prompt files
    const createdFiles: string[] = [];

    // Process each file
    for (const file of adjustedFiles) {
      try {
        // Extract part number from filename
        const partMatch = file.match(/part(\d+)/);
        if (!partMatch) {
          console.log(`Could not determine part number for ${file}, skipping`);
          continue;
        }

        const partNumber = parseInt(partMatch[1], 10);

        // Read the adjusted transcript file
        const malayalamFilePath = join(ADJUSTED_TRANSCRIPTS_DIR, file);
        const malayalamContent = await readFile(malayalamFilePath, "utf-8");
        console.log(`✓ Read Malayalam transcript: ${malayalamFilePath}`);

        // Determine the corresponding English SRT file
        const englishSrtFileName = `Sandesham_audio_part${partNumber}.srt`;
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
        const promptFileName = `prompt_part${partNumber}.txt`;
        const promptFilePath = join(PROMPTS_DIR, promptFileName);
        await writeFile(promptFilePath, promptContent);

        // Log success details
        console.log(`✅ Created prompt file: ${promptFilePath}`);
        console.log(`   - Source Malayalam: ${file}`);
        console.log(
          `   - Source English: ${
            englishFileFound ? englishSrtFileName : "Not found"
          }`
        );
        console.log(`   - Part number: ${partNumber}`);
        console.log("-----------------------------------------------------");

        createdFiles.push(promptFileName);
      } catch (error) {
        console.error(`❌ Error processing ${file}:`, error);
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
