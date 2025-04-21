#!/usr/bin/env bun

/**
 * Main Subtitle Generation Script
 *
 * Reads original SRT, parses translated response files using the
 * subtitle-parser module, merges translations, handles fallbacks,
 * applies colors, fixes overlaps, and generates the final bilingual SRT file.
 */

import { readdir, readFile, writeFile, mkdir as fsMkdir } from "fs/promises";
import { join, parse as parsePath } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import { parseArgs } from "util";

// Import the parsing function and types from the standalone module
import {
  parseSubtitleFileContent,
  type ParsedSubtitle,
  type ParseResult,
  type ParsingIssue, // Keep if you want to access issue details, e.g., counts
} from "./subtitle-parser"; // Adjust path if necessary

// Default paths (can be overridden via command line)
const DEFAULT_PRIMARY_DIR = "./videos/responses";
const DEFAULT_BACKUP_DIR = "./videos/responses2";
const DEFAULT_ORIGINAL_SRT = "./Downloaded-Sandhesam.eng.srt";
const DEFAULT_OUTPUT_DIR = "./videos/final_subtitles";
const DEFAULT_OUTPUT_SRT = "Sandesham_bilingual.srt";

// Color settings for subtitles
const ENGLISH_COLOR = "FFFFFF"; // White
const KOREAN_COLOR = "FFC0CB"; // Light pink

// --- Command Line Argument Parsing ---
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    primary: { type: "string", short: "p", default: DEFAULT_PRIMARY_DIR },
    backup: { type: "string", short: "b" },
    original: { type: "string", short: "o", default: DEFAULT_ORIGINAL_SRT },
    output: { type: "string", short: "O", default: DEFAULT_OUTPUT_DIR },
    filename: { type: "string", short: "f", default: DEFAULT_OUTPUT_SRT },
    responsetimings: { type: "boolean", short: "r", default: false },
    colors: { type: "string", short: "c" },
    verbose: { type: "boolean", short: "v", default: false },
    markfallbacks: { type: "boolean", short: "m", default: true },
    // Removed debugfile (-d) - use the standalone parser for detailed reports
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

// --- Help Text ---
if (values.help) {
  console.log(`
Usage: bun generate-subtitles.ts [options]

Description:
  Generates a bilingual SRT file by merging translations from response files
  with an original SRT file. Uses subtitle-parser module for parsing responses.

Options:
  -p, --primary <directory>    Primary responses directory (default: "${DEFAULT_PRIMARY_DIR}")
  -b, --backup <directory>     Backup responses directory (uses "${DEFAULT_BACKUP_DIR}" if exists and not specified)
  -o, --original <file>        Original SRT file (default: "${DEFAULT_ORIGINAL_SRT}")
  -O, --output <directory>     Output directory (default: "${DEFAULT_OUTPUT_DIR}")
  -f, --filename <filename>    Base output filename (default: "${DEFAULT_OUTPUT_SRT}")
  -r, --responsetimings        Use timings from response files instead of original SRT
  -c, --colors <colors>        Subtitle colors as "english,korean" (default: "${ENGLISH_COLOR},${KOREAN_COLOR}")
  -v, --verbose                Show detailed processing information (including parser summary per file)
  -m, --markfallbacks          Mark subtitles where original line is used as fallback (default: true)
  -h, --help                   Show this help message

Examples:
  bun generate-subtitles.ts
  bun generate-subtitles.ts -p ./responses_v1 -b ./responses_v2 -r
  bun generate-subtitles.ts -f my_movie.srt -O ./output -v
  `);
  process.exit(0);
}

// --- Configuration ---
const primaryDir = values.primary as string;
const originalSrtPath = values.original as string;
const outputDir = values.output as string;
const baseOutputFilename = values.filename as string;
const useResponseTimings = values.responsetimings as boolean;
const verboseMode = values.verbose as boolean;
const markFallbacks = values.markfallbacks as boolean;

// Handle backup directory
let backupDir: string | null = null;
if (values.backup) {
  backupDir = values.backup as string;
} else if (existsSync(DEFAULT_BACKUP_DIR)) {
  backupDir = DEFAULT_BACKUP_DIR;
}

// Handle custom colors
let englishColor = ENGLISH_COLOR;
let koreanColor = KOREAN_COLOR;
if (values.colors) {
  const colors = (values.colors as string).split(",");
  if (colors.length >= 2) {
    englishColor = colors[0].trim();
    koreanColor = colors[1].trim();
  }
}

// --- Interfaces ---

