#!/usr/bin/env bun

import { Command } from "commander";
import { readdir } from "fs/promises";
import { join, parse as parsePath } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import boxen from "boxen";
import type {
  ChunkInfo,
  Config,
  ProcessingIssue,
  ParsedTranslationEntry,
  SrtEntry,
  FinalSubtitleEntry,
} from "../types.js";
import * as logger from "../utils/logger.js";
import {
  ensureDir,
  writeToFile,
  readJsonFromFile,
} from "../utils/file_utils.js";
import { parseSrtFile } from "../utils/srt_utils.js";
import { formatSrtEntry } from "./srt_formatter.js";

// --- Constants ---
const MIN_SUB_DURATION = 0.5;
const MAX_SUB_DURATION = 7.0;
const OVERLAP_GAP_S = 0.05; // 50ms
const SKIP_MARKER = "[SKIP THIS SUBTITLE]";

// --- Helper Functions ---

/** Loads all parsed data JSON files from the intermediate directory. */
async function loadParsedData(
  parsedDataDir: string,
  expectedChunkCount: number
): Promise<ParsedTranslationEntry[]> {
  let allParsed: ParsedTranslationEntry[] = [];
  logger.info(`Loading parsed data from: ${parsedDataDir}`);
  if (!existsSync(parsedDataDir)) {
    logger.warn(`Parsed data directory not found: ${parsedDataDir}`);
    return [];
  }
  const files = await readdir(parsedDataDir);
  const jsonFiles = files.filter(
    (f) => f.startsWith("part") && f.endsWith("_parsed.json")
  );

  if (jsonFiles.length < expectedChunkCount) {
    logger.warn(
      `Expected ${expectedChunkCount} parsed files, but found ${jsonFiles.length}. Final output might be incomplete.`
    );
  }
  if (jsonFiles.length === 0) {
    logger.error(
      `No parsed data files found in ${parsedDataDir}. Cannot generate final subtitles.`
    );
    return [];
  }

  for (const file of jsonFiles) {
    const filePath = join(parsedDataDir, file);
    const data = await readJsonFromFile<ParsedTranslationEntry[]>(filePath);
    if (data) {
      allParsed = allParsed.concat(data);
    } else {
      logger.warn(`Failed to load or parse data from ${file}.`);
    }
  }
  logger.info(
    `Loaded ${allParsed.length} parsed entries from ${jsonFiles.length} files.`
  );
  return allParsed;
}

