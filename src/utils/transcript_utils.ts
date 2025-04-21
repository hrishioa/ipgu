import * as logger from "./logger";
import { parseSrtFile, calculateSrtTimeSpan } from "./srt_utils";
import { existsSync } from "fs";
import { secondsToTimestamp } from "./time_utils";
import type { Config, SrtEntry } from "../types.js";

/**
 * Represents a parsed timestamp range from a transcript line.
 */
export interface ParsedTimestamp {
  startTimeSeconds: number;
  endTimeSeconds: number;
  lineNumber: number; // Original line number for context
}

/**
 * Parses a relative timestamp (mm:ss) to seconds.
 */
function parseMmSs(timeStr: string): number | null {
  const parts = timeStr.split(":");
  if (parts.length !== 2) return null;
  const minutes = parseInt(parts[0], 10);
  const seconds = parseInt(parts[1], 10);
  if (isNaN(minutes) || isNaN(seconds)) return null;
  return minutes * 60 + seconds;
}

/**
 * More leniently parses raw transcript text to find timestamp ranges.
 * Looks for the first occurrence of `mm:ss - mm:ss` on each line.
 *
 * @param rawTranscript The raw string output from the LLM.
 * @returns An array of successfully parsed timestamp ranges.
 */
export function findTimestampRanges(rawTranscript: string): ParsedTimestamp[] {
  const lines = rawTranscript.split("\n");
  const parsedTimestamps: ParsedTimestamp[] = [];

  // Regex to find "mm:ss - mm:ss" pattern anywhere, possibly preceded/followed by other chars
  // It captures the two mm:ss parts.
  const timeRangeRegex = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

  lines.forEach((line, index) => {
    const match = line.match(timeRangeRegex);
    if (match) {
      const startTimeStr = match[1];
      const endTimeStr = match[2];

      const startTimeSeconds = parseMmSs(startTimeStr);
      const endTimeSeconds = parseMmSs(endTimeStr);

      // Basic sanity check on parsed times
      if (
        startTimeSeconds !== null &&
        endTimeSeconds !== null &&
        startTimeSeconds <= endTimeSeconds
      ) {
        parsedTimestamps.push({
          startTimeSeconds,
          endTimeSeconds,
          lineNumber: index + 1,
        });
      } else {
        // Log if parsing mm:ss failed even after regex match (unlikely but possible)
        logger.debug(
          `[Transcript Util] Malformed time components in line ${
            index + 1
          }: ${line.trim()}`
        );
      }
    }
    // We don't log lines that *don't* match anymore, as we only care about valid ranges now
  });

  return parsedTimestamps;
}

const MIN_SPAN_COVERAGE_RATIO = 0.75; // Require transcript span to be at least 75% of chunk duration

/**
 * Validates the parsed transcript timestamps based on duration relative to chunk size and optionally against a reference SRT.
 *
 * @param rawTranscript The raw transcript text.
 * @param referenceSrtPath Optional path to the reference SRT chunk for span comparison.
 * @param config The pipeline configuration object (must include chunkDuration).
 * @param minTimestamps Minimum number of valid timestamp ranges required in the LLM transcript.
 * @param allowedSpanDifferenceRatio Allowed fractional difference between LLM span and reference SRT span.
 * @returns Object indicating if validation passed and the reason/details.
 */
