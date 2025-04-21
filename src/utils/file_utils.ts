import { existsSync, mkdirSync, statSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import { join, dirname, basename } from "path";
import * as logger from "./logger";

/**
 * Ensure a directory exists, creating it if necessary
 * @param dirPath Path to the directory
 * @returns True if successful, false otherwise
 */
export function ensureDir(dirPath: string): boolean {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      logger.debug(`Created directory: ${dirPath}`);
    }
    return true;
  } catch (error) {
    logger.error(`Failed to create directory ${dirPath}: ${error}`);
    return false;
  }
}

/**
 * Write data to a file, ensuring its directory exists
 * @param filePath Path to the file
 * @param data Data to write (string or object to be stringified)
 * @returns Promise that resolves to true if successful
 */
export async function writeToFile(
  filePath: string,
  data: string | object
): Promise<boolean> {
  try {
    const dir = dirname(filePath);
    ensureDir(dir);

    const content =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await writeFile(filePath, content, "utf-8");
    logger.debug(`Wrote to file: ${filePath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to write to file ${filePath}: ${error}`);
    return false;
  }
}

/**
 * Read data from a file
 * @param filePath Path to the file
 * @returns Promise that resolves to the file contents or null if error
 */
export async function readFromFile(filePath: string): Promise<string | null> {
  try {
    if (!existsSync(filePath)) {
      logger.warn(`File does not exist: ${filePath}`);
      return null;
    }

    const content = await readFile(filePath, "utf-8");
    logger.debug(`Read from file: ${filePath}`);
    return content;
  } catch (error) {
    logger.error(`Failed to read from file ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Read and parse a JSON file
 * @param filePath Path to the JSON file
 * @returns Promise that resolves to the parsed object or null if error
 */
export async function readJsonFromFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFromFile(filePath);
    if (!content) return null;

    return JSON.parse(content) as T;
  } catch (error) {
    logger.error(`Failed to parse JSON from file ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Check if a file exists and is not empty
 * @param filePath Path to the file
 * @returns True if the file exists and has content
 */
export function fileExistsWithContent(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) {
      return false;
    }

    const stats = statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (error) {
    logger.error(`Error checking file ${filePath}: ${error}`);
    return false;
  }
}

/**
 * Generate output path for a processed file
 * @param baseDir Base directory for output
 * @param inputPath Original input file path
 * @param suffix Suffix to add to the filename
 * @param extension New extension (without dot)
 * @returns Full path for the output file
 */
export function generateOutputPath(
  baseDir: string,
  inputPath: string,
  suffix: string,
  extension: string
): string {
  const filename = basename(inputPath).split(".")[0];
  return join(baseDir, `${filename}${suffix}.${extension}`);
}
