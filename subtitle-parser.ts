#!/usr/bin/env bun

/**
 * Standalone Subtitle Parser Module
 *
 * Usage:
 * bun run subtitle-parser.ts <input-file> [options]
 *
 * Description:
 * Parses a text file containing LLM-generated subtitle translations (expected in XML-like format),
 * extracts subtitle data (ID, English, Korean, optional timing), logs parsing issues,
 * and outputs the parsed data and a report.
 * Handles potentially malformed closing tags and alternative timing formats.
 *
 * Options:
 * -i, --input <file>        Required: Path to the input text file.
 * -o, --output-data <file>  Path for the parsed data JSON output (default: <input-file>.parsed.json).
 * -r, --output-report <file> Path for the parsing report text file (default: <input-file>.report.txt).
 * -t, --extract-timings     Attempt to parse and validate timing information (default: false).
 * -v, --verbose             Enable detailed console logging during parsing (default: false).
 * -h, --help                Show this help message.
 */

import { readFile, writeFile } from "fs/promises";
import { join, parse as parsePath } from "path";
import chalk from "chalk";
import { parseArgs } from "util";

// --- Interfaces ---

/** Represents a successfully parsed subtitle entry. */
export interface ParsedSubtitle {
  number: string; // The original subtitle ID/number
  english: string | null; // English translation text, null if missing
  korean: string | null; // Korean translation text, null if missing
  timing?: string; // Raw timing string (e.g., "00:00:01,000 --> 00:00:02,500")
  startTime?: number; // Start time in seconds
  endTime?: number; // End time in seconds
  sourceFormat: "markdown" | "direct_tag" | "regex"; // How this subtitle was found
  rawContent?: string; // Optional: The raw block/tag content parsed
}

/** Defines the types of parsing issues that can be logged. */
export type ParsingIssueType =
  | "MissingTag" // A required tag (like english or korean) was not found within a subtitle block.
  | "InvalidTimingFormat" // Timing string format is incorrect or unparseable by known formats.
  | "InvalidTimingValue" // Timing values are illogical (e.g., end <= start, duration too long/short).
  | "MalformedTag" // XML-like tags seem broken or incomplete (includes mismatched closing tags).
  | "AmbiguousStructure" // Parser found multiple possible interpretations or couldn't reliably extract data.
  | "ExtractionFailed" // General failure to extract expected data from a recognized block.
  | "DuplicateId" // The same subtitle ID was found multiple times in the file.
  | "NumberNotFound" // Could not find a number/ID tag in a potential subtitle block.
  | "TextNotFound" // Found a number/ID but no English or Korean text associated.
  | "MarkdownBlockEmptyOrInvalid"; // Found ``` block, but it was empty or didn't contain expected tags.

/** Represents a single error or warning encountered during parsing. */
interface ParsingIssue {
  type: ParsingIssueType;
  severity: "error" | "warning"; // Errors typically prevent parsing the entry, warnings indicate potential issues.
  id?: string; // The subtitle number/ID, if identifiable.
  message: string; // Description of the issue.
  context?: string; // Snippet of the text being parsed (limited length).
  lineNumber?: number; // Optional: Approximate line number where the issue occurred.
}

/** The overall result returned by the main parsing function. */
interface ParseResult {
  subtitles: ParsedSubtitle[];
  issues: ParsingIssue[];
  summary: {
    inputFile: string;
    totalEntriesAttempted: number;
    successfullyParsed: number;
    markdownBlocksProcessed: number;
    directTagsProcessed: number;
    regexAttempts: number;
    errors: number;
    warnings: number;
  };
}

// --- Constants ---
const CONTEXT_SNIPPET_LENGTH = 150; // Max length for context snippets in reports
// Regex for MM:SS format
const MM_SS_REGEX = /^(\d{1,2}):(\d{2})$/;
// Regex for HH:MM:SS format
const HH_MM_SS_REGEX = /^(\d{1,2}):(\d{2}):(\d{2})$/;

// --- Command Line Argument Parsing ---
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: { type: "string", short: "i" },
    "output-data": { type: "string", short: "o" },
    "output-report": { type: "string", short: "r" },
    "extract-timings": { type: "boolean", short: "t", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true, // Allow input file as positional argument
});

// --- Help Text ---
if (values.help || (positionals.length === 0 && !values.input)) {
  console.log(`
  Standalone Subtitle Parser Module

  Usage:
    bun run subtitle-parser.ts <input-file> [options]
    bun run subtitle-parser.ts -i <input-file> [options]

  Description:
    Parses a text file containing LLM-generated subtitle translations,
    extracts subtitle data, logs parsing issues, and outputs results.
    Handles potentially malformed closing tags and alternative timing formats
    (HH:MM:SS,ms --> HH:MM:SS,ms, MM:SS - MM:SS, HH:MM:SS - HH:MM:SS).

  Options:
    -i, --input <file>        Required: Path to the input text file.
    -o, --output-data <file>  Path for the parsed data JSON output
                              (default: <input-file>.parsed.json).
    -r, --output-report <file> Path for the parsing report text file
                              (default: <input-file>.report.txt).
    -t, --extract-timings     Attempt to parse and validate timing info (default: false).
    -v, --verbose             Enable detailed console logging (default: false).
    -h, --help                Show this help message.

  Example:
    bun run subtitle-parser.ts ./responses/response_part1.txt -t -v -o parsed_part1.json -r report_part1.txt
  `);
  process.exit(0);
}

