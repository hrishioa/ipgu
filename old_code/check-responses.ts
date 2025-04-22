#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir as fsMkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";

const PRIMARY_RESPONSES_DIR = "./videos/responses";
const DIAGNOSTIC_DIR = "./videos/diagnostics";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let backupDir: string | null = null;

  // Check if backup directory is specified
  const backupArg = args.find((arg) => arg.startsWith("--backup="));
  if (backupArg) {
    backupDir = backupArg.split("=")[1];
  }

  return { backupDir };
}

// Interface for subtitle entries
interface SubtitleEntry {
  number: string;
  line: string;
  timing: string;
  english: string;
  korean: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  sourceLineNumber?: number; // Line number in source file (for debugging)
  source?: string; // Which directory this entry came from
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

// More robust parsing using direct string search and manual extraction
async function parseResponseFile(
  filePath: string,
  partNumber: number,
  source: string
): Promise<SubtitleEntry[]> {
  const content = await readFile(filePath, "utf-8");
  const entries: SubtitleEntry[] = [];

  // Write diagnostic output for part 6
  if (partNumber === 6 && source === PRIMARY_RESPONSES_DIR) {
    try {
      if (!existsSync(DIAGNOSTIC_DIR)) {
        await fsMkdir(DIAGNOSTIC_DIR, { recursive: true });
      }
      await writeFile(join(DIAGNOSTIC_DIR, "part6_content.txt"), content);
      console.log(
        chalk.blue(`Saved part 6 content to diagnostic file for inspection`)
      );
    } catch (error) {
      console.error(`Error saving diagnostic file: ${error}`);
    }
  }

  // Split the file into lines for line number tracking
  const lines = content.split("\n");

  // Check if the content is wrapped in a markdown code block
  let processableContent = content;
  const markdownBlockMatch = content.match(/```(?:xml)?\s*\n([\s\S]*?)```/);
  if (markdownBlockMatch && markdownBlockMatch[1]) {
    processableContent = markdownBlockMatch[1];
  }

  // Find all <subline> blocks directly
  const sublineRegex = /<subline>([\s\S]*?)<\/subline>/g;
  let match;

  // Use a global regex to find all <subline> blocks in the whole file
  while ((match = sublineRegex.exec(processableContent)) !== null) {
    const sublineContent = match[1];
    const matchPosition = match.index;

    // Calculate line number (approximate) for debugging
    const contentBeforeMatch = processableContent.substring(0, matchPosition);
    const lineNumber = contentBeforeMatch.split("\n").length;

    // Define helper function to extract tag content
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

    // Extract all the components
    const number = extractTagContent(sublineContent, "original_number");
    const line = extractTagContent(sublineContent, "original_line");
    const timing = extractTagContent(sublineContent, "original_timing");
    const english = extractTagContent(
      sublineContent,
      "better_english_translation"
    );
    const korean = extractTagContent(sublineContent, "korean_translation");

    if (number && timing) {
      // Parse the timing to get start and end times
      const timingParts = timing.split(" --> ");
      if (timingParts.length === 2) {
        const startTime = timeToSeconds(timingParts[0]);
        const endTime = timeToSeconds(timingParts[1]);

        entries.push({
          number,
          line: line || "",
          timing,
          english: english || "",
          korean: korean || "",
          startTime,
          endTime,
          sourceLineNumber: lineNumber,
          source,
        });
      }
    }
  }

  // Special debugging for part 6
  if (partNumber === 6 && source === PRIMARY_RESPONSES_DIR) {
    // Check for specific entries that should be present
    const hasEntry1824 = entries.some((entry) => entry.number === "1824");
    const hasEntry1825 = entries.some((entry) => entry.number === "1825");

    console.log(chalk.blue(`Part 6 debugging information:`));
    console.log(`  - Total entries found: ${entries.length}`);
    console.log(`  - Entry #1824 present: ${hasEntry1824 ? "Yes" : "No"}`);
    console.log(`  - Entry #1825 present: ${hasEntry1825 ? "Yes" : "No"}`);

    // Show the first few and last few entries
    if (entries.length > 0) {
      console.log(chalk.blue(`First 5 entries of part 6:`));
      const firstEntries = entries.slice(0, 5);
      for (const entry of firstEntries) {
        console.log(
          `  #${entry.number}: "${entry.english.substring(0, 50)}${
            entry.english.length > 50 ? "..." : ""
          }" (line: ~${entry.sourceLineNumber})`
        );
      }

      console.log(chalk.blue(`Last 5 entries of part 6:`));
      const lastEntries = entries.slice(-5);
      for (const entry of lastEntries) {
        console.log(
          `  #${entry.number}: "${entry.english.substring(0, 50)}${
            entry.english.length > 50 ? "..." : ""
          }" (line: ~${entry.sourceLineNumber})`
        );
      }
    }
  }

  // Sort the entries by number (numeric sort)
  return entries.sort((a, b) => parseInt(a.number) - parseInt(b.number));
}

// Check for missing subtitle numbers in a sequence
function checkMissingNumbers(entries: SubtitleEntry[]): number[] {
  if (entries.length === 0) return [];

  const numbers = entries.map((entry) => parseInt(entry.number));
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);

