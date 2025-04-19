#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir as fsMkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";

const PRIMARY_RESPONSES_DIR = "./videos/responses";
const BACKUP_RESPONSES_DIR = "./videos/responses2"; // Optional backup
const ORIGINAL_SRT = "./Downloaded-Sandhesam.eng.srt";
const OUTPUT_DIR = "./videos/final_subtitles";
const OUTPUT_SRT = "Sandesham_bilingual.srt";

// Color settings for subtitles
const ENGLISH_COLOR = "FFFFFF"; // White
const KOREAN_COLOR = "FFC0CB"; // Light pink

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let backupDir: string | null = null;
  let useResponseTimings = false;

  // Check if backup directory is specified
  const backupArg = args.find((arg) => arg.startsWith("--backup="));
  if (backupArg) {
    backupDir = backupArg.split("=")[1];
  }

  // Check if we should use response timings instead of original SRT timings
  if (args.includes("--use-response-timings")) {
    useResponseTimings = true;
  }

  return { backupDir, useResponseTimings };
}

// Interface for original subtitle entries
interface OriginalSubtitle {
  id: number;
  timing: string;
  content: string;
  startTime: number;
  endTime: number;
}

// Interface for translated subtitle entries
interface TranslatedSubtitle {
  number: string;
  english: string;
  korean: string;
  source: string; // Which response file this came from
  partNumber: number;
  timing?: string; // Optional timing from response
  startTime?: number;
  endTime?: number;
}

// Interface for the final subtitle entry
interface FinalSubtitle {
  id: number;
  timing: string;
  english: string;
  korean: string;
}

// Interface for parsed SRT entry (used in validation)
interface ParsedSrtEntry {
  id: number;
  startTime: number;
  endTime: number;
  content: string;
}

// Parse SRT timestamp to seconds
function timeToSeconds(time: string): number {
  // Handle formats like 00:14:58,840 or 00:14:58.840
  const timeStr = time.replace(",", ".");
  const [hours, minutes, seconds] = timeStr.split(":").map((part, index) => {
    if (index === 2 && part.includes(".")) {
      const [sec, ms] = part.split(".");
      return parseFloat(`${sec}.${ms}`);
    }
    return parseInt(part);
  });

  return hours * 3600 + minutes * 60 + seconds;
}

// Format seconds to SRT timestamp
function secondsToTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// Parse the original SRT file
async function parseOriginalSrt(
  filePath: string
): Promise<Map<number, OriginalSubtitle>> {
  console.log(chalk.cyan(`Parsing original SRT file: ${filePath}`));
  const content = await readFile(filePath, "utf-8");
  const subtitles = new Map<number, OriginalSubtitle>();

  // Split the file by empty lines to get subtitle blocks
  const blocks = content
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== "");

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);

    if (lines.length >= 3) {
      const id = parseInt(lines[0].trim());
      const timing = lines[1].trim();
      const contentLines = lines.slice(2);
      const content = contentLines.join("\n");

      // Parse timing
      const timingParts = timing.split(" --> ");
      if (timingParts.length === 2) {
        const startTime = timeToSeconds(timingParts[0]);
        const endTime = timeToSeconds(timingParts[1]);

        subtitles.set(id, {
          id,
          timing,
          content,
          startTime,
          endTime,
        });
      }
    }
  }

  console.log(
    chalk.green(
      `Successfully parsed ${subtitles.size} subtitles from original SRT`
    )
  );
  return subtitles;
}

// Parse a response file to extract translated subtitles
async function parseResponseFile(
  filePath: string,
  partNumber: number,
  extractTimings: boolean
): Promise<TranslatedSubtitle[]> {
  const content = await readFile(filePath, "utf-8");
  const translations: TranslatedSubtitle[] = [];

  // Check if the content is wrapped in a markdown code block
  let processableContent = content;
  const markdownBlockMatch = content.match(/```(?:xml)?\s*\n([\s\S]*?)```/);
  if (markdownBlockMatch && markdownBlockMatch[1]) {
    processableContent = markdownBlockMatch[1];
  }

  // Find all <subline> blocks
  const sublineRegex = /<subline>([\s\S]*?)<\/subline>/g;
  let match;

  while ((match = sublineRegex.exec(processableContent)) !== null) {
    const sublineContent = match[1];

    // Extract the components
    function extractTagContent(content: string, tag: string): string | null {
      const startTag = `<${tag}>`;
      const endTag = `</${tag}>`;
      const startIndex = content.indexOf(startTag);
      if (startIndex === -1) return null;

      const valueStartIndex = startIndex + startTag.length;
      const endIndex = content.indexOf(endTag, valueStartIndex);
      if (endIndex === -1) return null;

      return content.substring(valueStartIndex, endIndex).trim();
    }

    const number = extractTagContent(sublineContent, "original_number");
    const english = extractTagContent(
      sublineContent,
      "better_english_translation"
    );
    const korean = extractTagContent(sublineContent, "korean_translation");

    // Also extract timing if requested
    let timing: string | undefined = undefined;
    let startTime: number | undefined = undefined;
    let endTime: number | undefined = undefined;

    if (extractTimings) {
      const timingValue = extractTagContent(sublineContent, "original_timing");
      if (timingValue) {
        timing = timingValue;
        const timingParts = timing.split(" --> ");
        if (timingParts.length === 2) {
          startTime = timeToSeconds(timingParts[0]);
          endTime = timeToSeconds(timingParts[1]);
        }
      }
    }

    if (number && (english || korean)) {
      translations.push({
        number,
        english: english || "",
        korean: korean || "",
        source: filePath,
        partNumber,
        timing,
        startTime,
        endTime,
      });
    }
  }

  return translations;
}

