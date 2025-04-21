import { readFile } from "fs/promises";
import { existsSync } from "fs";
import * as logger from "../utils/logger.js";
import type { ChunkInfo, Config } from "../types.js";

const DEFAULT_TEMPLATE_PATH = "./translation_prompt.template";

/**
 * Loads the prompt template content.
 * @param templatePath Optional path to the template file.
 * @returns The template string or null if not found/readable.
 */
async function loadPromptTemplate(
  templatePath?: string
): Promise<string | null> {
  const path = templatePath || DEFAULT_TEMPLATE_PATH;
  if (!existsSync(path)) {
    logger.error(`Prompt template file not found: ${path}`);
    return null;
  }
  try {
    const template = await readFile(path, "utf-8");
    logger.debug(`Loaded prompt template from: ${path}`);
    return template;
  } catch (error: any) {
    logger.error(
      `Failed to read prompt template ${path}: ${error.message || error}`
    );
    return null;
  }
}

/**
 * Generates the prompt for the translation LLM.
 * Assumes config.targetLanguages contains exactly one language.
 */
export async function generateTranslationPrompt(
  chunk: ChunkInfo,
  config: Config
): Promise<string | null> {
  const template = await loadPromptTemplate(
    config.translationPromptTemplatePath
  );
  if (!template) {
    return null;
  }

  if (!config.targetLanguages || config.targetLanguages.length === 0) {
    logger.error(
      "No target languages specified in config for translation prompt."
    );
    return null;
  }
  // Use only the first target language
  const targetLanguage = config.targetLanguages[0];
  if (config.targetLanguages.length > 1) {
    logger.warn(
      `Multiple target languages provided, but only using the first one for translation: ${targetLanguage}`
    );
  }

  // Read adjusted transcript
  if (
    !chunk.adjustedTranscriptPath ||
    !existsSync(chunk.adjustedTranscriptPath)
  ) {
    logger.error(
      `[Chunk ${chunk.partNumber}] Adjusted transcript missing: ${chunk.adjustedTranscriptPath}`
    );
    return null;
  }
  let adjustedTranscriptContent = "";
  try {
    adjustedTranscriptContent = await readFile(
      chunk.adjustedTranscriptPath,
      "utf-8"
    );
  } catch (error: any) {
    logger.error(
      `[Chunk ${chunk.partNumber}] Failed to read adjusted transcript ${
        chunk.adjustedTranscriptPath
      }: ${error.message || error}`
    );
    return null;
  }

  // Read reference SRT (optional)
  let referenceSrtContent = "";
  if (chunk.srtChunkPath && existsSync(chunk.srtChunkPath)) {
    try {
      referenceSrtContent = await readFile(chunk.srtChunkPath, "utf-8");
    } catch (error: any) {
      logger.warn(
        `[Chunk ${chunk.partNumber}] Failed to read reference SRT ${chunk.srtChunkPath}. Proceeding without it.`
      );
    }
  } else {
    logger.warn(
      `[Chunk ${chunk.partNumber}] Reference SRT missing: ${chunk.srtChunkPath}. Proceeding without it.`
    );
  }

  // --- Populate Template ---
  let populatedPrompt = template;
  populatedPrompt = populatedPrompt.replace(
    "{ADJUSTED_TRANSCRIPT}",
    adjustedTranscriptContent
  );
  populatedPrompt = populatedPrompt.replace(
    "{REFERENCE_SRT}",
    referenceSrtContent || "[Reference SRT not available]"
  );
  populatedPrompt = populatedPrompt.replace(
    /{TARGET_LANGUAGE_NAME}/g,
    targetLanguage
  ); // Replace all instances

  // Create and replace the XML example placeholder
  const safeLangTag = targetLanguage.toLowerCase().replace(/\s+/g, "_");
  const xmlExample = `<${safeLangTag}_translation>[Your translation for ${targetLanguage}]</${safeLangTag}_translation>`;
  populatedPrompt = populatedPrompt.replace(
    "{TARGET_LANGUAGE_XML_EXAMPLE}",
    xmlExample
  );

  logger.debug(
    `[Chunk ${chunk.partNumber}] Generated translation prompt for English + ${targetLanguage}.`
  );
  return populatedPrompt;
}
