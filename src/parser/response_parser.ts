import chalk from "chalk";
import {
  type ParsedTranslationEntry,
  type ProcessingIssue,
  type ParsingIssueType,
} from "../types.js";
import * as logger from "../utils/logger.js";

// --- Constants ---
const CONTEXT_SNIPPET_LENGTH = 150;
const MM_SS_REGEX = /^(\d{1,2}):(\d{2})$/;
const HH_MM_SS_REGEX = /^(\d{1,2}):(\d{2}):(\d{2})$/;

// --- Result Interface for Internal Use ---
interface InternalParseResult {
  entries: ParsedTranslationEntry[];
  issues: ProcessingIssue[];
  summary: {
    // Keep summary for potential internal logging or reporting
    totalEntriesAttempted: number;
    successfullyParsed: number;
    markdownBlocksProcessed: number;
    directTagsProcessed: number;
    errors: number;
    warnings: number;
  };
}

// --- Utility Functions (Adapted) ---

/** Calculates approximate line number based on character index */
function getLineNumber(content: string, index: number): number {
  const validIndex = Math.max(0, Math.min(index, content.length));
  return content.substring(0, validIndex).split("\n").length;
}

/** Adds a parsing issue to the provided list. */
function addIssue(
  issuesList: ProcessingIssue[],
  issueDetails: Omit<ProcessingIssue, "lineNumber" | "context" | "type"> & {
    type: ParsingIssueType;
    contextSnippet?: string;
  },
  charIndex?: number,
  fullContent?: string
) {
  const context = issueDetails.contextSnippet
    ? issueDetails.contextSnippet.substring(0, CONTEXT_SNIPPET_LENGTH) +
      (issueDetails.contextSnippet.length > CONTEXT_SNIPPET_LENGTH ? "..." : "")
    : charIndex !== undefined && fullContent
    ? fullContent.substring(charIndex, charIndex + CONTEXT_SNIPPET_LENGTH) +
      (fullContent.length > charIndex + CONTEXT_SNIPPET_LENGTH ? "..." : "")
    : undefined;

  const fullIssue: ProcessingIssue = {
    ...issueDetails,
    lineNumber:
      charIndex !== undefined && fullContent
        ? getLineNumber(fullContent, charIndex)
        : undefined,
    context: context,
  };
  issuesList.push(fullIssue);
  // No console logging here, handled by caller if needed
}