// Process all response files and merge translations
async function processResponseFiles(
  directories: string[],
  extractTimings: boolean
): Promise<Map<string, TranslatedSubtitle>> {
  const allTranslations = new Map<string, TranslatedSubtitle>();

  for (const directory of directories) {
    if (!existsSync(directory)) {
      console.log(
        chalk.yellow(`Directory ${directory} does not exist, skipping`)
      );
      continue;
    }

    console.log(chalk.cyan(`Processing response files from: ${directory}`));

    // Get all response files in this directory
    const files = await readdir(directory);
    const responseFiles = files
      .filter(
        (file) => file.startsWith("response_part") && file.endsWith(".txt")
      )
      .sort((a, b) => {
        // Sort by part number
        const partNumberA = parseInt(a.match(/part(\d+)/)?.[1] || "0", 10);
        const partNumberB = parseInt(b.match(/part(\d+)/)?.[1] || "0", 10);
        return partNumberA - partNumberB;
      });

    if (responseFiles.length === 0) {
      console.log(chalk.yellow(`No response files found in ${directory}`));
      continue;
    }

    console.log(`Found ${responseFiles.length} response files in ${directory}`);

    // Process each file
    for (const file of responseFiles) {
      const partMatch = file.match(/part(\d+)/);
      if (!partMatch) continue;

      const partNumber = parseInt(partMatch[1], 10);
      const filePath = join(directory, file);

      console.log(`Parsing ${file}...`);
      const translations = await parseResponseFile(
        filePath,
        partNumber,
        extractTimings
      );

      console.log(`Found ${translations.length} translations in ${file}`);

      // Add to our merged map, preferring lower part numbers for overlaps
      for (const translation of translations) {
        const existing = allTranslations.get(translation.number);

        // Add if not exists, or replace if from a lower part number
        if (!existing || translation.partNumber < existing.partNumber) {
          allTranslations.set(translation.number, translation);
        }
      }
    }
  }

  return allTranslations;
}

// Generate the final SRT file with colored subtitles
async function generateFinalSrt(
  originalSubtitles: Map<number, OriginalSubtitle>,
  translations: Map<string, TranslatedSubtitle>,
  useResponseTimings: boolean
): Promise<string> {
  const finalSubtitles: FinalSubtitle[] = [];
  let responseTimingsUsed = 0;

  // Match original subtitles with translations
  for (const [id, originalSub] of originalSubtitles.entries()) {
    const translation = translations.get(id.toString());

    if (translation) {
      // Determine which timing to use
      let timing = originalSub.timing;
      if (useResponseTimings && translation.timing) {
        timing = translation.timing;
        responseTimingsUsed++;
      }

      finalSubtitles.push({
        id: originalSub.id,
        timing,
        english: translation.english || originalSub.content,
        korean: translation.korean || "",
      });
    } else {
      // Use original content if no translation found
      finalSubtitles.push({
        id: originalSub.id,
        timing: originalSub.timing,
        english: originalSub.content,
        korean: "",
      });
    }
  }

  if (useResponseTimings) {
    console.log(
      chalk.cyan(`Used response timings for ${responseTimingsUsed} subtitles`)
    );
  }

  // Sort by ID and renumber
  finalSubtitles.sort((a, b) => a.id - b.id);

  // Generate the SRT content with colored text
  let srtContent = "";
  let newId = 1;

  for (const sub of finalSubtitles) {
    // Format the subtitle text with colors
    let subtitleText = "";

    if (sub.english) {
      subtitleText += `<font color="#${ENGLISH_COLOR}">${sub.english}</font>`;
    }

    if (sub.english && sub.korean) {
      subtitleText += "\n";
    }

    if (sub.korean) {
      subtitleText += `<font color="#${KOREAN_COLOR}">${sub.korean}</font>`;
    }

    // Add to SRT content
    srtContent += `${newId}\n${sub.timing}\n${subtitleText}\n\n`;
    newId++;
  }

  return srtContent;
}