// Interface for original subtitle entries (parsed from input SRT)
interface OriginalSubtitle {
  id: number;
  timing: string;
  content: string;
  startTime: number;
  endTime: number;
}

// Interface for translated subtitle entries after processing module results
// Combines module's ParsedSubtitle with source file info
interface TranslatedSubtitle {
  number: string;
  english: string; // Use empty string "" for null from parser
  korean: string; // Use empty string "" for null from parser
  timing?: string;
  startTime?: number;
  endTime?: number;
  source: string; // Which response file this came from
  partNumber: number; // Which part number file
}

// Interface for the final subtitle entry before writing to SRT
interface FinalSubtitle {
  id: number;
  timing: string;
  english: string;
  korean: string;
  startTime: number;
  endTime: number;
  isFallback?: boolean;
}

// Interface for parsed SRT entry (used only in validation)
interface ParsedSrtEntry {
  id: number;
  startTime: number;
  endTime: number;
  content: string;
}

// --- Utility Functions (kept for SRT parsing/generation/validation) ---

// Parse SRT timestamp (HH:MM:SS,ms) to seconds
function timeToSeconds(time: string): number {
  const timeStr = time.replace(",", ".");
  const parts = timeStr.split(":");
  if (parts.length !== 3)
    throw new Error(`Invalid SRT time format: "${time}". Expected HH:MM:SS,ms`);

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const secondsWithMs = parseFloat(parts[2]);

  if (
    isNaN(hours) ||
    isNaN(minutes) ||
    isNaN(secondsWithMs) ||
    hours < 0 ||
    minutes < 0 ||
    minutes > 59 ||
    secondsWithMs < 0 ||
    secondsWithMs >= 60
  ) {
    throw new Error(`Invalid SRT time components in "${time}"`);
  }
  return hours * 3600 + minutes * 60 + secondsWithMs;
}

// Format seconds to SRT timestamp (HH:MM:SS,ms)
function secondsToTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) {
    console.warn(
      chalk.yellow(
        `Attempted to format invalid seconds value: ${seconds}. Returning 00:00:00,000`
      )
    );
    return "00:00:00,000";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  // Ensure milliseconds are handled correctly, even for integer seconds
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// Helper function to check if timing is valid (used by generateFinalSrt)
function isValidTiming(
  startTime: number | undefined,
  endTime: number | undefined
): boolean {
  if (
    startTime === undefined ||
    endTime === undefined ||
    isNaN(startTime) ||
    isNaN(endTime)
  ) {
    return false;
  }
  // Check if end is strictly after start
  if (endTime <= startTime) {
    return false;
  }
  // Check for reasonable duration (e.g., 0.05 sec to 20 sec) - adjust as needed
  const duration = endTime - startTime;
  if (duration < 0.05 || duration > 20) {
    if (verboseMode)
      console.warn(
        chalk.yellow(
          `Suspicious duration ${duration.toFixed(
            3
          )}s for time ${secondsToTimestamp(startTime)} -> ${secondsToTimestamp(
            endTime
          )}`
        )
      );
    // Allow potentially long durations for now, but definitely reject negative/zero/tiny duration
    // return duration > 0; // Allow durations > 20s for now, just ensure end > start
  }
  return true; // Return true if end > start and duration > threshold (0.05s)
}

// Parse the original SRT file (remains the same)
async function parseOriginalSrt(
  filePath: string
): Promise<Map<number, OriginalSubtitle>> {
  console.log(chalk.cyan(`Parsing original SRT file: ${filePath}`));
  const content = await readFile(filePath, "utf-8");
  const subtitles = new Map<number, OriginalSubtitle>();
  const blocks = content
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== "");

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length >= 3) {
      const idStr = lines[0].trim();
      const timing = lines[1].trim();
      const contentLines = lines.slice(2);
      const contentText = contentLines.join("\n");
      const id = parseInt(idStr, 10);

      if (isNaN(id)) {
        console.warn(
          chalk.yellow(
            `Skipping invalid block in original SRT (invalid ID): ${idStr}`
          )
        );
        continue;
      }

      const timingParts = timing.split(" --> ");
      if (timingParts.length === 2) {
        try {
          const startTime = timeToSeconds(timingParts[0].trim());
          const endTime = timeToSeconds(timingParts[1].trim());

          if (endTime <= startTime) {
            console.warn(
              chalk.yellow(
                `Skipping invalid block in original SRT (ID ${id}): end time <= start time (${timing})`
              )
            );
            continue;
          }

          subtitles.set(id, {
            id,
            timing,
            content: contentText,
            startTime,
            endTime,
          });
        } catch (e: any) {
          console.warn(
            chalk.yellow(
              `Skipping invalid block in original SRT (ID ${id}): Error parsing timing "${timing}". ${e.message}`
            )
          );
        }
      } else {
        console.warn(
          chalk.yellow(
            `Skipping invalid block in original SRT (ID ${id}): Malformed timing line "${timing}"`
          )
        );
      }
    }
  }
  console.log(
    chalk.green(
      `Successfully parsed ${subtitles.size} subtitles from ${filePath}`
    )
  );
  return subtitles;
}

