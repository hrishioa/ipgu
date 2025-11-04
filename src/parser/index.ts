#!/usr/bin/env bun

import { Command } from "commander";
import { join, parse as parsePath } from "path";
import { existsSync } from "fs";
import chalk from "chalk";
import boxen from "boxen";
import type {
  ChunkInfo,
  Config,
  ProcessingIssue,
  ParsedTranslationEntry,
} from "../types.js";
import * as logger from "../utils/logger.js";
import {
  ensureDir,
  writeToFile,
  readJsonFromFile,
  readFromFile,
} from "../utils/file_utils.js";
import { parseTranslationResponse } from "./response_parser.js";

/**
 * Parses the raw LLM response text for a given chunk.
 *
 * @param chunk The ChunkInfo object containing the path to the raw response.
 * @param config The pipeline configuration (needed for target languages).
 * @returns Promise resolving to updated chunk and any parsing issues.
 */
export async function parseResponse(
  chunk: ChunkInfo,
  config: Config
): Promise<{ chunk: ChunkInfo; issues: ProcessingIssue[] }> {
  let issues: ProcessingIssue[] = [];

  // Check if response file exists
  if (!chunk.responsePath || !existsSync(chunk.responsePath)) {
    chunk.status = "failed";
    chunk.error = `LLM response file not found: ${chunk.responsePath}`;
    issues.push({
      type: "ExtractionFailed",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
    return { chunk, issues };
  }

  // Read the response content
  const llmResponseContent = await readFromFile(chunk.responsePath);
  if (llmResponseContent === null) {
    chunk.status = "failed";
    chunk.error = `Failed to read LLM response file: ${chunk.responsePath}`;
    issues.push({
      type: "ExtractionFailed",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
    return { chunk, issues };
  }

  // Ensure target languages are available
  if (!config.targetLanguages || config.targetLanguages.length === 0) {
    chunk.status = "failed";
    chunk.error = `Missing target languages in config for parsing chunk ${chunk.partNumber}`;
    issues.push({
      type: "TranslationError",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
    return { chunk, issues };
  }

  // Parse the content
  logger.info(`[Chunk ${chunk.partNumber}] Parsing LLM response...`);
  const parseResult = parseTranslationResponse(
    llmResponseContent,
    chunk.partNumber,
    config.targetLanguages
  );

  issues = parseResult.issues; // Overwrite issues with those from the parser run
  const parsedEntries = parseResult.entries;

  // Determine output path for parsed data
  const parsedDir = join(config.intermediateDir, "parsed_data");
  ensureDir(parsedDir);
  const parsedFileName = `part${chunk.partNumber
    .toString()
    .padStart(2, "0")}_parsed.json`;
  chunk.parsedDataPath = join(parsedDir, parsedFileName);

  // Save parsed data
  const saveSuccess = await writeToFile(chunk.parsedDataPath, parsedEntries);
  if (!saveSuccess) {
    chunk.status = "failed";
    chunk.error = `Failed to write parsed data to ${chunk.parsedDataPath}`;
    issues.push({
      type: "FormatError",
      severity: "error",
      message: chunk.error,
      chunkPart: chunk.partNumber,
    });
    logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
    // Don't return here, parsing itself might have succeeded partly
  }

  // Update status based on parsing success/issues
  // Consider parsing successful if we got *any* entries, even with warnings/errors.
  // Validation step will handle quality checks.
  if (parsedEntries.length > 0 && saveSuccess) {
    chunk.status = "validating"; // Ready for validation step
    logger.info(
      `[Chunk ${chunk.partNumber}] Successfully parsed ${parsedEntries.length} subtitle entries.`
    );
  } else if (parsedEntries.length === 0) {
    chunk.status = "failed";
    chunk.error =
      chunk.error ||
      `Parsing failed: No valid subtitle entries found in response.`;
    if (!issues.some((i) => i.chunkPart === chunk.partNumber)) {
      issues.push({
        type: "ExtractionFailed",
        severity: "error",
        message: chunk.error,
        chunkPart: chunk.partNumber,
      });
    }
    logger.error(`[Chunk ${chunk.partNumber}] ${chunk.error}`);
  }
  // If save failed but entries were parsed, status remains 'failed' from above

  return { chunk, issues };
}

// --- CLI Logic ---

interface ParserCliOptions {
  responseFilePath: string;
  outputJsonPath?: string;
  outputReportPath?: string;
  targetLanguages: string; // Comma-separated required for CLI
  logFile?: string;
  logLevel?: string;
}

async function cliMain() {
  const program = new Command();

  program
    .name("subtitle-parser")
    .description("Parse LLM translation response file (XML-like format)")
    .requiredOption("-i, --input <path>", "Path to the LLM response text file")
    .requiredOption(
      "-l, --languages <langs>",
      "Comma-separated target languages expected in the file (e.g., Korean,Japanese)"
    )
    .option(
      "-o, --output-json <path>",
      "Path to save parsed data JSON (default: <input>.parsed.json)"
    )
    .option(
      "-r, --output-report <path>",
      "Path to save parsing report (default: <input>.report.txt)"
    )
    .option("--log-file <path>", "Path to log file")
    .option("--log-level <level>", "Log level", "info")
    .parse(process.argv);

  const opts = program.opts();

  logger.configureLogger({
    logToFile: !!opts.logFile,
    logFilePath: opts.logFile,
    consoleLogLevel: opts.logLevel || "info",
  });

  const cliOptions: ParserCliOptions = {
    responseFilePath: opts.input,
    outputJsonPath: opts.outputJson,
    outputReportPath: opts.outputReport,
    targetLanguages: opts.languages,
  };

  // Determine default output paths
  const inputPathParsed = parsePath(cliOptions.responseFilePath);
  const defaultJsonPath = join(
    inputPathParsed.dir,
    `${inputPathParsed.name}.parsed.json`
  );
  const defaultReportPath = join(
    inputPathParsed.dir,
    `${inputPathParsed.name}.report.txt`
  );
  const jsonPath = cliOptions.outputJsonPath || defaultJsonPath;
  const reportPath = cliOptions.outputReportPath || defaultReportPath;

  try {
    logger.info(chalk.blueBright("--- Starting LLM Response Parsing ---"));
    logger.info(`Input file: ${cliOptions.responseFilePath}`);

    const llmResponseContent = await readFromFile(cliOptions.responseFilePath);
    if (llmResponseContent === null) {
      logger.error(`Failed to read input file: ${cliOptions.responseFilePath}`);
      process.exit(1);
    }

    const targetLangs = cliOptions.targetLanguages
      .split(",")
      .map((l) => l.trim());
    if (targetLangs.length === 0) {
      logger.error(`No target languages provided via --languages flag.`);
      process.exit(1);
    }

    // Parse the content (assuming chunk number 0 for standalone runs)
    const startTime = performance.now();
    const { entries, issues } = parseTranslationResponse(
      llmResponseContent,
      0,
      targetLangs
    );
    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    // --- Reporting ---
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;

    logger.info(chalk.blueBright(`--- Parsing Report (${duration}s) ---`));
    let reportContent = "";
    reportContent += `${chalk.green("Successfully Parsed:")} ${
      entries.length
    }\n`;
    reportContent += `${chalk.red("Errors Found:")}       ${errorCount}\n`;
    reportContent += `${chalk.yellow("Warnings Found:")}     ${warningCount}\n`;

    if (issues.length > 0) {
      reportContent += `\n${chalk.yellowBright("Issues Encountered:")} (${
        issues.length
      })\n`;
      issues.sort(
        (a, b) => (a.lineNumber ?? Infinity) - (b.lineNumber ?? Infinity)
      );
      issues.forEach((issue) => {
        const prefix =
          issue.severity === "error"
            ? chalk.red("ERROR")
            : chalk.yellow("WARN");
        reportContent += `- ${prefix}: [Line ${
          issue.lineNumber ?? "N/A"
        }] [ID ${issue.subtitleId || "N/A"}] ${issue.message}\n`;
        // Directly check the log level option for showing context
        if (issue.context && opts.logLevel === "debug") {
          reportContent += `  Context: ${chalk.gray(issue.context)}\n`;
        }
      });
    }
    console.log(
      boxen(reportContent, {
        title: "Parsing Summary",
        padding: 1,
        margin: 1,
        borderStyle: "round",
        borderColor: "blue",
      })
    );

    // ... rest of CLI function ...
  } catch (err: any) {
    logger.error(`Fatal parser error: ${err.message || err}`);
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

// Run main if called directly (only when running this file standalone with Bun)
if (typeof Bun !== 'undefined' && import.meta.url.replace("file://", "") === Bun.main) {
  cliMain();
}
