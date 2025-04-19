#!/usr/bin/env bun

import { readdir, readFile, writeFile, mkdir as fsMkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import { parseArgs } from "util";

// Default paths (can be overridden via command line)
const DEFAULT_PRIMARY_DIR = "./videos/responses";
const DEFAULT_BACKUP_DIR = "./videos/responses2";
const DEFAULT_ORIGINAL_SRT = "./Downloaded-Sandhesam.eng.srt";
const DEFAULT_OUTPUT_DIR = "./videos/final_subtitles";
const DEFAULT_OUTPUT_SRT = "Sandesham_bilingual.srt";

// Color settings for subtitles
const ENGLISH_COLOR = "FFFFFF"; // White
const KOREAN_COLOR = "FFC0CB"; // Light pink

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    primary: {
      type: "string",
      short: "p",
      default: DEFAULT_PRIMARY_DIR,
    },
    backup: {
      type: "string",
      short: "b",
    },
    original: {
      type: "string",
      short: "o",
      default: DEFAULT_ORIGINAL_SRT,
    },
    output: {
      type: "string",
      short: "O",
      default: DEFAULT_OUTPUT_DIR,
    },
    filename: {
      type: "string",
      short: "f",
      default: DEFAULT_OUTPUT_SRT,
    },
    responsetimings: {
      type: "boolean",
      short: "r",
      default: false,
    },
    colors: {
      type: "string",
      short: "c",
    },
    verbose: {
      type: "boolean",
      short: "v",
      default: false,
    },
    markfallbacks: {
      type: "boolean",
      short: "m",
      default: true,
    },
    debugfile: {
      type: "string",
      short: "d",
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
Usage: bun generate-subtitles.ts [options]

Options:
  -p, --primary <directory>    Primary responses directory (default: "${DEFAULT_PRIMARY_DIR}")
  -b, --backup <directory>     Backup responses directory (uses "${DEFAULT_BACKUP_DIR}" if exists and not specified)
  -o, --original <file>        Original SRT file (default: "${DEFAULT_ORIGINAL_SRT}")
  -O, --output <directory>     Output directory (default: "${DEFAULT_OUTPUT_DIR}")
  -f, --filename <filename>    Base output filename (default: "${DEFAULT_OUTPUT_SRT}")
  -r, --responsetimings        Use timings from response files instead of original SRT
  -c, --colors <colors>        Subtitle colors as "english,korean" (default: "${ENGLISH_COLOR},${KOREAN_COLOR}")
  -v, --verbose                Show detailed parsing information
  -m, --markfallbacks          Mark subtitles where original line is used as fallback (default: true)
  -d, --debugfile <filename>   Output parsing debug info to this file
  -h, --help                   Show this help message

Examples:
  bun generate-subtitles.ts
  bun generate-subtitles.ts -p ./responses_v1 -b ./responses_v2
  bun generate-subtitles.ts -r -c "FFFFFF,FFC0CB"
  bun generate-subtitles.ts -f my_movie.srt -O ./output
  `);
  process.exit(0);
}

// Get values from parsed arguments
const primaryDir = values.primary as string;
const originalSrtPath = values.original as string;
const outputDir = values.output as string;
const baseOutputFilename = values.filename as string;
const useResponseTimings = values.responsetimings as boolean;
const verboseMode = values.verbose as boolean;
const markFallbacks = values.markfallbacks as boolean;
const debugFile = values.debugfile as string | undefined;

// Handle backup directory
let backupDir: string | null = null;
if (values.backup) {
  backupDir = values.backup as string;
} else if (existsSync(DEFAULT_BACKUP_DIR)) {
  // Use default backup if available and not explicitly overridden
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

// Color settings for fallback indicator
const FALLBACK_COLOR = "FF0000"; // Red for fallback indicator

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

// Fixed type version for the extracted data
interface ExtractedSubtitleData {
  number: string;
  english: string;
  korean: string;
  timing?: string;
  startTime?: number;
  endTime?: number;
}

// Interface for the final subtitle entry
interface FinalSubtitle {
  id: number;
  timing: string;
  english: string;
  korean: string;
  startTime: number;
  endTime: number;
  isFallback?: boolean;
}

// Interface for parsed SRT entry (used in validation)
interface ParsedSrtEntry {
  id: number;
  startTime: number;
  endTime: number;
  content: string;
}

// Store information about parsing failures
interface ParsingFailure {
  id: number;
  files: {
    filename: string;
    partNumber: number;
    foundSublineTag: boolean;
    sampleContent?: string;
  }[];
}

const parsingFailures: Map<number, ParsingFailure> = new Map();

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

  if (verboseMode) {
    console.log(chalk.cyan(`Detailed parsing of ${filePath}:`));
  }

  // APPROACH 1: Find all individual markdown code blocks (multiple blocks per file)
  // This handles cases with multiple consecutive ```xml blocks
  const markdownBlocksResults = extractFromMarkdownBlocks(
    content,
    extractTimings
  );

  if (markdownBlocksResults.length > 0) {
    if (verboseMode) {
      console.log(
        `Found ${markdownBlocksResults.length} subtitle entries from markdown blocks`
      );
    }

    for (const result of markdownBlocksResults) {
      translations.push({
        ...result,
        source: filePath,
        partNumber,
      });
    }
  } else {
    // APPROACH 2: Find all variants of subtitle tags directly in content
    const allSublineTags = getAllSublineTags(content);

    if (allSublineTags.length > 0) {
      if (verboseMode) {
        console.log(
          `Found ${allSublineTags.length} subtitle entries using direct tag extraction`
        );
      }

      for (const tagContent of allSublineTags) {
        const extractedData = extractSubtitleData(tagContent, extractTimings);

        if (extractedData && extractedData.number) {
          translations.push({
            ...extractedData,
            source: filePath,
            partNumber,
          });
        }
      }
    } else if (translations.length === 0) {
      // APPROACH 3: Last resort regex pattern matching
      if (verboseMode) {
        console.log(`No direct tags found, trying regex patterns...`);
      }

      const originalResults = extractWithRegexPatterns(content, extractTimings);

      if (originalResults.length > 0) {
        if (verboseMode) {
          console.log(
            `Found ${originalResults.length} translations using regex patterns`
          );
        }

        for (const result of originalResults) {
          translations.push({
            ...result,
            source: filePath,
            partNumber,
          });
        }
      }
    }
  }

  // Add debug information for suspiciously empty files
  if (translations.length < 10 && partNumber > 1) {
    console.log(
      chalk.yellow(
        `⚠️ WARNING: Found only ${translations.length} translations in part ${partNumber}.`
      )
    );

    if (verboseMode) {
      // Count potential translation blocks in the file
      const potentialMatches = (content.match(/<(subline|subtitle)>/g) || [])
        .length;
      console.log(
        `Found ${potentialMatches} potential <subline> or <subtitle> tags in the file`
      );

      // Count markdown blocks
      const markdownBlocks = (content.match(/```(?:xml)?\s*\n/g) || []).length;
      console.log(`Found ${markdownBlocks} markdown code blocks in the file`);

      // Show content preview
      console.log("File preview (first 500 chars):");
      console.log("----------------------------------------");
      console.log(content.substring(0, 500));
      console.log("----------------------------------------");
    }
  } else {
    if (verboseMode) {
      console.log(
        `Successfully parsed ${translations.length} translations from part ${partNumber}`
      );
    }
  }

  return translations;
}

// Extract subtitles from markdown code blocks
function extractFromMarkdownBlocks(
  content: string,
  extractTimings: boolean
): ExtractedSubtitleData[] {
  const results: ExtractedSubtitleData[] = [];

  // Improved regex to handle consecutive markdown blocks better
  // This looks for ```xml ... ``` blocks with or without whitespace between them
  const markdownBlockRegex = /```(?:xml)?\s*\n([\s\S]*?)```/g;
  let markdownMatch;
  let markdownBlockCount = 0;

  while ((markdownMatch = markdownBlockRegex.exec(content)) !== null) {
    markdownBlockCount++;
    const blockContent = markdownMatch[1].trim();

    // Check if this block contains a subline/subtitle tag
    if (
      blockContent.includes("<subline>") ||
      blockContent.includes("<subtitle>")
    ) {
      // Extract tags from this block
      const tags = getAllSublineTags(blockContent);

      if (verboseMode && tags.length > 1) {
        console.log(
          `Found ${tags.length} subtitle tags in a single markdown block`
        );
      }

      for (const tagContent of tags) {
        const extractedData = extractSubtitleData(tagContent, extractTimings);

        if (extractedData && extractedData.number) {
          results.push(extractedData);
        }
      }
    }
    // If the block itself IS the content of a subline (without the surrounding tags)
    else {
      // Try to find subtitle data directly in the block
      // This handles cases where the markdown block contains tag content without the <subline> wrapper

      // First try to find multiple subtitle entries by looking for multiple number tags
      const numberTags = findAllNumberTags(blockContent);

      if (numberTags.length > 1 && verboseMode) {
        console.log(
          `Found ${numberTags.length} potential subtitle entries in a block without subline tags`
        );
      }

      if (numberTags.length > 0) {
        // We have multiple entries in one block without proper subline tags
        for (const { number, startPos, endPos } of numberTags) {
          // Extract a section around this number tag to find its related content
          // Look from this tag until the next one or end of content
          const nextStartPos =
            numberTags.find((t) => t.startPos > startPos)?.startPos ||
            blockContent.length;
          const sectionContent = blockContent.substring(startPos, nextStartPos);

          const english =
            extractNestedTagContent(
              sectionContent,
              "better_english_translation"
            ) ||
            extractNestedTagContent(sectionContent, "english_translation") ||
            extractNestedTagContent(sectionContent, "english");

          const korean =
            extractNestedTagContent(sectionContent, "korean_translation") ||
            extractNestedTagContent(sectionContent, "korean");

          if (number && (english || korean)) {
            const result: ExtractedSubtitleData = {
              number,
              english: english || "",
              korean: korean || "",
            };

            if (extractTimings) {
              const timing =
                extractNestedTagContent(sectionContent, "original_timing") ||
                extractNestedTagContent(sectionContent, "timing");

              if (timing) {
                result.timing = timing;
                const timingParts = timing.split(" --> ");
                if (timingParts.length === 2) {
                  result.startTime = timeToSeconds(timingParts[0]);
                  result.endTime = timeToSeconds(timingParts[1]);
                }
              }
            }

            results.push(result);
          }
        }
      } else {
        // Fall back to old approach for single entries
        const number =
          extractNestedTagContent(blockContent, "original_number") ||
          extractNestedTagContent(blockContent, "number") ||
          extractNestedTagContent(blockContent, "id");

        const english =
          extractNestedTagContent(blockContent, "better_english_translation") ||
          extractNestedTagContent(blockContent, "english_translation") ||
          extractNestedTagContent(blockContent, "english");

        const korean =
          extractNestedTagContent(blockContent, "korean_translation") ||
          extractNestedTagContent(blockContent, "korean");

        if (number && (english || korean)) {
          const result: ExtractedSubtitleData = {
            number,
            english: english || "",
            korean: korean || "",
          };

          if (extractTimings) {
            const timing =
              extractNestedTagContent(blockContent, "original_timing") ||
              extractNestedTagContent(blockContent, "timing");

            if (timing) {
              result.timing = timing;
              const timingParts = timing.split(" --> ");
              if (timingParts.length === 2) {
                result.startTime = timeToSeconds(timingParts[0]);
                result.endTime = timeToSeconds(timingParts[1]);
              }
            }
          }

          results.push(result);
        }
      }
    }
  }

  if (verboseMode && markdownBlockCount > 0) {
    console.log(
      `Processed ${markdownBlockCount} markdown blocks, found ${results.length} valid subtitles`
    );
  }

  return results;
}

// Helper function to find all number/id tags in a block
function findAllNumberTags(
  content: string
): { number: string; startPos: number; endPos: number }[] {
  const results: { number: string; startPos: number; endPos: number }[] = [];

  // Find all possible number tag variants
  const patterns = [
    /<original_number>(.*?)<\/original_number>/g,
    /<number>(.*?)<\/number>/g,
    /<id>(.*?)<\/id>/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const number = match[1].trim();
      if (number && !isNaN(parseInt(number, 10))) {
        results.push({
          number,
          startPos: match.index,
          endPos: match.index + match[0].length,
        });
      }
    }
  }

  // Sort by position in the document
  return results.sort((a, b) => a.startPos - b.startPos);
}

// Helper function to extract all subline/subtitle tags from content
function getAllSublineTags(content: string): string[] {
  const results: string[] = [];

  // Try different tag variants
  const patterns = [
    /<subline>([\s\S]*?)<\/subline>/g,
    /<subtitle>([\s\S]*?)<\/subtitle>/g,
    /<subl[^>]*>([\s\S]*?)<\/subl[^>]*>/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      results.push(match[1]);
    }
  }

  return results;
}

// Helper function to extract subtitle data from tag content
function extractSubtitleData(
  tagContent: string,
  extractTimings: boolean
): ExtractedSubtitleData | null {
  // Extract the components
  const number =
    extractNestedTagContent(tagContent, "original_number") ||
    extractNestedTagContent(tagContent, "number") ||
    extractNestedTagContent(tagContent, "id");

  const english =
    extractNestedTagContent(tagContent, "better_english_translation") ||
    extractNestedTagContent(tagContent, "english_translation") ||
    extractNestedTagContent(tagContent, "english");

  const korean =
    extractNestedTagContent(tagContent, "korean_translation") ||
    extractNestedTagContent(tagContent, "korean");

  // Skip if we don't have the bare minimum data
  if (!number || (!english && !korean)) {
    return null;
  }

  const result: ExtractedSubtitleData = {
    number,
    english: english || "",
    korean: korean || "",
  };

  // Add timing if requested and available
  if (extractTimings) {
    const timingValue =
      extractNestedTagContent(tagContent, "original_timing") ||
      extractNestedTagContent(tagContent, "timing");

    if (timingValue) {
      result.timing = timingValue;
      const timingParts = timingValue.split(" --> ");
      if (timingParts.length === 2) {
        result.startTime = timeToSeconds(timingParts[0]);
        result.endTime = timeToSeconds(timingParts[1]);
      }
    }
  }

  return result;
}

// Extract content from nested tags with multiple possible tag names
function extractNestedTagContent(
  content: string,
  tagNames: string | string[]
): string | null {
  if (!Array.isArray(tagNames)) {
    tagNames = [tagNames];
  }

  for (const tagName of tagNames) {
    const startTag = `<${tagName}>`;
    const endTag = `</${tagName}>`;
    const startIndex = content.indexOf(startTag);

    if (startIndex === -1) continue;

    const valueStartIndex = startIndex + startTag.length;
    const endIndex = content.indexOf(endTag, valueStartIndex);

    if (endIndex === -1) continue;

    return content.substring(valueStartIndex, endIndex).trim();
  }

  return null;
}

// Extract with multiple regex patterns as a last resort
function extractWithRegexPatterns(
  content: string,
  extractTimings: boolean
): ExtractedSubtitleData[] {
  const results: ExtractedSubtitleData[] = [];

  // Look for patterns like: <original_number>123</original_number> anywhere in the file
  const numberMatches =
    content.match(
      /<(?:original_number|number|id)>(\d+)<\/(?:original_number|number|id)>/g
    ) || [];

  // For each number, try to extract associated translations
  for (const numberMatch of numberMatches) {
    const numberRegex =
      /<(?:original_number|number|id)>(\d+)<\/(?:original_number|number|id)>/;
    const numberExtract = numberMatch.match(numberRegex);

    if (!numberExtract || !numberExtract[1]) continue;

    const number = numberExtract[1];
    const surroundingText = extractSurroundingText(content, numberMatch, 500);

    // Extract english and korean translations from surrounding text
    const english = extractFromSurrounding(surroundingText, [
      "better_english_translation",
      "english_translation",
      "english",
    ]);

    const korean = extractFromSurrounding(surroundingText, [
      "korean_translation",
      "korean",
    ]);

    if (!english && !korean) continue;

    const result: ExtractedSubtitleData = {
      number,
      english: english || "",
      korean: korean || "",
    };

    // Add timing if requested
    if (extractTimings) {
      const timing = extractFromSurrounding(surroundingText, [
        "original_timing",
        "timing",
      ]);

      if (timing) {
        result.timing = timing;
        const timingParts = timing.split(" --> ");
        if (timingParts.length === 2) {
          result.startTime = timeToSeconds(timingParts[0]);
          result.endTime = timeToSeconds(timingParts[1]);
        }
      }
    }

    results.push(result);
  }

  return results;
}

// Helper to extract text surrounding a match
function extractSurroundingText(
  content: string,
  match: string,
  radius: number
): string {
  const matchIndex = content.indexOf(match);
  if (matchIndex === -1) return "";

  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(content.length, matchIndex + match.length + radius);

  return content.substring(start, end);
}

// Helper to extract tag content from surrounding text
function extractFromSurrounding(
  text: string,
  tagNames: string[]
): string | null {
  for (const tagName of tagNames) {
    const regex = new RegExp(`<${tagName}>(.*?)<\/${tagName}>`, "s");
    const match = text.match(regex);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

// Process all response files and merge translations
async function processResponseFiles(
  directories: string[],
  extractTimings: boolean,
  originalSubtitleIds: number[]
): Promise<Map<string, TranslatedSubtitle>> {
  const allTranslations = new Map<string, TranslatedSubtitle>();
  const checkedSubtitleIds = new Set<number>();
  const directoryScores: Map<string, { total: number; found: number }> =
    new Map();

  for (const directory of directories) {
    if (!existsSync(directory)) {
      console.log(
        chalk.yellow(`Directory ${directory} does not exist, skipping`)
      );
      continue;
    }

    console.log(chalk.cyan(`Processing response files from: ${directory}`));
    directoryScores.set(directory, { total: 0, found: 0 });

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
      const { translations, parsedIds } = await parseResponseFileWithTracking(
        filePath,
        partNumber,
        extractTimings,
        originalSubtitleIds
      );

      // Track which IDs were found and which weren't
      const dirScore = directoryScores.get(directory)!;
      const relevantIds = originalSubtitleIds.filter((id) => {
        // Determine if this file should contain this ID based on part ranges
        // This is a simplified check - you might need more sophisticated logic
        const idNum = parseInt(String(id), 10);
        const fileStartIndex = (partNumber - 1) * 300; // Assuming each part has roughly 300 subtitles
        const fileEndIndex = fileStartIndex + 400; // Add overlap
        return idNum >= fileStartIndex && idNum <= fileEndIndex;
      });

      dirScore.total += relevantIds.length;
      dirScore.found += parsedIds.size;

      console.log(`Found ${translations.length} translations in ${file}`);

      // Record which IDs weren't found in this file that should have been
      for (const id of relevantIds) {
        checkedSubtitleIds.add(id);
        if (!parsedIds.has(id)) {
          // This ID should be in this file but wasn't found
          const failure = parsingFailures.get(id) || {
            id,
            files: [],
          };

          // Check if the file contains a subline tag for this ID
          const fileContent = await readFile(filePath, "utf-8");
          const searchPattern = new RegExp(
            `<(?:subline|subtitle)>[\\s\\S]*?<(?:original_number|number|id)>${id}<\/(?:original_number|number|id)>[\\s\\S]*?<\/(?:subline|subtitle)>`,
            "i"
          );

          const foundSublineTag = searchPattern.test(fileContent);
          const failureInfo: {
            filename: string;
            partNumber: number;
            foundSublineTag: boolean;
            sampleContent?: string;
          } = {
            filename: file,
            partNumber,
            foundSublineTag,
          };

          // If we found a tag but couldn't parse it, extract a sample
          if (foundSublineTag) {
            const match = fileContent.match(searchPattern);
            if (match) {
              // Store the full tag content without truncation
              failureInfo.sampleContent = match[0];
            }
          }

          failure.files.push(failureInfo);
          parsingFailures.set(id, failure);
        }
      }

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

  // Print directory parsing scores
  console.log(chalk.cyan("\nDirectory Parsing Success Rates:"));
  for (const [dir, score] of directoryScores.entries()) {
    const successRate = score.total
      ? Math.round((score.found / score.total) * 100)
      : 0;
    console.log(
      `${dir}: ${successRate}% (found ${score.found} of ${score.total} relevant subtitles)`
    );
  }

  return allTranslations;
}

// Enhanced version of parseResponseFile that tracks which IDs were found
async function parseResponseFileWithTracking(
  filePath: string,
  partNumber: number,
  extractTimings: boolean,
  originalSubtitleIds: number[]
): Promise<{ translations: TranslatedSubtitle[]; parsedIds: Set<number> }> {
  const content = await readFile(filePath, "utf-8");
  const translations: TranslatedSubtitle[] = [];
  const parsedIds = new Set<number>();

  if (verboseMode) {
    console.log(chalk.cyan(`Detailed parsing of ${filePath}:`));
  }

  // APPROACH 1: Find all individual markdown code blocks (multiple blocks per file)
  // This handles cases with multiple consecutive ```xml blocks
  const markdownBlocksResults = extractFromMarkdownBlocks(
    content,
    extractTimings
  );

  if (markdownBlocksResults.length > 0) {
    if (verboseMode) {
      console.log(
        `Found ${markdownBlocksResults.length} subtitle entries from markdown blocks`
      );
    }

    for (const result of markdownBlocksResults) {
      translations.push({
        ...result,
        source: filePath,
        partNumber,
      });

      // Track which IDs were parsed successfully
      const id = parseInt(result.number, 10);
      if (!isNaN(id)) {
        parsedIds.add(id);
      }
    }
  } else {
    // APPROACH 2: Find all variants of subtitle tags directly in content
    const allSublineTags = getAllSublineTags(content);

    if (allSublineTags.length > 0) {
      if (verboseMode) {
        console.log(
          `Found ${allSublineTags.length} subtitle entries using direct tag extraction`
        );
      }

      for (const tagContent of allSublineTags) {
        const extractedData = extractSubtitleData(tagContent, extractTimings);

        if (extractedData && extractedData.number) {
          translations.push({
            ...extractedData,
            source: filePath,
            partNumber,
          });

          const id = parseInt(extractedData.number, 10);
          if (!isNaN(id)) {
            parsedIds.add(id);
          }
        }
      }
    } else if (translations.length === 0) {
      // APPROACH 3: Last resort regex pattern matching
      if (verboseMode) {
        console.log(`No direct tags found, trying regex patterns...`);
      }

      const originalResults = extractWithRegexPatterns(content, extractTimings);

      if (originalResults.length > 0) {
        if (verboseMode) {
          console.log(
            `Found ${originalResults.length} translations using regex patterns`
          );
        }

        for (const result of originalResults) {
          translations.push({
            ...result,
            source: filePath,
            partNumber,
          });

          const id = parseInt(result.number, 10);
          if (!isNaN(id)) {
            parsedIds.add(id);
          }
        }
      }
    }
  }

  return { translations, parsedIds };
}

// Generate the final SRT file with colored subtitles
async function generateFinalSrt(
  originalSubtitles: Map<number, OriginalSubtitle>,
  translations: Map<string, TranslatedSubtitle>,
  useResponseTimings: boolean
): Promise<string> {
  const finalSubtitles: FinalSubtitle[] = [];
  let responseTimingsUsed = 0;
  let fallbackCount = 0;
  let markedFallbacks = 0;

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
        startTime: timeToSeconds(timing.split(" --> ")[0]),
        endTime: timeToSeconds(timing.split(" --> ")[1]),
        isFallback: translation.english ? false : true, // Mark as fallback if no translated English
      });

      // Count if we had to fall back to original content
      if (!translation.english) {
        fallbackCount++;
      }
    } else {
      // Use original content if no translation found
      finalSubtitles.push({
        id: originalSub.id,
        timing: originalSub.timing,
        english: originalSub.content,
        korean: "",
        startTime: originalSub.startTime,
        endTime: originalSub.endTime,
        isFallback: true, // Mark as fallback since no translation was found
      });
      fallbackCount++;
    }
  }

  if (useResponseTimings) {
    console.log(
      chalk.cyan(`Used response timings for ${responseTimingsUsed} subtitles`)
    );
  }

  if (fallbackCount > 0) {
    console.log(
      chalk.yellow(
        `Using original content as fallback for ${fallbackCount} subtitles`
      )
    );
  }

  // Sort by start time to handle overlaps
  finalSubtitles.sort((a, b) => a.startTime - b.startTime);

  // Fix overlapping subtitles
  let overlapsFixed = 0;
  for (let i = 0; i < finalSubtitles.length - 1; i++) {
    const current = finalSubtitles[i];
    const next = finalSubtitles[i + 1];

    if (current.endTime > next.startTime) {
      // Calculate new end time: 0.5 seconds before next subtitle starts or 5 seconds from start, whichever is shorter
      const maxDuration = 5; // 5 seconds maximum subtitle duration
      const gapBeforeNext = 0.5; // 0.5 second gap before next subtitle

      const endOption1 = next.startTime - gapBeforeNext; // 0.5 seconds before next starts
      const endOption2 = current.startTime + maxDuration; // 5 seconds from start

      const newEndTime = Math.min(endOption1, endOption2);

      // Only adjust if it would actually make the subtitle shorter
      if (newEndTime < current.endTime) {
        const originalEndTime = current.endTime;
        current.endTime = newEndTime;

        // Update the timing string
        current.timing = `${secondsToTimestamp(
          current.startTime
        )} --> ${secondsToTimestamp(current.endTime)}`;

        overlapsFixed++;

        // Debugging details for first 5 fixed overlaps
        if (overlapsFixed <= 5) {
          console.log(
            chalk.yellow(`Fixed overlap for subtitle #${current.id}:`)
          );
          console.log(
            `  Original: ${secondsToTimestamp(
              current.startTime
            )} --> ${secondsToTimestamp(originalEndTime)}`
          );
          console.log(
            `  Adjusted: ${secondsToTimestamp(
              current.startTime
            )} --> ${secondsToTimestamp(current.endTime)}`
          );
        }
      }
    }
  }

  if (overlapsFixed > 0) {
    console.log(chalk.green(`Fixed ${overlapsFixed} overlapping subtitles`));
    if (overlapsFixed > 5) {
      console.log(`(Showed details for first 5 overlaps)`);
    }
  }

  // Now sort by ID and renumber for the final output
  finalSubtitles.sort((a, b) => a.id - b.id);

  // Generate the SRT content with colored text
  let srtContent = "";
  let newId = 1;
  const fallbackSamples: string[] = [];

  for (const sub of finalSubtitles) {
    // Format the subtitle text with colors
    let subtitleText = "";

    if (sub.english) {
      if (markFallbacks && sub.isFallback) {
        // Mark fallback subtitles with a special prefix and/or color
        subtitleText += `<font color="#${englishColor}">[⚠ Original] ${sub.english}</font>`;
        markedFallbacks++;

        // Collect a few samples of marked fallbacks for verification
        if (fallbackSamples.length < 3) {
          fallbackSamples.push(
            `ID #${sub.id}: [⚠ Original] ${sub.english.substring(0, 30)}${
              sub.english.length > 30 ? "..." : ""
            }`
          );
        }
      } else {
        subtitleText += `<font color="#${englishColor}">${sub.english}</font>`;
      }
    }

    if (sub.english && sub.korean) {
      subtitleText += "\n";
    }

    if (sub.korean) {
      subtitleText += `<font color="#${koreanColor}">${sub.korean}</font>`;
    }

    // Add to SRT content
    srtContent += `${newId}\n${sub.timing}\n${subtitleText}\n\n`;
    newId++;
  }

  // Show marker usage summary
  if (markFallbacks) {
    console.log(
      chalk.cyan(`Added fallback markers to ${markedFallbacks} subtitles`)
    );
    if (fallbackSamples.length > 0) {
      console.log("Sample fallback markers:");
      fallbackSamples.forEach((sample) => console.log(`  ${sample}`));
    }
  } else {
    console.log("Fallback marking is disabled");
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
    // Print configuration information
    console.log(chalk.cyan("Configuration:"));
    console.log(`- Primary directory: ${primaryDir}`);
    if (backupDir) {
      console.log(`- Backup directory: ${backupDir}`);
    }
    console.log(`- Original SRT: ${originalSrtPath}`);
    console.log(`- Output directory: ${outputDir}`);
    console.log(`- Base output filename: ${baseOutputFilename}`);
    console.log(`- Response timings: ${useResponseTimings ? "Yes" : "No"}`);
    console.log(
      `- Subtitle colors: English=#${englishColor}, Korean=#${koreanColor}`
    );

    // Create output directory if it doesn't exist
    if (!existsSync(outputDir)) {
      await fsMkdir(outputDir, { recursive: true });
      console.log(`Created output directory: ${outputDir}`);
    }

    // Directories to process
    const directories: string[] = [];

    // Add primary directory if it exists
    if (existsSync(primaryDir)) {
      directories.push(primaryDir);
      console.log(chalk.cyan(`Using primary directory: ${primaryDir}`));
    } else {
      console.log(
        chalk.yellow(`Primary directory ${primaryDir} not found, skipping`)
      );
    }

    // Add backup directory if specified and exists
    if (backupDir) {
      if (existsSync(backupDir)) {
        directories.push(backupDir);
        console.log(chalk.cyan(`Using backup directory: ${backupDir}`));
      } else {
        console.log(
          chalk.yellow(`Backup directory ${backupDir} not found, skipping`)
        );
      }
    }

    // Check if we have at least one valid directory
    if (directories.length === 0) {
      console.error(
        chalk.red(
          "❌ Error: No valid response directories found. Please check your paths."
        )
      );
      process.exit(1);
    }

    // Parse the original SRT file
    if (!existsSync(originalSrtPath)) {
      console.error(
        chalk.red(`❌ Error: Original SRT file not found: ${originalSrtPath}`)
      );
      process.exit(1);
    }

    const originalSubtitles = await parseOriginalSrt(originalSrtPath);

    // Get a list of all original subtitle IDs
    const originalSubtitleIds = Array.from(originalSubtitles.keys());

    // Process all response files and merge translations
    const translations = await processResponseFiles(
      directories,
      useResponseTimings,
      originalSubtitleIds
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

    // Generate output filename based on parameters
    let outputFilename = baseOutputFilename;

    // Add timing source indicator
    if (useResponseTimings) {
      // Split the filename to insert suffix before extension
      const filenameParts = outputFilename.split(".");
      if (filenameParts.length > 1) {
        const extension = filenameParts.pop();
        outputFilename = filenameParts.join(".") + "_resp_timing." + extension;
      } else {
        outputFilename = outputFilename + "_resp_timing";
      }
    }

    // Add directory identifiers to filename if using non-default directories
    if (primaryDir !== DEFAULT_PRIMARY_DIR) {
      const primaryDirName = primaryDir.split("/").pop() || "custom";

      // Split the filename to insert suffix before extension
      const filenameParts = outputFilename.split(".");
      if (filenameParts.length > 1) {
        const extension = filenameParts.pop();
        outputFilename =
          filenameParts.join(".") + "_" + primaryDirName + "." + extension;
      } else {
        outputFilename = outputFilename + "_" + primaryDirName;
      }
    }

    // Generate the final SRT file
    const srtContent = await generateFinalSrt(
      originalSubtitles,
      translations,
      useResponseTimings
    );

    // Write to output file
    const outputPath = join(outputDir, outputFilename);
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

    if (backupDir) {
      console.log(`  - Using directories: ${primaryDir}, ${backupDir}`);
    } else {
      console.log(`  - Using directory: ${primaryDir}`);
    }

    // Validate the generated SRT file
    await validateGeneratedSrt(outputPath, originalSubtitles);

    // Output parsing failures to debug file or console
    const failuresCount = parsingFailures.size;

    if (failuresCount > 0) {
      console.log(
        chalk.yellow(
          `\n🔍 Found ${failuresCount} subtitles with parsing issues`
        )
      );

      // Group failures by file to identify problematic files
      const fileFailures: Map<string, number[]> = new Map();
      for (const [id, failure] of parsingFailures.entries()) {
        for (const fileInfo of failure.files) {
          const key = fileInfo.filename;
          if (!fileFailures.has(key)) {
            fileFailures.set(key, []);
          }
          fileFailures.get(key)!.push(id);
        }
      }

      // Show files with the most failures
      console.log(chalk.yellow("Files with the most parsing failures:"));
      const sortedFiles = Array.from(fileFailures.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 5);

      for (const [file, ids] of sortedFiles) {
        console.log(`  ${file}: ${ids.length} failures`);
      }

      // Generate detailed debug info if requested
      if (debugFile) {
        let debugContent = "# Subtitle Parsing Failures Report\n\n";
        debugContent += `Generated: ${new Date().toISOString()}\n\n`;
        debugContent += `Total failures: ${failuresCount}\n\n`;

        // Add file summary
        debugContent += "## Problem Files\n\n";
        for (const [file, ids] of fileFailures.entries()) {
          debugContent += `- ${file}: ${ids.length} failures (IDs: ${ids
            .slice(0, 10)
            .join(", ")}${ids.length > 10 ? "..." : ""})\n`;
        }

        // Add details for each failure
        debugContent += "\n## Detailed Failures\n\n";

        // Organize failures by file to limit reporting
        const fileDetailedFailures: Map<
          string,
          Map<number, ParsingFailure>
        > = new Map();

        // Group failures by file
        for (const [id, failure] of parsingFailures.entries()) {
          for (const fileInfo of failure.files) {
            const filename = fileInfo.filename;
            if (!fileDetailedFailures.has(filename)) {
              fileDetailedFailures.set(filename, new Map());
            }
            fileDetailedFailures.get(filename)!.set(id, failure);
          }
        }

        // Add detailed failures from each file (max 20 per file)
        for (const [filename, failures] of fileDetailedFailures.entries()) {
          debugContent += `## File: ${filename}\n\n`;

          // Sort failures by ID for consistent ordering
          const sortedFailures = Array.from(failures.entries()).sort(
            (a, b) => a[0] - b[0]
          );
          const displayCount = Math.min(sortedFailures.length, 20);

          // Display warning if limiting the output
          if (sortedFailures.length > 20) {
            debugContent += `**Note:** Showing ${displayCount} of ${sortedFailures.length} failures for this file\n\n`;
          }

          // Show the failures (limited to 20)
          for (let i = 0; i < displayCount; i++) {
            const [id, failure] = sortedFailures[i];
            debugContent += `### ID ${id}\n\n`;

            // Only include file info for this specific file
            for (const fileInfo of failure.files) {
              if (fileInfo.filename === filename) {
                debugContent += `Part ${fileInfo.partNumber}\n`;
                debugContent += `Found tag: ${
                  fileInfo.foundSublineTag ? "Yes" : "No"
                }\n`;

                if (fileInfo.sampleContent) {
                  debugContent += "Full content:\n```xml\n";
                  debugContent += fileInfo.sampleContent;
                  debugContent += "\n```\n";
                }

                debugContent += "\n";
              }
            }

            debugContent += "---\n\n";
          }
        }

        // Write debug info to file
        const debugPath = join(outputDir, debugFile);
        await writeFile(debugPath, debugContent);
        console.log(
          chalk.green(`✅ Saved detailed parsing debug info to: ${debugPath}`)
        );
      } else if (verboseMode) {
        // Show sample failures in verbose mode
        console.log("\nSample parsing failures (first 3):");
        let count = 0;
        for (const [id, failure] of parsingFailures.entries()) {
          if (count >= 3) break;
          console.log(`\nID ${id}:`);

          for (const fileInfo of failure.files) {
            console.log(
              `  File: ${fileInfo.filename} (Part ${fileInfo.partNumber})`
            );
            console.log(
              `  Found tag: ${fileInfo.foundSublineTag ? "Yes" : "No"}`
            );

            if (fileInfo.sampleContent) {
              console.log("  Content:");
              // Show full content in verbose mode, but format for console viewing
              const formattedContent = fileInfo.sampleContent.replace(
                /\n/g,
                "\n  "
              ); // Indent each line for readability
              console.log(`  ${formattedContent}`);
            }
          }

          count++;
        }
      }
    }
  } catch (error) {
    console.error(chalk.red("❌ Error:"), error);
  }
}

main();
