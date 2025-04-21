import { readFile } from "fs/promises";
import type { SrtEntry } from "../types"; // Assuming SrtEntry is in types.ts
import { parseSrtTiming } from "./time_utils"; // Assuming time utils are here
import * as logger from "./logger";

/**
 * Parse an SRT file into SrtEntry objects
 * @param filePath Path to the SRT file
 * @returns Promise resolving to an array of SrtEntry objects, or null if error
 */
export async function parseSrtFile(
  filePath: string
): Promise<SrtEntry[] | null> {
  try {
    logger.debug(`Parsing SRT file: ${filePath}`);
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

      const timingString = lines[1].trim();
      const timing = parseSrtTiming(timingString);
      if (!timing) {
        logger.warn(
          `[SRT Parser] Malformed block (invalid timing): ${timingString}`
        );
        continue;
      }

      const text = lines.slice(2).join("\n");

      entries.push({
        id,
        timingString,
        startTimeSeconds: timing.startTimeSeconds,
        endTimeSeconds: timing.endTimeSeconds,
        text,
      });
    }

    // Sort by start time just in case
    entries.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    logger.debug(
      `[SRT Parser] Parsed ${entries.length} subtitles from ${filePath}`
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