// --- Configuration ---
const inputFile = (values.input as string) || positionals[0];
const extractTimings = values["extract-timings"] as boolean;
const verboseMode = values.verbose as boolean;

if (!inputFile) {
  console.error(
    chalk.red(
      "Error: Input file path is required. Use -i or provide as argument."
    )
  );
  process.exit(1);
}

const inputPathParsed = parsePath(inputFile);
const outputDataFile =
  (values["output-data"] as string) ||
  join(inputPathParsed.dir, `${inputPathParsed.name}.parsed.json`);
const outputReportFile =
  (values["output-report"] as string) ||
  join(inputPathParsed.dir, `${inputPathParsed.name}.report.txt`);

// --- Global State (for parsing process) ---
let issues: ParsingIssue[] = [];

// --- Utility Functions ---

/** Calculates approximate line number based on character index */
function getLineNumber(content: string, index: number): number {
  // Ensure index is within bounds
  const validIndex = Math.max(0, Math.min(index, content.length));
  return content.substring(0, validIndex).split("\n").length;
}

/** Adds a parsing issue to the global list and optionally logs to console. */
function addIssue(
  issue: Omit<ParsingIssue, "lineNumber">,
  charIndex?: number,
  content?: string
) {
  const fullIssue: ParsingIssue = {
    ...issue,
    lineNumber:
      charIndex !== undefined && content
        ? getLineNumber(content, charIndex)
        : undefined,
    // Ensure context is derived safely
    context: issue.context
      ? issue.context.substring(0, CONTEXT_SNIPPET_LENGTH) +
        (issue.context.length > CONTEXT_SNIPPET_LENGTH ? "..." : "")
      : charIndex !== undefined && content
      ? content.substring(charIndex, charIndex + CONTEXT_SNIPPET_LENGTH) +
        (content.length > charIndex + CONTEXT_SNIPPET_LENGTH ? "..." : "")
      : undefined,
  };
  issues.push(fullIssue);
  if (verboseMode) {
    const color = issue.severity === "error" ? chalk.red : chalk.yellow;
    console.log(
      color(
        `[${issue.severity.toUpperCase()}] ${issue.type}${
          fullIssue.lineNumber ? ` (Line ~${fullIssue.lineNumber})` : ""
        }${issue.id ? ` (ID: ${issue.id})` : ""}: ${issue.message}`
      )
    );
    if (fullIssue.context) {
      // Ensure context is displayed safely, replacing potential newlines that might break console formatting
      console.log(color(`  Context: ${fullIssue.context.replace(/\n/g, " ")}`));
    }
  }
}

/** Parse HH:MM:SS,ms timestamp to seconds */
function timeToSeconds(time: string): number {
  const timeStr = time.replace(",", ".");
  const parts = timeStr.split(":");
  if (parts.length !== 3)
    throw new Error(`Invalid time format: "${time}". Expected HH:MM:SS,ms`);

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
    throw new Error(`Invalid time components in "${time}"`);
  }

  return hours * 3600 + minutes * 60 + secondsWithMs;
}

/** Parse MM:SS timestamp to seconds */
function parseMmSs(time: string): number {
  const match = time.match(MM_SS_REGEX);
  if (!match) throw new Error(`Invalid time format: "${time}". Expected MM:SS`);
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  if (
    isNaN(minutes) ||
    isNaN(seconds) ||
    minutes < 0 ||
    seconds < 0 ||
    seconds > 59
  ) {
    throw new Error(`Invalid time components in "${time}"`);
  }
  return minutes * 60 + seconds;
}

