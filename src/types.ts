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

// Issue found during processing
export interface ProcessingIssue {
  type:
    | "SplitError"
    | "TranscriptionError"
    | "TimestampAdjustError" // Keep for potential future use
    | "PromptGenError" // Keep for errors during prompt string generation
    | "TranslationError"
    | "ParseError"
    | "ValidationError"
    | "MergeError"
    | "FormatError";
  severity: "error" | "warning" | "info";
  message: string;
  chunkPart?: number;
  subtitleId?: string | number;
  context?: string; // Snippet or relevant data
}
