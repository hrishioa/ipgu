#!/usr/bin/env bun

import { GoogleGenAI } from "@google/genai";
import { readdir, readFile, writeFile, mkdir as fsMkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import * as cliProgress from "cli-progress";
import chalk from "chalk";
import { Anthropic } from "@anthropic-ai/sdk";
import { parseArgs } from "util";

// Supported models
const MODELS = {
  GEMINI_PRO: "gemini-2.5-pro-preview-03-25",
  GEMINI_FLASH: "gemini-2.5-flash-preview-0514",
  CLAUDE_SONNET: "claude-3-7-sonnet-latest",
};

// Parse command line arguments
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: {
      type: "string",
      short: "i",
      default: "./videos/prompts",
    },
    output: {
      type: "string",
      short: "o",
      default: "./videos/responses",
    },
    model: {
      type: "string",
      short: "m",
      default: "gemini-pro",
    },
    parts: {
      type: "string",
      short: "p",
    },
    concurrent: {
      type: "string",
      short: "c",
      default: "10",
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
  allowPositionals: true,
});

// Show help if requested
if (values.help) {
  console.log(`
Usage: bun process-prompts.ts [options]

Options:
  -i, --input <directory>      Input directory with prompt files (default: "./videos/prompts")
  -o, --output <directory>     Output directory for responses (default: "./videos/responses")
  -m, --model <name>           AI model to use (default: "gemini-pro")
                               Supported models: gemini-pro, gemini-flash, claude-sonnet
  -p, --parts <numbers>        Process only specific parts (comma-separated, e.g. "1,2,3")
  -c, --concurrent <number>    Maximum concurrent requests (default: "10")
  -h, --help                   Show this help message
  `);
  process.exit(0);
}

const PROMPTS_DIR = values.input as string;
const RESPONSES_DIR = values.output as string;
const MAX_PARALLEL = parseInt(values.concurrent as string, 10) || 10;

// Parse parts to process
let partNumbers: number[] = [];
if (values.parts) {
  partNumbers = (values.parts as string)
    .split(",")
    .map((num) => parseInt(num.trim(), 10))
    .filter((num) => !isNaN(num));
}

// Determine which model to use
let selectedModel = MODELS.GEMINI_PRO; // Default model
const modelArg = (values.model as string).toLowerCase();

if (modelArg.includes("flash")) {
  selectedModel = MODELS.GEMINI_FLASH;
} else if (modelArg.includes("claude") || modelArg.includes("sonnet")) {
  selectedModel = MODELS.CLAUDE_SONNET;
} else if (modelArg.includes("pro")) {
  selectedModel = MODELS.GEMINI_PRO;
} else {
  console.log(
    chalk.yellow(`Unknown model: ${modelArg}, using default ${selectedModel}`)
  );
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

async function processPromptWithGemini(
  promptContent: string,
  apiKey: string,
  modelName: string
): Promise<string> {
  // Initialize the Gemini API
  const ai = new GoogleGenAI({ apiKey });

  // prettier-ignore
  const kiwico =
`
Some notes for the english translation:
The consumer for English is from new zealand. If you can use cultural references, see if it's possible to change the tone (english doesn't have honorifics but you can use different diction to change how people speak to convey the intent and tone that's not actually present in the text. Feel free to be creative and take a lot of creative license.

`;

  // Send prompt to Gemini
  const contents = [
    {
      role: "user",
      parts: [{ text: promptContent + kiwico }],
    },
  ];

  const response = await ai.models.generateContentStream({
    model: modelName,
    contents,
  });

  // Collect the streamed response
  let fullResponse = "";
  for await (const chunk of response) {
    fullResponse += chunk.text;
  }

  return fullResponse;
}

async function processPromptWithClaude(
  promptContent: string,
  apiKey: string
): Promise<string> {
  const client = new Anthropic({ apiKey });

  // prettier-ignore
  const kiwico =
`
Some notes for the english translation:
The consumer for English is from new zealand. If you can use cultural references, see if it's possible to change the tone (english doesn't have honorifics but you can use different diction to change how people speak to convey the intent and tone that's not actually present in the text. Feel free to be creative and take a lot of creative license.

`;

  const message = await client.messages.create({
    model: MODELS.CLAUDE_SONNET,
    max_tokens: 128000,
    temperature: 1,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: promptContent + kiwico,
          },
        ],
      },
    ],
  });

  // Handle different response formats for Claude API
  if (typeof message.content[0] === "object" && "text" in message.content[0]) {
    return message.content[0].text;
  } else {
    // Convert other content types to string if needed
    return message.content
      .map((item) => {
        if (typeof item === "object" && "text" in item) {
          return item.text;
        }
        return "";
      })
      .join("\n");
  }
}