/** Merges translations, selects timing, handles chunk overlaps and fallbacks. */
async function mergeTranslations(
  allParsedEntries: ParsedTranslationEntry[],
  originalSrtPath: string | undefined,
  config: Pick<
    Config,
    "useResponseTimings" | "targetLanguages" | "inputOffsetSeconds"
  >
): Promise<{
  mergedEntries: Omit<FinalSubtitleEntry, "finalId">[];
  issues: ProcessingIssue[];
}> {
  const issues: ProcessingIssue[] = [];
  const translationsById = new Map<string, ParsedTranslationEntry>();

  // Resolve chunk overlaps - keep entry from the latest chunk
  allParsedEntries.forEach((entry) => {
    const existing = translationsById.get(entry.originalId);
    if (!existing || entry.sourceChunk >= existing.sourceChunk) {
      translationsById.set(entry.originalId, entry);
    }
  });
  logger.debug(
    `Resolved chunk overlaps. Kept ${translationsById.size} unique entries.`
  );

  // Load original SRT, passing the input offset
  let originalSrtMap: Map<string, SrtEntry> | null = null;
  const inputOffset = config.inputOffsetSeconds ?? 0;
  if (originalSrtPath && existsSync(originalSrtPath)) {
    // Pass offset to parser
    const srtEntries = await parseSrtFile(originalSrtPath, inputOffset);
    if (srtEntries) {
      originalSrtMap = new Map(srtEntries.map((e) => [e.id.toString(), e]));
      logger.debug(
        `Loaded ${originalSrtMap.size} original SRT entries (offset: ${inputOffset}s).`
      );
    } else {
      logger.warn(`Failed to parse original SRT: ${originalSrtPath}`);
      // Don't push issue here, handled below if needed
    }
  }
  if (!originalSrtMap) {
    logger.warn(
      "Original SRT not found or unreadable. Fallback timing/text unavailable."
    );
    if (!config.useResponseTimings) {
      logger.error(
        "Original SRT timings requested but file unavailable! Cannot proceed."
      );
      issues.push({
        type: "MergeError",
        severity: "error",
        message: "Original SRT required for timing but not found/readable.",
      });
      return { mergedEntries: [], issues };
    }
  }

  const mergedEntries: Omit<FinalSubtitleEntry, "finalId">[] = [];
  const targetLanguage = config.targetLanguages[0]; // Assume single target language

  for (const entry of translationsById.values()) {
    let startTime: number | undefined = undefined;
    let endTime: number | undefined = undefined;
    let timingSource: FinalSubtitleEntry["timingSource"] = "llm";
    let isFallback = false;

    // Filter based on skip marker
    if (
      entry.translations["english"] === SKIP_MARKER ||
      entry.translations[targetLanguage] === SKIP_MARKER
    ) {
      logger.debug(`Skipping entry ID ${entry.originalId} due to SKIP_MARKER.`);
      continue;
    }

    // Determine timing source
    if (
      config.useResponseTimings &&
      entry.parsedStartTimeSeconds !== undefined &&
      entry.parsedEndTimeSeconds !== undefined
    ) {
      startTime = entry.parsedStartTimeSeconds;
      endTime = entry.parsedEndTimeSeconds;
      timingSource = "llm";
    } else {
      const originalSrtEntry = originalSrtMap?.get(entry.originalId);
      if (originalSrtEntry) {
        startTime = originalSrtEntry.startTimeSeconds;
        endTime = originalSrtEntry.endTimeSeconds;
        timingSource = "original";
      } else {
        // If original timing requested but not found, OR response timing requested but invalid/missing
        if (!config.useResponseTimings) {
          issues.push({
            type: "MergeError",
            severity: "warning",
            subtitleId: entry.originalId,
            message: `Original SRT timing requested but entry ID not found in original SRT. Skipping entry.`,
          });
          continue; // Skip if timing is missing and was required
        } else {
          // Attempt to use LLM timing even if invalid? No, skip if no valid timing source found.
          issues.push({
            type: "MergeError",
            severity: "warning",
            subtitleId: entry.originalId,
            message: `LLM timing requested but entry had no valid timing. Original SRT entry also missing. Skipping entry.`,
          });
          continue;
        }
      }
    }

    // Determine fallback status
    const originalSrtEntry = originalSrtMap?.get(entry.originalId);
    isFallback = !entry.translations["english"] && !!originalSrtEntry?.text;
    const finalTranslations = { ...entry.translations };
    if (isFallback && originalSrtEntry) {
      finalTranslations["english"] = originalSrtEntry.text; // Use original text for fallback
    }

    mergedEntries.push({
      originalId: entry.originalId,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      translations: finalTranslations,
      isFallback,
      timingSource,
    });
  }

  logger.info(`Merged ${mergedEntries.length} entries.`);
  return { mergedEntries, issues };
}

