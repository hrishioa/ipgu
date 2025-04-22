// Common types shared across the subtitle pipeline

// Configuration options
export interface Config {
  videoPath: string;
  srtPath?: string; // Optional reference SRT
  outputDir: string;
  intermediateDir: string;
  sourceLanguages?: string[]; // Optional: Languages spoken in the source video (e.g., ['ml', 'ta'])
  targetLanguages: string[]; // e.g., ['korean', 'japanese'
  translationPromptTemplatePath?: string; // Path to the translation prompt template file
  transcriptionModel: string;
  translationModel: string;
  chunkDuration: number; // seconds
  chunkOverlap: number; // seconds
  chunkFormat: "mp3" | "mp4";
  maxConcurrent: number;
  retries: number; // General retries (e.g., for translation API calls)
  transcriptionRetries: number; // Specific retries for transcription validation failure
  force: boolean;
  apiKeys: {
    gemini?: string;
    anthropic?: string;
  };
  processOnlyPart?: number; // Optional: Process only this specific part number
  disableTimingValidation?: boolean; // Optional: Disable timing checks in validator
  useResponseTimings?: boolean; // Use timings from LLM response instead of original SRT
  markFallbacks?: boolean; // Add marker to subtitles using original text
  subtitleColorEnglish?: string; // Color for English text
  subtitleColorTarget?: string; // Color for the target language text
  outputOffsetSeconds?: number; // Optional: Add seconds offset to final output timings
  inputOffsetSeconds?: number; // Optional: Add seconds offset to the input original SRT timings
}

// Information about each processed chunk
export interface ChunkInfo {
  partNumber: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  // File paths within intermediateDir
  mediaChunkPath?: string; // Path to mp3 or mp4 chunk
  srtChunkPath?: string; // Path to reference SRT chunk
  rawTranscriptPath?: string;
  adjustedTranscriptPath?: string; // Path to transcript with absolute timestamps
  responsePath?: string; // Path to the RAW LLM text response file
  llmRequestLogPath?: string; // Path to structured JSON log of the request sent to LLM
  llmResponseLogPath?: string; // Path to structured JSON log of the full LLM response object
  llmTranscriptionInputTokens?: number; // Tokens for transcription step (most recent attempt)
  llmTranscriptionOutputTokens?: number;
  llmTranslationInputTokens?: number; // Tokens for translation step (most recent attempt)
  llmTranslationOutputTokens?: number;
  cost?: number; // Cost of API calls for this chunk (most recent attempt)

  // Track all attempts
  allTranscriptionAttempts?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }[];
  allTranslationAttempts?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }[];
  totalTranscriptionCost?: number; // Sum of all transcription attempt costs
  totalTranslationCost?: number; // Sum of all translation attempt costs
  totalCost?: number; // Sum of all costs for this chunk
  parsedDataPath?: string; // Path to parsed JSON from response
  failedTranscriptPath?: string; // Path to raw transcript if it failed validation
  status:
    | "pending"
    | "splitting"
    | "transcribing"
    | "prompting" // Status indicating ready for translation prompt generation + call
    | "translating" // In progress of calling translation LLM
    | "parsing" // Raw response received, ready for parsing
    | "validating"
    | "completed"
    | "failed";
  error?: string; // Store error message if failed
}

// Parsed entry from reference SRT
export interface SrtEntry {
  id: number;
  timingString: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
}

// Parsed entry from LLM translation response (REFINED)
export interface ParsedTranslationEntry {
  originalId: string; // Corresponds to SrtEntry ID, from <original_number>
  originalLine?: string; // Text from <original_line>
  originalTiming?: string; // Raw timing string from <original_timing>
  parsedStartTimeSeconds?: number; // Parsed start time (if timing exists and is valid)
  parsedEndTimeSeconds?: number; // Parsed end time (if timing exists and is valid)
  translations: Record<string, string | null>; // { 'english': '...', 'korean': '...' } - Allow null if tag exists but is empty
  sourceChunk: number; // Which part number this came from
  sourceFormat: "markdown" | "direct_tag" | "regex" | "unknown"; // How the subline block was found
}

// Define possible issue types
export type ParsingIssueType =
  | "MissingTag"
  | "InvalidTimingFormat"
  | "InvalidTimingValue"
  | "MalformedTag"
  | "AmbiguousStructure"
  | "ExtractionFailed"
  | "DuplicateId"
  | "NumberNotFound"
  | "TextNotFound"
  | "MarkdownBlockEmptyOrInvalid";

// Issue found during processing (ensure ParseError is listed and lineNumber exists)
export interface ProcessingIssue {
  type:
    | ParsingIssueType
    | "SplitError"
    | "TranscriptionError"
    | "TimestampAdjustError"
    | "PromptGenError"
    | "TranslationError"
    | "ValidationError"
    | "MergeError"
    | "FormatError";
  severity: "error" | "warning" | "info";
  message: string;
  chunkPart?: number;
  subtitleId?: string | number; // ID from <original_number> if available
  context?: string; // Snippet or relevant data
  lineNumber?: number; // Optional line number from parser
}

// Entry for the final, merged SRT file before formatting
export interface FinalSubtitleEntry {
  originalId: string; // Keep original ID for reference/debugging
  finalId: number; // Sequential ID for final output
  startTimeSeconds: number;
  endTimeSeconds: number;
  translations: Record<string, string | null>; // { 'english': 'Hello', 'korean': '안녕하세요' }
  isFallback?: boolean; // Did we use original SRT text?
  markFallback?: boolean; // Should this fallback be marked in output?
  timingSource: "original" | "llm"; // Where did the timing come from?
}

/** Structure for cost breakdown */
export interface CostBreakdown {
  totalCost: number;
  transcriptionCost: number;
  translationCost: number;
  costPerModel: Record<string, number>; // e.g., { 'claude-3-5-sonnet': 1.23, 'gemini-1.5-flash': 0.45 }
  costPerMinute?: number; // Total cost / video duration in minutes
  warnings: string[]; // e.g., "Token count unavailable for transcription model X"
}

/** Structure for the final report */
export interface PipelineReport {
  startTime: string;
  endTime: string;
  totalDurationSeconds: number;
  videoDurationSeconds?: number; // Add original video duration
  configUsed: Config;
  overallStatus: "Success" | "SuccessWithIssues" | "Failed";
  summary: {
    chunksTotal: number;
    chunksCompleted: number;
    chunksFailed: number;
    // Add token/cost summary?
  };
  issues: ProcessingIssue[];
  cost?: CostBreakdown; // Ensure this uses the exported type
  outputFilePath?: string;
  reportFilePath: string;
}
