import { existsSync, mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { join, dirname } from "path";
import chalk from "chalk";
import type { MultiBar } from "cli-progress";

// Define log levels
export type LogLevel = "debug" | "info" | "warn" | "error";

// Interface for logger configuration
export interface LoggerConfig {
  logToConsole: boolean;
  logToFile: boolean;
  logFilePath?: string;
  consoleLogLevel: LogLevel; // Separate level for console
  fileLogLevel: LogLevel; // Separate level for file
  multibar?: MultiBar | null;
}

// Default configuration
const defaultConfig: LoggerConfig = {
  logToConsole: true,
  logToFile: false,
  consoleLogLevel: "info", // Default console level
  fileLogLevel: "debug", // Default file level to debug
  multibar: null,
};

// Current configuration
let currentConfig: LoggerConfig = { ...defaultConfig };

/**
 * Configure the logger
 * @param config Configuration options
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  // Ensure default fileLogLevel is debug if file logging is enabled but level not specified
  if (
    config.logToFile === true &&
    config.logFilePath &&
    config.fileLogLevel === undefined
  ) {
    config.fileLogLevel = "debug";
  }
  currentConfig = { ...currentConfig, ...config };

  // Create log directory if logging to file
  if (currentConfig.logToFile && currentConfig.logFilePath) {
    const logDir = dirname(currentConfig.logFilePath);
    if (logDir && !existsSync(logDir)) {
      try {
        mkdirSync(logDir, { recursive: true });
      } catch (error) {
        console.error(`Failed to create log directory: ${error}`);
        currentConfig.logToFile = false;
      }
    }
  }
}

/**
 * Sets or clears the active MultiBar instance for the logger
 * @param multibar The cli-progress MultiBar instance or null
 */
export function setActiveMultibar(multibar: MultiBar | null): void {
  currentConfig.multibar = multibar;
}

/**
 * Numeric value for log level (for filtering)
 */
const logLevelValue: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Checks if a level should be logged to a specific target (console or file). */
function shouldLog(level: LogLevel, target: "console" | "file"): boolean {
  const threshold =
    target === "console"
      ? currentConfig.consoleLogLevel
      : currentConfig.fileLogLevel;
  return logLevelValue[level] >= logLevelValue[threshold];
}

/**
 * Format a log message with timestamp and level
 */
function formatLogMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

/**
 * Internal function to handle console logging (with MultiBar awareness)
 */
function logToConsole(
  level: LogLevel,
  formattedMessage: string,
  coloredMessage: string
): void {
  if (!currentConfig.logToConsole || !shouldLog(level, "console")) return; // Check console level

  let messageForConsole = coloredMessage;
  if (currentConfig.multibar && currentConfig.logToFile && level === "error") {
    messageForConsole += chalk.gray(" (See log file for full details)");
  }

  if (currentConfig.multibar) {
    currentConfig.multibar.log(`${messageForConsole}\n`);
  } else {
    // Standard console logging
    switch (level) {
      case "debug":
        console.debug(messageForConsole);
        break;
      case "info":
        console.info(messageForConsole);
        break;
      case "warn":
        console.warn(messageForConsole);
        break;
      case "error":
        console.error(messageForConsole);
        break;
    }
  }
}

/** Write log to file if configured AND level meets file threshold. */
async function logToFile(
  level: LogLevel,
  formattedMessage: string,
  context?: string
): Promise<void> {
  // Check file logging enabled AND file log level threshold
  if (
    !currentConfig.logToFile ||
    !currentConfig.logFilePath ||
    !shouldLog(level, "file")
  )
    return;

  let messageToWrite = formattedMessage;
  // Always include full context (like stack trace) in file log if present
  if (context) {
    messageToWrite += `\n  Context: ${context}`;
  }

  try {
    await appendFile(currentConfig.logFilePath, messageToWrite + "\n");
  } catch (error) {
    console.error(`[Logger Error] Failed to write to log file: ${error}`);
  }
}

/**
 * Log a debug message
 */
export function debug(message: string, context?: string): void {
  if (!shouldLog("debug", "console") && !shouldLog("debug", "file")) return;
  const formattedMessage = formatLogMessage("debug", message);
  logToConsole("debug", formattedMessage, chalk.gray(formattedMessage));
  logToFile("debug", formattedMessage, context);
}

/**
 * Log an info message
 */
export function info(message: string, context?: string): void {
  if (!shouldLog("info", "console") && !shouldLog("info", "file")) return;
  const formattedMessage = formatLogMessage("info", message);
  logToConsole("info", formattedMessage, chalk.blue(formattedMessage));
  logToFile("info", formattedMessage, context);
}

/**
 * Log a warning message
 */
export function warn(message: string, context?: string): void {
  if (!shouldLog("warn", "console") && !shouldLog("warn", "file")) return;
  const formattedMessage = formatLogMessage("warn", message);
  logToConsole("warn", formattedMessage, chalk.yellow(formattedMessage));
  logToFile("warn", formattedMessage, context);
}

/**
 * Log an error message
 */
export function error(message: string, context?: string): void {
  if (!shouldLog("error", "console") && !shouldLog("error", "file")) return;
  const formattedMessage = formatLogMessage("error", message);
  logToConsole("error", formattedMessage, chalk.red(formattedMessage));
  logToFile("error", formattedMessage, context); // Pass context here
}

/**
 * Log a success message (info level with green color)
 */
export function success(message: string, context?: string): void {
  if (!shouldLog("info", "console") && !shouldLog("info", "file")) return;
  const formattedMessage = formatLogMessage("info", message);
  logToConsole("info", formattedMessage, chalk.green(formattedMessage));
  logToFile("info", formattedMessage, context);
}