/** Fixes overlaps and clamps durations */
function fixAndClampTimings(
  entries: Omit<FinalSubtitleEntry, "finalId">[]
): Omit<FinalSubtitleEntry, "finalId">[] {
  if (entries.length === 0) return [];

  logger.debug("Sorting entries by start time for overlap check...");
  entries.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  let changed = true;
  let pass = 0;
  const MAX_PASSES = 10; // Safety break for infinite loops
  logger.info("Starting overlap correction pass...");

  while (changed && pass < MAX_PASSES) {
    changed = false;
    pass++;
    logger.debug(`Overlap correction pass ${pass}...`);
    let overlapsFixedThisPass = 0;

    for (let i = 0; i < entries.length - 1; i++) {
      const current = entries[i];
      const next = entries[i + 1];

      if (current.endTimeSeconds > next.startTimeSeconds) {
        // overlap = current end - next start
        const overlapDuration = current.endTimeSeconds - next.startTimeSeconds;
        // Calculate potential new end time by shortening current
        const targetEndTime = next.startTimeSeconds - OVERLAP_GAP_S;
        // Calculate potential new duration if shortened
        const newDuration = targetEndTime - current.startTimeSeconds;

        // Logic from user: newEndTime = min(current.startTime + maxDuration, next.startTime - gap)
        const maxEndTimeFromDuration =
          current.startTimeSeconds + MAX_SUB_DURATION;
        const potentialNewEndTime = Math.min(
          maxEndTimeFromDuration,
          targetEndTime
        );

        // Check if new end time respects minimum duration
        if (
          potentialNewEndTime - current.startTimeSeconds >=
          MIN_SUB_DURATION
        ) {
          if (current.endTimeSeconds !== potentialNewEndTime) {
            // Only log if change occurs
            logger.debug(
              `  Fixing overlap: ID ${
                current.originalId
              } (${current.endTimeSeconds.toFixed(
                3
              )}s) adjusted to ${potentialNewEndTime.toFixed(3)}s (before ID ${
                next.originalId
              } starting at ${next.startTimeSeconds.toFixed(3)}s).`
            );
            current.endTimeSeconds = potentialNewEndTime;
            changed = true;
            overlapsFixedThisPass++;
          }
        } else {
          // Cannot shorten current, log a warning
          logger.warn(
            `  Overlap detected: ID ${
              current.originalId
            } (${current.endTimeSeconds.toFixed(3)}s) overlaps ID ${
              next.originalId
            } (${next.startTimeSeconds.toFixed(
              3
            )}s) by ${overlapDuration.toFixed(3)}s. Cannot shorten ID ${
              current.originalId
            } without violating min duration (${MIN_SUB_DURATION}s). Leaving overlap.`
          );
          // Consider alternative strategies like shifting next subtitle if this becomes a major issue
        }
      }
    }
    logger.debug(`Pass ${pass} fixed ${overlapsFixedThisPass} overlaps.`);
  }
  if (pass >= MAX_PASSES) {
    logger.warn(
      "Reached maximum overlap correction passes. Some overlaps might remain."
    );
  }
  logger.info(`Overlap correction finished after ${pass} passes.`);

  // --- Duration Clamping ---
  logger.info("Clamping subtitle durations...");
  let clampedShort = 0;
  let clampedLong = 0;
  for (const entry of entries) {
    const duration = entry.endTimeSeconds - entry.startTimeSeconds;
    let changed = false;
    if (duration < MIN_SUB_DURATION) {
      entry.endTimeSeconds = entry.startTimeSeconds + MIN_SUB_DURATION;
      clampedShort++;
      changed = true;
    } else if (duration > MAX_SUB_DURATION) {
      entry.endTimeSeconds = entry.startTimeSeconds + MAX_SUB_DURATION;
      clampedLong++;
      changed = true;
    }
    // Note: Clamping might re-introduce overlaps. A final overlap check pass could be added if needed.
    if (changed && clampedShort + clampedLong < 10) {
      // Log first few clamps
      logger.debug(
        `  Clamped ID ${entry.originalId}: New duration ${(
          entry.endTimeSeconds - entry.startTimeSeconds
        ).toFixed(3)}s`
      );
    }
  }
  logger.info(
    `Duration clamping: Fixed ${clampedShort} too short, ${clampedLong} too long.`
  );

  // Re-sort by original ID for final output sequence
  logger.debug("Sorting entries by original ID...");
  entries.sort((a, b) => {
    const numA = parseInt(a.originalId, 10);
    const numB = parseInt(b.originalId, 10);
    if (isNaN(numA)) return 1;
    if (isNaN(numB)) return -1;
    return numA - numB;
  });

  return entries;
}

/**
 * Main finalizer function for the pipeline.
 */