// --- Timing Parsers (Adapted from original) ---
function timeToSeconds(time: string): number {
  const timeStr = time.replace(",", ".");
  const parts = timeStr.split(":");
  if (parts.length !== 3) throw new Error(`Invalid time format: "${time}"`);
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

function parseMmSs(time: string): number {
  const match = time.match(MM_SS_REGEX);
  if (!match) throw new Error(`Invalid time format: "${time}"`);
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

function parseHhMmSs(time: string): number {
  const match = time.match(HH_MM_SS_REGEX);
  if (!match) throw new Error(`Invalid time format: "${time}"`);
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

function isValidTiming(start?: number, end?: number): boolean {
  return (
    start !== undefined &&
    end !== undefined &&
    !isNaN(start) &&
    !isNaN(end) &&
    end > start
  );
}

// --- Tag Extraction (Adapted) ---
function extractNestedTagContent(
  content: string,
  tagNames: string | string[],
  issuesList: ProcessingIssue[],
  contextInfo: {
    fullContent: string;
    searchStartIndex: number;
    currentId?: string;
  }
): string | null {
  if (!Array.isArray(tagNames)) tagNames = [tagNames];

  for (const tagName of tagNames) {
    const escapedTagName = tagName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
    const startTagRegex = new RegExp(`<${escapedTagName}(\\s+[^>]*)?>`, "i");
    const startMatch = content.match(startTagRegex);

    if (startMatch && startMatch.index !== undefined) {
      const openTag = startMatch[0];
      const openTagIndex = startMatch.index;
      const valueStartIndex = openTagIndex + openTag.length;
      const closeTagMarkerIndex = content.indexOf("</", valueStartIndex);

      if (closeTagMarkerIndex !== -1) {
        const extractedContent = content
          .substring(valueStartIndex, closeTagMarkerIndex)
          .trim();
        const closingTagMatch = content
          .substring(closeTagMarkerIndex)
          .match(/<\/([^>]+)>/);
        if (closingTagMatch) {
          const actualClosingTagName = closingTagMatch[1].trim();
          const expectedClosingTag = `</${tagName}>`;
          if (actualClosingTagName.toLowerCase() !== tagName.toLowerCase()) {
            addIssue(
              issuesList,
              {
                type: "MalformedTag",
                severity: "warning",
                subtitleId: contextInfo.currentId,
                message: `Found opening tag '<${tagName}>' but next closing tag was '</${actualClosingTagName}>' (expected '${expectedClosingTag}'). Using content anyway.`,
                contextSnippet: content.substring(
                  openTagIndex,
                  Math.min(
                    content.length,
                    closeTagMarkerIndex + closingTagMatch[0].length + 10
                  )
                ),
              },
              contextInfo.searchStartIndex + openTagIndex,
              contextInfo.fullContent
            );
          }
        }
        return extractedContent;
      } else {
        addIssue(
          issuesList,
          {
            type: "MalformedTag",
            severity: "warning",
            subtitleId: contextInfo.currentId,
            message: `Found opening tag '<${tagName}>' but no subsequent closing tag marker '</' was found within the parsed block.`,
            contextSnippet: content.substring(openTagIndex),
          },
          contextInfo.searchStartIndex + openTagIndex,
          contextInfo.fullContent
        );
        return null;
      }
    }
  }
  return null;
}

// --- Core Parsing Logic (Adapted) ---

/**
 * Extracts subtitle data from a single <subline> block content.
 * Adapts output to ParsedTranslationEntry format.
 */
function extractSublineData(
  tagContent: string,
  sourceFormat: ParsedTranslationEntry["sourceFormat"],
  issuesList: ProcessingIssue[],
  contextInfo: {
    fullContent: string;
    tagStartIndex: number;
    sourceChunk: number;
    targetLanguages: string[];
  }
): Omit<ParsedTranslationEntry, "sourceFormat" | "sourceChunk"> | null {
  const initialContext = {
    ...contextInfo,
    searchStartIndex: contextInfo.tagStartIndex,
  };
  const number = extractNestedTagContent(
    tagContent,
    ["original_number", "number", "id"],
    issuesList,
    initialContext
  );

  if (!number) {
    if (!/<\/?(?:original_number|number|id)/i.test(tagContent)) {
      addIssue(
        issuesList,
        {
          type: "NumberNotFound",
          severity: "error",
          message: "Missing <original_number> tag.",
          contextSnippet: tagContent,
        },
        contextInfo.tagStartIndex,
        contextInfo.fullContent
      );
    } else {
      addIssue(
        issuesList,
        {
          type: "ExtractionFailed",
          severity: "error",
          message:
            "Found potential <original_number> tag but failed to extract content.",
          contextSnippet: tagContent,
        },
        contextInfo.tagStartIndex,
        contextInfo.fullContent
      );
    }
    return null;
  }

  const updatedContext = {
    ...contextInfo,
    currentId: number,
    searchStartIndex: contextInfo.tagStartIndex,
  };

  const originalLine = extractNestedTagContent(
    tagContent,
    "original_line",
    issuesList,
    updatedContext
  );
  const timingValue = extractNestedTagContent(
    tagContent,
    ["original_timing", "timing"],
    issuesList,
    updatedContext
  );

  const translations: Record<string, string | null> = {};
  let hasAnyTranslation = false;
  translations["english"] = extractNestedTagContent(
    tagContent,
    ["better_english_translation", "english_translation", "english"],
    issuesList,
    updatedContext
  );
  if (translations["english"] !== null) hasAnyTranslation = true;
  for (const lang of contextInfo.targetLanguages) {
    const safeLangTag = lang.toLowerCase().replace(/\s+/g, "_");
    translations[lang] = extractNestedTagContent(
      tagContent,
      `${safeLangTag}_translation`,
      issuesList,
      updatedContext
    );
    if (translations[lang] !== null) hasAnyTranslation = true;
  }
  if (!hasAnyTranslation) {
    addIssue(
      issuesList,
      {
        type: "TextNotFound",
        severity: "warning",
        subtitleId: number,
        message:
          "Found ID but failed to extract any English or target language translations.",
        contextSnippet: tagContent,
      },
      contextInfo.tagStartIndex,
      contextInfo.fullContent
    );
  }

  let parsedStartTime: number | undefined = undefined;
  let parsedEndTime: number | undefined = undefined;
  if (timingValue) {
    try {
      const parts = timingValue.split(" --> ");
      if (parts.length === 2) {
        parsedStartTime = timeToSeconds(parts[0].trim());
        parsedEndTime = timeToSeconds(parts[1].trim());
        if (!isValidTiming(parsedStartTime, parsedEndTime)) {
          addIssue(
            issuesList,
            {
              type: "InvalidTimingValue",
              severity: "warning",
              subtitleId: number,
              message: `Invalid timing values: ${timingValue}`,
              contextSnippet: timingValue,
            },
            contextInfo.tagStartIndex,
            contextInfo.fullContent
          );
          parsedStartTime = undefined;
          parsedEndTime = undefined;
        }
      } else {
        addIssue(
          issuesList,
          {
            type: "InvalidTimingFormat",
            severity: "warning",
            subtitleId: number,
            message: `Invalid timing format (expected -->): ${timingValue}`,
            contextSnippet: timingValue,
          },
          contextInfo.tagStartIndex,
          contextInfo.fullContent
        );
      }
    } catch (e: any) {
      addIssue(
        issuesList,
        {
          type: "InvalidTimingFormat",
          severity: "warning",
          subtitleId: number,
          message: `Failed to parse timing string components: ${timingValue} - ${e.message}`,
          contextSnippet: timingValue,
        },
        contextInfo.tagStartIndex,
        contextInfo.fullContent
      );
    }
  }

  return {
    originalId: number,
    originalLine: originalLine ?? undefined,
    originalTiming: timingValue ?? undefined,
    parsedStartTimeSeconds: parsedStartTime,
    parsedEndTimeSeconds: parsedEndTime,
    translations,
  };
}

/**
 * Main parsing function for the LLM response content.
 * @param llmResponseContent The raw text response from the translation LLM.
 * @param sourceChunkNumber The part number this response corresponds to.
 * @param targetLanguages The list of target languages expected.
 * @returns An object containing the list of parsed entries and any issues found.
 */
export function parseTranslationResponse(
  llmResponseContent: string,
  sourceChunkNumber: number,
  targetLanguages: string[]
): { entries: ParsedTranslationEntry[]; issues: ProcessingIssue[] } {
  const entries: ParsedTranslationEntry[] = [];
  const issuesList: ProcessingIssue[] = [];
  const foundIds = new Set<string>();
  const processedRanges: { start: number; end: number }[] = [];

  let summary = {
    totalEntriesAttempted: 0,
    successfullyParsed: 0,
    markdownBlocksProcessed: 0,
    directTagsProcessed: 0,
    errors: 0,
    warnings: 0,
  };

  const markdownBlockRegex = /```(?:xml)?\s*\n?([\s\S]*?)\n?```/g;
  let markdownMatch;
  while (
    (markdownMatch = markdownBlockRegex.exec(llmResponseContent)) !== null
  ) {
    summary.markdownBlocksProcessed++;
    const blockContent = markdownMatch[1].trim();
    const blockStartIndex =
      markdownMatch.index + markdownMatch[0].indexOf(blockContent);
    processedRanges.push({
      start: markdownMatch.index,
      end: markdownMatch.index + markdownMatch[0].length,
    });

    if (!blockContent) {
      addIssue(
        issuesList,
        {
          type: "MarkdownBlockEmptyOrInvalid",
          severity: "warning",
          message: "Found empty markdown block.",
          contextSnippet: markdownMatch[0],
        },
        markdownMatch.index,
        llmResponseContent
      );
      continue;
    }

    const sublineRegex = /<subline>([\s\S]*?)<\/subline>/gi;
    let sublineMatch;
    let foundSubTagInBlock = false;
    while ((sublineMatch = sublineRegex.exec(blockContent)) !== null) {
      foundSubTagInBlock = true;
      summary.totalEntriesAttempted++;
      const sublineContent = sublineMatch[1];
      const sublineStartIndex =
        blockStartIndex +
        sublineMatch.index +
        sublineMatch[0].indexOf(sublineContent);

      const contextInfo = {
        fullContent: llmResponseContent,
        tagStartIndex: sublineStartIndex,
        sourceChunk: sourceChunkNumber,
        targetLanguages,
      };
      const extracted = extractSublineData(
        sublineContent,
        "markdown",
        issuesList,
        contextInfo
      );

      if (extracted) {
        if (foundIds.has(extracted.originalId)) {
          addIssue(
            issuesList,
            {
              type: "DuplicateId",
              severity: "warning",
              subtitleId: extracted.originalId,
              message: `Duplicate ID found (markdown).`,
            },
            sublineStartIndex,
            llmResponseContent
          );
        } else {
          foundIds.add(extracted.originalId);
          entries.push({
            ...extracted,
            sourceChunk: sourceChunkNumber,
            sourceFormat: "markdown",
          });
          summary.successfullyParsed++;
        }
      }
    }
    if (!foundSubTagInBlock && blockContent.length > 0) {
      addIssue(
        issuesList,
        {
          type: "AmbiguousStructure",
          severity: "warning",
          message: "Markdown block found but contained no <subline> tags.",
          contextSnippet: blockContent,
        },
        blockStartIndex,
        llmResponseContent
      );
    }
  }

  const directSublineRegex = /<subline>([\s\S]*?)<\/subline>/gi;
  let directMatch;
  while ((directMatch = directSublineRegex.exec(llmResponseContent)) !== null) {
    const matchStartIndex = directMatch.index;
    if (
      processedRanges.some(
        (range) => matchStartIndex >= range.start && matchStartIndex < range.end
      )
    ) {
      continue;
    }
    summary.totalEntriesAttempted++;
    summary.directTagsProcessed++;
    const sublineContent = directMatch[1];
    const sublineStartIndex =
      matchStartIndex + directMatch[0].indexOf(sublineContent);
    const contextInfo = {
      fullContent: llmResponseContent,
      tagStartIndex: sublineStartIndex,
      sourceChunk: sourceChunkNumber,
      targetLanguages,
    };
    const extracted = extractSublineData(
      sublineContent,
      "direct_tag",
      issuesList,
      contextInfo
    );

    if (extracted) {
      if (foundIds.has(extracted.originalId)) {
        addIssue(
          issuesList,
          {
            type: "DuplicateId",
            severity: "warning",
            subtitleId: extracted.originalId,
            message: `Duplicate ID found (direct tag).`,
          },
          sublineStartIndex,
          llmResponseContent
        );
      } else {
        foundIds.add(extracted.originalId);
        entries.push({
          ...extracted,
          sourceChunk: sourceChunkNumber,
          sourceFormat: "direct_tag",
        });
        summary.successfullyParsed++;
      }
    }
  }

  entries.sort((a, b) => {
    const numA = parseInt(a.originalId, 10);
    const numB = parseInt(b.originalId, 10);
    if (isNaN(numA)) return 1;
    if (isNaN(numB)) return -1;
    return numA - numB;
  });

  summary.errors = issuesList.filter((i) => i.severity === "error").length;
  summary.warnings = issuesList.filter((i) => i.severity === "warning").length;

  logger.debug(
    `[Chunk ${sourceChunkNumber}] Parsing complete. Found: ${summary.successfullyParsed}, Errors: ${summary.errors}, Warnings: ${summary.warnings}`
  );

  return { entries, issues: issuesList };
}
