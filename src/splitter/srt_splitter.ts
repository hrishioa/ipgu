import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import type { ChunkInfo, ProcessingIssue, SrtEntry } from "../types";
import { parseSrtTiming, formatSrtTiming } from "../utils/time_utils";
import { ensureDir } from "../utils/file_utils";
import * as logger from "../utils/logger";

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
    const blocks = cleanContent
      .split(/\r?\n\r?\n/)
      .filter((block) => block.trim().length > 0);
    const entries: SrtEntry[] = [];

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);

      // At minimum, we need 3 lines: subtitle number, timing, and text
      if (lines.length < 3) {
        logger.warn(`Malformed SRT block (too few lines): ${block}`);
        continue;
      }

      // Parse subtitle number
      const id = parseInt(lines[0].trim());
      if (isNaN(id)) {
        logger.warn(`Malformed SRT block (invalid ID): ${block}`);
        continue;
      }

      // Parse timing line
      const timingString = lines[1].trim();
      const timing = parseSrtTiming(timingString);
      if (!timing) {
        logger.warn(`Malformed SRT block (invalid timing): ${block}`);
        continue;
      }

      // The rest is the subtitle text (may be multi-line)
      const text = lines.slice(2).join("\n");

      entries.push({
        id,
        timingString,
        startTimeSeconds: timing.startTimeSeconds,
        endTimeSeconds: timing.endTimeSeconds,
        text,
      });
    }

    // Sort by start time
    entries.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    logger.info(`Parsed ${entries.length} subtitles from SRT file`);
    return entries;
  } catch (error) {
    logger.error(`Failed to parse SRT file: ${error}`);
    return null;
  }
}

/**
 * Filter SRT entries for a specific chunk based on time range
 * @param entries All SRT entries
 * @param startTime Chunk start time in seconds
 * @param endTime Chunk end time in seconds
 * @param expandRange Whether to include subtitles partially overlapping with the range
 * @returns Filtered entries
 */
export function filterEntriesForChunk(
  entries: SrtEntry[],
  startTime: number,
  endTime: number,
  expandRange: boolean = true
): SrtEntry[] {
  return entries.filter((entry) => {
    // Fully contained entries
    if (
      entry.startTimeSeconds >= startTime &&
      entry.endTimeSeconds <= endTime
    ) {
      return true;
    }

    // Partially overlapping entries (if requested)
    if (expandRange) {
      // Entry starts before chunk but ends within chunk
      if (
        entry.startTimeSeconds < startTime &&
        entry.endTimeSeconds > startTime
      ) {
        return true;
      }

      // Entry starts within chunk but ends after chunk
      if (entry.startTimeSeconds < endTime && entry.endTimeSeconds > endTime) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Write filtered entries to an SRT file for a chunk
 * @param entries SRT entries to write
 * @param outputPath Output file path
 * @returns Promise resolving to true if successful
 */
export async function writeChunkSrt(
  entries: SrtEntry[],
  outputPath: string
): Promise<boolean> {
  try {
    // Format the entries as SRT content
    let content = "";
    for (const entry of entries) {
      content += `${entry.id}\n`;
      content += `${entry.timingString}\n`;
      content += `${entry.text}\n\n`;
    }

    await writeFile(outputPath, content, "utf-8");
    logger.debug(`Wrote ${entries.length} subtitles to ${outputPath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to write chunk SRT: ${error}`);
    return false;
  }
}

/**
 * Split an SRT file into chunks based on time ranges
 * @param srtPath Path to the SRT file
 * @param chunks Chunk info objects with time ranges
 * @param outputDir Directory to save chunk SRTs
 * @returns Promise resolving to updated chunks and issues
 */
export async function splitSrt(
  srtPath: string,
  chunks: ChunkInfo[],
  outputDir: string
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];

  // Parse the SRT file
  const entries = await parseSrtFile(srtPath);
  if (!entries) {
    const issue: ProcessingIssue = {
      type: "SplitError",
      severity: "error",
      message: `Failed to parse SRT file: ${srtPath}`,
    };
    issues.push(issue);
    return { chunks, issues };
  }

  // Create output directory
  if (!ensureDir(outputDir)) {
    const issue: ProcessingIssue = {
      type: "SplitError",
      severity: "error",
      message: `Failed to create output directory for SRT chunks: ${outputDir}`,
    };
    issues.push(issue);
    return { chunks, issues };
  }

  logger.info(`Splitting SRT file into ${chunks.length} chunks`);

  // Process each chunk
  for (const chunk of chunks) {
    // Skip failed chunks
    if (chunk.status === "failed") {
      continue;
    }

    // Filter entries for this chunk
    const chunkEntries = filterEntriesForChunk(
      entries,
      chunk.startTimeSeconds,
      chunk.endTimeSeconds
    );

    if (chunkEntries.length === 0) {
      logger.warn(
        `No subtitles found for chunk ${chunk.partNumber} (${chunk.startTimeSeconds}s - ${chunk.endTimeSeconds}s)`
      );
    }

    // Generate output path
    const srtChunkPath = join(
      outputDir,
      `part${chunk.partNumber.toString().padStart(2, "0")}.srt`
    );
    chunk.srtChunkPath = srtChunkPath;

    // Write chunk SRT
    const success = await writeChunkSrt(chunkEntries, srtChunkPath);
    if (!success) {
      issues.push({
        type: "SplitError",
        severity: "warning",
        message: `Failed to write SRT chunk for part ${chunk.partNumber}`,
        chunkPart: chunk.partNumber,
      });
    } else {
      logger.debug(
        `Created SRT chunk ${chunk.partNumber} with ${chunkEntries.length} subtitles`
      );
    }
  }

  logger.info(`SRT splitting complete`);
  return { chunks, issues };
}