// --- Core Logic ---

/**
 * Processes response files from specified directories using the subtitle-parser module.
 * @param directories List of directory paths containing response files.
 * @param extractTimings Flag indicating whether to use timings from responses.
 * @returns A map of subtitle ID (string) to the best found TranslatedSubtitle.
 */
async function processResponseFiles(
  directories: string[],
  extractTimings: boolean
): Promise<Map<string, TranslatedSubtitle>> {
  const allTranslations = new Map<string, TranslatedSubtitle>();
  let totalFilesProcessed = 0;
  let totalParsedFromFile = 0;
  let totalParserErrors = 0;
  let totalParserWarnings = 0;

  for (const directory of directories) {
    if (!existsSync(directory)) {
      console.log(
        chalk.yellow(`Directory ${directory} does not exist, skipping.`)
      );
      continue;
    }
    console.log(chalk.cyan(`Processing response files from: ${directory}`));

    const files = await readdir(directory);
    const responseFiles = files
      .filter(
        (file) => file.startsWith("response_part") && file.endsWith(".txt")
      )
      .sort((a, b) => {
        const partNumberA = parseInt(a.match(/part(\d+)/)?.[1] || "0", 10);
        const partNumberB = parseInt(b.match(/part(\d+)/)?.[1] || "0", 10);
        return partNumberA - partNumberB;
      });

    if (responseFiles.length === 0) {
      console.log(chalk.yellow(`No response files found in ${directory}.`));
      continue;
    }
    console.log(
      `Found ${responseFiles.length} response files in ${directory}.`
    );

    // Process each file using the imported parser
    for (const file of responseFiles) {
      totalFilesProcessed++;
      const partMatch = file.match(/part(\d+)/);
      const partNumber = partMatch ? parseInt(partMatch[1], 10) : 0; // Assign 0 if no part number found
      const filePath = join(directory, file);

      try {
        if (verboseMode) console.log(`Parsing ${file}...`);
        const fileContent = await readFile(filePath, "utf-8");

        // Call the parser module function
        // Note: The parser module itself handles the extractTimings logic internally now
        const {
          subtitles: parsedEntries,
          issues,
          summary,
        } = parseSubtitleFileContent(fileContent);

        totalParsedFromFile += summary.successfullyParsed;
        totalParserErrors += summary.errors;
        totalParserWarnings += summary.warnings;

        if (verboseMode) {
          console.log(
            chalk.blue(`  Parser Summary for ${file}: `) +
              chalk.green(`${summary.successfullyParsed} parsed`) +
              chalk.red(`, ${summary.errors} errors`) +
              chalk.yellow(`, ${summary.warnings} warnings`)
          );
        } else if (summary.errors > 0 || summary.warnings > 0) {
          // Log concise summary if not verbose but issues exist
          console.log(
            chalk.yellow(
              `  Parsed ${file}: ${summary.successfullyParsed} subs`
            ) +
              (summary.errors > 0
                ? chalk.red(`, ${summary.errors} errors`)
                : "") +
              (summary.warnings > 0
                ? chalk.yellow(`, ${summary.warnings} warnings`)
                : "")
          );
        }

        // Add successfully parsed entries to our merged map
        for (const parsedEntry of parsedEntries) {
          // Map ParsedSubtitle from module to TranslatedSubtitle for this script
          const translation: TranslatedSubtitle = {
            number: parsedEntry.number,
            english: parsedEntry.english ?? "", // Handle null from parser
            korean: parsedEntry.korean ?? "", // Handle null from parser
            timing: parsedEntry.timing,
            startTime: parsedEntry.startTime,
            endTime: parsedEntry.endTime,
            source: filePath, // Add source file path
            partNumber: partNumber, // Add part number
          };

          const existing = allTranslations.get(translation.number);
          // Add if not exists, or replace if from a lower part number (prefer earlier parts)
          if (!existing || translation.partNumber < existing.partNumber) {
            allTranslations.set(translation.number, translation);
          }
        }
      } catch (error: any) {
        console.error(
          chalk.red(`❌ Error processing file ${filePath}: ${error.message}`)
        );
        // Optionally skip file or handle error differently
      }
    } // End loop through files in directory
  } // End loop through directories

  console.log(chalk.cyan("\n--- Response File Processing Summary ---"));
  console.log(` - Total files processed: ${totalFilesProcessed}`);
  console.log(` - Total subtitles parsed from files: ${totalParsedFromFile}`);
  console.log(
    chalk.red(` - Total parser errors reported: ${totalParserErrors}`)
  );
  console.log(
    chalk.yellow(` - Total parser warnings reported: ${totalParserWarnings}`)
  );
  console.log(` - Final unique translated subtitles: ${allTranslations.size}`);
  console.log(chalk.cyan("----------------------------------------"));

  return allTranslations;
}