export async function finalize(
  chunks: ChunkInfo[],
  config: Config
): Promise<{ finalSrtPath?: string; issues: ProcessingIssue[] }> {
  const issues: ProcessingIssue[] = [];
  const parsedDataDir = join(config.intermediateDir, "parsed_data");
  const finalOutputDir = config.outputDir;
  ensureDir(finalOutputDir);

  // TODO: Add checkChunkContinuity logic here if needed
  const totalChunks = Math.max(...chunks.map((c) => c.partNumber)); // Rough estimate

  // Load all parsed data
  const allParsedEntries = await loadParsedData(parsedDataDir, totalChunks);
  if (allParsedEntries.length === 0) {
    issues.push({
      type: "MergeError",
      severity: "error",
      message: "No parsed data found to generate final SRT.",
    });
    return { issues };
  }

  // Merge translations and select timings
  const mergeResult = await mergeTranslations(
    allParsedEntries,
    config.srtPath,
    config
  );
  issues.push(...mergeResult.issues);
  if (
    mergeResult.mergedEntries.length === 0 &&
    issues.some((i) => i.severity === "error")
  ) {
    logger.error("Failed to merge any entries due to errors.");
    return { issues }; // Return early if merge failed critically
  }
  let finalSubtitleData = mergeResult.mergedEntries;

  // Fix overlaps and clamp durations
  finalSubtitleData = fixAndClampTimings(finalSubtitleData);

  // Generate final SRT content
  logger.info("Generating final SRT string...");
  let srtContent = "";
  const targetLanguage = config.targetLanguages[0]; // Assume single target
  const outputOffset = config.outputOffsetSeconds ?? 0; // Get offset or default to 0

  if (outputOffset !== 0) {
    logger.info(`Applying output offset of ${outputOffset} seconds.`);
  }

  finalSubtitleData.forEach((entry, index) => {
    // Apply offset before formatting
    const finalStartTime = entry.startTimeSeconds + outputOffset;
    const finalEndTime = entry.endTimeSeconds + outputOffset;

    // Prevent negative timestamps after offset
    if (finalStartTime < 0 || finalEndTime < 0) {
      logger.warn(
        `[ID ${entry.originalId}] Skipping entry due to negative timestamp after applying offset ${outputOffset}s.`
      );
      return; // Skip this entry
    }

    const finalEntry: FinalSubtitleEntry = {
      ...entry,
      finalId: index + 1, // Renumber sequentially
      markFallback: config.markFallbacks,
      // Use the offset-adjusted times
      startTimeSeconds: finalStartTime,
      endTimeSeconds: finalEndTime,
    };
    srtContent += formatSrtEntry(finalEntry, targetLanguage, config);
  });

  // Determine final filename
  const baseName = config.videoPath
    ? parsePath(config.videoPath).name
    : "output";
  const langSuffix = targetLanguage.toLowerCase();
  const finalSrtFilename = `${baseName}.bilingual.${langSuffix}.srt`;
  const finalSrtPath = join(finalOutputDir, finalSrtFilename);

  // Write final file
  const writeSuccess = await writeToFile(finalSrtPath, srtContent);
  if (writeSuccess) {
    logger.success(`Final bilingual SRT saved to: ${finalSrtPath}`);
    return { finalSrtPath, issues };
  } else {
    issues.push({
      type: "FormatError",
      severity: "error",
      message: `Failed to write final SRT file to ${finalSrtPath}`,
    });
    return { issues };
  }
}

// --- CLI Logic ---

interface FinalizerCliOptions {
  intermediateDir: string;
  originalSrt: string;
  outputDir: string;
  outputFilename?: string;
  targetLanguage: string; // Single target language
  useResponseTimings?: boolean;
  markFallbacks?: boolean;
  logLevel?: string;
  outputOffset?: number;
  inputOffset?: number;
}

