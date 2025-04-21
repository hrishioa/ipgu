import { readFile } from "fs/promises";
import type { SrtEntry } from "../types.js"; // Assuming SrtEntry is in types.ts
import {
  parseSrtTiming,
  formatSrtTiming,
  secondsToTimestamp,
} from "./time_utils.js"; // Assuming time utils are here
import * as logger from "./logger.js";

/**
 * Parse an SRT file into SrtEntry objects, applying an optional time offset.
 * @param filePath Path to the SRT file.
 * @param offsetSeconds Optional offset in seconds to apply to all timestamps.
 * @returns Promise resolving to an array of SrtEntry objects, or null if error.
 */
export async function parseSrtFile(
  filePath: string,
  offsetSeconds: number = 0 // Default offset to 0
): Promise<SrtEntry[] | null> {
  try {
    logger.debug(
      `Parsing SRT file: ${filePath}` +
        (offsetSeconds ? ` with offset: ${offsetSeconds}s` : "")
    );
    const content = await readFile(filePath, "utf-8");

    // Remove BOM if present
    const cleanContent =
      content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

    // Split into subtitle blocks (separated by blank lines)
    // Handles both \n and \r\n line endings more robustly
    const blocks = cleanContent
      .split(/\r?\n\r?\n/)
      .filter((block) => block.trim().length > 0);
    const entries: SrtEntry[] = [];

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);

      if (lines.length < 3) {
        logger.warn(
          `[SRT Parser] Malformed block (too few lines): ${
            block.split(/\r?\n/)[0]
          }`
        );
        continue;
      }

      const id = parseInt(lines[0].trim());
      if (isNaN(id)) {
        logger.warn(
          `[SRT Parser] Malformed block (invalid ID): ${lines[0].trim()}`
        );
        continue;
      }

      const originalTimingString = lines[1].trim();
      const timing = parseSrtTiming(originalTimingString);
      if (!timing) {
        logger.warn(
          `[SRT Parser] Malformed block (invalid timing): ${originalTimingString}`
        );
        continue;
      }

      // Apply offset
      const offsettedStartTime = timing.startTimeSeconds + offsetSeconds;
      const offsettedEndTime = timing.endTimeSeconds + offsetSeconds;

      // Skip entry if offset results in negative times
      if (offsettedStartTime < 0 || offsettedEndTime < 0) {
        logger.warn(
          `[SRT Parser] Skipping entry ID ${id} due to negative timestamp after applying offset ${offsetSeconds}s (Original: ${originalTimingString})`
        );
        continue;
      }

      // Regenerate timing string with offsetted values
      const newTimingString = formatSrtTiming(
        offsettedStartTime,
        offsettedEndTime
      );

      const text = lines.slice(2).join("\n");

      entries.push({
        id,
        timingString: newTimingString, // Store the *new* timing string
        startTimeSeconds: offsettedStartTime, // Store offsetted seconds
        endTimeSeconds: offsettedEndTime, // Store offsetted seconds
        text,
      });
    }

    // Sort by start time just in case
    entries.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    logger.debug(
      `[SRT Parser] Parsed and offsetted ${entries.length} subtitles from ${filePath}`
    );
    return entries;
  } catch (error) {
    logger.error(`[SRT Parser] Failed to parse SRT file ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Calculates the total time span covered by a list of SRT entries.
 * @param entries An array of SrtEntry objects.
 * @returns The time span in seconds, or 0 if no entries.
 */
export function calculateSrtTimeSpan(entries: SrtEntry[]): number {
  if (!entries || entries.length === 0) {
    return 0;
  }
  // Entries should already be sorted by parseSrtFile, but sort again just in case
  entries.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const firstStartTime = entries[0].startTimeSeconds;
  const lastEndTime = Math.max(...entries.map((e) => e.endTimeSeconds));
  return lastEndTime - firstStartTime;
}