export async function validateTranscriptTimestamps(
  rawTranscript: string,
  referenceSrtPath: string | undefined,
  config: Pick<Config, "chunkDuration" | "disableTimingValidation">, // Expect chunkDuration
  minTimestamps: number = 5,
  allowedSpanDifferenceRatio: number = 0.1
): Promise<{
  isValid: boolean;
  detectedLlmSpanSeconds: number | null;
  referenceSrtSpanSeconds?: number | null;
  message: string;
}> {
  let validationMessage = "Validation checks passed.";
  let isValid = true;
  let detectedLlmSpanSeconds: number | null = null;
  let referenceSrtSpanSeconds: number | null = null;

  if (!rawTranscript || rawTranscript.trim().length === 0) {
    return {
      isValid: false,
      detectedLlmSpanSeconds: null,
      message: "Transcript is empty.",
    };
  }

  // --- Check LLM Transcript ---
  const parsedLlmTimestamps = findTimestampRanges(rawTranscript);

  if (parsedLlmTimestamps.length < minTimestamps) {
    return {
      isValid: false,
      detectedLlmSpanSeconds: null,
      message: `Validation failed: Found only ${parsedLlmTimestamps.length} valid timestamp ranges in LLM output (minimum required: ${minTimestamps}).`,
    };
  }

  parsedLlmTimestamps.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const firstLlmStartTime = parsedLlmTimestamps[0].startTimeSeconds;
  const lastLlmEndTime = Math.max(
    ...parsedLlmTimestamps.map((ts) => ts.endTimeSeconds)
  );
  detectedLlmSpanSeconds = lastLlmEndTime - firstLlmStartTime;

  // 1. Check minimum duration relative to chunk duration
  const requiredMinSpanSeconds = config.chunkDuration * MIN_SPAN_COVERAGE_RATIO;
  if (detectedLlmSpanSeconds < requiredMinSpanSeconds) {
    return {
      isValid: false,
      detectedLlmSpanSeconds,
      message: `Validation failed: LLM transcript time span (${detectedLlmSpanSeconds.toFixed(
        1
      )}s) is less than minimum required (${requiredMinSpanSeconds.toFixed(
        1
      )}s, ${MIN_SPAN_COVERAGE_RATIO * 100}% of chunk duration ${
        config.chunkDuration
      }s).`,
    };
  }

  // --- Check Against Reference SRT (if provided) ---
  if (referenceSrtPath && existsSync(referenceSrtPath)) {
    const referenceEntries = await parseSrtFile(referenceSrtPath);
    if (referenceEntries && referenceEntries.length > 0) {
      referenceSrtSpanSeconds = calculateSrtTimeSpan(referenceEntries);

      if (referenceSrtSpanSeconds > 1.0) {
        const lowerBound =
          referenceSrtSpanSeconds * (1 - allowedSpanDifferenceRatio);

        // Check only if LLM span is significantly SHORTER than reference
        if (detectedLlmSpanSeconds < lowerBound) {
          isValid = false;
          // Update message to only mention lower bound
          validationMessage = `Validation failed: LLM transcript span (${detectedLlmSpanSeconds.toFixed(
            1
          )}s) is shorter than allowed lower bound (${lowerBound.toFixed(
            1
          )}s) based on reference SRT span (${referenceSrtSpanSeconds.toFixed(
            1
          )}s).`;
        } else {
          validationMessage += ` LLM span (${detectedLlmSpanSeconds.toFixed(
            1
          )}s) meets or exceeds minimum duration compared to reference span (${referenceSrtSpanSeconds.toFixed(
            1
          )}s).`;
        }
      } else {
        logger.warn(
          `[Validation] Reference SRT span (${referenceSrtSpanSeconds.toFixed(
            1
          )}s) is too short for meaningful comparison. Skipping span check.`
        );
        validationMessage += ` Reference SRT span (${referenceSrtSpanSeconds.toFixed(
          1
        )}s) too short to compare.`;
      }
    } else {
      logger.warn(
        `[Validation] Could not parse or found no entries in reference SRT: ${referenceSrtPath}. Skipping span check.`
      );
      validationMessage += ` Could not read reference SRT.`;
    }
  } else if (referenceSrtPath) {
    logger.warn(
      `[Validation] Reference SRT path provided but not found: ${referenceSrtPath}. Skipping span check.`
    );
    validationMessage += ` Reference SRT not found.`;
  } else {
    validationMessage += ` No reference SRT provided for comparison.`;
  }

  return {
    isValid,
    detectedLlmSpanSeconds,
    referenceSrtSpanSeconds,
    message: validationMessage,
  };
}

/**
 * Adjusts timestamps in a raw transcript string using a time offset.
 * Replaces relative `mm:ss - mm:ss` timestamps with absolute `HH:MM:SS,sss` timestamps.
 * Lines without valid timestamps are kept as is.
 *
 * @param rawTranscript The raw transcript text from the LLM.
 * @param offsetSeconds The starting time offset (in seconds) for this chunk.
 * @returns The transcript text with adjusted absolute timestamps.
 */
export function adjustTranscriptTimestamps(
  rawTranscript: string,
  offsetSeconds: number
): string {
  const lines = rawTranscript.split("\n");
  const adjustedLines: string[] = [];

  // Regex to find "mm:ss - mm:ss" pattern, potentially with surrounding chars
  const timeRangeRegex = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

  for (const line of lines) {
    const match = line.match(timeRangeRegex);

    if (match) {
      const startTimeStr = match[1];
      const endTimeStr = match[2];
      const startTimeRelativeSeconds = parseMmSs(startTimeStr);
      const endTimeRelativeSeconds = parseMmSs(endTimeStr);

      if (
        startTimeRelativeSeconds !== null &&
        endTimeRelativeSeconds !== null &&
        startTimeRelativeSeconds <= endTimeRelativeSeconds
      ) {
        const adjustedStartTime = startTimeRelativeSeconds + offsetSeconds;
        const adjustedEndTime = endTimeRelativeSeconds + offsetSeconds;

        // Format using the HH:MM:SS,sss utility
        const formattedStartTime = secondsToTimestamp(adjustedStartTime);
        const formattedEndTime = secondsToTimestamp(adjustedEndTime);

        // Replace the original timestamp part with the new absolute one
        const newLine = line.replace(
          match[0],
          `${formattedStartTime} --> ${formattedEndTime}`
        );
        adjustedLines.push(newLine);
      } else {
        // Keep line as is if mm:ss parsing failed within the regex match
        adjustedLines.push(line);
      }
    } else {
      // Keep lines without the timestamp pattern as they are
      adjustedLines.push(line);
    }
  }

  return adjustedLines.join("\n");
}