async function cliMain() {
  const program = new Command();
  program
    .name("subtitle-finalizer")
    .description(
      "Merges parsed translations, fixes timings, and formats final bilingual SRT."
    )
    .requiredOption(
      "-i, --intermediate-dir <path>",
      "Path to the intermediate directory containing parsed_data/"
    )
    .requiredOption(
      "-s, --original-srt <path>",
      "Path to the original full SRT file"
    )
    .option(
      "-o, --output-dir <path>",
      "Directory for final output SRT",
      "./output"
    )
    .option(
      "-f, --output-filename <name>",
      "Filename for the final SRT (defaults based on video name)"
    )
    .requiredOption(
      "-l, --language <lang>",
      "The target language used in translations (e.g., Korean)"
    )
    .option(
      "--use-response-timings",
      "Use timings parsed from LLM response instead of original SRT",
      false
    )
    .option(
      "--mark-fallbacks",
      "Add [Original] marker to fallback subtitles",
      true
    )
    .option("--log-file <path>", "Path to log file")
    .option("--log-level <level>", "Log level", "info")
    .option(
      "--output-offset <seconds>",
      "Add offset (in seconds, can be negative) to final subtitle timings"
    )
    .option(
      "--input-offset <seconds>",
      "Apply offset (in seconds, can be negative) to input SRT timings"
    )
    .parse(process.argv);

  const opts = program.opts();
  logger.configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    minLogLevel: opts.logLevel || "info",
  });

  // Parse colors
  let engColor: string | undefined;
  let tgtColor: string | undefined;
  if (opts.colors) {
    [engColor, tgtColor] = opts.colors.split(",").map((c: string) => c.trim());
  }

  const cliOptions: FinalizerCliOptions = {
    intermediateDir: opts.intermediateDir,
    originalSrt: opts.originalSrt,
    outputDir: opts.outputDir,
    outputFilename: opts.outputFilename,
    targetLanguage: opts.language.trim(),
    useResponseTimings: opts.useResponseTimings || false,
    markFallbacks: opts.markFallbacks !== undefined ? opts.markFallbacks : true,
    logLevel: opts.logLevel,
    outputOffset: opts.outputOffset ? parseFloat(opts.outputOffset) : undefined,
    inputOffset: opts.inputOffset ? parseFloat(opts.inputOffset) : undefined,
  };

  // Build minimal config for finalize function
  const config: Partial<Config> = {
    intermediateDir: cliOptions.intermediateDir,
    srtPath: cliOptions.originalSrt,
    outputDir: cliOptions.outputDir,
    targetLanguages: [cliOptions.targetLanguage],
    useResponseTimings: cliOptions.useResponseTimings,
    markFallbacks: cliOptions.markFallbacks,
    subtitleColorEnglish: engColor,
    subtitleColorTarget: tgtColor,
    outputOffsetSeconds: cliOptions.outputOffset ?? 0,
    inputOffsetSeconds: cliOptions.inputOffset ?? 0,
    videoPath: cliOptions.outputFilename,
  };

  try {
    logger.info(chalk.blueBright("--- Starting Subtitle Finalization ---"));

    // Estimate chunk count (less critical for standalone, maybe scan parsed_data dir?)
    let estChunkCount = 1;
    const parsedDataDir = join(config.intermediateDir!, "parsed_data");
    if (existsSync(parsedDataDir)) {
      estChunkCount =
        (await readdir(parsedDataDir)).filter((f) => f.endsWith("_parsed.json"))
          .length || 1;
    }

    // Create a dummy chunks array for finalize call signature
    const dummyChunks: ChunkInfo[] = Array.from(
      { length: estChunkCount },
      (_, i) => ({
        partNumber: i + 1,
        status: "completed", // Assume completed for this stage
        startTimeSeconds: 0,
        endTimeSeconds: 0,
      })
    );

    const { finalSrtPath, issues } = await finalize(
      dummyChunks,
      config as Config
    );

    // --- Final Reporting ---
    logger.info(chalk.blueBright("--- Finalizer Report ---"));
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;

    let reportContent = "";
    if (finalSrtPath) {
      reportContent += `${chalk.green(
        "Success:"
      )} Final SRT generated at ${finalSrtPath}\n`;
    } else {
      reportContent += `${chalk.red(
        "Failure:"
      )} Could not generate final SRT file.\n`;
    }
    reportContent += `${chalk.red("Errors Found:")}       ${errorCount}\n`;
    reportContent += `${chalk.yellow("Warnings Found:")}     ${warningCount}\n`;
    if (issues.length > 0) {
      reportContent += `\n${chalk.yellowBright("Issues Encountered:")} (${
        issues.length
      })\n`;
      issues.sort(
        (a, b) =>
          (a.chunkPart ?? 0) - (b.chunkPart ?? 0) ||
          (a.subtitleId ? parseInt(a.subtitleId.toString()) : Infinity) -
            (b.subtitleId ? parseInt(b.subtitleId.toString()) : Infinity)
      );
      issues.forEach((issue) => {
        const prefix =
          issue.severity === "error"
            ? chalk.red("ERROR")
            : chalk.yellow("WARN");
        reportContent += `- ${prefix}: [Chunk ${
          issue.chunkPart ?? "N/A"
        }] [ID ${issue.subtitleId || "N/A"}] ${issue.message}\n`;
      });
    }
    console.log(
      boxen(reportContent, {
        title: "Finalizer Summary",
        padding: 1,
        margin: 1,
        borderStyle: "round",
        borderColor: "green",
      })
    );

    process.exit(errorCount > 0 ? 1 : 0);
  } catch (err: any) {
    logger.error(`Fatal finalizer error: ${err.message || err}`);
    console.error(
      boxen(chalk.red(`Fatal Error: ${err.message || err}`), {
        padding: 1,
        margin: 1,
        borderColor: "red",
      })
    );
    process.exit(1);
  }
}

// Run main if called directly
if (import.meta.url.replace("file://", "") === Bun.main) {
  cliMain();
}
