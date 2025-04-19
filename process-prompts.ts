#!/usr/bin/env bun

import { GoogleGenAI } from "@google/genai";
import { readdir, readFile, writeFile, mkdir as fsMkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import * as cliProgress from "cli-progress";
import chalk from "chalk";

const PROMPTS_DIR = "./videos/prompts";
const DEFAULT_RESPONSES_DIR = "./videos/responses";
// Maximum number of parallel requests to make at once
const MAX_PARALLEL = 10;

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let partNumbers: number[] = [];
  let outputDir = DEFAULT_RESPONSES_DIR;

  // Check if specific part numbers are requested
  const partArg = args.find((arg) => arg.startsWith("--parts="));
  if (partArg) {
    const partsStr = partArg.split("=")[1];
    partNumbers = partsStr
      .split(",")
      .map((num) => parseInt(num.trim(), 10))
      .filter((num) => !isNaN(num));
  }

  // Check if output directory is specified
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  if (outputArg) {
    outputDir = outputArg.split("=")[1];
  }

  return { partNumbers, outputDir };
}

// Create a multi-bar container for handling multiple progress bars
const multibar = new cliProgress.MultiBar(
  {
    clearOnComplete: false,
    hideCursor: true,
    format: "{bar} | {filename} | {value}/{total} chunks",
  },
  cliProgress.Presets.shades_classic
);

async function processPrompt(
  promptPath: string,
  apiKey: string,
  filename: string
): Promise<{ text: string; filename: string }> {
  // Read the prompt file
  const promptContent = await readFile(promptPath, "utf-8");

  // Initialize the Gemini API
  const ai = new GoogleGenAI({
    apiKey,
  });

  console.log(chalk.yellow(`Starting processing for: ${filename}`));

  // Use Gemini 2.5 Pro model
  const modelName = "gemini-2.5-pro-preview-03-25";

  // Send prompt to Gemini
  const contents = [
    {
      role: "user",
      parts: [{ text: promptContent }],
    },
  ];

  const response = await ai.models.generateContentStream({
    model: modelName,
    contents,
  });

  // Create a progress bar for this specific file
  const progressBar = multibar.create(100, 0, { filename });

  // Track chunks and estimate progress
  let chunkCount = 0;
  const updateInterval = 3; // Update progress every 3 chunks

  // Collect the streamed response
  let fullResponse = "";
  for await (const chunk of response) {
    fullResponse += chunk.text;
    chunkCount++;

    // Update progress bar
    if (chunkCount % updateInterval === 0) {
      // We don't know the total, so simulate progress
      const value = Math.min(chunkCount, 100);
      progressBar.update(value);
    }
  }

  // Complete the progress bar
  progressBar.update(100);

  return { text: fullResponse, filename };
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error(
      chalk.red("❌ Error: GEMINI_API_KEY environment variable is not set")
    );
    process.exit(1);
  }

  // Parse command line arguments
  const { partNumbers, outputDir } = parseArgs();

  console.log(chalk.cyan(`Using output directory: ${outputDir}`));

  try {
    // Create responses directory if it doesn't exist
    if (!existsSync(outputDir)) {
      await fsMkdir(outputDir, { recursive: true });
      console.log(`Created directory: ${outputDir}`);
    }

    // Get all prompt files
    const files = await readdir(PROMPTS_DIR);
    let promptFiles = files.filter(
      (file) => file.startsWith("prompt_part") && file.endsWith(".txt")
    );

    // Filter files by part numbers if specified
    if (partNumbers.length > 0) {
      promptFiles = promptFiles.filter((file) => {
        const partMatch = file.match(/part(\d+)/);
        if (!partMatch) return false;

        const partNumber = parseInt(partMatch[1], 10);
        return partNumbers.includes(partNumber);
      });

      console.log(
        chalk.cyan(`Processing only parts: ${partNumbers.join(", ")}`)
      );
    }

    if (promptFiles.length === 0) {
      console.log(`No matching prompt files found in ${PROMPTS_DIR}`);
      return;
    }

    console.log(
      chalk.cyan(
        `Found ${promptFiles.length} prompt files to process in parallel (max ${MAX_PARALLEL} at once)`
      )
    );

    // Create a main progress bar to track overall completion
    const mainProgressBar = multibar.create(promptFiles.length, 0, {
      filename: "Overall progress",
    });

    // Keep track of successfully processed files
    const processedFiles: string[] = [];
    const failedFiles: string[] = [];

    // Process files in parallel, but with a limit on concurrency
    for (let i = 0; i < promptFiles.length; i += MAX_PARALLEL) {
      const batch = promptFiles.slice(i, i + MAX_PARALLEL);
      const promises = batch.map(async (file) => {
        try {
          const promptPath = join(PROMPTS_DIR, file);

          // Extract part number from filename
          const partMatch = file.match(/part(\d+)/);
          if (!partMatch) {
            console.log(
              `Could not determine part number for ${file}, skipping`
            );
            return { success: false, file };
          }

          const partNumber = parseInt(partMatch[1], 10);

          // Process the prompt with Gemini
          const result = await processPrompt(promptPath, apiKey, file);

          // Save the response
          const responseFileName = `response_part${partNumber}.txt`;
          const responsePath = join(outputDir, responseFileName);
          await writeFile(responsePath, result.text);

          // Log success details
          console.log(chalk.green(`✅ Generated response: ${responsePath}`));
          console.log(`   - Response length: ${result.text.length} characters`);

          processedFiles.push(responseFileName);
          return { success: true, file };
        } catch (error) {
          console.error(chalk.red(`❌ Error processing ${file}:`), error);
          failedFiles.push(file);
          return { success: false, file };
        }
      });

      // Wait for the current batch to complete
      const results = await Promise.all(promises);

      // Update the main progress bar
      mainProgressBar.increment(results.length);
    }

    // Stop all progress bars
    multibar.stop();

    // Print summary
    console.log("\n" + chalk.cyan("📋 Summary:"));
    console.log(`Total files: ${promptFiles.length}`);
    console.log(
      chalk.green(`Successfully processed: ${processedFiles.length}`)
    );

    if (failedFiles.length > 0) {
      console.log(chalk.red(`Failed: ${failedFiles.length}`));
      console.log("Failed files:");
      failedFiles.forEach((file, index) => {
        console.log(chalk.red(`  ${index + 1}. ${file}`));
      });
    }

    if (processedFiles.length > 0) {
      console.log(chalk.cyan("\nGenerated responses:"));
      processedFiles.forEach((file, index) => {
        console.log(`  ${index + 1}. ${file}`);
      });
      console.log(
        chalk.green(
          `\n✨ Successfully processed ${processedFiles.length} prompt files to ${outputDir}`
        )
      );
    } else {
      console.log(chalk.yellow("⚠️ No responses were generated."));
    }
  } catch (error) {
    console.error(chalk.red("❌ Error:"), error);
  }
}

main();
