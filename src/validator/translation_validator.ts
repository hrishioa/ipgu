import { existsSync } from "fs";
import * as logger from "../utils/logger.js";
import { parseSrtFile } from "../utils/srt_utils.js";
import type {
  ParsedTranslationEntry,
  ProcessingIssue,
  SrtEntry,
  Config,
} from "../types.js";

// --- Configuration Constants ---
const MAX_ERROR_RATE = 0.05; // Allow max 5% parsing errors relative to reference count
const MIN_COUNT_MATCH_RATE = 0.9; // Require at least 90% of reference subtitles to be parsed
const MIN_ID_COVERAGE_RATE = 0.9; // Require at least 90% of reference IDs to be present
const MAX_TIMING_MISMATCH_RATE = 0.1; // Allow max 10% of entries to have timing issues
const TIMING_DIFF_MARGIN_RATIO = 0.1; // Allow 10% difference relative to SRT duration
const TIMING_DIFF_ABS_MARGIN_S = 0.5; // Allow absolute difference of 0.5 seconds

interface ValidationResult {
  isValid: boolean; // True only if NO 'error' severity validation issues occurred
  validationIssues: ProcessingIssue[]; // Issues *added* by this function
}

/**
 * Validates parsed translation entries against criteria and a reference SRT.
 *
 * @param chunkPart The part number for context.
 * @param parsedEntries The array of parsed entries from the parser module.
 * @param parsingIssues The array of issues generated during the parsing stage.
 * @param referenceSrtPath Path to the corresponding reference SRT chunk.
 * @param config Configuration object containing disableTimingValidation flag
 * @param isLastChunk Flag indicating if this is the last chunk
 * @param isFinalAttempt Flag indicating if this is the final attempt
 * @returns A ValidationResult object.
 */
