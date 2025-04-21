/**
 * Time utilities for handling timestamps and durations
 */

/**
 * Converts seconds to a timestamp string in format HH:MM:SS,mmm
 * @param seconds Total seconds (can include fractional seconds)
 * @returns Formatted timestamp string
 */
export function secondsToTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${secs.toString().padStart(2, "0")},${ms
    .toString()
    .padStart(3, "0")}`;
}

/**
 * Converts a timestamp string in format HH:MM:SS,mmm to seconds
 * @param timestamp Timestamp string (supports both comma and period as decimal separator)
 * @returns Total seconds as a number
 */
export function timestampToSeconds(timestamp: string): number {
  // Handle formats like 00:14:58,840 or 00:14:58.840
  const timeStr = timestamp.replace(",", ".");
  const [timeWithoutMs, ms] = timeStr.split(".");
  const [hours, minutes, seconds] = timeWithoutMs.split(":").map(Number);

  return hours * 3600 + minutes * 60 + seconds + (ms ? Number(`0.${ms}`) : 0);
}

/**
 * Parse SRT timestamp line (start --> end) to extract start and end times in seconds
 * @param timingString SRT timing line (e.g., "00:01:23,456 --> 00:01:45,678")
 * @returns Object with start and end times in seconds, or null if parsing fails
 */
export function parseSrtTiming(
  timingString: string
): { startTimeSeconds: number; endTimeSeconds: number } | null {
  const parts = timingString.split(" --> ");
  if (parts.length !== 2) {
    return null;
  }

  return {
    startTimeSeconds: timestampToSeconds(parts[0]),
    endTimeSeconds: timestampToSeconds(parts[1]),
  };
}

/**
 * Format a start and end time in seconds to a SRT timing line
 * @param startTimeSeconds Start time in seconds
 * @param endTimeSeconds End time in seconds
 * @returns SRT timing line (e.g., "00:01:23,456 --> 00:01:45,678")
 */
export function formatSrtTiming(
  startTimeSeconds: number,
  endTimeSeconds: number
): string {
  return `${secondsToTimestamp(startTimeSeconds)} --> ${secondsToTimestamp(
    endTimeSeconds
  )}`;
}

/** Type definition for the result of calculateChunks */
export interface TimeChunk {
  startTimeSeconds: number;
  endTimeSeconds: number;
  partNumber: number;
}

/**
 * Calculate chunk time ranges based on total duration, chunk size, and overlap
 * @param totalDurationSeconds Total duration of the media in seconds
 * @param chunkDurationSeconds Duration of each chunk in seconds
 * @param overlapSeconds Overlap between chunks in seconds
 * @returns Array of TimeChunk objects
 */
export function calculateChunks(
  totalDurationSeconds: number,
  chunkDurationSeconds: number,
  overlapSeconds: number
): TimeChunk[] {
  const chunks: TimeChunk[] = [];
  let startTime = 0;
  let partNumber = 1;

  while (startTime < totalDurationSeconds) {
    let endTime = Math.min(
      startTime + chunkDurationSeconds,
      totalDurationSeconds
    );

    // If this is the last chunk and it's too short, merge with previous chunk
    if (
      endTime === totalDurationSeconds &&
      endTime - startTime < chunkDurationSeconds / 3
    ) {
      if (chunks.length > 0) {
        // Update the end time of the last chunk to include this small remainder
        chunks[chunks.length - 1].endTimeSeconds = endTime;
        break;
      }
    }

    chunks.push({
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      partNumber,
    });

    // Move to next chunk with overlap
    startTime = endTime - overlapSeconds;
    partNumber++;
  }

  return chunks;
}