/**
 * Generates the final SRT file content.
 * @param originalSubtitles Map of original subtitles.
 * @param translations Map of translated subtitles.
 * @param useResponseTimings Flag to use timings from translations if available and valid.
 * @returns The final SRT content as a string.
 */
async function generateFinalSrt(
  originalSubtitles: Map<number, OriginalSubtitle>,
  translations: Map<string, TranslatedSubtitle>,
  useResponseTimingsFlag: boolean // Renamed to avoid conflict with module's internal flag name
): Promise<string> {
  const finalSubtitles: FinalSubtitle[] = [];
  let responseTimingsUsedCount = 0;
  let fallbackCount = 0;
  let markedFallbacksCount = 0;
  let timingSourceIssuesCount = 0;

  console.log(chalk.cyan("\nGenerating final SRT content..."));

  // Match original subtitles with translations
  for (const [id, originalSub] of originalSubtitles.entries()) {
    const translation = translations.get(id.toString());
    let finalTiming = originalSub.timing;
    let finalStartTime = originalSub.startTime;
    let finalEndTime = originalSub.endTime;
    let timingSource = "Original SRT"; // Track where the timing came from

    if (translation) {
      // Determine which timing to use
      if (
        useResponseTimingsFlag &&
        translation.startTime !== undefined && // Check for parsed seconds
        translation.endTime !== undefined
      ) {
        // The parser module already validated the timing format and basic logic (end > start)
        // We perform a final check here, potentially with stricter duration limits if needed
        if (isValidTiming(translation.startTime, translation.endTime)) {
          // Use the raw timing string from the translation if available, otherwise format the parsed seconds
          finalTiming =
            translation.timing ??
            `${secondsToTimestamp(
              translation.startTime
            )} --> ${secondsToTimestamp(translation.endTime)}`;
          finalStartTime = translation.startTime;
          finalEndTime = translation.endTime;
          responseTimingsUsedCount++;
          timingSource = `Response (${parsePath(translation.source).base})`;
        } else {
          // This might happen if isValidTiming here has stricter rules than the parser's internal check
          timingSourceIssuesCount++;
          if (verboseMode)
            console.log(
              chalk.magenta(
                `⚠️ Using original timing for ID ${id} despite -r flag, as response timing from ${translation.source} ` +
                  `("${
                    translation.timing ?? "N/A"
                  }" -> ${translation.startTime?.toFixed(
                    3
                  )}s-${translation.endTime?.toFixed(
                    3
                  )}s) failed final validation.`
              )
            );
          // Keep original timing (already set)
        }
      } else if (useResponseTimingsFlag) {
        // Requested response timing, but it wasn't successfully parsed/extracted by the module
        timingSourceIssuesCount++;
        if (verboseMode)
          console.log(
            chalk.magenta(
              `ℹ️ Using original timing for ID ${id} despite -r flag, as no valid timing data was found in response from ${translation.source}.`
            )
          );
        // Keep original timing (already set)
      }
      // If not useResponseTimingsFlag, or if response timing was invalid/missing, we stick with originalSub timings

      const isFallback = !translation.english && !!originalSub.content; // Fallback if no English text AND original exists
      finalSubtitles.push({
        id: originalSub.id,
        timing: finalTiming,
        english: translation.english || originalSub.content, // Fallback TEXT uses original content
        korean: translation.korean || "", // Korean defaults to empty if missing
        startTime: finalStartTime,
        endTime: finalEndTime,
        isFallback: isFallback,
      });

      if (isFallback) {
        fallbackCount++;
      }
    } else {
      // No translation found for this ID
      fallbackCount++;
      finalSubtitles.push({
        id: originalSub.id,
        timing: originalSub.timing, // Uses ORIGINAL timing
        english: originalSub.content, // Uses ORIGINAL content
        korean: "",
        startTime: originalSub.startTime,
        endTime: originalSub.endTime,
        isFallback: true, // Mark as fallback since no translation was found
      });
      timingSource = "Original SRT (No Translation)";
    }

    // Optional: Log timing source per subtitle in verbose mode
    // if (verboseMode) console.log(`  ID ${id}: Timing from ${timingSource}`);
  } // End loop through original subtitles

  // --- Report Timing Usage ---
  if (useResponseTimingsFlag) {
    console.log(
      chalk.cyan(
        `Attempted to use response timings: Used successfully for ${responseTimingsUsedCount} subtitles.`
      )
    );
    if (timingSourceIssuesCount > 0) {
      console.log(
        chalk.yellow(
          `Could not use response timing for ${timingSourceIssuesCount} subtitles (missing/invalid), used original SRT timing instead.`
        )
      );
    }
  } else {
    console.log(chalk.cyan(`Using timings from original SRT file.`));
  }

  if (fallbackCount > 0) {
    console.log(
      chalk.yellow(
        `Used original content as fallback for ${fallbackCount} subtitles (missing or empty English translation).`
      )
    );
  }

  // --- Fix Overlaps ---
  console.log(chalk.cyan("Checking for and fixing timestamp overlaps..."));
  // Sort by start time to handle overlaps correctly
  finalSubtitles.sort((a, b) => a.startTime - b.startTime);

  let overlapsFixedCount = 0;
  const MIN_SUB_DURATION = 0.1; // Minimum duration in seconds
  const GAP_BEFORE_NEXT = 0.05; // Gap before next subtitle starts (50ms)

  for (let i = 0; i < finalSubtitles.length - 1; i++) {
    const current = finalSubtitles[i];
    const next = finalSubtitles[i + 1];

    // Check for overlap (current ends after next starts)
    if (current.endTime > next.startTime) {
      const overlapAmount = current.endTime - next.startTime;

      // Attempt to fix by shortening the current subtitle
      const newEndTime = next.startTime - GAP_BEFORE_NEXT;

      // Ensure the new end time doesn't make the duration too short or negative
      if (newEndTime - current.startTime >= MIN_SUB_DURATION) {
        if (verboseMode && overlapsFixedCount < 10) {
          // Log first few fixes
          console.log(
            chalk.yellow(
              `  Fixing overlap: ID ${current.id} (${current.startTime.toFixed(
                3
              )}s -> ${current.endTime.toFixed(3)}s) ` +
                `overlaps ID ${next.id} (${next.startTime.toFixed(
                  3
                )}s -> ${next.endTime.toFixed(3)}s) by ${overlapAmount.toFixed(
                  3
                )}s. ` +
                `Adjusting ID ${current.id} end to ${newEndTime.toFixed(3)}s.`
            )
          );
        }
        current.endTime = newEndTime;
        // Update the timing string based on adjusted seconds
        current.timing = `${secondsToTimestamp(
          current.startTime
        )} --> ${secondsToTimestamp(current.endTime)}`;
        overlapsFixedCount++;
      } else {
        // Cannot shorten current without making it too short, try shifting the *next* subtitle
        const requiredShift =
          current.endTime + GAP_BEFORE_NEXT - next.startTime;
        const nextOriginalDuration = next.endTime - next.startTime;
        next.startTime += requiredShift;
        next.endTime = next.startTime + nextOriginalDuration; // Maintain duration

        if (verboseMode && overlapsFixedCount < 10) {
          // Log first few fixes
          console.log(
            chalk.yellow(
              `  Fixing overlap: ID ${current.id} (${current.startTime.toFixed(
                3
              )}s -> ${current.endTime.toFixed(3)}s) ` +
                `overlaps ID ${next.id} (${(
                  next.startTime - requiredShift
                ).toFixed(3)}s -> ${(next.endTime - requiredShift).toFixed(
                  3
                )}s) by ${overlapAmount.toFixed(3)}s. ` +
                `Cannot shorten ID ${current.id}. Shifting ID ${
                  next.id
                } start to ${next.startTime.toFixed(3)}s.`
            )
          );
        }
        // Update the timing string for the *next* subtitle
        next.timing = `${secondsToTimestamp(
          next.startTime
        )} --> ${secondsToTimestamp(next.endTime)}`;
        overlapsFixedCount++; // Count as fixed even though we shifted the next one
      }
    }
  }

  if (overlapsFixedCount > 0) {
    console.log(
      chalk.green(
        `Adjusted timings for ${overlapsFixedCount} overlapping subtitles.`
      )
    );
    if (verboseMode && overlapsFixedCount >= 10) {
      console.log(
        chalk.yellow(`  (Overlap fix details logged for first 10 overlaps)`)
      );
    }
  } else {
    console.log(
      chalk.green("No overlapping timestamps found requiring adjustment.")
    );
  }

  // --- Generate Final SRT String ---
  // Re-sort by original ID for final output sequence
  finalSubtitles.sort((a, b) => a.id - b.id);

  let srtContent = "";
  let finalSrtIndex = 1; // Renumber sequentially
  const fallbackSamples: string[] = [];

  for (const sub of finalSubtitles) {
    // Final sanity check before writing
    if (sub.endTime <= sub.startTime) {
      console.error(
        chalk.red(
          `❌ CRITICAL ERROR: Subtitle ID ${
            sub.id
          } has invalid timing (end <= start: ${sub.startTime.toFixed(
            3
          )}s -> ${sub.endTime.toFixed(3)}s) before writing! Skipping.`
        )
      );
      continue; // Skip writing this invalid subtitle
    }

    // Format the subtitle text with colors
    let subtitleText = "";
    if (sub.english) {
      if (markFallbacks && sub.isFallback) {
        // Mark fallback subtitles with a special prefix and/or color
        // Using a simple prefix marker here
        subtitleText += `<font color="#${englishColor}">[Original] ${sub.english}</font>`;
        markedFallbacksCount++;
        if (fallbackSamples.length < 5)
          fallbackSamples.push(
            `ID ${sub.id}: ${sub.english.substring(0, 40)}...`
          );
      } else {
        subtitleText += `<font color="#${englishColor}">${sub.english}</font>`;
      }
    }

    if (sub.english && sub.korean) {
      subtitleText += "\n"; // Newline between languages
    }

    if (sub.korean) {
      subtitleText += `<font color="#${koreanColor}">${sub.korean}</font>`;
    }

    // Add to SRT content using the final sequential index and adjusted timing
    srtContent += `${finalSrtIndex}\n${sub.timing}\n${subtitleText}\n\n`;
    finalSrtIndex++;
  }

  // Show marker usage summary
  if (markFallbacks) {
    console.log(
      chalk.cyan(
        `Marked ${markedFallbacksCount} subtitles using original English text as fallback.`
      )
    );
    if (fallbackSamples.length > 0) {
      console.log("  Sample fallbacks:");
      fallbackSamples.forEach((sample) => console.log(`    ${sample}`));
    }
  } else {
    console.log("Fallback marking is disabled via -m=false.");
  }

  console.log(
    chalk.green(
      `Generated SRT content for ${finalSrtIndex - 1} final subtitles.`
    )
  );
  return srtContent;
}