export async function validateTranslations(
  chunkPart: number,
  parsedEntries: ParsedTranslationEntry[],
  parsingIssues: ProcessingIssue[], // Issues from the parsing step
  referenceSrtPath?: string,
  config?: Pick<Config, "disableTimingValidation" | "chunkDuration">, // Keep config for flags/duration
  isLastChunk: boolean = false, // New flag
  isFinalAttempt: boolean = false // New flag
): Promise<ValidationResult> {
  const validationIssues: ProcessingIssue[] = []; // Issues *added* by this function
  let foundError = false; // Track if any validation check fails critically

  // --- Reference SRT Loading ---
  let referenceSrtEntries: SrtEntry[] | null = null;
  let referenceSrtCount = 0;
  if (referenceSrtPath && existsSync(referenceSrtPath)) {
    referenceSrtEntries = await parseSrtFile(referenceSrtPath);
    if (referenceSrtEntries) {
      referenceSrtCount = referenceSrtEntries.length;
      logger.debug(
        `[Chunk ${chunkPart} Validation] Loaded ${referenceSrtCount} reference SRT entries.`
      );
    } else {
      validationIssues.push({
        type: "ValidationError",
        severity: "warning",
        chunkPart,
        message: `Could not parse reference SRT file: ${referenceSrtPath}`,
      });
    }
  } else {
    validationIssues.push({
      type: "ValidationError",
      severity: "warning",
      chunkPart,
      message: `Reference SRT file not found or path not provided: ${referenceSrtPath}. Some validation checks skipped.`,
    });
  }

  const parsedCount = parsedEntries.length;

  // --- Check 1: Parsing Error Rate ---
  const parsingErrorCount = parsingIssues.filter(
    (p) => p.severity === "error"
  ).length;
  const baseCountForErrorRate =
    referenceSrtCount > 0
      ? referenceSrtCount
      : parsedCount > 0
      ? parsedCount
      : 1;
  const errorRate = parsingErrorCount / baseCountForErrorRate;

  if (errorRate > MAX_ERROR_RATE) {
    foundError = true; // Critical failure
    validationIssues.push({
      type: "ValidationError",
      severity: "error",
      chunkPart,
      message: `High parsing error rate: ${parsingErrorCount}/${baseCountForErrorRate} (${(
        errorRate * 100
      ).toFixed(1)}%) exceeds threshold of ${(MAX_ERROR_RATE * 100).toFixed(
        1
      )}%.`,
    });
  }

  // --- Checks Requiring Reference SRT ---
  if (referenceSrtEntries && referenceSrtCount > 0) {
    // --- Check 2: Count Match Rate ---
    const countMatchRate = parsedCount / referenceSrtCount;
    if (countMatchRate < MIN_COUNT_MATCH_RATE) {
      foundError = true; // Critical failure
      validationIssues.push({
        type: "ValidationError",
        severity: "error",
        chunkPart,
        message: `Low subtitle count match: Parsed ${parsedCount} entries, expected ~${referenceSrtCount} (${(
          countMatchRate * 100
        ).toFixed(1)}% found, required ${(MIN_COUNT_MATCH_RATE * 100).toFixed(
          1
        )}%).`,
      });
    }

    // --- Check 3: ID Coverage ---
    const referenceIds = new Set(
      referenceSrtEntries.map((e) => e.id.toString())
    );
    const parsedIds = new Set(parsedEntries.map((e) => e.originalId));
    let missingIds = 0;
    const missingIdList: string[] = [];
    referenceIds.forEach((refId) => {
      if (!parsedIds.has(refId)) {
        missingIds++;
        if (missingIdList.length < 10) missingIdList.push(refId); // Keep list short
      }
    });
    const idCoverageRate = 1 - missingIds / referenceSrtCount;
    if (idCoverageRate < MIN_ID_COVERAGE_RATE) {
      foundError = true; // Critical failure
      validationIssues.push({
        type: "ValidationError",
        severity: "error",
        chunkPart,
        message: `Low ID coverage: Found ${
          parsedIds.size
        } unique IDs covering only ${(idCoverageRate * 100).toFixed(
          1
        )}% of ${referenceSrtCount} reference IDs (required ${(
          MIN_ID_COVERAGE_RATE * 100
        ).toFixed(1)}%). Missing ${missingIds} IDs (e.g., ${missingIdList.join(
          ", "
        )}${missingIds > 10 ? "..." : ""}).`,
      });
    }

    // --- Check 4: Timing Consistency (Conditional) ---
    if (!config?.disableTimingValidation) {
      logger.debug(
        `[Chunk ${chunkPart} Validation] Running timing consistency check...`
      );
      let timingMismatches = 0;
      let entriesComparedForTiming = 0;
      const mismatchList: string[] = [];
      let loggedMismatchCount = 0;
      const MAX_MISMATCH_LOGS = 15;
      const referenceMap = new Map(
        referenceSrtEntries.map((e) => [e.id.toString(), e])
      );
      const FIXED_TIMING_MARGIN_S = 3.0;

      parsedEntries.forEach((parsed) => {
        if (
          parsed.parsedStartTimeSeconds !== undefined &&
          parsed.parsedEndTimeSeconds !== undefined
        ) {
          const refEntry = referenceMap.get(parsed.originalId);
          if (refEntry) {
            entriesComparedForTiming++;
            const refDuration =
              refEntry.endTimeSeconds - refEntry.startTimeSeconds;
            const parsedDuration =
              parsed.parsedEndTimeSeconds - parsed.parsedStartTimeSeconds;
            const durationDiff = Math.abs(parsedDuration - refDuration);
            const startDiff = Math.abs(
              parsed.parsedStartTimeSeconds - refEntry.startTimeSeconds
            );

            if (
              durationDiff > FIXED_TIMING_MARGIN_S ||
              startDiff > FIXED_TIMING_MARGIN_S
            ) {
              timingMismatches++;
              const mismatchDetail = `ID ${
                parsed.originalId
              }: StartDiff=${startDiff.toFixed(
                2
              )}s, DurDiff=${durationDiff.toFixed(
                2
              )}s (Margin: ${FIXED_TIMING_MARGIN_S.toFixed(1)}s)`;
              if (mismatchList.length < 5) mismatchList.push(mismatchDetail);

              if (loggedMismatchCount < MAX_MISMATCH_LOGS) {
                logger.debug(
                  `[Chunk ${chunkPart} Validation] Timing mismatch detail: ${mismatchDetail} | Parsed: ${parsed.parsedStartTimeSeconds.toFixed(
                    3
                  )} -> ${parsed.parsedEndTimeSeconds.toFixed(
                    3
                  )} (${parsedDuration.toFixed(
                    2
                  )}s) | Ref: ${refEntry.startTimeSeconds.toFixed(
                    3
                  )} -> ${refEntry.endTimeSeconds.toFixed(
                    3
                  )} (${refDuration.toFixed(2)}s)`
                );
                loggedMismatchCount++;
              }

              validationIssues.push({
                type: "ValidationError",
                severity: "warning",
                chunkPart,
                subtitleId: parsed.originalId,
                message: `Timing mismatch: ${mismatchDetail}`,
              });
            }
          }
        }
      });

      if (entriesComparedForTiming > 0) {
        const mismatchRate = timingMismatches / entriesComparedForTiming;
        if (mismatchRate > MAX_TIMING_MISMATCH_RATE) {
          // --- Leniency for Last Chunk, Final Attempt ---
          const ignoreTimingError = isLastChunk && isFinalAttempt;
          if (!ignoreTimingError) {
            foundError = true; // Critical failure *unless* it's last chunk/final attempt
          }
          // --- End Leniency ---

          // Log the error regardless, but severity might be overridden by leniency
          const severity = ignoreTimingError ? "warning" : "error";
          validationIssues.push({
            type: "ValidationError",
            severity: severity, // Log as error normally, but warning if leniency applied
            chunkPart,
            message: `High timing mismatch rate: ${timingMismatches}/${entriesComparedForTiming} (${(
              mismatchRate * 100
            ).toFixed(
              1
            )}%) entries exceed fixed timing threshold (${FIXED_TIMING_MARGIN_S.toFixed(
              1
            )}s). Examples: ${mismatchList.join("; ")}${
              timingMismatches > 5 ? "..." : ""
            }`,
          });

          // Add specific log message if error was ignored
          if (ignoreTimingError) {
            logger.warn(
              `[Chunk ${chunkPart} Validation] High timing mismatch rate detected, but IGNORING for final validation decision (Last Chunk & Final Attempt).`
            );
          }
        }
      } else if (parsedEntries.some((p) => p.originalTiming)) {
        validationIssues.push({
          type: "ValidationError",
          severity: "warning",
          chunkPart,
          message: `Could not compare timing for any entries (missing parsed times, or missing reference matches).`,
        });
      }
    } else {
      logger.debug(
        `[Chunk ${chunkPart} Validation] Skipping timing consistency check due to config flag.`
      );
    }
  } // End of checks requiring reference SRT

  // --- Final Decision ---
  const isValid = !foundError; // isValid is now true if only ignored timing errors occurred
  if (isValid) {
    if (validationIssues.length > 0) {
      // Passed validation, but had warnings
      logger.debug(
        `[Chunk ${chunkPart} Validation] Passed with warnings. Issues: ${validationIssues
          .map((i) => i.type)
          .join(", ")}`
      );
    } else {
      // Passed validation clean
      logger.debug(`[Chunk ${chunkPart} Validation] All checks passed.`);
    }
  } else {
    // Failed validation due to at least one error
    const errorTypes = validationIssues
      .filter((i) => i.severity === "error")
      .map((i) => i.type)
      .join(", ");
    logger.warn(
      `[Chunk ${chunkPart} Validation] Failed. Critical Error(s): ${errorTypes}. Total Issues: ${validationIssues.length}`
    );
  }

  return { isValid, validationIssues };
}