async function processPrompt(
  promptPath: string,
  config: {
    geminiApiKey?: string;
    claudeApiKey?: string;
    model: string;
    filename: string;
  }
): Promise<{ text: string; filename: string }> {
  const { model, filename } = config;

  // Read the prompt file
  const promptContent = await readFile(promptPath, "utf-8");

  console.log(
    chalk.yellow(`Starting processing for: ${filename} with model: ${model}`)
  );

  // Create a progress bar for this specific file
  const progressBar = multibar.create(100, 0, { filename });

  try {
    let fullResponse: string;

    // Process with appropriate model
    if (model === MODELS.CLAUDE_SONNET) {
      if (!config.claudeApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for Claude models");
      }

      // For Claude, we don't have streaming progress, so show indeterminate
      progressBar.update(10);
      fullResponse = await processPromptWithClaude(
        promptContent,
        config.claudeApiKey
      );
      progressBar.update(100);
    } else {
      // For Gemini models
      if (!config.geminiApiKey) {
        throw new Error("GEMINI_API_KEY is required for Gemini models");
      }

      // Process with Gemini
      progressBar.update(5);
      fullResponse = await processPromptWithGemini(
        promptContent,
        config.geminiApiKey,
        model
      );
      progressBar.update(100);
    }

    return { text: fullResponse, filename };
  } catch (error) {
    progressBar.stop();
    throw error;
  }
}

async function main() {
  // Check for required API keys based on model
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const claudeApiKey = process.env.ANTHROPIC_API_KEY;

  if (selectedModel.includes("gemini") && !geminiApiKey) {
    console.error(
      chalk.red("❌ Error: GEMINI_API_KEY environment variable is not set")
    );
    process.exit(1);
  }

  if (selectedModel.includes("claude") && !claudeApiKey) {
    console.error(
      chalk.red("❌ Error: ANTHROPIC_API_KEY environment variable is not set")
    );
    process.exit(1);
  }

  // Print configuration information
  console.log(chalk.cyan("Configuration:"));
  console.log(`- Input directory: ${PROMPTS_DIR}`);
  console.log(`- Output directory: ${RESPONSES_DIR}`);
  console.log(`- Model: ${selectedModel}`);
  console.log(`- Max concurrent requests: ${MAX_PARALLEL}`);

  if (partNumbers.length > 0) {
    console.log(`- Processing parts: ${partNumbers.join(", ")}`);
  } else {
    console.log(`- Processing all parts`);
  }

  try {
    // Create responses directory if it doesn't exist
    if (!existsSync(RESPONSES_DIR)) {
      await fsMkdir(RESPONSES_DIR, { recursive: true });
      console.log(`Created directory: ${RESPONSES_DIR}`);
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

          // Process the prompt with the selected model
          const result = await processPrompt(promptPath, {
            geminiApiKey,
            claudeApiKey,
            model: selectedModel,
            filename: file,
          });

          // Save the response
          const responseFileName = `response_part${partNumber}.txt`;
          const responsePath = join(RESPONSES_DIR, responseFileName);
          await writeFile(responsePath, result.text);

          // Log success details
          console.log(chalk.green(`✅ Generated response: ${responsePath}`));
          console.log(`   - Response length: ${result.text.length} characters`);
          console.log(`   - Model used: ${selectedModel}`);

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
    console.log(`Model used: ${selectedModel}`);
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
          `\n✨ Successfully processed ${processedFiles.length} prompt files to ${RESPONSES_DIR}`
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