/** Parse HH:MM:SS timestamp to seconds */
function parseHhMmSs(time: string): number {
  const match = time.match(HH_MM_SS_REGEX);
  if (!match)
    throw new Error(`Invalid time format: "${time}". Expected HH:MM:SS`);
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  if (
    isNaN(hours) ||
    isNaN(minutes) ||
    isNaN(seconds) ||
    hours < 0 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    throw new Error(`Invalid time components in "${time}"`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** Check if start and end times are valid */
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
  // Basic check: end time must be after start time
  if (endTime <= startTime) {
    return false;
  }
  // Optional: Add duration checks if needed (e.g., max 30 seconds for safety?)
  // const duration = endTime - startTime;
  // if (duration <= 0 || duration > 30) {
  //    console.warn(`Suspicious duration ${duration}s for ${startTime} -> ${endTime}`);
  //    // return false; // Decide if you want to reject long durations
  // }
  return true;
}

/**
 * Extract content from nested tags, tolerating malformed closing tags.
 * Finds the start tag and then looks for the *next* closing tag marker `</`.
 * @param content The string to search within.
 * @param tagNames An array of possible tag names (e.g., ["english", "english_translation"]).
 * @param fullFileContent The complete file content (used for line number calculation in errors).
 * @param searchStartIndex The character index within `content` where the search should begin (for context in errors).
 * @returns The trimmed content string or null if not found.
 */
function extractNestedTagContent(
  content: string,
  tagNames: string | string[],
  fullFileContent?: string, // Optional: Pass full content for better error reporting context
  searchStartIndex: number = 0 // Optional: Index in fullFileContent where 'content' starts
): string | null {
  if (!Array.isArray(tagNames)) {
    tagNames = [tagNames];
  }

  for (const tagName of tagNames) {
    // Regex to find the opening tag, handling attributes
    const startTagRegex = new RegExp(`<${tagName}(?:\\s+[^>]*)?>`, "i");
    const startMatch = content.match(startTagRegex);

    if (startMatch && startMatch.index !== undefined) {
      const openTag = startMatch[0];
      const openTagIndex = startMatch.index;
      const valueStartIndex = openTagIndex + openTag.length;

      // Find the *next* closing tag marker `</` after the opening tag's content starts
      const closeTagMarkerIndex = content.indexOf("</", valueStartIndex);

      if (closeTagMarkerIndex !== -1) {
        // Extract the content between the opening tag and the next closing marker
        const extractedContent = content
          .substring(valueStartIndex, closeTagMarkerIndex)
          .trim();

        // --- Optional: Check if the closing tag looks correct and add warning if not ---
        const closingTagMatch = content
          .substring(closeTagMarkerIndex)
          .match(/<\/[^>]+>/);
        if (closingTagMatch) {
          const actualClosingTag = closingTagMatch[0];
          const expectedClosingTag = `</${tagName}>`;
          // Use startsWith for more tolerance (e.g. </original_number> matches </original_num...>) - NO, require exact match for warning
          if (
            actualClosingTag.toLowerCase() !== expectedClosingTag.toLowerCase()
          ) {
            // Calculate approximate index in the *full* file content
            const approxGlobalIndex = searchStartIndex + openTagIndex;
            addIssue(
              {
                type: "MalformedTag",
                severity: "warning",
                message: `Found opening tag '<${tagName}>' but the next closing tag was '${actualClosingTag}' (expected '${expectedClosingTag}'). Using content anyway.`,
                // Provide context around the opening tag in the original content snippet
                context: content.substring(
                  openTagIndex,
                  Math.min(
                    content.length,
                    closeTagMarkerIndex + actualClosingTag.length + 10
                  )
                ),
              },
              approxGlobalIndex,
              fullFileContent
            );
          }
        }
        // --- End Optional Check ---

        return extractedContent;
      } else {
        // Opening tag found, but no closing tag marker found afterwards in the content block
        const approxGlobalIndex = searchStartIndex + openTagIndex;
        addIssue(
          {
            type: "MalformedTag",
            severity: "warning", // Warning because the block might be truncated
            message: `Found opening tag '<${tagName}>' but no subsequent closing tag marker '</' was found within the parsed block.`,
            context: content.substring(openTagIndex),
          },
          approxGlobalIndex,
          fullFileContent
        );
        // Return null as the tag is effectively unclosed in this context
        return null;
      }
    }
  }

  // No matching opening tag found for any of the provided tagNames
  return null;
}

// --- Core Parsing Logic ---

/**
 * Extracts subtitle data from the content within a <subline> or similar tag.
 * @param tagContent The text content inside the main subtitle tag.
 * @param sourceFormat Indicates how the tag was found (for reporting).
 * @param fullContent The full file content for context reporting.
 * @param tagStartIndex The starting character index of the tag content for line number calculation.
 * @returns A ParsedSubtitle object or null if essential data (number) is missing.
 */
function extractSubtitleData(
  tagContent: string,
  sourceFormat: ParsedSubtitle["sourceFormat"],
  fullContent: string,
  tagStartIndex: number
): Omit<ParsedSubtitle, "sourceFormat" | "rawContent"> | null {
  // Use the improved extractNestedTagContent, passing context info
  const number = extractNestedTagContent(
    tagContent,
    ["original_number", "number", "id"],
    fullContent,
    tagStartIndex
  );

  if (!number) {
    // Issue is logged if verboseMode is on inside extractNestedTagContent if tag was found but content extraction failed.
    // Add a specific error here if NO opening tag was found at all.
    // Check if any potential tag exists to differentiate between missing tag and extraction failure.
    if (!/<\/?(?:original_number|number|id)/i.test(tagContent)) {
      addIssue(
        {
          type: "NumberNotFound",
          severity: "error",
          message:
            "Could not find any opening tag for <original_number>, <number>, or <id>.",
          context: tagContent,
        },
        tagStartIndex,
        fullContent
      );
    } else if (
      !issues.some(
        (issue) =>
          issue.type === "MalformedTag" &&
          issue.lineNumber === getLineNumber(fullContent, tagStartIndex)
      )
    ) {
      // Avoid duplicate error if MalformedTag was already logged for the number tag by extractNestedTagContent
      addIssue(
        {
          type: "NumberNotFound", // Or maybe ExtractionFailed?
          severity: "error",
          message:
            "Found potential number/id tag(s), but failed to extract content (likely malformed).",
          context: tagContent,
        },
        tagStartIndex,
        fullContent
      );
    }
    return null; // Cannot proceed without an ID
  }

  const english = extractNestedTagContent(
    tagContent,
    ["better_english_translation", "english_translation", "english"],
    fullContent,
    tagStartIndex
  );

  const korean = extractNestedTagContent(
    tagContent,
    ["korean_translation", "korean"],
    fullContent,
    tagStartIndex
  );

  if (!english && !korean) {
    // Check if tags exist but content extraction failed (warnings logged by extractNestedTagContent)
    const englishTagExists =
      /<\/?(?:better_english_translation|english_translation|english)/i.test(
        tagContent
      );
    const koreanTagExists = /<\/?(?:korean_translation|korean)/i.test(
      tagContent
    );

    if (!englishTagExists && !koreanTagExists) {
      addIssue(
        {
          type: "TextNotFound",
          severity: "warning", // Warning, as maybe only one language was requested/provided
          id: number,
          message:
            "Found number tag, but no English or Korean translation tags were found.",
          context: tagContent,
        },
        tagStartIndex,
        fullContent
      );
    } else {
      addIssue(
        {
          type: "TextNotFound", // Or ExtractionFailed?
          severity: "warning",
          id: number,
          message:
            "Found number tag, and potential English/Korean tags exist but content extraction failed (likely malformed).",
          context: tagContent,
        },
        tagStartIndex,
        fullContent
      );
    }
    // Proceed even without text, the main script might handle fallbacks
  }

  const result: Omit<ParsedSubtitle, "sourceFormat" | "rawContent"> = {
    number,
    english: english || null,
    korean: korean || null,
  };

  // --- Timing Extraction (if enabled) ---
  if (extractTimings) {
    const timingValue = extractNestedTagContent(
      tagContent,
      ["original_timing", "timing"],
      fullContent,
      tagStartIndex
    );

    if (timingValue) {
      let potentialStartTime: number | undefined = undefined;
      let potentialEndTime: number | undefined = undefined;
      let parsedFormat = "unknown";
      let parseError: Error | null = null;

      try {
        // Attempt 1: HH:MM:SS,ms --> HH:MM:SS,ms
        const parts1 = timingValue.split(" --> ");
        if (parts1.length === 2) {
          try {
            potentialStartTime = timeToSeconds(parts1[0].trim());
            potentialEndTime = timeToSeconds(parts1[1].trim());
            parsedFormat = "HH:MM:SS,ms --> HH:MM:SS,ms";
          } catch (e) {
            /* Ignore error, try next format */
          }
        }

        // Attempt 2: MM:SS - MM:SS (if Attempt 1 failed)
        if (potentialStartTime === undefined) {
          const parts2 = timingValue.split(/\s*-\s*/);
          if (
            parts2.length === 2 &&
            MM_SS_REGEX.test(parts2[0].trim()) &&
            MM_SS_REGEX.test(parts2[1].trim())
          ) {
            try {
              potentialStartTime = parseMmSs(parts2[0].trim());
              potentialEndTime = parseMmSs(parts2[1].trim());
              parsedFormat = "MM:SS - MM:SS";
            } catch (e) {
              /* Ignore error, try next format */
            }
          }
        }

        // Attempt 3: HH:MM:SS - HH:MM:SS (if Attempts 1 & 2 failed)
        if (potentialStartTime === undefined) {
          const parts3 = timingValue.split(/\s*-\s*/); // Reuse split, check format with regex
          if (
            parts3.length === 2 &&
            HH_MM_SS_REGEX.test(parts3[0].trim()) &&
            HH_MM_SS_REGEX.test(parts3[1].trim())
          ) {
            try {
              potentialStartTime = parseHhMmSs(parts3[0].trim());
              potentialEndTime = parseHhMmSs(parts3[1].trim());
              parsedFormat = "HH:MM:SS - HH:MM:SS";
            } catch (e) {
              /* Ignore error */
            }
          }
        }

        // Check if any format succeeded
        if (
          potentialStartTime === undefined ||
          potentialEndTime === undefined
        ) {
          throw new Error("Timing string does not match any known format.");
        }

        // Validation (only if parsing succeeded)
        if (isValidTiming(potentialStartTime, potentialEndTime)) {
          result.timing = timingValue; // Keep original string
          result.startTime = potentialStartTime;
          result.endTime = potentialEndTime;
          if (verboseMode)
            console.log(
              chalk.green(
                `  Successfully parsed timing "${timingValue}" using format: ${parsedFormat}`
              )
            );
        } else {
          // Parsed but values invalid (e.g., end <= start)
          addIssue(
            {
              type: "InvalidTimingValue",
              severity: "warning",
              id: number,
              message: `Timing values parsed from "${timingValue}" (format: ${parsedFormat}) are invalid (e.g., end <= start). Discarding timing.`,
              context: timingValue,
            },
            tagStartIndex +
              (tagContent.indexOf(timingValue) >= 0
                ? tagContent.indexOf(timingValue)
                : 0),
            fullContent
          );
        }
      } catch (e: any) {
        // Catch errors from parsing functions or the final throw if no format matched
        addIssue(
          {
            type: "InvalidTimingFormat",
            severity: "warning",
            id: number,
            message: `Failed to parse timing string: "${timingValue}". Attempted formats: HH:MM:SS,ms --> HH:MM:SS,ms, MM:SS - MM:SS, HH:MM:SS - HH:MM:SS. Error: ${e.message}. Discarding timing.`,
            context: timingValue,
          },
          tagStartIndex +
            (tagContent.indexOf(timingValue) >= 0
              ? tagContent.indexOf(timingValue)
              : 0),
          fullContent
        );
      }
    } else {
      // Optional: Add a warning if timing tag exists but extraction failed (handled by extractNestedTagContent)
      // Or add warning if no timing tag was found at all
      if (!/<\/?(?:original_timing|timing)/i.test(tagContent)) {
        // Only log if no timing tag seems to exist
        // addIssue({ type: 'MissingTag', severity: 'info', id: number, message: 'Timing tag (<original_timing> or <timing>) not found.', context: tagContent }, tagStartIndex, fullContent);
      }
    }
  }

  return result;
}

/**
 * Parses the entire file content to find and extract subtitle entries.
 * Tries multiple strategies: Markdown blocks, direct tags.
 * @param content The full text content of the input file.
 * @returns A ParseResult object containing parsed subtitles and issues.
 */
export function parseSubtitleFileContent(content: string): ParseResult {
  const subtitles: ParsedSubtitle[] = [];
  const foundIds = new Set<string>(); // Track IDs to detect duplicates
  issues = []; // Reset issues for this parse run

  let summary = {
    inputFile: inputFile,
    totalEntriesAttempted: 0,
    successfullyParsed: 0,
    markdownBlocksProcessed: 0,
    directTagsProcessed: 0,
    regexAttempts: 0, // Placeholder for future regex strategy
    errors: 0,
    warnings: 0,
  };

  // --- Strategy 1: Markdown Code Blocks (```xml ... ```) ---
  const markdownBlockRegex = /```(?:xml)?\s*\n([\s\S]*?)```/g;
  let markdownMatch;
  const processedRanges = []; // Keep track of ranges processed by markdown

  while ((markdownMatch = markdownBlockRegex.exec(content)) !== null) {
    summary.markdownBlocksProcessed++;
    const blockContent = markdownMatch[1].trim();
    const blockStartIndex =
      markdownMatch.index + markdownMatch[0].indexOf(blockContent); // Index in full content
    const blockEndIndex = markdownMatch.index + markdownMatch[0].length;
    processedRanges.push({ start: markdownMatch.index, end: blockEndIndex }); // Record processed range

    if (!blockContent) {
      addIssue(
        {
          type: "MarkdownBlockEmptyOrInvalid",
          severity: "warning",
          message: "Found empty markdown block.",
          context: markdownMatch[0],
        },
        markdownMatch.index,
        content
      );
      continue;
    }

    // Count each non-empty block as a potential source, detailed attempts counted below
    // summary.totalEntriesAttempted++;

    // Does the block contain explicit <subline> or <subtitle> tags?
    // Use a regex that captures the tag name and content separately
    // Need to handle nested tags potentially better - this simple regex might grab too much if nested
    // Let's refine to be less greedy and find the *first* closing tag for subline/subtitle
    const subTagRegex = /<(subline|subtitle)(?:[^>]*)?>([\s\S]*?)<\/\1>/gi; // Initial greedy approach
    const subTagFinderRegex = /<(subline|subtitle)(?:[^>]*)?>/gi; // Find opening tags
    let subTagStartMatch;
    let foundSubTagInBlock = false;
    let currentBlockSearchIndex = 0;

    while ((subTagStartMatch = subTagFinderRegex.exec(blockContent)) !== null) {
      foundSubTagInBlock = true;
      const tagName = subTagStartMatch[1]; // 'subline' or 'subtitle'
      const openTag = subTagStartMatch[0];
      const openTagIndexInBlock = subTagStartMatch.index;
      const valueStartIndexInBlock = openTagIndexInBlock + openTag.length;

      // Find the *next* corresponding closing tag </tagname>
      // This is complex with regex, let's use indexOf for simplicity here too
      const closeTagString = `</${tagName}>`;
      const closeTagIndexInBlock = blockContent.indexOf(
        closeTagString,
        valueStartIndexInBlock
      );

      let tagContent = "";
      let tagEndIndexInBlock = blockContent.length; // Assume end of block if no close tag

      if (closeTagIndexInBlock !== -1) {
        tagContent = blockContent
          .substring(valueStartIndexInBlock, closeTagIndexInBlock)
          .trim();
        tagEndIndexInBlock = closeTagIndexInBlock + closeTagString.length;
      } else {
        // No proper closing tag found, maybe try finding any '</'?
        const genericCloseIndex = blockContent.indexOf(
          "</",
          valueStartIndexInBlock
        );
        if (genericCloseIndex !== -1) {
          tagContent = blockContent
            .substring(valueStartIndexInBlock, genericCloseIndex)
            .trim();
          tagEndIndexInBlock = genericCloseIndex; // Approximate end
          addIssue(
            {
              type: "MalformedTag",
              severity: "warning",
              message: `Found opening <${tagName}> tag but no matching closing tag '${closeTagString}'. Used content up to next '</'.`,
              context: blockContent.substring(
                openTagIndexInBlock,
                genericCloseIndex + 2
              ),
            },
            blockStartIndex + openTagIndexInBlock,
            content
          );
        } else {
          tagContent = blockContent.substring(valueStartIndexInBlock).trim(); // Take rest of block
          addIssue(
            {
              type: "MalformedTag",
              severity: "warning",
              message: `Found opening <${tagName}> tag but no closing tag was found in the block.`,
              context: blockContent.substring(openTagIndexInBlock),
            },
            blockStartIndex + openTagIndexInBlock,
            content
          );
        }
      }

      // Calculate index relative to the full content string
      const tagStartIndexInFullContent = blockStartIndex + openTagIndexInBlock;

      if (tagContent) {
        summary.totalEntriesAttempted++; // Count each tag within block as attempt
        const extracted = extractSubtitleData(
          tagContent,
          "markdown",
          content,
          tagStartIndexInFullContent
        );
        if (extracted) {
          if (foundIds.has(extracted.number)) {
            addIssue(
              {
                type: "DuplicateId",
                severity: "warning",
                id: extracted.number,
                message: `Duplicate subtitle ID found (markdown block).`,
              },
              tagStartIndexInFullContent,
              content
            );
          } else {
            foundIds.add(extracted.number);
            subtitles.push({
              ...extracted,
              sourceFormat: "markdown",
              rawContent: tagContent,
            });
            summary.successfullyParsed++;
          }
        } // else: Error already logged by extractSubtitleData if number was missing
      } else {
        addIssue(
          {
            type: "MalformedTag",
            severity: "warning",
            message: `Found empty or unparseable <${tagName}> tag within markdown block.`,
            context: blockContent.substring(
              openTagIndexInBlock,
              tagEndIndexInBlock
            ),
          },
          tagStartIndexInFullContent,
          content
        );
      }

      // Advance the regex index past the processed tag
      subTagFinderRegex.lastIndex = blockStartIndex + tagEndIndexInBlock;
    }

    // If no explicit <subline>/<subtitle> tags were found *in the entire block*, try parsing the block content directly
    if (!foundSubTagInBlock) {
      if (verboseMode)
        console.log(
          chalk.blue(
            `Attempting direct parse of markdown block content (no <subline>/<subtitle> tag found inside)`
          )
        );
      summary.totalEntriesAttempted++; // Count block parse as one attempt
      const extracted = extractSubtitleData(
        blockContent,
        "markdown",
        content,
        blockStartIndex
      );
      if (extracted) {
        if (foundIds.has(extracted.number)) {
          addIssue(
            {
              type: "DuplicateId",
              severity: "warning",
              id: extracted.number,
              message: `Duplicate subtitle ID found (direct markdown block parse).`,
            },
            blockStartIndex,
            content
          );
        } else {
          foundIds.add(extracted.number);
          subtitles.push({
            ...extracted,
            sourceFormat: "markdown",
            rawContent: blockContent,
          });
          summary.successfullyParsed++;
        }
      } else {
        // Only add a general failure if number wasn't found, specific errors handled by extractSubtitleData
        if (
          !extractNestedTagContent(
            blockContent,
            ["original_number", "number", "id"],
            content,
            blockStartIndex
          )
        ) {
          addIssue(
            {
              type: "MarkdownBlockEmptyOrInvalid",
              severity: "warning",
              message:
                "Markdown block did not contain identifiable subtitle data (missing number/id or malformed).",
              context: blockContent,
            },
            blockStartIndex,
            content
          );
        }
      }
    }
  }

  // --- Strategy 2: Direct <subline> or <subtitle> tags (outside markdown blocks) ---
  // Use the refined finder regex and indexOf logic from Strategy 1
  const directTagFinderRegex = /<(subline|subtitle)(?:[^>]*)?>/gi; // Find opening tags globally
  let directTagStartMatch;

  while ((directTagStartMatch = directTagFinderRegex.exec(content)) !== null) {
    const openTag = directTagStartMatch[0];
    const tagName = directTagStartMatch[1];
    const matchStartIndex = directTagStartMatch.index;
    const valueStartIndex = matchStartIndex + openTag.length;

    // Check if this match starts within a range already processed by markdown
    const isInMarkdown = processedRanges.some(
      (range) => matchStartIndex >= range.start && matchStartIndex < range.end
    ); // Check if start is within range

    if (isInMarkdown) {
      continue; // Skip tags already handled within markdown blocks
    }

    // Find the corresponding closing tag </tagname>
    const closeTagString = `</${tagName}>`;
    const closeTagIndex = content.indexOf(closeTagString, valueStartIndex);

    let tagContent = "";
    let matchEndIndex = content.length; // Assume end of file if no close tag

    if (closeTagIndex !== -1) {
      tagContent = content.substring(valueStartIndex, closeTagIndex).trim();
      matchEndIndex = closeTagIndex + closeTagString.length;
    } else {
      // No proper closing tag, try generic '</'
      const genericCloseIndex = content.indexOf("</", valueStartIndex);
      if (genericCloseIndex !== -1) {
        tagContent = content
          .substring(valueStartIndex, genericCloseIndex)
          .trim();
        matchEndIndex = genericCloseIndex + 2; // Approx end
        addIssue(
          {
            type: "MalformedTag",
            severity: "warning",
            message: `Found opening <${tagName}> tag but no matching closing tag '${closeTagString}'. Used content up to next '</'.`,
            context: content.substring(matchStartIndex, genericCloseIndex + 2),
          },
          matchStartIndex,
          content
        );
      } else {
        tagContent = content.substring(valueStartIndex).trim(); // Take rest of file
        addIssue(
          {
            type: "MalformedTag",
            severity: "warning",
            message: `Found opening <${tagName}> tag but no closing tag was found.`,
            context: content.substring(matchStartIndex),
          },
          matchStartIndex,
          content
        );
      }
    }

    summary.totalEntriesAttempted++;
    summary.directTagsProcessed++; // Count tags found outside markdown

    if (tagContent) {
      const extracted = extractSubtitleData(
        tagContent,
        "direct_tag",
        content,
        matchStartIndex
      );
      if (extracted) {
        if (foundIds.has(extracted.number)) {
          addIssue(
            {
              type: "DuplicateId",
              severity: "warning",
              id: extracted.number,
              message: `Duplicate subtitle ID found (direct tag).`,
            },
            matchStartIndex,
            content
          );
        } else {
          foundIds.add(extracted.number);
          subtitles.push({
            ...extracted,
            sourceFormat: "direct_tag",
            rawContent: tagContent,
          });
          summary.successfullyParsed++;
        }
      } // else: Error logged by extractSubtitleData
    } else {
      addIssue(
        {
          type: "MalformedTag",
          severity: "warning",
          message: `Found empty or unparseable <${tagName}> tag outside markdown block.`,
          context: content.substring(matchStartIndex, matchEndIndex),
        },
        matchStartIndex,
        content
      );
    }

    // Advance the regex index past the processed tag
    directTagFinderRegex.lastIndex = matchEndIndex;
  }

  // --- Strategy 3: Regex Patterns (Last Resort - Not implemented yet) ---
  // summary.regexAttempts = ...;

  // --- Final Summary Update ---
  summary.errors = issues.filter((i) => i.severity === "error").length;
  summary.warnings = issues.filter((i) => i.severity === "warning").length;

  // Sort subtitles by number (numeric sort)
  subtitles.sort((a, b) => {
    const numA = parseInt(a.number, 10);
    const numB = parseInt(b.number, 10);
    if (isNaN(numA) && isNaN(numB)) return 0;
    if (isNaN(numA)) return 1; // Put NaNs at the end
    if (isNaN(numB)) return -1;
    return numA - numB;
  });

  return { subtitles, issues, summary };
}

// --- Main Execution ---
async function main() {
  console.log(chalk.cyan(`Starting subtitle parsing for: ${inputFile}`));
  console.log(` - Extract Timings: ${extractTimings}`);
  console.log(` - Verbose Logging: ${verboseMode}`);
  console.log(` - Parsed Data Output: ${outputDataFile}`);
  console.log(` - Report Output: ${outputReportFile}`);

  let fileContent: string;
  try {
    fileContent = await readFile(inputFile, "utf-8");
  } catch (error: any) {
    console.error(
      chalk.red(`❌ Error reading input file "${inputFile}": ${error.message}`)
    );
    process.exit(1);
  }

  // --- Perform Parsing ---
  const startTime = performance.now();
  const {
    subtitles,
    issues: finalIssues,
    summary,
  } = parseSubtitleFileContent(fileContent);
  const endTime = performance.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  console.log(chalk.cyan(`\n--- Parsing Summary (${duration}s) ---`));
  console.log(` - Input File: ${summary.inputFile}`);
  console.log(` - Markdown Blocks Found: ${summary.markdownBlocksProcessed}`);
  console.log(
    ` - Direct <subline>/<subtitle> Tags Found (outside MD): ${summary.directTagsProcessed}`
  );
  console.log(
    ` - Total Entries Attempted (Blocks + Tags): ${summary.totalEntriesAttempted}`
  );
  // console.log(` - Regex Attempts: ${summary.regexAttempts}`);
  console.log(
    chalk.green(
      ` - Successfully Parsed Subtitles: ${summary.successfullyParsed}`
    )
  );
  console.log(chalk.red(` - Errors Logged: ${summary.errors}`));
  console.log(chalk.yellow(` - Warnings Logged: ${summary.warnings}`));

  // --- Write Parsed Data Output (JSON) ---
  try {
    const jsonData = JSON.stringify(subtitles, null, 2); // Pretty print JSON
    await writeFile(outputDataFile, jsonData);
    console.log(
      chalk.green(`✅ Successfully wrote parsed data to: ${outputDataFile}`)
    );
  } catch (error: any) {
    console.error(
      chalk.red(
        `❌ Error writing parsed data file "${outputDataFile}": ${error.message}`
      )
    );
  }

  // --- Write Parsing Report ---
  try {
    let reportContent = `# Subtitle Parsing Report\n\n`;
    reportContent += `Input File: ${summary.inputFile}\n`;
    reportContent += `Parsing Timestamp: ${new Date().toISOString()}\n`;
    reportContent += `Duration: ${duration} seconds\n`;
    reportContent += `Options: Extract Timings=${extractTimings}\n`;
    reportContent += `\n## Summary\n`;
    reportContent += `- Successfully Parsed: ${summary.successfullyParsed}\n`;
    reportContent += `- Markdown Blocks Found: ${summary.markdownBlocksProcessed}\n`;
    reportContent += `- Direct Tags Found (outside MD): ${summary.directTagsProcessed}\n`;
    reportContent += `- Total Entries Attempted: ${summary.totalEntriesAttempted}\n`;
    reportContent += `- Errors: ${summary.errors}\n`;
    reportContent += `- Warnings: ${summary.warnings}\n`;

    if (finalIssues.length > 0) {
      reportContent += `\n## Issues Logged (${finalIssues.length})\n\n`;
      // Sort issues by line number for better readability
      finalIssues.sort(
        (a, b) => (a.lineNumber ?? Infinity) - (b.lineNumber ?? Infinity)
      );

      // Group issues by type for better readability in the report
      const issuesByType: { [key in ParsingIssueType]?: ParsingIssue[] } = {};
      for (const issue of finalIssues) {
        if (!issuesByType[issue.type]) {
          issuesByType[issue.type] = [];
        }
        issuesByType[issue.type]!.push(issue);
      }

      reportContent += `### Issues by Type\n\n`;
      for (const type in issuesByType) {
        reportContent += `- ${type}: ${
          issuesByType[type as ParsingIssueType]!.length
        }\n`;
      }
      reportContent += `\n---\n\n`;

      reportContent += `### Detailed Issues (Sorted by Line Number)\n\n`;
      for (const issue of finalIssues) {
        reportContent += `- **Type:** ${issue.type}\n`;
        reportContent += `- **Severity:** ${issue.severity.toUpperCase()}\n`;
        if (issue.id) reportContent += `- **ID:** ${issue.id}\n`;
        if (issue.lineNumber)
          reportContent += `- **Line Approx:** ${issue.lineNumber}\n`;
        reportContent += `- **Message:** ${issue.message}\n`;
        // Use Markdown code block for context to preserve formatting
        if (issue.context)
          reportContent += `- **Context:**\n  \`\`\`\n  ${issue.context}\n  \`\`\`\n`;
        reportContent += `----\n`;
      }
    } else {
      reportContent += `\n## Issues Logged\n\nNo issues were logged during parsing.\n`;
    }

    await writeFile(outputReportFile, reportContent);
    console.log(
      chalk.green(
        `✅ Successfully wrote parsing report to: ${outputReportFile}`
      )
    );
  } catch (error: any) {
    console.error(
      chalk.red(
        `❌ Error writing report file "${outputReportFile}": ${error.message}`
      )
    );
  }

  if (summary.errors > 0) {
    console.log(chalk.red(`\nCompleted with ${summary.errors} errors.`));
  } else if (summary.warnings > 0) {
    console.log(chalk.yellow(`\nCompleted with ${summary.warnings} warnings.`));
  } else {
    console.log(
      chalk.green(`\nCompleted successfully with no errors or warnings.`)
    );
  }
}

// --- Run Main Function ---
main().catch((err) => {
  console.error(chalk.red("\n❌ An unexpected error occurred:"), err);
  process.exit(1);
});