/**
 * Parses a generated SRT file for validation purposes.
 * @param filePath Path to the SRT file.
 * @returns Array of parsed SRT entries.
 */
async function parseSrtFile(filePath: string): Promise<ParsedSrtEntry[]> {
  const content = await readFile(filePath, "utf-8");
  const parsedEntries: ParsedSrtEntry[] = [];
  const blocks = content
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== "");

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length >= 3) {
      const idStr = lines[0].trim();
      const timing = lines[1].trim();
      const contentText = lines.slice(2).join("\n");
      const id = parseInt(idStr, 10);

      if (isNaN(id)) continue; // Skip invalid entries

      const timingParts = timing.split(" --> ");
      if (timingParts.length === 2) {
        try {
          const startTime = timeToSeconds(timingParts[0].trim());
          const endTime = timeToSeconds(timingParts[1].trim());
          if (endTime > startTime) {
            // Basic validation
            parsedEntries.push({
              id,
              startTime,
              endTime,
              content: contentText,
            });
          }
        } catch {
          /* Ignore blocks with invalid timing */
        }
      }
    }
  }
  return parsedEntries;
}

/**
 * Validates the generated SRT file against the original.
 * @param outputPath Path to the generated SRT file.
 * @param originalSubtitles Map of original subtitles.
 */
