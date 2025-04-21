import { join, basename } from "path";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { ChunkInfo, ProcessingIssue, SrtEntry } from "../types.js";
import { parseSrtTiming, formatSrtTiming } from "../utils/time_utils.js";
import { ensureDir } from "../utils/file_utils.js";
import * as logger from "../utils/logger.js";
import { parseSrtFile } from "../utils/srt_utils.js";

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
 * Write filtered entries to an SRT file for a chunk, optionally skipping if exists.
 * @param entries SRT entries to write
 * @param outputPath Output file path
 * @param force Whether to force writing even if file exists
 * @returns Promise resolving to true if successful
 */
export async function writeChunkSrt(
  entries: SrtEntry[],
  outputPath: string,
  force: boolean
): Promise<boolean> {
  // Skip if file exists and not forcing
  if (!force && existsSync(outputPath)) {
    logger.debug(
      `SRT chunk ${basename(outputPath)} already exists. Skipping write.`
    );
    return true; // Treat as success if skipped
  }

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
 * @param force Whether to force writing even if file exists
 * @param inputOffsetSeconds Input offset in seconds
 * @returns Promise resolving to updated chunks and issues
 */
export async function splitSrt(
  srtPath: string,
  chunks: ChunkInfo[],
  outputDir: string,
  force: boolean,
  inputOffsetSeconds: number = 0
): Promise<{ chunks: ChunkInfo[]; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];

  // Parse the SRT file, applying the offset
  const entries = await parseSrtFile(srtPath, inputOffsetSeconds);
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

  logger.info(
    `Splitting SRT file into ${chunks.length} chunks (Force: ${force}, Input Offset: ${inputOffsetSeconds}s)`
  );

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

    // Pass force flag to write function
    const success = await writeChunkSrt(chunkEntries, srtChunkPath, force);
    if (!success) {
      issues.push({
        type: "SplitError",
        severity: "warning",
        message: `Failed to write SRT chunk for part ${chunk.partNumber}`,
        chunkPart: chunk.partNumber,
      });
    }
  }

  logger.info(`SRT splitting complete`);
  return { chunks, issues };
}