  const missingNumbers: number[] = [];
  for (let i = min; i <= max; i++) {
    if (!numbers.includes(i)) {
      missingNumbers.push(i);
    }
  }

  return missingNumbers;
}

// Checks for overlap between two sets of subtitle entries
function checkOverlap(
  part1: SubtitleEntry[],
  part2: SubtitleEntry[]
): {
  hasOverlap: boolean;
  overlapCount: number;
  overlapEntries: Array<{ part1: SubtitleEntry; part2: SubtitleEntry }>;
} {
  const overlapEntries: Array<{ part1: SubtitleEntry; part2: SubtitleEntry }> =
    [];

  // Find entries that have the same original number
  for (const entry1 of part1) {
    for (const entry2 of part2) {
      if (entry1.number === entry2.number) {
        overlapEntries.push({ part1: entry1, part2: entry2 });
      }
    }
  }

  // Also check for time-based overlaps if no numbered matches
  if (overlapEntries.length === 0) {
    const lastEntryPart1 = part1[part1.length - 1];
    const firstEntryPart2 = part2[0];

    // Check if the last entry of part1 overlaps with the first entry of part2
    if (lastEntryPart1 && firstEntryPart2) {
      // Consider overlap if the last entry in part1 ends after the first entry in part2 starts
      if (lastEntryPart1.endTime >= firstEntryPart2.startTime) {
        overlapEntries.push({ part1: lastEntryPart1, part2: firstEntryPart2 });
      }
    }
  }

  return {
    hasOverlap: overlapEntries.length > 0,
    overlapCount: overlapEntries.length,
    overlapEntries,
  };
}

