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
  minLogLevel: LogLevel;
  multibar?: MultiBar | null;
}

// Default configuration
const defaultConfig: LoggerConfig = {
  logToConsole: true,
  logToFile: false,
  minLogLevel: "info",
  multibar: null,
};

// Current configuration
let currentConfig: LoggerConfig = { ...defaultConfig };

/**
 * Configure the logger
 * @param config Configuration options
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
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

/**
 * Should this log level be displayed based on configuration?
 */
function shouldLog(level: LogLevel): boolean {
  return logLevelValue[level] >= logLevelValue[currentConfig.minLogLevel];
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
  if (!currentConfig.logToConsole) return;

  let messageForConsole = coloredMessage;

  // Append note about log file for errors when bar is active and file logging is on
  if (currentConfig.multibar && currentConfig.logToFile && level === "error") {
    messageForConsole += chalk.gray(" (See log file for full details)");
  }

  if (currentConfig.multibar) {
    // Use MultiBar's log method
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

/**
 * Write log to file if configured
 */
async function logToFile(formattedMessage: string): Promise<void> {
  if (currentConfig.logToFile && currentConfig.logFilePath) {
    try {
      await appendFile(currentConfig.logFilePath, formattedMessage + "\n");
    } catch (error) {
      // Use direct console.error here to avoid potential loop if logging itself fails
      console.error(`[Logger Error] Failed to write to log file: ${error}`);
    }
  }
}

/**
 * Log a debug message
 */
export function debug(message: string): void {
  if (!shouldLog("debug")) return;

  const formattedMessage = formatLogMessage("debug", message);
  logToConsole("debug", formattedMessage, chalk.gray(formattedMessage));
  logToFile(formattedMessage);
}

/**
 * Log an info message
 */
export function info(message: string): void {
  if (!shouldLog("info")) return;

  const formattedMessage = formatLogMessage("info", message);
  logToConsole("info", formattedMessage, chalk.blue(formattedMessage));
  logToFile(formattedMessage);
}

/**
 * Log a warning message
 */
export function warn(message: string): void {
  if (!shouldLog("warn")) return;

  const formattedMessage = formatLogMessage("warn", message);
  logToConsole("warn", formattedMessage, chalk.yellow(formattedMessage));
  logToFile(formattedMessage);
}

/**
 * Log an error message
 */
export function error(message: string): void {
  if (!shouldLog("error")) return;

  const formattedMessage = formatLogMessage("error", message);
  logToConsole("error", formattedMessage, chalk.red(formattedMessage));
  logToFile(formattedMessage);
}

/**
 * Log a success message (info level with green color)
 */
export function success(message: string): void {
  if (!shouldLog("info")) return;

  const formattedMessage = formatLogMessage("info", message);
  logToConsole("info", formattedMessage, chalk.green(formattedMessage));
  logToFile(formattedMessage);
}