// Parse a generated SRT file for validation
async function parseSrtFile(filePath: string): Promise<ParsedSrtEntry[]> {
  const content = await readFile(filePath, "utf-8");
  const parsedEntries: ParsedSrtEntry[] = [];

  // Split the file by empty lines to get subtitle blocks
  const blocks = content
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== "");

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);

    if (lines.length >= 3) {
      const id = parseInt(lines[0].trim());
      const timing = lines[1].trim();
      const contentLines = lines.slice(2);
      const content = contentLines.join("\n");

      // Parse timing
      const timingParts = timing.split(" --> ");
      if (timingParts.length === 2) {
        const startTime = timeToSeconds(timingParts[0]);
        const endTime = timeToSeconds(timingParts[1]);

        parsedEntries.push({
          id,
          startTime,
          endTime,
          content,
        });
      }
    }
  }

  return parsedEntries;
}

// Validate the generated SRT file
async function validateGeneratedSrt(
  outputPath: string,
  originalSubtitles: Map<number, OriginalSubtitle>
): Promise<void> {
  console.log(chalk.cyan("\nValidating generated SRT file..."));

  try {
    // Parse the generated SRT file
    const generatedEntries = await parseSrtFile(outputPath);

    if (generatedEntries.length === 0) {
      console.log(
        chalk.red("❌ Generated SRT file is empty or improperly formatted")
      );
      return;
    }

    console.log(`Parsed ${generatedEntries.length} entries from generated SRT`);

    // 1. Check if number of subtitles matches original
    const originalCount = originalSubtitles.size;
    const generatedCount = generatedEntries.length;

    if (originalCount === generatedCount) {
      console.log(
        chalk.green(`✅ Subtitle count matches original (${originalCount})`)
      );
    } else {
      console.log(
        chalk.yellow(
          `⚠️ Subtitle count differs - Original: ${originalCount}, Generated: ${generatedCount}`
        )
      );
    }

    // 2. Check for sequential numbering
    let hasNumberingIssues = false;
    for (let i = 0; i < generatedEntries.length; i++) {
      const expectedId = i + 1;
      if (generatedEntries[i].id !== expectedId) {
        if (!hasNumberingIssues) {
          console.log(
            chalk.yellow("⚠️ Found non-sequential subtitle numbers:")
          );
          hasNumberingIssues = true;
        }
        console.log(
          `   Entry #${i + 1} has ID ${
            generatedEntries[i].id
          } (expected ${expectedId})`
        );
      }
    }

    if (!hasNumberingIssues) {
      console.log(chalk.green("✅ All subtitle numbers are sequential"));
    }

    // 3. Check for overlapping timestamps
    let hasOverlaps = false;
    let overlapsCount = 0;

    for (let i = 0; i < generatedEntries.length - 1; i++) {
      const current = generatedEntries[i];
      const next = generatedEntries[i + 1];

      if (current.endTime > next.startTime) {
        if (!hasOverlaps) {
          console.log(chalk.yellow("⚠️ Found overlapping timestamps:"));
          hasOverlaps = true;
        }

        overlapsCount++;
        if (overlapsCount <= 5) {
          // Only show the first 5 overlaps
          console.log(
            `   Subtitle #${current.id} (${secondsToTimestamp(
              current.startTime
            )} --> ${secondsToTimestamp(current.endTime)})`
          );
          console.log(
            `   overlaps with #${next.id} (${secondsToTimestamp(
              next.startTime
            )} --> ${secondsToTimestamp(next.endTime)})`
          );
          console.log(
            `   Overlap: ${(current.endTime - next.startTime).toFixed(
              2
            )} seconds`
          );
        }
      }
    }

    if (hasOverlaps && overlapsCount > 5) {
      console.log(`   ... and ${overlapsCount - 5} more overlaps`);
    }

    if (!hasOverlaps) {
      console.log(chalk.green("✅ No overlapping timestamps found"));
    }

    // 4. Check overall duration
    const originalFirstSub = [...originalSubtitles.values()].sort(
      (a, b) => a.startTime - b.startTime
    )[0];
    const originalLastSub = [...originalSubtitles.values()].sort(
      (a, b) => b.endTime - a.endTime
    )[0];
    const originalDuration =
      originalLastSub.endTime - originalFirstSub.startTime;

    const generatedFirstSub = generatedEntries[0];
    const generatedLastSub = generatedEntries[generatedEntries.length - 1];
    const generatedDuration =
      generatedLastSub.endTime - generatedFirstSub.startTime;

    const durationDiff = Math.abs(originalDuration - generatedDuration);

    if (durationDiff < 1) {
      // Less than 1 second difference
      console.log(
        chalk.green(
          `✅ Overall duration matches original (${secondsToTimestamp(
            originalDuration
          )})`
        )
      );
    } else {
      console.log(
        chalk.yellow(
          `⚠️ Duration differs - Original: ${secondsToTimestamp(
            originalDuration
          )}, Generated: ${secondsToTimestamp(generatedDuration)}`
        )
      );
      console.log(`   Difference: ${durationDiff.toFixed(2)} seconds`);
    }

    // Summary
    console.log(chalk.cyan("\nValidation Summary:"));
    if (
      !hasNumberingIssues &&
      !hasOverlaps &&
      durationDiff < 1 &&
      originalCount === generatedCount
    ) {
      console.log(
        chalk.green("✅ Generated SRT file passed all validation checks")
      );
    } else {
      console.log(
        chalk.yellow(
          "⚠️ Generated SRT file has some issues (see details above)"
        )
      );
    }
  } catch (error) {
    console.error(chalk.red(`❌ Error during validation: ${error}`));
  }
}