async function main() {
  try {
    // Parse command line arguments
    const { backupDir } = parseArgs();

    // Array of directories to check
    const directories = [PRIMARY_RESPONSES_DIR];
    if (backupDir) {
      directories.push(backupDir);
      console.log(chalk.cyan(`Using backup directory: ${backupDir}`));
    }

    // Check if the primary responses directory exists
    if (!existsSync(PRIMARY_RESPONSES_DIR)) {
      console.error(
        chalk.red(
          `❌ Error: Primary responses directory ${PRIMARY_RESPONSES_DIR} does not exist`
        )
      );
      process.exit(1);
    }

    // Check if the backup directory exists if specified
    if (backupDir && !existsSync(backupDir)) {
      console.error(
        chalk.red(`❌ Error: Backup directory ${backupDir} does not exist`)
      );
      process.exit(1);
    }

    // Track all subtitle entries from all sources
    const allEntriesByPart: Map<number, SubtitleEntry[]> = new Map();
    const allSubtitleNumbers: number[] = [];

    // Process each directory
    for (const directory of directories) {
      console.log(chalk.cyan(`\nProcessing directory: ${directory}`));

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
        console.log(chalk.yellow(`⚠️ No response files found in ${directory}`));
        continue;
      }

      console.log(
        chalk.cyan(
          `Found ${responseFiles.length} response files in ${directory}`
        )
      );

      // Parse all response files
      for (const file of responseFiles) {
        const partMatch = file.match(/part(\d+)/);
        if (!partMatch) continue;

        const partNumber = parseInt(partMatch[1], 10);
        const filePath = join(directory, file);

        console.log(chalk.yellow(`Parsing ${file} from ${directory}...`));
        const entries = await parseResponseFile(
          filePath,
          partNumber,
          directory
        );

        console.log(`  - Found ${entries.length} subtitle entries`);
        if (entries.length > 0) {
          console.log(
            `  - First entry: #${entries[0].number} (${entries[0].timing})`
          );
          console.log(
            `  - Last entry: #${entries[entries.length - 1].number} (${
              entries[entries.length - 1].timing
            })`
          );

          // Check for missing numbers in this part
          const missingNumbers = checkMissingNumbers(entries);
          if (missingNumbers.length > 0) {
            console.log(
              chalk.yellow(
                `  - Missing ${missingNumbers.length} subtitle numbers in this part`
              )
            );
            if (missingNumbers.length <= 10) {
              console.log(`    Missing numbers: ${missingNumbers.join(", ")}`);
            } else {
              console.log(
                `    First 10 missing numbers: ${missingNumbers
                  .slice(0, 10)
                  .join(", ")}...`
              );
            }
          }

          // Merge with existing entries if we have them from a different source
          const existingEntries = allEntriesByPart.get(partNumber) || [];
          const mergedEntries = mergeEntries(existingEntries, entries);
          allEntriesByPart.set(partNumber, mergedEntries);

          // Track all subtitle numbers after merging
          mergedEntries.forEach((entry) => {
            const num = parseInt(entry.number);
            if (!allSubtitleNumbers.includes(num)) {
              allSubtitleNumbers.push(num);
            }
          });
        }
      }
    }

    // Now check for missing numbers across all parts and all sources
    if (allSubtitleNumbers.length > 0) {
      allSubtitleNumbers.sort((a, b) => a - b);
      const min = Math.min(...allSubtitleNumbers);
      const max = Math.max(...allSubtitleNumbers);

      const missingGlobally: number[] = [];
      for (let i = min; i <= max; i++) {
        if (!allSubtitleNumbers.includes(i)) {
          missingGlobally.push(i);
        }
      }

      console.log(
        chalk.cyan(
          "\nChecking for missing subtitle numbers across all parts and sources:"
        )
      );
      if (missingGlobally.length === 0) {
        console.log(
          chalk.green(
            "✅ No missing subtitle numbers found! Complete sequence from",
            min,
            "to",
            max
          )
        );
      } else {
        console.log(
          chalk.yellow(
            `⚠️ Found ${missingGlobally.length} missing subtitle numbers across all parts and sources`
          )
        );
        if (missingGlobally.length <= 20) {
          console.log(`  Missing numbers: ${missingGlobally.join(", ")}`);
        } else {
          console.log(
            `  First 20 missing numbers: ${missingGlobally
              .slice(0, 20)
              .join(", ")}...`
          );
        }
      }
    }

    // Check for overlaps between consecutive parts
    console.log(
      chalk.cyan("\nChecking for overlaps between parts (using merged data):")
    );
    let hasGaps = false;

    // Convert map to sorted array
    const allParts = Array.from(allEntriesByPart.keys()).sort((a, b) => a - b);

    for (let i = 1; i < allParts.length; i++) {
      const currentPartNum = allParts[i];
      const previousPartNum = allParts[i - 1];

      const currentEntries = allEntriesByPart.get(currentPartNum) || [];
      const previousEntries = allEntriesByPart.get(previousPartNum) || [];

      const { hasOverlap, overlapCount, overlapEntries } = checkOverlap(
        previousEntries,
        currentEntries
      );

      if (hasOverlap) {
        console.log(
          chalk.green(
            `✅ Parts ${previousPartNum} and ${currentPartNum} have ${overlapCount} overlapping entries`
          )
        );
        if (overlapCount > 0) {
          console.log("  Example overlap:");
          const example = overlapEntries[0];
          console.log(
            `  Part ${previousPartNum}: #${
              example.part1.number
            } - "${example.part1.english.substring(0, 50)}${
              example.part1.english.length > 50 ? "..." : ""
            }" (from ${example.part1.source})`
          );
          console.log(
            `  Part ${currentPartNum}: #${
              example.part2.number
            } - "${example.part2.english.substring(0, 50)}${
              example.part2.english.length > 50 ? "..." : ""
            }" (from ${example.part2.source})`
          );
        }
      } else {
        console.log(
          chalk.red(
            `❌ No overlap found between parts ${previousPartNum} and ${currentPartNum}!`
          )
        );
        hasGaps = true;

        // Show the last entry of the previous part and the first entry of the current part
        if (previousEntries.length > 0 && currentEntries.length > 0) {
          const lastPrevious = previousEntries[previousEntries.length - 1];
          const firstCurrent = currentEntries[0];

          // Calculate the missing range of subtitle numbers
          const lastPreviousNum = parseInt(lastPrevious.number);
          const firstCurrentNum = parseInt(firstCurrent.number);
          const missingRange = `#${lastPreviousNum + 1} to #${
            firstCurrentNum - 1
          }`;

          console.log(chalk.yellow("  Gap details:"));
          console.log(
            `  Last entry in part ${previousPartNum}: #${
              lastPrevious.number
            } - "${lastPrevious.english.substring(0, 50)}${
              lastPrevious.english.length > 50 ? "..." : ""
            }" (from ${lastPrevious.source})`
          );
          console.log(`  Time: ${lastPrevious.timing}`);
          console.log(
            `  First entry in part ${currentPartNum}: #${
              firstCurrent.number
            } - "${firstCurrent.english.substring(0, 50)}${
              firstCurrent.english.length > 50 ? "..." : ""
            }" (from ${firstCurrent.source})`
          );
          console.log(`  Time: ${firstCurrent.timing}`);

          // Calculate the time gap
          const timeGap = firstCurrent.startTime - lastPrevious.endTime;
          console.log(`  Time gap: ${timeGap.toFixed(2)} seconds`);
          console.log(
            `  Missing subtitle numbers: ${missingRange} (${
              firstCurrentNum - lastPreviousNum - 1
            } numbers)`
          );
        }
      }
    }

    // Summary
    if (hasGaps) {
      console.log(
        chalk.yellow(
          "\n⚠️ Warning: Some parts do not have overlaps. Check the details above."
        )
      );
    } else {
      console.log(chalk.green("\n✅ All parts have proper overlaps!"));
    }
  } catch (error) {
    console.error(chalk.red("❌ Error:"), error);
  }
}

// Helper function to merge entries from different sources
function mergeEntries(
  existingEntries: SubtitleEntry[],
  newEntries: SubtitleEntry[]
): SubtitleEntry[] {
  const mergedMap = new Map<string, SubtitleEntry>();

  // First add all existing entries to the map
  for (const entry of existingEntries) {
    mergedMap.set(entry.number, entry);
  }

  // Then add new entries, overriding only if they don't already exist
  for (const entry of newEntries) {
    if (!mergedMap.has(entry.number)) {
      mergedMap.set(entry.number, entry);
    }
  }

  // Convert back to array and sort
  return Array.from(mergedMap.values()).sort(
    (a, b) => parseInt(a.number) - parseInt(b.number)
  );
}

main();