async function validateGeneratedSrt(
  outputPath: string,
  originalSubtitles: Map<number, OriginalSubtitle>
): Promise<void> {
  console.log(chalk.cyan("\nValidating generated SRT file..."));
  let validationIssues = 0;

  try {
    const generatedEntries = await parseSrtFile(outputPath);
    if (generatedEntries.length === 0) {
      console.log(
        chalk.red(
          "❌ Validation Error: Generated SRT file is empty or unparseable."
        )
      );
      return;
    }
    console.log(
      `Parsed ${generatedEntries.length} entries from generated SRT for validation.`
    );

    // 1. Check subtitle count (allow difference due to skipped invalid entries)
    const originalCount = originalSubtitles.size;
    const generatedCount = generatedEntries.length;
    if (originalCount !== generatedCount) {
      console.log(
        chalk.yellow(
          `⚠️ Subtitle count differs - Original: ${originalCount}, Generated: ${generatedCount} (May be due to skipped invalid entries).`
        )
      );
      // Not necessarily an error, but flag it.
    } else {
      console.log(
        chalk.green(`✅ Subtitle count matches original (${originalCount}).`)
      );
    }

    // 2. Check for sequential numbering (should be guaranteed by generation loop)
    let hasNumberingIssues = false;
    for (let i = 0; i < generatedEntries.length; i++) {
      if (generatedEntries[i].id !== i + 1) {
        if (!hasNumberingIssues) {
          console.log(
            chalk.red(
              "❌ Validation Error: Found non-sequential subtitle numbers:"
            )
          );
          hasNumberingIssues = true;
          validationIssues++;
        }
        console.log(
          `   Entry #${i + 1} has ID ${generatedEntries[i].id} (expected ${
            i + 1
          })`
        );
      }
    }
    if (!hasNumberingIssues) {
      console.log(chalk.green("✅ All subtitle numbers are sequential."));
    }

    // 3. Check for overlapping timestamps (should have been fixed)
    let hasOverlaps = false;
    let overlapsCount = 0;
    for (let i = 0; i < generatedEntries.length - 1; i++) {
      const current = generatedEntries[i];
      const next = generatedEntries[i + 1];
      if (current.endTime > next.startTime) {
        // Use strict inequality
        if (!hasOverlaps) {
          console.log(
            chalk.red(
              "❌ Validation Error: Found overlapping timestamps after fix attempt:"
            )
          );
          hasOverlaps = true;
          validationIssues++;
        }
        overlapsCount++;
        if (overlapsCount <= 5) {
          // Show details for first few overlaps
          console.log(
            `   Overlap: #${current.id} (${secondsToTimestamp(
              current.startTime
            )} --> ${secondsToTimestamp(current.endTime)}) ` +
              `overlaps #${next.id} (${secondsToTimestamp(
                next.startTime
              )} --> ${secondsToTimestamp(next.endTime)}) ` +
              `by ${(current.endTime - next.startTime).toFixed(3)}s`
          );
        }
      }
    }
    if (hasOverlaps && overlapsCount > 5) {
      console.log(`   ... and ${overlapsCount - 5} more overlaps.`);
    }
    if (!hasOverlaps) {
      console.log(chalk.green("✅ No overlapping timestamps found."));
    }

    // 4. Check overall duration (optional, less critical)
    // ... (Consider if this check is still valuable)

    // --- Validation Summary ---
    console.log(chalk.cyan("\nValidation Summary:"));
    if (validationIssues === 0) {
      console.log(
        chalk.green(
          "✅ Generated SRT file passed critical validation checks (sequential numbers, no overlaps)."
        )
      );
    } else {
      console.log(
        chalk.red(
          `❌ Generated SRT file failed ${validationIssues} critical validation check(s) (see details above).`
        )
      );
    }
  } catch (error: any) {
    console.error(chalk.red(`❌ Error during validation: ${error.message}`));
  }
}