async function main() {
  try {
    // Parse command line arguments
    const { backupDir, useResponseTimings } = parseArgs();

    // Create output directory if it doesn't exist
    if (!existsSync(OUTPUT_DIR)) {
      await fsMkdir(OUTPUT_DIR, { recursive: true });
      console.log(`Created output directory: ${OUTPUT_DIR}`);
    }

    // Directories to process
    const directories = [PRIMARY_RESPONSES_DIR];
    if (backupDir) {
      directories.push(backupDir);
      console.log(chalk.cyan(`Using backup directory: ${backupDir}`));
    } else if (existsSync(BACKUP_RESPONSES_DIR)) {
      directories.push(BACKUP_RESPONSES_DIR);
      console.log(
        chalk.cyan(`Using default backup directory: ${BACKUP_RESPONSES_DIR}`)
      );
    }

    // Log timing mode
    if (useResponseTimings) {
      console.log(
        chalk.cyan("Using timings from response files instead of original SRT")
      );
    } else {
      console.log(chalk.cyan("Using timings from original SRT file (default)"));
    }

    // Parse the original SRT file
    const originalSubtitles = await parseOriginalSrt(ORIGINAL_SRT);

    // Process all response files and merge translations
    const translations = await processResponseFiles(
      directories,
      useResponseTimings
    );
    console.log(
      chalk.green(`Found translations for ${translations.size} subtitles`)
    );

    // Check for missing translations
    const missingTranslations: number[] = [];
    for (const [id] of originalSubtitles.entries()) {
      if (!translations.has(id.toString())) {
        missingTranslations.push(id);
      }
    }

    if (missingTranslations.length > 0) {
      console.log(
        chalk.yellow(
          `Missing translations for ${missingTranslations.length} subtitles`
        )
      );
      if (missingTranslations.length <= 20) {
        console.log(`Missing IDs: ${missingTranslations.join(", ")}`);
      } else {
        console.log(
          `First 20 missing IDs: ${missingTranslations
            .slice(0, 20)
            .join(", ")}...`
        );
      }
    }

    // Generate the final SRT file
    const srtContent = await generateFinalSrt(
      originalSubtitles,
      translations,
      useResponseTimings
    );

    // Determine output filename based on timing source
    const outputFilename = useResponseTimings
      ? OUTPUT_SRT.replace(".srt", "_resp_timing.srt")
      : OUTPUT_SRT;

    // Write to output file
    const outputPath = join(OUTPUT_DIR, outputFilename);
    await writeFile(outputPath, srtContent);

    console.log(
      chalk.green(`✅ Successfully generated bilingual SRT: ${outputPath}`)
    );
    console.log(`  - Original subtitles: ${originalSubtitles.size}`);
    console.log(`  - With translations: ${translations.size}`);
    console.log(`  - Missing translations: ${missingTranslations.length}`);
    console.log(
      `  - Timing source: ${
        useResponseTimings ? "Response files" : "Original SRT"
      }`
    );

    // Validate the generated SRT file
    await validateGeneratedSrt(outputPath, originalSubtitles);
  } catch (error) {
    console.error(chalk.red("❌ Error:"), error);
  }
}

main();
