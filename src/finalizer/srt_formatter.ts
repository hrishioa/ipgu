import { secondsToTimestamp } from "../utils/time_utils.js";
import type { FinalSubtitleEntry } from "../types.js";

const DEFAULT_ENGLISH_COLOR = "FFFFFF";
const DEFAULT_TARGET_COLOR = "FFC0CB";

/**
 * Applies font color tags to subtitle text based on language.
 * Handles fallback marking if requested.
 *
 * @param translations Object containing text for 'english' and the target language.
 * @param targetLanguage The key for the target language in the translations object.
 * @param englishColor Hex color code for English.
 * @param targetColor Hex color code for the target language.
 * @param isFallback Whether this entry used fallback text.
 * @param markFallback Whether to visually mark fallbacks.
 * @returns Formatted text block for the SRT entry.
 */
function applyColorsAndFormatText(
  translations: Record<string, string | null>,
  targetLanguage: string, // The actual key, e.g., 'Korean'
  englishColor: string = DEFAULT_ENGLISH_COLOR,
  targetColor: string = DEFAULT_TARGET_COLOR,
  isFallback: boolean = false,
  markFallback: boolean = true
): string {
  let outputText = "";
  const englishText = translations["english"];
  const targetText = translations[targetLanguage];

  if (englishText) {
    if (markFallback && isFallback) {
      outputText += `<font color="#${englishColor}">[Original] ${englishText}</font>`;
    } else {
      outputText += `<font color="#${englishColor}">${englishText}</font>`;
    }
  }

  if (targetText) {
    if (outputText) {
      outputText += "\n"; // Add newline if English text was present
    }
    outputText += `<font color="#${targetColor}">${targetText}</font>`;
  }

  // If both are somehow null/empty (should be filtered earlier ideally), return a placeholder
  if (!outputText) {
    return "(Text unavailable)";
  }

  return outputText;
}

/**
 * Formats a single FinalSubtitleEntry into an SRT block string.
 *
 * @param entry The final subtitle data.
 * @param targetLanguage The target language key (e.g., 'Korean').
 * @param config Configuration containing color and fallback marking preferences.
 * @returns A string representing the SRT block.
 */
export function formatSrtEntry(
  entry: FinalSubtitleEntry,
  targetLanguage: string,
  config: {
    subtitleColorEnglish?: string;
    subtitleColorTarget?: string;
    markFallbacks?: boolean;
  }
): string {
  const timingString = `${secondsToTimestamp(
    entry.startTimeSeconds
  )} --> ${secondsToTimestamp(entry.endTimeSeconds)}`;

  const formattedText = applyColorsAndFormatText(
    entry.translations,
    targetLanguage,
    config.subtitleColorEnglish,
    config.subtitleColorTarget,
    entry.isFallback,
    config.markFallbacks
  );

  return `${entry.finalId}\n${timingString}\n${formattedText}\n\n`;
}