// --- Main Execution Function ---
async function main() {
  try {
    // Print configuration
    console.log(chalk.cyan("--- Configuration ---"));
    console.log(`- Primary directory: ${primaryDir}`);
    if (backupDir) console.log(`- Backup directory: ${backupDir}`);
    console.log(`- Original SRT: ${originalSrtPath}`);
    console.log(`- Output directory: ${outputDir}`);
    console.log(`- Base output filename: ${baseOutputFilename}`);
    console.log(`- Use response timings: ${useResponseTimings ? "Yes" : "No"}`);
    console.log(`- Mark fallbacks: ${markFallbacks ? "Yes" : "No"}`);
    console.log(`- Verbose logging: ${verboseMode ? "Yes" : "No"}`);
    console.log(
      `- Subtitle colors: English=#${englishColor}, Korean=#${koreanColor}`
    );
    console.log(chalk.cyan("---------------------"));

    // Create output directory if needed
    if (!existsSync(outputDir)) {
      await fsMkdir(outputDir, { recursive: true });
      console.log(`Created output directory: ${outputDir}`);
    }

    // Determine directories to process
    const directories: string[] = [];
    if (existsSync(primaryDir)) directories.push(primaryDir);
    else
      console.log(
        chalk.yellow(`Primary directory ${primaryDir} not found, skipping.`)
      );
    if (backupDir) {
      if (existsSync(backupDir)) directories.push(backupDir);
      else
        console.log(
          chalk.yellow(`Backup directory ${backupDir} not found, skipping.`)
        );
    }
    if (directories.length === 0) {
      console.error(
        chalk.red("❌ Error: No valid response directories found. Exiting.")
      );
      process.exit(1);
    }

    // Parse original SRT
    if (!existsSync(originalSrtPath)) {
      console.error(
        chalk.red(
          `❌ Error: Original SRT file not found: ${originalSrtPath}. Exiting.`
        )
      );
      process.exit(1);
    }
    const originalSubtitles = await parseOriginalSrt(originalSrtPath);
    if (originalSubtitles.size === 0) {
      console.error(
        chalk.red(
          `❌ Error: No valid subtitles parsed from original SRT: ${originalSrtPath}. Exiting.`
        )
      );
      process.exit(1);
    }

    // Process response files using the parser module
    const translations = await processResponseFiles(
      directories,
      useResponseTimings // Pass flag to indicate *intent*
    );
    if (translations.size === 0 && originalSubtitles.size > 0) {
      console.warn(
        chalk.yellow(
          "⚠️ Warning: No translations were successfully parsed from any response files. Output will only contain original text."
        )
      );
    }

    // Check for missing translations (compared to original)
    const missingTranslationIds: number[] = [];
    for (const id of originalSubtitles.keys()) {
      if (!translations.has(id.toString())) {
        missingTranslationIds.push(id);
      }
    }
    if (missingTranslationIds.length > 0) {
      console.log(
        chalk.yellow(
          `Note: Missing translations for ${missingTranslationIds.length} subtitle IDs (will use original text).`
        )
      );
      if (verboseMode && missingTranslationIds.length <= 20) {
        console.log(`  Missing IDs: ${missingTranslationIds.join(", ")}`);
      } else if (verboseMode) {
        console.log(
          `  First 20 missing IDs: ${missingTranslationIds
            .slice(0, 20)
            .join(", ")}...`
        );
      }
    }

    // --- Filename Generation ---
    let outputFilename = baseOutputFilename;
    const filenameParts = outputFilename.split(".");
    const base =
      filenameParts.length > 1
        ? filenameParts.slice(0, -1).join(".")
        : outputFilename;
    const ext = filenameParts.length > 1 ? `.${filenameParts.pop()}` : ".srt"; // Default to .srt

    let filenameSuffix = "";
    // Add timing source indicator
    if (useResponseTimings) filenameSuffix += "_respTime";
    // Add directory identifiers if using non-default directories
    const primaryDirName = parsePath(primaryDir).name;
    if (primaryDir !== DEFAULT_PRIMARY_DIR)
      filenameSuffix += `_${primaryDirName}`;
    if (backupDir && backupDir !== DEFAULT_BACKUP_DIR) {
      const backupDirName = parsePath(backupDir).name;
      filenameSuffix += `_${backupDirName}`;
    }

    outputFilename = `${base}${filenameSuffix}${ext}`;
    const outputPath = join(outputDir, outputFilename);
    console.log(chalk.cyan(`\nOutput filename set to: ${outputFilename}`));

    // --- Generate Final SRT ---
    const srtContent = await generateFinalSrt(
      originalSubtitles,
      translations,
      useResponseTimings // Pass the user's preference flag
    );

    // --- Write Output File ---
    await writeFile(outputPath, srtContent);
    console.log(
      chalk.green(`\n✅ Successfully generated bilingual SRT: ${outputPath}`)
    );
    console.log(`  - Original subtitles count: ${originalSubtitles.size}`);
    console.log(`  - Translations merged: ${translations.size}`);
    console.log(`  - Subtitles using fallback text: ${fallbackCount}`); // Need to get fallbackCount from generateFinalSrt or recalculate

    // --- Validate Output ---
    await validateGeneratedSrt(outputPath, originalSubtitles);

    console.log(chalk.magentaBright("\n--- Script Finished ---"));
  } catch (error) {
    console.error(
      chalk.red("\n❌ An unexpected error occurred in main execution:"),
      error
    );
    process.exit(1); // Exit with error code
  }
}

// --- Run Main Script ---
main();
